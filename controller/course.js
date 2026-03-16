import { db, FieldValue } from "../db/firebase.js";
import { serializeTimestamps } from "../utils/firestoreSerializer.js";
import { OUTLINE_SYSTEM_PROMPT } from "../prompts/outlinePrompt.js";
import {
  OutlineRequestSchema,
  LlmOutlineSchema,
  normalizeLlmOutline,
  SubtopicBatchResponseSchema,
  RegenerateContentOutlineSchema,
  normalizeLlmOutlineForRegeneration,
} from "../llm/outlineSchemas.js";
import { z } from "zod/mini";
import { SUBTOPIC_BATCH_PROMPT } from "../prompts/SubTopicBatchPrompt.js";
import { startBackgroundGeneration } from "../service/generationQueue.js";
import { getLLMProvider } from "../providers/LLMProviders.js";
import { fetchYoutubeVideos } from "../service/youtubeService.js";
import { grantXpOnce, touchUserDailyActivity } from "../service/gamificationService.js";

const coursesRef = db.collection("courses");

// ============================================================
//  POST /api/courses/generate-outline
// ============================================================
export const generateCourseOutline = async (req, res) => {
  try {
    const camelBody = {
      title: req.body.title || req.body.course_title,
      description: req.body.description,
      numUnits: req.body.numUnits ?? req.body.num_units,
      difficulty: req.body.difficulty,
      includeVideos: req.body.includeVideos ?? req.body.include_youtube ?? false,
      provider: req.body.provider ?? "Groq",
      model: req.body.model ?? null,
    };

    const result = OutlineRequestSchema.safeParse(camelBody);
    if (!result.success) {
      return res.status(400).json({ error: "Validation Failed", fields: z.treeifyError(result.error) });
    }

    const input = result.data;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const userInputs = {
      course_title: input.title,
      description: input.description,
      num_units: input.numUnits,
      difficulty: input.difficulty,
      include_youtube: !!input.includeVideos,
    };

    const llm = getLLMProvider(input.provider, input.model);
    const llmJson = await llm(OUTLINE_SYSTEM_PROMPT, userInputs);

    const normalized = normalizeLlmOutline(llmJson);
    if ((normalized.units?.length || 0) !== input.numUnits) {
      normalized.units = (normalized.units || []).slice(0, input.numUnits);
      if (normalized.units.length < input.numUnits) {
        return res.status(502).json({ error: "LLM returned fewer units than requested. Try again." });
      }
    }

    const parsed = LlmOutlineSchema.safeParse(normalized);
    if (!parsed.success) {
      return res.status(400).json({ error: "Validation Failed", fields: z.treeifyError(parsed.error) });
    }

    // Create course document
    const courseRef = coursesRef.doc();
    const courseId = courseRef.id;

    await courseRef.set({
      created_by: userId,
      title: input.title,
      description: input.description,
      difficulty: input.difficulty,
      include_videos: !!input.includeVideos,
      status: "draft",
      outline_json: parsed.data,
      outline_generated_at: new Date(),
      is_public: true,
      created_at: new Date(),
    });

    // Insert each unit and its subtopics as subcollections
    for (const unit of parsed.data.units) {
      const unitRef = courseRef.collection("units").doc();

      await unitRef.set({
        title: unit.title,
        position: unit.position,
      });

      // Insert subtopics
      let position = 1;
      for (const subtopicTitle of unit.subtopics) {
        await unitRef.collection("subtopics").doc().set({
          title: subtopicTitle,
          position: position++,
          content: null,
          content_generated_at: null,
        });
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
};

// ============================================================
//  PUT /api/course/:id/outline
// ============================================================
export const updateCourseOutline = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const courseDoc = await coursesRef.doc(id).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ error: "Course Not Found" });
    }
    if (courseDoc.data().created_by !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const normalized = normalizeLlmOutline(req.body);
    const parsed = LlmOutlineSchema.safeParse(normalized);

    if (!parsed.success) {
      return res.status(400).json({ error: "Validation Failed", fields: z.treeifyError(parsed.error) });
    }

    await coursesRef.doc(id).update({
      outline_json: parsed.data,
      outline_generated_at: new Date(),
      status: "draft",
    });

    return res.json({ ok: true, courseId: id, outline: parsed.data, status: "draft" });
  } catch (err) {
    console.error("updateCourseOutline error:", err);
    return res.status(500).json({ error: "Failed to update outline" });
  }
};

