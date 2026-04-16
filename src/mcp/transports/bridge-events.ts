/**
 * Bridge connection event log — append-only JSONL at ~/.workrail/bridge.log.
 *
 * Records the lifecycle of each bridge process so that post-mortem diagnosis
 * can reconstruct exactly what happened: when it connected, when it lost
 * connection, how many reconnect attempts it made, whether it spawned a
 * primary, and why it ultimately shut down.
 *
 * Without this log, diagnosing orphaned high-CPU bridge processes requires
 * reading stale CPU stats and guessing at the state machine. With it, the
 * history is immediate and unambiguous.
 *
 * Format: one JSON object per line (JSONL), appended synchronously.
 * Each entry carries ts, pid, and event plus event-specific fields.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const BRIDGE_LOG_PATH = join(homedir(), '.workrail', 'bridge.log');
const BRIDGE_LOG_MAX_BYTES = 512 * 1024; // 512 KB

// ---------------------------------------------------------------------------
// Event types — sealed union so all callers are exhaustive
// ---------------------------------------------------------------------------

export type BridgeEvent =
  | { readonly kind: 'started'; readonly primaryPort: number; readonly ppid: number }
  | { readonly kind: 'connected'; readonly primaryPort: number }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'reconnect_attempt'; readonly attempt: number; readonly maxAttempts: number }
  | { readonly kind: 'reconnected'; readonly attempt: number }
  | { readonly kind: 'spawn_primary'; readonly port: number }
  | { readonly kind: 'spawn_skipped'; readonly reason: string }
  | { readonly kind: 'spawn_lock_acquired'; readonly port: number }
  | { readonly kind: 'spawn_lock_skipped'; readonly reason: string }
  | { readonly kind: 'budget_exhausted'; readonly budgetUsed: number; readonly respawnBudget: number }
  | { readonly kind: 'waiting_for_primary'; readonly port: number }
  | { readonly kind: 'primary_found_after_wait'; readonly port: number }
  | { readonly kind: 'reconnect_loop_error'; readonly message: string; readonly stack: string | null }
  | { readonly kind: 'shutdown'; readonly reason: string }
  /**
   * Fired when a bridge detects it has outlived its original primary session.
   * The bridge connected to a primary with PID `expectedPid`, but on reconnect
   * it found a different primary with PID `actualPid`. The bridge exits cleanly
   * rather than hijacking the new session.
   */
  | { readonly kind: 'orphaned'; readonly expectedPid: number; readonly actualPid: number };

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append a bridge lifecycle event to ~/.workrail/bridge.log.
 *
 * Uses synchronous I/O so entries are written even if the process crashes
 * immediately after. Silently no-ops on any write error — never throws.
 */
export function logBridgeEvent(event: BridgeEvent): void {
  try {
    mkdirSync(join(homedir(), '.workrail'), { recursive: true });

    // Rotate if oversized
    try {
      const { statSync } = require('fs') as typeof import('fs');
      if (statSync(BRIDGE_LOG_PATH).size > BRIDGE_LOG_MAX_BYTES) {
        const { writeFileSync } = require('fs') as typeof import('fs');
        writeFileSync(BRIDGE_LOG_PATH, '');
      }
    } catch { /* file doesn't exist yet */ }

    const entry = { ts: new Date().toISOString(), pid: process.pid, ...event };
    appendFileSync(BRIDGE_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* log write failed — silently ignore */ }
}
