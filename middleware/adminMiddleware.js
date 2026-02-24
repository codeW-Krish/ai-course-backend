import { db } from "../db/firebase.js";
import { extractBearerToken, tokenErrorReason, verifyAccessToken } from "../service/authTokenService.js";

const adminMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const accessToken = extractBearerToken(authHeader);

  if (!accessToken) {
    console.warn("[auth:admin] 401 missing_token (no bearer token)");
    return res.status(401).json({
      error: "No token provided",
      reason: "missing_token",
    });
  }

  try {
    const decoded = verifyAccessToken(accessToken);

    const userDoc = await db.collection("users").doc(decoded.sub).get();

    if (!userDoc.exists) {
      return res.status(401).json({
        error: "User not found",
        reason: "invalid_token",
      });
    }

    const userData = userDoc.data();

    if (userData.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      username: userData.username || decoded.email?.split("@")[0],
      role: userData.role,
    };

    next();
  } catch (error) {
    const reason = tokenErrorReason(error);
    console.warn(`[auth:admin] 401 ${reason} (${error?.message || "verify failed"})`);
    return res.status(401).json({
      error: reason === "expired_token" ? "Token expired" : "Invalid token",
      reason,
    });
  }
};

export { adminMiddleware };
export default adminMiddleware;