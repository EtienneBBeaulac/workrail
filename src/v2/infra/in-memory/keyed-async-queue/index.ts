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

  /**
   * Per-key pending dispatch counter.
   *
   * WHY a separate Map (not derived from `queues`): `queues` tracks the tail promise
   * for serialization, not a count. A single entry in `queues` may represent any number
   * of chained dispatches. The counter increments synchronously at the top of enqueue()
   * (before the promise chain is constructed) so callers can read an accurate depth
   * synchronously between enqueue() calls -- the single-threaded JS event loop guarantees
   * no race between the read and the increment.
   *
   * The counter decrements unconditionally at the start of the .finally() block (before
   * the tail identity check). Every increment has exactly one corresponding decrement.
   */
  private readonly _depths = new Map<string, number>();

  enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Increment synchronously before constructing the chain so depth() is accurate
    // from the caller's perspective immediately after enqueue() returns.
    this._depths.set(key, (this._depths.get(key) ?? 0) + 1);

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
        // Decrement unconditionally: every enqueue() that incremented must decrement
        // exactly once, regardless of whether this tail is still the current tail.
        // WHY before the identity check: the decrement is per-dispatch accounting;
        // the identity check below is per-key cleanup of the `queues` Map. They are
        // independent. Placing the decrement inside the identity-check branch would
        // cause under-decrement when a newer enqueue replaces the tail before this
        // .finally() fires.
        const prev = this._depths.get(key) ?? 0;
        if (prev <= 1) {
          this._depths.delete(key);
        } else {
          this._depths.set(key, prev - 1);
        }

        // Only clean up if no newer enqueue has replaced this tail.
        if (this.queues.get(key) === tail) {
          this.queues.delete(key);
        }
      });

    this.queues.set(key, tail);
    return result;
  }

  /**
   * Number of pending (enqueued but not yet complete) dispatches for the given key.
   *
   * Returns 0 if no dispatches are pending for this key.
   * Includes the currently-executing dispatch (if any) in the count.
   *
   * WHY: used by TriggerRouter.route() to check queue depth before accepting a
   * new dispatch for a serial-mode trigger. The count is accurate to read synchronously
   * between route() calls because the JS event loop is single-threaded.
   */
  depth(key: string): number {
    return this._depths.get(key) ?? 0;
  }

  /** Number of keys with active or pending work. Useful for testing. */
  get activeKeyCount(): number {
    return this.queues.size;
  }
}
