import { db } from "../db/firebase.js";
import { SubtopicBatchResponseSchema } from "../llm/outlineSchemas.js";
import { SUBTOPIC_BATCH_PROMPT } from "../prompts/SubTopicBatchPrompt.js";
import { getLLMProvider } from "../providers/LLMProviders.js";
import { fetchYoutubeVideos } from "./youtubeService.js";

const coursesRef = db.collection("courses");

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export const startBackgroundGeneration = async (courseId, userId, providerName = "Gemini", model) => {
  try {
    const courseDoc = await coursesRef.doc(courseId).get();
    if (!courseDoc.exists) return;

    const course = courseDoc.data();
    const llm = getLLMProvider(providerName, model);

    // Fetch all units + missing subtopics
    const unitsSnap = await coursesRef.doc(courseId).collection("units").orderBy("position").get();

    const grouped = new Map(); // key: unitId, value: { unit_title, subtopics: [] }

    for (const unitDoc of unitsSnap.docs) {
      const subsSnap = await unitDoc.ref.collection("subtopics").orderBy("position").get();

      for (const subDoc of subsSnap.docs) {
        if (!subDoc.data().content) {
          if (!grouped.has(unitDoc.id)) {
            grouped.set(unitDoc.id, {
              unit_title: unitDoc.data().title,
              subtopics: [],
            });
          }
          grouped.get(unitDoc.id).subtopics.push({
            id: subDoc.id,
            title: subDoc.data().title,
            unit_id: unitDoc.id,
          });
        }
      }
    }

    const allSubtopics = Array.from(grouped.values()).flatMap((g) => g.subtopics);
    if (allSubtopics.length === 0) return;

    let generatedCount = 0;

    // Process each unit group
    for (const [unitId, group] of grouped) {
      const batches = chunkArray(group.subtopics, 3);

      for (const batch of batches) {
        const batchInput = {
          course_title: course.title,
          unit_title: group.unit_title,
          subtopics: batch.map((s) => s.title),
          difficulty: course.difficulty || "Beginner",
          want_youtube_keywords: course.include_videos || false,
        };

        const batchRes = await llm(SUBTOPIC_BATCH_PROMPT, batchInput);

        if (!batchRes || !Array.isArray(batchRes)) {
          console.warn(`⚠️ Invalid response for unit: ${group.unit_title}`);
          continue;
        }

        const parsed = SubtopicBatchResponseSchema.safeParse(batchRes);
        if (!parsed.success) {
          console.warn(`⚠️ Schema validation failed for unit: ${group.unit_title}`, parsed.error);
          continue;
        }

        const normalize = (str) => str?.toLowerCase().replace(/\s+/g, " ").trim();

        for (const content of parsed.data) {
          const match = batch.find((s) => normalize(s.title) === normalize(content.subtopic_title));

          if (!match || !match.id) {
            console.warn(`⚠️ Could not match: ${content.subtopic_title}`);
            continue;
          }

          // YouTube videos (if enabled)
          if (course.include_videos && content.subtopic_keywords?.length) {
            try {
              const videos = await fetchYoutubeVideos(content.subtopic_keywords);
              if (Array.isArray(videos)) {
                const videoCollRef = coursesRef
                  .doc(courseId)
                  .collection("units")
                  .doc(unitId)
                  .collection("subtopics")
                  .doc(match.id)
                  .collection("videos");

                for (const video of videos) {
                  await videoCollRef.doc().set({
                    title: video.title,
                    youtube_url: video.youtube_url,
                    thumbnail: video.thumbnail,
                    duration_sec: video.duration_sec || null,
                  });
                }
              }
            } catch (e) {
              console.error("YouTube fetch failed:", e);
            }
          }

          // Save generated content
          await coursesRef
            .doc(courseId)
            .collection("units")
            .doc(unitId)
            .collection("subtopics")
            .doc(match.id)
            .update({
              content: content,
              content_generated_at: new Date(),
            });

          generatedCount++;
        }

        // Update generation status
        await db.collection("course_generation_status").doc(courseId).set(
          {
            generated_subtopics: generatedCount,
            last_updated: new Date(),
          },
          { merge: true }
        );

        // Rate limit
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Mark as completed
    await db.collection("course_generation_status").doc(courseId).set(
      {
        status: "completed",
        last_updated: new Date(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error("❌ Background generation failed:", err);
    await db.collection("course_generation_status").doc(courseId).set(
      {
        status: "failed",
        last_updated: new Date(),
      },
      { merge: true }
    );
  }
};
