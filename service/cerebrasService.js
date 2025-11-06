import Cerebras from "@cerebras/cerebras_cloud_sdk";
import dotenv from "dotenv";
import JSON5 from "json5";

dotenv.config();

const client = new Cerebras({
  apiKey: process.env.CEREBRAS_API_KEY,
});

const defaultModel = process.env.CEREBRAS_MODEL || "llama3.1-70b";

export const generateResponseWithCerebras = async (systemPrompt, userInputs) => {
  const model = userInputs.model || defaultModel;

  // Fetch the full response at once (stream removed)
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userInputs) },
    ]
  });

  const responseContent = completion.choices?.[0]?.message?.content || "";
  console.log("RAW response from Cerebras: ", responseContent);
  
  const jsonMatch = responseContent.match(/```json\s*([\s\S]*?)```/i) ||
                    responseContent.match(/```([\s\S]*?)```/i);
  const jsonStr = jsonMatch ? jsonMatch[1] : responseContent;

  try {
    return JSON5.parse(jsonStr);
  } catch (e) {
    const start = jsonStr.indexOf("{");
    const end = jsonStr.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON5.parse(jsonStr.slice(start, end + 1));
    }
    throw new Error("Failed to parse JSON from Cerebras response");
  }
};
