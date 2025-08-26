import jwt from "jsonwebtoken";

export const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: "Authorization header is missing or malformed" });
  }

  const token = authHeader.split(' ')[1];

  try {
    const secretKey = process.env.ACCESS_TOKEN_SECRET;

    if (!secretKey) {
      throw new Error('ACCESS_TOKEN_SECRET not set in environment variables');
    }

    const decoded = jwt.verify(token, secretKey);

    // Attach user data from token to request object
    req.user = {
      id: decoded.sub || decoded.subject,
      email: decoded.email,
      username: decoded.username,
    };

    next(); // ✅ Continue to the next middleware or route
  } catch (err) {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};
