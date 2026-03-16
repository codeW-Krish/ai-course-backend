import { db } from "../db/firebase.js";
import { getLLMProvider } from "../providers/LLMProviders.js";
import {
    INTERACTIVE_SUBTOPIC_PROMPT,
    SUBTOPIC_CHAT_PROMPT,
    COURSE_CHAT_PROMPT,
    COURSE_PRACTICE_PROMPT,
    CONTENT_ONLY_PROMPT,
    QUIZ_ONLY_PROMPT,
} from "../prompts/interactivePrompts.js";
import { InteractiveContentSchema, ContentOnlySchema, QuizOnlySchema } from "../llm/interactiveSchemas.js";
import {
    grantXpOnce,
    recordQuestionAttempt,
} from "../service/gamificationService.js";
import { z } from "zod";
import { serializeTimestamps } from "../utils/firestoreSerializer.js";

const coursesRef = db.collection("courses");
const courseChatSessionsRef = db.collection("course_chat_sessions");
const hubActivityRef = db.collection("hub_activity");

function sanitizeText(value, fallback = "") {
    if (typeof value !== "string") return fallback;
    return value.trim();
}

async function buildCourseContext(courseId, maxSubtopics = 25) {
    const courseDoc = await coursesRef.doc(courseId).get();
    if (!courseDoc.exists) {
        throw new Error("Course not found");
    }

    const course = { id: courseDoc.id, ...courseDoc.data() };
    const unitsSnap = await coursesRef.doc(courseId).collection("units").orderBy("position").get();

    const unitContexts = [];
    let includedSubtopics = 0;

    for (const unitDoc of unitsSnap.docs) {
        const unit = unitDoc.data();
        const subsSnap = await unitDoc.ref.collection("subtopics").orderBy("position").get();

        const subtopics = [];
        for (const subDoc of subsSnap.docs) {
            if (includedSubtopics >= maxSubtopics) break;

            const subtopic = subDoc.data();
            const contentRaw = typeof subtopic.content === "string"
                ? subtopic.content
                : subtopic.content
                    ? JSON.stringify(subtopic.content)
                    : "";

            const snippet = contentRaw.length > 260 ? `${contentRaw.slice(0, 260)}...` : contentRaw;
            subtopics.push({
                title: subtopic.title || "Untitled Subtopic",
                content_snippet: snippet || "(content not generated yet)",
            });
            includedSubtopics++;
        }

        unitContexts.push({
            title: unit.title || "Untitled Unit",
            subtopics,
        });

        if (includedSubtopics >= maxSubtopics) break;
    }

    return {
        course,
        contextText: JSON.stringify(unitContexts),
    };
}

async function getOrCreateCourseChatSession({ userId, courseId, sessionId }) {
    if (sessionId) {
        const existing = await courseChatSessionsRef.doc(sessionId).get();
        if (!existing.exists) {
            throw new Error("Session not found");
        }
        const data = existing.data();
        if (data.user_id !== userId || data.course_id !== courseId) {
            throw new Error("Session does not belong to user/course");
        }
        return { id: existing.id, ...data };
    }

    const createdAt = new Date();
    const docRef = await courseChatSessionsRef.add({
        user_id: userId,
        course_id: courseId,
        created_at: createdAt,
        updated_at: createdAt,
    });

    return {
        id: docRef.id,
        user_id: userId,
        course_id: courseId,
        created_at: createdAt,
        updated_at: createdAt,
    };
}

async function getRecentConversationHistory(sessionId, maxMessages = 12) {
    const snap = await courseChatSessionsRef
        .doc(sessionId)
        .collection("messages")
        .orderBy("created_at", "desc")
        .limit(maxMessages)
        .get();

    const chronological = snap.docs
        .map((d) => d.data())
        .reverse();

    return chronological
        .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
        .join("\n");
}

