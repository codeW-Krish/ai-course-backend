import { ImageKit } from "@imagekit/nodejs";
import axios from "axios";
import FormData from "form-data";

// Helper to strip path from endpoint if user provided it (ImageKit SDK expects base URL)
let urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;
if (urlEndpoint && urlEndpoint.includes('ik.imagekit.io/')) {
    const parts = urlEndpoint.split('/');
    urlEndpoint = parts.slice(0, 4).join('/'); // e.g. https://ik.imagekit.io/id
}

const imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: urlEndpoint,
});

/**
 * Upload an audio buffer to ImageKit.
 * Bypasses the SDK's .upload() to avoid FormData/Fetch mismatch bugs in some Node versions.
 * @param {Buffer} buffer  – WAV/MP3 audio buffer
 * @param {string} filename – e.g. "subtopic_abc123.wav"
 * @returns {Promise<Object>} - The ImageKit upload result
 */
export async function uploadAudio(buffer, filename) {
    console.log(`🚀 Uploading to ImageKit: ${filename} (${buffer.length} bytes)`);

    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    if (!privateKey) throw new Error("IMAGEKIT_PRIVATE_KEY is missing");

    // Auth header is Basic [base64(private_key:)]
    const authHeader = Buffer.from(`${privateKey}:`).toString("base64");

    const form = new FormData();
    form.append("file", buffer, {
        filename,
        contentType: "audio/wav",
    });
    form.append("fileName", filename);
    form.append("folder", "/audio-overviews");
    form.append("useUniqueFileName", "true");
    form.append("tags", "audio,overview");

    try {
        const response = await axios.post("https://upload.imagekit.io/api/v1/files/upload", form, {
            headers: {
                Authorization: `Basic ${authHeader}`,
                ...form.getHeaders(),
            },
            maxBodyLength: Infinity,
        });

        console.log(`✅ ImageKit upload success: ${response.data.url}`);
        return response.data;
    } catch (err) {
        const errMsg = err.response?.data?.message || err.message;
        const errDetails = err.response?.data ? JSON.stringify(err.response.data) : "No extra details";
        console.error("❌ ImageKit upload failed:", errMsg, errDetails);
        throw new Error(`ImageKit upload error: ${errMsg}`);
    }
}

/**
 * Delete an audio file from ImageKit by fileId.
 * @param {string} fileId - The ImageKit fileId
 */
export async function deleteAudio(fileId) {
    try {
        await imagekit.files.delete(fileId);
        console.log(`🗑️ Deleted from ImageKit: ${fileId}`);
    } catch (err) {
        console.warn(`⚠️ Failed to delete from ImageKit (${fileId}):`, err.message);
    }
}

export default imagekit;
