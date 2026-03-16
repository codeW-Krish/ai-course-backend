import { tokenErrorReason, verifyAccessToken, extractBearerToken } from "../service/authTokenService.js";

const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const accessToken = extractBearerToken(authHeader);

  if (!accessToken) {
    console.warn("[auth:middleware] 401 missing_token (no bearer token)");
    return res.status(401).json({
      error: "No token provided",
      reason: "missing_token",
    });
  }

  try {
    const decoded = verifyAccessToken(accessToken);

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role || "user",
      username: decoded.email?.split("@")[0] || "User",
    };

    next();
  } catch (error) {
    const reason = tokenErrorReason(error);
    console.warn(`[auth:middleware] 401 ${reason} (${error?.message || "verify failed"})`);
    return res.status(401).json({
      error: reason === "expired_token" ? "Token expired" : "Invalid token",
      reason,
    });
  }
};

export { authMiddleware };
export default authMiddleware;
