// d:\AI Course Generator App\backend\llm\interactiveSchemas.js
import { z } from "zod";

export const QuestionSchema = z.object({
    question_type: z.enum(["mcq", "fill_blank"]),
    question_text: z.string().min(5),
    options: z.array(z.string()).optional(), // Required for MCQ
    correct_answer: z.string(),
    hint: z.string().optional(),
    explanation: z.string().optional(),
});

export const InteractiveContentSchema = z.object({
    content: z.string().min(50), // Explanatory text
    questions: z.array(QuestionSchema).min(1).max(5),
});

export const ContentOnlySchema = z.object({
    content: z.string().min(50),
});

export const QuizOnlySchema = z.object({
    questions: z.array(QuestionSchema).min(1).max(5),
});

export const ChatResponseSchema = z.object({
    ai_response: z.string(),
});