// ============================================================
//  PUT/POST  — Update or Regenerate Course Outline (with content)
// ============================================================
export const updateOrRegenerateCourseOutline = async (req, res, regenerateContent = false) => {
  const providerName = req.body.provider || req.query.provider || "Groq";
  const model = req.body.model || req.query.model || undefined;
  const { id } = req.params;
  const userId = req.user?.id;

  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const courseDoc = await coursesRef.doc(id).get();
  if (!courseDoc.exists) {
    return res.status(404).json({ error: "Course Not Found" });
  }
  if (courseDoc.data().created_by !== userId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const normalized = normalizeLlmOutlineForRegeneration(req.body);
  console.log("Normalized: ", JSON.stringify(normalized, null, 2));

  const parsed = RegenerateContentOutlineSchema.safeParse(normalized);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation Failed", fields: z.treeifyError(parsed.error) });
  }

  // Step 1: Fetch existing units and subtopics
  const unitsSnapshot = await coursesRef.doc(id).collection("units").get();
  const existingUnits = unitsSnapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

  const existingSubtopics = [];
  for (const unitDoc of unitsSnapshot.docs) {
    const subSnap = await coursesRef.doc(id).collection("units").doc(unitDoc.id).collection("subtopics").get();
    for (const subDoc of subSnap.docs) {
      existingSubtopics.push({
        unit_id: unitDoc.id,
        subtopic_id: subDoc.id,
        subtopic_title: subDoc.data().title,
      });
    }
  }

  // Step 2: Match / insert units
  const newOutline = [];
  for (const unit of parsed.data.units) {
    let existingUnit = existingUnits.find((u) => u.title === unit.title);

    if (!existingUnit) {
      const newUnitRef = coursesRef.doc(id).collection("units").doc();
      await newUnitRef.set({ title: unit.title, position: unit.position });
      existingUnit = { id: newUnitRef.id, title: unit.title };
    }

    unit.id = existingUnit.id;
    newOutline.push(unit);
  }

  // Step 3: Handle subtopics (insert/delete)
  const toInsertSubtopics = [];
  const toDeleteSubtopics = [];

  for (const unit of newOutline) {
    for (const [index, subtopicTitle] of unit.subtopics.entries()) {
      const found = existingSubtopics.find(
        (sub) => sub.subtopic_title === subtopicTitle && sub.unit_id === unit.id
      );
      if (!found) {
        toInsertSubtopics.push({
          unit_id: unit.id,
          subtopic_title: subtopicTitle,
          position: index + 1,
        });
      }
    }
  }

  for (const dbSubtopic of existingSubtopics) {
    const foundInNewOutline = newOutline
      .flatMap((unit) => unit.subtopics)
      .includes(dbSubtopic.subtopic_title);
    if (!foundInNewOutline) {
      toDeleteSubtopics.push({ unit_id: dbSubtopic.unit_id, subtopic_id: dbSubtopic.subtopic_id });
    }
  }

  // Batch write: delete and insert subtopics
  const batch = db.batch();

  for (const sub of toDeleteSubtopics) {
    const ref = coursesRef.doc(id).collection("units").doc(sub.unit_id).collection("subtopics").doc(sub.subtopic_id);
    batch.delete(ref);
  }

  for (const sub of toInsertSubtopics) {
    const ref = coursesRef.doc(id).collection("units").doc(sub.unit_id).collection("subtopics").doc();
    batch.set(ref, {
      title: sub.subtopic_title,
      position: sub.position,
      content: null,
      content_generated_at: null,
    });
  }

  await batch.commit();

  // Update course outline_json
  await coursesRef.doc(id).update({
    outline_json: parsed.data,
    outline_generated_at: new Date(),
    status: "draft",
  });

  // If regenerateContent, start background generation for new subtopics
  if (regenerateContent && toInsertSubtopics.length > 0) {
    const llm = getLLMProvider(providerName, model);

    for (const sub of toInsertSubtopics) {
      const unitDoc = await coursesRef.doc(id).collection("units").doc(sub.unit_id).get();
      const unitTitle = unitDoc.data()?.title || "";

      const batchInput = {
        course_title: courseDoc.data().title,
        unit_title: unitTitle,
        subtopics: [sub.subtopic_title],
        difficulty: courseDoc.data().difficulty || "Beginner",
        want_youtube_keywords: courseDoc.data().include_videos || false,
      };

      try {
        const batchRes = await llm(SUBTOPIC_BATCH_PROMPT, batchInput);
        if (batchRes && Array.isArray(batchRes)) {
          const parsedContent = SubtopicBatchResponseSchema.safeParse(batchRes);
          if (parsedContent.success) {
            for (const content of parsedContent.data) {
              // Find the subtopic doc we just inserted
              const subSnap = await coursesRef
                .doc(id)
                .collection("units")
                .doc(sub.unit_id)
                .collection("subtopics")
                .where("title", "==", content.subtopic_title)
                .limit(1)
                .get();

              if (!subSnap.empty) {
                await subSnap.docs[0].ref.update({
                  content: content,
                  content_generated_at: new Date(),
                });
              }
            }
          }
        }
      } catch (err) {
        console.error(`Content generation failed for subtopic: ${sub.subtopic_title}`, err);
      }
    }
  }

  const updatedOutline = parsed.data;
  return res.json({ status: "draft", outline: updatedOutline, courseId: id });
};

export const updateOrRegenerateCourseOutlineController = async (req, res) => {
  const regenerateContent = req.query.regenerate === "true";
  try {
    await updateOrRegenerateCourseOutline(req, res, regenerateContent);
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Failed to update course outline" });
  }
};

// ============================================================
//  GET /api/courses
// ============================================================
export const getAllPublicCourses = async (req, res) => {
  try {
    const snapshot = await coursesRef
      .where("is_public", "==", true)
      .orderBy("created_at", "desc")
      .get();

    const courses = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      let creator_name = "Unknown";
      if (data.created_by) {
        const userDoc = await db.collection("users").doc(data.created_by).get();
        if (userDoc.exists) creator_name = userDoc.data().username || "Unknown";
      }
      courses.push(serializeTimestamps({
        id: doc.id,
        ...data,
        creator_name,
      }));
    }

    return res.status(200).json({ courses });
  } catch (err) {
    console.error("getAllPublicCourses error:", err);
    return res.status(500).json({ error: "Failed to fetch courses" });
  }
};

// ============================================================
//  GET /api/courses/me
// ============================================================
export const getCoursesCreatedByMe = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const snapshot = await coursesRef
      .where("created_by", "==", userId)
      .orderBy("created_at", "desc")
      .get();

    const myCourses = snapshot.docs.map((doc) => serializeTimestamps({
      id: doc.id,
      ...doc.data(),
    }));

    return res.status(200).json({ myCourses });
  } catch (err) {
    console.error("getMyCourses error:", err);
    return res.status(500).json({ error: "Failed to fetch your courses" });
  }
};

