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

/**
 * Output format for the report command.
 *
 * - ndjson  (default): one JSON object per line -- streamable, jq-friendly
 * - json   : single pretty-printed JSON blob (legacy / machine consumers)
 * - summary: aggregates only, no per-session detail
 * - csv    : spreadsheet-friendly, one row per session
 * - html   : self-contained HTML report with KPIs and session table
 */
export type ReportFormat = 'ndjson' | 'json' | 'summary' | 'csv' | 'html';

export interface WorktrainReportCommandOpts {
  /** Number of days to look back (default: 30). Ignored when `since` is provided. */
  readonly days?: number;
  /** Override start date (YYYY-MM-DD). Takes priority over `days`. */
  readonly since?: string;
  /** Override end date (YYYY-MM-DD, default: today). */
  readonly until?: string;
  /** Write output to this file path instead of stdout. */
  readonly out?: string;
  /** Output format (default: ndjson). */
  readonly format?: ReportFormat;
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
 * Remove internal-only fields before any renderer emits the session.
 *
 * WHY strip changedFilePaths: it is an implementation detail of churn
 * detection (used to correlate post-session git activity). Emitting it
 * inflates output by thousands of strings for large coding sessions and
 * is not useful to report consumers. languageBreakdown already conveys
 * the language composition without the raw path list.
 */
function sanitizeSession(s: ReportSession): Record<string, unknown> {
  const { metrics, ...rest } = s;
  if (metrics === null) return { ...rest, metrics: null };

  const { gitEvidence, ...otherMetrics } = metrics;
  const sanitizedGitEvidence = gitEvidence === null ? null : (() => {
    const { committedDiff, ...otherGit } = gitEvidence;
    const sanitizedCommittedDiff = committedDiff === null ? null : (() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { changedFilePaths: _dropped, ...diffRest } = committedDiff;
      return diffRest;
    })();
    return { ...otherGit, committedDiff: sanitizedCommittedDiff };
  })();

  return { ...rest, metrics: { ...otherMetrics, gitEvidence: sanitizedGitEvidence } };
}

// ---------------------------------------------------------------------------
// Format renderers -- pure functions, no I/O
// ---------------------------------------------------------------------------

/**
 * NDJSON (default): one JSON object per line -- streamable and jq-friendly.
 * Sessions are emitted individually; the final line is the summary object.
 */
function renderNdjson(output: ReportOutput): string {
  const lines: string[] = [];
  for (const s of output.sessions) {
    lines.push(JSON.stringify(sanitizeSession(s)));
  }
  lines.push(JSON.stringify({ _summary: true, ...output.summary }));
  return lines.join('\n');
}

/** JSON (legacy): single pretty-printed blob. Strips changedFilePaths. */
function renderJson(output: ReportOutput): string {
  const sanitized = { ...output, sessions: output.sessions.map(sanitizeSession) };
  return JSON.stringify(sanitized, null, 2);
}

/** Summary: aggregates only -- no per-session detail. */
function renderSummary(output: ReportOutput): string {
  return JSON.stringify({
    version: output.version,
    generatedAt: output.generatedAt,
    dateRange: output.dateRange,
    summary: output.summary,
  }, null, 2);
}

/** A scalar value safe to embed in a CSV cell. */
type CsvCellValue = string | number | boolean | null | undefined;

/** Escape a scalar value for CSV (RFC 4180). */
function csvEscape(value: CsvCellValue): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const CSV_HEADERS = [
  'sessionId', 'date', 'workflowId', 'repoRoot', 'triggerSource',
  'outcome', 'stepsCompleted', 'retriesCount', 'durationMs',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'linesAdded', 'linesRemoved', 'filesChanged', 'commitCount',
  'captureConfidence', 'filesRemodified', 'goal',
] as const;

/** Typed row for a single CSV session. One field per CSV_HEADERS entry. */
type CsvRow = {
  readonly sessionId: string;
  readonly date: string;
  readonly workflowId: CsvCellValue;
  readonly repoRoot: CsvCellValue;
  readonly triggerSource: string;
  readonly outcome: CsvCellValue;
  readonly stepsCompleted: number;
  readonly retriesCount: number;
  readonly durationMs: CsvCellValue;
  readonly inputTokens: CsvCellValue;
  readonly outputTokens: CsvCellValue;
  readonly cacheReadTokens: CsvCellValue;
  readonly cacheWriteTokens: CsvCellValue;
  readonly linesAdded: CsvCellValue;
  readonly linesRemoved: CsvCellValue;
  readonly filesChanged: CsvCellValue;
  readonly commitCount: number;
  readonly captureConfidence: CsvCellValue;
  readonly filesRemodified: CsvCellValue;
  readonly goal: CsvCellValue;
};

