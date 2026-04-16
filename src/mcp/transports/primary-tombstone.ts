/**
 * Primary tombstone: advisory coordination file written by the primary on CLEAN shutdown.
 *
 * WHY: When a primary exits cleanly (stdin EOF, SIGHUP), bridges that were
 * connected to it know the death was intentional. Without the tombstone, those
 * bridges burn through a full rapid-reconnect cycle (8 attempts, ~10s) before
 * entering slow-poll mode. The tombstone lets them short-circuit to slow-poll
 * immediately, reducing reconnect noise.
 *
 * ADVISORY: The tombstone is strictly optional. If it is missing (crash death,
 * SIGKILL, permission error), bridges fall back to the normal reconnect loop.
 * Never rely on it for correctness -- only for latency optimization.
 *
 * LIFECYCLE:
 *   primary starts  → clearTombstone() (remove stale tombstone from previous run)
 *   primary dies cleanly → writeTombstone(port, pid)
 *   bridge detects tombstone → enters slow-poll immediately
 *   new primary starts → clearTombstone()
 *
 * FORMAT: JSON, synchronous I/O only (writeFileSync / readFileSync) so the file
 * is on disk before any async teardown begins.
 */

import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrimaryTombstone {
  readonly pid: number;
  readonly port: number;
  readonly diedAt: string; // ISO-8601 timestamp
}

// Injectable sync FS primitives for testability.
// Production callers use the real fs module; tests inject stubs.
export type WriteSyncLike = (path: string, content: string) => void;
export type ReadSyncLike = (path: string, encoding: 'utf-8') => string;
export type UnlinkSyncLike = (path: string) => void;
export type MkdirSyncLike = (path: string, opts: { recursive: true }) => void;

export interface TombstoneDeps {
  readonly writeSync?: WriteSyncLike;
  readonly readSync?: ReadSyncLike;
  readonly unlinkSync?: UnlinkSyncLike;
  readonly mkdirSync?: MkdirSyncLike;
}

// ---------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------

/**
 * Tombstone path is global (not per-port) because there is only one primary
 * at a time on a given machine. If the port changes between runs the pid
 * field still uniquely identifies the dead primary.
 */
export function tombstonePath(): string {
  return join(homedir(), '.workrail', 'primary.tombstone');
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write the tombstone file synchronously.
 *
 * Must be called with synchronous I/O so the file is on disk before any
 * async shutdown handlers run (a bridge may already be reconnecting by
 * the time async code could execute).
 *
 * Silently ignores errors -- tombstone is advisory only.
 */
export function writeTombstone(port: number, pid: number, deps: TombstoneDeps = {}): void {
  try {
    const mkdirFn = deps.mkdirSync ?? mkdirSync;
    mkdirFn(join(homedir(), '.workrail'), { recursive: true });

    const writeFn = deps.writeSync ?? writeFileSync;
    const tombstone: PrimaryTombstone = {
      pid,
      port,
      diedAt: new Date().toISOString(),
    };
    writeFn(tombstonePath(), JSON.stringify(tombstone, null, 2));
  } catch {
    // Advisory -- silently ignore all errors.
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read the tombstone file synchronously.
 *
 * Returns the tombstone if it exists and is valid JSON, or null otherwise.
 * Never throws.
 */
export function readTombstone(deps: TombstoneDeps = {}): PrimaryTombstone | null {
  try {
    const readFn = deps.readSync ?? readFileSync;
    const content = readFn(tombstonePath(), 'utf-8');
    const parsed = JSON.parse(content) as Partial<PrimaryTombstone>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      typeof parsed.diedAt === 'string'
    ) {
      return parsed as PrimaryTombstone;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

/**
 * Remove the tombstone file synchronously.
 *
 * Called by the primary on startup to clear the previous tombstone.
 * Silently ignores ENOENT (no tombstone to clear) and all other errors.
 */
export function clearTombstone(deps: TombstoneDeps = {}): void {
  try {
    const unlinkFn = deps.unlinkSync ?? unlinkSync;
    unlinkFn(tombstonePath());
  } catch {
    // ENOENT or any other error -- silently ignore.
  }
}
