import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
	startSession,
	verifyAnswer,
	chatWithAI,
	getNextSubtopic,
	chatWithCourseAI,
	generateCoursePractice,
} from "../controller/interactiveController.js";

const router = express.Router();

// NEW: Sequential learning - finds next uncompleted subtopic
router.get("/course/:courseId/next", authMiddleware, getNextSubtopic);
// Course-level AI Study Buddy (with session memory)
router.post("/course/:courseId/chat", authMiddleware, chatWithCourseAI);
// Course-level custom practice generation
router.post("/course/:courseId/practice", authMiddleware, generateCoursePractice);
// Existing routes
router.get("/:subtopicId", authMiddleware, startSession);
router.post("/:subtopicId/verify", authMiddleware, verifyAnswer);
router.post("/:subtopicId/chat", authMiddleware, chatWithAI);

export default router;
