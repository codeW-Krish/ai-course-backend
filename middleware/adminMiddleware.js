import jwt from "jsonwebtoken";

export const adminMiddleware = (req, res, next) => {
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

    // Check if user is admin
    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: "Admin access required" });
    }

    // Attach admin user data to request object
    req.user = {
      id: decoded.sub || decoded.subject,
      email: decoded.email,
      username: decoded.username,
      role: decoded.role
    };

    next();
  } catch (err) {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};