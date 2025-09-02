import { pool } from '../db/db.js';
import { generateOutlineWithGemini } from './geminiService.js';
import { SubtopicBatchResponseSchema } from '../llm/outlineSchemas.js';
import { SUBTOPIC_BATCH_PROMPT } from '../prompts/SubTopicBatchPrompt.js';
import { getLLMProvider } from '../providers/ProviderManager.js';

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export const startBackgroundGeneration = async (courseId, userId, providerName = "gemini") => {
  try {
    const courseRes = await pool.query(
      `SELECT id, title, difficulty, include_videos FROM courses WHERE id = $1`,
      [courseId]
    );
    if (courseRes.rowCount === 0) return;

    const llm = getLLMProvider(providerName);

    const course = courseRes.rows[0];

    // ✅ Fetch all subtopics (with unit info)
    const subRes = await pool.query(
      `
      SELECT 
        s.id, s.title, s.unit_id, u.title as unit_title
      FROM units u
      JOIN subtopics s ON u.id = s.unit_id
      WHERE u.course_id = $1 AND s.content IS NULL
      ORDER BY u.position ASC, s.position ASC
    `,
      [courseId]
    );

    const allSubtopics = subRes.rows;
    if (allSubtopics.length === 0) return;

    // ✅ Group subtopics by unit_id
    const grouped = new Map(); // key: unit_id, value: { unit_title, subtopics: [] }

    for (const sub of allSubtopics) {
      if (!grouped.has(sub.unit_id)) {
        grouped.set(sub.unit_id, {
          unit_title: sub.unit_title,
          subtopics: [],
        });
      }
      grouped.get(sub.unit_id).subtopics.push(sub);
    }

    let generatedCount = 0;

    // ✅ Loop over each unit group
    for (const [unitId, group] of grouped) {
      const batches = chunkArray(group.subtopics, 3);

      for (const batch of batches) {
        const batchInput = {
          course_title: course.title,
          unit_title: group.unit_title,
          subtopics: batch.map((s) => s.title),
          difficulty: course.difficulty || 'Begineer',
          want_youtube_keywords: course.include_videos || false,
        };

        const batchRes = await llm.generateSubtopicBatch(SUBTOPIC_BATCH_PROMPT, batchInput);

        console.log(batchRes);
        

        if (!batchRes || !Array.isArray(batchRes)) {
          console.warn(`⚠️ Invalid response from Gemini for unit: ${group.unit_title}`);
          continue;
        }

        const parsed = SubtopicBatchResponseSchema.safeParse(batchRes);
        if (!parsed.success) {
          console.warn(
            `⚠️ Schema validation failed for unit: ${group.unit_title}`,
            parsed.error
          );
          continue;
        }

        const normalize = (str) =>
          str?.toLowerCase().replace(/\s+/g, ' ').trim();

        for (const content of parsed.data) {
          const match = batch.find(
            (s) => normalize(s.title) === normalize(content.subtopic_title)
          );

          if (!match || !match.id) {
            console.warn(
              `⚠️ Could not match content with subtopic in batch for: ${content.subtopic_title}`
            );
            continue;
          }

          await pool.query(
            `UPDATE subtopics SET content = $1, content_generated_at = NOW() WHERE id = $2`,
            [JSON.stringify(content), match.id]
          );

          generatedCount++;
        }

        await pool.query(
          `UPDATE course_generation_status 
           SET generated_subtopics = $1, last_updated = NOW()
           WHERE course_id = $2`,
          [generatedCount, courseId]
        );

        // Rate limit if needed
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // ✅ Mark as completed
    await pool.query(
      `UPDATE course_generation_status 
       SET status = 'completed', last_updated = NOW()
       WHERE course_id = $1`,
      [courseId]
    );
  } catch (err) {
    console.error('❌ Background generation failed:', err);
    await pool.query(
      `UPDATE course_generation_status 
       SET status = 'failed', last_updated = NOW()
       WHERE course_id = $1`,
      [courseId]
    );
  }
};
