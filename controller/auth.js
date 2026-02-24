import { z } from "zod";
import User from "../models/User.js";
import { db } from "../db/firebase.js";
import {
    authConfigSummary,
    decodeToken,
    extractBearerToken,
    hashToken,
    issueAccessToken,
    issueRefreshToken,
    tokenErrorReason,
    verifyAccessToken,
    verifyRefreshToken,
} from "../service/authTokenService.js";

// Validation schemas
const registerSchema = z.object({
    username: z.string().min(3).max(30),
    email: z.string().email(),
    password: z.string().min(6),
});

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
});

const refreshSchema = z.object({
    refreshToken: z.string().optional(),
    refresh_token: z.string().optional(),
    token: z.string().optional(),
});

const resolveRefreshTokenInput = (req) => {
    const body = req.body || {};
    const parsed = refreshSchema.safeParse(body);
    const bodyToken = parsed.success
        ? parsed.data.refreshToken || parsed.data.refresh_token || parsed.data.token
        : body.refreshToken || body.refresh_token || body.token;

    return bodyToken || extractBearerToken(req.headers.authorization);
};

const log401 = (scope, reason, details = "") => {
    const suffix = details ? ` (${details})` : "";
    console.warn(`[auth:${scope}] 401 ${reason}${suffix}`);
};

const withTokenAliases = ({ user, accessToken, refreshToken, message }) => ({
    message,
    user,
    accessToken,
    token: accessToken,
    refreshToken,
    refresh_token: refreshToken,
    tokens: {
        accessToken,
        refreshToken,
    },
});

const defaultUsernameFromEmail = (email = "") => {
    return email.includes("@") ? email.split("@")[0] : "User";
};

const upsertUserRefreshToken = async ({ userId, refreshToken }) => {
    const tokenHash = hashToken(refreshToken);
    const decoded = decodeToken(refreshToken);
    const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null;

    const userDoc = db.collection("users").doc(userId);
    const snapshot = await userDoc.get();
    const existing = snapshot.exists ? snapshot.data().refresh_tokens || [] : [];

    const filtered = existing.filter((entry) => entry?.token_hash !== tokenHash);
    filtered.push({
        token_hash: tokenHash,
        created_at: new Date().toISOString(),
        expires_at: expiresAt,
        revoked_at: null,
    });

    await userDoc.set({ refresh_tokens: filtered }, { merge: true });
};

const isRefreshTokenStoredAndActive = async ({ userId, refreshToken }) => {
    const tokenHash = hashToken(refreshToken);
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) return false;

    const refreshTokens = userDoc.data().refresh_tokens || [];
    const found = refreshTokens.find((entry) => entry?.token_hash === tokenHash);
    if (!found) return false;
    if (found.revoked_at) return false;
    if (found.expires_at && new Date(found.expires_at).getTime() < Date.now()) return false;
    return true;
};

const revokeRefreshToken = async ({ userId, refreshToken }) => {
    const tokenHash = hashToken(refreshToken);
    const userRef = db.collection("users").doc(userId);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return;

    const refreshTokens = snapshot.data().refresh_tokens || [];
    const updated = refreshTokens.map((entry) => {
        if (entry?.token_hash === tokenHash) {
            return {
                ...entry,
                revoked_at: new Date().toISOString(),
            };
        }
        return entry;
    });

    await userRef.set({ refresh_tokens: updated }, { merge: true });
};

const verifyFirebasePassword = async ({ email, password }) => {
    const apiKey = process.env.FIREBASE_API_KEY;
    if (!apiKey) {
        throw new Error("FIREBASE_API_KEY is required for email/password login");
    }

    const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email,
                password,
                returnSecureToken: true,
            }),
        }
    );

    const data = await response.json();
    if (!response.ok) {
        const err = new Error(data?.error?.message || "INVALID_CREDENTIALS");
        err.code = data?.error?.message || "INVALID_CREDENTIALS";
        throw err;
    }

    return data;
};

/**
 * POST /api/auth/register
 * Creates a Firebase Auth user + Firestore user doc
 * Returns the user data (frontend handles Firebase sign-in to get the token)
 */
export const register = async (req, res) => {
    try {
        const parsed = registerSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: "Validation failed",
                details: parsed.error.errors,
            });
        }

        const { username, email, password } = parsed.data;

        // Check if username already taken in Firestore
        const existingUser = await db
            .collection("users")
            .where("username", "==", username)
            .limit(1)
            .get();

        if (!existingUser.empty) {
            return res.status(400).json({ error: "Username already taken" });
        }

        // Create user via the User model (Firebase Auth + Firestore)
        const user = await User.create({ email, password, username });

        const userView = {
            id: user.id,
            email: user.email,
            username: user.username,
            role: user.role,
        };

        const accessToken = issueAccessToken(userView);
        const refreshToken = issueRefreshToken(userView);
        await upsertUserRefreshToken({ userId: user.id, refreshToken });

        return res.status(201).json({
            ...withTokenAliases({
                message: "Registration successful",
                user: userView,
                accessToken,
                refreshToken,
            }),
            authModel: "jwt",
        });
    } catch (error) {
        console.error("Register error:", error);

        // Handle Firebase Auth specific errors
        if (error.code === "auth/email-already-exists") {
            return res.status(400).json({ error: "Email already registered" });
        }
        if (error.code === "auth/invalid-email") {
            return res.status(400).json({ error: "Invalid email format" });
        }
        if (error.code === "auth/weak-password") {
            return res.status(400).json({ error: "Password is too weak" });
        }

        return res.status(500).json({ error: "Registration failed" });
    }
};

