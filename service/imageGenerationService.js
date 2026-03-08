// ============================================================
//  Image Generation Service  —  Priority Cascade
//  Pixazo (FREE) → ImageGPT (98 credits) → deAPI ($5) → SVG fallback
//
//  Env vars:
//    PIXAZO_API_KEY        – Ocp-Apim-Subscription-Key for Pixazo
//    IMAGEGPT_API_KEY      – Bearer token for ImageGPT
//    DEAPI_API_KEY         – Bearer token for deAPI
// ============================================================

import axios from "axios";

// ─────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────

/** Tiny sleep helper for polling loops */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download an image URL and return a Buffer.
 * Useful when we need the raw bytes for further upload (e.g. ImageKit).
 */
export async function downloadImageBuffer(url) {
  const resp = await axios.get(url, { responseType: "arraybuffer", timeout: 30000 });
  return Buffer.from(resp.data);
}

// ─────────────────────────────────────────
//  Provider 1 — Pixazo  (FREE, Flux 1 Schnell)
//  POST https://gateway.pixazo.ai/flux-1-schnell/v1/getData
//  Header: Ocp-Apim-Subscription-Key
//  Body:   { prompt, num_steps, seed, height, width }
//  Resp:   { output: "<image_url>" }
// ─────────────────────────────────────────

async function pixazoGenerate(prompt, width = 1024, height = 1024) {
  const apiKey = process.env.PIXAZO_API_KEY;
  if (!apiKey) throw new Error("PIXAZO_API_KEY not set");

  const response = await axios.post(
    "https://gateway.pixazo.ai/flux-1-schnell/v1/getData",
    {
      prompt,
      num_steps: 4,
      seed: Math.floor(Math.random() * 999999),
      height,
      width,
    },
    {
      headers: {
        "Ocp-Apim-Subscription-Key": apiKey,
        "Content-Type": "application/json",
      },
      timeout: 60000, // 60 s
    }
  );

  const url = response.data?.output;
  if (!url || typeof url !== "string") {
    throw new Error(`Pixazo: unexpected response — ${JSON.stringify(response.data).substring(0, 200)}`);
  }
  return url;
}

// ─────────────────────────────────────────
//  Provider 2 — ImageGPT  (98 Flux credits)
//  POST https://api.imagegpt.online/generate/text-image
//  Auth:  x-api-key header
//  Body:  { prompt, width, height, seed, model, outputType }
//  outputType: "url" → hosted URL, "binary" → blob, "base64" → encoded
// ─────────────────────────────────────────

async function imagegptGenerate(prompt, width = 1024, height = 1024) {
  const apiKey = process.env.IMAGEGPT_API_KEY;
  if (!apiKey) throw new Error("IMAGEGPT_API_KEY not set");

  const response = await axios.post(
    "https://api.imagegpt.online/generate/text-image",
    {
      prompt,
      model: "flux",
      width,
      height,
      seed: Math.floor(Math.random() * 999999),
      outputType: "url",
    },
    {
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      timeout: 90000,
    }
  );

  const data = response.data;

  // Extract URL from response
  if (typeof data === "string" && data.startsWith("http")) return data;
  if (data?.url) return data.url;
  if (data?.image_url) return data.image_url;
  if (data?.output && typeof data.output === "string") return data.output;
  if (data?.data?.url) return data.data.url;

  throw new Error(`ImageGPT: unexpected response — ${JSON.stringify(data).substring(0, 200)}`);
}

// ─────────────────────────────────────────
//  Provider 3 — deAPI  ($5 credit)
//  POST https://api.deapi.ai/api/v1/client/txt2img
//  Auth:  Bearer token
//  Body:  { prompt, model, width, height, guidance, steps, seed }
//  Resp:  { data: { request_id } }
//  Then poll: GET /api/v1/client/request-status/{request_id}
//  Until status "done" → result_url
//
//  Models: Flux1schnell (fast), ZImageTurbo_INT8, Flux_2_Klein_4B_BF16
// ─────────────────────────────────────────

const DEAPI_BASE = "https://api.deapi.ai";
const DEAPI_MODEL = "Flux1schnell"; // cheapest & fastest

