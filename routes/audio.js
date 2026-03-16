import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
	getAudioForSubtopic,
	getAudioForCourse,
	streamAudioForSubtopic,
	downloadAudioForSubtopic,
} from "../controller/audioController.js";

const router = Router();

// All audio routes require authentication
router.use(authMiddleware);

// Generate/get audio for a single subtopic
// GET /api/audio/:subtopicId?tts_provider=Groq&voice=autumn&llm_provider=Groq
router.get("/:subtopicId", getAudioForSubtopic);

// Stream subtopic audio for in-app player
// GET /api/audio/:subtopicId/stream
router.get("/:subtopicId/stream", streamAudioForSubtopic);

// Download subtopic audio
// GET /api/audio/:subtopicId/download
router.get("/:subtopicId/download", downloadAudioForSubtopic);

// Generate/get audio overview for entire course
// GET /api/audio/course/:courseId?tts_provider=Groq&voice=autumn&llm_provider=Groq
router.get("/course/:courseId", getAudioForCourse);

export default router;