/**
 * POST /api/auth/login
 * Verifies a Firebase ID token and returns user data
 * Note: Actual sign-in happens client-side with Firebase SDK.
 * This endpoint is for verifying the token and getting user profile data.
 */
export const login = async (req, res) => {
    try {
        const parsed = loginSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({
                error: "Validation failed",
                details: parsed.error.errors,
            });
        }

        const { email, password } = parsed.data;
        const firebaseSignIn = await verifyFirebasePassword({ email, password });

        const uid = firebaseSignIn.localId;
        let user = await User.findById(uid);
        if (!user) {
            user = await User.findByEmail(email);
        }

        if (!user) {
            const fallbackUser = {
                email,
                username: defaultUsernameFromEmail(email),
                role: "user",
                created_at: new Date(),
            };
            await db.collection("users").doc(uid).set(fallbackUser, { merge: true });
            user = { id: uid, ...fallbackUser };
        }

        const userView = {
            id: uid,
            email: user.email,
            username: user.username || defaultUsernameFromEmail(user.email),
            role: user.role || "user",
        };

        const accessToken = issueAccessToken(userView);
        const refreshToken = issueRefreshToken(userView);
        await upsertUserRefreshToken({ userId: userView.id, refreshToken });

        return res.status(200).json({
            ...withTokenAliases({
                message: "Login successful",
                user: userView,
                accessToken,
                refreshToken,
            }),
            authModel: "jwt",
            jwtConfig: authConfigSummary(),
        });
    } catch (error) {
        if (
            error?.code === "INVALID_LOGIN_CREDENTIALS" ||
            error?.code === "EMAIL_NOT_FOUND" ||
            error?.code === "INVALID_PASSWORD" ||
            error?.code === "INVALID_CREDENTIALS"
        ) {
            log401("login", "invalid_token", error?.code || "invalid_credentials");
            return res.status(401).json({
                error: "Invalid email or password",
                reason: "invalid_token",
            });
        }

        if (error?.message?.includes("FIREBASE_API_KEY")) {
            console.error("Login configuration error:", error.message);
            return res.status(500).json({
                error: "Authentication configuration error",
                reason: "server_config_error",
            });
        }

        console.error("Login error:", error);
        return res.status(500).json({
            error: "Authentication failed",
            reason: "server_error",
        });
    }
};

/**
 * POST /api/auth/logout
 * With Firebase Auth, logout is handled client-side.
 * This endpoint just acknowledges the request.
 */
export const logout = async (req, res) => {
    try {
        const refreshToken = resolveRefreshTokenInput(req);
        const accessToken = extractBearerToken(req.headers.authorization);

        if (refreshToken) {
            const decodedRefresh = verifyRefreshToken(refreshToken);
            await revokeRefreshToken({ userId: decodedRefresh.sub, refreshToken });
        } else if (accessToken) {
            const decodedAccess = verifyAccessToken(accessToken);
            await db.collection("users").doc(decodedAccess.sub).set({ refresh_tokens: [] }, { merge: true });
        }

        return res.json({ message: "Logged out successfully" });
    } catch (error) {
        console.warn("Logout warning:", error?.message || error);
        return res.json({ message: "Logged out" });
    }
};

/**
 * POST /api/auth/refresh
 * Not needed with Firebase Auth — Firebase SDK handles token refresh automatically.
 * Keep this endpoint for backward compatibility, it just verifies the current token.
 */
export const refreshToken = async (req, res) => {
    try {
        const rawRefreshToken = resolveRefreshTokenInput(req);
        if (!rawRefreshToken) {
            log401("refresh", "missing_token", "no refresh token provided");
            return res.status(401).json({
                error: "No refresh token provided",
                reason: "missing_token",
            });
        }

        let decodedRefresh;
        try {
            decodedRefresh = verifyRefreshToken(rawRefreshToken);
        } catch (error) {
            const reason = tokenErrorReason(error);
            log401("refresh", reason, error?.message || "verify failed");
            return res.status(401).json({
                error: reason === "expired_token" ? "Refresh token expired" : "Invalid refresh token",
                reason,
            });
        }

        const isStored = await isRefreshTokenStoredAndActive({
            userId: decodedRefresh.sub,
            refreshToken: rawRefreshToken,
        });

        if (!isStored) {
            log401("refresh", "invalid_token", "refresh token not found/revoked");
            return res.status(401).json({
                error: "Refresh token invalid or revoked",
                reason: "invalid_token",
            });
        }

        const user = await User.findById(decodedRefresh.sub);
        if (!user) {
            log401("refresh", "invalid_token", "user not found");
            return res.status(401).json({
                error: "User not found",
                reason: "invalid_token",
            });
        }

        const userView = {
            id: user.id,
            email: user.email,
            username: user.username || defaultUsernameFromEmail(user.email),
            role: user.role || "user",
        };

        const newAccessToken = issueAccessToken(userView);
        const newRefreshToken = issueRefreshToken(userView);

        await revokeRefreshToken({ userId: user.id, refreshToken: rawRefreshToken });
        await upsertUserRefreshToken({ userId: user.id, refreshToken: newRefreshToken });

        return res.status(200).json({
            ...withTokenAliases({
                message: "Token refreshed",
                user: userView,
                accessToken: newAccessToken,
                refreshToken: newRefreshToken,
            }),
            authModel: "jwt",
        });
    } catch (error) {
        console.error("Refresh token error:", error);
        return res.status(500).json({
            error: "Could not refresh token",
            reason: "server_error",
        });
    }
};