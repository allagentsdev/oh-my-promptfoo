export default class CiProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
  }

  id() {
    return "ci-fixture";
  }

  async callApi(prompt, context) {
    const mode = context?.vars?.mode ?? this.config.mode;
    if (mode === "throw") throw new Error("PRIVATE_TRANSPORT_REASON");
    if (mode === "error") return { error: "PRIVATE_PROVIDER_REASON" };
    if (mode === "grader-error") return { output: "PRIVATE_INVALID_GRADE" };
    return { output: prompt };
  }
}
