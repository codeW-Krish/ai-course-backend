import { pool } from "../db/db.js";
import {OUTLINE_SYSTEM_PROMPT} from "../prompts/outlinePrompt.js";
import { OutlineRequestSchema, LlmOutlineSchema, normalizeLlmOutline, SubtopicContentSchema, SubtopicBatchResponseSchema, RegenerateContentOutlineSchema, normalizeLlmOutlineForRegeneration } from "../llm/outlineSchemas.js";
import { z } from "zod/mini";
import { SUBTOPIC_BATCH_PROMPT } from "../prompts/SubTopicBatchPrompt.js";
import { startBackgroundGeneration } from "../service/generationQueue.js";
import { getLLMProvider } from "../providers/LLMProviders.js";
import { fetchYoutubeVideos } from "../service/youtubeService.js";
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
            provider: req.body.provider ?? "Gemini",
            model: req.body.model ?? null,

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

        const llm = getLLMProvider(input.provider, input.model);

        const llmJosn = await llm(OUTLINE_SYSTEM_PROMPT, userInputs);

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

        const normalized = normalizeLlmOutline(req.body);
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
 AFTER Course content generation creator of the course can update the outline and thus we need to regenerate the content ans store it to the DB tables

*/


// WORKING but updating the actual outline_json in course table is pending

// export const updateExistedCourseOutlineAndRegenerateContent = async (req, res) => {
//   const client = await pool.connect(); // Start a DB transaction
//   try {
//     const { id } = req.params; // courseId from the route
//     const userId = req.user?.id;

//     // Check if the user is authorized
//     if (!userId) return res.status(401).json({ error: "Unauthorized" });

//     // Check if the course exists and if the user is the owner
//     const ownerCheck = await pool.query("SELECT created_by FROM courses WHERE id = $1", [id]);
//     if (ownerCheck.rowCount === 0) {
//       return res.status(404).json({ error: "Course Not Found" });
//     }

//     if (ownerCheck.rows[0].created_by !== userId) {
//       return res.status(403).json({ error: "Forbidden" });
//     }

//     // Normalize the incoming outline (to ensure it's in the correct format)
//     const normalized = normalizeLlmOutlineForRegeneration(req.body);
//     console.log("Normalized: ", normalized);

//     const parsed = RegenerateContentOutlineSchema.safeParse(normalized);
    
//     if (!parsed.success) {
//       return res.status(400).json({
//         error: "Validation Failed",
//         fields: z.treeifyError(parsed.error),
//       });
//     }

//     // Step 1: Fetch the existing units to associate unit_id
//     const unitsQuery = `
//       SELECT id, title FROM units WHERE course_id = $1
//     `;
//     const unitsResult = await pool.query(unitsQuery, [id]);
//     const existingUnits = unitsResult.rows;

//     // Step 2: Ensure each unit has an id assigned
//     const newOutline = parsed.data.units.map(unit => {
//       const existingUnit = existingUnits.find(existing => existing.title === unit.title);
//       if (!existingUnit) {
//         throw new Error(`Unit not found in the database: ${unit.title}`);
//       }
//       unit.id = existingUnit.id; // Add the unit_id
//       return unit;
//     });

//     // Step 3: Prepare subtopic comparison
//     const existingSubtopicsQuery = `
//       SELECT u.id AS unit_id, s.id AS subtopic_id, s.title AS subtopic_title 
//       FROM units u
//       JOIN subtopics s ON u.id = s.unit_id
//       WHERE u.course_id = $1
//     `;
//     const currentOutline = await pool.query(existingSubtopicsQuery, [id]);
//     const existingSubtopics = currentOutline.rows;

//     const toInsertSubtopics = [];
//     const toUpdateSubtopics = [];
//     const toDeleteSubtopics = [];

//     // Traverse the new outline and compare subtopics with existing ones in DB
//     for (const unit of newOutline) {
//       for (const [index, subtopicTitle] of unit.subtopics.entries()) {
//         const dbSubtopic = existingSubtopics.find(
//           (sub) => sub.subtopic_title === subtopicTitle && sub.unit_id === unit.id
//         );

//         if (dbSubtopic) {
//           // Subtopic exists, check if it needs updating
//           if (dbSubtopic.subtopic_title !== subtopicTitle) {
//             toUpdateSubtopics.push({
//               id: dbSubtopic.subtopic_id,
//               unit_id: unit.id,
//               new_title: subtopicTitle,
//               position: index + 1,  // Assign position automatically
//             });
//           }
//         } else {
//           // New subtopic, insert it with position based on order in array
//           toInsertSubtopics.push({
//             unit_id: unit.id,
//             subtopic_title: subtopicTitle,
//             position: index + 1, // Position starts from 1
//           });
//         }
//       }
//     }

//     // Handle subtopics deletion (those that no longer exist in the new outline)
//     for (const dbSubtopic of existingSubtopics) {
//       const foundInNewOutline = newOutline
//         .flatMap((unit) => unit.subtopics)
//         .includes(dbSubtopic.subtopic_title);
        
//       if (!foundInNewOutline) {
//         toDeleteSubtopics.push(dbSubtopic.subtopic_id);
//       }
//     }

//     // Step 4: Start transaction
//     await client.query('BEGIN');

//     // Step 5: Delete subtopics that are no longer present
//     const deleteSubtopicsPromises = toDeleteSubtopics.map(subtopicId =>
//       client.query('DELETE FROM subtopics WHERE id = $1', [subtopicId])
//     );
//     await Promise.all(deleteSubtopicsPromises);

//     // Step 6: Insert new subtopics with position (position is based on index)
//     const insertSubtopics = toInsertSubtopics.map(subtopic => [
//       subtopic.unit_id,          // Correct unit_id is passed
//       subtopic.subtopic_title,   // Title of the subtopic
//       subtopic.position          // Position based on order in the subtopics array
//     ]);

//     const insertQuery = `
//       INSERT INTO subtopics (unit_id, title, position) 
//       VALUES ($1, $2, $3)  
//     `;
//     const insertPromises = insertSubtopics.map(subtopic =>
//       client.query(insertQuery, subtopic)
//     );
//     await Promise.all(insertPromises); // Insert new subtopics

//     // Step 7: Generate content for new subtopics using LLM
//     const llm = getLLMProvider(req.body.provider, req.body.model);
//     const subtopicsTitles = toInsertSubtopics.map(sub => sub.subtopic_title);
//     const batchInput = {
//       course_title: req.body.course_title,
//       unit_title: req.body.unit_title,
//       subtopics: subtopicsTitles,
//       difficulty: req.body.difficulty,
//       want_youtube_keywords: req.body.want_youtube_keywords || false,
//     };
    
//     const generatedContents = await llm(SUBTOPIC_BATCH_PROMPT, batchInput);

//     // Step 8: Insert generated content into subtopics
//     const contentUpdatePromises = generatedContents.map((content, idx) =>
//       client.query(
//         'UPDATE subtopics SET content = $1 WHERE title = $2 AND unit_id = $3',
//         [JSON.stringify(content), toInsertSubtopics[idx].subtopic_title, toInsertSubtopics[idx].unit_id]
//       )
//     );
//     await Promise.all(contentUpdatePromises);

//     // Commit the transaction
//     await client.query('COMMIT');

//     return res.json({
//       status: "draft",
//       outline: parsed.data,
//       courseId: id,
//     });

