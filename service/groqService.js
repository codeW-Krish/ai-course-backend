import Groq from "groq-sdk";
import dotenv from "dotenv";
import JSON5 from "json5";

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
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content from Groq");

  console.log("Groq Response:", content);

  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  let raw = jsonMatch ? jsonMatch[1] : content;
  raw = raw.trim();
  if (raw.endsWith(",")) raw = raw.slice(0, -1);

  try {
    return JSON5.parse(raw);
  } catch (err) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON5.parse(raw.slice(start, end + 1));
    }
    throw new Error("Failed to parse JSON from Groq response");
  }
};  