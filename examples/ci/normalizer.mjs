/** A credential-free candidate for the fixed release regression example. */
export default class Normalizer {
  id() {
    return "name-normalizer";
  }

  async callApi(prompt) {
    // This local string operation makes no model requests.
    return {
      output: prompt.trim().replace(/\s+/g, " "),
      cost: 0,
      tokenUsage: { total: 0, prompt: 0, completion: 0, cached: 0, numRequests: 0 },
    };
  }
}
