import { OpenAI } from "openai";
import dotenv from "dotenv";
import { parseJsonResponse } from "../utils/jsonParser.js";

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

  console.log("RAW response from GLM: ", content);
  return parseJsonResponse(content);
};