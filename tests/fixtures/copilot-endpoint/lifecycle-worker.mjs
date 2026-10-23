// Adversarial IPC peer: exercise process failure and shutdown, never emulate SDK metadata.
let behavior;
process.on("message", ({ id, method, params }) => {
  if (method === "initialize") {
    behavior = params.token;
    if (behavior === "die") process.exit(23);
    if (behavior === "hang" || behavior === "hang-close") return;
    process.send({ id, ok: true });
  } else if (method === "close") {
    if (behavior === "hang-close") return;
    process.send({ id, ok: true });
    process.disconnect();
  } else if (behavior === "fail-secret") {
    process.send({ id, ok: false, error: "Bearer secret-credential\n at private-stack" });
  } else {
    process.exit(24);
  }
});