//   } catch (err) {
//     await client.query('ROLLBACK');  // Rollback on error
//     console.error("updateCourseOutline error:", err);
//     return res.status(500).json({ error: "Failed to update outline" });
//   } finally {
//     client.release(); // Release DB connection
//   }
// };

// WORKING 100% PROPER USE THIS IF NEEDED

// export const updateExistedCourseOutlineAndRegenerateContent = async (req, res) => {
//   const client = await pool.connect(); // Start a DB transaction
//     const providerName = req.query.provider || 'Gemini';
//     const model = req.query.model || undefined;
//   try {
//     const { id } = req.params; // courseId from the route
//     const userId = req.user?.id;

//     // Check if the user is authorized
//     if (!userId) return res.status(401).json({ error: "Unauthorized" });

//     // Check if the course exists and if the user is the owner
//     const ownerCheck = await pool.query("SELECT created_by, outline_json FROM courses WHERE id = $1", [id]);
//     if (ownerCheck.rowCount === 0) {
//       return res.status(404).json({ error: "Course Not Found" });
//     }

//     if (ownerCheck.rows[0].created_by !== userId) {
//       return res.status(403).json({ error: "Forbidden" });
//     }

//     // Normalize the incoming outline (to ensure it's in the correct format)
//     const normalized = normalizeLlmOutlineForRegeneration(req.body);
//     console.log("Normalized: ", normalized);

//     const parsed = RegenerateContentOutlineSchema.safeParse(normalized);
    
//     if (!parsed.success) {
//       return res.status(400).json({
//         error: "Validation Failed",
//         fields: z.treeifyError(parsed.error),
//       });
//     }

//     // Step 1: Fetch the existing units to associate unit_id
//     const unitsQuery = `SELECT id, title FROM units WHERE course_id = $1`;
//     const unitsResult = await pool.query(unitsQuery, [id]);
//     const existingUnits = unitsResult.rows;

//     // Step 2: Ensure each unit has an id assigned, insert new units if necessary
//     const newOutline = [];

//     for (const unit of parsed.data.units) {
//       let existingUnit = existingUnits.find(existing => existing.title === unit.title);
      
//       if (!existingUnit) {
//         // Insert the new unit into the database
//         const insertUnitQuery = `
//           INSERT INTO units (course_id, title, position)
//           VALUES ($1, $2, $3) RETURNING id
//         `;
//         const insertResult = await pool.query(insertUnitQuery, [id, unit.title, unit.position]);
//         existingUnit = { id: insertResult.rows[0].id, title: unit.title };  // Get the new unit id
//       }
      
//       unit.id = existingUnit.id;
//       newOutline.push(unit); // Add the unit with the correct id to the new outline
//     }

//     // Step 3: Handle subtopics (insert, update, delete)
//     const existingSubtopicsQuery = `
//       SELECT u.id AS unit_id, s.id AS subtopic_id, s.title AS subtopic_title 
//       FROM units u
//       JOIN subtopics s ON u.id = s.unit_id
//       WHERE u.course_id = $1
//     `;
//     const currentOutline = await pool.query(existingSubtopicsQuery, [id]);
//     const existingSubtopics = currentOutline.rows;

//     const toInsertSubtopics = [];
//     const toUpdateSubtopics = [];
//     const toDeleteSubtopics = [];

//     // Traverse the new outline and compare subtopics with existing ones in DB
//     for (const unit of newOutline) {
//       for (const [index, subtopicTitle] of unit.subtopics.entries()) {
//         const dbSubtopic = existingSubtopics.find(
//           (sub) => sub.subtopic_title === subtopicTitle && sub.unit_id === unit.id
//         );

//         if (dbSubtopic) {
//           // Subtopic exists, check if it needs updating
//           if (dbSubtopic.subtopic_title !== subtopicTitle) {
//             toUpdateSubtopics.push({
//               id: dbSubtopic.subtopic_id,
//               unit_id: unit.id,
//               new_title: subtopicTitle,
//               position: index + 1,
//             });
//           }
//         } else {
//           // New subtopic, insert it with position based on order in array
//           toInsertSubtopics.push({
//             unit_id: unit.id,
//             subtopic_title: subtopicTitle,
//             position: index + 1,
//           });
//         }
//       }
//     }

//     // Handle subtopics deletion (those that no longer exist in the new outline)
//     for (const dbSubtopic of existingSubtopics) {
//       const foundInNewOutline = newOutline
//         .flatMap((unit) => unit.subtopics)
//         .includes(dbSubtopic.subtopic_title);
        
//       if (!foundInNewOutline) {
//         toDeleteSubtopics.push(dbSubtopic.subtopic_id);
//       }
//     }

//     // Step 4: Start transaction
//     await client.query('BEGIN');

//     // Step 5: Delete subtopics that are no longer present
//     const deleteSubtopicsPromises = toDeleteSubtopics.map(subtopicId =>
//       client.query('DELETE FROM subtopics WHERE id = $1', [subtopicId])
//     );
//     await Promise.all(deleteSubtopicsPromises);

//     // Step 6: Insert new subtopics
//     const insertSubtopics = toInsertSubtopics.map(subtopic => [
//       subtopic.unit_id,
//       subtopic.subtopic_title,
//       subtopic.position
//     ]);
//     const insertQuery = `
//       INSERT INTO subtopics (unit_id, title, position)
//       VALUES ($1, $2, $3)  
//     `;
//     const insertPromises = insertSubtopics.map(subtopic =>
//       client.query(insertQuery, subtopic)
//     );
//     await Promise.all(insertPromises);  // Insert new subtopics

//     // Step 7: Generate content for new subtopics using LLM
//     const llm = getLLMProvider(providerName, model);
//     const subtopicsTitles = toInsertSubtopics.map(sub => sub.subtopic_title);
//     const batchInput = {
//       course_title: req.body.course_title,
//       unit_title: req.body.unit_title,
//       subtopics: subtopicsTitles,
//       difficulty: req.body.difficulty,
//       want_youtube_keywords: req.body.want_youtube_keywords || false,
//     };
    
//     const generatedContents = await llm(SUBTOPIC_BATCH_PROMPT, batchInput);

//     // Step 8: Insert generated content into subtopics
//     const contentUpdatePromises = generatedContents.map((content, idx) =>
//       client.query(
//         'UPDATE subtopics SET content = $1 WHERE title = $2 AND unit_id = $3',
//         [JSON.stringify(content), toInsertSubtopics[idx].subtopic_title, toInsertSubtopics[idx].unit_id]
//       )
//     );
//     await Promise.all(contentUpdatePromises);

//     // Step 10: Update the course outline in the database
//     const updatedOutline = {
//       course_title: req.body.course_title,
//       difficulty: req.body.difficulty,
//       units: newOutline, // Only include units with subtopics
//     };

//     // Update the course outline in the database
//     await client.query(
//       `UPDATE courses SET outline_json = $1 WHERE id = $2`,
//       [JSON.stringify(updatedOutline), id]
//     );

//     // Commit the transaction
//     await client.query('COMMIT');

//     return res.json({
//       status: "draft",
//       outline: updatedOutline,
//       courseId: id,
//     });

//   } catch (err) {
//     await client.query('ROLLBACK');
//     console.error("updateCourseOutline error:", err);
//     return res.status(500).json({ error: "Failed to update outline" });
//   } finally {
//     client.release();
//   }
// };

