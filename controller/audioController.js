// ============================================================
//  Audio Overview Controller
//  Generates conversational audio for subtopics or full courses
// ============================================================

import { db } from "../db/firebase.js";
import axios from "axios";
import { getLLMProvider } from "../providers/LLMProviders.js";
import { AUDIO_SUBTOPIC_PROMPT, AUDIO_COURSE_PROMPT } from "../prompts/audioPrompt.js";
import { AudioScriptSchema } from "../llm/audioSchemas.js";
import { synthesize } from "../service/ttsService.js";
import { uploadAudio } from "../service/imagekitService.js";

const coursesRef = db.collection("courses");
const audioRef = db.collection("generated_audio");

function safeFilename(value, fallback) {
    const normalized = (value || fallback || "audio")
        .replace(/[^a-zA-Z0-9\s-_]/g, "")
        .replace(/\s+/g, "_")
        .slice(0, 80);
    return normalized || fallback || "audio";
}

async function ensureSubtopicAudio(req, subtopicId) {
    const userId = req.user?.id;
    if (!userId) {
        return { status: 401, error: "Unauthorized" };
    }

    const cachedDoc = await audioRef.doc(`sub_${subtopicId}`).get();
    if (cachedDoc.exists) {
        return {
            status: 200,
            audio: { id: cachedDoc.id, ...cachedDoc.data() },
            generated: false,
        };
    }

    const context = await findSubtopicWithContext(subtopicId);
    if (!context) {
        return { status: 404, error: "Subtopic not found" };
    }

    const { subtopic, unit, course } = context;

    if (!subtopic.content) {
        return {
            status: 400,
            error: "Subtopic content not generated yet. Generate course content first.",
        };
    }

    const contentText =
        typeof subtopic.content === "string"
            ? subtopic.content
            : JSON.stringify(subtopic.content);

    const llmProvider = req.query.llm_provider || "Groq";
    const llmModel = req.query.llm_model || null;
    const llm = getLLMProvider(llmProvider, llmModel);

    console.log("🎙️ Generating audio script via LLM...");
    const llmResponse = await llm(AUDIO_SUBTOPIC_PROMPT, {
        course_title: course.title,
        unit_title: unit.title,
        subtopic_title: subtopic.title,
        difficulty: course.difficulty || "Beginner",
        content: contentText,
    });

    const parsed = AudioScriptSchema.safeParse(llmResponse);
    if (!parsed.success) {
        console.error("Audio script schema validation failed:", parsed.error);
        return { status: 500, error: "Failed to generate valid audio script" };
    }

    const script = parsed.data;
    console.log(`📝 Script generated: ${script.segments.length} segments, ~${script.estimated_duration_seconds}s`);

    const ttsProvider = req.query.tts_provider || "Groq";
    const voice = req.query.voice || "autumn";

    console.log(`🔊 Synthesizing with ${ttsProvider}...`);
    const audioBuffer = await synthesize(script.segments, ttsProvider, { voice });

    console.log("☁️ Uploading to ImageKit...");
    const filename = `${subtopicId}_${Date.now()}.wav`;
    const uploadResult = await uploadAudio(audioBuffer, filename);

    const audioData = {
        type: "subtopic",
        subtopic_id: subtopicId,
        subtopic_title: subtopic.title,
        unit_title: unit.title,
        course_title: course.title,
        course_id: course.id,
        script: script.segments.map((s) => s.text).join(" "),
        segment_count: script.segments.length,
        estimated_duration: script.estimated_duration_seconds,
        tts_provider: ttsProvider,
        voice,
        audio_url: uploadResult.url,
        imagekit_file_id: uploadResult.fileId,
        file_size_bytes: audioBuffer.length,
        generated_at: new Date(),
    };

    await audioRef.doc(`sub_${subtopicId}`).set(audioData);

    return {
        status: 201,
        audio: { id: `sub_${subtopicId}`, ...audioData },
        generated: true,
    };
}

async function synthesizeSubtopicAudioBuffer(req, subtopicId) {
    const context = await findSubtopicWithContext(subtopicId);
    if (!context) {
        return { status: 404, error: "Subtopic not found" };
    }

    const { subtopic, unit, course } = context;
    if (!subtopic.content) {
        return {
            status: 400,
            error: "Subtopic content not generated yet. Generate course content first.",
        };
    }

    const contentText =
        typeof subtopic.content === "string"
            ? subtopic.content
            : JSON.stringify(subtopic.content);

    const llmProvider = req.query.llm_provider || "Groq";
    const llmModel = req.query.llm_model || null;
    const llm = getLLMProvider(llmProvider, llmModel);

    const llmResponse = await llm(AUDIO_SUBTOPIC_PROMPT, {
        course_title: course.title,
        unit_title: unit.title,
        subtopic_title: subtopic.title,
        difficulty: course.difficulty || "Beginner",
        content: contentText,
    });

    const parsed = AudioScriptSchema.safeParse(llmResponse);
    if (!parsed.success) {
        return { status: 500, error: "Failed to generate valid audio script" };
    }

    const script = parsed.data;
    const ttsProvider = req.query.tts_provider || "Groq";
    const voice = req.query.voice || "autumn";
    const audioBuffer = await synthesize(script.segments, ttsProvider, { voice });

    return { status: 200, audioBuffer };
}

