// ============================================================
//  Video Generation Controller
//  Full pipeline: Content → Script → Scenes → Assets → Video
//  Orchestrates all services for course video generation
// ============================================================

import { db } from "../db/firebase.js";
import { getLLMProvider } from "../providers/LLMProviders.js";
import { VIDEO_SCRIPT_PROMPT, SCENE_PLAN_PROMPT } from "../prompts/videoPrompt.js";
import { VideoScriptSchema, ScenePlanListSchema } from "../llm/videoSchemas.js";
import { generateSVGForScene, generateQuoteSVG } from "../service/svgGeneratorService.js";
import { generateIllustration } from "../service/imageGenerationService.js";
import { synthesize } from "../service/ttsService.js";
import { chooseTransition, planTransitions } from "../service/transitionEngine.js";
import {
  renderSceneClip,
  renderSubscenes,
  stitchScenes,
  prepareVisualAsset,
  saveAudioToFile,
  getAudioDuration,
  cleanupJobFiles,
  readVideoFile,
  OUTPUT_DIR,
} from "../service/videoRenderService.js";
import { uploadAudio } from "../service/imagekitService.js";
import { serializeTimestamps } from "../utils/firestoreSerializer.js";
import path from "path";
import fs from "fs/promises";
import { existsSync, mkdirSync } from "fs";

const coursesRef = db.collection("courses");
const videosRef = db.collection("generated_videos");

// ─────────────────────────────────────────
//  Helper: Find subtopic with full context
// ─────────────────────────────────────────

