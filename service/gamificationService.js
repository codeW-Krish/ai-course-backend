import { db, FieldValue } from "../db/firebase.js";

const userStatsRef = db.collection("user_stats");
const userAchievementsRef = db.collection("user_achievements");
const userXpEventsRef = db.collection("user_xp_events");
const userActivityRef = db.collection("user_activity_log");
const userQuestionAttemptsRef = db.collection("user_question_attempts");
const userFlashcardReviewsRef = db.collection("user_flashcard_reviews");

function todayDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function parseDateKey(dateKey) {
  const parts = (dateKey || "").split("-").map((value) => parseInt(value, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function daysBetweenDateKeys(prevKey, currentKey) {
  const prev = parseDateKey(prevKey);
  const current = parseDateKey(currentKey);
  if (!prev || !current) return null;

  const diffMs = current.getTime() - prev.getTime();
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

export async function ensureUserStats(userId) {
  const statsDoc = await userStatsRef.doc(userId).get();
  if (statsDoc.exists) return statsDoc.data();

  const now = new Date();
  const initial = {
    user_id: userId,
    total_xp: 0,
    current_streak: 0,
    longest_streak: 0,
    courses_completed: 0,
    subtopics_completed: 0,
    quizzes_passed: 0,
    perfect_quizzes: 0,
    flashcards_reviewed: 0,
    last_activity_date: null,
    created_at: now,
    updated_at: now,
  };

  await userStatsRef.doc(userId).set(initial, { merge: true });
  return initial;
}

export async function touchUserDailyActivity(userId, activityType = "activity", metadata = {}) {
  const currentDateKey = todayDateKey();
  await ensureUserStats(userId);

  await db.runTransaction(async (transaction) => {
    const statsDocRef = userStatsRef.doc(userId);
    const statsDoc = await transaction.get(statsDocRef);

    const stats = statsDoc.exists ? statsDoc.data() : {};
    const previousDateKey = stats.last_activity_date || null;

    let currentStreak = stats.current_streak || 0;
    if (!previousDateKey) {
      currentStreak = 1;
    } else {
      const diffDays = daysBetweenDateKeys(previousDateKey, currentDateKey);
      if (diffDays === 0) {
        currentStreak = stats.current_streak || 1;
      } else if (diffDays === 1) {
        currentStreak = (stats.current_streak || 0) + 1;
      } else {
        currentStreak = 1;
      }
    }

    const longestStreak = Math.max(stats.longest_streak || 0, currentStreak);

    transaction.set(
      statsDocRef,
      {
        user_id: userId,
        current_streak: currentStreak,
        longest_streak: longestStreak,
        last_activity_date: currentDateKey,
        updated_at: new Date(),
      },
      { merge: true }
    );
  });

  await userActivityRef.add({
    user_id: userId,
    activity_type: activityType,
    date_key: currentDateKey,
    metadata,
    created_at: new Date(),
  });

  const refreshed = await userStatsRef.doc(userId).get();
  await unlockAchievements(userId, refreshed.data() || {});
}

export async function grantXpOnce(userId, eventKey, xpAmount, options = {}) {
  const {
    activityType = "xp_event",
    metadata = {},
    statIncrements = {},
  } = options;

  await ensureUserStats(userId);
  await touchUserDailyActivity(userId, activityType, metadata);

  const eventDocRef = userXpEventsRef.doc(`${userId}_${eventKey}`);
  const statsDocRef = userStatsRef.doc(userId);

  const result = await db.runTransaction(async (transaction) => {
    const eventDoc = await transaction.get(eventDocRef);
    if (eventDoc.exists) {
      return { granted: false };
    }

    const increments = {
      total_xp: FieldValue.increment(xpAmount),
      updated_at: new Date(),
    };

    Object.entries(statIncrements).forEach(([key, value]) => {
      if (typeof value === "number" && value !== 0) {
        increments[key] = FieldValue.increment(value);
      }
    });

    transaction.set(eventDocRef, {
      user_id: userId,
      event_key: eventKey,
      xp_awarded: xpAmount,
      metadata,
      created_at: new Date(),
    });

    transaction.set(statsDocRef, increments, { merge: true });
    return { granted: true };
  });

  const refreshed = await userStatsRef.doc(userId).get();
  await unlockAchievements(userId, refreshed.data() || {});
  return result;
}

export async function recordQuestionAttempt(userId, payload) {
  await ensureUserStats(userId);
  await touchUserDailyActivity(userId, "quiz_attempt", {
    course_id: payload.course_id || null,
    subtopic_id: payload.subtopic_id || null,
    is_correct: !!payload.is_correct,
  });

  await userQuestionAttemptsRef.add({
    user_id: userId,
    question_id: payload.question_id,
    course_id: payload.course_id || null,
    subtopic_id: payload.subtopic_id || null,
    is_correct: !!payload.is_correct,
    created_at: new Date(),
  });
}

export async function recordFlashcardReviewAndRewards(userId, payload) {
  await ensureUserStats(userId);
  await touchUserDailyActivity(userId, "flashcard_review", {
    flashcard_id: payload.flashcard_id,
    quality: payload.quality,
  });

  await userFlashcardReviewsRef.add({
    user_id: userId,
    flashcard_id: payload.flashcard_id,
    quality: payload.quality,
    is_success: payload.quality >= 3,
    created_at: new Date(),
  });

  await userStatsRef.doc(userId).set(
    {
      flashcards_reviewed: FieldValue.increment(1),
      updated_at: new Date(),
    },
    { merge: true }
  );

  const statsDoc = await userStatsRef.doc(userId).get();
  const stats = statsDoc.data() || {};
  const reviewed = stats.flashcards_reviewed || 0;

  if (reviewed > 0 && reviewed % 10 === 0) {
    await grantXpOnce(userId, `flashcards_10x_${reviewed}`, 25, {
      activityType: "flashcard_milestone",
      metadata: { reviewed },
    });
  }

  await unlockAchievements(userId, stats);
}

export async function getUserStats(userId) {
  await ensureUserStats(userId);
  const statsDoc = await userStatsRef.doc(userId).get();
  const achievementsSnap = await userAchievementsRef.where("user_id", "==", userId).get();

  const stats = statsDoc.data() || {};

  // Compute level from XP (each level requires 100 XP more than the previous)
  const totalXp = stats.total_xp || 0;
  const level = Math.floor(totalXp / 100);
  const nextLevelXp = (level + 1) * 100;

  return {
    stats: {
      ...stats,
      level,
      next_level_xp: nextLevelXp,
    },
    achievements: achievementsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  };
}

export async function unlockAchievements(userId, stats) {
  const achievementRules = [
    { key: "first_lesson", threshold: stats.subtopics_completed >= 1 },
    { key: "first_course", threshold: stats.courses_completed >= 1 },
    { key: "streak_7", threshold: stats.current_streak >= 7 },
    { key: "streak_30", threshold: stats.current_streak >= 30 },
    { key: "perfect_quiz", threshold: stats.perfect_quizzes >= 1 },
    { key: "ten_courses", threshold: stats.courses_completed >= 10 },
    { key: "flashcard_master", threshold: stats.flashcards_reviewed >= 100 },
  ];

  const writes = achievementRules
    .filter((rule) => !!rule.threshold)
    .map((rule) =>
      userAchievementsRef
        .doc(`${userId}_${rule.key}`)
        .set(
          {
            user_id: userId,
            achievement_key: rule.key,
            earned_at: new Date(),
          },
          { merge: true }
        )
    );

  await Promise.all(writes);
}
