// Same relative path as basepath-answering/judge.mjs, but this suite's judge is rate limited.
export default class RateLimitedJudge {
  id() {
    return "basepath-judge";
  }

  async callApi() {
    return { error: "API error: 429", metadata: { http: { status: 429 } } };
  }
}