async function findSubtopicWithContext(subtopicId) {
  const coursesSnap = await coursesRef.get();

  for (const courseDoc of coursesSnap.docs) {
    const unitsSnap = await courseDoc.ref.collection("units").get();
    for (const unitDoc of unitsSnap.docs) {
      const subDoc = await unitDoc.ref.collection("subtopics").doc(subtopicId).get();
      if (subDoc.exists) {
        return {
          course: { id: courseDoc.id, ...courseDoc.data() },
          unit: { id: unitDoc.id, ...unitDoc.data() },
          subtopic: { id: subDoc.id, ...subDoc.data() },
        };
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────
//  STEP 1: Generate Video Script
//  Content → Structured script chunks
// ─────────────────────────────────────────

async function generateVideoScript(llm, courseTitle, unitTitle, subtopicTitle, difficulty, content) {
  console.log("📝 Step 1: Generating video script...");

  const contentText = typeof content === "string" ? content : JSON.stringify(content);

  const response = await llm(VIDEO_SCRIPT_PROMPT, {
    course_title: courseTitle,
    unit_title: unitTitle,
    subtopic_title: subtopicTitle,
    difficulty: difficulty || "Beginner",
    content: contentText,
  });

  const parsed = VideoScriptSchema.safeParse(response);
  if (!parsed.success) {
    console.error("Video script schema validation failed:", parsed.error);
    throw new Error("Failed to generate valid video script");
  }

  console.log(`   ✅ Script: ${parsed.data.chunks.length} chunks, ~${parsed.data.total_estimated_duration_seconds}s`);
  return parsed.data;
}

// ─────────────────────────────────────────
//  STEP 2: Scene Planning
//  Classify each chunk → scene type + metadata
// ─────────────────────────────────────────

async function planScenes(llm, script, courseTitle, subtopicTitle, difficulty) {
  console.log("🎬 Step 2: Planning scenes...");

  // Determine subject area from course title
  const subjectArea = courseTitle.toLowerCase();

  const response = await llm(SCENE_PLAN_PROMPT, {
    course_title: courseTitle,
    subtopic_title: subtopicTitle,
    difficulty: difficulty || "Beginner",
    subject_area: subjectArea,
    chunks: script.chunks.map((c) => ({
      chunk_index: c.chunk_index,
      text: c.text,
      key_concept: c.key_concept,
    })),
  });

  const parsed = ScenePlanListSchema.safeParse(response);
  if (!parsed.success) {
    console.error("Scene plan schema validation failed:", parsed.error);
    throw new Error("Failed to generate valid scene plans");
  }

  const sceneCounts = {};
  for (const scene of parsed.data.scenes) {
    sceneCounts[scene.scene_type] = (sceneCounts[scene.scene_type] || 0) + 1;
  }
  console.log(`   ✅ Scenes planned: ${JSON.stringify(sceneCounts)}`);

  return parsed.data.scenes;
}

// ─────────────────────────────────────────
//  STEP 3: Generate Assets
//  For each scene → SVG, image, or fallback
// ─────────────────────────────────────────

async function generateAssets(scenes, jobId, imageProvider) {
  console.log("🎨 Step 3: Generating visual assets...");

  const assets = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const sceneId = `${jobId}_scene_${i}`;

    console.log(`   Scene ${i + 1}/${scenes.length}: ${scene.scene_type}`);

    let visualPath = null;

    // Generate based on scene type
    if (scene.scene_type === "illustration") {
      // Use AI image generation
      const prompt = scene.image_prompt || `Educational illustration for: ${scene.text || "concept"}`;
      const imageUrl = await generateIllustration(prompt, { provider: imageProvider });

      if (imageUrl) {
        visualPath = await prepareVisualAsset({ imageUrl, sceneId });
      } else {
        // Fallback: generate a quote-style SVG with the key concept
        const fallbackSvg = generateQuoteSVG({
          quote_text: scene.image_prompt || "Visual Concept",
          quote_attribution: "",
        });
        visualPath = await prepareVisualAsset({ svgContent: fallbackSvg, sceneId });
      }
    } else {
      // Generate SVG for structured scenes
      const svgContent = generateSVGForScene(scene);
      if (svgContent) {
        visualPath = await prepareVisualAsset({ svgContent, sceneId });
      } else {
        // Fallback
        const fallbackSvg = generateQuoteSVG({
          quote_text: scene.quote_text || scene.key_concept || "Content",
          quote_attribution: "",
        });
        visualPath = await prepareVisualAsset({ svgContent: fallbackSvg, sceneId });
      }
    }

    // Handle subscenes
    const subsceneAssets = [];
    if (scene.subscenes && scene.subscenes.length > 1) {
      for (let s = 0; s < scene.subscenes.length; s++) {
        const sub = scene.subscenes[s];
        const subId = `${sceneId}_sub_${s}`;

        // For subscenes that highlight different parts, modify the SVG
        // For simplicity, use the main visual with text overlay
        subsceneAssets.push({
          visualPath,
          duration: sub.duration_hint_seconds || 4,
          animationStyle: sub.animation_style || scene.animation_style || "fade",
          textOverlay: sub.text_overlay || "",
        });
      }
    }

    assets.push({
      sceneIndex: i,
      sceneType: scene.scene_type,
      visualPath,
      animationStyle: scene.animation_style,
      subsceneAssets: subsceneAssets.length > 0 ? subsceneAssets : null,
    });
  }

  console.log(`   ✅ ${assets.length} visual assets generated`);
  return assets;
}

// ─────────────────────────────────────────
//  STEP 4: Generate TTS Audio
//  One audio per chunk
// ─────────────────────────────────────────

async function generateChunkAudio(chunks, jobId, ttsProvider, voice) {
  console.log("🎙️ Step 4: Generating TTS audio...");

  const audioFiles = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`   Chunk ${i + 1}/${chunks.length}: "${chunk.text.substring(0, 50)}..."`);

    const segments = [{ text: chunk.text, direction: null }];
    const audioBuffer = await synthesize(segments, ttsProvider, { voice });

    const sceneId = `${jobId}_chunk_${i}`;
    const audioPath = await saveAudioToFile(audioBuffer, sceneId);
    const duration = await getAudioDuration(audioPath);

    audioFiles.push({
      chunkIndex: i,
      audioPath,
      duration,
      buffer: audioBuffer,
    });

    console.log(`   ✅ Chunk ${i + 1}: ${duration.toFixed(1)}s`);
  }

  const totalDuration = audioFiles.reduce((sum, a) => sum + a.duration, 0);
  console.log(`   ✅ Total audio: ${totalDuration.toFixed(1)}s across ${audioFiles.length} chunks`);

  return audioFiles;
}

// ─────────────────────────────────────────
//  STEP 5: Render Scene Clips
//  Visual + Audio → MP4 per scene
// ─────────────────────────────────────────

async function renderAllScenes(scenes, assets, audioFiles, jobId) {
  console.log("🎞️ Step 5: Rendering scene clips...");

  const clipDir = path.join(OUTPUT_DIR, "clips");
  if (!existsSync(clipDir)) {
    mkdirSync(clipDir, { recursive: true });
  }

  const clipPaths = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const asset = assets[i];
    const audio = audioFiles[i];
    const outputPath = path.join(clipDir, `${jobId}_clip_${i}.mp4`);

    console.log(`   Clip ${i + 1}/${scenes.length}: ${scene.scene_type} (${audio?.duration?.toFixed(1) || "?"}s)`);

    if (asset.subsceneAssets && asset.subsceneAssets.length > 1) {
      // Render multiple subscenes
      await renderSubscenes({
        subsceneAssets: asset.subsceneAssets,
        audioPath: audio?.audioPath,
        totalDuration: audio?.duration || 5,
        outputPath,
      });
    } else {
      // Render single scene
      await renderSceneClip({
        visualPath: asset.visualPath,
        audioPath: audio?.audioPath,
        duration: audio?.duration || 5,
        animationStyle: asset.animationStyle || "fade",
        outputPath,
      });
    }

    clipPaths.push(outputPath);
    console.log(`   ✅ Clip ${i + 1} rendered`);
  }

  return clipPaths;
}

