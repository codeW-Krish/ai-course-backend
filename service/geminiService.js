import dotenv from "dotenv";
import {GoogleGenerativeAI} from "@google/generative-ai";
dotenv.config();

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);   
const model = genAI.getGenerativeModel({model: MODEL});

export const generateOutlineWithGemini= async(systemPrompt, userInputs) => {
    const prompt = `
         returns only valid JSON — no markdown, no prose, no explanations.Respond strictly in JSON format.
        ${systemPrompt}

        User Input JSON:
        ${JSON.stringify(userInputs, null, 2)}
    `.trim();

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    console.log("Raw Gemini Response: \n", text);
    

     const jsonMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/i);
     const jsonStr = jsonMatch ? jsonMatch[1] : text;

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        console.warn("⚠️ Initial JSON.parse failed. Attempting to clean...");
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          const sliced = jsonStr.slice(firstBrace, lastBrace + 1);
          try {
            parsed = JSON.parse(sliced);
          } catch (innerErr) {
            console.error("❌ Cleaned JSON parse also failed:", innerErr.message);
            console.error("➡️ Problematic JSON:\n", sliced);
            throw new Error('Gemini returned invalid JSON even after cleaning.');
          }
        } else {
          console.error("❌ JSON does not even contain proper braces.");
          throw new Error('Gemini did not return any valid JSON block.');
        }
      }


  return parsed;
}