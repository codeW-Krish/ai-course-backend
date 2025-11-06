import ILLMProvider from "../providers/ILLMProvider.js";
import Cerebras from "@cerebras/cerebras_cloud_sdk";
import JSON5 from 'json5';
import dotenv from "dotenv";
dotenv.config();

const client = new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });
const DEFAULT_MODEL = process.env.CEREBRAS_MODEL || 'gpt-oss-120b';

export default class CerebrasProvider extends ILLMProvider {
  async streamContent(systemPrompt, userInputs, onChunk, onError) {
    const model = userInputs.model || DEFAULT_MODEL;

    try {
      const stream = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userInputs) },
        ],
        stream: true,
      });

      // let buffer = "";
      // for await (const chunk of stream) {
      //   const content = chunk.choices?.[0]?.delta?.content || "";
      //   if(content){
      //     buffer += content;
      //     onChunk(content);
      //   }
      // }
        let buffer = "";
        let hasSentContent = false;
        let chunkCount = 0;
        let nonEmptyChunkCount = 0;
      
        
        for await (const chunk of stream) {
            const content = chunk.choices?.[0]?.delta?.content || "";
            chunkCount++;

          // Filter out empty chunks and only send meaningful content
          if (content && content.trim().length > 0) {
              buffer += content;
              nonEmptyChunkCount++;
              console.log(`Sending chunk ${nonEmptyChunkCount}: "${content.substring(0, 30)}${content.length > 30 ? '...' : ''}"`);
              onChunk(content);
              hasSentContent = true;
            
            // Small delay to make streaming visible in UI
              await new Promise(resolve => setTimeout(resolve, 10));
          }
        }

        // If no content was streamed, send the final buffer at once
        if (!hasSentContent && buffer) {
            onChunk(buffer);
        }

        console.log(`Stream complete: ${chunkCount} total chunks, ${nonEmptyChunkCount} non-empty chunks`);
      
      // If no content was streamed but we have buffer, send it all at once
        if (nonEmptyChunkCount === 0 && buffer) {
          console.log("No chunks were sent during streaming, sending complete buffer");
          onChunk(buffer);
        }

      return this.parseJson(buffer);
    } catch (err) {
      onError(err);
      throw err;
    }
  }

  async generateContent(systemPrompt, userInputs){
    const model = userInputs.model || DEFAULT_MODEL;

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userInputs) },
      ],
      stream: false,
    });

      const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content returned from Cerebras");

  console.log("Cerebras raw response:", content.substring(0, 300) + "...");

  // --- JSON extraction logic (same as your Groq version) ---
  let raw;

  // Try to match JSON in a markdown code block (```json ... ```)
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    raw = jsonMatch[1];
  } else {
    raw = content; // Assume plain JSON
  }

  // Clean and sanitize
  raw = raw.trim();
  if (raw.endsWith(",")) {
    raw = raw.slice(0, -1);
  }

  // --- Parse safely using JSON5 ---
  try {
    const parsed = JSON5.parse(raw);
    console.log("✅ Successfully parsed Cerebras response as JSON");
    return parsed;
  } catch (err) {
    console.warn("⚠️ JSON5 parse failed, trying fallback extraction...");

    // Try to locate braces manually
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      const validJson = raw.slice(start, end + 1);
      try {
        const parsed = JSON5.parse(validJson);
        console.log("✅ Successfully parsed Cerebras JSON after fallback extraction");
        return parsed;
      } catch (innerErr) {
        console.error("❌ Fallback parse also failed:", innerErr);
        throw new Error("Failed to parse JSON from Cerebras response");
      }
    }

    console.error("❌ No valid JSON braces found in response");
    throw new Error("No JSON found in Cerebras response");
  }
}

  // async generateContent(systemPrompt, userInputs){
  //     const model = userInputs.model || DEFAULT_MODEL;

  //     const response = await client.chat.completions.create({
  //       model,
  //       messages: [
  //         { role: "system", content: systemPrompt },
  //         { role: "user", content: JSON.stringify(userInputs) },
  //       ],
  //       stream: false,
  //     });

  //   const responseContent = response.choices[0]?.message?.content || "";
    
  //   console.log("Cerebras non-streaming response received, length:", responseContent.length);
    
  //   // Return the raw string content
  //   return responseContent;


  //     // let responseContent = "";
  //     // for await (const chunk of stream) {
  //     //   const chunkContent = chunk.choices?.[0]?.delta?.content || "";
  //     //   responseContent += chunkContent;
  //     // }

  //     // // Attempt to extract JSON from the response
  //     // const jsonMatch =
  //     //   responseContent.match(/```json\s*([\s\S]*?)```/i) ||
  //     //   responseContent.match(/```([\s\S]*?)```/i);
  //     // const jsonStr = jsonMatch ? jsonMatch[1] : responseContent;

  //     // try {
  //     //   return JSON5.parse(jsonStr);
  //     // } catch (e) {
  //     //   // Fallback: locate the first and last braces
  //     //   const start = jsonStr.indexOf("{");
  //     //   const end = jsonStr.lastIndexOf("}");
  //     //   if (start !== -1 && end !== -1 && end > start) {
  //     //     return JSON5.parse(jsonStr.slice(start, end + 1));
  //     //   }
  //     //   throw new Error("Failed to parse JSON from Cerebras response");
  //     // }
  // }

  parseJson(text) {
      const jsonStr = this.extractJson(text);
      return JSON5.parse(jsonStr);
  }
  
  extractJson(text) {
      const match = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/i);
      if (match) return match[1].trim();

      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1) return text.slice(start, end + 1);
      throw new Error("No JSON found");
   }
}


// import Cerebras from "@cerebras/cerebras_cloud_sdk";
// import dotenv from "dotenv";
// import JSON5 from "json5";

// dotenv.config();

// const client = new Cerebras({
//   apiKey: process.env.CEREBRAS_API_KEY,
// });

// const defaultModel = process.env.CEREBRAS_MODEL

// export const generateResponseWithCerebras = async (systemPrompt, userInputs) => {
//   const model = userInputs.model || defaultModel;

//   const stream = await client.chat.completions.create({
//     model,
//     messages: [
//       { role: "system", content: systemPrompt },
//       { role: "user", content: JSON.stringify(userInputs) },
//     ],
//     stream: true,
//   });

//   let responseContent = "";
//   for await (const chunk of stream) {
//     const chunkContent = chunk.choices?.[0]?.delta?.content || "";
//     responseContent += chunkContent;
//   }

//   // Attempt to extract JSON from the response
//   const jsonMatch =
//     responseContent.match(/```json\s*([\s\S]*?)```/i) ||
//     responseContent.match(/```([\s\S]*?)```/i);
//   const jsonStr = jsonMatch ? jsonMatch[1] : responseContent;

//   try {
//     return JSON5.parse(jsonStr);
//   } catch (e) {
//     // Fallback: locate the first and last braces
//     const start = jsonStr.indexOf("{");
//     const end = jsonStr.lastIndexOf("}");
//     if (start !== -1 && end !== -1 && end > start) {
//       return JSON5.parse(jsonStr.slice(start, end + 1));
//     }
//     throw new Error("Failed to parse JSON from Cerebras response");
//   }
// };
