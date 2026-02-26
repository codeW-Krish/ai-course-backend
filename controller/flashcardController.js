import { db } from "../db/firebase.js";
import { getLLMProvider } from "../providers/LLMProviders.js";
import { FLASHCARD_SYSTEM_PROMPT } from "../prompts/flashcardPrompt.js";
import { FlashcardArraySchema } from "../llm/flashcardSchemas.js";
import { recordFlashcardReviewAndRewards } from "../service/gamificationService.js";
import { serializeTimestamps } from "../utils/firestoreSerializer.js";

const coursesRef = db.collection("courses");
const flashcardsRef = db.collection("flashcards");
const progressRef = db.collection("user_flashcard_progress");

// ============================================================
//  Helper: Find subtopic with context
// ============================================================
async function findSubtopicWithContext(subtopicId) {
    const coursesSnap = await coursesRef.get();

    for (const courseDoc of coursesSnap.docs) {
        const unitsSnap = await courseDoc.ref.collection("units").get();
        for (const unitDoc of unitsSnap.docs) {
            const subDoc = await unitDoc.ref.collection("subtopics").doc(subtopicId).get();
            if (subDoc.exists) {
                return {
                    subtopic: { id: subDoc.id, ...subDoc.data() },
                    unit: { id: unitDoc.id, ...unitDoc.data() },
                    course: { id: courseDoc.id, ...courseDoc.data() },
                };
            }
        }
    }
    return null;
}

// ============================================================
//  GET /api/flashcards/:subtopicId
//  Get or generate flashcards for a subtopic
// ============================================================
export const getFlashcards = async (req, res) => {
    try {
        const { subtopicId } = req.params;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        // Check if flashcards already exist for this subtopic
        const existing = await flashcardsRef
            .where("subtopic_id", "==", subtopicId)
            .orderBy("position")
            .get();

        if (!existing.empty) {
            // Return existing flashcards with user progress
            const flashcards = [];
            for (const doc of existing.docs) {
                const card = { id: doc.id, ...doc.data() };

                // Get user-specific progress
                const progId = `${userId}_${doc.id}`;
                const progDoc = await progressRef.doc(progId).get();
                if (progDoc.exists) {
                    card.progress = progDoc.data();
                } else {
                    card.progress = null;
                }

                flashcards.push(serializeTimestamps(card));
            }

            return res.json({ flashcards, generated: false });
        }

        // Generate flashcards via LLM
        const context = await findSubtopicWithContext(subtopicId);
        if (!context) {
            return res.status(404).json({ error: "Subtopic not found" });
        }

        const { subtopic, unit, course } = context;

        if (!subtopic.content) {
            return res.status(400).json({
                error: "Subtopic content not generated yet. Generate course content first.",
            });
        }

        // Extract text content from the content object
        const contentText =
            typeof subtopic.content === "string"
                ? subtopic.content
                : JSON.stringify(subtopic.content);

        const provider = req.query.provider || "Groq";
        const model = req.query.model || null;
        const llm = getLLMProvider(provider, model);

        // Pass userInputs object — the LLM service concatenates systemPrompt + JSON.stringify(userInputs)
        const userInputs = {
            course_title: course.title,
            unit_title: unit.title,
            subtopic_title: subtopic.title,
            difficulty: course.difficulty || "Beginner",
            content: contentText,
        };

        const llmResponse = await llm(FLASHCARD_SYSTEM_PROMPT, userInputs);

        // LLM returns { flashcards: [...] } — extract the array
        const flashcardArray = llmResponse?.flashcards || llmResponse;
        const parsed = FlashcardArraySchema.safeParse(
            Array.isArray(flashcardArray) ? flashcardArray : []
        );

        if (!parsed.success) {
            console.error("Flashcard schema validation failed:", parsed.error);
            return res.status(500).json({ error: "Failed to generate valid flashcards" });
        }

        // Save flashcards to Firestore
        const flashcards = [];
        for (let i = 0; i < parsed.data.length; i++) {
            const card = parsed.data[i];
            const docRef = await flashcardsRef.add({
                subtopic_id: subtopicId,
                front: card.front,
                back: card.back,
                card_type: card.card_type,
                position: i + 1,
                created_at: new Date(),
            });
            flashcards.push({
                id: docRef.id,
                ...card,
                position: i + 1,
                progress: null,
            });
        }

        return res.status(201).json({ flashcards, generated: true });
    } catch (err) {
        console.error("getFlashcards error:", err);
        return res.status(500).json({ error: "Failed to get flashcards" });
    }
};