// ============================================================
//  POST /api/courses/:id/enroll
// ============================================================
export const enrollInCourse = async (req, res) => {
  const userId = req.user?.id;
  const courseId = req.params.id;

  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const courseDoc = await coursesRef.doc(courseId).get();

    if (!courseDoc.exists) {
      return res.status(404).json({ error: "Course doesn't exist" });
    }
    if (!courseDoc.data().is_public) {
      return res.status(403).json({ error: "Can't Enroll in this course it's not public" });
    }

    // Check if already enrolled (composite doc ID)
    const enrollmentId = `${userId}_${courseId}`;
    const enrollDoc = await db.collection("user_courses").doc(enrollmentId).get();

    if (enrollDoc.exists) {
      return res.status(409).json({ error: "Already Enrolled" });
    }

    // Enroll
    await db.collection("user_courses").doc(enrollmentId).set({
      user_id: userId,
      course_id: courseId,
      joined_at: new Date(),
    });

    // Update course_public_stats
    const statsRef = db.collection("course_public_stats").doc(courseId);
    await statsRef.set(
      {
        course_id: courseId,
        total_users_joined: FieldValue.increment(1),
        last_updated: new Date(),
      },
      { merge: true }
    );

    return res.status(200).json({ message: "Enrolled Successfully" });
  } catch (err) {
    console.error("enrollInCourse error:", err);
    return res.status(500).json({ error: "Failed to enroll" });
  }
};

// ============================================================
//  GET /api/courses/me/enrolled
// ============================================================
export const getCoursesEnrolledByMe = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Get all enrollments for this user
    const enrollSnap = await db
      .collection("user_courses")
      .where("user_id", "==", userId)
      .orderBy("joined_at", "desc")
      .get();

    const enrolledCourses = [];

    for (const enrollDoc of enrollSnap.docs) {
      const { course_id, joined_at } = enrollDoc.data();

      const courseDoc = await coursesRef.doc(course_id).get();
      if (!courseDoc.exists) continue;

      const course = courseDoc.data();

      // Skip courses created by this user (same behavior as PostgreSQL version)
      if (course.created_by === userId) continue;

      // Get creator name
      let creator_name = "Unknown";
      if (course.created_by) {
        const userDoc = await db.collection("users").doc(course.created_by).get();
        if (userDoc.exists) creator_name = userDoc.data().username;
      }

      // Get stats
      let total_users_joined = 0;
      const statsDoc = await db.collection("course_public_stats").doc(course_id).get();
      if (statsDoc.exists) total_users_joined = statsDoc.data().total_users_joined || 0;

      enrolledCourses.push(serializeTimestamps({
        id: course_id,
        title: course.title,
        description: course.description,
        difficulty: course.difficulty,
        include_videos: course.include_videos,
        status: course.status,
        created_by: course.created_by,
        outline_json: course.outline_json,
        creator_name,
        total_users_joined,
        joined_at,
      }));
    }

    return res.status(200).json({ enrolledCourses });
  } catch (err) {
    console.error("getEnrolledCourses error:", err);
    return res.status(500).json({ error: "Failed to fetch enrolled courses" });
  }
};

// ============================================================
//  GET /api/courses/:id/getoutline
// ============================================================
export const getCourseOutline = async (req, res) => {
  const courseId = req.params.id;
  try {
    const courseDoc = await coursesRef.doc(courseId).get();

    if (!courseDoc.exists || !courseDoc.data().is_public) {
      return res.status(404).json({ error: "Course not found or not public" });
    }

    return res.status(200).json({ outline: courseDoc.data().outline_json });
  } catch (err) {
    console.error("getCourseOutlineOnly error:", err);
    return res.status(500).json({ error: "Failed to fetch course outline" });
  }
};

// ============================================================
//  DELETE /api/courses/:id
// ============================================================
export const deleteCourseById = async (req, res) => {
  const userId = req.user?.id;
  const courseId = req.params.id;

  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const courseDoc = await coursesRef.doc(courseId).get();

    if (!courseDoc.exists) return res.status(404).json({ error: "Course Not Found" });

    if (courseDoc.data().created_by !== userId) {
      return res.status(403).json({
        error: "You're not allowed to delete this course, you're not the owner of the course",
      });
    }

    // Delete subcollections (units → subtopics → videos)
    const unitsSnap = await coursesRef.doc(courseId).collection("units").get();
    for (const unitDoc of unitsSnap.docs) {
      const subsSnap = await unitDoc.ref.collection("subtopics").get();
      for (const subDoc of subsSnap.docs) {
        const videosSnap = await subDoc.ref.collection("videos").get();
        const vBatch = db.batch();
        videosSnap.docs.forEach((v) => vBatch.delete(v.ref));
        if (!videosSnap.empty) await vBatch.commit();

        await subDoc.ref.delete();
      }
      await unitDoc.ref.delete();
    }

    // Delete related top-level docs
    const enrollSnap = await db.collection("user_courses").where("course_id", "==", courseId).get();
    if (!enrollSnap.empty) {
      const eBatch = db.batch();
      enrollSnap.docs.forEach((d) => eBatch.delete(d.ref));
      await eBatch.commit();
    }

    const progressSnap = await db.collection("user_progress").where("course_id", "==", courseId).get();
    if (!progressSnap.empty) {
      const pBatch = db.batch();
      progressSnap.docs.forEach((d) => pBatch.delete(d.ref));
      await pBatch.commit();
    }

    await db.collection("course_public_stats").doc(courseId).delete().catch(() => { });
    await db.collection("course_generation_status").doc(courseId).delete().catch(() => { });

    // Delete course doc
    await coursesRef.doc(courseId).delete();

    return res.status(200).json({ message: "Course Deleted Successfully" });
  } catch (err) {
    console.error("deleteCourseById error:", err);
    return res.status(500).json({ error: "Failed to delete course" });
  }
};

