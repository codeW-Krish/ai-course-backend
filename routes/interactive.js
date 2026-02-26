import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
	startSession,
	verifyAnswer,
	chatWithAI,
	getNextSubtopic,
	chatWithCourseAI,
	generateCoursePractice,
	getNextContent,
	getQuiz,
	submitQuiz,
	logHubActivity,
	getHubHistory,
} from "../controller/interactiveController.js";

const router = express.Router();

// === Content-First Interactive Flow ===
// Get content for next uncompleted subtopic (triggers background quiz gen)
router.get("/course/:courseId/next-content", authMiddleware, getNextContent);
// Get quiz questions (with correct answers for client-side checking)
router.get("/:subtopicId/quiz", authMiddleware, getQuiz);
// Submit all quiz results at once
router.post("/:subtopicId/submit-quiz", authMiddleware, submitQuiz);

// === Hub History ===
router.post("/hub/log", authMiddleware, logHubActivity);
router.get("/hub/history/:courseId", authMiddleware, getHubHistory);

// === Existing: Sequential learning - finds next uncompleted subtopic (legacy) ===
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
