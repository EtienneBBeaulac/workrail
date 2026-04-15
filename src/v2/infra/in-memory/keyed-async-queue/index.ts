/**
 * Per-key async serialization queue.
 *
 * Ensures that concurrent calls to `enqueue()` with the same key are executed
 * serially (FIFO). Calls with different keys run concurrently.
 *
 * Used by the WorkRail autonomous daemon to prevent token corruption when
 * multiple triggers fire concurrently for the same session.
 *
 * Design: dual-promise pattern.
 * - The void chain (`Map<string, Promise<void>>`) serializes execution.
 * - A separate result promise returns `T` to the caller.
 * - A `.catch(() => {})` on the void chain prevents a failing `fn()` from
 *   breaking the chain for subsequent enqueues on the same key.
 * - The `.finally()` identity check avoids premature cleanup when a new
 *   enqueue arrives while the current one is finishing.
 */
export class KeyedAsyncQueue {
  private readonly queues = new Map<string, Promise<void>>();

  enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const tail: Promise<void> = (this.queues.get(key) ?? Promise.resolve())
      .then(() => fn())
      .then(resolve, reject)
      .catch(() => {
        // Swallow on the void chain so subsequent enqueues are not blocked.
        // The error already propagated to the caller via `result`.
      })
      .finally(() => {
        // Only clean up if no newer enqueue has replaced this tail.
        if (this.queues.get(key) === tail) {
          this.queues.delete(key);
        }
      });

    this.queues.set(key, tail);
    return result;
  }

  /** Number of keys with active or pending work. Useful for testing. */
  get activeKeyCount(): number {
    return this.queues.size;
  }
}