// ============================================================
//  GET /api/courses/:id/full
// ============================================================
export const getCourseContentById = async (req, res) => {
  const courseId = req.params.id;
  const userId = req.user?.id;

  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const courseDoc = await coursesRef.doc(courseId).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ error: "Course not found" });
    }

    const course = { id: courseId, ...courseDoc.data() };

    // Check access: creator OR enrolled OR public course
    const isCreator = course.created_by === userId;
    const isPublic = course.is_public === true;
    if (!isCreator && !isPublic) {
      const enrollId = `${userId}_${courseId}`;
      const enrollDoc = await db.collection("user_courses").doc(enrollId).get();
      if (!enrollDoc.exists) {
        return res.status(403).json({ error: "Access Denied to this course" });
      }
    }

    // Fetch units (ordered by position)
    const unitsSnap = await coursesRef.doc(courseId).collection("units").orderBy("position").get();
    const units = [];

    for (const unitDoc of unitsSnap.docs) {
      const unit = { id: unitDoc.id, course_id: courseId, ...unitDoc.data() };

      // Fetch subtopics
      const subsSnap = await unitDoc.ref.collection("subtopics").orderBy("position").get();
      unit.subtopics = [];

      for (const subDoc of subsSnap.docs) {
        const subtopic = { id: subDoc.id, unit_id: unitDoc.id, ...subDoc.data() };

        // Fetch videos
        const videosSnap = await subDoc.ref.collection("videos").get();
        subtopic.videos = videosSnap.docs.map((v) => ({ id: v.id, subtopic_id: subDoc.id, ...v.data() }));

        unit.subtopics.push(subtopic);
      }

      units.push(unit);
    }

    return res.status(200).json(serializeTimestamps({ course, units }));
  } catch (err) {
    console.error("getCourseContentById error:", err);
    res.status(500).json({ error: "Failed to fetch course content" });
  }
};

// ============================================================
//  POST /api/courses/:id/generate-content
// ============================================================
export const generateCourseContent = async (req, res) => {
  const providerName = req.body.provider || "Groq";
  const isCerebras = providerName.toLowerCase() === "cerebras";

  if (isCerebras) {
    return generateFullCourseWithCerebras(req, res);
  } else {
    return generateWithBatching(req, res);
  }
};

// ============================================================
//  Generate content with batching (Groq/Gemini)
// ============================================================
export const generateWithBatching = async (req, res) => {
  const courseId = req.params.id;
  const userId = req.user?.id;
  const providerName = req.body.provider || req.query.provider || "Groq";
  const model = req.body.model || req.query.model || undefined;

  const llm = getLLMProvider(providerName, model);

  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const courseDoc = await coursesRef.doc(courseId).get();
    if (!courseDoc.exists) return res.status(404).json({ error: "Course not found" });

    const course = courseDoc.data();
    if (course.created_by !== userId) return res.status(403).json({ error: "Forbidden" });

    // Auto-enroll
    const enrollmentId = `${userId}_${courseId}`;
    const enrollDoc = await db.collection("user_courses").doc(enrollmentId).get();
    if (!enrollDoc.exists) {
      await db.collection("user_courses").doc(enrollmentId).set({
        user_id: userId,
        course_id: courseId,
        joined_at: new Date(),
      });

      if (course.is_public) {
        await db.collection("course_public_stats").doc(courseId).set(
          {
            course_id: courseId,
            total_users_joined: FieldValue.increment(1),
            last_updated: new Date(),
          },
          { merge: true }
        );
      }
    }

    // Get first 1 unit (matches original behavior)
    const unitSnap = await coursesRef
      .doc(courseId)
      .collection("units")
      .orderBy("position")
      .limit(1)
      .get();

    const units = unitSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!units.length) return res.status(400).json({ error: "No units to generate." });

    let totalSubtopicsProcessed = 0;

    const chunkArray = (arr, size) => {
      const chunks = [];
      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }
      return chunks;
    };

    for (const unit of units) {
      const subsSnap = await coursesRef
        .doc(courseId)
        .collection("units")
        .doc(unit.id)
        .collection("subtopics")
        .get();

      const allSubtopics = subsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const missingSubtopics = allSubtopics.filter((s) => !s.content);
      if (missingSubtopics.length === 0) continue;

      let batches;
      if (missingSubtopics.length <= 4) {
        batches = [missingSubtopics];
      } else {
        batches = chunkArray(missingSubtopics, 3);
      }

      for (const batch of batches) {
        const batchInput = {
          course_title: course.title,
          unit_title: unit.title,
          subtopics: batch.map((s) => s.title),
          difficulty: course.difficulty || "Beginner",
          want_youtube_keywords: course.include_videos || false,
        };

        const batchRes = await llm(SUBTOPIC_BATCH_PROMPT, batchInput);
        if (!batchRes || !Array.isArray(batchRes)) {
          console.warn(`Invalid batch response for unit: ${unit.title}`);
          continue;
        }

        const parsed = SubtopicBatchResponseSchema.safeParse(batchRes);
        if (!parsed.success) {
          console.warn(`Batch Schema validation failed for unit: ${unit.title}`, parsed.error);
          continue;
        }

        const normalize = (str) => str?.toLowerCase().replace(/\s+/g, " ").trim() ?? "";

        for (const content of parsed.data) {
          const match = batch.find((s) => normalize(s.title) === normalize(content.subtopic_title));

          if (!match || !match.id) {
            console.warn(`Could not match content: ${content.subtopic_title}`);
            continue;
          }

          // Save content to Firestore
          await coursesRef
            .doc(courseId)
            .collection("units")
            .doc(unit.id)
            .collection("subtopics")
            .doc(match.id)
            .update({
              content: content,
              content_generated_at: new Date(),
            });

          totalSubtopicsProcessed++;

          // YouTube videos
          if (course.include_videos && content.youtube_keywords?.length) {
            fetchYoutubeVideosInBackground(content.youtube_keywords, courseId, unit.id, match.id);
          }
        }
      }
    }

    return res.status(200).json({
      message: `Generated content for ${totalSubtopicsProcessed} subtopics`,
      generated: totalSubtopicsProcessed,
    });
  } catch (err) {
    console.error("generateWithBatching error:", err);
    return res.status(500).json({ error: "Failed to generate content" });
  }
};

