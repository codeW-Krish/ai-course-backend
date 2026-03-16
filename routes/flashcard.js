import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { getFlashcards, reviewFlashcard, getDueFlashcards } from "../controller/flashcardController.js";

const router = express.Router();

// Get due flashcards for a course (must be before /:subtopicId to avoid clash)
router.get("/course/:courseId/due", authMiddleware, getDueFlashcards);

// Get or generate flashcards for a subtopic
router.get("/:subtopicId", authMiddleware, getFlashcards);

// Submit review result (SM-2 update)
router.post("/:flashcardId/review", authMiddleware, reviewFlashcard);

export default router;
