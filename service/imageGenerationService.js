// ============================================================
//  Image Generation Service
//  Calls external AI image APIs (Flux, DALL-E, etc.)
//  for "illustration" scene types
// ============================================================

import axios from "axios";

// ─────────────────────────────────────────
//  Provider configuration
// ─────────────────────────────────────────

const IMAGE_PROVIDERS = {
  /**
   * Flux (via Replicate or similar API)
   * Set env: FLUX_API_URL, FLUX_API_KEY
   */
  flux: {
    generate: async (prompt, options = {}) => {
      const apiUrl = process.env.FLUX_API_URL;
      const apiKey = process.env.FLUX_API_KEY;

      if (!apiUrl || !apiKey) {
        throw new Error("Flux API not configured. Set FLUX_API_URL and FLUX_API_KEY env vars.");
      }

      const response = await axios.post(
        apiUrl,
        {
          prompt,
          width: options.width || 1920,
          height: options.height || 1080,
          num_inference_steps: options.steps || 30,
          guidance_scale: options.guidance || 7.5,
          negative_prompt: options.negativePrompt || "text, watermark, blurry, low quality, distorted",
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 120000, // 2 min timeout for generation
        }
      );

      // Response format varies by provider — handle common patterns
      const data = response.data;
      if (data.output && Array.isArray(data.output)) {
        return data.output[0]; // URL
      }
      if (data.images && Array.isArray(data.images)) {
        return data.images[0]; // URL or base64
      }
      if (data.url) {
        return data.url;
      }
      if (typeof data === "string" && data.startsWith("http")) {
        return data;
      }

      throw new Error("Unexpected image API response format");
    },
  },

  /**
   * OpenAI DALL-E
   * Set env: OPENAI_API_KEY
   */
  dalle: {
    generate: async (prompt, options = {}) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OpenAI API key not configured for DALL-E.");
      }

      const { default: OpenAI } = await import("openai");
      const openai = new OpenAI({ apiKey });

      const response = await openai.images.generate({
        model: options.model || "dall-e-3",
        prompt,
        n: 1,
        size: "1792x1024", // Closest to 16:9
        quality: "standard",
      });

      return response.data[0].url;
    },
  },

  /**
   * Placeholder / fallback
   * Returns a solid color image with text overlay
   * (generated via SVG, no external API needed)
   */
  placeholder: {
    generate: async (prompt) => {
      // Return null to signal that rendering should use a text-based SVG instead
      return null;
    },
  },
};

// ─────────────────────────────────────────
//  Main: Generate illustration image
// ─────────────────────────────────────────

/**
 * Generate an illustration image for a scene.
 *
 * @param {string} prompt - Detailed image generation prompt
 * @param {Object} options
 * @param {string} options.provider - "flux" | "dalle" | "placeholder"
 * @param {string} options.negativePrompt
 * @param {number} options.width
 * @param {number} options.height
 * @returns {Promise<string|null>} Image URL or null if placeholder
 */
export async function generateIllustration(prompt, options = {}) {
  const providerName = options.provider || process.env.IMAGE_PROVIDER || "placeholder";
  const provider = IMAGE_PROVIDERS[providerName];

  if (!provider) {
    console.warn(`⚠️ Unknown image provider "${providerName}", using placeholder`);
    return null;
  }

  try {
    console.log(`🎨 Generating illustration via ${providerName}...`);
    console.log(`   Prompt: ${prompt.substring(0, 100)}...`);
    const result = await provider.generate(prompt, options);
    console.log(`✅ Image generated${result ? `: ${result.substring(0, 80)}...` : " (placeholder)"}`);
    return result;
  } catch (err) {
    console.error(`❌ Image generation failed (${providerName}): ${err.message}`);
    // Fallback to placeholder on error
    if (providerName !== "placeholder") {
      console.log("   Falling back to placeholder...");
      return null;
    }
    throw err;
  }
}

export default { generateIllustration, IMAGE_PROVIDERS };
