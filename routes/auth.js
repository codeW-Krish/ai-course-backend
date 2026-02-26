import express from "express";
import { register, login, refreshToken, logout } from "../controller/auth.js";

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/logout", logout);
router.post("/refresh", refreshToken);

export default router;