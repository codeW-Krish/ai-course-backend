// ============================================================
//  Transition Engine
//  Intelligent selection of transitions between scenes
//  Based on semantic similarity + scene type context
// ============================================================

import { TRANSITION_TYPES, SCENE_TYPES } from "../llm/videoSchemas.js";

// ─────────────────────────────────────────
//  Transition duration (ms) per type
// ─────────────────────────────────────────
export const TRANSITION_DURATIONS = {
  crossfade: 800,
  zoom_morph: 1000,
  slide_forward: 700,
  split_expand: 900,
  blur_dissolve: 1000,
  fade_to_dark: 1200,
  wipe: 600,
};

// ─────────────────────────────────────────
//  FFmpeg filter mappings for each transition
//  These are used in video rendering
// ─────────────────────────────────────────
export const TRANSITION_FFMPEG_FILTERS = {
  crossfade: (duration) => `xfade=transition=fade:duration=${duration / 1000}`,
  zoom_morph: (duration) => `xfade=transition=smoothup:duration=${duration / 1000}`,
  slide_forward: (duration) => `xfade=transition=slideleft:duration=${duration / 1000}`,
  split_expand: (duration) => `xfade=transition=horzopen:duration=${duration / 1000}`,
  blur_dissolve: (duration) => `xfade=transition=fadeblack:duration=${duration / 1000}`,
  fade_to_dark: (duration) => `xfade=transition=fadeblack:duration=${duration / 1000}`,
  wipe: (duration) => `xfade=transition=wipeleft:duration=${duration / 1000}`,
};

// ─────────────────────────────────────────
//  Micro-transition (within a chunk's subscenes)
//  Lighter, faster transitions
// ─────────────────────────────────────────
export const MICRO_TRANSITIONS = {
  same_type: "crossfade",           // Same scene type subscenes
  highlight_shift: "crossfade",     // Different highlight, same diagram
  progressive_reveal: "crossfade",  // Sequential reveal
  zoom_detail: "zoom_morph",        // Zooming into detail
};

export const MICRO_TRANSITION_DURATION = 400; // ms

// ─────────────────────────────────────────
//  Cosine similarity for embeddings
// ─────────────────────────────────────────
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0.5;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─────────────────────────────────────────
//  Simple text similarity (word overlap)
//  Used as fallback when embeddings not available
// ─────────────────────────────────────────
function textSimilarity(textA, textB) {
  if (!textA || !textB) return 0.5;

  const wordsA = new Set(
    textA.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3)
  );
  const wordsB = new Set(
    textB.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3)
  );

  if (wordsA.size === 0 || wordsB.size === 0) return 0.3;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  return overlap / Math.max(wordsA.size, wordsB.size);
}

// ─────────────────────────────────────────
//  MAIN: Choose transition between two scenes
// ─────────────────────────────────────────

/**
 * Choose the best transition between two consecutive scenes.
 *
 * @param {Object} prevScene - Previous scene plan
 * @param {Object} currentScene - Current scene plan
 * @param {Object} options - Optional: embeddings for similarity
 * @returns {{ type: string, duration: number, ffmpegFilter: string }}
 */
