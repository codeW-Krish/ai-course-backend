// ============================================================
//  Video Manifest Controller
//  Client-Side Playback Engine — NO server-side video rendering
//  Pipeline: Content → Script → Scenes → Assets(CDN) → Audio(CDN) → Manifest
//  The Android app plays the manifest as a synchronized presentation
// ============================================================

import { db } from "../db/firebase.js";
import { getLLMProvider } from "../providers/LLMProviders.js";
import { VIDEO_SCRIPT_PROMPT, SCENE_PLAN_PROMPT } from "../prompts/videoPrompt.js";
import { VideoScriptSchema, ScenePlanListSchema } from "../llm/videoSchemas.js";
import { generateSVGForScene, generateQuoteSVG } from "../service/svgGeneratorService.js";
import { generateIllustration } from "../service/imageGenerationService.js";
import { synthesize } from "../service/ttsService.js";
import { planTransitions } from "../service/transitionEngine.js";
import { uploadAudio, uploadImage } from "../service/imagekitService.js";
import { serializeTimestamps } from "../utils/firestoreSerializer.js";
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "url";
import nodePath from "path";

const coursesRef = db.collection("courses");
const manifestsRef = db.collection("video_manifests");

// ─────────────────────────────────────────
//  Config
// ─────────────────────────────────────────

const MANIFEST_VERSION = 1;
const DEFAULT_RESOLUTION = { width: 1280, height: 720 }; // 720p default
const MAX_SUBSCENES_BY_DURATION = [
  { maxSeconds: 8, maxSubscenes: 1 },
  { maxSeconds: 15, maxSubscenes: 2 },
  { maxSeconds: 25, maxSubscenes: 3 },
  { maxSeconds: Infinity, maxSubscenes: 4 },
];

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
//  Helper: Get WAV buffer duration (pure JS)
//  No FFmpeg/ffprobe needed
// ─────────────────────────────────────────

function getWavDuration(buffer) {
  try {
    const riff = buffer.toString("ascii", 0, 4);
    if (riff !== "RIFF") {
      // Not a WAV, estimate from buffer size (assume 24kHz 16-bit mono)
      return buffer.length / (24000 * 2);
    }
    // Read fmt chunk info
    let offset = 12;
    while (offset < buffer.length - 8) {
      const chunkId = buffer.toString("ascii", offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkId === "fmt ") {
        const byteRate = buffer.readUInt32LE(offset + 16);
        // Find data chunk size
        let dataOffset = offset + 8 + chunkSize;
        if (chunkSize % 2 !== 0) dataOffset += 1;
        while (dataOffset < buffer.length - 8) {
          const dId = buffer.toString("ascii", dataOffset, dataOffset + 4);
          const dSize = buffer.readUInt32LE(dataOffset + 4);
          if (dId === "data") {
            return dSize / byteRate;
          }
          dataOffset += 8 + dSize;
          if (dSize % 2 !== 0) dataOffset += 1;
        }
        // Fallback: estimate from total buffer
        return (buffer.length - 44) / byteRate;
      }
      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset += 1;
    }
  } catch {
    // Fallback estimate
  }
  return buffer.length / (24000 * 2);
}

// ─────────────────────────────────────────
//  Helper: Strip SVG animations for static rendering
//  SVGs use opacity="0" + <animate> for presentation.
//  sharp renders frame-0 (all invisible) → black image.
//  Fix: set all elements to their final visible state.
// ─────────────────────────────────────────

function stripSvgAnimations(svgString) {
  let s = svgString;

  // 1. Remove all <animate .../> and <animate ...>...</animate> elements
  s = s.replace(/<animate\b[^>]*\/>/gi, "");
  s = s.replace(/<animate\b[^>]*>[\s\S]*?<\/animate>/gi, "");

  // 2. Remove all <animateTransform .../> elements
  s = s.replace(/<animateTransform\b[^>]*\/>/gi, "");
  s = s.replace(/<animateTransform\b[^>]*>[\s\S]*?<\/animateTransform>/gi, "");

  // 3. Replace opacity="0" with opacity="1" so content is visible
  s = s.replace(/\bopacity\s*=\s*"0"/gi, 'opacity="1"');

  // 4. Also handle style-based opacity:0
  s = s.replace(/opacity\s*:\s*0\b/gi, "opacity:1");

  // 5. Fix stroke-dashoffset (diagrams use dasharray animation — show full lines)
  s = s.replace(/stroke-dashoffset\s*=\s*"[^"]*"/gi, 'stroke-dashoffset="0"');

  // 6. Strip zero-width / invisible Unicode characters that LLMs sometimes emit
  s = s.replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, "");

  return s;
}

