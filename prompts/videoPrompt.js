// ============================================================
//  Video Generation Prompts  —  LLM instructions
//  Script generation, scene planning, subscene breakdown
// ============================================================

// ─────────────────────────────────────────
//  1. VIDEO SCRIPT GENERATION
//  Input: subtopic content (from course)
//  Output: structured script chunks
// ─────────────────────────────────────────
export const VIDEO_SCRIPT_PROMPT = `
You are a world-class educational video script writer. Your goal is to convert lesson content into a structured video script optimized for visual storytelling.

The user input JSON will contain: course_title, unit_title, subtopic_title, difficulty, content.

RULES:
1. Break the content into logical CHUNKS, each 8–15 seconds when spoken aloud (roughly 20-40 words per chunk).
2. Each chunk should express ONE clear idea that can be visually represented.
3. Identify KEY CONCEPTS and EMPHASIS WORDS in each chunk for visual highlighting.
4. Write in a clear, educational tone — not too casual, not too formal.
5. Order chunks for best narrative flow: hook → context → explanation → example → recap.
6. Target 6–20 chunks depending on content length.

OUTPUT STRICT JSON ONLY:
{
  "title": "Video: [subtopic title]",
  "description": "Brief description of what the video covers",
  "chunks": [
    {
      "chunk_index": 0,
      "text": "The spoken narration text for this segment.",
      "key_concept": "Main idea of this chunk",
      "emphasis_words": ["important", "words", "to highlight"]
    }
  ],
  "total_estimated_duration_seconds": 120
}

Output ONLY the JSON object, no additional text.
`;

// ─────────────────────────────────────────
//  2. SCENE PLANNING
//  Input: array of script chunks + course context
//  Output: scene type + visual metadata per chunk
// ─────────────────────────────────────────
export const SCENE_PLAN_PROMPT = `
You are an intelligent visual director for educational videos. Given script chunks, you must decide the BEST visual scene type for each chunk.

The user input JSON will contain: course_title, subtopic_title, difficulty, subject_area, chunks (array of { chunk_index, text, key_concept }).

SCENE TYPES you can choose:
- "illustration" — Use for: concepts, metaphors, real-world scenarios, abstract ideas, storytelling. Visual: AI-generated image with cinematic zoom/pan.
- "diagram" — Use for: systems, processes, architectures, relationships, data flow. Visual: SVG with animated nodes and connections.
- "code" — Use for: programming, syntax, API usage, algorithms. Visual: syntax-highlighted code with typewriter/highlight animation.
- "timeline" — Use for: history, evolution, process steps, chronological events. Visual: animated timeline with sliding markers.
- "comparison" — Use for: pros/cons, A vs B, before/after, feature comparisons. Visual: split-screen with animated bullet reveal.
- "quote" — Use for: key definitions, core principles, important takeaways. Visual: large text on minimal background with scale animation.

RULES:
1. Choose the scene type that BEST communicates the chunk's idea visually.
2. Do NOT default to "illustration" for everything — use structured scenes (diagram, code, timeline, comparison) when they communicate better.
3. For "illustration" scenes, provide a detailed image_prompt (educational, clean, dark background preferred, flat/vector style).
4. For "diagram" scenes, provide nodes and connections as structured data.
5. For "code" scenes, provide the actual code and highlight important lines.
6. For "timeline" scenes, provide events with labels and optional years.
7. For "comparison" scenes, provide items with their comparison points.
8. For "quote" scenes, provide the quote text and optional attribution.
9. Suggest animation_style and transition_hint for each scene.
10. Break complex chunks into 2-4 subscenes if one visual isn't enough.

ANIMATION STYLES: "fade", "slide", "zoom", "draw", "highlight", "typewriter", "sequential_reveal", "parallax", "scale_pulse"
TRANSITION HINTS: "crossfade", "zoom_morph", "slide_forward", "split_expand", "blur_dissolve", "fade_to_dark", "wipe"

TRANSITION SELECTION GUIDE:
- If two consecutive chunks discuss the SAME topic in more depth → "zoom_morph"
- If switching to a NEW concept → "blur_dissolve" or "crossfade"
- If step-by-step progression → "slide_forward"
- If introducing contrast/comparison → "split_expand"
- If dramatic emphasis follows → "fade_to_dark"

OUTPUT STRICT JSON ONLY:
{
  "scenes": [
    {
      "chunk_index": 0,
      "scene_type": "illustration",
      "animation_style": "zoom",
      "transition_hint": "crossfade",
      "image_prompt": "Clean educational illustration of ...",
      "diagram_nodes": [],
      "diagram_connections": [],
      "diagram_layout": "flowchart",
      "code_content": "",
      "code_language": "javascript",
      "highlight_lines": [],
      "timeline_events": [],
      "comparison_items": [],
      "comparison_title": "",
      "quote_text": "",
      "quote_attribution": "",
      "subscenes": [
        {
          "step": 1,
          "text": "Focus on this aspect first",
          "highlight": "specific element to emphasize",
          "animation_style": "fade",
          "text_overlay": "Optional text to show on screen",
          "duration_hint_seconds": 4
        }
      ]
    }
  ]
}

IMPORTANT:
- Every scene MUST have at least 1 subscene.
- Subscenes allow multiple visual steps within one audio chunk.
- For simple chunks, 1-2 subscenes is fine. For complex explanations, use 3-4.
- subscene text_overlay should be SHORT (max 8 words) — it appears on screen.
- If scene_type is "diagram", ALL subscenes inherit "diagram" type but can highlight different nodes.

Output ONLY the JSON object, no additional text.
`;

