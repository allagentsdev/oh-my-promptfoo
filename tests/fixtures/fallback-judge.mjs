// A judge Promptfoo loads from file://; it answers with config.output and reports its id,
// or fails with HTTP status config.fail.
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
    if (this.config.fail)
      return {
        error: `API error: ${this.config.fail}`,
        metadata: { http: { status: this.config.fail } },
      };
    return { output: this.config.output ?? "fixture verdict", metadata: { from: "fixture" } };
  }
}
