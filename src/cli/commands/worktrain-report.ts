/**
 * WorkTrain Report Command (`worktrain report`)
 *
 * Emits a machine-readable JSON report of session history and metrics for a
 * configurable date window. Reads session data directly from the session store
 * via ConsoleService -- no daemon required.
 *
 * Design:
 * - Pure function: all I/O injected via WorktrainReportCommandDeps
 * - ConsoleService reads the same session files the console UI uses
 * - stdout is always clean JSON or nothing (progress goes to stderr only)
 * - Read-only: never writes to the session store or any stateful store
 * - Graceful degradation: missing sessions dir yields empty sessions array
 * - 500-session cap: ConsoleService.getSessionList() loads at most 500 sessions
 *   (most recently modified first). A stderr warning is emitted when the list
 *   is truncated.
 *
 * Follows the same pattern as worktrain-overview.ts (pure executeXxx + injected deps).
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalDataDirV2 } from '../../v2/infra/local/data-dir/index.js';
import { LocalDirectoryListingV2 } from '../../v2/infra/local/directory-listing/index.js';
import { NodeFileSystemV2 } from '../../v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../v2/infra/local/sha256/index.js';
import { NodeCryptoV2 } from '../../v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../../v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../v2/infra/local/pinned-workflow-store/index.js';
import { LocalSessionEventLogStoreV2 } from '../../v2/infra/local/session-store/index.js';
import { ConsoleService } from '../../v2/usecases/console-service.js';
import type { SessionMetricsV2 } from '../../v2/projections/session-metrics.js';

// ---------------------------------------------------------------------------
// Output schema types
// ---------------------------------------------------------------------------

/**
 * One session entry in the report output.
 */
export interface ReportSession {
  readonly sessionId: string;
  readonly workflowId: string | null;
  /** Human-readable goal for this session (derived from context_set goal/taskDescription keys). */
  readonly goal: string | null;
  /** YYYY-MM-DD date derived from session's lastModifiedMs. */
  readonly date: string;
  readonly repoRoot: string | null;
  readonly triggerSource: 'daemon' | 'mcp';
  /** Full SessionMetricsV2 for this session's first completed run. null when in-progress or pre-feature. */
  readonly metrics: SessionMetricsV2 | null;
}

/**
 * Aggregate summary across all sessions in the report window.
 */
export interface ReportSummary {
  readonly totalSessions: number;
  /** Sessions with status 'complete' or 'complete_with_gaps'. */
  readonly completedSessions: number;
  readonly totalDurationMs: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheWriteTokens: number;
  readonly totalLinesAdded: number;
  readonly totalLinesRemoved: number;
  readonly totalFilesChanged: number;
  readonly totalStepsCompleted: number;
  readonly totalRetriesCount: number;
  /** Outcome breakdown: keys are 'success' | 'partial' | 'abandoned' | 'error' | 'unknown'. */
  readonly outcomeBreakdown: Record<string, number>;
  /** Session count per workflowId (null workflowId grouped under '__unknown__'). */
  readonly workflowBreakdown: Record<string, number>;
  /** Total lines changed per file extension (from gitEvidence.committedDiff.languageBreakdown). */
  readonly languageBreakdown: Record<string, number>;
}

/**
 * Top-level report output. Emitted to stdout as valid JSON.
 */
