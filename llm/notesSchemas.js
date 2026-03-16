import { z } from "zod";

export const TechnicalExampleSchema = z.object({
    language: z.string(),
    code: z.string(),
    explanation: z.string(),
}).nullable();

export const MiniQASchema = z.object({
    question: z.string().min(5),
    answer: z.string().min(5),
});

export const GeneratedNotesSchema = z.object({
    summary: z.string().min(10),
    the_problem: z.string().min(10),
    previous_approaches: z.string().min(10),
    the_solution: z.string().min(20),
    key_points: z.array(z.string()).min(2),
    analogy: z.string().min(10),
    real_world_example: z.string().min(10),
    technical_example: TechnicalExampleSchema.optional().nullable(),
    workflow: z.array(z.string()).nullable().optional(),
    common_mistakes: z.array(z.string()).min(1),
    common_confusions: z.array(z.string()).min(1),
    mini_qa: z.array(MiniQASchema).min(2).max(5),
});
