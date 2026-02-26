// ============================================================
//  TTS Service — Groq Orpheus + Resemble.ai
//  Converts script segments to audio (WAV buffer)
// ============================================================

import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────────────────
//  WAV helpers
// ─────────────────────────────────────────

/**
 * Parse a WAV buffer and return the raw PCM data + format info.
 */
function parseWav(buffer) {
    // RIFF header
    const riff = buffer.toString("ascii", 0, 4);
    if (riff !== "RIFF") throw new Error("Not a valid WAV file");

    let offset = 12; // skip RIFF header + WAVE

    let fmt = null;
    let dataChunks = [];

    while (offset < buffer.length) {
        const chunkId = buffer.toString("ascii", offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);

        if (chunkId === "fmt ") {
            fmt = {
                audioFormat: buffer.readUInt16LE(offset + 8),
                numChannels: buffer.readUInt16LE(offset + 10),
                sampleRate: buffer.readUInt32LE(offset + 12),
                byteRate: buffer.readUInt32LE(offset + 16),
                blockAlign: buffer.readUInt16LE(offset + 20),
                bitsPerSample: buffer.readUInt16LE(offset + 22),
            };
        } else if (chunkId === "data") {
            dataChunks.push(buffer.slice(offset + 8, offset + 8 + chunkSize));
        }

        offset += 8 + chunkSize;
        // WAV chunks are word-aligned (2 bytes)
        if (chunkSize % 2 !== 0) offset += 1;
    }

    return { fmt, pcmData: Buffer.concat(dataChunks) };
}

/**
 * Create a WAV file buffer from raw PCM data and format info.
 */
function createWav(pcmData, fmt) {
    const headerSize = 44;
    const buffer = Buffer.alloc(headerSize + pcmData.length);

    // RIFF header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + pcmData.length, 4);
    buffer.write("WAVE", 8);

    // fmt sub-chunk
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16); // sub-chunk size
    buffer.writeUInt16LE(fmt.audioFormat, 20);
    buffer.writeUInt16LE(fmt.numChannels, 22);
    buffer.writeUInt32LE(fmt.sampleRate, 24);
    buffer.writeUInt32LE(fmt.byteRate, 28);
    buffer.writeUInt16LE(fmt.blockAlign, 32);
    buffer.writeUInt16LE(fmt.bitsPerSample, 34);

    // data sub-chunk
    buffer.write("data", 36);
    buffer.writeUInt32LE(pcmData.length, 40);
    pcmData.copy(buffer, 44);

    return buffer;
}