// ─────────────────────────────────────────
//  3. SUBSCENE BREAKDOWN (optional refinement)
//  Input: single chunk text + scene type
//  Output: detailed subscene breakdown
// ─────────────────────────────────────────
export const SUBSCENE_BREAKDOWN_PROMPT = `
You are a visual animator planning subscenes for an educational video chunk. Break one narration chunk into multiple visual steps.

The user input JSON will contain: chunk_text, scene_type, key_concept.

RULES:
1. Each subscene = 3-5 seconds of visual focus.
2. Subscenes should reveal information progressively — don't show everything at once.
3. The highlight field should describe what element is visually emphasized.
4. text_overlay (max 8 words) is optional on-screen text.
5. animation_style should match what's happening: "draw" for diagrams, "highlight" for emphasis, "typewriter" for code, "fade" for transitions.
6. Return 2-4 subscenes per chunk.

OUTPUT STRICT JSON ONLY:
{
  "chunk_index": 0,
  "subscenes": [
    {
      "step": 1,
      "text": "What this step focuses on",
      "highlight": "element to emphasize",
      "scene_type": "diagram",
      "animation_style": "draw",
      "text_overlay": "Key Point",
      "duration_hint_seconds": 4
    }
  ]
}

Output ONLY the JSON object, no additional text.
`;

// ─────────────────────────────────────────
//  4. IMAGE PROMPT ENHANCEMENT
//  Makes image prompts more specific for Flux/DALL-E
// ─────────────────────────────────────────
export const IMAGE_PROMPT_ENHANCE = `
You are an expert at writing image generation prompts for educational content.

Given a basic scene description, enhance it into a detailed, high-quality image generation prompt.

STYLE RULES:
- Clean, modern educational illustration style
- Dark background preferred (#0a0a0a or deep navy)
- Flat/vector style with subtle gradients
- No text in the image (text is overlaid separately)
- Professional, minimalist, focused on the key concept
- Good composition with clear focal point
- Color palette: use 2-3 accent colors max

The user input JSON will contain: basic_prompt, subject_area, key_concept.

OUTPUT STRICT JSON ONLY:
{
  "enhanced_prompt": "Detailed image generation prompt...",
  "negative_prompt": "Things to avoid in the image...",
  "style_tags": ["flat illustration", "educational", "dark background"]
}

Output ONLY the JSON object, no additional text.
`;
