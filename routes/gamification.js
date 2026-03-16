import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { getMyGamification, pingDailyActivity } from "../controller/gamificationController.js";

const router = express.Router();

router.get("/me", authMiddleware, getMyGamification);
router.post("/activity/ping", authMiddleware, pingDailyActivity);

export default router;