// ============================================================
//  POST /api/flashcards/:flashcardId/review
//  Submit review result — SM-2 algorithm update
// ============================================================
export const reviewFlashcard = async (req, res) => {
    try {
        const { flashcardId } = req.params;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        // quality: 0-5, where 0=complete blackout, 5=perfect recall
        const quality = parseInt(req.body.quality, 10);
        if (isNaN(quality) || quality < 0 || quality > 5) {
            return res.status(400).json({ error: "Quality must be 0-5" });
        }

        // Verify flashcard exists
        const cardDoc = await flashcardsRef.doc(flashcardId).get();
        if (!cardDoc.exists) {
            return res.status(404).json({ error: "Flashcard not found" });
        }

        const progId = `${userId}_${flashcardId}`;
        const progDoc = await progressRef.doc(progId).get();

        let easeFactor, interval, repetitions;

        if (progDoc.exists) {
            const prog = progDoc.data();
            easeFactor = prog.ease_factor;
            interval = prog.interval_days;
            repetitions = prog.repetitions;
        } else {
            // Defaults
            easeFactor = 2.5;
            interval = 1;
            repetitions = 0;
        }

        // SM-2 Algorithm
        if (quality >= 3) {
            // Correct recall
            if (repetitions === 0) {
                interval = 1;
            } else if (repetitions === 1) {
                interval = 6;
            } else {
                interval = Math.round(interval * easeFactor);
            }
            repetitions += 1;
        } else {
            // Failed recall — reset
            repetitions = 0;
            interval = 1;
        }

        // Update ease factor (never below 1.3)
        easeFactor = Math.max(
            1.3,
            easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
        );

        const now = new Date();
        const nextReview = new Date(now.getTime() + interval * 24 * 60 * 60 * 1000);

        await progressRef.doc(progId).set({
            user_id: userId,
            flashcard_id: flashcardId,
            ease_factor: easeFactor,
            interval_days: interval,
            repetitions,
            next_review_at: nextReview,
            last_reviewed_at: now,
        });

        await recordFlashcardReviewAndRewards(userId, {
            flashcard_id: flashcardId,
            quality,
        });

        return res.json({
            message: "Review recorded",
            next_review_at: nextReview,
            interval_days: interval,
            ease_factor: easeFactor,
            repetitions,
        });
    } catch (err) {
        console.error("reviewFlashcard error:", err);
        return res.status(500).json({ error: "Failed to record review" });
    }
};

// ============================================================
//  GET /api/flashcards/course/:courseId/due
//  Get all due flashcards for a course
// ============================================================
export const getDueFlashcards = async (req, res) => {
    try {
        const { courseId } = req.params;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        // Get all subtopic IDs for this course
        const unitsSnap = await coursesRef.doc(courseId).collection("units").get();
        const subtopicIds = [];

        for (const unitDoc of unitsSnap.docs) {
            const subsSnap = await unitDoc.ref.collection("subtopics").get();
            for (const subDoc of subsSnap.docs) {
                subtopicIds.push(subDoc.id);
            }
        }

        if (subtopicIds.length === 0) {
            return res.json({ dueCards: [], total: 0 });
        }

        // Get all flashcards for these subtopics
        // Firestore 'in' queries limited to 30, so chunk if needed
        const allFlashcards = [];
        const chunks = [];
        for (let i = 0; i < subtopicIds.length; i += 30) {
            chunks.push(subtopicIds.slice(i, i + 30));
        }

        for (const chunk of chunks) {
            const snap = await flashcardsRef
                .where("subtopic_id", "in", chunk)
                .get();
            snap.docs.forEach((doc) => allFlashcards.push(serializeTimestamps({ id: doc.id, ...doc.data() })));
        }

        if (allFlashcards.length === 0) {
            return res.json({ dueCards: [], total: 0 });
        }

        // Check which are due (or never reviewed)
        const now = new Date();
        const dueCards = [];

        for (const card of allFlashcards) {
            const progId = `${userId}_${card.id}`;
            const progDoc = await progressRef.doc(progId).get();

            if (!progDoc.exists) {
                // Never reviewed — always due
                dueCards.push({ ...card, progress: null });
            } else {
                const prog = serializeTimestamps(progDoc.data());
                const nextReview = new Date(prog.next_review_at);

                if (nextReview <= now) {
                    dueCards.push({ ...card, progress: prog });
                }
            }
        }

        return res.json({ dueCards, total: dueCards.length });
    } catch (err) {
        console.error("getDueFlashcards error:", err);
        return res.status(500).json({ error: "Failed to get due flashcards" });
    }
};
