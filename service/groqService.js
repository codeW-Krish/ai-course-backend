import Groq from 'groq-sdk';
import dotenv from 'dotenv';
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

  // Attempt to parse JSON from response
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/```([\s\S]*?)```/);
  const raw = jsonMatch ? jsonMatch[1] : content;

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error('Failed to parse JSON from Groq response');
  }
}