export const updateOrRegenerateCourseOutline = async (req, res, regenerateContent = false) => {
  const client = await pool.connect(); // Start DB transaction
  const providerName = req.query.provider || 'Gemini';  // Optional: specify the LLM provider
  const model = req.query.model || undefined;  // Optional: specify the model to use for content generation
  const { id } = req.params;  // courseId from the route
  const userId = req.user?.id;

  // Check if the user is authorized
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  // Check if the course exists and if the user is the owner
  const ownerCheck = await pool.query("SELECT created_by, outline_json FROM courses WHERE id = $1", [id]);
  if (ownerCheck.rowCount === 0) {
    return res.status(404).json({ error: "Course Not Found" });
  }

  if (ownerCheck.rows[0].created_by !== userId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Normalize the incoming outline (to ensure it's in the correct format)
  const normalized = normalizeLlmOutlineForRegeneration(req.body);
  console.log("Normalized: ",  JSON.stringify(normalized, null, 2));

  const parsed = RegenerateContentOutlineSchema.safeParse(normalized);
  
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation Failed",
      fields: z.treeifyError(parsed.error),
    });
  }

  // Step 1: Fetch the existing units and subtopics from the database
  const unitsQuery = `SELECT id, title FROM units WHERE course_id = $1`;
  const unitsResult = await pool.query(unitsQuery, [id]);
  const existingUnits = unitsResult.rows;

  const existingSubtopicsQuery = `
    SELECT u.id AS unit_id, s.id AS subtopic_id, s.title AS subtopic_title 
    FROM units u
    JOIN subtopics s ON u.id = s.unit_id
    WHERE u.course_id = $1
  `;
  const currentOutline = await pool.query(existingSubtopicsQuery, [id]);
  const existingSubtopics = currentOutline.rows;

  // Step 2: Insert or Update Units in the Outline
  const newOutline = [];

  for (const unit of parsed.data.units) {
    let existingUnit = existingUnits.find(existing => existing.title === unit.title);
    
    if (!existingUnit) {
      // Insert the new unit into the database
      const insertUnitQuery = `
        INSERT INTO units (course_id, title, position)
        VALUES ($1, $2, $3) RETURNING id
      `;
      const insertResult = await pool.query(insertUnitQuery, [id, unit.title, unit.position]);
      existingUnit = { id: insertResult.rows[0].id, title: unit.title };  // Get the new unit id
    }
    
    unit.id = existingUnit.id;
    newOutline.push(unit);  // Add the unit with the correct id to the new outline
  }

  // Step 3: Handle Subtopics (Insert, Update, Delete)
  const toInsertSubtopics = [];
  const toUpdateSubtopics = [];
  const toDeleteSubtopics = [];

  for (const unit of newOutline) {
    for (const [index, subtopicTitle] of unit.subtopics.entries()) {
      const dbSubtopic = existingSubtopics.find(
        (sub) => sub.subtopic_title === subtopicTitle && sub.unit_id === unit.id
      );

      if (dbSubtopic) {
        // Subtopic exists, check if it needs updating
        if (dbSubtopic.subtopic_title !== subtopicTitle) {
          toUpdateSubtopics.push({
            id: dbSubtopic.subtopic_id,
            unit_id: unit.id,
            new_title: subtopicTitle,
            position: index + 1,
          });
        }
      } else {
        // New subtopic, insert it with position based on order in array
        toInsertSubtopics.push({
          unit_id: unit.id,
          subtopic_title: subtopicTitle,
          position: index + 1,
        });
      }
    }
  }

  // Handle subtopics deletion (those that no longer exist in the new outline)
  for (const dbSubtopic of existingSubtopics) {
    const foundInNewOutline = newOutline
      .flatMap((unit) => unit.subtopics)
      .includes(dbSubtopic.subtopic_title);
    
    if (!foundInNewOutline) {
      toDeleteSubtopics.push(dbSubtopic.subtopic_id);
    }
  }

  // Step 4: Start Database Transaction
  await client.query('BEGIN');

  // Step 5: Delete subtopics that no longer exist
  const deleteSubtopicsPromises = toDeleteSubtopics.map(subtopicId =>
    client.query('DELETE FROM subtopics WHERE id = $1', [subtopicId])
  );
  await Promise.all(deleteSubtopicsPromises);

  // Step 6: Insert new subtopics
  const insertSubtopics = toInsertSubtopics.map(subtopic => [
    subtopic.unit_id,
    subtopic.subtopic_title,
    subtopic.position
  ]);
  const insertQuery = `
    INSERT INTO subtopics (unit_id, title, position)
    VALUES ($1, $2, $3)  
  `;
  const insertPromises = insertSubtopics.map(subtopic =>
    client.query(insertQuery, subtopic)
  );
  await Promise.all(insertPromises);  // Insert new subtopics

  // Step 7: Update existing subtopics
  const updateSubtopicsPromises = toUpdateSubtopics.map(subtopic =>
    client.query(
      'UPDATE subtopics SET title = $1, position = $2 WHERE id = $3',
      [subtopic.new_title, subtopic.position, subtopic.id]
    )
  );
  await Promise.all(updateSubtopicsPromises); // Update existing subtopics

  // Step 8: Generate content for new subtopics using LLM (optional)
  if (regenerateContent) {
    const llm = getLLMProvider(providerName, model);
    const subtopicsTitles = toInsertSubtopics.map(sub => sub.subtopic_title);
    const batchInput = {
      course_title: req.body.course_title,
      unit_title: req.body.unit_title,
      subtopics: subtopicsTitles,
      difficulty: req.body.difficulty,
      want_youtube_keywords: req.body.want_youtube_keywords || false,
    };

    const generatedContents = await llm(SUBTOPIC_BATCH_PROMPT, batchInput);

    // Step 9: Insert generated content into subtopics
    const contentUpdatePromises = generatedContents.map((content, idx) =>
      client.query(
        'UPDATE subtopics SET content = $1 WHERE title = $2 AND unit_id = $3',
        [JSON.stringify(content), toInsertSubtopics[idx].subtopic_title, toInsertSubtopics[idx].unit_id]
      )
    );
    await Promise.all(contentUpdatePromises);
  }

  // Step 10: Update the course outline in the database
  const updatedOutline = {
    course_title: req.body.course_title,
    difficulty: req.body.difficulty,
    units: newOutline, // Only include units with subtopics
  };

  await client.query(
    `UPDATE courses SET outline_json = $1 WHERE id = $2`,
    [JSON.stringify(updatedOutline), id]
  );

  // Commit the transaction
  await client.query('COMMIT');

  return res.json({
    status: "draft",
    outline: updatedOutline,
    courseId: id,
  });
};

