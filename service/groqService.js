import Groq from "groq-sdk";
import dotenv from "dotenv";
import { parseJsonResponse } from "../utils/jsonParser.js";

dotenv.config();

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export const generateResponseWithGroq = async (systemPrompt, userInputs) => {
  const model = userInputs.model || "llama-3.3-70b-versatile";
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

  console.log("Groq Response:", content);
  return parseJsonResponse(content);
};  