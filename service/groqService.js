import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import JSON5 from 'json5';  // Import JSON5
import ILLMProvider from '../providers/ILLMProvider.js';

dotenv.config();

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY2,
  // If you use a Cloudflare AI Gateway, you can also set baseURL accordingly
});

export default class GroqProvider extends ILLMProvider{
  async streamContent(systemPrompt, userInputs, onChunk, onError){
    const model = userInputs.model || "moonshotai/kimi-k2-instruct";
      try {
          const stream = await client.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: JSON.stringify(userInputs) }
            ],
            stream: true,
          });

          let buffer = "";
          let chunkCount = 0;
          let nonEmptyChunkCount = 0;
          let sentenceCount = 0;
          
          console.log(`Starting Groq stream for: ${userInputs.subtopic_title}`);
          
          for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || "";
            chunkCount++;
            // Only send non-empty chunks and filter out empty ones
            if (content && content.trim() !== '') {
              buffer += content;
              nonEmptyChunkCount++;

               const shouldSend = 
                content.includes('.') || 
                content.includes('\n') || 
                buffer.length >= 80 || // Send every ~80 characters
                content.includes('!') || 
                content.includes('?');
              
              if (shouldSend && buffer.trim().length > 0) {
                sentenceCount++;
                console.log(`Sending meaningful chunk ${sentenceCount}: "${buffer.trim()}"`);
                onChunk(buffer);
                buffer = ""; // Reset buffer
              }
              
              // Add small delay to make streaming visible
              // await new Promise(resolve => setTimeout(resolve, 10));
            }
          }

          // Send any remaining content
        if (buffer.trim().length > 0) {
            console.log(`Sending final chunk: "${buffer.trim()}"`);
            onChunk(buffer);
        }

        console.log(`Stream complete: ${chunkCount} total chunks, ${nonEmptyChunkCount} non-empty chunks`);
        // If no chunks were sent but we have content, send it all
        if (nonEmptyChunkCount === 0 && buffer) {
          console.log("No chunks were sent during streaming, sending complete buffer");
          onChunk(buffer);
        }

        // return this.parseJson(buffer);
      } catch (err) {
          onError(err);
          throw err;
      }
    }

  
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


// export async function generateResponseWithGroq(systemPrompt, userInputs) {

//   const response = await client.chat.completions.create({
//     model,
//     messages: [
//       { role: 'system', content: systemPrompt },
//       { role: 'user', content: JSON.stringify(userInputs) }
//     ],
//   });

//   const content = response.choices?.[0]?.message?.content;
//   if (!content) throw new Error('No content from Groq');
//   console.log("content from Groq: ", content);

//   // Check for JSON format in content
//   let raw;

//   // Try to match the content in a code block format (` ```json ... ``` `)
//   const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
//   if (jsonMatch) {
//     raw = jsonMatch[1];  // Extract the JSON content from the code block
//   } else {
//     raw = content;  // Otherwise, assume it's raw JSON (array in this case)
//   }

//   // Trim and clean the raw content
//   raw = raw.trim();  // Trim any unnecessary whitespace
//   if (raw.charAt(raw.length - 1) === ',') {
//     raw = raw.slice(0, -1);  // Remove trailing commas if present
//   }

//   try {
//     // Use JSON5.parse instead of JSON.parse to handle lenient JSON
//     return JSON5.parse(raw);  // Attempt to parse the cleaned-up JSON using JSON5
//   } catch (err) {
//     console.error('Error parsing JSON:', err);
//     const start = raw.indexOf('{');
//     const end = raw.lastIndexOf('}');
//     if (start !== -1 && end !== -1 && end > start) {
//       const validJson = raw.slice(start, end + 1);
//       return JSON5.parse(validJson);  // Try parsing valid JSON using JSON5 if possible
//     }
//     throw new Error('Failed to parse JSON from Groq response');
//   }
// }