// ─────────────────────────────────────────
//  Chunk text into ≤ maxLen pieces
//  Splits at sentence boundaries first,
//  then at word boundaries if needed.
// ─────────────────────────────────────────
function chunkText(text, maxLen = 190) {
    if (text.length <= maxLen) return [text];

    const chunks = [];
    // Split on sentence-ending punctuation
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];

    let current = "";
    for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (!trimmed) continue;

        if ((current + " " + trimmed).trim().length <= maxLen) {
            current = (current + " " + trimmed).trim();
        } else {
            if (current) chunks.push(current);
            // If single sentence > maxLen, split at word boundaries
            if (trimmed.length > maxLen) {
                const words = trimmed.split(/\s+/);
                current = "";
                for (const word of words) {
                    if ((current + " " + word).trim().length <= maxLen) {
                        current = (current + " " + word).trim();
                    } else {
                        if (current) chunks.push(current);
                        current = word;
                    }
                }
            } else {
                current = trimmed;
            }
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

// ─────────────────────────────────────────
//  Groq Orpheus TTS
// ─────────────────────────────────────────

const GROQ_TTS_MODEL = "canopylabs/orpheus-v1-english";
const DEFAULT_VOICE = "autumn";

/**
 * Synthesize a single text chunk with Groq Orpheus.
 * Returns a WAV Buffer.
 */
async function groqTTSChunk(text, voice = DEFAULT_VOICE) {
    try {
        const response = await groq.audio.speech.create({
            model: GROQ_TTS_MODEL,
            voice,
            input: text,
            response_format: "wav",
        });

        return Buffer.from(await response.arrayBuffer());
    } catch (err) {
        const errorMessage =
            err.response?.data?.error?.message ||
            err.message ||
            "Unknown Groq TTS error";

        const unsupportedVoice =
            typeof errorMessage === "string" &&
            errorMessage.toLowerCase().includes("voice must be one of");

        if (unsupportedVoice && voice !== DEFAULT_VOICE) {
            console.warn(`⚠️ Unsupported Groq voice "${voice}". Retrying with default voice "${DEFAULT_VOICE}".`);
            const retry = await groq.audio.speech.create({
                model: GROQ_TTS_MODEL,
                voice: DEFAULT_VOICE,
                input: text,
                response_format: "wav",
            });
            return Buffer.from(await retry.arrayBuffer());
        }

        throw err;
    }
}

/**
 * Synthesize full script using Groq Orpheus.
 * Chunks segments, calls TTS for each, concatenates WAV.
 * @param {Array<{ text: string, direction: string|null }>} segments
 * @param {string} voice
 * @returns {Promise<Buffer>} final WAV buffer
 */
export async function synthesizeWithGroq(segments, voice = DEFAULT_VOICE) {
    // Build flat list of text chunks with vocal directions prepended
    const allChunks = [];
    for (const seg of segments) {
        // The text already contains [direction] inline from the LLM prompt,
        // but ensure direction is prepended if separate
        let text = seg.text;
        if (seg.direction && !text.startsWith(`[${seg.direction}]`)) {
            text = `[${seg.direction}] ${text}`;
        }

        // Remove directions from text length calculation for chunking
        const chunks = chunkText(text, 195);
        allChunks.push(...chunks);
    }

    console.log(`🎙️ Groq TTS: ${allChunks.length} chunks to synthesize`);

    // Process chunks sequentially to respect rate limits
    const wavBuffers = [];
    let firstFmt = null;
    const errors = [];

    for (let i = 0; i < allChunks.length; i++) {
        const chunk = allChunks[i];
        console.log(`  🎧 Chunk ${i + 1}/${allChunks.length}: "${chunk.substring(0, 50)}..."`);

        try {
            const wavBuf = await groqTTSChunk(chunk, voice);
            const { fmt, pcmData } = parseWav(wavBuf);

            if (!firstFmt) firstFmt = fmt;
            wavBuffers.push(pcmData);

            // Small delay between requests to avoid rate limiting
            if (i < allChunks.length - 1) {
                await new Promise((r) => setTimeout(r, 200));
            }
        } catch (err) {
            const errMsg = `Chunk ${i + 1} failed: ${err.message}${err.response?.data ? ' - ' + JSON.stringify(err.response.data) : ''}`;
            console.error(`  ❌ ${errMsg}`);
            errors.push(errMsg);
            // Continue with remaining chunks
        }
    }

    if (wavBuffers.length === 0 || !firstFmt) {
        throw new Error(`No audio chunks were successfully generated. Errors: ${errors.join('; ')}`);
    }

    // Concatenate all PCM data and wrap in a single WAV
    const combinedPCM = Buffer.concat(wavBuffers);
    const finalWav = createWav(combinedPCM, firstFmt);

    console.log(`✅ Groq TTS complete: ${finalWav.length} bytes, ${wavBuffers.length} chunks`);
    return finalWav;
}

// ─────────────────────────────────────────
//  Resemble.ai TTS
// ─────────────────────────────────────────

import { Resemble } from "@resemble/node";

/**
 * Synthesize full script using Resemble.ai Node SDK (Streaming).
 * @param {Array<{ text: string }>} segments
 * @returns {Promise<Buffer>} WAV buffer
 */
export async function synthesizeWithResemble(segments) {
    const apiKey = process.env.RESEMBLE_API_KEY;
    const projectUuid = process.env.RESEMBLE_PROJECT_UUID || null; // Optional
    const voiceUuid = process.env.RESEMBLE_VOICE_UUID || "5bb13f03"; // User's preferred voice
    const synthUrl = process.env.RESEMBLE_SYNTH_ENDPOINT || "https://f.cluster.resemble.ai/synthesize";
    const streamUrl = process.env.RESEMBLE_STREAM_ENDPOINT || "https://f.cluster.resemble.ai/stream";

    if (!apiKey) {
        throw new Error(
            "Resemble.ai credentials not configured (RESEMBLE_API_KEY)"
        );
    }

    // Configure SDK
    Resemble.setApiKey(apiKey);

    // Note: The SDK might not have a direct way to set the stream URL explicitly for clips.stream 
    // but setting the synthesis URL is standard. If the user provided a cluster, we use it.
    if (synthUrl) {
        Resemble.setSynthesisUrl(synthUrl);
    }

    // Combine all segments into one text block
    const fullText = segments.map((s) => s.text).join(" ");
    console.log(`🎙️ Resemble.ai SDK Streaming: ${fullText.length} chars (Voice: ${voiceUuid})`);

    const chunks = [];
    try {
        // Use the streaming API as requested by user
        // If project_uuid is missing, it's optional in HTTP stream
        const streamOptions = {
            data: fullText,
            voice_uuid: voiceUuid,
            precision: "PCM_16", // Standard
            sample_rate: 22050,
        };

        if (projectUuid) {
            streamOptions.project_uuid = projectUuid;
        }

        for await (const chunk of Resemble.v2.clips.stream(streamOptions)) {
            if (chunk) {
                if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
                    chunks.push(Buffer.from(chunk));
                } else {
                    // Handle object-based chunks (common in newer SDKs)
                    const data = chunk.audio || chunk.chunk || chunk.data || chunk.content;
                    if (data) {
                        chunks.push(Buffer.from(data));
                    } else {
                        console.warn("⚠️ Received Resemble.ai chunk without recognizable data:", Object.keys(chunk));
                    }
                }
            }
        }
    } catch (err) {
        console.error("  ❌ Resemble.ai streaming failed:", err.message);
        throw new Error(`Resemble.ai streaming error: ${err.message}`);
    }

    if (chunks.length === 0) {
        throw new Error("Resemble.ai: No audio chunks returned from stream");
    }

    // Concatenate all chunks (first one includes the WAV header by default)
    const audioBuffer = Buffer.concat(chunks);
    console.log(`✅ Resemble.ai TTS complete: ${audioBuffer.length} bytes`);
    return audioBuffer;
}

// ─────────────────────────────────────────
//  Unified synthesize function
// ─────────────────────────────────────────

/**
 * Synthesize audio from script segments.
 * @param {Array<{ text: string, direction: string|null }>} segments
 * @param {"Groq"|"Resemble"} provider
 * @param {{ voice?: string }} options
 * @returns {Promise<Buffer>}
 */
export async function synthesize(segments, provider = "Groq", options = {}) {
    if (provider === "Resemble") {
        return synthesizeWithResemble(segments);
    }
    // Default: Groq Orpheus
    return synthesizeWithGroq(segments, options.voice || DEFAULT_VOICE);
}
