// A judge Promptfoo loads from file://; it answers with config.output and reports its id.
export default class FallbackFixtureJudge {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.providerId = options.id ?? "fallback-fixture-judge";
    this.label = options.label;
  }

  id() {
    return this.providerId;
  }

  async callApi() {
    return { output: this.config.output ?? "fixture verdict", metadata: { from: "fixture" } };
  }
}
