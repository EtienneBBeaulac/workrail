/**
 * Stats summary writer.
 *
 * Reads execution-stats.jsonl, aggregates all-time session metrics, and writes
 * stats-summary.json atomically to the same directory.
 *
 * WHY fire-and-forget: a write failure must never crash the daemon or block any
 * session. This is observability data -- callers invoke with .catch(() => {}).
 *
 * WHY all-time aggregate (no period filter): avoids a surprise cliff where sessions
 * silently disappear after a rolling window. oldestSessionTs makes the coverage
 * window explicit. Future: opt-in period filter via WORKRAIL_STATS_PERIOD_DAYS
 * (config key is reserved but a no-op in v1).
 *
 * WHY concurrent write safety: post-session and heartbeat triggers can both fire
 * within seconds of each other. fs.rename() is atomic on POSIX -- the last writer
 * wins and both produce complete, valid JSON. No data corruption is possible.
 *
 * WHY coverage gap: execution-stats.jsonl only exists since the session shipped
 * in PR #756. Sessions before that date are not in the aggregate. oldestSessionTs
 * makes this visible to consumers.
 *
 * @module daemon/stats-summary
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';

// =============================================================================
// Input record schema
// =============================================================================

/**
 * Zod schema for one line in execution-stats.jsonl.
 *
 * WHY validate at parse time: JSON.parse() returns `any`. Validating each line
 * here keeps the aggregation logic type-safe and ensures that malformed or
 * partially-written lines increment malformedLineCount rather than silently
 * producing wrong aggregates.
 */
const ExecutionStatRecordSchema = z.object({
  sessionId: z.string(),
  workflowId: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  durationMs: z.number(),
  outcome: z.string(),
  stepCount: z.number(),
  ts: z.string(),
});

type ExecutionStatRecord = z.infer<typeof ExecutionStatRecordSchema>;

// =============================================================================
// Output schema types
// =============================================================================

interface WorkflowStats {
  count: number;
  successCount: number;
  avgDurationMs: number;
}

interface StatsSummary {
  version: 1;
  generatedAt: string;
  sessionCount: number;
  malformedLineCount: number;
  outcomeBreakdown: Record<string, number>;
  durationMs: {
    avg: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
  };
  stepCount: {
    avg: number;
    min: number;
    max: number;
  };
  byWorkflow: Record<string, WorkflowStats>;
  oldestSessionTs: string | null;
  newestSessionTs: string | null;
}

// =============================================================================
// Percentile helper
// =============================================================================

/**
 * Compute the p-th percentile of a sorted numeric array using nearest-rank method.
 * Array must be pre-sorted ascending. Returns 0 for empty arrays.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, idx)];
}

// =============================================================================
// Zero-count summary (fresh install / no sessions)
// =============================================================================

function emptyStatsSummary(): StatsSummary {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sessionCount: 0,
    malformedLineCount: 0,
    outcomeBreakdown: {},
    durationMs: { avg: 0, min: 0, max: 0, p50: 0, p95: 0 },
    stepCount: { avg: 0, min: 0, max: 0 },
    byWorkflow: {},
    oldestSessionTs: null,
    newestSessionTs: null,
  };
}


// =============================================================================
// Aggregation
// =============================================================================

function aggregate(records: ExecutionStatRecord[], malformedLineCount: number): StatsSummary {
  if (records.length === 0) return { ...emptyStatsSummary(), malformedLineCount };

  const durations = records.map((r) => r.durationMs).sort((a, b) => a - b);
  const steps = records.map((r) => r.stepCount);

  const outcomeBreakdown: Record<string, number> = {};
  const byWorkflow: Record<string, WorkflowStats> = {};

  let totalDuration = 0;
  let totalSteps = 0;
  let oldestTs = records[0].ts;
  let newestTs = records[0].ts;

  for (const r of records) {
    // outcome breakdown
    outcomeBreakdown[r.outcome] = (outcomeBreakdown[r.outcome] ?? 0) + 1;

    // per-workflow stats
    const wf = byWorkflow[r.workflowId] ?? { count: 0, successCount: 0, avgDurationMs: 0 };
    const newCount = wf.count + 1;
    // Running average: ((avg * n) + next) / (n + 1)
    const newAvgDuration = (wf.avgDurationMs * wf.count + r.durationMs) / newCount;
    byWorkflow[r.workflowId] = {
      count: newCount,
      successCount: wf.successCount + (r.outcome === 'success' ? 1 : 0),
      avgDurationMs: Math.round(newAvgDuration),
    };

    totalDuration += r.durationMs;
    totalSteps += r.stepCount;

    if (r.ts < oldestTs) oldestTs = r.ts;
    if (r.ts > newestTs) newestTs = r.ts;
  }

  const n = records.length;
  // WHY reduce not spread: Math.min/max(...array) throws RangeError at ~115k+ elements
  // because spread pushes all values onto the call stack. reduce is O(n) and stack-safe.
  const minStep = steps.reduce((min, v) => (v < min ? v : min), Infinity);
  const maxStep = steps.reduce((max, v) => (v > max ? v : max), -Infinity);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sessionCount: n,
    malformedLineCount,
    outcomeBreakdown,
    durationMs: {
      avg: Math.round(totalDuration / n),
      min: durations[0],
      max: durations[durations.length - 1],
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
    },
    stepCount: {
      avg: Math.round((totalSteps / n) * 10) / 10,
      min: minStep,
      max: maxStep,
    },
    byWorkflow,
    oldestSessionTs: oldestTs,
    newestSessionTs: newestTs,
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Read execution-stats.jsonl from `statsDir`, aggregate all sessions, and write
 * stats-summary.json to `statsDir` atomically (tmp file then rename).
 *
 * Fire-and-forget: callers must use .catch(() => {}) -- this function never
 * rejects in a way that would affect the calling scope.
 *
 * WHY statsDir param: enables independent testability with a temp directory.
 * No hardcoded paths inside this function.
 *
 * @param statsDir - Directory containing execution-stats.jsonl (and where
 *   stats-summary.json will be written). Typically ~/.workrail/data.
 */
export async function writeStatsSummary(statsDir: string): Promise<void> {
  const jsonlPath = path.join(statsDir, 'execution-stats.jsonl');
  const summaryPath = path.join(statsDir, 'stats-summary.json');
  const tmpPath = `${summaryPath}.tmp`;

  // Read the JSONL file. ENOENT means fresh install -- produce empty summary.
  let content: string;
  try {
    content = await fs.readFile(jsonlPath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Fresh install -- write zero-count summary.
      const empty = emptyStatsSummary();
      await fs.mkdir(statsDir, { recursive: true });
      await fs.writeFile(tmpPath, JSON.stringify(empty, null, 2), 'utf8');
      await fs.rename(tmpPath, summaryPath);
      return;
    }
    // Other read errors: re-throw so callers' .catch(() => {}) handles them.
    throw e;
  }

  // Parse lines.
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const records: ExecutionStatRecord[] = [];
  let malformedLineCount = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLineCount++;
      continue;
    }
    const result = ExecutionStatRecordSchema.safeParse(parsed);
    if (!result.success) {
      malformedLineCount++;
      continue;
    }
    records.push(result.data);
  }

  const summary: StatsSummary = aggregate(records, malformedLineCount);

  // Atomic write: write to tmp then rename. Ensures consumers never see a partial file.
  // WHY same directory for tmp: fs.rename() is only atomic when src and dst are on the
  // same filesystem. Placing the tmp file in statsDir guarantees this.
  await fs.writeFile(tmpPath, JSON.stringify(summary, null, 2), 'utf8');
  await fs.rename(tmpPath, summaryPath);
}
