// import Groq from 'groq-sdk';
// import dotenv from 'dotenv';
// dotenv.config();

// const client = new Groq({
//   apiKey: process.env.GROQ_API_KEY,
//   // If you use a Cloudflare AI Gateway, you can also set baseURL accordingly
// });

// export async function generateResponseWithGroq(systemPrompt, userInputs) {
//   const model = userInputs.model || 'compound-beta';

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
  

//   // Attempt to parse JSON from response
//   const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/```([\s\S]*?)```/);
//   let raw = jsonMatch ? jsonMatch[1] : content;

//   // Clean up any non-JSON parts (trailing commas, extra characters, etc.)
//     raw = raw.trim(); // Trim any unnecessary whitespace
//     if (raw.charAt(raw.length - 1) === ',') {
//       raw = raw.slice(0, -1); // Remove trailing commas if present
//     }
//   try {
//     return JSON.parse(raw);
//   } catch {
//     const start = raw.indexOf('{');
//     const end = raw.lastIndexOf('}');
//     if (start !== -1 && end !== -1 && end > start) {
//       return JSON.parse(raw.slice(start, end + 1));
//     }
//     throw new Error('Failed to parse JSON from Groq response');
//   }
// }

import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import JSON5 from 'json5';  // Import JSON5

dotenv.config();

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  // If you use a Cloudflare AI Gateway, you can also set baseURL accordingly
});

export async function generateResponseWithGroq(systemPrompt, userInputs) {
  const model = userInputs.model || 'compound-beta';

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(userInputs) }
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content from Groq');
  console.log("content from Groq: ", content);

  // Check for JSON format in content
  let raw;

  // Try to match the content in a code block format (` ```json ... ``` `)
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    raw = jsonMatch[1];  // Extract the JSON content from the code block
  } else {
    raw = content;  // Otherwise, assume it's raw JSON (array in this case)
  }

  // Trim and clean the raw content
  raw = raw.trim();  // Trim any unnecessary whitespace
  if (raw.charAt(raw.length - 1) === ',') {
    raw = raw.slice(0, -1);  // Remove trailing commas if present
  }

  try {
    // Use JSON5.parse instead of JSON.parse to handle lenient JSON
    return JSON5.parse(raw);  // Attempt to parse the cleaned-up JSON using JSON5
  } catch (err) {
    console.error('Error parsing JSON:', err);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const validJson = raw.slice(start, end + 1);
      return JSON5.parse(validJson);  // Try parsing valid JSON using JSON5 if possible
    }
    throw new Error('Failed to parse JSON from Groq response');
  }
}