export function chooseTransition(prevScene, currentScene, options = {}) {
  // If either scene has a strong hint, respect it
  if (currentScene.transition_hint && currentScene.transition_hint !== "crossfade") {
    const hint = currentScene.transition_hint;
    return {
      type: hint,
      duration: TRANSITION_DURATIONS[hint] || 800,
      ffmpegFilter: (TRANSITION_FFMPEG_FILTERS[hint] || TRANSITION_FFMPEG_FILTERS.crossfade)(
        TRANSITION_DURATIONS[hint] || 800
      ),
    };
  }

  // Calculate similarity
  let similarity = 0.5;
  if (options.prevEmbedding && options.currentEmbedding) {
    similarity = cosineSimilarity(options.prevEmbedding, options.currentEmbedding);
  } else {
    // Fallback: text-based similarity
    const prevText = prevScene.text || prevScene.key_concept || "";
    const currentText = currentScene.text || currentScene.key_concept || "";
    similarity = textSimilarity(prevText, currentText);
  }

  let transitionType = "crossfade";

  // ─── Decision rules ───

  // Closely related topics → zoom morph (diving deeper)
  if (similarity > 0.75) {
    transitionType = "zoom_morph";
  }
  // Moderate similarity → gentle crossfade
  else if (similarity > 0.5) {
    transitionType = "crossfade";
  }
  // Topic shift → blur dissolve
  else if (similarity < 0.3) {
    transitionType = "blur_dissolve";
  }

  // ─── Scene-type specific overrides ───

  // Comparison scene → split expand
  if (currentScene.scene_type === "comparison") {
    transitionType = "split_expand";
  }

  // Timeline → slide forward (implies progression)
  if (currentScene.scene_type === "timeline") {
    transitionType = "slide_forward";
  }

  // Quote/emphasis → dramatic fade to dark
  if (currentScene.scene_type === "quote") {
    transitionType = "fade_to_dark";
  }

  // Code → Code: slide forward
  if (prevScene.scene_type === "code" && currentScene.scene_type === "code") {
    transitionType = "slide_forward";
  }

  // Diagram → Diagram (progressive): zoom morph
  if (prevScene.scene_type === "diagram" && currentScene.scene_type === "diagram" && similarity > 0.4) {
    transitionType = "zoom_morph";
  }

  const duration = TRANSITION_DURATIONS[transitionType] || 800;
  const ffmpegFilter = (TRANSITION_FFMPEG_FILTERS[transitionType] || TRANSITION_FFMPEG_FILTERS.crossfade)(duration);

  return { type: transitionType, duration, ffmpegFilter };
}

/**
 * Choose micro-transition for subscenes within a chunk.
 * These are lighter and faster.
 *
 * @param {Object} prevSubscene
 * @param {Object} currentSubscene
 * @returns {{ type: string, duration: number, ffmpegFilter: string }}
 */
export function chooseMicroTransition(prevSubscene, currentSubscene) {
  let type = MICRO_TRANSITIONS.same_type;

  // If different scene types within subscenes
  if (prevSubscene.scene_type !== currentSubscene.scene_type) {
    type = "crossfade";
  }

  // If same diagram with different highlights
  if (
    prevSubscene.scene_type === "diagram" &&
    currentSubscene.scene_type === "diagram" &&
    prevSubscene.highlight !== currentSubscene.highlight
  ) {
    type = MICRO_TRANSITIONS.highlight_shift;
  }

  const duration = MICRO_TRANSITION_DURATION;
  const ffmpegFilter = (TRANSITION_FFMPEG_FILTERS[type] || TRANSITION_FFMPEG_FILTERS.crossfade)(duration);

  return { type, duration, ffmpegFilter };
}


/**
 * Generate a complete transition plan for an array of scene plans.
 * Returns an array of transitions (length = scenes.length - 1).
 *
 * @param {Array} scenes - Array of scene plans
 * @param {Array} chunkTexts - Corresponding text for each scene
 * @returns {Array<{ type: string, duration: number, ffmpegFilter: string }>}
 */
export function planTransitions(scenes, chunkTexts = []) {
  const transitions = [];

  for (let i = 1; i < scenes.length; i++) {
    const prevScene = { ...scenes[i - 1], text: chunkTexts[i - 1] || "" };
    const currentScene = { ...scenes[i], text: chunkTexts[i] || "" };
    const transition = chooseTransition(prevScene, currentScene);
    transitions.push(transition);
  }

  return transitions;
}

export default {
  chooseTransition,
  chooseMicroTransition,
  planTransitions,
  TRANSITION_DURATIONS,
  TRANSITION_FFMPEG_FILTERS,
};
