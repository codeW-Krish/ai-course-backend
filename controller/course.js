import { pool } from "../db/db.js";
import {OUTLINE_SYSTEM_PROMPT} from "../prompts/outlinePrompt.js";
import {generateOutlineWithGemini} from "../service/geminiService.js"
import { OutlineRequestSchema, LlmOutlineSchema, normalizeLlmOutline, SubtopicContentSchema, SubtopicBatchResponseSchema } from "../llm/outlineSchemas.js";
import { z } from "zod/mini";
import { SUBTOPIC_SYSTEM_PROMPT } from "../prompts/subTopicSystemPrompt.js";
import { SUBTOPIC_BATCH_PROMPT } from "../prompts/SubTopicBatchPrompt.js";
import { startBackgroundGeneration } from "../service/generationQueue.js";
import { getLLMProvider } from "../providers/ProviderManager.js";
/*
 POST /api/courses/generate-outline
 *Requires JWT (req.user.id)
*/

export const generateCourseOutline =async (req, res) => {
    try {

        const camelBody = {
            title: req.body.title || req.body.course_title,
            description: req.body.description,
            numUnits: req.body.numUnits ?? req.body.num_units,
            difficulty: req.body.difficulty,
            includeVideos: req.body.includeVideos ?? req.body.include_youtube ?? false,
        };

        const result = OutlineRequestSchema.safeParse(camelBody);
        if(!result.success){
            return res.status(400).json({error: "Validation Failed", fields: z.treeifyError(result.error)});
        }

        const input = result.data;

        const userId = req.user?.id;
        if(!userId) return res.status(401).json({error: "Unauthorized"});


        const userInputs = {
            course_title: input.title,
            description: input.description,
            num_units: input.numUnits,
            difficulty: input.difficulty,
            include_youtube: !!input.includeVideos,
        }

        const llmJosn = await generateOutlineWithGemini(OUTLINE_SYSTEM_PROMPT, userInputs);

        const normalized = normalizeLlmOutline(llmJosn);
          // Enforce exact numUnits as requested (safety net)
        if ((normalized.units?.length || 0) !== input.numUnits) {
        // If mismatch, trim or regenerate; here we trim or slice/pad if needed.
            normalized.units = (normalized.units || []).slice(0, input.numUnits);
            if (normalized.units.length < input.numUnits) {
                return res.status(502).json({ error: "LLM returned fewer units than requested. Try again." });
            }
        }

        const parsed = LlmOutlineSchema.safeParse(normalized);
        if(!parsed.success){
            return res.status(400).json({
            error: "Validation Failed",
            fields: z.treeifyError(parsed.error)
        });
        } 

        const insertQuery = `
            INSERT INTO courses(id, created_by, title, description, difficulty, include_videos, status, outline_json, outline_generated_at, is_public, created_at)
            VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, 'draft', $6, NOW(), TRUE, NOW())
            RETURNING id
        `

        const params = [
            userId, 
            input.title,
            input.description,
            input.difficulty,
            !!input.includeVideos,
            JSON.stringify(parsed.data),
        ]

        const dbres = await pool.query(insertQuery, params);
        const courseId = dbres.rows[0].id;
        

        // Insert each unit and its subtopics
        for (const unit of parsed.data.units) {
        const unitInsertRes = await pool.query(
            `INSERT INTO units (id, course_id, title, position)
            VALUES (gen_random_uuid(), $1, $2, $3)
            RETURNING id`,
            [courseId, unit.title, unit.position]
        );

        const unitId = unitInsertRes.rows[0].id;

        // Insert subtopics
        let position = 1;
        for (const subtopicTitle of unit.subtopics) {
            await pool.query(
            `INSERT INTO subtopics (id, unit_id, title, position)
            VALUES (gen_random_uuid(), $1, $2, $3)`,
            [unitId, subtopicTitle, position++]
            );
        }
        }


        return res.status(201).json({
            courseId,
            status: "draft",
            outline: parsed.data,
        });     
    } catch (err) {
        console.error("generateCourseOutline error:", err);
        if (err.name === "ZodError") {
             return res.status(400).json({ error: "Invalid request body", details: err.errors });
        }
        return res.status(500).json({ error: "Failed to generate outline" });
    }
}

