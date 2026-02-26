// ============================================================
//  Video Routes
//  API endpoints for video generation + retrieval
// ============================================================

import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
  generateVideoForSubtopic,
  getVideoForSubtopic,
  getVideoForCourse,
  regenerateVideoForSubtopic,
  previewVideoForSubtopic,
} from "../controller/videoController.js";

const router = Router();

// All video routes require authentication
router.use(authMiddleware);

// ─────────────────────────────────────────
//  Subtopic video endpoints
// ─────────────────────────────────────────

// Generate video for a single subtopic (or return cached)
// POST /api/videos/:subtopicId/generate
//   Query params: llm_provider, llm_model, tts_provider, voice, image_provider
router.post("/:subtopicId/generate", generateVideoForSubtopic);

// Get video status/data for a subtopic
// GET /api/videos/:subtopicId
router.get("/:subtopicId", getVideoForSubtopic);

// Regenerate video (delete cache + regenerate)
// POST /api/videos/:subtopicId/regenerate
//   Query params: same as generate
router.post("/:subtopicId/regenerate", regenerateVideoForSubtopic);

// Preview: script + scene plan only (no rendering)
// GET /api/videos/:subtopicId/preview
//   Query params: llm_provider, llm_model
router.get("/:subtopicId/preview", previewVideoForSubtopic);

// ─────────────────────────────────────────
//  Course-level video endpoints
// ─────────────────────────────────────────

// Get all video statuses for a course
// GET /api/videos/course/:courseId
router.get("/course/:courseId", getVideoForCourse);

export default router;
