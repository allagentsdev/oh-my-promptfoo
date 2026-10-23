export interface CallOptions {
  abortSignal?: AbortSignal;
}

export class Calls {
  private closed = false;
  private active = new Map<AbortController, Promise<unknown>>();
  protected execute<T>(
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Provider is closed"));
    if (signal?.aborted) return Promise.reject(new Error("Provider call aborted before execution"));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    // Start in a microtask so cleanup always sees the promise before execution begins.
    const call = Promise.resolve()
      .then(() => run(controller.signal))
      .finally(() => {
        signal?.removeEventListener("abort", abort);
        this.active.delete(controller);
      });
    this.active.set(controller, call);
    return call;
  }
  protected async stopCalls(): Promise<void> {
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled(this.active.values());
  }
}
