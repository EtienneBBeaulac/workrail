/**
 * WorkRail Auto: Polled Event Store
 *
 * Persists the set of already-processed event IDs and the last poll timestamp
 * for each polling trigger. Prevents duplicate workflow dispatches across poll cycles.
 *
 * Storage: $WORKRAIL_HOME/polled-events/<triggerId>.json
 * Format: { processedIds: string[], lastPollAt: string (ISO 8601) }
 *
 * Design notes:
 * - Atomic write: write to .tmp then rename -- no partial writes.
 * - load() returns fresh state on ENOENT, corrupt JSON, or schema mismatch.
 *   Never propagates I/O errors to the caller.
 * - save() prunes processedIds to the last MAX_PROCESSED_IDS entries (most recent).
 * - filterNew() returns only IDs not in the current processedIds set.
 * - record() appends new IDs and updates lastPollAt atomically.
 * - getLastPollAt() returns the stored lastPollAt, or approximately now if absent.
 *
 * Invariants:
 * - processedIds never exceeds MAX_PROCESSED_IDS entries after a save().
 * - "Last N" pruning: old IDs are dropped from the front (index 0 = oldest).
 * - Atomic write ensures the file is never in a partially-written state.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';
import type { TriggerId } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of processed IDs retained per trigger. */
const MAX_PROCESSED_IDS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolledEventState {
  readonly processedIds: string[];
  readonly lastPollAt: string;
}

export type PolledEventStoreError =
  | { readonly kind: 'io_error'; readonly message: string };

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function isPolledEventState(value: unknown): value is PolledEventState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v['processedIds']) &&
    v['processedIds'].every((id: unknown) => typeof id === 'string') &&
    typeof v['lastPollAt'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// PolledEventStore
// ---------------------------------------------------------------------------

export class PolledEventStore {
  private readonly dataDir: string;

  constructor(env: { WORKRAIL_HOME: string }) {
    this.dataDir = path.join(env.WORKRAIL_HOME, 'polled-events');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private statePath(triggerId: TriggerId): string {
    return path.join(this.dataDir, `${triggerId}.json`);
  }

  private freshState(): PolledEventState {
    return {
      processedIds: [],
      lastPollAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // load
  // ---------------------------------------------------------------------------

  /**
   * Load the persisted state for a trigger.
   *
   * Returns fresh state (empty processedIds, lastPollAt ≈ now) on:
   * - ENOENT (first run for this trigger)
   * - Corrupt JSON
   * - Schema mismatch (missing or wrong-typed fields)
   *
   * Never returns err. The Result wrapper is kept for API consistency.
   */
  async load(triggerId: TriggerId): Promise<Result<PolledEventState, PolledEventStoreError>> {
    const filePath = this.statePath(triggerId);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isPolledEventState(parsed)) {
        return ok(parsed);
      }
      // Schema mismatch: return fresh state
      return ok(this.freshState());
    } catch (e: unknown) {
      const isEnoent =
        e instanceof Error &&
        'code' in e &&
        (e as NodeJS.ErrnoException).code === 'ENOENT';
      if (isEnoent) {
        // First run for this trigger
        return ok(this.freshState());
      }
      // Corrupt JSON or other I/O error: return fresh state
      // WHY: poll state is a cache, not source of truth. Losing it means
      // re-processing some events once -- acceptable vs. crashing.
      return ok(this.freshState());
    }
  }

  // ---------------------------------------------------------------------------
  // save
  // ---------------------------------------------------------------------------

  /**
   * Persist state for a trigger, pruning processedIds to at most MAX_PROCESSED_IDS entries.
   *
   * Uses atomic write (tmp file + rename) to prevent partial writes.
   * Creates the polled-events directory if it does not exist.
   */
  async save(
    triggerId: TriggerId,
    state: PolledEventState,
  ): Promise<Result<void, PolledEventStoreError>> {
    await fs.mkdir(this.dataDir, { recursive: true });

    // Prune to last MAX_PROCESSED_IDS (most recent entries)
    const pruned: PolledEventState = {
      processedIds:
        state.processedIds.length > MAX_PROCESSED_IDS
          ? state.processedIds.slice(state.processedIds.length - MAX_PROCESSED_IDS)
          : state.processedIds,
      lastPollAt: state.lastPollAt,
    };

    const filePath = this.statePath(triggerId);
    const tmpPath = `${filePath}.tmp`;

    try {
      await fs.writeFile(tmpPath, JSON.stringify(pruned, null, 2), 'utf8');
      await fs.rename(tmpPath, filePath);
      return ok(undefined);
    } catch (e: unknown) {
      return err({
        kind: 'io_error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // filterNew
  // ---------------------------------------------------------------------------

  /**
   * Return only the candidate IDs that are NOT already in processedIds.
   *
   * Loads state from disk on each call to ensure freshness.
   */
  async filterNew(
    triggerId: TriggerId,
    candidateIds: string[],
  ): Promise<Result<string[], PolledEventStoreError>> {
    if (candidateIds.length === 0) return ok([]);

    const loadResult = await this.load(triggerId);
    // load() never returns err -- safe to use .value directly
    const state = loadResult.kind === 'ok' ? loadResult.value : this.freshState();

    const processed = new Set(state.processedIds);
    return ok(candidateIds.filter((id) => !processed.has(id)));
  }

  // ---------------------------------------------------------------------------
  // record
  // ---------------------------------------------------------------------------

  /**
   * Append newIds to processedIds and update lastPollAt.
   *
   * Loads current state, merges, then saves. Atomic write ensures no partial update.
   * Updates lastPollAt even when newIds is empty.
   */
  async record(
    triggerId: TriggerId,
    newIds: string[],
    lastPollAt: string,
  ): Promise<Result<void, PolledEventStoreError>> {
    const loadResult = await this.load(triggerId);
    const current = loadResult.kind === 'ok' ? loadResult.value : this.freshState();

    const merged: PolledEventState = {
      processedIds: [...current.processedIds, ...newIds],
      lastPollAt,
    };

    return this.save(triggerId, merged);
  }

  // ---------------------------------------------------------------------------
  // getLastPollAt
  // ---------------------------------------------------------------------------

  /**
   * Return the stored lastPollAt timestamp for a trigger.
   *
   * Returns approximately now when no state exists (fresh start).
   */
  async getLastPollAt(triggerId: TriggerId): Promise<string> {
    const loadResult = await this.load(triggerId);
    const state = loadResult.kind === 'ok' ? loadResult.value : this.freshState();
    return state.lastPollAt;
  }
}