export const updateOrRegenerateCourseOutlineController = async (req, res) => {
  const regenerateContent = req.query.regenerate === 'true';

  try {
    // The service handles the database operations and response
    await updateOrRegenerateCourseOutline(req, res, regenerateContent);
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Failed to update course outline' });
  }
};

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
        const userId = req.user?.id;
        const courseId = req.params.id;

        if(!userId) {
            return res.status(401).json({error: "Unauthorized"});
        }

    //     const courseExists = await pool.query(
    //         "SELECT 1 FROM courses WHERE id = $1",
    //         [courseId]
    //     );

    //     if (courseExists.rowCount === 0) {
    //         return res.status(404).json({ error: "Course not found" });
    //     }

    //     const exists = await pool.query("SELECT 1 FROM user_courses WHERE user_id = $1 AND course_id = $2", [userId, courseId]);

    //     if(exists.rowCount > 0){
    //         return res.status(409).json({ error: "Already enrolled" });
    //     }


    //     // if not already enrolled then enroll 
    //     await pool.query("INSERT INTO user_courses(user_id, course_id) VALUES($1, $2)", [userId, courseId]);
    //     return res.status(200).json({message: "Enrolled Successfullty"});

    // } catch (err) {
    //     console.error("enrollInCourse error:", err);
    //     return res.status(500).json({ error: "Failed to enroll" });
    // }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const courseExistAndPublic = await client.query(`
                SELECT is_public FROM courses 
                WHERE id = $1
            `, [courseId]);
            
        if (courseExistAndPublic.rowCount === 0) {
            // await client.query("ROLLBACK");
            return res.status(404).json({error: "Course doesn't exist"});
        }

        if (!courseExistAndPublic.rows[0].is_public) {
            // await client.query("ROLLBACK");
            return res.status(403).json({error: "Can't Enroll in this course it's not public"});
        }

        // if already enrolled
        const enrollmentCheck = await client.query(`SELECT 1 FROM user_courses WHERE user_id = $1 AND course_id = $2`, [userId, courseId]); 
        if (enrollmentCheck.rowCount > 0) {
            // await client.query("ROLLBACK");
            return res.status(409).json({error: "Already Enrolled"});
        }

            // Enroll user in course
        await client.query(
        "INSERT INTO user_courses(user_id, course_id) VALUES ($1, $2)",
        [userId, courseId]
        );

        // Update course_public_stats total_users_joined counter
        await client.query(`
        INSERT INTO course_public_stats(course_id, total_users_joined, last_updated)
        VALUES ($1, 1, NOW())
        ON CONFLICT (course_id)
        DO UPDATE SET total_users_joined = course_public_stats.total_users_joined + 1, last_updated = NOW()
        `, [courseId]);

        await client.query("COMMIT");
        return res.status(200).json({ message: "Enrolled Successfully" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("enrollInCourse error:", err);
        return res.status(500).json({ error: "Failed to enroll" });
    } finally {
        client.release();
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

        // const getEnrolledCoursesQuery = `
        //     SELECT 
        //         c.id,
        //         c.title,
        //         c.description,
        //         c.difficulty,
        //         c.include_videos,
        //         c.status,
        //         c.created_by,
        //         c.outline_json,
        //         uc.joined_at
        //     FROM user_courses uc
        //     JOIN courses c ON uc.course_id = c.id
        //     WHERE uc.user_id = $1
        //     ORDER BY uc.joined_at DESC 
        // `

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
                    u.username AS creator_name,
                    COALESCE(stats.total_users_joined, 0) AS total_users_joined,
                    uc.joined_at
                FROM user_courses uc
                JOIN courses c ON uc.course_id = c.id
                LEFT JOIN users u ON c.created_by = u.id
                LEFT JOIN course_public_stats stats ON c.id = stats.course_id
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
GET -> /api/courses/:id/outline
*/

export const getCourseOutline = async(req, res) => {
    const courseId = req.params.id;
    try {
        const result = await pool.query(`        
                SELECT outline_json FROM courses WHERE id = $1 AND is_public = TRUE
        `, [courseId]);

        if (result.rowCount === 0) {
            return res.status(404).json({error: "Course not found or not public"});            
        }

        return res.status(200).json({outline: result.rows[0].outline_json});
    } catch (err) {
        console.error("getCourseOutlineOnly error:", err);
        return res.status(500).json({ error: "Failed to fetch course outline" });
    }
}

/*
  DELETE -> /api/courses/:id
*/

export const deleteCourseById = async(req, res) => {
    const userId = req.user?.id;
    const courseId = req.params.id;

    if (!userId) return res.status(401).json({error: "Unauthorized"});

    try {
        const checkOwnerShip = await pool.query(`
            SELECT created_by FROM courses WHERE id = $1  
        `, [courseId]);

        if (checkOwnerShip.rowCount === 0) return res.status(404).json({error: "Course Not Found"});

        if (checkOwnerShip.rows[0].created_by != userId) {
            return res.status(403).json({error: "You're not allowed to delete this course, you're not the owner of the course"});
        }

        await pool.query(`DELETE FROM courses WHERE id = $1`, [courseId]);
        
        return res.status(200).json({message: "Course Deleted Successfully"});
    } catch (err) {
        console.error("deleteCourseById error:", err);
        return res.status(500).json({ error: "Failed to delete course" });
    }
}


/*
 GET /api/courses/:id/full -> to get teh data on the on click of the card
*/

// export const getCourseContentById = async(req,res) => {
//     const courseId = req.params.id;
//     const userId = req.user?.id;

//     if(!userId){
//         return res.status(401).json({error: "Unauthorized"});
//     }

//     try {
//         // const isAccessAble = await pool.query(`
//         //     SELECT * FROM courses
//         //     WHERE id = $1 AND (created_by = $2 OR id IN (
//         //     SELECT course_id FROM user_courses WHERE user_id = $2
//         //         ))

//         //     `,[courseId, userId]);

//         // if(isAccessAble.rowCount === 0){
//         //     return res.status(403).json({ error: "Access denied to this course" });
//         // }

//         // const course = isAccessAble.rows[0];
//         // const unitsRes= await pool.query(`SELECT * FROM units WHERE course_id = $1 ORDER BY position ASC`, [courseId]);
//         // const units = unitsRes.rows;

//         // // getting subtopic for each unit
//         // for(let unit of units){
//         //     const subtopicsRes = await pool.query(`SELECT * FROM subtopics WHERE unit_id = $1 ORDER BY position ASC`, [unit.id]);
//         //     unit.subtopics = subtopicsRes.rows;
//         // }

//         // res.status(200).json({ course, units });

//         // new code with optimization solved n + 1 query problem and add that is_public filter 
//         const isAccessAble = await pool.query(`SELECT * FROM courses WHERE id = $1 AND (created_by = $2 OR EXISTS (SELECT 1 FROM user_courses WHERE course_id = $1 AND user_id = $2))`, [courseId, userId]);

//         if (isAccessAble.rowCount === 0) {
//             return res.status(403).json({error: "Access Denied to this course"});
//         }

//         const course = isAccessAble.rows[0];

//         const unitsRes = await pool.query(`SELECT * FROM units WHERE course_id = $1 ORDER BY position ASC`, [courseId]);
//         const units = unitsRes.rows;

//         const unitIds = units.map(u => u.id);
//         const subtopicsRes = await pool.query(`SELECT * FROM subtopics WHERE unit_id = ANY($1::uuid[]) ORDER BY position ASC`, [unitIds]);

//         const subtopicsMap = {};
//         for (const subtopic of subtopicsRes.rows) {
//             if (!subtopicsMap[subtopic.unit_id]){
//                 subtopicsMap[subtopic.unit_id] = [];
//             }
//             subtopicsMap[subtopic.unit_id].push(subtopic);
//         }

//         for (const unit of units) {
//             unit.subtopics = subtopicsMap[unit.id] || [];
//         }

//         return res.status(200).json({course, units})

//     } catch (err) {
//         console.error("getCourseContentById error:", err);
//         res.status(500).json({ error: "Failed to fetch course content" });
//     }
// }