function buildCsvRow(s: ReportSession): CsvRow {
  const m = s.metrics;
  const ge = m?.gitEvidence ?? null;
  const td = m?.tokenDelta ?? null;
  const usage = m?.usageEvents[0] ?? null;
  return {
    sessionId:         s.sessionId,
    date:              s.date,
    workflowId:        s.workflowId,
    repoRoot:          s.repoRoot,
    triggerSource:     s.triggerSource,
    outcome:           m?.outcome ?? null,
    stepsCompleted:    m?.stepsCompleted ?? 0,
    retriesCount:      m?.retriesCount ?? 0,
    durationMs:        m?.durationMs ?? null,
    inputTokens:       td?.inputTokens ?? usage?.inputTokens ?? null,
    outputTokens:      td?.outputTokens ?? usage?.outputTokens ?? null,
    cacheReadTokens:   td?.cacheReadTokens ?? usage?.cacheReadTokens ?? null,
    cacheWriteTokens:  td?.cacheWriteTokens ?? usage?.cacheWriteTokens ?? null,
    linesAdded:        ge?.committedDiff?.linesAdded ?? m?.linesAdded ?? null,
    linesRemoved:      ge?.committedDiff?.linesRemoved ?? m?.linesRemoved ?? null,
    filesChanged:      ge?.committedDiff?.filesChanged ?? m?.filesChanged ?? null,
    commitCount:       ge?.commitShas.length ?? 0,
    captureConfidence: ge?.captureConfidence ?? m?.captureConfidence ?? null,
    filesRemodified:   ge?.churnSignal?.filesRemodified ?? null,
    goal:              s.goal,
  };
}