// ─────────────────────────────────────────
//  STEP 6: Stitch Final Video
//  All clips + transitions → final MP4
// ─────────────────────────────────────────

async function stitchFinalVideo(clipPaths, scenes, chunkTexts, jobId) {
  console.log("🎬 Step 6: Stitching final video...");

  // Plan transitions
  const transitions = planTransitions(scenes, chunkTexts);
  console.log(`   Transitions: ${transitions.map((t) => t.type).join(" → ")}`);

  const outputPath = path.join(OUTPUT_DIR, `${jobId}_final.mp4`);
  await stitchScenes(clipPaths, transitions, outputPath);

  console.log(`   ✅ Final video: ${outputPath}`);
  return outputPath;
}

// ─────────────────────────────────────────
//  MAIN: Generate video for a subtopic
// ─────────────────────────────────────────

async function generateSubtopicVideo(req, subtopicId) {
  const userId = req.user?.id;
  if (!userId) return { status: 401, error: "Unauthorized" };

  // Check cache
  const cacheKey = `vid_${subtopicId}`;
  const cachedDoc = await videosRef.doc(cacheKey).get();
  if (cachedDoc.exists) {
    return {
      status: 200,
      video: serializeTimestamps({ id: cachedDoc.id, ...cachedDoc.data() }),
      generated: false,
    };
  }

  // Get subtopic context
  const context = await findSubtopicWithContext(subtopicId);
  if (!context) return { status: 404, error: "Subtopic not found" };

  const { subtopic, unit, course } = context;
  if (!subtopic.content) {
    return { status: 400, error: "Subtopic content not generated yet." };
  }

  // Config from query params
  const llmProvider = req.query.llm_provider || "Groq";
  const llmModel = req.query.llm_model || null;
  const ttsProvider = req.query.tts_provider || "Groq";
  const voice = req.query.voice || "autumn";
  const imageProvider = req.query.image_provider || "placeholder";

  const llm = getLLMProvider(llmProvider, llmModel);
  const jobId = `${subtopicId}_${Date.now()}`;

  try {
    console.log("═══════════════════════════════════════════════");
    console.log(`🎬 VIDEO GENERATION: ${subtopic.title}`);
    console.log(`   Course: ${course.title} > ${unit.title}`);
    console.log(`   Job: ${jobId}`);
    console.log("═══════════════════════════════════════════════");

    // Step 1: Generate script
    const script = await generateVideoScript(
      llm, course.title, unit.title, subtopic.title,
      course.difficulty, subtopic.content
    );

    // Step 2: Plan scenes
    const scenes = await planScenes(
      llm, script, course.title, subtopic.title, course.difficulty
    );

    // Step 3: Generate visual assets
    const assets = await generateAssets(scenes, jobId, imageProvider);

    // Step 4: Generate TTS audio per chunk
    const audioFiles = await generateChunkAudio(
      script.chunks, jobId, ttsProvider, voice
    );

    // Step 5: Render scene clips
    const clipPaths = await renderAllScenes(scenes, assets, audioFiles, jobId);

    // Step 6: Stitch final video with transitions
    const chunkTexts = script.chunks.map((c) => c.text);
    const finalVideoPath = await stitchFinalVideo(clipPaths, scenes, chunkTexts, jobId);

    // Upload to ImageKit
    console.log("☁️ Uploading final video...");
    const videoBuffer = await readVideoFile(finalVideoPath);
    const filename = `${subtopicId}_video_${Date.now()}.mp4`;

    let videoUrl = "";
    let imagekitFileId = "";
    try {
      const uploadResult = await uploadVideo(videoBuffer, filename);
      videoUrl = uploadResult.url;
      imagekitFileId = uploadResult.fileId;
    } catch (uploadErr) {
      console.warn("⚠️ Video upload failed, storing local path:", uploadErr.message);
      videoUrl = finalVideoPath; // Local fallback
    }

    // Calculate total duration
    const totalDuration = audioFiles.reduce((sum, a) => sum + a.duration, 0);

    // Save metadata to Firestore
    const videoData = {
      type: "subtopic",
      subtopic_id: subtopicId,
      subtopic_title: subtopic.title,
      unit_title: unit.title,
      course_title: course.title,
      course_id: course.id,
      scene_count: scenes.length,
      scene_types: scenes.map((s) => s.scene_type),
      total_duration_seconds: totalDuration,
      llm_provider: llmProvider,
      tts_provider: ttsProvider,
      image_provider: imageProvider,
      voice,
      video_url: videoUrl,
      imagekit_file_id: imagekitFileId,
      file_size_bytes: videoBuffer.length,
      script_chunks: script.chunks.length,
      generated_at: new Date(),
    };

    await videosRef.doc(cacheKey).set(videoData);

    // Cleanup temp files
    await cleanupJobFiles(jobId);

    console.log("═══════════════════════════════════════════════");
    console.log("✅ VIDEO GENERATION COMPLETE");
    console.log(`   Duration: ${totalDuration.toFixed(1)}s`);
    console.log(`   Scenes: ${scenes.length}`);
    console.log(`   URL: ${videoUrl.substring(0, 80)}...`);
    console.log("═══════════════════════════════════════════════");

    return {
      status: 201,
      video: { id: cacheKey, ...videoData },
      generated: true,
    };
  } catch (err) {
    console.error("❌ Video generation failed:", err);
    await cleanupJobFiles(jobId);
    return { status: 500, error: `Video generation failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────
//  Upload video to ImageKit
// ─────────────────────────────────────────

async function uploadVideo(buffer, filename) {
  const { default: axios } = await import("axios");
  const { default: FormData } = await import("form-data");

  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey) throw new Error("IMAGEKIT_PRIVATE_KEY is missing");

  const authHeader = Buffer.from(`${privateKey}:`).toString("base64");

  const form = new FormData();
  form.append("file", buffer, { filename, contentType: "video/mp4" });
  form.append("fileName", filename);
  form.append("folder", "/course-videos");
  form.append("useUniqueFileName", "true");
  form.append("tags", "video,course,education");

  const response = await axios.post("https://upload.imagekit.io/api/v1/files/upload", form, {
    headers: {
      Authorization: `Basic ${authHeader}`,
      ...form.getHeaders(),
    },
    maxBodyLength: Infinity,
    timeout: 300000, // 5 min for large videos
  });

  console.log(`✅ Video uploaded: ${response.data.url}`);
  return response.data;
}

// ─────────────────────────────────────────
//  Get generation status / progress
// ─────────────────────────────────────────

async function getVideoStatus(subtopicId) {
  const cacheKey = `vid_${subtopicId}`;
  const doc = await videosRef.doc(cacheKey).get();

  if (doc.exists) {
    return {
      status: "completed",
      video: serializeTimestamps({ id: doc.id, ...doc.data() }),
    };
  }

  return { status: "not_generated" };
}

// ─────────────────────────────────────────
//  Express route handlers
// ─────────────────────────────────────────

export const generateVideoForSubtopic = async (req, res) => {
  try {
    const { subtopicId } = req.params;
    if (!subtopicId) {
      return res.status(400).json({ error: "subtopicId is required" });
    }

    const result = await generateSubtopicVideo(req, subtopicId);
    return res.status(result.status).json(result);
  } catch (err) {
    console.error("Video generation error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const getVideoForSubtopic = async (req, res) => {
  try {
    const { subtopicId } = req.params;
    const result = await getVideoStatus(subtopicId);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

export const getVideoForCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    if (!courseId) {
      return res.status(400).json({ error: "courseId is required" });
    }

    // Get all subtopics for this course
    const courseDoc = await coursesRef.doc(courseId).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ error: "Course not found" });
    }

    const unitsSnap = await coursesRef.doc(courseId).collection("units").orderBy("position").get();
    const videos = [];

    for (const unitDoc of unitsSnap.docs) {
      const subsSnap = await unitDoc.ref.collection("subtopics").orderBy("position").get();
      for (const subDoc of subsSnap.docs) {
        const status = await getVideoStatus(subDoc.id);
        videos.push({
          subtopic_id: subDoc.id,
          subtopic_title: subDoc.data().title,
          unit_title: unitDoc.data().title,
          ...status,
        });
      }
    }

    return res.status(200).json({
      course_id: courseId,
      course_title: courseDoc.data().title,
      videos,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Regenerate video (delete cache and regenerate)
 */
export const regenerateVideoForSubtopic = async (req, res) => {
  try {
    const { subtopicId } = req.params;
    const cacheKey = `vid_${subtopicId}`;

    // Delete cached version
    const existingDoc = await videosRef.doc(cacheKey).get();
    if (existingDoc.exists) {
      await videosRef.doc(cacheKey).delete();
      console.log(`🗑️ Deleted cached video for ${subtopicId}`);
    }

    // Regenerate
    const result = await generateSubtopicVideo(req, subtopicId);
    return res.status(result.status).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Preview: Generate only the script + scene plan (no rendering)
 * Useful for debugging or previewing before expensive render
 */
export const previewVideoForSubtopic = async (req, res) => {
  try {
    const { subtopicId } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const context = await findSubtopicWithContext(subtopicId);
    if (!context) return res.status(404).json({ error: "Subtopic not found" });

    const { subtopic, unit, course } = context;
    if (!subtopic.content) {
      return res.status(400).json({ error: "Subtopic content not generated yet." });
    }

    const llmProvider = req.query.llm_provider || "Groq";
    const llmModel = req.query.llm_model || null;
    const llm = getLLMProvider(llmProvider, llmModel);

    // Generate script
    const script = await generateVideoScript(
      llm, course.title, unit.title, subtopic.title,
      course.difficulty, subtopic.content
    );

    // Plan scenes
    const scenes = await planScenes(
      llm, script, course.title, subtopic.title, course.difficulty
    );

    // Plan transitions
    const chunkTexts = script.chunks.map((c) => c.text);
    const transitions = planTransitions(scenes, chunkTexts);

    return res.status(200).json({
      preview: true,
      script,
      scenes,
      transitions: transitions.map((t) => t.type),
      scene_type_summary: scenes.reduce((acc, s) => {
        acc[s.scene_type] = (acc[s.scene_type] || 0) + 1;
        return acc;
      }, {}),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
