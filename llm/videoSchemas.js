// ============================================================
//  Video Generation Schemas  —  Zod validation
//  Validates LLM output for script, scene plans, subscenes
// ============================================================

import { z } from "zod";

// ─────────────────────────────────────────
//  Scene Types (universal education engine)
// ─────────────────────────────────────────
export const SCENE_TYPES = [
  "illustration",  // AI-generated image — concepts, metaphors, real-world
  "diagram",       // SVG flowchart, architecture, system diagram
  "code",          // Syntax-highlighted code block
  "timeline",      // Chronological events, process steps
  "comparison",    // Side-by-side, pros/cons, A vs B
  "quote",         // Key takeaway, definition, emphasis
];

// ─────────────────────────────────────────
//  Animation styles per scene type
// ─────────────────────────────────────────
export const ANIMATION_STYLES = [
  "fade",              // Simple fade in/out
  "slide",             // Slide from direction
  "zoom",              // Ken Burns zoom
  "draw",              // SVG stroke draw animation
  "highlight",         // Highlight/glow specific element
  "typewriter",        // Character-by-character reveal
  "sequential_reveal", // Reveal elements one by one
  "parallax",          // Foreground/background parallax
  "scale_pulse",       // Subtle scale emphasis
];

// ─────────────────────────────────────────
//  Transition types between scenes
// ─────────────────────────────────────────
export const TRANSITION_TYPES = [
  "crossfade",      // Standard dissolve
  "zoom_morph",     // Zoom into next scene (related topics)
  "slide_forward",  // Slide left (progression / steps)
  "split_expand",   // Split screen expand (comparison)
  "blur_dissolve",  // Blur then reveal (topic shift)
  "fade_to_dark",   // Fade black then reveal (emphasis)
  "wipe",           // Directional wipe
];

// ─────────────────────────────────────────
//  Script chunk from LLM
// ─────────────────────────────────────────
export const ScriptChunkSchema = z.object({
  chunk_index: z.number(),
  text: z.string().min(1),
  key_concept: z.string().optional().default(""),
  emphasis_words: z.array(z.string()).optional().default([]),
});

export const VideoScriptSchema = z.object({
  title: z.string(),
  description: z.string().optional().default(""),
  chunks: z.array(ScriptChunkSchema).min(1),
  total_estimated_duration_seconds: z.number().optional().default(120),
});

// ─────────────────────────────────────────
//  Scene plan for a single chunk
// ─────────────────────────────────────────

// Diagram node
const DiagramNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  shape: z.enum(["circle", "rect", "diamond", "rounded_rect"]).optional().default("rounded_rect"),
  color: z.string().optional().default("#4F86F7"),
});

// Diagram connection
const DiagramConnectionSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().optional().default(""),
});

// Timeline event
const TimelineEventSchema = z.object({
  label: z.string(),
  description: z.string().optional().default(""),
  year: z.string().optional().default(""),
});

// Comparison item
const ComparisonItemSchema = z.object({
  label: z.string(),
  points: z.array(z.string()).min(1),
  color: z.string().optional().default("#4F86F7"),
});

// Subscene plan
export const SubsceneSchema = z.object({
  step: z.number(),
  text: z.string().min(1),
  highlight: z.string().optional().default(""),
  scene_type: z.enum(SCENE_TYPES).optional(),
  animation_style: z.enum(ANIMATION_STYLES).optional().default("fade"),
  text_overlay: z.string().optional().default(""),
  duration_hint_seconds: z.number().optional().default(4),
});

// Full scene plan for a chunk
export const ScenePlanSchema = z.object({
  chunk_index: z.number(),
  scene_type: z.enum(SCENE_TYPES),
  animation_style: z.enum(ANIMATION_STYLES),
  transition_hint: z.enum(TRANSITION_TYPES).optional().default("crossfade"),

  // For illustration scenes
  image_prompt: z.string().optional().default(""),

  // For diagram scenes
  diagram_nodes: z.array(DiagramNodeSchema).optional().default([]),
  diagram_connections: z.array(DiagramConnectionSchema).optional().default([]),
  diagram_layout: z.enum(["flowchart", "tree", "circular", "layered"]).optional().default("flowchart"),

  // For code scenes
  code_content: z.string().optional().default(""),
  code_language: z.string().optional().default("javascript"),
  highlight_lines: z.array(z.number()).optional().default([]),

  // For timeline scenes
  timeline_events: z.array(TimelineEventSchema).optional().default([]),

  // For comparison scenes
  comparison_items: z.array(ComparisonItemSchema).optional().default([]),
  comparison_title: z.string().optional().default(""),

  // For quote scenes
  quote_text: z.string().optional().default(""),
  quote_attribution: z.string().optional().default(""),

  // Subscenes (multiple visuals per chunk)
  subscenes: z.array(SubsceneSchema).optional().default([]),
});

export const ScenePlanListSchema = z.object({
  scenes: z.array(ScenePlanSchema).min(1),
});

// ─────────────────────────────────────────
//  Subscene breakdown from LLM
// ─────────────────────────────────────────
export const SubsceneBreakdownSchema = z.object({
  chunk_index: z.number(),
  subscenes: z.array(SubsceneSchema).min(1),
});

// ─────────────────────────────────────────
//  Final video metadata (stored in Firestore)
// ─────────────────────────────────────────
export const VideoMetadataSchema = z.object({
  course_id: z.string(),
  subtopic_id: z.string().optional(),
  title: z.string(),
  scene_count: z.number(),
  total_duration_seconds: z.number(),
  video_url: z.string(),
  thumbnail_url: z.string().optional().default(""),
  tts_provider: z.string(),
  llm_provider: z.string(),
  generated_at: z.date().or(z.string()),
});
