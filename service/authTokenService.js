import crypto from "crypto";
import jwt from "jsonwebtoken";

const ACCESS_TOKEN_TYPE = "access";
const REFRESH_TOKEN_TYPE = "refresh";

const getSecret = () => process.env.JWT_SECRET || process.env.SECRET_KEY || "dev-insecure-secret-change-me";

const getAccessExpiry = () => process.env.JWT_ACCESS_EXPIRES_IN || "15m";

const getRefreshExpiry = () => process.env.JWT_REFRESH_EXPIRES_IN || "30d";

const basePayload = (user) => ({
    sub: user.id,
    email: user.email,
    role: user.role || "user",
});

export const issueAccessToken = (user) => {
    return jwt.sign(
        {
            ...basePayload(user),
            type: ACCESS_TOKEN_TYPE,
        },
        getSecret(),
        { expiresIn: getAccessExpiry() }
    );
};

export const issueRefreshToken = (user) => {
    return jwt.sign(
        {
            ...basePayload(user),
            type: REFRESH_TOKEN_TYPE,
        },
        getSecret(),
        { expiresIn: getRefreshExpiry() }
    );
};

export const verifyAccessToken = (token) => {
    const decoded = jwt.verify(token, getSecret());
    if (decoded?.type !== ACCESS_TOKEN_TYPE) {
        const err = new Error("Token type mismatch");
        err.name = "JsonWebTokenError";
        throw err;
    }
    return decoded;
};

export const verifyRefreshToken = (token) => {
    const decoded = jwt.verify(token, getSecret());
    if (decoded?.type !== REFRESH_TOKEN_TYPE) {
        const err = new Error("Token type mismatch");
        err.name = "JsonWebTokenError";
        throw err;
    }
    return decoded;
};

export const decodeToken = (token) => jwt.decode(token);

export const extractBearerToken = (authHeader) => {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
    }

    return authHeader.split(" ")[1]?.trim() || null;
};

export const hashToken = (token) => {
    return crypto.createHash("sha256").update(token).digest("hex");
};

export const tokenErrorReason = (error) => {
    if (error?.name === "TokenExpiredError") {
        return "expired_token";
    }
    return "invalid_token";
};

export const authConfigSummary = () => ({
    accessExpiresIn: getAccessExpiry(),
    refreshExpiresIn: getRefreshExpiry(),
    secretSource: process.env.JWT_SECRET
        ? "JWT_SECRET"
        : process.env.SECRET_KEY
            ? "SECRET_KEY"
            : "fallback_dev_secret",
});