export interface ReportOutput {
  readonly version: 1;
  readonly generatedAt: string;
  readonly dateRange: { readonly since: string; readonly until: string };
  readonly sessions: readonly ReportSession[];
  readonly summary: ReportSummary;
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface WorktrainReportCommandDeps {
  /** Return the current epoch time in milliseconds. Injected so tests can control "now". */
  readonly now: () => number;
  /**
   * Build and return a ConsoleService instance for the given data directory.
   * Injected so tests can substitute a fake service without hitting the filesystem.
   */
  readonly buildConsoleService: (dataDir: string) => ConsoleService;
  /** Return the home directory (used to resolve the default data directory). */
  readonly homedir: () => string;
  /** Join path segments. */
  readonly joinPath: (...parts: string[]) => string;
  /**
   * Write the final JSON output. In production this writes to stdout.
   * Injected so tests can capture output without process.stdout.
   */
  readonly writeOutput: (json: string) => void;
  /**
   * Write a progress or warning message to stderr.
   * Injected so tests can assert what was written to stderr.
   */
  readonly writeStderr: (line: string) => void;
  /**
   * Write output to a file (used when --out is specified).
   * Injected so tests can verify file writes without hitting the filesystem.
   */
  readonly writeFile: (filePath: string, content: string) => Promise<void>;
  /** Read the WORKRAIL_DATA_DIR env var. Returns undefined when not set. */
  readonly getDataDirEnv: () => string | undefined;
}

export interface WorktrainReportCommandOpts {
  /** Number of days to look back (default: 30). Ignored when `since` is provided. */
  readonly days?: number;
  /** Override start date (YYYY-MM-DD). Takes priority over `days`. */
  readonly since?: string;
  /** Override end date (YYYY-MM-DD, default: today). */
  readonly until?: string;
  /** Write JSON to this file path instead of stdout. */
  readonly out?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a YYYY-MM-DD string into epoch ms at midnight UTC.
 * Returns null for invalid input.
 */
function parseDateToMs(dateStr: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const ms = Date.parse(dateStr + 'T00:00:00Z');
  return isNaN(ms) ? null : ms;
}

/**
 * Format epoch ms as YYYY-MM-DD (UTC).
 */
function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Build the summary aggregate from the filtered sessions array.
 * Pure function: only reads from sessions.
 */
function buildSummary(
  sessions: readonly ReportSession[],
  statuses: readonly string[],
): ReportSummary {
  let completedSessions = 0;
  let totalDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;
  let totalFilesChanged = 0;
  let totalStepsCompleted = 0;
  let totalRetriesCount = 0;
  const outcomeBreakdown: Record<string, number> = {};
  const workflowBreakdown: Record<string, number> = {};
  const languageBreakdown: Record<string, number> = {};

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    const status = statuses[i];

    // Completed sessions: status is 'complete' or 'complete_with_gaps'
    if (status === 'complete' || status === 'complete_with_gaps') {
      completedSessions++;
    }

    // Workflow breakdown
    const wfKey = session.workflowId ?? '__unknown__';
    workflowBreakdown[wfKey] = (workflowBreakdown[wfKey] ?? 0) + 1;

    const m = session.metrics;
    if (m === null) {
      // Outcome: count null metrics as 'unknown'
      outcomeBreakdown['unknown'] = (outcomeBreakdown['unknown'] ?? 0) + 1;
      continue;
    }

    // Duration
    if (typeof m.durationMs === 'number') {
      totalDurationMs += m.durationMs;
    }

    // Token totals: sum across all usageEvents
    for (const u of m.usageEvents) {
      totalInputTokens += u.inputTokens;
      totalOutputTokens += u.outputTokens;
      totalCacheReadTokens += u.cacheReadTokens;
      totalCacheWriteTokens += u.cacheWriteTokens;
    }

    // Git metrics (prefer gitEvidence, fall back to legacy fields)
    if (m.gitEvidence?.committedDiff !== null && m.gitEvidence?.committedDiff !== undefined) {
      const diff = m.gitEvidence.committedDiff;
      totalLinesAdded += diff.linesAdded;
      totalLinesRemoved += diff.linesRemoved;
      totalFilesChanged += diff.filesChanged;
      // Language breakdown
      for (const [ext, count] of Object.entries(diff.languageBreakdown)) {
        languageBreakdown[ext] = (languageBreakdown[ext] ?? 0) + (count as number);
      }
    } else {
      // Fallback to agent-reported legacy fields
      if (typeof m.linesAdded === 'number') totalLinesAdded += m.linesAdded;
      if (typeof m.linesRemoved === 'number') totalLinesRemoved += m.linesRemoved;
      if (typeof m.filesChanged === 'number') totalFilesChanged += m.filesChanged;
    }

    // Step metrics
    totalStepsCompleted += m.stepsCompleted;
    totalRetriesCount += m.retriesCount;

    // Outcome breakdown
    const outcomeKey = m.outcome ?? 'unknown';
    outcomeBreakdown[outcomeKey] = (outcomeBreakdown[outcomeKey] ?? 0) + 1;
  }