// ─────────────────────────────────────────
//  Helper: SVG → PNG buffer via @resvg/resvg-js
//  Uses bundled fonts for reliable text rendering
//  on any server (no system font dependency)
// ─────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = nodePath.dirname(__filename);
const FONTS_DIR = nodePath.resolve(__dirname, "..", "assets", "fonts");

async function svgToPngBuffer(svgString, width = DEFAULT_RESOLUTION.width, height = DEFAULT_RESOLUTION.height) {
  // Strip animations so resvg renders the final visible state, not frame-0
  const staticSvg = stripSvgAnimations(svgString);

  const opts = {
    fitTo: { mode: "width", value: width },
    font: {
      fontFiles: [
        nodePath.join(FONTS_DIR, "Inter-Regular.ttf"),
        nodePath.join(FONTS_DIR, "Inter-Bold.ttf"),
        nodePath.join(FONTS_DIR, "NotoSans-Regular.ttf"),
      ],
      loadSystemFonts: false, // don't depend on server fonts
      defaultFontFamily: "Inter",
    },
    logLevel: "off",
  };

  try {
    const resvg = new Resvg(staticSvg, opts);
    const pngData = resvg.render();
    return Buffer.from(pngData.asPng());
  } catch (err) {
    console.warn(`⚠️ resvg render failed: ${err.message}, falling back to sharp`);
    // Fallback to sharp (may have font issues but at least produces an image)
    const sharp = (await import("sharp")).default;
    return sharp(Buffer.from(staticSvg))
      .resize(width, height)
      .png()
      .toBuffer();
  }
}

// ─────────────────────────────────────────
//  Helper: Limit subscenes by chunk duration
// ─────────────────────────────────────────

function getMaxSubscenes(durationSeconds) {
  for (const rule of MAX_SUBSCENES_BY_DURATION) {
    if (durationSeconds <= rule.maxSeconds) return rule.maxSubscenes;
  }
  return 2;
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
//  STEP 3: Generate & Upload Visual Assets
//  SVG → PNG → ImageKit CDN → URLs
// ─────────────────────────────────────────

async function generateAndUploadAssets(scenes, jobId, imageProvider) {
  console.log("🎨 Step 3: Generating & uploading visual assets...");

  const assetUrls = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const sceneId = `${jobId}_scene_${i}`;
    console.log(`   Scene ${i + 1}/${scenes.length}: ${scene.scene_type}`);

    let visualUrl = null;

    if (scene.scene_type === "illustration") {
      // AI image generation → already a URL
      const prompt = scene.image_prompt || `Educational illustration for: ${scene.text || "concept"}`;
      const imageUrl = await generateIllustration(prompt, { provider: imageProvider });

      if (imageUrl) {
        visualUrl = imageUrl; // Already a CDN URL from the image provider
      } else {
        // Fallback: generate quote SVG → PNG → upload
        const fallbackSvg = generateQuoteSVG({
          quote_text: scene.image_prompt || "Visual Concept",
          quote_attribution: "",
        });
        const pngBuffer = await svgToPngBuffer(fallbackSvg);
        const uploaded = await uploadImage(pngBuffer, `${sceneId}.png`);
        visualUrl = uploaded.url;
      }
    } else {
      // Structured scenes: SVG → PNG → upload
      const svgContent = generateSVGForScene(scene);
      if (svgContent) {
        const pngBuffer = await svgToPngBuffer(svgContent);
        const uploaded = await uploadImage(pngBuffer, `${sceneId}.png`);
        visualUrl = uploaded.url;
      } else {
        // Fallback: quote SVG
        const fallbackSvg = generateQuoteSVG({
          quote_text: scene.quote_text || scene.key_concept || "Content",
          quote_attribution: "",
        });
        const pngBuffer = await svgToPngBuffer(fallbackSvg);
        const uploaded = await uploadImage(pngBuffer, `${sceneId}.png`);
        visualUrl = uploaded.url;
      }
    }

    assetUrls.push({
      sceneIndex: i,
      sceneType: scene.scene_type,
      visualUrl,
    });
  }

  console.log(`   ✅ ${assetUrls.length} visual assets uploaded to CDN`);
  return assetUrls;
}

// ─────────────────────────────────────────
//  STEP 4: Generate & Upload TTS Audio
//  One audio per chunk → upload each → URLs
// ─────────────────────────────────────────

