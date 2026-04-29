/**
 * TTL-based deduplication guard for trigger dispatches.
 *
 * Prevents duplicate dispatches for the same key within a configurable
 * time window. Cleanup-on-entry: stale entries are purged on each call,
 * keeping memory bounded without a background timer.
 *
 * WHY a class (not a plain Map): encapsulates cleanup-on-entry and TTL
 * logic so callers cannot forget to run cleanup before checking. The
 * compile-time dependency ensures new dispatch methods cannot bypass
 * dedup by omission.
 *
 * WHY checkAndRecord (not separate shouldSkip + record): a split API
 * runs cleanup twice per dispatch and creates an implicit caller obligation
 * (always call both in the right order). checkAndRecord is atomic: one
 * cleanup pass, one check, one record when not skipping.
 */
export class DispatchDeduplicator {
  private readonly _recent = new Map<string, number>();
  private readonly _ttlMs: number;

  constructor(ttlMs: number) {
    this._ttlMs = ttlMs;
  }

  /**
   * Check whether the key was dispatched within the TTL window and, if not,
   * record this dispatch.
   *
   * Returns true  -- key is within TTL, caller should skip this dispatch.
   * Returns false -- key is stale or new, dispatch recorded, caller should proceed.
   *
   * Cleanup-on-entry: stale entries are purged before the check so memory
   * stays bounded. WHY cleanup-on-entry (not a background timer): avoids async
   * state, keeps the implementation deterministic and testable with vi.useFakeTimers().
   */
  checkAndRecord(key: string): boolean {
    const now = Date.now();
    // Cleanup-on-entry: purge stale entries before checking/recording.
    for (const [k, ts] of this._recent) {
      if (now - ts >= this._ttlMs) {
        this._recent.delete(k);
      }
    }
    const lastDispatch = this._recent.get(key);
    if (lastDispatch !== undefined && now - lastDispatch < this._ttlMs) {
      return true; // skip
    }
    this._recent.set(key, now);
    return false; // proceed
  }
}