// --- Generic retry wrapper for LLM calls ---
async function withRetry(fn, maxAttempts = 3, label = "LLM call") {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            console.warn(`${label} attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
            if (attempt < maxAttempts) {
                // Small delay before retry (200ms, 500ms)
                await new Promise(r => setTimeout(r, attempt * 200));
            }
        }
    }
    throw lastError;
}

// --- Helper to normalize LLM output ---
const generateInteractiveContent = async (course, unit, subtopic, provider = "Groq", model) => {
    const llm = getLLMProvider(provider, model);
    const input = {
        course_title: course.title,
        unit_title: unit.title,
        subtopic_title: subtopic.title,
        difficulty: course.difficulty || "Beginner",
    };

    return withRetry(async () => {
        const rawResponse = await llm(INTERACTIVE_SUBTOPIC_PROMPT, input);
        const parsed = InteractiveContentSchema.parse(rawResponse);
        return parsed;
    }, 3, "generateInteractiveContent");
};

// --- Helper: Generate ONLY content (faster, no quiz) ---
const generateContentOnly = async (course, unit, subtopic, provider = "Groq", model) => {
    const llm = getLLMProvider(provider, model);
    const input = {
        course_title: course.title,
        unit_title: unit.title,
        subtopic_title: subtopic.title,
        difficulty: course.difficulty || "Beginner",
    };
    return withRetry(async () => {
        const rawResponse = await llm(CONTENT_ONLY_PROMPT, input);
        const parsed = ContentOnlySchema.parse(rawResponse);
        return parsed.content;
    }, 3, "generateContentOnly");
};

// --- Helper: Generate ONLY quiz questions from existing content ---
const generateQuizOnly = async (course, unit, subtopic, content, provider = "Groq", model) => {
    const llm = getLLMProvider(provider, model);
    const prompt = QUIZ_ONLY_PROMPT
        .replace("{{course_title}}", course.title || "")
        .replace("{{unit_title}}", unit.title || "")
        .replace("{{subtopic_title}}", subtopic.title || "")
        .replace("{{difficulty}}", course.difficulty || "Beginner")
        .replace("{{content}}", typeof content === "object" ? JSON.stringify(content) : content);
    return withRetry(async () => {
        const rawResponse = await llm(prompt, {});
        const parsed = QuizOnlySchema.parse(rawResponse);
        return parsed.questions;
    }, 3, "generateQuizOnly");
};

// --- Helper: Normalize and save questions to Firestore ---
async function saveQuestions(subtopicId, questions) {
    const questionsRef = db.collection("subtopic_questions");
    for (const [idx, q] of questions.entries()) {
        const qId = `${subtopicId}_${idx + 1}`;
        let correctAnswer = q.correct_answer;
        if (q.question_type === "mcq" && q.options && q.options.length > 0) {
            const letterIndex = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };
            const upper = (correctAnswer || "").trim().toUpperCase();
            if (upper in letterIndex && letterIndex[upper] < q.options.length) {
                correctAnswer = q.options[letterIndex[upper]];
            }
        }
        await questionsRef.doc(qId).set({
            subtopic_id: subtopicId,
            question_type: q.question_type,
            question_text: q.question_text,
            options: q.options || [],
            correct_answer: correctAnswer,
            hint: q.hint || "",
            explanation: q.explanation || "",
            position: idx + 1,
        });
    }
}

/**
 * Find a subtopic by ID, optionally within a known course.
 * Returns { subtopicDoc, unitDoc, courseDoc, courseId, unitId } for context.
 *
 * If courseId is provided, searches only within that course (fast direct lookup).
 * Otherwise, uses collectionGroup to search across all courses.
 */
async function findSubtopicById(subtopicId, courseId = null) {
    // --- Fast path: courseId is known, search only within that course ---
    if (courseId) {
        const unitsSnap = await coursesRef.doc(courseId).collection("units").get();
        for (const unitDoc of unitsSnap.docs) {
            const subDoc = await unitDoc.ref.collection("subtopics").doc(subtopicId).get();
            if (subDoc.exists) {
                const courseDoc = await coursesRef.doc(courseId).get();
                return { subtopicDoc: subDoc, unitDoc, courseDoc, courseId, unitId: unitDoc.id };
            }
        }
        return null;
    }

    // --- Slow path: courseId unknown, scan collectionGroup ---
    // NOTE: We cannot filter collectionGroup by __name__ with just a doc ID;
    // Firestore requires a full document path for that filter.
    // Instead, fetch all subtopic docs and filter by doc.id in memory.
    const allSubtopics = await db.collectionGroup("subtopics").get();

    for (const subDoc of allSubtopics.docs) {
        if (subDoc.id === subtopicId) {
            // Extract path segments: courses/{courseId}/units/{unitId}/subtopics/{subtopicId}
            const pathSegments = subDoc.ref.path.split("/");
            const cId = pathSegments[1];
            const uId = pathSegments[3];

            const courseDoc = await coursesRef.doc(cId).get();
            const unitDoc = await coursesRef.doc(cId).collection("units").doc(uId).get();

            return { subtopicDoc: subDoc, unitDoc, courseDoc, courseId: cId, unitId: uId };
        }
    }

    return null;
}

// --- REUSEABLE HELPER ---
const getOrGenerateSession = async (subtopicId, user, provider = "Groq", model, courseIdHint = null) => {
    // 1. Find subtopic with context (pass courseId hint for fast lookup)
    const found = await findSubtopicById(subtopicId, courseIdHint);
    if (!found) throw new Error("Subtopic not found");

    const { subtopicDoc, unitDoc, courseDoc, courseId, unitId } = found;
    const subtopicData = subtopicDoc.data();
    const unitData = unitDoc.data();
    const courseData = courseDoc.data();

    // 2. Check if questions exist
    const questionsRef = db.collection("subtopic_questions");
    const existingQSnap = await questionsRef.where("subtopic_id", "==", subtopicId).get();
    const existingQCount = existingQSnap.size;

    // 3. If content missing OR questions missing, GENERATE IT
    if (!subtopicData.content || existingQCount === 0) {
        console.log(`Generating interactive content for: ${subtopicData.title}`);
        const generated = await generateInteractiveContent(
            { title: courseData.title, difficulty: courseData.difficulty },
            { title: unitData.title },
            { title: subtopicData.title },
            provider,
            model
        );

        // Save content
        await subtopicDoc.ref.update({ content: generated.content });

        // Save questions
        for (const [idx, q] of generated.questions.entries()) {
            const qId = `${subtopicId}_${idx + 1}`;
            // Normalize letter-based correct_answer (A/B/C/D) to actual option text for MCQs
            let correctAnswer = q.correct_answer;
            if (q.question_type === "mcq" && q.options && q.options.length > 0) {
                const letterIndex = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };
                const upper = (correctAnswer || "").trim().toUpperCase();
                if (upper in letterIndex && letterIndex[upper] < q.options.length) {
                    correctAnswer = q.options[letterIndex[upper]];
                }
            }
            await questionsRef.doc(qId).set({
                subtopic_id: subtopicId,
                question_type: q.question_type,
                question_text: q.question_text,
                options: q.options || [],
                correct_answer: correctAnswer,
                hint: q.hint,
                position: idx + 1,
            });
        }

        subtopicData.content = generated.content;
    }

    // 4. Fetch questions
    const qSnap = await questionsRef
        .where("subtopic_id", "==", subtopicId)
        .orderBy("position")
        .get();

    const questions = qSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // 5. Get/Init User Progress
    const progressId = `${user.id}_${subtopicId}`;
    const progressRef = db.collection("user_subtopic_progress").doc(progressId);
    let progressDoc = await progressRef.get();

    if (!progressDoc.exists) {
        const newProgress = {
            user_id: user.id,
            subtopic_id: subtopicId,
            hearts_remaining: 3,
            attempts: 0,
            is_completed: false,
            completed_at: null,
        };
        await progressRef.set(newProgress);
        progressDoc = await progressRef.get();
    }

    const progress = { id: progressDoc.id, ...progressDoc.data() };

    return {
        subtopic: {
            id: subtopicId,
            title: subtopicData.title,
            content: subtopicData.content,
            course_id: courseId,
        },
        questions,
        progress,
    };
};

// --- 1. Start/Resume Session (By ID) ---
export const startSession = async (req, res) => {
    const { subtopicId } = req.params;
    const user = req.user;
    const provider = req.query.provider || "Groq";
    const model = req.query.model;

    try {
        const data = await getOrGenerateSession(subtopicId, user, provider, model);

        res.json({
            subtopic: data.subtopic,
            questions: data.questions.map((q) => ({
                id: q.id,
                question_text: q.question_text,
                options: typeof q.options === "string" ? JSON.parse(q.options) : q.options,
                hint: q.hint,
                type: q.question_type,
            })),
            hearts_remaining: data.progress.hearts_remaining,
            attempts: data.progress.attempts,
            is_completed: data.progress.is_completed,
        });
    } catch (err) {
        console.error("startSession error:", err);
        if (err.message === "Subtopic not found") return res.status(404).json({ error: "Subtopic not found" });
        res.status(500).json({ error: "Failed to start session" });
    }
};

// --- 2. Verify Answer ---
export const verifyAnswer = async (req, res) => {
    const { subtopicId } = req.params;
    const { questionId, answer } = req.body;
    const userId = req.user.id;

    try {
        // 1. Get correct answer
        const qDoc = await db.collection("subtopic_questions").doc(questionId).get();
        if (!qDoc.exists || qDoc.data().subtopic_id !== subtopicId) {
            return res.status(404).json({ error: "Question not found" });
        }

        const question = qDoc.data();
        // Direct text comparison
        let isCorrect = question.correct_answer.toLowerCase().trim() === answer.toLowerCase().trim();
        // Fallback: if correct_answer is still a letter index (A/B/C/D), resolve it to option text
        if (!isCorrect && question.options && question.options.length > 0) {
            const letterIndex = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };
            const upper = (question.correct_answer || "").trim().toUpperCase();
            if (upper in letterIndex && letterIndex[upper] < question.options.length) {
                const resolvedAnswer = question.options[letterIndex[upper]];
                isCorrect = resolvedAnswer.toLowerCase().trim() === answer.toLowerCase().trim();
            }
        }

        const subtopicContext = await findSubtopicById(subtopicId);
        const courseId = subtopicContext?.courseId || null;

        // 2. Update Progress atomically
        const progressId = `${userId}_${subtopicId}`;
        const progressRef = db.collection("user_subtopic_progress").doc(progressId);

        const result = await db.runTransaction(async (t) => {
            let progressDoc = await t.get(progressRef);

            if (!progressDoc.exists) {
                t.set(progressRef, {
                    user_id: userId,
                    subtopic_id: subtopicId,
                    hearts_remaining: 3,
                    attempts: 0,
                    is_completed: false,
                    completed_at: null,
                });
                progressDoc = await t.get(progressRef);
            }

            const progress = progressDoc.data();
            const wasCompleted = !!progress.is_completed;
            const updates = { attempts: (progress.attempts || 0) + 1 };

            if (!isCorrect) {
                updates.hearts_remaining = Math.max((progress.hearts_remaining || 0) - 1, 0);
            } else {
                updates.hearts_remaining = progress.hearts_remaining;

                // Check if this is the last question (by position)
                const allQSnap = await db
                    .collection("subtopic_questions")
                    .where("subtopic_id", "==", subtopicId)
                    .get();

                let maxPos = 0;
                allQSnap.docs.forEach((d) => {
                    if (d.data().position > maxPos) maxPos = d.data().position;
                });

                if (question.position >= maxPos) {
                    updates.is_completed = true;
                    updates.completed_at = new Date();
                }
            }

            t.update(progressRef, updates);

            return {
                hearts_remaining: updates.hearts_remaining ?? progress.hearts_remaining,
                is_completed: updates.is_completed ?? progress.is_completed ?? false,
                newly_completed: !wasCompleted && !!updates.is_completed,
            };
        });

        await recordQuestionAttempt(userId, {
            question_id: questionId,
            subtopic_id: subtopicId,
            course_id: courseId,
            is_correct: isCorrect,
        });

        if (result.newly_completed) {
            await grantXpOnce(userId, `subtopic_complete_${subtopicId}`, 50, {
                activityType: "subtopic_complete",
                metadata: { subtopic_id: subtopicId, course_id: courseId },
                statIncrements: {
                    subtopics_completed: 1,
                    quizzes_passed: 1,
                },
            });

            if (result.hearts_remaining === 3) {
                await grantXpOnce(userId, `perfect_quiz_${subtopicId}`, 100, {
                    activityType: "perfect_quiz",
                    metadata: { subtopic_id: subtopicId, course_id: courseId },
                    statIncrements: {
                        perfect_quizzes: 1,
                    },
                });
            }
        }

        // Resolve letter-based correct_answer for display
        let displayCorrectAnswer = question.correct_answer;
        if (question.options && question.options.length > 0) {
            const letterIdx = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };
            const upperCA = (displayCorrectAnswer || "").trim().toUpperCase();
            if (upperCA in letterIdx && letterIdx[upperCA] < question.options.length) {
                displayCorrectAnswer = question.options[letterIdx[upperCA]];
            }
        }

        res.json({
            correct: isCorrect,
            correct_answer: isCorrect ? null : displayCorrectAnswer,
            hint: !isCorrect ? question.hint : null,
            hearts_remaining: result.hearts_remaining,
            result: isCorrect ? "Correct!" : "Incorrect",
            game_over: result.hearts_remaining === 0,
            is_subtopic_completed: result.is_completed,
        });
    } catch (err) {
        console.error("verifyAnswer error:", err);
        res.status(500).json({ error: "Verification failed" });
    }
};

// --- 3. Chat with AI ---
export const chatWithAI = async (req, res) => {
    const { subtopicId } = req.params;
    const { message } = req.body;
    const userId = req.user.id;
    const provider = req.body.provider || "Groq";

    try {
        // 1. Find subtopic context
        const found = await findSubtopicById(subtopicId);
        if (!found) return res.status(404).json({ error: "Subtopic not found" });

        const { subtopicDoc, unitDoc, courseDoc } = found;
        const context = {
            content: subtopicDoc.data().content,
            title: subtopicDoc.data().title,
            unit_title: unitDoc.data().title,
            course_title: courseDoc.data().title,
        };

        // 2. LLM Call
        const llm = getLLMProvider(provider);
        const prompt = SUBTOPIC_CHAT_PROMPT
            .replace("{{course_title}}", context.course_title)
            .replace("{{unit_title}}", context.unit_title)
            .replace("{{subtopic_title}}", context.title)
            .replace("{{content}}", typeof context.content === "object" ? JSON.stringify(context.content) : context.content)
            .replace("{{user_message}}", message);

        const rawResponse = await llm(prompt, {});

        let aiResponse = "";
        if (rawResponse && rawResponse.ai_response) {
            aiResponse = rawResponse.ai_response;
        } else {
            aiResponse = typeof rawResponse === "string" ? rawResponse : JSON.stringify(rawResponse);
        }

        // 3. Log interaction
        await db.collection("subtopic_chat").doc().set({
            user_id: userId,
            subtopic_id: subtopicId,
            user_message: message,
            ai_response: aiResponse,
            created_at: new Date(),
        });

        res.json({ ai_response: aiResponse });
    } catch (err) {
        console.error("Chat Error:", err);
        res.status(500).json({ error: "Chat failed" });
    }
};

// --- 4. Get Next Uncompleted Subtopic for a Course ---
export const getNextSubtopic = async (req, res) => {
    const { courseId } = req.params;
    const user = req.user;
    const provider = req.query.provider || "Groq";
    const model = req.query.model;

    try {
        // 1. Get all subtopics in order
        const unitsSnap = await coursesRef.doc(courseId).collection("units").orderBy("position").get();

        const allSubtopics = [];
        for (const unitDoc of unitsSnap.docs) {
            const subsSnap = await unitDoc.ref.collection("subtopics").orderBy("position").get();
            for (const subDoc of subsSnap.docs) {
                allSubtopics.push({
                    id: subDoc.id,
                    title: subDoc.data().title,
                    unit_position: unitDoc.data().position,
                    subtopic_position: subDoc.data().position,
                });
            }
        }

        // 2. Find first uncompleted
        let nextSubtopicId = null;
        for (const sub of allSubtopics) {
            const progressId = `${user.id}_${sub.id}`;
            const progressDoc = await db.collection("user_subtopic_progress").doc(progressId).get();
            if (!progressDoc.exists || !progressDoc.data().is_completed) {
                nextSubtopicId = sub.id;
                break;
            }
        }

        // 3. If all completed, course is done
        if (!nextSubtopicId) {
            return res.json({
                course_completed: true,
                message: "Congratulations! You've completed this course.",
            });
        }

        // 4. Get/generate session (pass courseId for fast lookup)
        const data = await getOrGenerateSession(nextSubtopicId, user, provider, model, courseId);

        res.json({
            subtopic: data.subtopic,
            questions: data.questions.map((q) => ({
                id: q.id,
                question_text: q.question_text,
                options: typeof q.options === "string" ? JSON.parse(q.options) : q.options,
                hint: q.hint,
                type: q.question_type,
            })),
            hearts_remaining: data.progress.hearts_remaining,
            attempts: data.progress.attempts,
            is_completed: data.progress.is_completed,
            course_completed: false,
        });
    } catch (err) {
        console.error("getNextSubtopic error:", err);
        res.status(500).json({ error: "Failed to get next subtopic" });
    }
};

// --- 5. Course-level Study Buddy Chat with Memory ---
export const chatWithCourseAI = async (req, res) => {
    const { courseId } = req.params;
    const userId = req.user?.id;
    const message = sanitizeText(req.body?.message);
    const provider = req.body?.provider || "Groq";
    const model = req.body?.model;
    const sessionId = sanitizeText(req.body?.session_id, "");

    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!message) return res.status(400).json({ error: "Message is required" });

    try {
        const { course, contextText } = await buildCourseContext(courseId);
        const session = await getOrCreateCourseChatSession({
            userId,
            courseId,
            sessionId: sessionId || null,
        });

        const history = await getRecentConversationHistory(session.id);
        const llm = getLLMProvider(provider, model);

        const prompt = COURSE_CHAT_PROMPT
            .replace("{{course_title}}", course.title || "Untitled Course")
            .replace("{{difficulty}}", course.difficulty || "Beginner")
            .replace("{{course_description}}", course.description || "")
            .replace("{{course_context}}", contextText)
            .replace("{{conversation_history}}", history || "(no prior messages)")
            .replace("{{user_message}}", message);

        const rawResponse = await llm(prompt, {});
        const aiResponse = rawResponse?.ai_response
            ? sanitizeText(rawResponse.ai_response)
            : sanitizeText(typeof rawResponse === "string" ? rawResponse : JSON.stringify(rawResponse));

        if (!aiResponse) {
            return res.status(502).json({ error: "AI returned an empty response" });
        }

        const now = new Date();
        const msgRef = courseChatSessionsRef.doc(session.id).collection("messages");
        await msgRef.add({ role: "user", content: message, created_at: now });
        await msgRef.add({ role: "assistant", content: aiResponse, created_at: new Date(now.getTime() + 1) });

        await courseChatSessionsRef.doc(session.id).update({
            updated_at: new Date(),
            last_provider: provider,
            last_model: model || null,
        });

        return res.json({
            session_id: session.id,
            ai_response: aiResponse,
            provider,
        });
    } catch (err) {
        console.error("chatWithCourseAI error:", err);
        if (err.message === "Course not found") return res.status(404).json({ error: "Course not found" });
        if (err.message === "Session not found") return res.status(404).json({ error: "Session not found" });
        if (err.message === "Session does not belong to user/course") return res.status(403).json({ error: "Invalid session" });
        return res.status(500).json({ error: "Course chat failed" });
    }
};

// --- 6. Generate Course-level Practice Questions ---
export const generateCoursePractice = async (req, res) => {
    const { courseId } = req.params;
    const userId = req.user?.id;
    const focus = sanitizeText(req.body?.focus, "general revision");
    const provider = req.body?.provider || "Groq";
    const model = req.body?.model;

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    try {
        const { course, contextText } = await buildCourseContext(courseId);
        const llm = getLLMProvider(provider, model);

        const prompt = COURSE_PRACTICE_PROMPT
            .replace("{{course_title}}", course.title || "Untitled Course")
            .replace("{{difficulty}}", course.difficulty || "Beginner")
            .replace("{{course_description}}", course.description || "")
            .replace("{{focus}}", focus)
            .replace("{{course_context}}", contextText);

        const rawResponse = await llm(prompt, {});
        const questions = Array.isArray(rawResponse?.questions) ? rawResponse.questions : [];

        if (questions.length === 0) {
            return res.status(502).json({ error: "Failed to generate practice questions" });
        }

        const normalized = questions.slice(0, 5).map((q) => ({
            question: sanitizeText(q?.question, ""),
            answer: sanitizeText(q?.answer, ""),
            explanation: sanitizeText(q?.explanation, ""),
            type: sanitizeText(q?.type, "concept") || "concept",
        })).filter((q) => q.question && q.answer);

        if (normalized.length === 0) {
            return res.status(502).json({ error: "Invalid practice format from AI" });
        }

        return res.json({
            course_id: courseId,
            focus,
            provider,
            questions: normalized,
        });
    } catch (err) {
        console.error("generateCoursePractice error:", err);
        if (err.message === "Course not found") return res.status(404).json({ error: "Course not found" });
        return res.status(500).json({ error: "Practice generation failed" });
    }
};

// =====================================================================
// === NEW: Content-First Interactive Flow =============================
// =====================================================================

/**
 * 7. Get Content for Next Uncompleted Subtopic (content only, quiz generated in bg)
 * GET /api/interactive/course/:courseId/next-content
 *
 * Returns subtopic content for reading. Triggers background quiz generation.
 */
export const getNextContent = async (req, res) => {
    const { courseId } = req.params;
    const user = req.user;
    const provider = req.query.provider || "Groq";
    const model = req.query.model;

    try {
        // 1. Get all subtopics in order
        const unitsSnap = await coursesRef.doc(courseId).collection("units").orderBy("position").get();

        const allSubtopics = [];
        for (const unitDoc of unitsSnap.docs) {
            const subsSnap = await unitDoc.ref.collection("subtopics").orderBy("position").get();
            for (const subDoc of subsSnap.docs) {
                allSubtopics.push({
                    id: subDoc.id,
                    ref: subDoc.ref,
                    data: subDoc.data(),
                    unitDoc,
                    unit_position: unitDoc.data().position,
                    subtopic_position: subDoc.data().position,
                });
            }
        }

        // 2. Find first uncompleted
        let nextSub = null;
        for (const sub of allSubtopics) {
            const progressId = `${user.id}_${sub.id}`;
            const progressDoc = await db.collection("user_subtopic_progress").doc(progressId).get();
            if (!progressDoc.exists || !progressDoc.data().is_completed) {
                nextSub = sub;
                break;
            }
        }

        // 3. If all completed, course is done
        if (!nextSub) {
            return res.json({
                course_completed: true,
                message: "Congratulations! You've completed this course.",
            });
        }

        const subtopicId = nextSub.id;
        const subtopicData = nextSub.data;
        const unitData = nextSub.unitDoc.data();
        const courseDoc = await coursesRef.doc(courseId).get();
        const courseData = courseDoc.data();

        // 4. Generate content if missing
        let content = subtopicData.content;
        if (!content) {
            console.log(`Generating content for: ${subtopicData.title}`);
            content = await generateContentOnly(
                { title: courseData.title, difficulty: courseData.difficulty },
                { title: unitData.title },
                { title: subtopicData.title },
                provider, model
            );
            await nextSub.ref.update({ content });
        }

        // 5. Check if questions already exist
        const questionsRef = db.collection("subtopic_questions");
        const existingQSnap = await questionsRef.where("subtopic_id", "==", subtopicId).get();
        const questionsReady = existingQSnap.size > 0;

        // 6. If questions not ready, trigger background generation (fire and forget)
        if (!questionsReady) {
            (async () => {
                try {
                    console.log(`Background quiz generation for: ${subtopicData.title}`);
                    const questions = await generateQuizOnly(
                        { title: courseData.title, difficulty: courseData.difficulty },
                        { title: unitData.title },
                        { title: subtopicData.title },
                        content, provider, model
                    );
                    await saveQuestions(subtopicId, questions);
                    console.log(`Background quiz generation complete for: ${subtopicData.title}`);
                } catch (err) {
                    console.error("Background quiz generation failed:", err);
                }
            })();
        }

        // 7. Get/Init User Progress
        const progressId = `${user.id}_${subtopicId}`;
        const progressRef = db.collection("user_subtopic_progress").doc(progressId);
        let progressDoc = await progressRef.get();
        if (!progressDoc.exists) {
            await progressRef.set({
                user_id: user.id,
                subtopic_id: subtopicId,
                hearts_remaining: 3,
                attempts: 0,
                is_completed: false,
                completed_at: null,
            });
            progressDoc = await progressRef.get();
        }
        const progress = progressDoc.data();

        // 8. Compute total/completed subtopics for progress tracking
        let completedCount = 0;
        for (const sub of allSubtopics) {
            const pId = `${user.id}_${sub.id}`;
            const pDoc = await db.collection("user_subtopic_progress").doc(pId).get();
            if (pDoc.exists && pDoc.data().is_completed) completedCount++;
        }

        res.json({
            course_completed: false,
            subtopic: {
                id: subtopicId,
                title: subtopicData.title,
                content: content,
                course_id: courseId,
            },
            questions_ready: questionsReady,
            hearts_remaining: progress.hearts_remaining,
            attempts: progress.attempts,
            is_completed: progress.is_completed,
            course_progress: {
                completed: completedCount,
                total: allSubtopics.length,
            },
        });
    } catch (err) {
        console.error("getNextContent error:", err);
        res.status(500).json({ error: "Failed to get next content" });
    }
};

/**
 * 8. Get Quiz Questions (with correct answers for client-side checking)
 * GET /api/interactive/:subtopicId/quiz
 *
 * Returns questions including correct_answer + explanation.
 * If questions aren't generated yet, generates them on-the-fly.
 */
export const getQuiz = async (req, res) => {
    const { subtopicId } = req.params;
    const user = req.user;
    const provider = req.query.provider || "Groq";
    const model = req.query.model;

    try {
        const questionsRef = db.collection("subtopic_questions");
        let qSnap = await questionsRef
            .where("subtopic_id", "==", subtopicId)
            .orderBy("position")
            .get();

        // If not generated yet, generate now
        if (qSnap.empty) {
            const found = await findSubtopicById(subtopicId);
            if (!found) return res.status(404).json({ error: "Subtopic not found" });

            const { subtopicDoc, unitDoc, courseDoc } = found;
            const subtopicData = subtopicDoc.data();
            const courseData = courseDoc.data();
            const unitData = unitDoc.data();

            // Need content to generate quiz
            let content = subtopicData.content;
            if (!content) {
                content = await generateContentOnly(
                    { title: courseData.title, difficulty: courseData.difficulty },
                    { title: unitData.title },
                    { title: subtopicData.title },
                    provider, model
                );
                await subtopicDoc.ref.update({ content });
            }

            const questions = await generateQuizOnly(
                { title: courseData.title, difficulty: courseData.difficulty },
                { title: unitData.title },
                { title: subtopicData.title },
                content, provider, model
            );
            await saveQuestions(subtopicId, questions);

            // Re-fetch
            qSnap = await questionsRef
                .where("subtopic_id", "==", subtopicId)
                .orderBy("position")
                .get();
        }

        // Get progress
        const progressId = `${user.id}_${subtopicId}`;
        const progressRef = db.collection("user_subtopic_progress").doc(progressId);
        let progressDoc = await progressRef.get();
        if (!progressDoc.exists) {
            await progressRef.set({
                user_id: user.id,
                subtopic_id: subtopicId,
                hearts_remaining: 3,
                attempts: 0,
                is_completed: false,
                completed_at: null,
            });
            progressDoc = await progressRef.get();
        }

        const questions = qSnap.docs.map((d) => {
            const q = d.data();
            return {
                id: d.id,
                question_text: q.question_text,
                question_type: q.question_type,
                options: typeof q.options === "string" ? JSON.parse(q.options) : q.options,
                correct_answer: q.correct_answer,
                hint: q.hint || "",
                explanation: q.explanation || "",
                position: q.position,
            };
        });

        res.json({
            subtopic_id: subtopicId,
            questions,
            hearts_remaining: progressDoc.data().hearts_remaining,
            is_completed: progressDoc.data().is_completed,
        });
    } catch (err) {
        console.error("getQuiz error:", err);
        res.status(500).json({ error: "Failed to get quiz" });
    }
};

/**
 * 9. Submit Quiz Results (bulk)
 * POST /api/interactive/:subtopicId/submit-quiz
 *
 * Accepts all answers at once, updates progress, grants XP.
 * Body: { answers: [{ question_id, user_answer, is_correct }] }
 */
export const submitQuiz = async (req, res) => {
    const { subtopicId } = req.params;
    const userId = req.user.id;
    const { answers } = req.body;

    if (!Array.isArray(answers) || answers.length === 0) {
        return res.status(400).json({ error: "answers array is required" });
    }

    try {
        const found = await findSubtopicById(subtopicId);
        const courseId = found?.courseId || null;

        const totalQuestions = answers.length;
        const correctCount = answers.filter((a) => a.is_correct).length;
        const wrongCount = totalQuestions - correctCount;

        // Update progress
        const progressId = `${userId}_${subtopicId}`;
        const progressRef = db.collection("user_subtopic_progress").doc(progressId);

        const heartsLost = Math.min(wrongCount, 3);
        const heartsRemaining = Math.max(3 - heartsLost, 0);
        const isCompleted = heartsRemaining > 0; // Passed if still has hearts
        const isPerfect = correctCount === totalQuestions;

        await progressRef.set({
            user_id: userId,
            subtopic_id: subtopicId,
            hearts_remaining: heartsRemaining,
            attempts: (await progressRef.get()).exists
                ? ((await progressRef.get()).data().attempts || 0) + 1
                : 1,
            is_completed: isCompleted,
            completed_at: isCompleted ? new Date() : null,
            last_score: { correct: correctCount, total: totalQuestions },
        }, { merge: true });

        // Record each question attempt for analytics
        for (const ans of answers) {
            await recordQuestionAttempt(userId, {
                question_id: ans.question_id,
                subtopic_id: subtopicId,
                course_id: courseId,
                is_correct: ans.is_correct,
            });
        }

        // Grant XP if completed
        if (isCompleted) {
            await grantXpOnce(userId, `subtopic_complete_${subtopicId}`, 50, {
                activityType: "subtopic_complete",
                metadata: { subtopic_id: subtopicId, course_id: courseId },
                statIncrements: {
                    subtopics_completed: 1,
                    quizzes_passed: 1,
                },
            });

            if (isPerfect) {
                await grantXpOnce(userId, `perfect_quiz_${subtopicId}`, 100, {
                    activityType: "perfect_quiz",
                    metadata: { subtopic_id: subtopicId, course_id: courseId },
                    statIncrements: {
                        perfect_quizzes: 1,
                    },
                });
            }
        }

        res.json({
            subtopic_id: subtopicId,
            total_questions: totalQuestions,
            correct_count: correctCount,
            wrong_count: wrongCount,
            hearts_remaining: heartsRemaining,
            is_completed: isCompleted,
            is_perfect: isPerfect,
            xp_earned: isCompleted ? (isPerfect ? 150 : 50) : 0,
        });
    } catch (err) {
        console.error("submitQuiz error:", err);
        res.status(500).json({ error: "Failed to submit quiz results" });
    }
};

// =====================================================================
// === Hub Activity History ============================================
// =====================================================================

/**
 * 10. Log Hub Activity
 * POST /api/hub/log
 * Body: { course_id, subtopic_id?, feature_type, title? }
 */
export const logHubActivity = async (req, res) => {
    const userId = req.user.id;
    const { course_id, subtopic_id, feature_type, title } = req.body;

    if (!course_id || !feature_type) {
        return res.status(400).json({ error: "course_id and feature_type are required" });
    }

    const validTypes = ["flashcards", "notes", "audio", "chat", "course_audio", "practice", "quiz", "content_read"];
    if (!validTypes.includes(feature_type)) {
        return res.status(400).json({ error: `Invalid feature_type. Must be one of: ${validTypes.join(", ")}` });
    }

    try {
        const activity = {
            user_id: userId,
            course_id,
            subtopic_id: subtopic_id || null,
            feature_type,
            title: title || "",
            created_at: new Date(),
        };

        const docRef = await hubActivityRef.add(activity);
        res.json({ id: docRef.id, ...activity });
    } catch (err) {
        console.error("logHubActivity error:", err);
        res.status(500).json({ error: "Failed to log activity" });
    }
};

/**
 * 11. Get Hub Activity History + Generated Content for a Course
 * GET /api/hub/history/:courseId
 * Returns: activities, subtopic_statuses (with generation info), generated_items (browseable list)
 */
export const getHubHistory = async (req, res) => {
    const { courseId } = req.params;
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 50;

    try {
        // --- Activities ---
        const snap = await hubActivityRef
            .where("user_id", "==", userId)
            .where("course_id", "==", courseId)
            .orderBy("created_at", "desc")
            .limit(limit)
            .get();

        const activities = snap.docs.map((d) => ({
            id: d.id,
            ...d.data(),
            created_at: d.data().created_at?.toDate?.() || d.data().created_at,
        }));

        // --- Build subtopic statuses + generated items list ---
        const unitsSnap = await coursesRef.doc(courseId).collection("units").orderBy("position").get();
        const subtopicStatuses = {};
        const generatedItems = []; // flat list of all generated content

        for (const unitDoc of unitsSnap.docs) {
            const unitData = unitDoc.data();
            const subsSnap = await unitDoc.ref.collection("subtopics").orderBy("position").get();

            for (const subDoc of subsSnap.docs) {
                const subData = subDoc.data();
                const subtopicId = subDoc.id;

                // Check what has been generated for this subtopic
                const [flashcardSnap, notesSnap, audioDoc] = await Promise.all([
                    db.collection("flashcards").where("subtopic_id", "==", subtopicId).limit(1).get(),
                    db.collection("generated_notes").where("subtopic_id", "==", subtopicId).limit(1).get(),
                    db.collection("generated_audio").doc(`sub_${subtopicId}`).get(),
                ]);

                const hasFlashcards = !flashcardSnap.empty;
                const hasNotes = !notesSnap.empty;
                const hasAudio = audioDoc.exists;
                const hasContent = !!subData.content;

                // Check for generated video manifest
                const videoDoc = await db.collection("video_manifests").doc(`manifest_${subtopicId}`).get();
                const hasVideo = videoDoc.exists;

                subtopicStatuses[subtopicId] = {
                    title: subData.title,
                    unit_title: unitData.title,
                    has_flashcards: hasFlashcards,
                    has_notes: hasNotes,
                    has_audio: hasAudio,
                    has_content: hasContent,
                    has_video: hasVideo,
                };

                // Add to generated items list (only if something has been generated)
                if (hasFlashcards || hasNotes || hasAudio || hasVideo) {
                    const features = [];
                    if (hasNotes) features.push("notes");
                    if (hasFlashcards) features.push("flashcards");
                    if (hasAudio) {
                        const audioData = audioDoc.data();
                        features.push("audio");
                        generatedItems.push({
                            type: "audio",
                            subtopic_id: subtopicId,
                            subtopic_title: subData.title,
                            unit_title: unitData.title,
                            generated_at: audioData.generated_at?.toDate?.() || audioData.generated_at || null,
                            audio_url: audioData.audio_url || null,
                            estimated_duration: audioData.estimated_duration || 0,
                        });
                    }
                    if (hasNotes) {
                        const noteData = notesSnap.docs[0].data();
                        generatedItems.push({
                            type: "notes",
                            subtopic_id: subtopicId,
                            subtopic_title: subData.title,
                            unit_title: unitData.title,
                            generated_at: noteData.generated_at?.toDate?.() || noteData.generated_at || null,
                        });
                    }
                    if (hasFlashcards) {
                        const fcCount = await db.collection("flashcards").where("subtopic_id", "==", subtopicId).get();
                        generatedItems.push({
                            type: "flashcards",
                            subtopic_id: subtopicId,
                            subtopic_title: subData.title,
                            unit_title: unitData.title,
                            card_count: fcCount.size,
                        });
                    }
                    if (hasVideo) {
                        const videoData = videoDoc.data();
                        generatedItems.push({
                            type: "video",
                            subtopic_id: subtopicId,
                            subtopic_title: subData.title,
                            unit_title: unitData.title,
                            generated_at: videoData.generated_at?.toDate?.() || videoData.generated_at || null,
                            estimated_duration: videoData.total_duration_seconds
                                ? Math.round(videoData.total_duration_seconds)
                                : 0,
                        });
                    }
                }
            }
        }

        // Check for course-level audio
        const courseAudioDoc = await db.collection("generated_audio").doc(`course_${courseId}`).get();
        if (courseAudioDoc.exists) {
            const cAudioData = courseAudioDoc.data();
            generatedItems.unshift({
                type: "course_audio",
                course_id: courseId,
                subtopic_id: null,
                subtopic_title: cAudioData.course_title || "Course Audio",
                unit_title: null,
                generated_at: cAudioData.generated_at?.toDate?.() || cAudioData.generated_at || null,
                audio_url: cAudioData.audio_url || null,
                estimated_duration: cAudioData.estimated_duration || 0,
            });
        }

        res.json(serializeTimestamps({
            course_id: courseId,
            activities,
            subtopic_statuses: subtopicStatuses,
            generated_items: generatedItems,
        }));
    } catch (err) {
        console.error("getHubHistory error:", err);
        res.status(500).json({ error: "Failed to get hub history" });
    }
};