/* 
PUT /api/course/:id/outline
*/

export const updateCourseOutline = async(req, res) => {
    try {
        const {id} = req.params;
        const userId = req.user?.id;
    
        if(!userId) return res.status(401).json({error: "Unauthorized"});

        const ownerCheck = await pool.query("SELECT created_by FROM courses WHERE id = $1", [id]);
        if(ownerCheck.rowCount == 0) {
            return res.status(404).json({error: "Course Not Found"});
        }

        if(ownerCheck.rows[0].created_by != userId){
            return res.status(403).json({error: "Forbidden"});
        }

        const normalized = normalizeLlmOutline(req.body?.outline);
        const parsed = LlmOutlineSchema.safeParse(normalized);
        
        if (!parsed.success) {
            return res.status(400).json({
        error: "Validation Failed",
        fields: z.treeifyError(parsed.error)
    });
        }

        const updateQuery = `
            UPDATE courses 
            SET outline_json = $1, outline_generated_at = NOW(), status = 'draft'
            WHERE id = $2
        `;

        await pool.query(updateQuery, [JSON.stringify(parsed.data), id])
        return res.json({ ok: true, courseId: id, outline: parsed.data, status: "draft" });

    } catch (err) {
         console.error("updateCourseOutline error:", err);
         return res.status(500).json({ error: "Failed to update outline" });        
    }
}

/* 
 GET /api/courses -> to get all the public courses 
*/

export const getAllPublicCourses = async(req, res) => {
    try {
        const selectQuery = `
            SELECT id, title, description, difficulty, include_videos, created_by, outline_json, created_at
            FROM courses 
            WHERE is_public = TRUE
            ORDER BY created_at DESC
        `;

        const result = await pool.query(selectQuery);
        return res.status(200).json({courses: result.rows});

    } catch (err) {
         console.error("getAllPublicCourses error:", err);
         return res.status(500).json({ error: "Failed to fetch courses" });
    }
}

/* 
 GET /api/courses/me -> get my courses created by me 
*/

export const getCoursesCreatedByMe = async(req, res) => {
    try {
        const userId = req.user?.id;
        if(!userId) return res.status(401).json({error: "Unauthorized"});

        const sql = `
            SELECT id, title, description, difficulty, include_videos, status, is_public, created_at
            FROM courses
            WHERE created_by = $1
            ORDER BY created_at DESC
        `;

        const result = await pool.query(sql, [userId]);
        return res.status(200).json({ myCourses: result.rows });
    } catch (err) {
        console.error("getMyCourses error:", err);
        return res.status(500).json({ error: "Failed to fetch your courses" });
    }
}

/* 
 POST /api/courses/:id/enroll -> to enroll into course
*/

export const enrollInCourse = async(req, res) => {
    try {
        const userId = req.user?.id;
        const courseId = req.params.id;

        if(!userId) {
            return res.status(401).json({error: "Unauthorized"});
        }

        const courseExists = await pool.query(
            "SELECT 1 FROM courses WHERE id = $1",
            [courseId]
        );

        if (courseExists.rowCount === 0) {
            return res.status(404).json({ error: "Course not found" });
        }

        const exists = await pool.query("SELECT 1 FROM user_courses WHERE user_id = $1 AND course_id = $2", [userId, courseId]);

        if(exists.rowCount > 0){
            return res.status(409).json({ error: "Already enrolled" });
        }


        // if not already enrolled then enroll 
        await pool.query("INSERT INTO user_courses(user_id, course_id) VALUES($1, $2)", [userId, courseId]);
        return res.status(200).json({message: "Enrolled Successfullty"});

    } catch (err) {
        console.error("enrollInCourse error:", err);
        return res.status(500).json({ error: "Failed to enroll" });
    }
}

/* 
 GET /api/courses/me/enrolled -> get all the courses enrolled by me, only for card view not the data of units and subtopic content
*/

