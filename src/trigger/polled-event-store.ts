/**
 * WorkRail Auto: Polled Event Store
 *
 * Tracks which external event IDs have already been processed by the polling
 * scheduler. Prevents re-firing workflows for the same event across daemon
 * restarts.
 *
 * Storage: one JSON file per trigger at:
 *   ~/.workrail/polled-events/<triggerId>.json
 *
 * Schema:
 *   { "processedIds": string[], "lastPollAt": string (ISO 8601) }
 *
 * Design notes:
 * - Per-trigger files: eliminates concurrent write races between multiple
 *   polling triggers firing at the same moment.
 * - Atomic writes: write to a .tmp file, then fs.rename(). Prevents partial
 *   writes from corrupting the state file.
 * - ID pruning: keeps the last MAX_PROCESSED_IDS entries to cap file growth.
 *   Older IDs are pruned on each save. 500 IDs is conservative -- GitLab MR
 *   IDs are project-scoped integers so collisions across projects are impossible.
 * - Fresh-start invariant: on corrupt or missing file, initialize with
 *   { processedIds: [], lastPollAt: now }. Using "now" as the default
 *   lastPollAt prevents a burst of dispatch() calls for all currently-open
 *   MRs on first start or after file corruption.
 * - Caller ordering: callers must call filterNew() to find unprocessed IDs,
 *   dispatch workflows, then call record() to persist the new IDs. This
 *   guarantees at-least-once delivery: if the process crashes between dispatch
 *   and record(), the IDs will be re-dispatched on the next poll cycle.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';
import type { TriggerId } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of processed event IDs stored per trigger.
 * When exceeded, the oldest IDs are pruned on save.
 * 500 is conservative -- MR IDs in a typical project rarely exceed this
 * across a reasonable time window.
 */
const MAX_PROCESSED_IDS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolledEventState {
  /** IDs of events that have been processed. Used for deduplication. */
  readonly processedIds: readonly string[];
  /**
   * ISO 8601 timestamp of the last successful poll.
   * Passed as `updated_after` in the next poll request.
   * Initialized to the current time on first start or after file corruption
   * (fresh-start invariant: never re-fire historical events).
   */
  readonly lastPollAt: string;
}

export type PolledEventStoreError =
  | { readonly kind: 'io_error'; readonly message: string }
  | { readonly kind: 'write_error'; readonly message: string };

// ---------------------------------------------------------------------------
// Storage path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the directory where polled-event state files are stored.
 * Defaults to ~/.workrail/polled-events/.
 * Override via WORKRAIL_HOME for testing.
 */
function polledEventsDir(env: Record<string, string | undefined> = process.env): string {
  const workrailHome = env['WORKRAIL_HOME'] ?? path.join(os.homedir(), '.workrail');
  return path.join(workrailHome, 'polled-events');
}

/**
 * Returns the file path for a trigger's polled-event state.
 * Example: ~/.workrail/polled-events/my-mr-trigger.json
 */
