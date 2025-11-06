import dotenv from "dotenv";
import {GoogleGenerativeAI} from "@google/generative-ai";
import JSON5 from 'json5';
import ILLMProvider from "../providers/ILLMProvider.js"
dotenv.config();

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);   

export default class GeminiProvider extends ILLMProvider{
 async streamContent(systemPrompt, userInputs, onChunk, onError) {
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.5-flash" });

  try {
    console.log(`🚀 Starting Gemini stream for: ${userInputs.subtopic_title}`);

    const prompt = `
      Respond ONLY with valid JSON. No markdown, no explanations.
      ${systemPrompt}
      User Input: ${JSON.stringify(userInputs)}
    `.trim();

    const result = await model.generateContentStream(prompt);

    let buffer = "";
    let chunkCount = 0;
    let nonEmptyChunkCount = 0;
    let sentenceCount = 0;

    for await (const chunk of result.stream) {
      const text = chunk.text() || "";
      chunkCount++;

      if (text && text.trim() !== "") {
        buffer += text;
        nonEmptyChunkCount++;

        const shouldPrint =
          text.includes(".") ||
          text.includes("\n") ||
          buffer.length >= 80 ||
          text.includes("!") ||
          text.includes("?");

        if (shouldPrint && buffer.trim().length > 0) {
          sentenceCount++;
          console.log(`🟢 Chunk ${sentenceCount}: "${buffer.trim()}"`);
          buffer = ""; // reset buffer for next chunk
        }
      }
    }

    // Print any remaining content
    if (buffer.trim().length > 0) {
      console.log(`🟣 Final chunk: "${buffer.trim()}"`);
    }

    console.log(
      `✅ Gemini stream complete — ${chunkCount} total chunks, ${nonEmptyChunkCount} non-empty`
    );

    // Do not parse or return anything for now (Groq-style logging only)
    // return this.parseJson(buffer);

  } catch (err) {
    console.error("❌ Gemini stream error:", err);
    onError(err);
    throw err;
  }
}


parseJson(text) {
  try {
    const jsonStr = this.extractJson(text);
    return JSON5.parse(jsonStr);
  } catch (err) {
    console.warn("⚠️ Primary JSON5.parse failed:", err.message);

    // Try cleaning trailing commas and partial content
    let cleaned = text
      .replace(/,\s*([\]}])/g, '$1')   // Remove trailing commas before } or ]
      .replace(/```json|```/g, '')     // Remove markdown fences
      .trim();

    // Attempt to isolate valid JSON portion
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      cleaned = cleaned.slice(start, end + 1);
    }

    try {
      return JSON5.parse(cleaned);  
    } catch (innerErr) {
      console.error("❌ Cleaned JSON parse also failed:", innerErr.message);
      console.error("➡️ Raw text snippet:\n", text.slice(0, 500));
      throw new Error("Gemini returned invalid JSON after all cleanup attempts.");
    }
  }
}

extractJson(text) {
  // Try to find fenced JSON (```json ... ```)
  const match =
    text.match(/```json\s*([\s\S]*?)```/i) ||
    text.match(/```([\s\S]*?)```/i);

  if (match) return match[1].trim();

  // Fall back to bracket slicing
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    return text.slice(start, end + 1).trim();
  }

  throw new Error("No JSON found in Gemini response.");
}

}

// export const generateResponseWithGemini= async(systemPrompt, userInputs) => {
//     const prompt = `
//          returns only valid JSON — no markdown, no prose, no explanations.Respond strictly in JSON format.
//         ${systemPrompt}

//         User Input JSON:
//         ${JSON.stringify(userInputs, null, 2)}
//     `.trim();

//     const result = await model.generateContent(prompt);
//     const text = result.response.text();
//     console.log("Raw Gemini Response: \n", text);
    

//      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/i);
//      const jsonStr = jsonMatch ? jsonMatch[1] : text;

//       let parsed;
//       try {
//         parsed = JSON5.parse(jsonStr);
//       } catch (e) {
//         console.warn("⚠️ Initial JSON.parse failed. Attempting to clean...");
//         const firstBrace = jsonStr.indexOf('{');
//         const lastBrace = jsonStr.lastIndexOf('}');
//         if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
//           const sliced = jsonStr.slice(firstBrace, lastBrace + 1);
//           try {
//             parsed = JSON.parse(sliced);
//           } catch (innerErr) {
//             console.error("❌ Cleaned JSON parse also failed:", innerErr.message);
//             console.error("➡️ Problematic JSON:\n", sliced);
//             throw new Error('Gemini returned invalid JSON even after cleaning.');
//           }
//         } else {
//           console.error("❌ JSON does not even contain proper braces.");
//           throw new Error('Gemini did not return any valid JSON block.');
//         }
//       }


//   return parsed;
// }