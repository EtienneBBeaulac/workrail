/**
 * TTL-based deduplication guard for trigger dispatches.
 *
 * Prevents duplicate dispatches for the same key within a configurable
 * time window. Cleanup-on-entry: stale entries are purged each time
 * shouldSkip() or record() is called, keeping memory bounded.
 *
 * WHY a class (not a plain Map): encapsulates cleanup-on-entry and TTL
 * logic so callers cannot forget to run cleanup before checking. The
 * compile-time dependency ensures new dispatch methods cannot bypass
 * dedup by omission.
 */
export class DispatchDeduplicator {
  private readonly _recent = new Map<string, number>();
  private readonly _ttlMs: number;

  constructor(ttlMs: number) {
    this._ttlMs = ttlMs;
  }

  /**
   * Returns true if the key was dispatched within the TTL window.
   * Runs cleanup-on-entry before checking.
   */
  shouldSkip(key: string): boolean {
    const now = Date.now();
    // Cleanup-on-entry: purge stale entries before checking/inserting.
    // WHY cleanup-on-entry (not a background timer): avoids async state, keeps the
    // implementation deterministic and trivially testable with vi.useFakeTimers().
    for (const [k, ts] of this._recent) {
      if (now - ts >= this._ttlMs) {
        this._recent.delete(k);
      }
    }
    const lastDispatch = this._recent.get(key);
    return lastDispatch !== undefined && now - lastDispatch < this._ttlMs;
  }

  /**
   * Record a dispatch for the given key at the current timestamp.
   * Runs cleanup-on-entry before recording.
   */
  record(key: string): void {
    const now = Date.now();
    // Cleanup-on-entry: purge stale entries before recording.
    for (const [k, ts] of this._recent) {
      if (now - ts >= this._ttlMs) {
        this._recent.delete(k);
      }
    }
    this._recent.set(key, now);
  }
}
