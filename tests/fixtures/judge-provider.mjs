// A judge Promptfoo loads from an absolute file:// id. It scores the metrics in
// config.scores and reports the id and config it was constructed with.
export default class JudgeFixture {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.providerId = options.id ?? "judge-fixture";
  }

  id() {
    return this.providerId;
  }

  async callApi(_prompt, context) {
    const scores = this.config.scores ?? { accuracy: 1, clarity: 1 };
    const reason = this.config.reason ?? "Fixture";
    return {
      output: JSON.stringify({
        components: Object.entries(scores).map(([metric, score]) => ({
          metric,
          score,
          reason: `${reason} graded ${metric}`,
        })),
      }),
      metadata: {
        fixture: { id: this.providerId, config: this.config, label: context?.prompt?.label },
      },
    };
  }
}