// ============================================================
//  Generate full course with Cerebras (single batch, full course)
// ============================================================
export const generateFullCourseWithCerebras = async (req, res) => {
  const courseId = req.params.id;
  const userId = req.user?.id;
  const model = req.body.model || undefined;

  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const courseDoc = await coursesRef.doc(courseId).get();
    if (!courseDoc.exists) return res.status(404).json({ error: "Course not found" });

    const course = courseDoc.data();
    if (course.created_by !== userId) return res.status(403).json({ error: "Forbidden" });

    const llm = getLLMProvider("Cerebras", model);

    // Get all units + missing subtopics
    const unitsSnap = await coursesRef.doc(courseId).collection("units").orderBy("position").get();

    const unitsData = [];
    const subtopicMap = new Map(); // subtopic title -> { unitId, subtopicId }

    for (const unitDoc of unitsSnap.docs) {
      const subsSnap = await unitDoc.ref.collection("subtopics").orderBy("position").get();
      const subtopics = subsSnap.docs
        .filter((d) => !d.data().content)
        .map((d) => {
          subtopicMap.set(d.data().title.toLowerCase().trim(), {
            unitId: unitDoc.id,
            subtopicId: d.id,
          });
          return d.data().title;
        });

      if (subtopics.length > 0) {
        unitsData.push({ unit_title: unitDoc.data().title, subtopics });
      }
    }

    if (unitsData.length === 0) {
      return res.status(200).json({ message: "All content already generated", generated: 0 });
    }

    const input = {
      course_title: course.title,
      difficulty: course.difficulty,
      units: unitsData,
      want_youtube_keywords: course.include_videos,
    };

    const result = await llm(SUBTOPIC_BATCH_PROMPT, input);
    const parsed = SubtopicBatchResponseSchema.safeParse(result);

    if (!parsed.success) {
      return res.status(502).json({ error: "Invalid LLM response from Cerebras" });
    }

    let generated = 0;
    for (const content of parsed.data) {
      const key = content.subtopic_title?.toLowerCase().trim();
      const location = subtopicMap.get(key);

      if (!location) {
        console.warn(`No matching subtopic for: ${content.subtopic_title}`);
        continue;
      }

      await coursesRef
        .doc(courseId)
        .collection("units")
        .doc(location.unitId)
        .collection("subtopics")
        .doc(location.subtopicId)
        .update({ content: content, content_generated_at: new Date() });

      generated++;

      if (course.include_videos && content.youtube_keywords?.length) {
        fetchYoutubeVideosInBackground(
          content.youtube_keywords,
          courseId,
          location.unitId,
          location.subtopicId
        );
      }
    }

    return res.status(200).json({ message: `Generated ${generated} subtopics`, generated });
  } catch (err) {
    console.error("generateFullCourseWithCerebras error:", err);
    return res.status(500).json({ error: "Failed to generate with Cerebras" });
  }
};

// ============================================================
//  Helper: chunk array
// ============================================================
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ============================================================
//  SSE Streaming Course Generation
// ============================================================
export const streamCourseGeneration = async (req, res) => {
  const courseId = req.params.id;
  const userId = req.user?.id;

  // SSE Headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  let rawBody = "";
  req.on("data", (chunk) => (rawBody += chunk.toString()));
  req.on("end", async () => {
    let providerName = "Groq";
    let model = null;

    if (rawBody) {
      try {
        const cleaned = rawBody.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]").trim();
        const parsed = JSON.parse(cleaned);
        providerName = (parsed.provider || "Groq").trim();
        model = parsed.model || null;
      } catch (e) {
        send({ type: "error", message: "Invalid request format" });
        res.end();
        return;
      }
    }

    const isCerebras = providerName.toLowerCase() === "cerebras";

    try {
      // 1. Verify ownership + get course
      const courseDoc = await coursesRef.doc(courseId).get();
      if (!courseDoc.exists || courseDoc.data().created_by !== userId) {
        send({ type: "error", message: "Course not found or not owned" });
        res.end();
        return;
      }
      const course = courseDoc.data();

      // 2. Auto-enroll
      const enrollmentId = `${userId}_${courseId}`;
      const enrollDoc = await db.collection("user_courses").doc(enrollmentId).get();
      if (!enrollDoc.exists) {
        await db.collection("user_courses").doc(enrollmentId).set({
          user_id: userId,
          course_id: courseId,
          joined_at: new Date(),
        });
        if (course.is_public) {
          await db.collection("course_public_stats").doc(courseId).set(
            { course_id: courseId, total_users_joined: FieldValue.increment(1), last_updated: new Date() },
            { merge: true }
          );
        }
      }

      // 3. Get missing subtopics (across all units)
      const unitsSnap = await coursesRef.doc(courseId).collection("units").orderBy("position").get();

      const missingSubtopics = [];
      for (const unitDoc of unitsSnap.docs) {
        const subsSnap = await unitDoc.ref.collection("subtopics").orderBy("position").get();
        for (const subDoc of subsSnap.docs) {
          if (!subDoc.data().content) {
            missingSubtopics.push({
              id: subDoc.id,
              title: subDoc.data().title,
              unit_id: unitDoc.id,
              unit_title: unitDoc.data().title,
              unit_position: unitDoc.data().position,
            });
          }
        }
      }

      if (missingSubtopics.length === 0) {
        send({ type: "complete", generated: 0, total: 0, message: "All content already generated" });
        res.end();
        return;
      }

      const total = missingSubtopics.length;
      let generated = 0;
      send({ type: "start", total, provider: providerName, isCerebras });

      const llmProvider = getLLMProvider(providerName);

      // 4. Group by unit
      const grouped = new Map();
      for (const sub of missingSubtopics) {
        if (!grouped.has(sub.unit_id)) {
          grouped.set(sub.unit_id, {
            unit_title: sub.unit_title,
            unit_position: sub.unit_position,
            subtopics: [],
          });
        }
        grouped.get(sub.unit_id).subtopics.push(sub);
      }

      // 5. Process based on provider type
      if (isCerebras) {
        generated = await processCerebrasBatch(course, courseId, grouped, total, generated, send, llmProvider);
      } else {
        generated = await processStreamingBatches(course, courseId, grouped, total, generated, send, llmProvider);
      }

      // 6. Final status
      await db.collection("course_generation_status").doc(courseId).set(
        {
          course_id: courseId,
          status: "completed",
          total_subtopics: total,
          generated_subtopics: generated,
          last_updated: new Date(),
        },
        { merge: true }
      );

      send({ type: "complete", generated, total });
    } catch (err) {
      send({ type: "error", message: err.message || "Generation failed" });
      console.error("Streaming generation failed:", err);
    } finally {
      res.end();
    }
  });
};

