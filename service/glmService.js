import { OpenAI } from "openai";
import dotenv from "dotenv";
import JSON5 from "json5";

dotenv.config();

const client = new OpenAI({
  apiKey: process.env.GLM_API_KEY,
  baseURL: "https://open.bigmodel.cn/api/paas/v4/", // GLM OpenAI-compatible endpoint
});

const defaultModel = process.env.GLM_MODEL || "glm-4-flash";

export const generateResponseWithGLM = async (systemPrompt, userInputs) => {
  const model = userInputs.model || defaultModel;

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userInputs) },
    ],
    stream: false,
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content from GLM");

  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i) ||
                    content.match(/```([\s\S]*?)```/i);
  const jsonStr = jsonMatch ? jsonMatch[1] : content;

  try {
    return JSON5.parse(jsonStr);
  } catch (e) {
    const start = jsonStr.indexOf("{");
    const end = jsonStr.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON5.parse(jsonStr.slice(start, end + 1));
    }
    throw new Error("Failed to parse JSON from GLM response");
  }
};