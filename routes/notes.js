import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { getGeneratedNotes, exportSubtopicNotes, exportCourseNotes } from "../controller/notesController.js";

const router = express.Router();

// Export all notes for a course (must be before /:subtopicId routes)
router.get("/course/:courseId/export", authMiddleware, exportCourseNotes);

// Get or generate AI notes for a subtopic
router.get("/:subtopicId/generated", authMiddleware, getGeneratedNotes);

// Export single subtopic notes
router.get("/:subtopicId/export", authMiddleware, exportSubtopicNotes);

export default router;