async function getAudioUpstreamWithRecovery(req, subtopicId) {
    let result = await ensureSubtopicAudio(req, subtopicId);
    if (result.error) {
        return { result, upstream: null };
    }

    try {
        const upstream = await axios.get(result.audio.audio_url, {
            responseType: "stream",
            timeout: 30000,
        });
        return { result, upstream };
    } catch (err) {
        const status = err.response?.status;
        const shouldRegenerate = status === 404 || status === 410 || status === 403;

        if (!shouldRegenerate) {
            throw err;
        }

        console.warn(`⚠️ Cached audio URL invalid (${status}) for subtopic ${subtopicId}; regenerating audio.`);
        await audioRef.doc(`sub_${subtopicId}`).delete().catch(() => {});

        result = await ensureSubtopicAudio(req, subtopicId);
        if (result.error) {
            return { result, upstream: null };
        }

        const upstream = await axios.get(result.audio.audio_url, {
            responseType: "stream",
            timeout: 30000,
        });

        return { result, upstream };
    }
}

// ============================================================
//  Helper: Find subtopic with context (same as flashcard/notes)
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
//  GET /api/audio/:subtopicId
//  Generate or get cached audio for a single subtopic
// ============================================================
export const getAudioForSubtopic = async (req, res) => {
    try {
        const { subtopicId } = req.params;
        const result = await ensureSubtopicAudio(req, subtopicId);
        if (result.error) {
            return res.status(result.status || 500).json({ error: result.error });
        }

        return res.status(result.status === 201 ? 201 : 200).json({
            audio: result.audio,
            generated: result.generated,
        });
    } catch (err) {
        console.error("getAudioForSubtopic error details:", {
            message: err.message,
            stack: err.stack,
            response: err.response?.data,
            code: err.code
        });
        return res.status(500).json({ error: "Failed to generate audio overview", details: err.message });
    }
};

// ============================================================
//  GET /api/audio/:subtopicId/stream
//  Streams generated audio for in-app playback
// ============================================================
export const streamAudioForSubtopic = async (req, res) => {
    try {
        const { subtopicId } = req.params;
        try {
            const { result, upstream } = await getAudioUpstreamWithRecovery(req, subtopicId);
            if (result.error) {
                return res.status(result.status || 500).json({ error: result.error });
            }

            res.status(200);
            res.setHeader("Content-Type", upstream.headers["content-type"] || "audio/wav");
            if (upstream.headers["content-length"]) {
                res.setHeader("Content-Length", upstream.headers["content-length"]);
            }
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

            upstream.data.on("error", (error) => {
                console.error("streamAudioForSubtopic upstream stream error:", error.message);
                if (!res.headersSent) {
                    res.status(502).json({ error: "Audio stream failed" });
                } else {
                    res.end();
                }
            });

            return upstream.data.pipe(res);
        } catch (err) {
            console.warn("streamAudioForSubtopic falling back to direct synthesis:", err.response?.status || err.message);
            const fallback = await synthesizeSubtopicAudioBuffer(req, subtopicId);
            if (fallback.error) {
                return res.status(fallback.status || 500).json({ error: fallback.error });
            }

            res.status(200);
            res.setHeader("Content-Type", "audio/wav");
            res.setHeader("Content-Length", String(fallback.audioBuffer.length));
            res.setHeader("Cache-Control", "no-store");
            return res.end(fallback.audioBuffer);
        }
    } catch (err) {
        const detail = err.response?.status
            ? `Upstream status ${err.response.status}`
            : err.message;
        console.error("streamAudioForSubtopic error:", detail);
        return res.status(500).json({ error: "Failed to stream audio", details: detail });
    }
};