export const getCoursesEnrolledByMe = async(req, res) => {
    try {
        const userId = req.user?.id;
        if(!userId){
            return res.status(401).json({error: "Unauthorized"});
        }

        const getEnrolledCoursesQuery = `
            SELECT 
                c.id,
                c.title,
                c.description,
                c.difficulty,
                c.include_videos,
                c.status,
                c.created_by,
                c.outline_json,
                uc.joined_at
            FROM user_courses uc
            JOIN courses c ON uc.course_id = c.id
            WHERE uc.user_id = $1
            ORDER BY uc.joined_at DESC 
        `
        
        const result = await pool.query(getEnrolledCoursesQuery, [userId]);
        return res.status(200).json({enrolledCourses: result.rows})

    } catch (err) {
        console.error("getEnrolledCourses error:", err);
        return res.status(500).json({ error: "Failed to fetch enrolled courses" });
    }
}

/*
 GET /api/courses/:id/full -> to get teh data on the on click of the card
*/

export const getCourseContentById = async(req,res) => {
    const courseId = req.params.id;
    const userId = req.user?.id;

    if(!userId){
        return res.status(401).json({error: "Unauthorized"});
    }

    try {
        const isAccessAble = await pool.query(`
            SELECT * FROM courses
            WHERE id = $1 AND (created_by = $2 OR id IN (
            SELECT course_id FROM user_courses WHERE user_id = $2
                ))

            `,[courseId, userId]);

        if(isAccessAble.rowCount === 0){
            return res.status(403).json({ error: "Access denied to this course" });
        }

        const course = isAccessAble.rows[0];
        const unitsRes= await pool.query(`SELECT * FROM units WHERE course_id = $1 ORDER BY position ASC`, [courseId]);
        const units = unitsRes.rows;

        // getting subtopic for each unit
        for(let unit of units){
            const subtopicsRes = await pool.query(`SELECT * FROM subtopics WHERE unit_id = $1 ORDER BY position ASC`, [unit.id]);
            unit.subtopics = subtopicsRes.rows;
        }

        res.status(200).json({ course, units });

    } catch (err) {
        console.error("getCourseContentById error:", err);
        res.status(500).json({ error: "Failed to fetch course content" });
    }
}

/*
 POST /api/courses/:id/generate-content
*/