// ============================================================
//  Cerebras batch processor (entire course at once)
// ============================================================
async function processCerebrasBatch(course, courseId, grouped, total, generated, send, llmProvider) {
  console.log("Cerebras: Processing entire course in one batch");

  const units = Array.from(grouped.values())
    .sort((a, b) => a.unit_position - b.unit_position)
    .map((unit) => ({
      unit_title: unit.unit_title,
      subtopics: unit.subtopics.map((s) => s.title),
    }));

  const input = {
    course_title: course.title,
    difficulty: course.difficulty,
    units: units,
    want_youtube_keywords: course.include_videos,
  };

  try {
    const result = await llmProvider(SUBTOPIC_BATCH_PROMPT, input);
    const parsed = SubtopicBatchResponseSchema.safeParse(result);
    if (!parsed.success) {
      send({ type: "error", message: "Invalid LLM response from Cerebras" });
      return generated;
    }

    for (const content of parsed.data) {
      let subtopic = null;
      for (const unit of grouped.values()) {
        subtopic = unit.subtopics.find(
          (s) => s.title.toLowerCase().trim() === content.subtopic_title.toLowerCase().trim()
        );
        if (subtopic) break;
      }

      if (!subtopic) {
        console.warn(`No matching subtopic for: ${content.subtopic_title}`);
        continue;
      }

      await coursesRef
        .doc(courseId)
        .collection("units")
        .doc(subtopic.unit_id)
        .collection("subtopics")
        .doc(subtopic.id)
        .update({ content: content, content_generated_at: new Date() });

      generated++;
      send({
        type: "progress",
        subtopic: subtopic.title,
        unit: subtopic.unit_title,
        progress: Math.round((generated / total) * 100),
        generated,
        total,
      });

      if (course.include_videos && content.youtube_keywords?.length) {
        fetchYoutubeVideosInBackground(content.youtube_keywords, courseId, subtopic.unit_id, subtopic.id);
      }
    }
  } catch (err) {
    console.error("Cerebras batch processing error:", err);
    throw err;
  }

  return generated;
}

// ============================================================
//  Streaming batch processor (3-subtopic batches)
// ============================================================
async function processStreamingBatches(course, courseId, grouped, total, generated, send, llmProvider) {
  console.log("Streaming: Processing in 3-subtopic batches");

  const allBatches = [];
  for (const [unitId, unitData] of grouped) {
    const batches = chunkArray(unitData.subtopics, 3);
    allBatches.push(
      ...batches.map((batch) => ({
        unit_id: unitId,
        unit_title: unitData.unit_title,
        subtopics: batch,
      }))
    );
  }

  for (const [batchIdx, batchData] of allBatches.entries()) {
    const batchInput = {
      course_title: course.title,
      unit_title: batchData.unit_title,
      subtopics: batchData.subtopics.map((s) => s.title),
      difficulty: course.difficulty || "Beginner",
      want_youtube_keywords: course.include_videos,
    };

    try {
      const batchRes = await llmProvider(SUBTOPIC_BATCH_PROMPT, batchInput);
      if (!batchRes || !Array.isArray(batchRes)) {
        send({ type: "warning", message: `Invalid response for batch` });
        continue;
      }

      const parsed = SubtopicBatchResponseSchema.safeParse(batchRes);
      if (!parsed.success) {
        send({ type: "warning", message: `Validation failed for batch` });
        continue;
      }

      send({
        type: "chunk",
        subtopic: `Batch ${batchIdx + 1}: ${batchData.subtopics.map((s) => s.title).join(", ")}`,
        chunk: JSON.stringify(parsed.data, null, 2),
        unit: batchData.unit_title,
      });

      for (const content of parsed.data) {
        const subtopic = batchData.subtopics.find(
          (s) => s.title.toLowerCase().trim() === content.subtopic_title.toLowerCase().trim()
        );

        if (!subtopic) {
          send({ type: "warning", message: `No match for: ${content.subtopic_title}` });
          continue;
        }

        await coursesRef
          .doc(courseId)
          .collection("units")
          .doc(batchData.unit_id)
          .collection("subtopics")
          .doc(subtopic.id)
          .update({ content: content, content_generated_at: new Date() });

        generated++;
        send({
          type: "progress",
          subtopic: subtopic.title,
          unit: subtopic.unit_title,
          progress: Math.round((generated / total) * 100),
          generated,
          total,
        });

        if (course.include_videos && content.youtube_keywords?.length) {
          fetchYoutubeVideosInBackground(content.youtube_keywords, courseId, batchData.unit_id, subtopic.id);
        }
      }

      // Rate limit between batches
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
      send({ type: "warning", message: `Batch ${batchIdx + 1} failed` });
      console.error("Batch error:", err);
    }
  }

  return generated;
}

