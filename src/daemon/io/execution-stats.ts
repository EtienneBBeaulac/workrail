/**
 * Execution stats and outbox writers for daemon agent sessions.
 *
 * WHY this module: writeExecutionStats() and writeStuckOutboxEntry() are I/O
 * functions that write observability data to disk. They have no session state
 * or agent loop dependencies. They belong in the io/ layer.
 *
 * WHY both functions in one module: they both write to ~/.workrail/data/ or
 * ~/.workrail/ paths and are both fire-and-forget observability writers.
 * Co-locating them avoids two 30-line files.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeStatsSummary } from '../stats-summary.js';

/**
 * Directory that holds execution stats JSONL files written by writeExecutionStats().
 */
export const DAEMON_STATS_DIR = path.join(os.homedir(), '.workrail', 'data');

/**
 * Write a single execution-stats entry and regenerate the stats summary.
 *
 * Fire-and-forget: returns void, never throws, never awaited. A stats write
 * failure must never affect the session result -- this is observability data,
 * not crash recovery state.
 *
 * WHY module-level (not inline): the same logic is needed at 4 early-exit
 * paths (before the try block) and in the finally block. A single helper
 * eliminates duplication and guarantees all paths write the same schema.
 *
 * WHY chained .then() for writeStatsSummary: writeStatsSummary reads
 * execution-stats.jsonl and must include the record just appended above.
 * Chaining ensures the append completes before the read starts.
 */
export function writeExecutionStats(
  statsDir: string,
  sessionId: string,
  workflowId: string,
  startMs: number,
  outcome: 'success' | 'error' | 'timeout' | 'stuck' | 'unknown',
  stepCount: number,
): void {
  const endMs = Date.now();
  const statsPath = path.join(statsDir, 'execution-stats.jsonl');
  fs.mkdir(statsDir, { recursive: true })
    .then(() => fs.appendFile(
      statsPath,
      JSON.stringify({
        sessionId,
        workflowId,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        outcome,
        stepCount,
        ts: new Date().toISOString(),
      }) + '\n',
      'utf8',
    ))
    .then(() => { writeStatsSummary(statsDir).catch(() => {}); })
    .catch(() => {}); // best-effort -- never propagate
}

/**
 * Append a stuck-escalation entry to ~/.workrail/outbox.jsonl.
 *
 * WHY fire-and-forget (called as void): outbox write is best-effort. A failed
 * write must never affect the session result or abort the turn_end subscriber.
 *
 * WHY a separate helper: keeps the turn_end subscriber readable. The outbox write
 * requires async fs operations that would add noise inside the subscriber.
 */
export async function writeStuckOutboxEntry(opts: {
  workflowId: string;
  reason: 'repeated_tool_call' | 'no_progress' | 'stall';
  issueSummaries?: readonly string[];
}): Promise<void> {
  try {
    const outboxPath = path.join(os.homedir(), '.workrail', 'outbox.jsonl');
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    const entry = JSON.stringify({
      id: randomUUID(),
      kind: 'stuck',
      message:
        `Session stuck (${opts.reason}): workflowId=${opts.workflowId}` +
        (opts.issueSummaries && opts.issueSummaries.length > 0
          ? ` -- issues: ${opts.issueSummaries.join('; ')}`
          : ''),
      timestamp: new Date().toISOString(),
      workflowId: opts.workflowId,
      reason: opts.reason,
      ...(opts.issueSummaries && opts.issueSummaries.length > 0
        ? { issueSummaries: opts.issueSummaries }
        : {}),
    });
    await fs.appendFile(outboxPath, entry + '\n');
  } catch (err) {
    console.warn(
      `[WorkflowRunner] Could not write stuck outbox entry: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
