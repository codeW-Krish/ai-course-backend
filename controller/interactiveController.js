import { db } from "../db/firebase.js";
import { getLLMProvider } from "../providers/LLMProviders.js";
import {
    INTERACTIVE_SUBTOPIC_PROMPT,
    SUBTOPIC_CHAT_PROMPT,
    COURSE_CHAT_PROMPT,
    COURSE_PRACTICE_PROMPT,
} from "../prompts/interactivePrompts.js";
import { InteractiveContentSchema } from "../llm/interactiveSchemas.js";
import {
    grantXpOnce,
    recordQuestionAttempt,
} from "../service/gamificationService.js";
import { z } from "zod";

const coursesRef = db.collection("courses");
const courseChatSessionsRef = db.collection("course_chat_sessions");

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

// --- Helper to normalize LLM output ---
const generateInteractiveContent = async (course, unit, subtopic, provider = "Groq", model) => {
    const llm = getLLMProvider(provider, model);
    const input = {
        course_title: course.title,
        unit_title: unit.title,
        subtopic_title: subtopic.title,
        difficulty: course.difficulty || "Beginner",
    };

    try {
        const rawResponse = await llm(INTERACTIVE_SUBTOPIC_PROMPT, input);
        const parsed = InteractiveContentSchema.parse(rawResponse);
        return parsed;
    } catch (err) {
        console.error("LLM Generation Failed:", err);
        throw new Error("Failed to generate interactive content");
    }
};

/**
 * Find a subtopic by ID across all courses/units.
 * Returns { subtopicDoc, unitDoc, courseDoc } for context.
 * This replaces the SQL JOIN: subtopics → units → courses
 */
async function findSubtopicById(subtopicId) {
    // Search for the subtopic across all courses/units using collectionGroup
    // Path: courses/{courseId}/units/{unitId}/subtopics/{subtopicId}
    const coursesSnap = await coursesRef.get();

    for (const courseDoc of coursesSnap.docs) {
        const unitsSnap = await courseDoc.ref.collection("units").get();
        for (const unitDoc of unitsSnap.docs) {
            const subDoc = await unitDoc.ref.collection("subtopics").doc(subtopicId).get();
            if (subDoc.exists) {
                return {
                    subtopicDoc: subDoc,
                    unitDoc,
                    courseDoc,
                    courseId: courseDoc.id,
                    unitId: unitDoc.id,
                };
            }
        }
    }

    return null;
}

// --- REUSEABLE HELPER ---
const getOrGenerateSession = async (subtopicId, user, provider = "Groq", model) => {
    // 1. Find subtopic with context
    const found = await findSubtopicById(subtopicId);
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
            await questionsRef.doc(qId).set({
                subtopic_id: subtopicId,
                question_type: q.question_type,
                question_text: q.question_text,
                options: q.options || [],
                correct_answer: q.correct_answer,
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
        const isCorrect = question.correct_answer.toLowerCase().trim() === answer.toLowerCase().trim();

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

        res.json({
            correct: isCorrect,
            correct_answer: isCorrect ? null : question.correct_answer,
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

        // 4. Get/generate session
        const data = await getOrGenerateSession(nextSubtopicId, user, provider, model);

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