  return {
    totalSessions: sessions.length,
    completedSessions,
    totalDurationMs,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalLinesAdded,
    totalLinesRemoved,
    totalFilesChanged,
    totalStepsCompleted,
    totalRetriesCount,
    outcomeBreakdown,
    workflowBreakdown,
    languageBreakdown,
  };
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Execute the `worktrain report` command.
 *
 * Reads sessions via ConsoleService and emits a structured JSON report.
 * All progress goes to deps.writeStderr. deps.writeOutput receives exactly
 * one call with the final JSON (unless --out is used, in which case
 * deps.writeFile receives the JSON and deps.writeOutput is not called).
 *
 * Never writes to the session store. Never throws -- errors are reported
 * to stderr and the command exits cleanly.
 */
export async function executeWorktrainReportCommand(
  deps: WorktrainReportCommandDeps,
  opts: WorktrainReportCommandOpts = {},
): Promise<void> {
  const nowMs = deps.now();
  const nowDay = formatDate(nowMs);

  // Resolve the date window.
  const untilStr = opts.until ?? nowDay;
  const untilMs = parseDateToMs(untilStr);
  if (untilMs === null) {
    deps.writeStderr(`[report] Invalid --until date: "${opts.until}". Expected YYYY-MM-DD.`);
    return;
  }
  // until is inclusive: add one day to cover sessions modified on the until date.
  const untilMsInclusive = untilMs + 24 * 60 * 60 * 1000;

  let sinceMs: number;
  let sinceStr: string;
  if (opts.since !== undefined) {
    const parsed = parseDateToMs(opts.since);
    if (parsed === null) {
      deps.writeStderr(`[report] Invalid --since date: "${opts.since}". Expected YYYY-MM-DD.`);
      return;
    }
    sinceMs = parsed;
    sinceStr = opts.since;
  } else {
    const days = opts.days ?? 30;
    sinceMs = untilMs - (days - 1) * 24 * 60 * 60 * 1000;
    sinceStr = formatDate(sinceMs);
  }

  if (sinceMs > untilMsInclusive) {
    deps.writeStderr(`[report] --since date (${sinceStr}) is after --until date (${untilStr}). No sessions to report.`);
    // Emit empty report rather than failing.
  }

  // Resolve data directory.
  const dataDir = deps.getDataDirEnv()
    ?? deps.joinPath(deps.homedir(), '.workrail', 'data');

  const consoleService = deps.buildConsoleService(dataDir);

  deps.writeStderr(`[report] Loading sessions from ${dataDir}...`);

  // Load session list. Gracefully degrade on error.
  const sessionListResult = await consoleService.getSessionList();
  if (sessionListResult.isErr()) {
    deps.writeStderr(`[report] Warning: could not enumerate sessions: ${sessionListResult.error.message}`);
    deps.writeStderr('[report] Generating report with no sessions.');
  }

  const allSessions = sessionListResult.isOk() ? sessionListResult.value.sessions : [];
  const totalAvailable = sessionListResult.isOk() ? sessionListResult.value.totalCount : 0;

  // Warn when the session list was truncated by the 500-session cap.
  if (totalAvailable > allSessions.length) {
    deps.writeStderr(
      `[report] Warning: session store has ${totalAvailable} sessions but only ${allSessions.length} were loaded (most-recently-modified first). Older sessions in your date window may be missing from this report.`,
    );
  }

  // Filter sessions within the date window.
  const filteredSessions = allSessions.filter(
    (s) => s.lastModifiedMs >= sinceMs && s.lastModifiedMs < untilMsInclusive,
  );

  deps.writeStderr(
    `[report] ${filteredSessions.length} session(s) in window ${sinceStr} to ${untilStr}.`,
  );

  // Build report sessions array and capture statuses for summary computation.
  const reportSessions: ReportSession[] = [];
  const statuses: string[] = [];

  for (const s of filteredSessions) {
    reportSessions.push({
      sessionId: s.sessionId,
      workflowId: s.workflowId,
      goal: s.sessionTitle,
      date: formatDate(s.lastModifiedMs),
      repoRoot: s.repoRoot,
      triggerSource: s.triggerSource,
      metrics: s.metrics,
    });
    statuses.push(s.status);
  }

  const summary = buildSummary(reportSessions, statuses);

  const output: ReportOutput = {
    version: 1,
    generatedAt: new Date(nowMs).toISOString(),
    dateRange: { since: sinceStr, until: untilStr },
    sessions: reportSessions,
    summary,
  };

  const json = JSON.stringify(output, null, 2);

  if (opts.out !== undefined) {
    try {
      await deps.writeFile(opts.out, json);
      deps.writeStderr(`[report] Report written to ${opts.out}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.writeStderr(`[report] Error writing to ${opts.out}: ${msg}`);
    }
  } else {
    deps.writeOutput(json);
  }
}

// ---------------------------------------------------------------------------
// Factory: build real ConsoleService from data directory path
// ---------------------------------------------------------------------------

/**
 * Construct a ConsoleService that reads from the given data directory.
 * This is the real implementation used in the CLI composition root.
 * Tests inject their own fake via the deps interface.
 */
export function buildConsoleServiceFromDataDir(dataDir: string): ConsoleService {
  const envWithDataDir: Record<string, string | undefined> = {
    ...process.env as Record<string, string | undefined>,
    WORKRAIL_DATA_DIR: dataDir,
  };

  const dataDirPort = new LocalDataDirV2(envWithDataDir);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const directoryListing = new LocalDirectoryListingV2(fsPort);
  const sessionStore = new LocalSessionEventLogStoreV2(dataDirPort, fsPort, sha256);
  const snapshotStore = new LocalSnapshotStoreV2(dataDirPort, fsPort, crypto);
  const pinnedWorkflowStore = new LocalPinnedWorkflowStoreV2(dataDirPort, fsPort);

  return new ConsoleService({
    directoryListing,
    dataDir: dataDirPort,
    sessionStore,
    snapshotStore,
    pinnedWorkflowStore,
    // daemonRegistry omitted: report command never tracks live daemon heartbeats.
  });
}

/**
 * Build the real production deps for the report command.
 */
export function buildWorktrainReportCommandDeps(): WorktrainReportCommandDeps {
  return {
    now: () => Date.now(),
    buildConsoleService: buildConsoleServiceFromDataDir,
    homedir: os.homedir,
    joinPath: path.join,
    writeOutput: (json: string) => { process.stdout.write(json + '\n'); },
    writeStderr: (line: string) => { process.stderr.write(line + '\n'); },
    writeFile: (filePath: string, content: string) => fs.writeFile(filePath, content, 'utf-8'),
    getDataDirEnv: () => process.env['WORKRAIL_DATA_DIR'],
  };
}
