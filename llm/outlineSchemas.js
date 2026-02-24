// src/validation/outlineSchemas.js
import { z } from "zod";

// Client request body schema
export const OutlineRequestSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(2000),
  numUnits: z.number().int().min(1).max(20),
  difficulty: z.enum(["Beginner", "Intermediate", "Advanced"]),
  includeVideos: z.boolean().optional().default(false),
  provider: z.string().optional().default("Groq"),
  model: z.string().optional().nullable(),
});

// LLM output schema (strict)
export const LlmOutlineSchema = z.object({
  course_title: z.string().min(3),
  difficulty: z.enum(["Beginner", "Intermediate", "Advanced"]).optional(), // nice to have
  units: z.array(z.object({
    position: z.number().int().min(1),
    title: z.string().min(3),
    subtopics: z.array(z.string().min(2)).min(1).max(6),
  })).min(1),
}).strict();

// Input outline schema for Regeneration of Content

export const RegenerateContentOutlineSchema = z.object({
  course_title: z.string().min(3, "Course title must be at least 3 characters long"),
  difficulty: z.enum(["Beginner", "Intermediate", "Advanced"]).optional(),
  units: z.array(z.object({
    position: z.number().int().min(1, "Position must be a positive integer").optional(),
    title: z.string().min(3, "Unit title must be at least 3 characters long"),
    subtopics: z.array(z.string().min(2, "Subtopic title must be at least 2 characters long")).min(1, "Each unit must have at least 1 subtopics").max(6, "Each unit can have a maximum of 6 subtopics"),
  })).min(1, "There must be at least one unit"),
  want_youtube_keywords: z.boolean().optional(),
  provider: z.string().min(3, "Provider must be a valid string").optional(),
  model: z.string().min(3, "Model name must be at least 3 characters long").optional(),
}).strict();



// Normalizer: if model returns "position" as string, coerce to int
export function normalizeLlmOutline(raw) {
  // If the model sometimes returns code-fenced JSON, your gemini service already strips it.
  // Here we just coerce positions to integers and trim strings.
  const copy = structuredClone(raw);
  copy.units = (copy.units || []).map(u => ({
    position: typeof u.position === "string" ? parseInt(u.position, 10) : u.position,
    title: (u.title || "").trim(),
    subtopics: (u.subtopics || []).map(s => (s || "").trim()),
  }));
  return copy;
}

export function normalizeLlmOutlineForRegeneration(raw) {
  // console.log("Normalizing Raw Input:", raw); 
  // Check if raw is an object and contains units
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.units)) {
    throw new Error("Invalid input: 'raw' must be an object with a 'units' array.");
  }

  // Clone the input to avoid mutating the original data
  const copy = structuredClone(raw);

  // Normalize units (if present)
  copy.units = (copy.units || []).map(u => ({
    position: typeof u.position === "string" ? parseInt(u.position, 10) : u.position, // Coerce position to integer
    title: (u.title || "").trim(), // Trim the title
    subtopics: (u.subtopics || []).map(s => (s || "").trim()), // Trim all subtopics
  }));

  return copy;
}


export const CoreConceptsSchema = z.object({
  concept: z.string(),
  explanation: z.string(),
})

export const SubtopicContentSchema = z.object({
  subtopic_title: z.string(),
  title: z.string(),
  why_this_matters: z.string(),
  core_concepts: z.array(CoreConceptsSchema),
  examples: z.array(
    z.object({
      type: z.enum(["analogy", "technical_example"]),
      content: z.string(),
    })
  ),
  code_or_math: z.union([z.string(), z.null()]),
  youtube_keywords: z.union([z.array(z.string()), z.null()]).optional(),
});


export const SubtopicBatchResponseSchema = z.array(SubtopicContentSchema);