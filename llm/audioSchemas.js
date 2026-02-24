import { z } from "zod";

// Single segment of the audio script
export const AudioSegmentSchema = z.object({
    text: z.string().min(1),
    direction: z.string().nullable().optional(),
});

// Full script output from the LLM
export const AudioScriptSchema = z.object({
    title: z.string(),
    segments: z.array(AudioSegmentSchema).min(1),
    estimated_duration_seconds: z.number().optional().default(180),
});
