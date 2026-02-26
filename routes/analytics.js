import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
  getAnalyticsSummary,
  getCourseAnalytics,
  getWeeklyAnalytics,
} from "../controller/analyticsController.js";

const router = express.Router();

router.get("/summary", authMiddleware, getAnalyticsSummary);
router.get("/course/:courseId", authMiddleware, getCourseAnalytics);
router.get("/weekly", authMiddleware, getWeeklyAnalytics);

export default router;
