  // src/validation/outlineSchemas.js
  import { z } from "zod";

  // Client request body schema
  export const OutlineRequestSchema = z.object({
    title: z.string().min(3).max(200),
    description: z.string().min(10).max(2000),
    numUnits: z.number().int().min(1).max(20),
    difficulty: z.enum(["Beginner", "Intermediate", "Advanced"]),
    includeVideos: z.boolean().optional().default(false),
    provider: z.string().optional().default("Gemini"),
    model: z.string().optional().nullable(),
  });

  // LLM output schema (strict)
  export const LlmOutlineSchema = z.object({
    course_title: z.string().min(3),
    difficulty: z.enum(["Beginner", "Intermediate", "Advanced"]).optional(), // nice to have
    units: z.array(z.object({
      position: z.number().int().min(1),
      title: z.string().min(3),
      subtopics: z.array(z.string().min(2)).min(2).max(6),
    })).min(1),
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