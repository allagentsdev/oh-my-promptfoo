/** A credential-free candidate for the fixed release regression example. */
export default class Normalizer {
  id() {
    return "name-normalizer";
  }

  async callApi(prompt) {
    return { output: prompt.trim().replace(/\s+/g, " ") };
  }
}