export const generateCourseContent = async (req, res) => {
    const courseId = req.params.id;
    const userId = req.user?.id;
    const providerName = req.body.providerName || 'gemini';

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    try {
        const courseRes = await pool.query(
            "SELECT created_by, title, include_videos, difficulty FROM courses WHERE id = $1",
            [courseId]
        );
        if (courseRes.rowCount === 0)
            return res.status(404).json({ error: "Course not found" });

        const course = courseRes.rows[0];
        if (course.created_by !== userId)
            return res.status(403).json({ error: "Forbidden" });

        const courseTitle = course.title;
        const courseDifficulty = course.difficulty || "Beginner";

        // Get first 2 units
        const unitRes = await pool.query(
            `SELECT id, title FROM units WHERE course_id = $1 ORDER BY position ASC LIMIT 1`, // I changed it to 1, we can change it to LIMIT 2
            [courseId]
        );
        const units = unitRes.rows;

        if (!units.length) return res.status(400).json({ error: "No units to generate." });

        const llm = getLLMProvider(providerName);


        let totalSubtopicsProcessed = 0;

        const chunkArray = (arr, size) => {
            const chunks = [];
            for (let i = 0; i < arr.length; i+=size) {
                chunks.push(arr.slice(i, i+size));
            }
            return chunks;
        }
        for (const unit of units) {
            // Get subtopics for each unit
            const subtopicsRes = await pool.query(
                `SELECT id, title, content FROM subtopics WHERE unit_id = $1`,
                [unit.id]
            );

            const missingSubtopics = subtopicsRes.rows.filter(s => !s.content);
            if(missingSubtopics.length === 0) continue;

            let batches = [];
            if(missingSubtopics.length <= 4){
                batches = [missingSubtopics];
            }else{
                batches = chunkArray(missingSubtopics, 3);
            }

            for (const batch of batches) {
                const batchInput = {
                    course_title: courseTitle,
                    unit_title: unit.title,
                    subtopics: batch.map(s => s.title),
                    difficulty: courseDifficulty || "Begineer",
                    want_youtube_keywords: course.include_videos || false
                }

                const batchRes = await llm.generateSubtopicBatch(SUBTOPIC_BATCH_PROMPT, batchInput);
                if (!batchRes || !Array.isArray(batchRes)){
                    console.warn(`"Invalid batch response for unit: ${unit.title}"`);
                    continue;
                }

                const parsed = SubtopicBatchResponseSchema.safeParse(batchRes);
                if (!parsed.success) {
                    console.warn(`Batch Schema validation failed for unit: ${unit.title}`, parsed.error);
                    continue;
                }

                console.log("Trying to match with subtopics batch:", batch);
                const normalize = (str) => str?.toLowerCase().replace(/\s+/g, ' ').trim() ?? '';
                for (const content of parsed.data) {

                    // const matchingSubtopic = batch.find(s =>
                    //     content.subtopic_title?.toLowerCase().trim() === s.title?.toLowerCase().trim()
                    // );
                       const matchingSubtopic = batch.find(s =>
                            normalize(content.subtopic_title) === normalize(s.title)
                        );


                    if (!matchingSubtopic) {
                        console.warn(`No matching subtopics found in response from Gemini for ${content.subtopic_title}`);
                        continue;
                    }

                    await pool.query(`UPDATE subtopics SET content = $1 WHERE id = $2`, [JSON.stringify(content), matchingSubtopic.id]);

                    if (batchInput.want_youtube_keywords && content.youtube_keywords?.length) {
                        for (const keyword in content.youtube_keywords) {
                            console.log(`keyword for YT Video ${keyword}`);
                        }
                    }

                    totalSubtopicsProcessed++;
                }

            }}
            const subRes = await pool.query(`
                SELECT s.id 
                FROM units u 
                JOIN subtopics s ON u.id = s.unit_id 
                WHERE u.course_id = $1 AND s.content IS NULL
                `, [courseId]
            );

            const remainingSubtopics = subRes.rows;

            await pool.query(`
                    INSERT INTO course_generation_status (course_id, status, total_subtopics, generated_subtopics, last_updated)
                    VALUES($1, 'in_progress', $2, 0, NOW())
                    ON CONFLICT (course_id) DO UPDATE
                    SET status = 'in_progress', total_subtopics = $2, last_updated = NOW()                
                `,[courseId, subRes.rowCount]);
          
                /// 
                startBackgroundGeneration(courseId, userId, providerName);

            return res.status(200).json({
                message: "First 2 units generated, background generation started for remaining.",
                units: units.length,
                remaining_subtopics: remainingSubtopics.length,
                status: 'in_progress',
            });
    } catch (err) {
        console.error("generateCourseContent error:", err);
        return res.status(500).json({ error: "Failed to generate course content" });
    }
};
export const getCourseGenerationStatus = async (req, res) => {
  const courseId = req.params.id;
  const since = req.query.since;

  try {
    const statusRes = await pool.query(
      `
      SELECT status, total_subtopics, generated_subtopics, last_updated
      FROM course_generation_status
      WHERE course_id = $1
      `,
      [courseId]
    );

    if (statusRes.rowCount === 0) {
      return res.status(404).json({ error: "No generation status found" });
    }

    const status = statusRes.rows[0];

    let subtopicsQuery = `
      SELECT s.id, s.title, s.content, s.content_generated_at, u.title AS unit_title
      FROM subtopics s
      JOIN units u ON s.unit_id = u.id
      WHERE u.course_id = $1 AND s.content IS NOT NULL
    `;

    const params = [courseId];

    if (since) {
      subtopicsQuery += " AND s.content_generated_at > $2::timestamptz";
      params.push(since);
    }

    subtopicsQuery += " ORDER BY s.content_generated_at ASC";

    const subtopicRes = await pool.query(subtopicsQuery, params);

    return res.status(200).json({
      courseId,
      status: status.status,
      totalSubtopics: status.total_subtopics,
      generatedSubtopics: status.generated_subtopics,
      lastUpdated: status.last_updated,
      subtopics: subtopicRes.rows.map((s) => ({
        id: s.id,
        title: s.title,
        content: JSON.parse(s.content),
        content_generated_at: s.content_generated_at,
        unit_title: s.unit_title,
      })),
    });
  } catch (err) {
    console.error("getCourseGenerationStatus error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

export const retryFailedSubtopics = async(req, res) => {
    const courseId = req.params.id;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({error: "Unauthorized"});

    try {
        const courseRes = await pool.query("SELECT created_by FROM courses WHERE id = $1", [courseId]);

        if (courseRes.rowCount === 0) {
            return res.status(404).json({error: "Course Not Found"});
        }

        const course = courseRes.rows[0];
        if (course.created_by !== userId) {
            return res.status(403).json({error: "Forbidden"});
        }

        // Counting how many subtopic need to retry
        const subRes = await pool.query(`
                    SELECT COUNT(*) FROM units u
                    JOIN subtopics s ON u.id = s.unit_id
                    WHERE u.course_id = $1 AND s.content IS NULL   
            `, [courseId])

        const missingCount = parseInt(subRes.rows[0].count || '0');
        if (missingCount === 0) {
            return res.status(200).json({
                message: "No Failed subtopics found to retry",
                status: "idle",
                remaining_subtopics: 0
            });
        }

        startBackgroundGeneration(courseId, userId)
        .then(() => {
            console.log(`Retry background generation started for course: ${courseId}`);
        })
        .catch((err) => {
            console.log(`Retry background generation failed for course: ${courseId}`, err);
        })

        await pool.query(`
            INSERT INTO course_generation_status (course_id, status, total_subtopics, generated_subtopics, last_updated)
            VALUES ($1, 'in_progress', $2, 0, NOW())
            ON CONFLICT (course_id) DO UPDATE
            SET status = 'in_progress', total_subtopics = $2, generated_subtopics = 0, last_updated = NOW()   
        `, [courseId, missingCount]);

        return res.status(202).json({
            message: "Retry initiated for failed subtopics",
            status: "in_progress",
            remaining_subtopics: missingCount
        })
        
    } catch (err) {
        console.error("retryFailedSubtopics error:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }

}

export const generateSubtopicAndRelatedContent = async (req, res) => {
    const subtopicId = req.params.id;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    try {
        // 1. Get subtopic, unit, and course details
        const subtopicRes = await pool.query(
            `SELECT s.id, s.title, s.content, s.unit_id, u.course_id, u.title AS unit_title, c.title AS course_title, c.include_videos, c.difficulty AS course_difficulty, c.created_by
            FROM subtopics s
            JOIN units u ON s.unit_id = u.id
            JOIN courses c ON u.course_id = c.id
            WHERE s.id = $1`,
            [subtopicId]
        );

        if (subtopicRes.rowCount === 0)
            return res.status(404).json({ error: "Subtopic not found" });

        const subtopic = subtopicRes.rows[0];

        // if (
        //     subtopic.created_by !== userId &&
        //     !(await pool.query(
        //         `SELECT 1 FROM user_courses WHERE user_id = $1 AND course_id = $2`,
        //         [userId, subtopic.course_id]
        //     )).rowCount
        // ) {
        //     return res.status(403).json({ error: "Forbidden" });
        // }
        const isCreator = subtopic.created_by === userId;
        const isEnrolled = (
            await pool.query(
                `SELECT 1 FROM user_courses WHERE user_id = $1 AND course_id = $2`,
                [userId, subtopic.course_id]
            )
        ).rowCount > 0;

        if (!isCreator && !isEnrolled)
            return res.status(403).json({ error: "Forbidden" });

        const { unit_id, course_id, course_title, unit_title,  course_difficulty: courseDifficulty, include_videos } = subtopic;

        // 2. Get siblings (subtopics in same unit)
        const siblingsRes = await pool.query(
            `SELECT id, title, content FROM subtopics WHERE unit_id = $1 ORDER BY position ASC`,
            [unit_id]
        );
        const siblings = siblingsRes.rows;

        // 3. Get next unit's subtopics
        const nextUnitRes = await pool.query(
            `SELECT id, title FROM units WHERE course_id = $1 AND position > (SELECT position FROM units WHERE id = $2) ORDER BY position ASC LIMIT 1`,
            [course_id, unit_id]
        );
        let nextUnitSubtopics = [];
        if (nextUnitRes.rowCount > 0) {
            const nextUnitId = nextUnitRes.rows[0].id;
            const nextSubsRes = await pool.query(
                `SELECT id, title, content FROM subtopics WHERE unit_id = $1 ORDER BY position ASC`,
                [nextUnitId]
            );
            nextUnitSubtopics = nextSubsRes.rows;
        }

        // 4. Collect all subtopics to generate if content missing:
        // clicked subtopic + siblings + next unit subtopics
        const toGenerate = [
            ...siblings.filter(s => !s.content),
            ...nextUnitSubtopics.filter(s => !s.content),
        ];

        // // Ensure clicked subtopic is included
        // if (!subtopic.content) {
        //     toGenerate.push({
        //         id: subtopic.id,
        //         title: subtopic.title,
        //         // difficulty: difficulty || "Beginner", // Use course's difficulty
        //     });
        // }

        // // Deduplicate by id
        // const uniqueToGenerate = [];
        // const seenIds = new Set();
        // for (const st of toGenerate) {
        //     if (!seenIds.has(st.id)) {
        //         seenIds.add(st.id);
        //         uniqueToGenerate.push(st);
        //     }
        // }

        const seenIds = new Set(toGenerate.map(s => s.id));
        if (!subtopic.content && !seenIds.has(subtopic.id)) {
            toGenerate.push({ id: subtopic.id, title: subtopic.title });
        }

        const uniqueToGenerate = [];
        const uniqueIds = new Set();
        for (const sub of toGenerate) {
            if (!uniqueIds.has(sub.id)) {
                uniqueIds.add(sub.id);
                uniqueToGenerate.push(sub);
             }
        }

        // 5. Generate content for missing ones
        for (const sub of uniqueToGenerate) {
            const result = await generateOutlineWithGemini(
                {
                    course_id,
                    course_title,
                    unit_title,
                    subtopic_title: sub.title,
                    difficulty: courseDifficulty || "Beginner", // Using course's difficulty
                },
                SUBTOPIC_SYSTEM_PROMPT
            );

            
            if (!result?.content) {
                console.warn(`⚠️ No content returned for subtopic: ${sub.title}`);
                continue;
            }

            const contentJson = result.content;

            // Save content
            await pool.query(
                `UPDATE subtopics SET content = $1 WHERE id = $2`,
                [JSON.stringify(contentJson), sub.id]
            );

            // Optionally handle YouTube keywords
            if (result.includeVideos && contentJson.youtube_keywords?.length) {
                for (const keyword of contentJson.youtube_keywords) {
                    console.log(`🔍 Queue video search for keyword: ${keyword}`);
                }
            }
        }

        // 6. Return clicked subtopic content + siblings + next unit subtopics content from DB (fresh)
        const finalSiblingsRes = await pool.query(
            `SELECT id, title, content FROM subtopics WHERE unit_id = $1 ORDER BY position ASC`,
            [unit_id]
        );
        const finalSiblings = finalSiblingsRes.rows;

        let finalNextUnitSubtopics = [];
        if (nextUnitRes.rowCount > 0) {
            const nextUnitId = nextUnitRes.rows[0].id;
            const nextSubsRes = await pool.query(
                `SELECT id, title, content FROM subtopics WHERE unit_id = $1 ORDER BY position ASC`,
                [nextUnitId]
            );
            finalNextUnitSubtopics = nextSubsRes.rows;
        }

        res.status(200).json({
            clickedSubtopicId: subtopicId,
            siblings: finalSiblings,
            nextUnitSubtopics: finalNextUnitSubtopics,
        });
    } catch (err) {
        console.error("generateSubtopicAndRelatedContent error:", err);
        res.status(500).json({ error: "Failed to generate subtopic content" });
    }
};
    // function chunkArray(arr, size) {
    //   const chunks = [];
    //   for (let i = 0; i < arr.length; i += size) {
    //     chunks.push(arr.slice(i, i + size));
    //   }
    //   return chunks;
    // }

