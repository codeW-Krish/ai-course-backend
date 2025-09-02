import { LLMProvider } from "./LLMProvider.js";
import { generateOutlineWithGemini } from "../service/geminiService.js";

export class GeminiProvider extends LLMProvider{
    async generateSubtopicBatch(SYSTEM_PROMPT, batchInput){
        const response = await generateOutlineWithGemini(SYSTEM_PROMPT, batchInput);
        return response;
    }
}