export const getCourseContentById = async(req,res) => {
    const courseId = req.params.id;
    const userId = req.user?.id;

    if(!userId){
        return res.status(401).json({error: "Unauthorized"});
    }

    try {
        const isAccessAble = await pool.query(`SELECT * FROM courses WHERE id = $1 AND (created_by = $2 OR EXISTS (SELECT 1 FROM user_courses WHERE course_id = $1 AND user_id = $2))`, [courseId, userId]);

        if (isAccessAble.rowCount === 0) {
            return res.status(403).json({error: "Access Denied to this course"});
        }

        const course = isAccessAble.rows[0];

        const unitsRes = await pool.query(`SELECT * FROM units WHERE course_id = $1 ORDER BY position ASC`, [courseId]);
        const units = unitsRes.rows;

        const unitIds = units.map(u => u.id);
        
        // Get subtopics
        const subtopicsRes = await pool.query(`SELECT * FROM subtopics WHERE unit_id = ANY($1::uuid[]) ORDER BY position ASC`, [unitIds]);
        const subtopics = subtopicsRes.rows;

        // Get videos for all subtopics
        const subtopicIds = subtopics.map(s => s.id);
        const videosRes = await pool.query(`SELECT * FROM videos WHERE subtopic_id = ANY($1::uuid[]) ORDER BY subtopic_id, id`, [subtopicIds]);
        const videos = videosRes.rows;

        // Create maps for organization
        const subtopicsMap = {};
        const videosMap = {};

        // Organize videos by subtopic_id
        for (const video of videos) {
            if (!videosMap[video.subtopic_id]) {
                videosMap[video.subtopic_id] = [];
            }
            videosMap[video.subtopic_id].push(video);
        }

        // Organize subtopics by unit_id and attach videos
        for (const subtopic of subtopics) {
            subtopic.videos = videosMap[subtopic.id] || [];
            if (!subtopicsMap[subtopic.unit_id]) {
                subtopicsMap[subtopic.unit_id] = [];
            }
            subtopicsMap[subtopic.unit_id].push(subtopic);
        }

        // Attach subtopics to units
        for (const unit of units) {
            unit.subtopics = subtopicsMap[unit.id] || [];
        }

        return res.status(200).json({course, units})

    } catch (err) {
        console.error("getCourseContentById error:", err);
        res.status(500).json({ error: "Failed to fetch course content" });
    }
}


// Add to controller/course.js
const generateFullCourseWithCerebras = async (req, res) => {
  const courseId = req.params.id;
  const userId = req.user?.id;
  const model = req.query.model;

  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify ownership
    const courseRes = await client.query(
      "SELECT title, difficulty, include_videos FROM courses WHERE id = $1 AND created_by = $2",
      [courseId, userId]
    );
    if (courseRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Course not found or not owned" });
    }
    const course = courseRes.rows[0];

    // Get all subtopics without content
    const subtopicsRes = await client.query(`
      SELECT s.id, s.title, u.title AS unit_title
      FROM subtopics s
      JOIN units u ON s.unit_id = u.id
      WHERE u.course_id = $1 AND s.content IS NULL
      ORDER BY u.position, s.position
    `, [courseId]);

    const subtopics = subtopicsRes.rows;
    if (subtopics.length === 0) {
      await client.query('COMMIT');
      return res.status(200).json({ message: "All content already generated" });
    }

    // Group by unit
    const unitsMap = {};
    subtopics.forEach(s => {
      if (!unitsMap[s.unit_title]) unitsMap[s.unit_title] = [];
      unitsMap[s.unit_title].push(s.title);
    });

    const input = {
      course_title: course.title,
      difficulty: course.difficulty,
      units: Object.entries(unitsMap).map(([unit_title, subtopics]) => ({
        unit_title,
        subtopics
      })),
      want_youtube_keywords: course.include_videos
    };

    const llm = getLLMProvider('Cerebras', model);
    const result = await llm(SUBTOPIC_BATCH_PROMPT, input); // Reuse prompt!

    // Validate
    const parsed = SubtopicBatchResponseSchema.safeParse(result);
    if (!parsed.success) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: "Invalid LLM response" });
    }

    // Save all content + videos
    for (const content of parsed.data) {
      const subtopic = subtopics.find(s => 
        s.title.toLowerCase().trim() === content.subtopic_title.toLowerCase().trim()
      );
      if (!subtopic) continue;

      await client.query(
        `UPDATE subtopics SET content = $1, content_generated_at = NOW() WHERE id = $2`,
        [JSON.stringify(content), subtopic.id]
      );

      if (course.include_videos && content.youtube_keywords?.length) {
        const videos = await fetchYoutubeVideos(content.youtube_keywords);
        for (const video of videos) {
          await client.query(
            `INSERT INTO videos (subtopic_id, title, youtube_url, thumbnail, duration_sec)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (subtopic_id, youtube_url) DO NOTHING`,
            [subtopic.id, video.title, video.youtube_url, video.thumbnail, video.duration_sec]
            );
        }
      }
    }

    await client.query('COMMIT');
    return res.status(200).json({
      message: "Course generated instantly!",
      generated: parsed.data.length
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: "Generation failed" });
  } finally {
    client.release();
  }
};

export const generateWithBatching = async(req, res) => {
     const courseId = req.params.id;
    const userId = req.user?.id;
    const providerName = req.query.provider || 'Gemini';
    const model = req.query.model || undefined;

    const llm = getLLMProvider(providerName, model);

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

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const enrollmentCheck = await client.query(`SELECT 1 FROM user_courses WHERE user_id = $1 AND course_id = $2`, [userId, courseId]);
            const isAlreadyEnrolled = enrollmentCheck.rowCount > 0;

            if (!isAlreadyEnrolled) {
                await client.query(`
                    INSERT INTO user_courses(user_id, course_id)
                    VALUES($1, $2)
                `, [userId, courseId]);

                // updating the total_user_joined for the course only if its public
                const publicCheck = await client.query('SELECT is_public FROM courses WHERE id = $1', [courseId]);
                const isPublic = publicCheck.rows[0]?.is_public;

                if (isPublic) {
                    await client.query(`
                        INSERT INTO course_public_stats (course_id, total_users_joined)
                        VALUES ($1, 1)
                        ON CONFLICT (course_id) DO UPDATE
                        SET total_users_joined = course_public_stats.total_users_joined + 1, last_updated = NOW()
                    `, [courseId]);
                }
            }

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            console.error("Auto-enrollment transaction failed:", e);
        } finally {
            client.release();
        }



        const courseTitle = course.title;
        const courseDifficulty = course.difficulty || "Beginner";

        // Get first 1 units
        const unitRes = await pool.query(
            `SELECT id, title FROM units WHERE course_id = $1 ORDER BY position ASC LIMIT 1`, // I changed it to 1, we can change it to LIMIT 2
            [courseId]
        );
        const units = unitRes.rows;

        if (!units.length) return res.status(400).json({ error: "No units to generate." });


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

                const batchRes = await llm(SUBTOPIC_BATCH_PROMPT, batchInput);
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
                    console.log('Subtopic Title from AI:', content.subtopic_title);
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
                        for (const keyword of content.youtube_keywords) {
                            console.log(`Fetching YouTube video for keyword: ${keyword}`);
                            const youtubeVideos = await fetchYoutubeVideos([keyword]);

                            // Check if youtubeVideos is an array and has elements
                            if (Array.isArray(youtubeVideos) && youtubeVideos.length) {
                                console.log("youtube Videos: ", youtubeVideos);
                                
                                // Store each video for the current subtopic
                                for (const video of youtubeVideos) {
                                    const { title, youtube_url, thumbnail, duration_sec } = video;
                                    const duration = duration_sec || null;

                                    // Check if the video already exists in the database
                                    const existingVideoCheck = await pool.query(`
                                        SELECT 1 FROM videos WHERE youtube_url = $1 AND subtopic_id = $2
                                    `, [youtube_url, matchingSubtopic.id]);

                                    if (existingVideoCheck.rowCount === 0) {
                                        // Insert the video if it doesn't already exist
                                        await pool.query(`
                                            INSERT INTO videos (subtopic_id, title, youtube_url, thumbnail, duration_sec)
                                            VALUES ($1, $2, $3, $4, $5)
                                        `, [matchingSubtopic.id, title, youtube_url, thumbnail, duration]);

                                        console.log(`Inserted video for subtopic ID: ${matchingSubtopic.id}`);
                                    } else {
                                        console.log(`Video with URL ${youtube_url} already exists for subtopic ID: ${matchingSubtopic.id}`);
                                    }
                                }

                            } else {
                                console.warn(`No videos found for keyword: ${keyword}`);
                            }
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
}

