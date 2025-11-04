import dotenv from "dotenv";
import OpenAI from "openai";
import JSON5 from "json5";

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.z.ai/api/paas/v4/", // ← uncomment for custom endpoint
});

export const generateResponseWithGLM = async (
  systemPrompt,
  userInputs
) => {
  const model =
    userInputs.model ?? process.env.GLM_MODEL ?? "glm-4.5-flash";

  const stream = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify(userInputs),
          },
        ],
      },
    ],
    stream: true,
  });

  let responseContent = "";
  let hasContent = false;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;

    // ---- SAFETY: COMPLETELY IGNORE reasoning_content ----
    if (delta?.reasoning_content) {
      // Do nothing – we **never** want thinking
      console.warn("Warning: Unexpected reasoning_content received (ignored):", delta.reasoning_content);
      continue;
    }

    // ---- ONLY collect real content ----
    if (delta?.content) {
      responseContent += delta.content;
      hasContent = true;
    }
  }

  // ---- If the model gave *nothing* but thinking, fail fast ----
  if (!hasContent) {
    throw new Error("Model returned no content (only reasoning or empty)");
  }

  // ---- Extract JSON from code blocks (same as before) ----
  const jsonMatch =
    responseContent.match(/```json\s*([\s\S]*?)```/i) ||
    responseContent.match(/```([\s\S]*?)```/i);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : responseContent.trim();

  // ---- Parse with JSON5 + brace fallback ----
  try {
    return JSON5.parse(jsonStr);
  } catch {
    const start = jsonStr.indexOf("{");
    const end = jsonStr.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON5.parse(jsonStr.slice(start, end + 1));
    }
    throw new Error("Failed to parse JSON from response");
  }
};