async function generateAndUploadAudio(chunks, jobId, ttsProvider, voice) {
  console.log("🎙️ Step 4: Generating & uploading TTS audio...");

  const audioData = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`   Chunk ${i + 1}/${chunks.length}: "${chunk.text.substring(0, 50)}..."`);

    const segments = [{ text: chunk.text, direction: null }];
    const audioBuffer = await synthesize(segments, ttsProvider, { voice });

    // Get duration from WAV header (no FFmpeg needed)
    const duration = getWavDuration(audioBuffer);

    // Upload to ImageKit
    const filename = `${jobId}_audio_${i}.wav`;
    const uploaded = await uploadAudio(audioBuffer, filename);

    audioData.push({
      chunkIndex: i,
      audioUrl: uploaded.url,
      durationSeconds: duration,
      fileId: uploaded.fileId,
    });

    console.log(`   ✅ Chunk ${i + 1}: ${duration.toFixed(1)}s → ${uploaded.url.substring(0, 60)}...`);
  }

  const totalDuration = audioData.reduce((sum, a) => sum + a.durationSeconds, 0);
  console.log(`   ✅ Total audio: ${totalDuration.toFixed(1)}s across ${audioData.length} chunks`);

  return audioData;
}

// ─────────────────────────────────────────
//  STEP 5: Build Presentation Manifest
//  Combines everything into a client-playable JSON
// ─────────────────────────────────────────

function buildManifest({ subtopicId, subtopicTitle, unitTitle, courseTitle, courseId, script, scenes, assetUrls, audioData, transitions }) {
  console.log("📦 Step 5: Building presentation manifest...");

  const manifestScenes = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const asset = assetUrls[i];
    const audio = audioData[i];
    const chunk = script.chunks[i];
    const transition = transitions[i] || null;

    const durationMs = Math.round((audio?.durationSeconds || chunk.estimated_duration_seconds || 10) * 1000);

    // Build subscenes with smart limiting
    const maxSubs = getMaxSubscenes(durationMs / 1000);
    let subscenes = [];

    if (scene.subscenes && scene.subscenes.length > 0) {
      const limited = scene.subscenes.slice(0, maxSubs);
      const subDuration = Math.floor(durationMs / limited.length);

      subscenes = limited.map((sub, idx) => ({
        index: idx,
        start_ms: idx * subDuration,
        duration_ms: idx === limited.length - 1 ? durationMs - idx * subDuration : subDuration,
        animation_style: sub.animation_style || "fade",
        text_overlay: sub.text_overlay || "",
      }));
    } else {
      // Single subscene = full duration
      subscenes = [{
        index: 0,
        start_ms: 0,
        duration_ms: durationMs,
        animation_style: scene.animation_style || "fade",
        text_overlay: "",
      }];
    }

    manifestScenes.push({
      scene_index: i,
      scene_type: scene.scene_type,
      visual_url: asset?.visualUrl || "",
      audio_url: audio?.audioUrl || "",
      duration_seconds: audio?.durationSeconds || chunk.estimated_duration_seconds || 10,
      key_concept: chunk.key_concept || "",
      narration_text: chunk.text || "",
      animation_style: scene.animation_style || "fade",
      transition: transition ? {
        type: transition.type,
        duration_ms: transition.durationMs || 800,
      } : null,
      subscenes,
    });
  }

  const totalDuration = manifestScenes.reduce((sum, s) => sum + s.duration_seconds, 0);

  const manifest = {
    manifest_version: MANIFEST_VERSION,
    subtopic_id: subtopicId,
    subtopic_title: subtopicTitle,
    unit_title: unitTitle,
    course_title: courseTitle,
    course_id: courseId,
    total_duration_seconds: totalDuration,
    scene_count: manifestScenes.length,
    resolution: DEFAULT_RESOLUTION,
    generated_at: new Date().toISOString(),
    scenes: manifestScenes,
  };

  console.log(`   ✅ Manifest: ${manifestScenes.length} scenes, ${totalDuration.toFixed(1)}s total`);
  return manifest;
}

// ─────────────────────────────────────────
//  MAIN: Generate manifest for a subtopic
// ─────────────────────────────────────────

