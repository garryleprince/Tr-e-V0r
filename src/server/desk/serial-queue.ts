/**
 * Serialises async work: each task starts only after the previous one settled.
 *
 * A Durable Object only blocks new events while it awaits its OWN storage; an
 * await on D1 or fetch lets another request interleave. This queue closes that
 * gap, so two proposals can never both pass an exposure check computed on the
 * same stale book (the TOCTOU race D1 alone could not prevent).
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
