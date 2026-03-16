import Cerebras from "@cerebras/cerebras_cloud_sdk";
import dotenv from "dotenv";
import { parseJsonResponse } from "../utils/jsonParser.js";

dotenv.config();

const client = new Cerebras({
  apiKey: process.env.CEREBRAS_API_KEY,
});

const defaultModel = process.env.CEREBRAS_MODEL || "llama3.1-70b";

export const generateResponseWithCerebras = async (systemPrompt, userInputs) => {
  const model = userInputs.model || defaultModel;

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userInputs) },
    ]
  });

  const responseContent = completion.choices?.[0]?.message?.content || "";
  console.log("RAW response from Cerebras: ", responseContent);
  return parseJsonResponse(responseContent);
};