// ============================================================
//  Fire-and-forget YouTube video fetching
// ============================================================
export async function fetchYoutubeVideosInBackground(keywords, courseId, unitId, subtopicId) {
  (async () => {
    try {
      const videos = await fetchYoutubeVideos(keywords);
      if (!Array.isArray(videos) || !videos.length) return;

      const videoCollRef = coursesRef
        .doc(courseId)
        .collection("units")
        .doc(unitId)
        .collection("subtopics")
        .doc(subtopicId)
        .collection("videos");

      for (const video of videos) {
        const { title, youtube_url, thumbnail, duration_sec } = video;

        // Check for duplicate
        const existing = await videoCollRef.where("youtube_url", "==", youtube_url).limit(1).get();
        if (existing.empty) {
          await videoCollRef.doc().set({
            title,
            youtube_url,
            thumbnail,
            duration_sec: duration_sec || null,
          });
        }
      }
    } catch (e) {
      console.error("Background YouTube fetch failed:", e);
    }
  })();
}

// ============================================================
//  GET /api/courses/:id/generation-status
// ============================================================
export const getCourseGenerationStatus = async (req, res) => {
  const courseId = req.params.id;
  const since = req.query.since;

  try {
    const statusDoc = await db.collection("course_generation_status").doc(courseId).get();

    if (!statusDoc.exists) {
      return res.status(404).json({ error: "No generation status found" });
    }

    const status = statusDoc.data();

    // Get generated subtopics
    const unitsSnap = await coursesRef.doc(courseId).collection("units").get();
    const subtopics = [];

    for (const unitDoc of unitsSnap.docs) {
      let query = unitDoc.ref
        .collection("subtopics")
        .where("content", "!=", null);

      const subsSnap = await query.get();

      for (const subDoc of subsSnap.docs) {
        const data = subDoc.data();

        // Filter by 'since' if provided
        if (since && data.content_generated_at) {
          const genTime = data.content_generated_at.toDate
            ? data.content_generated_at.toDate()
            : new Date(data.content_generated_at);
          if (genTime <= new Date(since)) continue;
        }

        subtopics.push({
          id: subDoc.id,
          title: data.title,
          content: typeof data.content === "string" ? JSON.parse(data.content) : data.content,
          content_generated_at: data.content_generated_at,
          unit_title: unitDoc.data().title,
        });
      }
    }

    // Sort by content_generated_at asc
    subtopics.sort((a, b) => {
      const aTime = a.content_generated_at?.toDate ? a.content_generated_at.toDate() : new Date(a.content_generated_at || 0);
      const bTime = b.content_generated_at?.toDate ? b.content_generated_at.toDate() : new Date(b.content_generated_at || 0);
      return aTime - bTime;
    });

    return res.status(200).json({
      courseId,
      status: status.status,
      totalSubtopics: status.total_subtopics,
      generatedSubtopics: status.generated_subtopics,
      lastUpdated: status.last_updated,
      subtopics,
    });
  } catch (err) {
    console.error("getCourseGenerationStatus error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// ============================================================
//  POST /api/courses/:id/retry-failed-subtopics
// ============================================================
export const retryFailedSubtopics = async (req, res) => {
  const courseId = req.params.id;
  const userId = req.user?.id;
  const provider = req.body.provider || "Groq";
  const model = req.body.model || undefined;

  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const courseDoc = await coursesRef.doc(courseId).get();
    if (!courseDoc.exists) return res.status(404).json({ error: "Course Not Found" });

    if (courseDoc.data().created_by !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Count missing subtopics
    let missingCount = 0;
    const unitsSnap = await coursesRef.doc(courseId).collection("units").get();
    for (const unitDoc of unitsSnap.docs) {
      const subsSnap = await unitDoc.ref.collection("subtopics").get();
      for (const subDoc of subsSnap.docs) {
        if (!subDoc.data().content) missingCount++;
      }
    }

    if (missingCount === 0) {
      return res.status(200).json({
        message: "No Failed subtopics found to retry",
        status: "idle",
        remaining_subtopics: 0,
      });
    }

    startBackgroundGeneration(courseId, userId, provider, model)
      .then(() => console.log(`Retry background generation started for course: ${courseId}`))
      .catch((err) => console.log(`Retry background generation failed for course: ${courseId}`, err));

    await db.collection("course_generation_status").doc(courseId).set(
      {
        course_id: courseId,
        status: "in_progress",
        total_subtopics: missingCount,
        generated_subtopics: 0,
        last_updated: new Date(),
      },
      { merge: true }
    );

    return res.status(202).json({
      message: "Retry initiated for failed subtopics",
      status: "in_progress",
      remaining_subtopics: missingCount,
    });
  } catch (err) {
    console.error("retryFailedSubtopics error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

// ============================================================
//  Search
// ============================================================
export const searchCourses = async (req, res) => {
  try {
    const { query } = req.query;
    if (!query?.trim()) return res.status(400).json({ error: "Query required" });

    // Firestore doesn't have ILIKE — use client-side filtering
    const snapshot = await coursesRef
      .where("is_public", "==", true)
      .orderBy("created_at", "desc")
      .limit(50) // fetch more, filter locally
      .get();

    const queryLower = query.toLowerCase();
    const courses = [];

    for (const doc of snapshot.docs) {
      if (courses.length >= 5) break;
      const data = doc.data();
      if (data.title?.toLowerCase().includes(queryLower)) {
        // Get creator name
        let creator_name = "Unknown";
        if (data.created_by) {
          const userDoc = await db.collection("users").doc(data.created_by).get();
          if (userDoc.exists) creator_name = userDoc.data().username;
        }
        courses.push({ id: doc.id, title: data.title, creator_name });
      }
    }

    res.json({ courses });
  } catch (err) {
    console.error("searchCourses error:", err);
    res.status(500).json({ error: "Search failed" });
  }
};

export const searchCoursesFull = async (req, res) => {
  try {
    const { query = "", difficulty, sortBy } = req.query;
    if (!query.trim()) return res.status(400).json({ error: "Query required" });

    let firestoreQuery = coursesRef.where("is_public", "==", true);

    // Add difficulty filter if provided
    if (difficulty) {
      firestoreQuery = firestoreQuery.where("difficulty", "==", difficulty);
    }

    // Sorting
    switch (sortBy) {
      case "Newest":
        firestoreQuery = firestoreQuery.orderBy("created_at", "desc");
        break;
      default:
        firestoreQuery = firestoreQuery.orderBy("created_at", "desc");
    }

    const snapshot = await firestoreQuery.limit(100).get(); // fetch more, filter locally

    const queryLower = query.toLowerCase();
    const courses = [];

    for (const doc of snapshot.docs) {
      if (courses.length >= 20) break;
      const data = doc.data();
      if (!data.title?.toLowerCase().includes(queryLower)) continue;

      // Get creator name
      let creator_name = "Unknown";
      if (data.created_by) {
        const userDoc = await db.collection("users").doc(data.created_by).get();
        if (userDoc.exists) creator_name = userDoc.data().username;
      }

      // Get stats
      let total_users_joined = 0;
      const statsDoc = await db.collection("course_public_stats").doc(doc.id).get();
      if (statsDoc.exists) total_users_joined = statsDoc.data().total_users_joined || 0;

      courses.push({
        id: doc.id,
        title: data.title,
        description: data.description,
        difficulty: data.difficulty,
        creator_name,
        total_users_joined,
        created_at: data.created_at,
      });
    }

    // Sort by enrollment count if requested
    if (sortBy === "Most_Enrolled") {
      courses.sort((a, b) => b.total_users_joined - a.total_users_joined);
    }

    res.json({ courses });
  } catch (err) {
    console.error("searchCoursesFull error:", err);
    res.status(500).json({ error: "Search failed" });
  }
};

// ============================================================
//  DELETE /api/courses/:id/unenroll
// ============================================================
export const unenrollFromCourse = async (req, res) => {
  const userId = req.user?.id;
  const courseId = req.params.id;

  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const enrollmentId = `${userId}_${courseId}`;
    const enrollDoc = await db.collection("user_courses").doc(enrollmentId).get();

    if (!enrollDoc.exists) {
      return res.status(400).json({ error: "Not enrolled in this course" });
    }

    await db.collection("user_courses").doc(enrollmentId).delete();

    // Decrement stats
    const statsRef = db.collection("course_public_stats").doc(courseId);
    const statsDoc = await statsRef.get();
    if (statsDoc.exists) {
      const current = statsDoc.data().total_users_joined || 0;
      await statsRef.update({
        total_users_joined: Math.max(current - 1, 0),
        last_updated: new Date(),
      });
    }

    return res.status(200).json({ message: "Unenrolled Successfully" });
  } catch (err) {
    console.error("unenrollFromCourse error:", err);
    return res.status(500).json({ error: "Failed to unenroll" });
  }
};

// ============================================================
//  Notes  (per subtopic, per user)
// ============================================================
export const saveNote = async (req, res) => {
  const subtopicId = req.params.id;
  const { note } = req.body;
  const userId = req.user.id;

  try {
    const noteId = `${userId}_${subtopicId}`;
    await db.collection("user_notes").doc(noteId).set(
      {
        user_id: userId,
        subtopic_id: subtopicId,
        note: note || "",
        updated_at: new Date(),
      },
      { merge: true }
    );
    res.json({ message: "Note saved" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save note" });
  }
};

export const getNote = async (req, res) => {
  const subtopicId = req.params.id;
  const userId = req.user.id;

  try {
    const noteId = `${userId}_${subtopicId}`;
    const noteDoc = await db.collection("user_notes").doc(noteId).get();
    res.json({ note: noteDoc.exists ? noteDoc.data().note : "" });
  } catch (err) {
    res.status(500).json({ error: "Failed to get note" });
  }
};

// ============================================================
//  Progress tracking (per subtopic, per user)
// ============================================================
export const markComplete = async (req, res) => {
  const subtopicId = req.params.id;
  const { completed } = req.body;
  const userId = req.user.id;

  try {
    const progressId = `${userId}_${subtopicId}`;
    if (completed) {
      await db.collection("user_progress").doc(progressId).set({
        user_id: userId,
        subtopic_id: subtopicId,
        completed_at: new Date(),
      });

      await grantXpOnce(userId, `subtopic_complete_${subtopicId}`, 50, {
        activityType: "subtopic_complete",
        metadata: { subtopic_id: subtopicId, source: "manual_complete" },
        statIncrements: {
          subtopics_completed: 1,
          quizzes_passed: 1,
        },
      });
    } else {
      await db.collection("user_progress").doc(progressId).delete();
      await touchUserDailyActivity(userId, "subtopic_uncomplete", { subtopic_id: subtopicId });
    }
    res.json({ message: "Progress updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update progress" });
  }
};

export const getProgress = async (req, res) => {
  const { id: courseId } = req.params;
  const userId = req.user.id;

  try {
    // We need to find all subtopic IDs for this course, then check progress
    const unitsSnap = await coursesRef.doc(courseId).collection("units").get();
    const subtopicIds = [];

    for (const unitDoc of unitsSnap.docs) {
      const subsSnap = await unitDoc.ref.collection("subtopics").get();
      subsSnap.docs.forEach((d) => subtopicIds.push(d.id));
    }

    // Check progress for each subtopic
    const progress = [];
    for (const subtopicId of subtopicIds) {
      const progressId = `${userId}_${subtopicId}`;
      const progressDoc = await db.collection("user_progress").doc(progressId).get();
      if (progressDoc.exists) {
        progress.push({ subtopic_id: subtopicId, completed: true });
      }
    }

    res.json(progress);
  } catch (err) {
    res.status(500).json({ error: "Failed to get progress" });
  }
};

// ============================================================
//  Safe JSON parser
// ============================================================
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}