// ============================================================
//  GET /api/audio/:subtopicId/download
//  Downloads generated audio as an attachment
// ============================================================
export const downloadAudioForSubtopic = async (req, res) => {
    try {
        const { subtopicId } = req.params;
        const filenameBase = safeFilename(`subtopic_${subtopicId}`, `subtopic_${subtopicId}`);

        try {
            const { result, upstream } = await getAudioUpstreamWithRecovery(req, subtopicId);
            if (result.error) {
                return res.status(result.status || 500).json({ error: result.error });
            }

            const resolvedFilenameBase = safeFilename(result.audio.subtopic_title, filenameBase);

            res.status(200);
            res.setHeader("Content-Type", upstream.headers["content-type"] || "audio/wav");
            res.setHeader("Content-Disposition", `attachment; filename="${resolvedFilenameBase}.wav"`);
            if (upstream.headers["content-length"]) {
                res.setHeader("Content-Length", upstream.headers["content-length"]);
            }

            upstream.data.on("error", (error) => {
                console.error("downloadAudioForSubtopic upstream stream error:", error.message);
                if (!res.headersSent) {
                    res.status(502).json({ error: "Audio download failed" });
                } else {
                    res.end();
                }
            });

            return upstream.data.pipe(res);
        } catch (err) {
            console.warn("downloadAudioForSubtopic falling back to direct synthesis:", err.response?.status || err.message);
            const fallback = await synthesizeSubtopicAudioBuffer(req, subtopicId);
            if (fallback.error) {
                return res.status(fallback.status || 500).json({ error: fallback.error });
            }

            res.status(200);
            res.setHeader("Content-Type", "audio/wav");
            res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.wav"`);
            res.setHeader("Content-Length", String(fallback.audioBuffer.length));
            return res.end(fallback.audioBuffer);
        }
    } catch (err) {
        const detail = err.response?.status
            ? `Upstream status ${err.response.status}`
            : err.message;
        console.error("downloadAudioForSubtopic error:", detail);
        return res.status(500).json({ error: "Failed to download audio", details: detail });
    }
};

// ============================================================
//  GET /api/audio/course/:courseId
//  Generate or get cached audio overview for an entire course
// ============================================================
export const getAudioForCourse = async (req, res) => {
    try {
        const { courseId } = req.params;
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        // ── Check cache ──
        const cachedDoc = await audioRef.doc(`course_${courseId}`).get();
        if (cachedDoc.exists) {
            return res.json({
                audio: { id: cachedDoc.id, ...cachedDoc.data() },
                generated: false,
            });
        }

        // ── Get course data ──
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

        const units = [];
        for (const unitDoc of unitsSnap.docs) {
            const subsSnap = await unitDoc.ref
                .collection("subtopics")
                .orderBy("position")
                .get();

            units.push({
                title: unitDoc.data().title,
                subtopics: subsSnap.docs.map((s) => ({ title: s.data().title })),
            });
        }

        // ── Step 1: Generate course overview script via LLM ──
        const llmProvider = req.query.llm_provider || "Groq";
        const llmModel = req.query.llm_model || null;
        const llm = getLLMProvider(llmProvider, llmModel);

        console.log("🎙️ Generating course audio script via LLM...");
        const llmResponse = await llm(AUDIO_COURSE_PROMPT, {
            course_title: course.title,
            difficulty: course.difficulty || "Beginner",
            units,
        });

        const parsed = AudioScriptSchema.safeParse(llmResponse);
        if (!parsed.success) {
            console.error("Audio script schema validation failed:", parsed.error);
            return res.status(500).json({ error: "Failed to generate valid audio script" });
        }

        const script = parsed.data;
        console.log(`📝 Course script: ${script.segments.length} segments, ~${script.estimated_duration_seconds}s`);

        // ── Step 2: Synthesize ──
        const ttsProvider = req.query.tts_provider || "Groq";
        const voice = req.query.voice || "autumn";

        console.log(`🔊 Synthesizing with ${ttsProvider}...`);
        const audioBuffer = await synthesize(script.segments, ttsProvider, { voice });

        // ── Step 3: Upload to ImageKit ──
        console.log("☁️ Uploading to ImageKit...");
        const filename = `course_${courseId}_${Date.now()}.wav`;
        const uploadResult = await uploadAudio(audioBuffer, filename);

        // ── Step 4: Save metadata ──
        const audioData = {
            type: "course",
            course_id: courseId,
            course_title: course.title,
            script: script.segments.map((s) => s.text).join(" "),
            segment_count: script.segments.length,
            estimated_duration: script.estimated_duration_seconds,
            tts_provider: ttsProvider,
            voice,
            audio_url: uploadResult.url,
            imagekit_file_id: uploadResult.fileId,
            file_size_bytes: audioBuffer.length,
            generated_at: new Date(),
        };

        await audioRef.doc(`course_${courseId}`).set(audioData);

        console.log(`✅ Course audio overview generated: ${uploadResult.url}`);
        return res.status(201).json({
            audio: { id: `course_${courseId}`, ...audioData },
            generated: true,
        });
    } catch (err) {
        console.error("getAudioForCourse error details:", {
            message: err.message,
            stack: err.stack,
            response: err.response?.data,
            code: err.code
        });
        return res.status(500).json({ error: "Failed to generate course audio overview", details: err.message });
    }
};
