import express from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
  getMyProfile,
  updateMyProfile,
  getUserProfile,
  followUser,
  unfollowUser,
  getFollowers,
  getFollowing,
} from "../controller/userController.js";

const router = express.Router();

// Own profile
router.get("/me", authMiddleware, getMyProfile);
router.put("/me", authMiddleware, updateMyProfile);

// Public profile
router.get("/:userId/profile", authMiddleware, getUserProfile);

// Follow system
router.post("/:userId/follow", authMiddleware, followUser);
router.delete("/:userId/follow", authMiddleware, unfollowUser);

// Followers / Following lists
router.get("/:userId/followers", authMiddleware, getFollowers);
router.get("/:userId/following", authMiddleware, getFollowing);

export default router;
