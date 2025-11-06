import GeminiProvider from '../service/geminiService.js';
import GroqProvider from '../service/groqService.js';
import CerebrasProvider from '../service/cerebrasService.js';
import GLMProvider from '../service/glmService.js';

export const getLLMProvider = (providerName="Groq") => {
  const name = providerName.toLowerCase().trim();
  switch (name) {
    case 'gemini': return new GeminiProvider();
    case 'groq': return new GroqProvider();
    case 'cerebras': return new CerebrasProvider();
    case 'glm': case 'z.ai': return new GLMProvider();
    default: throw new Error(`Unknown provider: ${providerName}`);
  }
};