function stateFilePath(
  triggerId: TriggerId,
  env: Record<string, string | undefined> = process.env,
): string {
  // Sanitize triggerId to a safe filename (replace non-alphanumeric chars with _)
  const safeId = String(triggerId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(polledEventsDir(env), `${safeId}.json`);
}

// ---------------------------------------------------------------------------
// PolledEventStore class
// ---------------------------------------------------------------------------

/**
 * Manages per-trigger polled event state on disk.
 *
 * All public methods return Result<T, PolledEventStoreError> -- no throws.
 *
 * Usage pattern (at-least-once delivery):
 *   1. const newIds = await store.filterNew(triggerId, candidateIds)
 *   2. for each id in newIds: await router.dispatch(...)
 *   3. await store.record(triggerId, newIds)
 *
 * Do NOT record before dispatch. If you record first and the process crashes
 * before dispatch, the events are permanently lost. The at-least-once ordering
 * (dispatch first, record second) ensures a crash causes duplicate dispatches,
 * not silent misses.
 */
export class PolledEventStore {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  // ---------------------------------------------------------------------------
  // load: read state from disk
  //
  // Returns a fresh state with lastPollAt=now if the file does not exist or
  // cannot be parsed. This is the "fresh-start invariant" -- initializing
  // lastPollAt to the current time ensures the first poll only processes MRs
  // updated after the daemon starts, not all historical open MRs.
  // ---------------------------------------------------------------------------

  async load(triggerId: TriggerId): Promise<Result<PolledEventState, PolledEventStoreError>> {
    const filePath = stateFilePath(triggerId, this.env);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      const error = e as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        // File does not exist -- fresh start
        return ok(freshState());
      }
      return err({ kind: 'io_error', message: error.message ?? String(e) });
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isValidState(parsed)) {
        return ok({
          processedIds: parsed.processedIds,
          lastPollAt: parsed.lastPollAt,
        });
      }
      // Schema invalid -- treat as corruption, return fresh state
      console.warn(
        `[PolledEventStore] State file for trigger '${triggerId}' has unexpected schema. ` +
        `Starting fresh with lastPollAt=now to prevent burst firing.`,
      );
      return ok(freshState());
    } catch {
      // JSON parse error -- treat as corruption, return fresh state
      console.warn(
        `[PolledEventStore] Could not parse state file for trigger '${triggerId}'. ` +
        `Starting fresh with lastPollAt=now to prevent burst firing.`,
      );
      return ok(freshState());
    }
  }

  // ---------------------------------------------------------------------------
  // save: write state to disk atomically
  //
  // Writes to a .tmp file, then renames to the final path.
  // This prevents partial writes from corrupting the state file.
  // Prunes processedIds to the most recent MAX_PROCESSED_IDS entries.
  // ---------------------------------------------------------------------------

  async save(
    triggerId: TriggerId,
    state: PolledEventState,
  ): Promise<Result<void, PolledEventStoreError>> {
    const filePath = stateFilePath(triggerId, this.env);
    const dir = path.dirname(filePath);

    // Ensure directory exists
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      return err({ kind: 'write_error', message: `Failed to create directory ${dir}: ${String(e)}` });
    }

    // Prune processedIds to the last MAX_PROCESSED_IDS entries
    const pruned = state.processedIds.length > MAX_PROCESSED_IDS
      ? state.processedIds.slice(state.processedIds.length - MAX_PROCESSED_IDS)
      : state.processedIds;

    const serialized = JSON.stringify({ processedIds: pruned, lastPollAt: state.lastPollAt }, null, 2);

    // Atomic write: write to tmp, fsync(file), rename, fsync(dir)
    // This matches the session-store pattern: if power fails mid-write the tmp
    // file is incomplete but the target file is still intact (or fully updated).
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmpPath, serialized, 'utf8');
      // fsync the tmp file before rename so the data is durable on disk.
      // Without this, a power failure after rename could leave an empty or
      // partial file in place of the successfully-named target (Linux ext4 issue).
      const fh = await fs.open(tmpPath, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmpPath, filePath);
      // fsync the directory so the rename (directory entry update) is durable.
      // WHY: Windows does not support opening directory handles for fsync -- fs.open(dir, 'r')
      // throws EPERM on win32. The durable-write guarantee still holds: fsync(file) + rename
      // is already crash-safe, and NTFS makes rename atomic. Skip directory fsync on win32
      // to match the pattern in src/v2/infra/local/fs/index.ts fsyncDir().
      if (process.platform !== 'win32') {
        const dirFh = await fs.open(dir, 'r');
        try {
          await dirFh.sync();
        } finally {
          await dirFh.close();
        }
      }
      return ok(undefined);
    } catch (e) {
      // Clean up tmp file if it exists
      await fs.unlink(tmpPath).catch(() => undefined);
      return err({ kind: 'write_error', message: `Failed to save state for trigger '${triggerId}': ${String(e)}` });
    }
  }

  // ---------------------------------------------------------------------------
  // filterNew: return only IDs not already in processedIds
  //
  // Does NOT modify state -- the caller is responsible for calling record()
  // after dispatch to persist the new IDs (at-least-once ordering).
  // ---------------------------------------------------------------------------

  async filterNew(
    triggerId: TriggerId,
    candidateIds: readonly string[],
  ): Promise<Result<string[], PolledEventStoreError>> {
    if (candidateIds.length === 0) return ok([]);

    const stateResult = await this.load(triggerId);
    if (stateResult.kind === 'err') return stateResult;

    const processed = new Set(stateResult.value.processedIds);
    const newIds = candidateIds.filter(id => !processed.has(id));
    return ok(newIds);
  }

  // ---------------------------------------------------------------------------
  // record: add newly processed IDs to state and update lastPollAt
  //
  // Call this AFTER dispatching workflows -- never before.
  // See class docstring for at-least-once delivery ordering rationale.
  // ---------------------------------------------------------------------------

  async record(
    triggerId: TriggerId,
    newIds: readonly string[],
    lastPollAt: string,
  ): Promise<Result<void, PolledEventStoreError>> {
    if (newIds.length === 0) {
      // Still need to update lastPollAt even if no new events were found
      const stateResult = await this.load(triggerId);
      if (stateResult.kind === 'err') return stateResult;
      return this.save(triggerId, { ...stateResult.value, lastPollAt });
    }

    const stateResult = await this.load(triggerId);
    if (stateResult.kind === 'err') return stateResult;

    const existing = stateResult.value.processedIds;
    const combined = [...existing, ...newIds];

    return this.save(triggerId, { processedIds: combined, lastPollAt });
  }

  // ---------------------------------------------------------------------------
  // getLastPollAt: convenience helper for retrieving lastPollAt without filtering
  // ---------------------------------------------------------------------------

  async getLastPollAt(triggerId: TriggerId): Promise<string> {
    const stateResult = await this.load(triggerId);
    if (stateResult.kind === 'err') return new Date().toISOString();
    return stateResult.value.lastPollAt;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fresh initial state with lastPollAt set to the current time. */
function freshState(): PolledEventState {
  return {
    processedIds: [],
    lastPollAt: new Date().toISOString(),
  };
}

/** Type guard for a valid PolledEventState JSON object. */
function isValidState(value: unknown): value is { processedIds: string[]; lastPollAt: string } {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj['processedIds'])) return false;
  if (typeof obj['lastPollAt'] !== 'string') return false;
  // All processedIds must be strings
  if (!(obj['processedIds'] as unknown[]).every(id => typeof id === 'string')) return false;
  return true;
}
