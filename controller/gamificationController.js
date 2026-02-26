import { getUserStats, touchUserDailyActivity } from "../service/gamificationService.js";

export const getMyGamification = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const data = await getUserStats(userId);
    return res.json(data);
  } catch (err) {
    console.error("getMyGamification error:", err);
    return res.status(500).json({ error: "Failed to fetch gamification data" });
  }
};

export const pingDailyActivity = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const activityType = req.body?.activity_type || "daily_ping";
    await touchUserDailyActivity(userId, activityType, { source: "manual_ping" });

    const data = await getUserStats(userId);
    return res.json({
      message: "Activity recorded",
      stats: data.stats,
    });
  } catch (err) {
    console.error("pingDailyActivity error:", err);
    return res.status(500).json({ error: "Failed to record activity" });
  }
};