/** CSV: header row + one row per session. Goal is last (may contain commas). */
function renderCsv(output: ReportOutput): string {
  const rows: string[] = [CSV_HEADERS.join(',')];
  for (const s of output.sessions) {
    const row = buildCsvRow(s);
    rows.push(CSV_HEADERS.map((h) => csvEscape(row[h])).join(','));
  }
  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

/** Escape a string for safe embedding in HTML. */
function htmlEscape(s: string | null | undefined): string {
  if (s == null) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDuration(ms: number | undefined): string {
  if (ms == null) return '--';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * HTML: self-contained report with KPI cards, workflow breakdown, and session
 * table. No external dependencies -- all CSS and JS are inlined.
 * changedFilePaths is excluded (same rule as all other formats).
 */
/**
 * HTML: self-contained report with KPI cards, breakdown table with progress
 * bars, daily activity heatmap, and a paginated/filterable session list.
 *
 * Ported from the common-ground workrail-report design (stripped of
 * Zillow-specific MR feed and correlation tabs; enriched with engine
 * metrics: tokens, git diff, language breakdown, churn, step counts).
 *
 * No external deps -- all CSS and JS are inlined. changedFilePaths excluded.
 */
function renderHtml(output: ReportOutput): string {
  const { summary, sessions, dateRange, generatedAt } = output;

  const totalTokens = summary.totalInputTokens + summary.totalOutputTokens +
    summary.totalCacheReadTokens + summary.totalCacheWriteTokens;
  const completionPct = summary.totalSessions > 0
    ? Math.round((summary.completedSessions / summary.totalSessions) * 100) : 0;
  const totalHours = (summary.totalDurationMs / 3_600_000).toFixed(1);

  // Build SESSIONS JS array for client-side rendering
  const sessionsJs = sessions.map((s) => {
    const m = s.metrics;
    const ge = m?.gitEvidence ?? null;
    const td = m?.tokenDelta ?? null;
    const usage = m?.usageEvents[0] ?? null;
    const tokens = td
      ? td.inputTokens + td.outputTokens
      : (usage ? usage.inputTokens + usage.outputTokens : 0);
    const linesAdded = ge?.committedDiff?.linesAdded ?? m?.linesAdded ?? 0;
    const durationMin = m?.durationMs != null ? Math.round(m.durationMs / 60_000 * 10) / 10 : null;
    const project = s.repoRoot ? s.repoRoot.split('/').pop() ?? '' : '';
    return {
      date: s.date,
      workflow_id: s.workflowId ?? '',
      workflow_label: s.workflowId?.replace(/^wr\./, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ?? 'Unknown',
      project,
      completed: m?.outcome === 'success' || m?.outcome === 'partial',
      outcome: m?.outcome ?? null,
      goal: htmlEscape(s.goal ?? ''),
      duration_min: durationMin,
      lines_added: linesAdded,
      tokens,
      steps: m?.stepsCompleted ?? 0,
      retries: m?.retriesCount ?? 0,
      churn: ge?.churnSignal?.filesRemodified ?? null,
      language: ge?.committedDiff?.languageBreakdown ?? {},
      model: usage?.model ?? null,
    };
  });

  // BREAKDOWN: per-workflow started/completed/median-duration
  const wfMap = new Map<string, { started: number; completed: number; durations: number[] }>();
  for (const s of sessionsJs) {
    const label = s.workflow_label;
    if (!wfMap.has(label)) wfMap.set(label, { started: 0, completed: 0, durations: [] });
    const entry = wfMap.get(label)!;
    entry.started++;
    if (s.completed) entry.completed++;
    if (s.duration_min != null) entry.durations.push(s.duration_min);
  }
  const breakdown = Array.from(wfMap.entries()).map(([label, d]) => {
    const sorted = [...d.durations].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]!.toFixed(0) + 'm' : '--';
    return { label, started: d.started, completed: d.completed, median };
  }).sort((a, b) => b.completed - a.completed);

  // HEATMAP: date -> count
  const heatmap: Record<string, number> = {};
  for (const s of sessionsJs) {
    heatmap[s.date] = (heatmap[s.date] ?? 0) + 1;
  }

  const safeJson = (v: unknown) => JSON.stringify(v).replace(/<\//g, '<\\/');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WorkRail Report -- ${htmlEscape(dateRange.since)} to ${htmlEscape(dateRange.until)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f7;color:#1d1d1f;padding:40px 24px}
.container{max-width:940px;margin:0 auto}
header{margin-bottom:28px}
header h1{font-size:24px;font-weight:700;letter-spacing:-0.4px;margin-bottom:5px}
header p{font-size:13px;color:#6e6e73}
.callout{background:#fff;border-radius:14px;padding:20px 24px;box-shadow:0 1px 4px rgba(0,0,0,.07);margin-bottom:20px;font-size:14px;line-height:1.65}
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
.kpi{background:#fff;border-radius:14px;padding:18px 20px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.kpi .value{font-size:30px;font-weight:700;letter-spacing:-1px;line-height:1;margin-bottom:4px;color:#007aff}
.kpi .label{font-size:12px;color:#6e6e73;line-height:1.4}
.tabs{display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap}
.tab{padding:7px 16px;border-radius:20px;font-size:13px;font-weight:500;cursor:pointer;border:1.5px solid transparent;background:#fff;color:#3a3a3c;box-shadow:0 1px 3px rgba(0,0,0,.08);transition:all .15s}
.tab:hover{border-color:#007aff;color:#007aff}
.tab.active{background:#007aff;color:#fff;border-color:#007aff}
.view{display:none}.view.active{display:block}
.card{background:#fff;border-radius:14px;padding:24px 26px;box-shadow:0 1px 4px rgba(0,0,0,.07);margin-bottom:18px}
.card h2{font-size:15px;font-weight:600;margin-bottom:3px}
.card .subtitle{font-size:12px;color:#6e6e73;margin-bottom:18px}
.breakdown-table{width:100%;border-collapse:collapse;font-size:13px}
.breakdown-table th{text-align:left;padding:0 10px 10px 0;font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:#aeaeb2;border-bottom:1px solid #f2f2f7}
.breakdown-table th.right{text-align:right}
.breakdown-table td{padding:8px 10px 8px 0;border-bottom:1px solid #f2f2f7;vertical-align:middle}
.breakdown-table td.right{text-align:right;color:#6e6e73}
.breakdown-table tr:last-child td{border-bottom:none}
.total-row td{padding-top:12px;font-weight:600;border-top:2px solid #e5e5ea;border-bottom:none!important}
.bar-outer{background:#f2f2f7;border-radius:4px;height:18px;position:relative;overflow:hidden;min-width:120px}
.bar-inner{background:#007aff;border-radius:4px;height:100%;position:absolute;top:0;left:0}
.chart-wrap{position:relative}
.y-axis{position:absolute;left:0;top:0;bottom:24px;width:32px;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none}
.y-label{font-size:10px;color:#aeaeb2;text-align:right;padding-right:6px}
.bar-chart-area{margin-left:36px}
.bar-chart{display:flex;align-items:flex-end;gap:3px;height:140px;border-bottom:1px solid #e5e5ea;padding-bottom:0}
.bar-chart-bar{flex:1;background:#007aff;border-radius:2px 2px 0 0;min-width:4px;position:relative;cursor:default;transition:opacity .1s}
.bar-chart-bar:hover{opacity:.7}
.bar-chart-bar:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:#1d1d1f;color:#fff;font-size:11px;padding:4px 8px;border-radius:6px;white-space:nowrap;z-index:10;pointer-events:none}
.bar-chart-axis{display:flex;gap:3px;margin-top:4px}
.bar-chart-label{flex:1;font-size:9px;color:#aeaeb2;text-align:center;overflow:hidden}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.controls select,.controls input{padding:6px 10px;border:1.5px solid #e5e5ea;border-radius:8px;font-size:12px;background:#fff;color:#1d1d1f;outline:none}
.controls select:focus,.controls input:focus{border-color:#007aff}
.stats-bar{display:flex;gap:20px;padding:10px 0 14px;border-bottom:1px solid #f2f2f7;margin-bottom:14px;font-size:12px;flex-wrap:wrap}
.stat-item .stat-val{font-weight:600;color:#1d1d1f}
.stat-item .stat-lbl{color:#6e6e73}
.session-item{display:grid;grid-template-columns:76px 36px 160px 1fr 80px 70px 60px;gap:10px;align-items:start;padding:9px 0;border-bottom:1px solid #f2f2f7;font-size:13px}
.session-item:last-child{border-bottom:none}
.session-date{font-size:11px;color:#aeaeb2;padding-top:2px}
.session-dot{width:8px;height:8px;border-radius:50%;margin-top:4px;flex-shrink:0}
.dot-done{background:#34c759}.dot-partial{background:#e5e5ea;border:1.5px solid #aeaeb2}
.session-wf{font-size:11px;font-weight:600;color:#6e6e73;padding-top:2px}
.session-goal{line-height:1.4;color:#1d1d1f}
.session-goal.no-goal{color:#aeaeb2;font-style:italic}
.session-metrics{font-size:11px;color:#6e6e73;margin-top:3px}
.outcome-badge{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;white-space:nowrap}
.outcome-success{background:#e1f8ec;color:#1a7a3a}
.outcome-partial{background:#fff8e0;color:#9a6000}
.outcome-abandoned{background:#f5f5f5;color:#999}
.outcome-error{background:#ffeaea;color:#c0392b}
.sess-dur{font-size:11px;color:#6e6e73;text-align:right;padding-top:2px}
.pagination{display:flex;gap:6px;justify-content:center;align-items:center;margin-top:16px;flex-wrap:wrap}
.page-btn{padding:5px 11px;border:1.5px solid #e5e5ea;border-radius:8px;font-size:12px;cursor:pointer;background:#fff;color:#3a3a3c}
.page-btn:hover:not(:disabled){border-color:#007aff;color:#007aff}
.page-btn.active{background:#007aff;color:#fff;border-color:#007aff;cursor:default}
.page-btn:disabled{opacity:.35;cursor:default}
footer{text-align:center;font-size:11px;color:#aeaeb2;margin-top:24px}
@media(max-width:600px){.kpi-row{grid-template-columns:repeat(2,1fr)}.session-item{grid-template-columns:60px 28px 1fr}}
</style>
</head>
<body>
<div class="container">
<header>
  <h1>WorkRail Report</h1>
  <p>${htmlEscape(dateRange.since)} to ${htmlEscape(dateRange.until)} &middot; Generated ${new Date(generatedAt).toLocaleString()}</p>
</header>

<div class="callout" id="callout">Loading...</div>

<div class="kpi-row">
  <div class="kpi"><div class="value">${summary.totalSessions}</div><div class="label">Workflow runs<br><span style="font-size:10px;color:#aeaeb2">${completionPct}% completed</span></div></div>
  <div class="kpi"><div class="value">${totalHours}h</div><div class="label">Autonomous runtime<br><span style="font-size:10px;color:#aeaeb2">wall clock</span></div></div>
  <div class="kpi"><div class="value">${fmtTokens(totalTokens)}</div><div class="label">Tokens used<br><span style="font-size:10px;color:#aeaeb2">input + output + cache</span></div></div>
  <div class="kpi"><div class="value">${fmtTokens(summary.totalLinesAdded)}</div><div class="label">Lines of code added<br><span style="font-size:10px;color:#aeaeb2">engine-authoritative</span></div></div>
</div>

<div class="tabs">
  <button class="tab active" data-view="breakdown">By workflow</button>
  <button class="tab" data-view="activity">Daily activity</button>
  <button class="tab" data-view="sessions">Sessions</button>
</div>

<div class="view active" id="view-breakdown">
  <div class="card">
    <h2>Workflow breakdown</h2>
    <p class="subtitle">Completion rate and median runtime per workflow type.</p>
    <table class="breakdown-table">
      <thead><tr><th>Workflow</th><th style="min-width:200px">Completed</th><th class="right">Rate</th><th class="right">Median</th></tr></thead>
      <tbody id="breakdown-body"></tbody>
    </table>
  </div>
</div>

<div class="view" id="view-activity">
  <div class="card">
    <h2>Daily activity</h2>
    <p class="subtitle">Sessions started per day.</p>
    <div class="chart-wrap">
      <div class="y-axis" id="y-axis"></div>
      <div class="bar-chart-area">
        <div class="bar-chart" id="barchart"></div>
        <div class="bar-chart-axis" id="barchart-axis"></div>
      </div>
    </div>
  </div>
</div>

<div class="view" id="view-sessions">
  <div class="card">
    <h2>Workflow runs</h2>
    <p class="subtitle">All sessions in the report window. <span id="sess-total"></span></p>
    <div class="controls">
      <select id="sess-workflow"><option value="">All workflows</option></select>
      <select id="sess-status">
        <option value="">All statuses</option>
        <option value="done">Completed</option>
        <option value="partial">Incomplete</option>
      </select>
      <input type="text" id="sess-search" placeholder="Search goals..." style="min-width:180px">
    </div>
    <div class="stats-bar" id="sess-stats"></div>
    <div id="sess-list"><div style="padding:20px;text-align:center;color:#aeaeb2" id="sess-empty" ${sessions.length > 0 ? 'style="display:none"' : ''}>No sessions in window</div></div>
    <div class="pagination" id="sess-pagination"></div>
  </div>
</div>

<footer>WorkRail session metrics &middot; <a href="https://github.com/EtienneBBeaulac/workrail" style="color:#aeaeb2">github.com/EtienneBBeaulac/workrail</a></footer>
</div>
<script>
const SESSIONS = ${safeJson(sessionsJs)};
const BREAKDOWN = ${safeJson(breakdown)};
const HEATMAP = ${safeJson(heatmap)};
const PAGE_SIZE = 30;

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

// ── Callout ───────────────────────────────────────────────────────────────────
(function(){
  const counts = {};
  for (const s of SESSIONS) { if (s.completed) counts[s.workflow_label] = (counts[s.workflow_label]||0)+1; }
  const dates = Object.keys(HEATMAP).sort();
  const totalDays = Math.max(1, dates.length);
  const avgPerDay = Math.round(SESSIONS.length / totalDays);
  const top = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0,3);
  const parts = top.map(([l,n]) => '<strong>' + n + ' ' + l.toLowerCase() + (n===1?'':'s') + '</strong>');
  document.getElementById('callout').innerHTML = parts.length
    ? 'Over ' + totalDays + ' days, this agent completed ' + parts.join(', ') + ' and more -- running autonomously at an average of <strong>' + avgPerDay + ' sessions per day</strong>.'
    : 'No completed sessions in this window.';
})();

// ── Breakdown table ───────────────────────────────────────────────────────────
(function(){
  const tbody = document.getElementById('breakdown-body');
  const max = Math.max(...BREAKDOWN.map(r => r.completed), 1);
  let totS = 0, totC = 0;
  for (const row of BREAKDOWN) {
    const pct = Math.round(row.completed / max * 100);
    const rate = Math.round(row.completed / row.started * 100);
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + row.label + '</td><td><div style="display:flex;align-items:center;gap:8px"><div class="bar-outer" style="flex:1"><div class="bar-inner" style="width:' + pct + '%"></div></div><span style="font-size:13px;font-weight:600;color:#1d1d1f;width:36px;text-align:right">' + row.completed + '</span></div></td><td class="right" style="color:#aeaeb2;font-size:12px">' + rate + '%</td><td class="right">' + row.median + '</td>';
    tbody.appendChild(tr);
    totS += row.started; totC += row.completed;
  }
  const totalRow = document.createElement('tr');
  totalRow.className = 'total-row';
  const totRate = Math.round(totC / Math.max(totS,1) * 100);
  totalRow.innerHTML = '<td>Total</td><td><div style="display:flex;align-items:center;gap:8px"><div class="bar-outer" style="flex:1"><div class="bar-inner" style="width:100%"></div></div><span style="font-size:13px;font-weight:600;color:#1d1d1f;width:36px;text-align:right">' + totC + '</span></div></td><td class="right" style="color:#aeaeb2;font-size:12px">' + totRate + '%</td><td class="right">--</td>';
  tbody.appendChild(totalRow);
})();

// ── Daily activity chart ──────────────────────────────────────────────────────
(function(){
  const chart = document.getElementById('barchart');
  const axis  = document.getElementById('barchart-axis');
  const yAxis = document.getElementById('y-axis');
  const entries = [];
  const start = new Date(Object.keys(HEATMAP).sort()[0]);
  const end   = new Date(Object.keys(HEATMAP).sort().reverse()[0]);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
    const k = d.toISOString().slice(0,10);
    entries.push({ date: k, label: d.toLocaleDateString('en-US',{month:'short',day:'numeric'}), count: HEATMAP[k]||0 });
  }
  if (!entries.length) return;
  const max = Math.max(...entries.map(e=>e.count), 1);
  [max, Math.round(max*.5), 0].forEach(v => {
    const el = document.createElement('div'); el.className='y-label'; el.textContent=v; yAxis.appendChild(el);
  });
  entries.forEach(e => {
    const isWe = new Date(e.date+'T12:00:00').getDay()===0 || new Date(e.date+'T12:00:00').getDay()===6;
    const bar = document.createElement('div');
    bar.className = 'bar-chart-bar';
    bar.style.height = Math.max(2, Math.round(e.count/max*100))+'%';
    if (isWe) bar.style.background = '#60a5fa';
    bar.setAttribute('data-tip', e.label+': '+e.count+' sessions');
    chart.appendChild(bar);
    const lbl = document.createElement('div'); lbl.className='bar-chart-label';
    if ([1,7,14,21,28].includes(new Date(e.date+'T12:00:00').getDate())) lbl.textContent = e.label;
    axis.appendChild(lbl);
  });
})();

// ── Sessions view ─────────────────────────────────────────────────────────────
let sessPage = 1, sessFiltered = SESSIONS.slice();

(function(){
  const sel = document.getElementById('sess-workflow');
  [...new Set(SESSIONS.map(s=>s.workflow_label))].sort().forEach(l => {
    const o = document.createElement('option'); o.value=l; o.textContent=l; sel.appendChild(o);
  });
  document.getElementById('sess-total').textContent = SESSIONS.length+' total.';
})();

function fmtDur(min) { if (!min) return '--'; return min < 60 ? min.toFixed(0)+'m' : (min/60).toFixed(1)+'h'; }
function fmtTok(n)  { if (!n) return '--'; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return Math.round(n/1e3)+'k'; return n; }

function applySessFilters() {
  const wf     = document.getElementById('sess-workflow').value;
  const status = document.getElementById('sess-status').value;
  const search = document.getElementById('sess-search').value.toLowerCase();
  sessFiltered = SESSIONS.filter(s =>
    (!wf     || s.workflow_label === wf) &&
    (!status || (status==='done' ? s.completed : !s.completed)) &&
    (!search || s.goal.toLowerCase().includes(search) || s.date.includes(search))
  );
  sessPage = 1;
  renderSessions();
}

function renderSessions() {
  const list = document.getElementById('sess-list');
  const total = sessFiltered.length;
  const start = (sessPage-1)*PAGE_SIZE;
  const page  = sessFiltered.slice(start, Math.min(start+PAGE_SIZE, total));
  const completed = sessFiltered.filter(s=>s.completed).length;
  const avgDur = sessFiltered.filter(s=>s.duration_min).reduce((a,s)=>a+s.duration_min,0) / (sessFiltered.filter(s=>s.duration_min).length||1);
  document.getElementById('sess-stats').innerHTML =
    '<div class="stat-item"><span class="stat-val">'+total+'</span> <span class="stat-lbl">sessions</span></div>'+
    '<div class="stat-item"><span class="stat-val" style="color:#34c759">'+completed+'</span> <span class="stat-lbl">completed</span></div>'+
    '<div class="stat-item"><span class="stat-val">'+Math.round(completed/Math.max(total,1)*100)+'%</span> <span class="stat-lbl">completion rate</span></div>'+
    '<div class="stat-item"><span class="stat-val">'+fmtDur(Math.round(avgDur*10)/10)+'</span> <span class="stat-lbl">avg duration</span></div>'+
    '<div class="stat-item" style="margin-left:auto;font-size:11px;color:#aeaeb2">Showing '+(start+1)+'&#8211;'+Math.min(start+PAGE_SIZE,total)+'</div>';
  list.innerHTML = '';
  for (const s of page) {
    const div = document.createElement('div');
    div.className = 'session-item';
    const outcomeHtml = s.outcome ? '<span class="outcome-badge outcome-'+s.outcome+'">'+s.outcome+'</span>' : '';
    const metaParts = [];
    if (s.lines_added) metaParts.push('<span style="color:#1a7a1a">+'+s.lines_added+' lines</span>');
    if (s.tokens) metaParts.push(fmtTok(s.tokens)+' tokens');
    if (s.steps) metaParts.push(s.steps+' steps');
    if (s.retries) metaParts.push(s.retries+' retries');
    const metaHtml = metaParts.length ? '<div class="session-metrics">'+metaParts.join(' &middot; ')+'</div>' : '';
    div.innerHTML =
      '<div class="session-date">'+s.date+'</div>'+
      '<div><div class="session-dot '+(s.completed?'dot-done':'dot-partial')+'"></div></div>'+
      '<div class="session-wf">'+s.workflow_label+'</div>'+
      '<div><div class="session-goal'+(s.goal?'':' no-goal')+'">'+(s.goal||'No goal recorded')+'</div>'+metaHtml+'</div>'+
      '<div>'+outcomeHtml+'</div>'+
      '<div class="sess-dur">'+fmtTok(s.tokens)+'</div>'+
      '<div class="sess-dur">'+fmtDur(s.duration_min)+'</div>';
    list.appendChild(div);
  }
  // Pagination
  const pag = document.getElementById('sess-pagination');
  pag.innerHTML = '';
  const pages = Math.ceil(total/PAGE_SIZE);
  if (pages <= 1) return;
  const prev = document.createElement('button'); prev.className='page-btn'; prev.textContent='Previous'; prev.disabled=sessPage===1;
  prev.addEventListener('click',()=>{sessPage--;renderSessions();}); pag.appendChild(prev);
  for (let p = Math.max(1,sessPage-2); p <= Math.min(pages,sessPage+2); p++) {
    const btn = document.createElement('button'); btn.className='page-btn'+(p===sessPage?' active':''); btn.textContent=p;
    btn.addEventListener('click',()=>{sessPage=p;renderSessions();}); pag.appendChild(btn);
  }
  const next = document.createElement('button'); next.className='page-btn'; next.textContent='Next'; next.disabled=sessPage===pages;
  next.addEventListener('click',()=>{sessPage++;renderSessions();}); pag.appendChild(next);
}

['sess-workflow','sess-status'].forEach(id => document.getElementById(id).addEventListener('change', applySessFilters));
document.getElementById('sess-search').addEventListener('input', applySessFilters);
applySessFilters();
</script>
</body>
</html>`;
}

/**
 * Dispatch to the correct renderer based on format.
 * Pure function: no I/O.
 */
function render(output: ReportOutput, format: ReportFormat): string {
  switch (format) {
    case 'ndjson':  return renderNdjson(output);
    case 'json':    return renderJson(output);
    case 'summary': return renderSummary(output);
    case 'csv':     return renderCsv(output);
    case 'html':    return renderHtml(output);
  }
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

  const format: ReportFormat = opts.format ?? 'ndjson';
  const rendered = render(output, format);

  if (opts.out !== undefined) {
    try {
      await deps.writeFile(opts.out, rendered);
      deps.writeStderr(`[report] Report written to ${opts.out}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.writeStderr(`[report] Error writing to ${opts.out}: ${msg}`);
    }
  } else {
    deps.writeOutput(rendered);
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