/*
 POST /api/courses/:id/generate-content
*/

export const generateCourseContent = async (req, res) => {
  const providerName = req.body.provider || 'Groq';
  const isCerebras = providerName.toLowerCase() === 'cerebras';

  if (isCerebras) {
    return generateFullCourseWithCerebras(req, res); // NEW
  } else {
    return generateWithBatching(req, res); // OLD
  }
};

// --------------------------------------------------------------------

const chunkArray = (arr, size) => {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

export const streamCourseGeneration = async (req, res) => {
  const courseId = req.params.id;
  const userId = req.user?.id;
  // const providerName = (req.body.provider || 'Groq').trim();
  // const model = req.body.model;

  // const isCerebras = providerName.toLowerCase() === 'cerebras';

  // SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // === MANUAL BODY PARSING ===
  let rawBody = '';
  req.on('data', chunk => rawBody += chunk.toString());
  req.on('end', async () => {
    let providerName = 'Groq';
    let model = null;


    if (rawBody) {
      try {
        // Clean whitespace, newlines, trailing commas
        const cleaned = rawBody
          .replace(/,\s*}/g, '}')     // Remove trailing comma
          .replace(/,\s*]/g, ']')     // Remove trailing comma in arrays
          .trim();

        const parsed = JSON.parse(cleaned);
        providerName = (parsed.provider || 'Groq').trim();
        model = parsed.model || null;
      } catch (e) {
        console.error("JSON Parse Error:", e.message, "Raw:", rawBody);
        send({ type: "error", message: "Invalid request format" });
        res.end();
        return;
      }
    }
    
    const isCerebras = providerName.toLowerCase() === 'cerebras';

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1. Verify ownership + get course
    const courseRes = await client.query(
      `SELECT title, difficulty, include_videos, is_public FROM courses WHERE id = $1 AND created_by = $2`,
      [courseId, userId]
    );
    if (courseRes.rowCount === 0) {
      send({ type: "error", message: "Course not found or not owned" });
      res.end();
      return;
    }
    const course = courseRes.rows[0];

    // 2. Auto-enroll (your exact logic)
    const enrollmentCheck = await client.query(
      `SELECT 1 FROM user_courses WHERE user_id = $1 AND course_id = $2`,
      [userId, courseId]
    );
    const isAlreadyEnrolled = enrollmentCheck.rowCount > 0;

    if (!isAlreadyEnrolled) {
      await client.query(
        `INSERT INTO user_courses(user_id, course_id) VALUES($1, $2)`,
        [userId, courseId]
      );

      if (course.is_public) {
        await client.query(
          `INSERT INTO course_public_stats (course_id, total_users_joined)
           VALUES ($1, 1)
           ON CONFLICT (course_id) DO UPDATE
           SET total_users_joined = course_public_stats.total_users_joined + 1, last_updated = NOW()`,
          [courseId]
        );
      }
    }

    // 3. Get missing subtopics
    const subRes = await client.query(`
      SELECT s.id, s.title, u.id AS unit_id, u.title AS unit_title
      FROM subtopics s
      JOIN units u ON s.unit_id = u.id
      WHERE u.course_id = $1 AND s.content IS NULL
      ORDER BY u.position, s.position
    `, [courseId]);

    const missingSubtopics = subRes.rows;
    if (missingSubtopics.length === 0) {
      send({ type: "complete", generated: 0, total: 0, message: "All content already generated" });
      res.end();
      return;
    }

    const total = missingSubtopics.length;
    let generated = 0;
    send({ type: "start", total, provider: providerName, isCerebras });

    const llm = getLLMProvider(providerName, model);

    // 4. Group by unit
    const grouped = new Map();
    for (const sub of missingSubtopics) {
      if (!grouped.has(sub.unit_id)) {
        grouped.set(sub.unit_id, { unit_title: sub.unit_title, subtopics: [] });
      }
      grouped.get(sub.unit_id).subtopics.push(sub);
    }

    // 5. Decide batch size
    const batchSize = isCerebras ? total : 3;
    const allBatches = [];

    for (const [, group] of grouped) {
      const unitBatches = chunkArray(group.subtopics, batchSize);
      allBatches.push(...unitBatches.map(batch => ({ ...group, subtopics: batch })));
    }

    // 6. Process each batch
    for (const [batchIdx, group] of allBatches.entries()) {
      const batch = group.subtopics;
      const batchInput = {
        course_title: course.title,
        unit_title: group.unit_title,
        subtopics: batch.map(s => s.title),
        difficulty: course.difficulty || "Beginner",
        want_youtube_keywords: course.include_videos
      };

      try {
        const batchRes = await llm(SUBTOPIC_BATCH_PROMPT, batchInput);
        if (!batchRes || !Array.isArray(batchRes)) {
          send({ type: "warning", message: `Invalid response for unit: ${group.unit_title}` });
          continue;
        }

        const parsed = SubtopicBatchResponseSchema.safeParse(batchRes);
        if (!parsed.success) {
          send({ type: "warning", message: `Validation failed for unit: ${group.unit_title}` });
          continue;
        }

        const normalize = (str) => str?.toLowerCase().replace(/\s+/g, ' ').trim() || '';

        for (const content of parsed.data) {
          const match = batch.find(s => normalize(s.title) === normalize(content.subtopic_title));
          if (!match) {
            send({ type: "warning", message: `No match for: ${content.subtopic_title}` });
            continue;
          }

          // Save content
          await client.query(
            `UPDATE subtopics SET content = $1, content_generated_at = NOW() WHERE id = $2`,
            [JSON.stringify(content), match.id]
          );

          // YouTube: your exact logic
          if (course.include_videos && content.youtube_keywords?.length) {
            for (const keyword of content.youtube_keywords) {
              const videos = await fetchYoutubeVideos([keyword]);
              if (!Array.isArray(videos)) continue;

              for (const video of videos) {
                const { title, youtube_url, thumbnail, duration_sec } = video;
                const duration = duration_sec || null;

                const exists = await client.query(
                  `SELECT 1 FROM videos WHERE youtube_url = $1 AND subtopic_id = $2`,
                  [youtube_url, match.id]
                );

                if (exists.rowCount === 0) {
                  await client.query(
                    `INSERT INTO videos (subtopic_id, title, youtube_url, thumbnail, duration_sec)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [match.id, title, youtube_url, thumbnail, duration]
                  );
                }
              }
            }
          }

          generated++;
          send({
            type: "progress",
            subtopic: content.subtopic_title,
            unit: group.unit_title,
            progress: Math.round((generated / total) * 100),
            generated,
            total,
            batch: batchIdx + 1,
            totalBatches: allBatches.length
          });
        }
      } catch (err) {
        send({ type: "warning", message: `Batch ${batchIdx + 1} failed` });
        console.error("Batch error:", err);
      }

      // Rate limit for non-Cerebras
      if (!isCerebras) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // 7. Update status
    await client.query(
      `INSERT INTO course_generation_status (course_id, status, total_subtopics, generated_subtopics, last_updated)
       VALUES ($1, 'completed', $2, $3, NOW())
       ON CONFLICT (course_id) DO UPDATE
       SET status = 'completed', generated_subtopics = $3, last_updated = NOW()`,
      [courseId, total, generated]
    );

    await client.query('COMMIT');
    send({ type: "complete", generated, total });

  } catch (err) {
    if (client) await client.query('ROLLBACK');
    send({ type: "error", message: err.message || "Generation failed" });
    console.error("Streaming generation failed:", err);
  } finally {
    if (client) client.release();
    res.end();
  }
});
};




// --------------------------------------------------------------------



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
    const provider = req.body.provider || 'Gemini';
    const model = req.body.model || undefined;
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

        startBackgroundGeneration(courseId, userId, provider, model)
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

/*
    GET -> /api/courses/search?query=ai 
    for on typing search realtime small dropdown list shows up with less data 
*/


export const searchCourses = async(req, res) => {
    try {
        const {query} = req.query;
        if (!query) {
            return res.status(400).json({ error: "Query parameter is required" });
        }

        const searchQuery = `
            SELECT id, title, created_by, u.username AS creator_name, 
            FROM courses c
            LEFT JOIN users u ON c.created_by = u.id
            WHERE c.title LIKE $1
            ORDER BY c.created_at DESC
            LIMIT 5
        `
        const result = await pool.query(searchQuery, [`%${query}%`]);
        return res.status(200).json({ courses: result.rows });
  } catch (err) {
        console.error("searchCourses error:", err);
        return res.status(500).json({ error: "Failed to search courses" });
  }
}
/*
   GET -> /api/courses/search?query=ai&difficulty=Beginner&sort=most_enrolled
   for big search on that search button click and with filtering and sorting options
*/

export const searchCoursesFull = async(req, res) => {
    try{
        const {query = "", difficulty, sortBy} = req.query;

        if (!query || query.trim() === "") {
            return res.status(400).json({error: "Search Query Is Required"});  
        } 

        let baseQuery = `
            SELECT 
                c.id,
                c.title,
                c.description, 
                c.difficulty,
                c.created_by,
                u.username AS creator_name,
                COALESCE(stats.total_users_joined, 0) AS total_users_joined
                c.created_at
            FROM courses c
            LEFT JOIN users u ON c.created_by = u.id
            LEFT JOIN course_public_stats stats ON c.id = stats.course_id
            WHERE c.is_public = TRUE
        `

        const params = [];
        let paramIndex = 1;

        if (query) {
            baseQuery += ` AND c.title ILIKE $${paramIndex}`;
            params.push(query);
            paramIndex++;
        }

        if (difficulty) {
            baseQuery += ` AND c.difficulty = $${paramIndex}`;
            params.push(difficulty);
            paramIndex++;
        }

        if (sortBy) {
            switch (sortBy) {
                case "Newest":
                    baseQuery += ' ORDER BY c.created_at DESC';
                    break;
                case "Oldest":
                    baseQuery += ' ORDER BY c.created_by ASC';
                    break;
                case "Most_Enrolled":
                    baseQuery += ' ORDER BY total_users_joined DESC';
                    break;
                case 'difficulty_asc':
                    baseQuery += ' ORDER BY c.difficulty ASC';
                    break;
                case 'difficulty_desc':
                    baseQuery += ' ORDER BY c.difficulty DESC';
                    break;
                default:
                    baseQuery += ' ORDER BY c.created_at DESC'; // default sorting
            }
        }

        baseQuery += ' LIMIT 20';

        const result = await pool.query(baseQuery, params);
        res.status(200).json({ courses: result.rows });
    }catch(error){
        console.error('searchCourses error:', err);
        res.status(500).json({ error: 'Failed to search courses' });
    }

}

/*
    GET ->  /api/courses/search?query=AI&difficulties=Beginner,Intermediate&sortBy=popularity&sortDirection=desc

*/

// export const searchCourses = async (req, res) => {
//   try {
//     const { query, difficulties, sortBy, sortDirection } = req.query;
//     // query: string to match course title
//     // difficulties: comma separated string e.g. "Beginner,Advanced"
//     // sortBy: "created_at" | "popularity" | "difficulty"
//     // sortDirection: "asc" or "desc"

//     const userInput = `%${query || ''}%`;

//     let baseQuery = `
//       SELECT 
//         c.id,
//         c.title,
//         c.description, 
//         c.difficulty,
//         c.created_by,
//         u.username AS creator_name,
//         COALESCE(stats.total_users_joined, 0) AS total_users_joined
//       FROM courses c
//       LEFT JOIN users u ON c.created_by = u.id
//       LEFT JOIN course_public_stats stats ON c.id = stats.course_id
//       WHERE c.is_public = TRUE AND c.title ILIKE $1
//     `;

//     const params = [userInput];
//     let paramIndex = 2; // track parameter index for SQL placeholders

//     // Handle difficulty filtering (multiple allowed)
//     if (difficulties) {
//       const difficultyList = difficulties.split(',').map(d => d.trim());
//       const placeholders = difficultyList.map(() => `$${paramIndex++}`).join(', ');
//       baseQuery += ` AND c.difficulty IN (${placeholders})`;
//       params.push(...difficultyList);
//     }

//     // Validate sortBy field
//     const validSortFields = {
//       created_at: 'c.created_at',
//       popularity: 'total_users_joined',
//       difficulty: 'c.difficulty',
//     };

//     let orderByField = validSortFields[sortBy] || 'c.created_at';

//     // Validate sortDirection
//     let orderDirection = (sortDirection && sortDirection.toUpperCase() === 'ASC') ? 'ASC' : 'DESC';

//     baseQuery += ` ORDER BY ${orderByField} ${orderDirection}`;

//     baseQuery += ' LIMIT 20';

//     const result = await pool.query(baseQuery, params);
//     res.status(200).json({ courses: result.rows });
//   } catch (err) {
//     console.error('searchCourses error:', err);
//     res.status(500).json({ error: 'Failed to search courses' });
//   }
// };



/*
    DELETE -> /api/courses/:id/unenroll
*/

export const unenrollFromCourse = async(req, res) => {
    const userId = req.user?.id;
    const courseId = req.params.id;

    if (!userId) return res.status(401).json({error: "Unauthorized"});

    try {
        const enrolled = await pool.query(`SELECT 1 FROM user_courses WHERE user_id = $1 AND course_id = $2`, [userId, courseId]);

        if (enrolled.rowCount === 0) return res.status(400).josn({error: "Not enrolled in this course"});

        await pool.query(`
            DELETE FROM user_courses WHERE user_id = $1 AND course_id = $2            
        `, [userId, courseId]);

        await pool.query(`
                UPDATE course_public_stats 
                SET total_users_joined = GREATEST(total_users_joined - 1, 0), last_updated = NOW()
                WHERE course_id = $1
        `, [courseId]);

        return res.status(200).json({message: "Unerolled Successfully"});
    } catch (error) {
        console.error("unenrollFromCourse error:", err);
        return res.status(500).json({ error: "Failed to unenroll" });
    }
}


//export const generateSubtopicAndRelatedContent = async (req, res) => {
//     const subtopicId = req.params.id;
//     const userId = req.user?.id;
//     const provider = req.

//     if (!userId) return res.status(401).json({ error: "Unauthorized" });

//     try {
//         // 1. Get subtopic, unit, and course details
//         const subtopicRes = await pool.query(
//             `SELECT s.id, s.title, s.content, s.unit_id, u.course_id, u.title AS unit_title, c.title AS course_title, c.include_videos, c.difficulty AS course_difficulty, c.created_by
//             FROM subtopics s
//             JOIN units u ON s.unit_id = u.id
//             JOIN courses c ON u.course_id = c.id
//             WHERE s.id = $1`,
//             [subtopicId]
//         );

//         if (subtopicRes.rowCount === 0)
//             return res.status(404).json({ error: "Subtopic not found" });

//         const subtopic = subtopicRes.rows[0];

//         // if (
//         //     subtopic.created_by !== userId &&
//         //     !(await pool.query(
//         //         `SELECT 1 FROM user_courses WHERE user_id = $1 AND course_id = $2`,
//         //         [userId, subtopic.course_id]
//         //     )).rowCount
//         // ) {
//         //     return res.status(403).json({ error: "Forbidden" });
//         // }
//         const isCreator = subtopic.created_by === userId;
//         const isEnrolled = (
//             await pool.query(
//                 `SELECT 1 FROM user_courses WHERE user_id = $1 AND course_id = $2`,
//                 [userId, subtopic.course_id]
//             )
//         ).rowCount > 0;

//         if (!isCreator && !isEnrolled)
//             return res.status(403).json({ error: "Forbidden" });

//         const { unit_id, course_id, course_title, unit_title,  course_difficulty: courseDifficulty, include_videos } = subtopic;

//         // 2. Get siblings (subtopics in same unit)
//         const siblingsRes = await pool.query(
//             `SELECT id, title, content FROM subtopics WHERE unit_id = $1 ORDER BY position ASC`,
//             [unit_id]
//         );
//         const siblings = siblingsRes.rows;

//         // 3. Get next unit's subtopics
//         const nextUnitRes = await pool.query(
//             `SELECT id, title FROM units WHERE course_id = $1 AND position > (SELECT position FROM units WHERE id = $2) ORDER BY position ASC LIMIT 1`,
//             [course_id, unit_id]
//         );
//         let nextUnitSubtopics = [];
//         if (nextUnitRes.rowCount > 0) {
//             const nextUnitId = nextUnitRes.rows[0].id;
//             const nextSubsRes = await pool.query(
//                 `SELECT id, title, content FROM subtopics WHERE unit_id = $1 ORDER BY position ASC`,
//                 [nextUnitId]
//             );
//             nextUnitSubtopics = nextSubsRes.rows;
//         }

//         // 4. Collect all subtopics to generate if content missing:
//         // clicked subtopic + siblings + next unit subtopics
//         const toGenerate = [
//             ...siblings.filter(s => !s.content),
//             ...nextUnitSubtopics.filter(s => !s.content),
//         ];

//         // // Ensure clicked subtopic is included
//         // if (!subtopic.content) {
//         //     toGenerate.push({
//         //         id: subtopic.id,
//         //         title: subtopic.title,
//         //         // difficulty: difficulty || "Beginner", // Use course's difficulty
//         //     });
//         // }

//         // // Deduplicate by id
//         // const uniqueToGenerate = [];
//         // const seenIds = new Set();
//         // for (const st of toGenerate) {
//         //     if (!seenIds.has(st.id)) {
//         //         seenIds.add(st.id);
//         //         uniqueToGenerate.push(st);
//         //     }
//         // }

//         const seenIds = new Set(toGenerate.map(s => s.id));
//         if (!subtopic.content && !seenIds.has(subtopic.id)) {
//             toGenerate.push({ id: subtopic.id, title: subtopic.title });
//         }

//         const uniqueToGenerate = [];
//         const uniqueIds = new Set();
//         for (const sub of toGenerate) {
//             if (!uniqueIds.has(sub.id)) {
//                 uniqueIds.add(sub.id);
//                 uniqueToGenerate.push(sub);
//              }
//         }

//         // 5. Generate content for missing ones
//         for (const sub of uniqueToGenerate) {
//             const result = await llm(
//                 {
//                     course_id,
//                     course_title,
//                     unit_title,
//                     subtopic_title: sub.title,
//                     difficulty: courseDifficulty || "Beginner", // Using course's difficulty
//                 },
//                 SUBTOPIC_SYSTEM_PROMPT
//             );

            
//             if (!result?.content) {
//                 console.warn(`No content returned for subtopic: ${sub.title}`);
//                 continue;
//             }

//             const contentJson = result.content;

//             // Save content
//             await pool.query(
//                 `UPDATE subtopics SET content = $1 WHERE id = $2`,
//                 [JSON.stringify(contentJson), sub.id]
//             );

//             // Optionally handle YouTube keywords
//             if (result.includeVideos && contentJson.youtube_keywords?.length) {
//                 for (const keyword of contentJson.youtube_keywords) {
//                     console.log(`Queue video search for keyword: ${keyword}`);
//                 }
//             }
//         }

//         // 6. Return clicked subtopic content + siblings + next unit subtopics content from DB (fresh)
//         const finalSiblingsRes = await pool.query(
//             `SELECT id, title, content FROM subtopics WHERE unit_id = $1 ORDER BY position ASC`,
//             [unit_id]
//         );
//         const finalSiblings = finalSiblingsRes.rows;

//         let finalNextUnitSubtopics = [];
//         if (nextUnitRes.rowCount > 0) {
//             const nextUnitId = nextUnitRes.rows[0].id;
//             const nextSubsRes = await pool.query(
//                 `SELECT id, title, content FROM subtopics WHERE unit_id = $1 ORDER BY position ASC`,
//                 [nextUnitId]
//             );
//             finalNextUnitSubtopics = nextSubsRes.rows;
//         }

//         res.status(200).json({
//             clickedSubtopicId: subtopicId,
//             siblings: finalSiblings,
//             nextUnitSubtopics: finalNextUnitSubtopics,
//         });
//     } catch (err) {
//         console.error("generateSubtopicAndRelatedContent error:", err);
//         res.status(500).json({ error: "Failed to generate subtopic content" });
//     }
// };
//     // function chunkArray(arr, size) {
//     //   const chunks = [];
//     //   for (let i = 0; i < arr.length; i += size) {
//     //     chunks.push(arr.slice(i, i + size));
//     //   }
//     //   return chunks;
//     // }

