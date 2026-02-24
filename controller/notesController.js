import { db } from "../db/firebase.js";
import { getLLMProvider } from "../providers/LLMProviders.js";
import { NOTES_SYSTEM_PROMPT } from "../prompts/notesPrompt.js";
import { GeneratedNotesSchema } from "../llm/notesSchemas.js";

const coursesRef = db.collection("courses");
const notesRef = db.collection("generated_notes");

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
//  GET /api/notes/:subtopicId/generated
//  Get or generate AI notes for a subtopic
// ============================================================
export const getGeneratedNotes = async (req, res) => {
    try {
        const { subtopicId } = req.params;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        // Check if notes already exist
        const noteDoc = await notesRef.doc(subtopicId).get();
        if (noteDoc.exists) {
            return res.json({ notes: { id: noteDoc.id, ...noteDoc.data() }, generated: false });
        }

        // Generate via LLM
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

        const llmResponse = await llm(NOTES_SYSTEM_PROMPT, userInputs);
        const parsed = GeneratedNotesSchema.safeParse(llmResponse);

        if (!parsed.success) {
            console.error("Notes schema validation failed:", parsed.error);
            return res.status(500).json({ error: "Failed to generate valid notes" });
        }

        // Save to Firestore (use subtopicId as doc ID for easy lookup)
        const notesData = {
            ...parsed.data,
            subtopic_id: subtopicId,
            subtopic_title: subtopic.title,
            unit_title: unit.title,
            course_title: course.title,
            difficulty: course.difficulty || "Beginner",
            generated_at: new Date(),
        };

        await notesRef.doc(subtopicId).set(notesData);

        return res.status(201).json({ notes: { id: subtopicId, ...notesData }, generated: true });
    } catch (err) {
        console.error("getGeneratedNotes error:", err);
        return res.status(500).json({ error: "Failed to generate notes" });
    }
};

// ============================================================
//  GET /api/notes/:subtopicId/export
//  Export single subtopic notes as Markdown
// ============================================================
export const exportSubtopicNotes = async (req, res) => {
    try {
        const { subtopicId } = req.params;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const noteDoc = await notesRef.doc(subtopicId).get();
        if (!noteDoc.exists) {
            return res.status(404).json({
                error: "Notes not generated yet. Call GET /:subtopicId/generated first.",
            });
        }

        const notes = noteDoc.data();
        const markdown = notesToMarkdown(notes);
        const format = req.query.format || "markdown";

        if (format === "json") {
            return res.json({ notes });
        }

        // Return as markdown file download
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${sanitizeFilename(notes.subtopic_title)}_notes.md"`
        );
        return res.send(markdown);
    } catch (err) {
        console.error("exportSubtopicNotes error:", err);
        return res.status(500).json({ error: "Failed to export notes" });
    }
};

// ============================================================
//  GET /api/notes/course/:courseId/export
//  Export ALL notes for a course as a single Markdown file
// ============================================================
export const exportCourseNotes = async (req, res) => {
    try {
        const { courseId } = req.params;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const courseDoc = await coursesRef.doc(courseId).get();
        if (!courseDoc.exists) {
            return res.status(404).json({ error: "Course not found" });
        }

        const course = courseDoc.data();
        const unitsSnap = await coursesRef
            .doc(courseId)
            .collection("units")
            .orderBy("position")
            .get();

        let fullMarkdown = `# 📚 ${course.title}\n`;
        fullMarkdown += `> **Difficulty:** ${course.difficulty || "Beginner"}\n\n`;
        fullMarkdown += `---\n\n`;

        let subtopicCount = 0;
        let generatedCount = 0;

        for (const unitDoc of unitsSnap.docs) {
            const unit = unitDoc.data();
            fullMarkdown += `# ${unit.title}\n\n`;

            const subsSnap = await unitDoc.ref
                .collection("subtopics")
                .orderBy("position")
                .get();

            for (const subDoc of subsSnap.docs) {
                subtopicCount++;
                const noteDoc = await notesRef.doc(subDoc.id).get();

                if (noteDoc.exists) {
                    generatedCount++;
                    const notes = noteDoc.data();
                    fullMarkdown += notesToMarkdown(notes);
                    fullMarkdown += `\n---\n\n`;
                } else {
                    fullMarkdown += `## ${subDoc.data().title}\n`;
                    fullMarkdown += `> ⚠️ Notes not generated yet for this subtopic.\n\n`;
                    fullMarkdown += `---\n\n`;
                }
            }
        }

        fullMarkdown += `\n---\n*Generated ${generatedCount}/${subtopicCount} subtopic notes*\n`;

        const format = req.query.format || "markdown";

        if (format === "json") {
            return res.json({
                course_title: course.title,
                total_subtopics: subtopicCount,
                notes_generated: generatedCount,
            });
        }

        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${sanitizeFilename(course.title)}_complete_notes.md"`
        );
        return res.send(fullMarkdown);
    } catch (err) {
        console.error("exportCourseNotes error:", err);
        return res.status(500).json({ error: "Failed to export course notes" });
    }
};

// ============================================================
//  Helper: Convert notes object to Markdown string
// ============================================================
function notesToMarkdown(notes) {
    let md = "";

    md += `## ${notes.subtopic_title || "Subtopic"}\n\n`;

    // Summary
    md += `### 📝 Summary\n${notes.summary}\n\n`;

    // The Problem
    md += `### ❓ The Problem\n${notes.the_problem}\n\n`;

    // Previous Approaches
    md += `### 🔄 What Was Tried Before\n${notes.previous_approaches}\n\n`;

    // The Solution
    md += `### 💡 The Solution\n${notes.the_solution}\n\n`;

    // Key Points (80-20)
    md += `### 🎯 Key Points (80-20 Rule)\n`;
    for (const point of notes.key_points || []) {
        md += `- ${point}\n`;
    }
    md += `\n`;

    // Analogy
    md += `### 🔗 Analogy\n${notes.analogy}\n\n`;

    // Real World Example
    md += `### 🌍 Real-World Example\n${notes.real_world_example}\n\n`;

    // Technical Example
    if (notes.technical_example) {
        md += `### 💻 Technical Example\n`;
        md += `\`\`\`${notes.technical_example.language || ""}\n`;
        md += `${notes.technical_example.code}\n`;
        md += `\`\`\`\n`;
        md += `${notes.technical_example.explanation}\n\n`;
    }

    // Workflow
    if (notes.workflow && notes.workflow.length > 0) {
        md += `### 🔄 Workflow\n`;
        for (let i = 0; i < notes.workflow.length; i++) {
            md += `${i + 1}. ${notes.workflow[i]}\n`;
        }
        md += `\n`;
    }

    // Common Mistakes
    md += `### ⚠️ Common Mistakes\n`;
    for (const mistake of notes.common_mistakes || []) {
        md += `- ${mistake}\n`;
    }
    md += `\n`;

    // Common Confusions
    md += `### 🤔 Common Confusions\n`;
    for (const confusion of notes.common_confusions || []) {
        md += `- ${confusion}\n`;
    }
    md += `\n`;

    // Mini Q&A
    md += `### 📋 Quick Q&A\n`;
    for (const qa of notes.mini_qa || []) {
        md += `**Q:** ${qa.question}\n`;
        md += `**A:** ${qa.answer}\n\n`;
    }

    return md;
}

// ============================================================
//  Helper: Sanitize filename
// ============================================================
function sanitizeFilename(name) {
    return (name || "notes")
        .replace(/[^a-zA-Z0-9\s-_]/g, "")
        .replace(/\s+/g, "_")
        .substring(0, 80);
}
