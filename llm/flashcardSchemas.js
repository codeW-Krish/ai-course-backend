import { z } from "zod";

export const FlashcardSchema = z.object({
    front: z.string().min(3),
    back: z.string().min(3),
    card_type: z.enum(["term", "concept", "code"]),
});

export const FlashcardArraySchema = z.array(FlashcardSchema).min(3).max(15);
