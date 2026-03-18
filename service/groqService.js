import Groq from "groq-sdk";
import dotenv from "dotenv";
import { parseJsonResponse } from "../utils/jsonParser.js";

dotenv.config();

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export const generateResponseWithGroq = async (systemPrompt, userInputs) => {
  const model = userInputs.model || "llama-3.3-70b-versatile";
  const traceId = `groq_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const startedAt = Date.now();

  console.log(`[${traceId}] Groq request start`);
  console.log(`[${traceId}] Model: ${model}`);
  console.log(`[${traceId}] response_format: json_object`);

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userInputs) },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content from Groq");

  const previewSize = 500;
  const head = content.slice(0, previewSize);
  const tail = content.slice(-previewSize);
  const hasSubscenesBang = content.includes("subscenes![") || content.includes('"subscenes![');

  console.log(`[${traceId}] Raw response chars: ${content.length}`);
  console.log(`[${traceId}] Contains malformed token subscenes![: ${hasSubscenesBang}`);
  console.log(`[${traceId}] Raw response head (${Math.min(previewSize, content.length)} chars):`, head);
  console.log(`[${traceId}] Raw response tail (${Math.min(previewSize, content.length)} chars):`, tail);

  try {
    const parsed = parseJsonResponse(content);
    const parseDuration = Date.now() - startedAt;
    const topLevelKeys = parsed && typeof parsed === "object" ? Object.keys(parsed).slice(0, 20) : [];

    console.log(`[${traceId}] Parsed successfully in ${parseDuration}ms`);
    console.log(`[${traceId}] Top-level keys: ${topLevelKeys.join(", ") || "(none)"}`);
    return parsed;
  } catch (err) {
    const parseDuration = Date.now() - startedAt;
    console.error(`[${traceId}] parseJsonResponse failed after ${parseDuration}ms: ${err.message}`);
    throw err;
  }
};  