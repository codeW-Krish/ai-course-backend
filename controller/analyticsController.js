import { db } from "../db/firebase.js";

const coursesRef = db.collection("courses");
const userStatsRef = db.collection("user_stats");
const userQuestionAttemptsRef = db.collection("user_question_attempts");
const userFlashcardReviewsRef = db.collection("user_flashcard_reviews");
const userActivityRef = db.collection("user_activity_log");
const userCoursesRef = db.collection("user_courses");

function safeRate(correct, total) {
  if (!total) return 0;
  return Number(((correct / total) * 100).toFixed(2));
}

export const getAnalyticsSummary = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const statsDoc = await userStatsRef.doc(userId).get();
    const stats = statsDoc.exists ? statsDoc.data() : {};

    const [enrolledSnap, questionSnap, flashSnap] = await Promise.all([
      userCoursesRef.where("user_id", "==", userId).get(),
      userQuestionAttemptsRef.where("user_id", "==", userId).get(),
      userFlashcardReviewsRef.where("user_id", "==", userId).get(),
    ]);

    const quizTotal = questionSnap.size;
    const quizCorrect = questionSnap.docs.filter((doc) => doc.data().is_correct).length;

    const flashTotal = flashSnap.size;
    const flashSuccess = flashSnap.docs.filter((doc) => doc.data().is_success).length;

    return res.json({
      summary: {
        total_xp: stats.total_xp || 0,
        current_streak: stats.current_streak || 0,
        longest_streak: stats.longest_streak || 0,
        courses_completed: stats.courses_completed || 0,
        subtopics_completed: stats.subtopics_completed || 0,
        quizzes_passed: stats.quizzes_passed || 0,
        flashcards_reviewed: stats.flashcards_reviewed || 0,
        enrolled_courses: enrolledSnap.size,
        quiz_accuracy_rate: safeRate(quizCorrect, quizTotal),
        flashcard_retention_rate: safeRate(flashSuccess, flashTotal),
      },
    });
  } catch (err) {
    console.error("getAnalyticsSummary error:", err);
    return res.status(500).json({ error: "Failed to fetch analytics summary" });
  }
};

export const getCourseAnalytics = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { courseId } = req.params;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const courseDoc = await coursesRef.doc(courseId).get();
    if (!courseDoc.exists) return res.status(404).json({ error: "Course not found" });

    const unitsSnap = await coursesRef.doc(courseId).collection("units").get();
    const subtopicIds = [];

    for (const unitDoc of unitsSnap.docs) {
      const subsSnap = await unitDoc.ref.collection("subtopics").get();
      subsSnap.docs.forEach((doc) => subtopicIds.push(doc.id));
    }

    let completedCount = 0;
    for (const subtopicId of subtopicIds) {
      const [manualDoc, interactiveDoc] = await Promise.all([
        db.collection("user_progress").doc(`${userId}_${subtopicId}`).get(),
        db.collection("user_subtopic_progress").doc(`${userId}_${subtopicId}`).get(),
      ]);

      if (manualDoc.exists || (interactiveDoc.exists && interactiveDoc.data().is_completed)) {
        completedCount++;
      }
    }

    const attemptsSnap = await userQuestionAttemptsRef
      .where("user_id", "==", userId)
      .where("course_id", "==", courseId)
      .get();

    const attemptsTotal = attemptsSnap.size;
    const attemptsCorrect = attemptsSnap.docs.filter((doc) => doc.data().is_correct).length;

    return res.json({
      course: {
        id: courseId,
        title: courseDoc.data().title,
      },
      progress: {
        total_subtopics: subtopicIds.length,
        completed_subtopics: completedCount,
        completion_rate: safeRate(completedCount, subtopicIds.length),
      },
      quiz: {
        attempts: attemptsTotal,
        correct: attemptsCorrect,
        accuracy_rate: safeRate(attemptsCorrect, attemptsTotal),
      },
    });
  } catch (err) {
    console.error("getCourseAnalytics error:", err);
    return res.status(500).json({ error: "Failed to fetch course analytics" });
  }
};

export const getWeeklyAnalytics = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 6);

    const activitySnap = await userActivityRef
      .where("user_id", "==", userId)
      .where("created_at", ">=", fromDate)
      .get();

    const byDay = {};
    for (const doc of activitySnap.docs) {
      const data = doc.data();
      const key = data.date_key || new Date(data.created_at?.toDate?.() || data.created_at).toISOString().slice(0, 10);

      if (!byDay[key]) {
        byDay[key] = {
          date: key,
          total_activities: 0,
          quiz_attempts: 0,
          flashcard_reviews: 0,
          completions: 0,
        };
      }

      byDay[key].total_activities += 1;
      if (data.activity_type === "quiz_attempt") byDay[key].quiz_attempts += 1;
      if (data.activity_type === "flashcard_review") byDay[key].flashcard_reviews += 1;
      if (data.activity_type === "subtopic_complete") byDay[key].completions += 1;
    }

    const weekly = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
    return res.json({ weekly });
  } catch (err) {
    console.error("getWeeklyAnalytics error:", err);
    return res.status(500).json({ error: "Failed to fetch weekly analytics" });
  }
};