async function generateSubtopicManifest(req, subtopicId) {
  const userId = req.user?.id;
  if (!userId) return { status: 401, error: "Unauthorized" };

  // Check cache
  const cacheKey = `manifest_${subtopicId}`;
  const cachedDoc = await manifestsRef.doc(cacheKey).get();
  if (cachedDoc.exists) {
    return {
      status: 200,
      manifest: serializeTimestamps({ id: cachedDoc.id, ...cachedDoc.data() }),
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
  const imageProvider = req.query.image_provider || null;  // null = use cascade chain

  const llm = getLLMProvider(llmProvider, llmModel);
  const jobId = `${subtopicId}_${Date.now()}`;

  try {
    console.log("═══════════════════════════════════════════════");
    console.log(`🎬 MANIFEST GENERATION: ${subtopic.title}`);
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

    // Step 3: Generate & upload visual assets
    const assetUrls = await generateAndUploadAssets(scenes, jobId, imageProvider);

    // Step 4: Generate & upload TTS audio per chunk
    const audioData = await generateAndUploadAudio(
      script.chunks, jobId, ttsProvider, voice
    );

    // Step 5: Plan transitions
    const chunkTexts = script.chunks.map((c) => c.text);
    const transitions = planTransitions(scenes, chunkTexts);

    // Step 6: Build manifest
    const manifest = buildManifest({
      subtopicId,
      subtopicTitle: subtopic.title,
      unitTitle: unit.title,
      courseTitle: course.title,
      courseId: course.id,
      script,
      scenes,
      assetUrls,
      audioData,
      transitions,
    });

    // Cache in Firestore
    await manifestsRef.doc(cacheKey).set(manifest);

    console.log("═══════════════════════════════════════════════");
    console.log("✅ MANIFEST GENERATION COMPLETE");
    console.log(`   Duration: ${manifest.total_duration_seconds.toFixed(1)}s`);
    console.log(`   Scenes: ${manifest.scene_count}`);
    console.log("═══════════════════════════════════════════════");

    return {
      status: 201,
      manifest,
      generated: true,
    };
  } catch (err) {
    console.error("❌ Manifest generation failed:", err);
    return { status: 500, error: `Manifest generation failed: ${err.message}` };
  }
}

// ─────────────────────────────────────────
//  Get manifest status / cached manifest
// ─────────────────────────────────────────

async function getManifestStatus(subtopicId) {
  const cacheKey = `manifest_${subtopicId}`;
  const doc = await manifestsRef.doc(cacheKey).get();

  if (doc.exists) {
    return {
      status: "completed",
      manifest: serializeTimestamps({ id: doc.id, ...doc.data() }),
    };
  }

  return { status: "not_generated" };
}

// ─────────────────────────────────────────
//  Express route handlers
// ─────────────────────────────────────────

/**
 * POST /:subtopicId/generate
 * Generate presentation manifest (LLM + TTS + asset upload)
 */
export const generateVideoForSubtopic = async (req, res) => {
  try {
    const { subtopicId } = req.params;
    if (!subtopicId) {
      return res.status(400).json({ error: "subtopicId is required" });
    }

    const result = await generateSubtopicManifest(req, subtopicId);
    return res.status(result.status).json(result);
  } catch (err) {
    console.error("Manifest generation error:", err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET /:subtopicId
 * Get cached manifest or status
 */
export const getVideoForSubtopic = async (req, res) => {
  try {
    const { subtopicId } = req.params;
    const result = await getManifestStatus(subtopicId);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET /course/:courseId
 * Get all manifests for a course
 */
export const getVideoForCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    if (!courseId) {
      return res.status(400).json({ error: "courseId is required" });
    }

    const courseDoc = await coursesRef.doc(courseId).get();
    if (!courseDoc.exists) {
      return res.status(404).json({ error: "Course not found" });
    }

    const unitsSnap = await coursesRef.doc(courseId).collection("units").orderBy("position").get();
    const manifests = [];

    for (const unitDoc of unitsSnap.docs) {
      const subsSnap = await unitDoc.ref.collection("subtopics").orderBy("position").get();
      for (const subDoc of subsSnap.docs) {
        const status = await getManifestStatus(subDoc.id);
        manifests.push({
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
      manifests,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /:subtopicId/regenerate
 * Delete cache and regenerate manifest
 */
export const regenerateVideoForSubtopic = async (req, res) => {
  try {
    const { subtopicId } = req.params;
    const cacheKey = `manifest_${subtopicId}`;

    // Delete cached version
    const existingDoc = await manifestsRef.doc(cacheKey).get();
    if (existingDoc.exists) {
      await manifestsRef.doc(cacheKey).delete();
      console.log(`🗑️ Deleted cached manifest for ${subtopicId}`);
    }

    // Regenerate
    const result = await generateSubtopicManifest(req, subtopicId);
    return res.status(result.status).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET /:subtopicId/preview
 * Preview: Generate only script + scene plan (no TTS or assets)
 * Cheap operation for debugging/preview before full generation
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
