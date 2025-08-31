import express from "express";
import { authMiddleware} from "../middleware/authMiddleware.js";
import { enrollInCourse, generateCourseContent, generateCourseOutline, generateSubtopicAndRelatedContent, getAllPublicCourses, getCourseContentById, getCoursesCreatedByMe, getCoursesEnrolledByMe, updateCourseOutline, } from "../controller/course.js";

const router = express.Router();

// Get all public courses
router.get("/", getAllPublicCourses);

// Get courses created by the logged-in user
router.get("/me", authMiddleware, getCoursesCreatedByMe);

// Get courses enrolled by the logged-in user
router.get("/me/enrolled", authMiddleware, getCoursesEnrolledByMe);

// Generate course outline using LLM (Gemini)
router.post("/generate-outline", authMiddleware, generateCourseOutline);

// Update a course outline
router.put("/:id/outline", authMiddleware, updateCourseOutline);

// Enroll user into a course
router.post("/:id/enroll", authMiddleware, enrollInCourse);

// Get full course content with units & subtopics
router.get("/:id/full", authMiddleware, getCourseContentById);

router.post("/:id/generate-content", authMiddleware, generateCourseContent);

router.get('/api/subtopics/:id/generate-content', generateSubtopicAndRelatedContent);

export default router;