async function deapiGenerate(prompt, width = 1024, height = 768) {
  const apiKey = process.env.DEAPI_API_KEY;
  if (!apiKey) throw new Error("DEAPI_API_KEY not set");

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // 1. Submit the generation request
  const submitResp = await axios.post(
    `${DEAPI_BASE}/api/v1/client/txt2img`,
    {
      prompt,
      negative_prompt: "text, watermark, blurry, low quality, distorted",
      model: DEAPI_MODEL,
      width,
      height,
      guidance: 3.5,
      steps: 4,
      seed: Math.floor(Math.random() * 999999),
    },
    { headers, timeout: 30000 }
  );

  const requestId = submitResp.data?.data?.request_id;
  if (!requestId) {
    throw new Error(`deAPI: no request_id — ${JSON.stringify(submitResp.data).substring(0, 200)}`);
  }

  // 2. Poll for completion (max ~120 s)
  const maxWait = 120000;
  const interval = 2500;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    await sleep(interval);

    const statusResp = await axios.get(
      `${DEAPI_BASE}/api/v1/client/request-status/${requestId}`,
      { headers, timeout: 15000 }
    );

    const job = statusResp.data?.data;
    if (!job) continue;

    if (job.status === "done") {
      if (job.result_url) return job.result_url;
      throw new Error("deAPI: job done but no result_url");
    }

    if (job.status === "error") {
      throw new Error(`deAPI job error: ${job.error || "unknown"}`);
    }

    // "pending" or "processing" → keep polling
  }

  throw new Error(`deAPI: job ${requestId} timed out after ${maxWait / 1000}s`);
}

// ─────────────────────────────────────────
//  Priority chain definition
// ─────────────────────────────────────────

const PROVIDER_CHAIN = [
  // { name: "pixazo", fn: pixazoGenerate, envKey: "PIXAZO_API_KEY" },  // TODO: re-enable when API key is available
  // { name: "imagegpt", fn: imagegptGenerate, envKey: "IMAGEGPT_API_KEY" },
  { name: "deapi", fn: deapiGenerate, envKey: "DEAPI_API_KEY" },
];

// ─────────────────────────────────────────
//  Main export — cascading generation
// ─────────────────────────────────────────

/**
 * Generate an illustration image for a scene.
 *
 * Tries providers in priority order: Pixazo → ImageGPT → deAPI.
 * If ALL providers fail (or have no keys), returns null
 * so the caller can fall back to an SVG-based visual.
 *
 * @param {string}  prompt           Detailed image generation prompt
 * @param {Object}  [options]
 * @param {string}  [options.provider]  Force a specific provider ("pixazo"|"imagegpt"|"deapi"|"placeholder")
 * @param {number}  [options.width]     Image width  (default 1024)
 * @param {number}  [options.height]    Image height (default 1024)
 * @returns {Promise<string|null>}  Image URL or null (SVG fallback)
 */
export async function generateIllustration(prompt, options = {}) {
  const width = options.width || 1024;
  const height = options.height || 1024;

  // Allow forcing a single provider (e.g. for testing)
  if (options.provider && options.provider !== "placeholder") {
    const forced = PROVIDER_CHAIN.find((p) => p.name === options.provider);
    if (forced) {
      try {
        console.log(`🎨 [${forced.name}] Generating (forced)...`);
        const url = await forced.fn(prompt, width, height);
        console.log(`✅ [${forced.name}] ${url.substring(0, 80)}...`);
        return url;
      } catch (err) {
        console.error(`❌ [${forced.name}] ${err.message}`);
        return null;
      }
    }
  }

  // If explicitly "placeholder" or no providers configured at all
  if (options.provider === "placeholder") return null;

  // ── Cascade: try each provider in priority order ──
  for (const { name, fn, envKey } of PROVIDER_CHAIN) {
    if (!process.env[envKey]) {
      console.log(`   ⏭️  [${name}] skipped — ${envKey} not set`);
      continue;
    }

    try {
      console.log(`🎨 [${name}] Generating illustration...`);
      console.log(`   Prompt: ${prompt.substring(0, 100)}...`);
      const url = await fn(prompt, width, height);
      console.log(`✅ [${name}] ${url.substring(0, 80)}...`);
      return url;
    } catch (err) {
      console.warn(`⚠️  [${name}] failed — ${err.message}`);
      // Continue to next provider
    }
  }

  // All providers exhausted → null triggers SVG fallback in videoController
  console.log("⚠️  All image providers failed or unconfigured → SVG fallback");
  return null;
}

export default { generateIllustration, downloadImageBuffer };
