import { generateResponseWithGemini } from "../service/geminiService.js";
import { generateResponseWithGroq } from "../service/groqService.js";
import { generateResponseWithCerebras } from "../service/cerebrasService.js";
import { generateResponseWithGLM } from "../service/glmService.js";

export const LLM_PROVIDERS = {
  Gemini: generateResponseWithGemini,
  Groq: generateResponseWithGroq,
  Cerebras: generateResponseWithCerebras,
  GLM: generateResponseWithGLM,
};

export const getLLMProvider = (provider = "Gemini", model) => {
  const fn = LLM_PROVIDERS[provider];
  if (!fn) {
    throw new Error(`LLM PROVIDER ${provider} NOT SUPPORTED`);
  }
  return (SYSTEM_PROMPT, userInputs) => {
    return fn(SYSTEM_PROMPT, { ...userInputs, model });
  };
};