import express from "express";
import { authMiddleware} from "../middleware/authMiddleware.js";
import { deleteCourseById, enrollInCourse, generateCourseContent, generateCourseOutline, getAllPublicCourses, getCourseContentById, getCourseGenerationStatus, getCourseOutline, getCoursesCreatedByMe, getCoursesEnrolledByMe, retryFailedSubtopics, streamCourseGeneration, updateOrRegenerateCourseOutlineController, } from "../controller/course.js";

const router = express.Router();

// Get all public courses
router.get("/", getAllPublicCourses);

// Get courses created by the logged-in user
router.get("/me", authMiddleware, getCoursesCreatedByMe);

// Get courses enrolled by the logged-in user
router.get("/me/enrolled", authMiddleware, getCoursesEnrolledByMe);

// Generate course outline using LLM (Gemini)
router.post("/generate-outline", authMiddleware, generateCourseOutline);

// Get outline
router.get("/:id/getoutline", getCourseOutline);

// Update a course outline
router.put("/:id/outline", authMiddleware, updateOrRegenerateCourseOutlineController);

// Upadte Created Course OUtline and Regenerate the content for it (insert/ update/ delete)
router.post("/:id/outline/regenerate", authMiddleware, updateOrRegenerateCourseOutlineController);

// Enroll user into a course
router.post("/:id/enroll", authMiddleware, enrollInCourse);

// Delete created Course
router.delete("/:id", authMiddleware, deleteCourseById);

// Get full course content with units & subtopics
router.get("/:id/full", authMiddleware, getCourseContentById);

// Generate content for subtopics 
router.post("/:id/generate-content", authMiddleware, generateCourseContent);

// Stream Generation
router.post("/:id/generate-content-stream", authMiddleware, streamCourseGeneration);

// Retry for topics where subtopic content in NULL
router.post("/:id/retry-failed-subtopics", authMiddleware, retryFailedSubtopics);

// To Check the generation status for poling 
router.get("/:id/generation-status", authMiddleware, getCourseGenerationStatus)


export default router;