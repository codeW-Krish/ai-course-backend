import Cerebras from "@cerebras/cerebras_cloud_sdk";
import dotenv from "dotenv";
import JSON5 from "json5";

dotenv.config();

const client = new Cerebras({
  apiKey: process.env.CEREBRAS_API_KEY,
});

const defaultModel = process.env.CEREBRAS_MODEL

export const generateResponseWithCerebras = async (systemPrompt, userInputs) => {
  const model = userInputs.model || defaultModel;

  const stream = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userInputs) },
    ],
    stream: true,
  });

  let responseContent = "";
  for await (const chunk of stream) {
    const chunkContent = chunk.choices?.[0]?.delta?.content || "";
    responseContent += chunkContent;
  }

  // Attempt to extract JSON from the response
  const jsonMatch =
    responseContent.match(/```json\s*([\s\S]*?)```/i) ||
    responseContent.match(/```([\s\S]*?)```/i);
  const jsonStr = jsonMatch ? jsonMatch[1] : responseContent;

  try {
    return JSON5.parse(jsonStr);
  } catch (e) {
    // Fallback: locate the first and last braces
    const start = jsonStr.indexOf("{");
    const end = jsonStr.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON5.parse(jsonStr.slice(start, end + 1));
    }
    throw new Error("Failed to parse JSON from Cerebras response");
  }
};
