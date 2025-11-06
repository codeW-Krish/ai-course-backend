export default class ILLMProvider {
  /**
   * Stream content token-by-token
   * @param {string} systemPrompt
   * @param {object} userInputs
   * @param {(chunk: string) => void} onChunk
   * @param {(error: Error) => void} onError
   * @returns {Promise<object>} Final parsed JSON
   */
  async streamContent(systemPrompt, userInputs, onChunk, onError) {
    throw new Error("streamContent must be implemented");
  }
}