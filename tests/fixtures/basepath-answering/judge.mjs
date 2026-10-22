// Same relative path as basepath-failing/judge.mjs, but this suite's judge answers.
export default class AnsweringJudge {
  id() {
    return "basepath-judge";
  }

  async callApi() {
    return { output: "answered from its own suite" };
  }
}
