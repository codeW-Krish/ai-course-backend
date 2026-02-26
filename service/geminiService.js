import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { parseJsonResponse } from "../utils/jsonParser.js";

dotenv.config();

const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL });

export const generateResponseWithGemini = async (systemPrompt, userInputs) => {
  const prompt = `
    returns only valid JSON — no markdown, no prose, no explanations. Respond strictly in JSON format.
    ${systemPrompt}
    User Input JSON:
    ${JSON.stringify(userInputs, null, 2)}
  `.trim();

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  console.log("Raw Gemini Response:\n", text);
  return parseJsonResponse(text);
};

export const generateChatResponseWithGemini = async (systemPrompt, userMessages) => {
  // userMessages can be a simple string or an array of history. 
  // keeping it simple for now: systemPrompt combines context + user query.

  try {
    const result = await model.generateContent(systemPrompt);
    const text = result.response.text();
    return text;
  } catch (error) {
    console.error("Gemini Chat Error:", error);
    throw new Error("Failed to generate chat response");
  }
}