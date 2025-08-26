import dotenv from "dotenv";
import {GoogleGenerativeAI} from "@google/generative-ai";
dotenv.config();

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);   
const model = genAI.getGenerativeModel({model: MODEL});

export const generateOutlineWithGemini= async(systemPrompt, userInputs) => {
    const prompt = `
        ${systemPrompt}

        User Input JSON:
        ${JSON.stringify(userInputs, null, 2)}
    `.trim();

    const result = await model.generateContent(prompt);
    const text = result.response.text();

     const jsonMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/i);
     const jsonStr = jsonMatch ? jsonMatch[1] : text;

      let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    // last attempt: remove leading/trailing prose
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      parsed = JSON.parse(jsonStr.slice(firstBrace, lastBrace + 1));
    } else {
      throw new Error('Gemini did not return valid JSON.');
    }
  }

  return parsed;
}