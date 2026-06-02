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
 * HTML: self-contained report surfacing all 18 metric categories.
 *
 * Design: dark header with estimated cost dominant, 4 KPI cards, 5 tabs
 * (Overview / Tokens & Cost / Activity / Quality / Sessions).
 *
 * No external deps -- all CSS and JS inlined. changedFilePaths excluded.
 * Goals are HTML-escaped before embedding to prevent XSS.
 */
function renderHtml(output: ReportOutput): string {
  const { summary, sessions, dateRange, generatedAt } = output;

  // ── Aggregate helpers ────────────────────────────────────────────────────────
  const inputTok  = summary.totalInputTokens;
  const outputTok = summary.totalOutputTokens;
  const cacheR    = summary.totalCacheReadTokens;
  const cacheW    = summary.totalCacheWriteTokens;
  const totalTokens = inputTok + outputTok + cacheR + cacheW;

  // Estimated cost at Anthropic Sonnet 4.6 list prices (no actual model lookup --
  // directional only). Displayed with disclaimer.
  const PRICE_INPUT   = 3.00;   // $/1M
  const PRICE_OUTPUT  = 15.00;
  const PRICE_CACHE_R = 0.30;
  const PRICE_CACHE_W = 3.75;
  const estCostCents = Math.round(
    (inputTok * PRICE_INPUT + outputTok * PRICE_OUTPUT +
     cacheR * PRICE_CACHE_R + cacheW * PRICE_CACHE_W) / 1_000_000 * 100,
  );
  const estCostStr = estCostCents >= 100
    ? `$${(estCostCents / 100).toFixed(0)}`
    : `$${(estCostCents / 100).toFixed(2)}`;

  const completionPct = summary.totalSessions > 0
    ? Math.round((summary.completedSessions / summary.totalSessions) * 100) : 0;
  const totalHours = (summary.totalDurationMs / 3_600_000).toFixed(1);

  // ── Per-session JS data ──────────────────────────────────────────────────────
  const sessionsJs = sessions.map((s) => {
    const m   = s.metrics;
    const ge  = m?.gitEvidence ?? null;
    const td  = m?.tokenDelta ?? null;
    const u0  = m?.usageEvents[0] ?? null;
    const tokIn  = td?.inputTokens  ?? u0?.inputTokens  ?? 0;
    const tokOut = td?.outputTokens ?? u0?.outputTokens ?? 0;
    const tokCR  = td?.cacheReadTokens  ?? u0?.cacheReadTokens  ?? 0;
    const tokCW  = td?.cacheWriteTokens ?? u0?.cacheWriteTokens ?? 0;
    const linesAdded   = ge?.committedDiff?.linesAdded   ?? m?.linesAdded   ?? 0;
    const linesRemoved = ge?.committedDiff?.linesRemoved ?? m?.linesRemoved ?? 0;
    const filesChanged = ge?.committedDiff?.filesChanged ?? m?.filesChanged ?? 0;
    const durationMin  = m?.durationMs != null ? Math.round(m.durationMs / 60_000 * 10) / 10 : null;
    const project = s.repoRoot ? (s.repoRoot.split('/').pop() ?? '') : '';
    const wfLabel = (s.workflowId ?? '')
      .replace(/^wr\./, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Unknown';
    // Estimated session cost at list pricing
    const sessEstCost = Math.round(
      (tokIn * PRICE_INPUT + tokOut * PRICE_OUTPUT +
       tokCR * PRICE_CACHE_R + tokCW * PRICE_CACHE_W) / 1_000_000 * 100,
    );
    return {
      date:          s.date,
      workflow_id:   s.workflowId ?? '',
      workflow_label: wfLabel,
      project,
      repoRoot:      s.repoRoot ?? '',
      completed:     m?.outcome === 'success' || m?.outcome === 'partial',
      outcome:       m?.outcome ?? null,
      goal:          htmlEscape(s.goal ?? ''),
      trigger:       s.triggerSource,
      duration_min:  durationMin,
      lines_added:   linesAdded,
      lines_removed: linesRemoved,
      files_changed: filesChanged,
      tok_in:        tokIn,
      tok_out:       tokOut,
      tok_cache_r:   tokCR,
      tok_cache_w:   tokCW,
      est_cost_cents: sessEstCost,
      steps:         m?.stepsCompleted ?? 0,
      retries:       m?.retriesCount ?? 0,
      git_branch:    m?.gitBranch ?? null,
      commit_count:  ge?.commitShas.length ?? 0,
      pr_refs:       ge?.prRefs ?? [],
      churn:         ge?.churnSignal?.filesRemodified ?? null,
      lang:          ge?.committedDiff?.languageBreakdown ?? {},
      model:         u0?.model ?? null,
      confidence:    ge?.captureConfidence ?? m?.captureConfidence ?? null,
      staged_start:  null as null,   // git_start_recorded not in SessionMetricsV2 projection yet
    };
  });

  // ── Breakdown: per-workflow (routines separated -- they never report outcomes) ──
  const wfMap = new Map<string, { started: number; completed: number; durations: number[]; linesAdded: number; isRoutine: boolean }>();
  for (const s of sessionsJs) {
    const label = s.workflow_label;
    const isRoutine = s.workflow_id.startsWith('wr.routine-');
    if (!wfMap.has(label)) wfMap.set(label, { started: 0, completed: 0, durations: [], linesAdded: 0, isRoutine });
    const e = wfMap.get(label)!;
    e.started++;
    if (s.completed) e.completed++;
    if (s.duration_min != null) e.durations.push(s.duration_min);
    e.linesAdded += s.lines_added;
  }
  const allBreakdown = Array.from(wfMap.entries()).map(([label, d]) => {
    const sorted = [...d.durations].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]!.toFixed(0) + 'm' : '--';
    return { label, started: d.started, completed: d.completed, median, linesAdded: d.linesAdded, isRoutine: d.isRoutine };
  }).sort((a, b) => b.completed - a.completed);
  // Main workflows shown in chart; routines shown separately with a note
  const breakdown = allBreakdown.filter(r => !r.isRoutine);
  const routineBreakdown = allBreakdown.filter(r => r.isRoutine);

  // ── Per-project breakdown ────────────────────────────────────────────────────
  const projMap = new Map<string, { sessions: number; linesAdded: number; lang: Record<string, number> }>();
  for (const s of sessionsJs) {
    const p = s.project || '(unknown)';
    if (!projMap.has(p)) projMap.set(p, { sessions: 0, linesAdded: 0, lang: {} });
    const e = projMap.get(p)!;
    e.sessions++;
    e.linesAdded += s.lines_added;
    for (const [ext, cnt] of Object.entries(s.lang)) {
      e.lang[ext] = (e.lang[ext] ?? 0) + (cnt as number);
    }
  }
  const projects = Array.from(projMap.entries())
    .map(([name, d]) => ({ name, sessions: d.sessions, linesAdded: d.linesAdded, lang: d.lang }))
    .sort((a, b) => b.sessions - a.sessions);

  // ── Heatmap: date → count ───────────────────────────────────────────────────
  const heatmap: Record<string, number> = {};
  for (const s of sessionsJs) { heatmap[s.date] = (heatmap[s.date] ?? 0) + 1; }

  // ── Language breakdown (aggregate) ──────────────────────────────────────────
  const langAgg: Record<string, number> = { ...summary.languageBreakdown };
  const langTotal = Object.values(langAgg).reduce((a, n) => a + n, 0);

  // Blue-family palette for language bars (single-hue, varying opacity) --
  // avoids multi-hue competition with the header accent per blind review finding.
  const langOpacities = [1, 0.75, 0.55, 0.38, 0.24, 0.14];
  const langEntries = Object.entries(langAgg)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([ext, cnt], i) => ({
      ext: ext || '(none)',
      cnt,
      pct: langTotal > 0 ? Math.round(cnt / langTotal * 100) : 0,
      opacity: langOpacities[i] ?? 0.1,
    }));

  // ── Quality signals ──────────────────────────────────────────────────────────
  const sessWithRetries = sessionsJs.filter(s => s.steps > 0);
  const avgRetryRate = sessWithRetries.length > 0
    ? (sessWithRetries.reduce((a, s) => a + s.retries / Math.max(s.steps, 1), 0) / sessWithRetries.length * 100).toFixed(1)
    : '0';
  const sessWithChurn = sessionsJs.filter(s => s.churn != null);
  const avgChurn = sessWithChurn.length > 0
    ? (sessWithChurn.reduce((a, s) => a + (s.churn ?? 0), 0) / sessWithChurn.length).toFixed(1)
    : null;
  const confHigh    = sessionsJs.filter(s => s.confidence === 'high').length;
  const confPartial = sessionsJs.filter(s => s.confidence === 'partial').length;
  const confNone    = sessionsJs.filter(s => s.confidence === 'none').length;

  // ── Token cost data for Tokens tab ──────────────────────────────────────────
  const modelMap = new Map<string, { inp: number; out: number; cr: number; cw: number; count: number }>();
  for (const s of sessionsJs) {
    const key = s.model ?? '(unknown)';
    if (!modelMap.has(key)) modelMap.set(key, { inp: 0, out: 0, cr: 0, cw: 0, count: 0 });
    const e = modelMap.get(key)!;
    e.inp += s.tok_in; e.out += s.tok_out; e.cr += s.tok_cache_r; e.cw += s.tok_cache_w; e.count++;
  }
  const modelBreakdown = Array.from(modelMap.entries())
    .map(([model, d]) => ({ model, ...d }))
    .sort((a, b) => (b.inp + b.out) - (a.inp + a.out));

  const safeJson = (v: unknown) => JSON.stringify(v).replace(/<\//g, '<\\/');

  // ── Language bar HTML (single blue family, varying opacity) ─────────────────
  const langBarsHtml = langEntries.map(({ ext, cnt, pct, opacity }) =>
    `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f2f2f7">
      <span style="font-size:13px;flex:1;color:#1d1d1f">${htmlEscape(ext)}</span>
      <div style="flex:2;background:#f2f2f7;border-radius:var(--radius-sm);height:14px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:rgba(0,122,255,${opacity});border-radius:var(--radius-sm)"></div>
      </div>
      <span style="font-size:11px;color:#6e6e73;width:40px;text-align:right;font-variant-numeric:tabular-nums">${cnt.toLocaleString()}</span>
    </div>`,
  ).join('') || '<p style="color:#aeaeb2;font-size:13px">No language data available</p>';

  // ── Per-project rows HTML ────────────────────────────────────────────────────
  const maxProjSessions = Math.max(...projects.map(p => p.sessions), 1);
  const projRowsHtml = projects.slice(0, 10).map((p) => {
    const barPct = Math.round(p.sessions / maxProjSessions * 100);
    const topLang = Object.entries(p.lang).sort(([, a], [, b]) => b - a).slice(0, 3)
      .map(([ext]) => ext).join(' ');
    return `<tr>
      <td style="font-weight:600">${htmlEscape(p.name)}</td>
      <td><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;background:#f2f2f7;border-radius:var(--radius-sm);height:18px;position:relative;overflow:hidden;min-width:80px"><div style="position:absolute;left:0;top:0;height:100%;width:${barPct}%;background:#007aff;border-radius:var(--radius-sm)"></div></div><span style="font-size:13px;font-weight:600;color:#1d1d1f;width:32px;text-align:right">${p.sessions}</span></div></td>
      <td style="text-align:right;color:#1a7a3a;font-variant-numeric:tabular-nums">+${p.linesAdded.toLocaleString()}</td>
      <td style="text-align:right;font-size:11px;color:#aeaeb2">${htmlEscape(topLang)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" style="color:#aeaeb2;text-align:center;padding:12px">No project data</td></tr>';

  // ── Token split rows ─────────────────────────────────────────────────────────
  const tokCards = [
    { label: 'Input tokens',      val: inputTok,  price: PRICE_INPUT,   note: `$${PRICE_INPUT}/1M` },
    { label: 'Output tokens',     val: outputTok, price: PRICE_OUTPUT,  note: `$${PRICE_OUTPUT}/1M` },
    { label: 'Cache reads',       val: cacheR,    price: PRICE_CACHE_R, note: `$${PRICE_CACHE_R}/1M (10x cheaper)` },
    { label: 'Cache writes',      val: cacheW,    price: PRICE_CACHE_W, note: `$${PRICE_CACHE_W}/1M` },
  ].map(({ label, val, price, note }) => {
    const cost = (val * price / 1_000_000);
    return `<div style="background:#f5f5f7;border-radius:var(--radius-sm);padding:16px 20px">
      <div style="font-size:22px;font-weight:700;letter-spacing:-0.5px;color:#1d1d1f">${fmtTokens(val)}</div>
      <div style="font-size:12px;color:#6e6e73;margin-top:2px">${htmlEscape(label)}</div>
      <div style="font-size:11px;color:#aeaeb2;margin-top:4px">${note} &middot; ~$${cost.toFixed(2)}</div>
    </div>`;
  }).join('');

  const modelRowsHtml = modelBreakdown.map((m) => {
    const totalTok = m.inp + m.out + m.cr + m.cw;
    const cost = (m.inp * PRICE_INPUT + m.out * PRICE_OUTPUT + m.cr * PRICE_CACHE_R + m.cw * PRICE_CACHE_W) / 1_000_000;
    return `<tr>
      <td style="font-weight:600">${htmlEscape(m.model)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtTokens(totalTok)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${m.count}</td>
      <td style="text-align:right;color:#6e6e73">~$${cost.toFixed(2)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" style="color:#aeaeb2;text-align:center;padding:12px">No token data (requires Claude Code JSONL)</td></tr>';

  // ── Outcome-stacked chart data (activity tab) ───────────────────────────────
  const activityData: Record<string, { success: number; partial: number; other: number }> = {};
  for (const s of sessionsJs) {
    const d = s.date;
    if (!activityData[d]) activityData[d] = { success: 0, partial: 0, other: 0 };
    if (s.outcome === 'success') activityData[d].success++;
    else if (s.outcome === 'partial') activityData[d].partial++;
    else activityData[d].other++;
  }

  // ── Coverage summary: per-session data type availability ────────────────────
  const hasGitEvidence = sessionsJs.filter(s => s.confidence === 'high' || s.confidence === 'partial').length;
  const hasTokenData   = sessionsJs.filter(s => s.tok_in + s.tok_out > 0).length;
  const hasOutcome     = sessionsJs.filter(s => s.outcome !== null).length;
  const hasPrRefs      = sessionsJs.filter(s => s.pr_refs.length > 0).length;

  // ── Hero narrative (engine-authoritative only) ──────────────────────────────
  const heroLines = summary.totalLinesAdded;
  const totalPRs = sessionsJs.reduce((a, s) => a + s.pr_refs.length, 0);
  const uniquePRs = new Set(sessionsJs.flatMap(s => s.pr_refs)).size;
  // Scope hero claims to the sessions that actually have the data.
  // heroMain is the primary claim (shown in white); heroAccent is the highlighted suffix (shown in accent color).
  const heroMain = heroLines > 0
    ? `${summary.totalSessions} guided sessions`
    : `${summary.totalSessions} guided sessions`;
  const heroAccent = heroLines > 0
    ? `${heroLines.toLocaleString()} lines shipped across ${hasGitEvidence} sessions with git data${uniquePRs > 0 ? `, ${uniquePRs} PRs` : ''}.`
    : `ran over ${Math.ceil(summary.totalDurationMs / 3_600_000)}h.`;

  // ── Main HTML output ─────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WorkRail Report -- ${htmlEscape(dateRange.since)} to ${htmlEscape(dateRange.until)}</title>
<style>
:root{
  /* WorkRail report token system */
  --bg:#f5f5f7;--surface:#fff;--hdr:#1d1d1f;
  --accent:#007aff;--txt:#1d1d1f;--txt2:#6e6e73;--txt3:#aeaeb2;
  --border:#f2f2f7;--border2:#e5e5ea;
  --success:#34c759;--error:#ff3b30;--warn:#ff9500;
  --radius:14px;--radius-sm:6px;--radius-pill:20px;
  --shadow:0 1px 4px rgba(0,0,0,.07);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --space-micro:2px;--space-half:4px;
  /* Trust badge colors */
  --trust-engine:#007aff;--trust-engine-bg:#e1f0ff;
  --trust-interp:#6366f1;--trust-interp-bg:#eef2ff;
  --trust-agent:#ff9500;--trust-agent-bg:#fff3e0;
  --trust-none:#aeaeb2;--trust-none-bg:#f5f5f5;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--bg);color:var(--txt);line-height:1.5;min-height:100vh}

/* DARK HEADER */
.site-header{background:var(--hdr);padding:28px 40px 20px}
.hdr-inner{max-width:940px;margin:0 auto;display:flex;align-items:flex-start;justify-content:space-between;gap:40px}
.hdr-cost-value{font-size:64px;font-weight:700;letter-spacing:-2.5px;color:#fff;line-height:1}
.hdr-cost-label{font-size:12px;color:rgba(255,255,255,.55);margin-top:var(--space-half)}
.hdr-cost-disclaimer{font-size:10px;color:rgba(255,255,255,.28);margin-top:var(--space-micro)}
.hdr-stats{display:flex;gap:40px;align-items:flex-start;padding-top:10px;border-left:1px solid rgba(255,255,255,.1);padding-left:40px}
.hdr-stat-value{font-size:32px;font-weight:700;letter-spacing:-1px;color:rgba(255,255,255,.8);line-height:1}
.hdr-stat-label{font-size:11px;color:rgba(255,255,255,.4);margin-top:var(--space-half)}
.hdr-meta{background:var(--hdr);border-top:1px solid rgba(255,255,255,.06);padding:8px 40px}
.hdr-meta-inner{max-width:940px;margin:0 auto;display:flex;justify-content:space-between;font-size:11px;color:rgba(255,255,255,.25)}

/* MAIN */
.main{max-width:940px;margin:0 auto;padding:28px 24px}

/* CALLOUT */
.callout{background:var(--surface);border-radius:var(--radius);padding:20px 24px;box-shadow:var(--shadow);margin-bottom:20px;font-size:14px;line-height:1.65}

/* KPI ROW */
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
.kpi{background:var(--surface);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow)}
.kpi-value{font-size:30px;font-weight:700;letter-spacing:-1px;line-height:1;margin-bottom:var(--space-half);color:var(--accent)}
.kpi-label{font-size:12px;color:var(--txt2);line-height:1.4}
.kpi-sub{font-size:10px;color:var(--txt3);margin-top:var(--space-micro)}

/* TABS */
.tabs{display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap}
.tab{padding:7px 16px;border-radius:var(--radius-pill);font-size:13px;font-weight:500;cursor:pointer;border:1.5px solid transparent;background:var(--surface);color:#3a3a3c;box-shadow:0 1px 3px rgba(0,0,0,.08);transition:all .15s;font-family:var(--font)}
.tab:hover{border-color:var(--accent);color:var(--accent)}
.tab.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.view{display:none}.view.active{display:block}

/* CARDS */
.card{background:var(--surface);border-radius:var(--radius);padding:24px 26px;box-shadow:var(--shadow);margin-bottom:18px}
.card h2{font-size:17px;font-weight:600;margin-bottom:var(--space-micro)}
.card-sub{font-size:12px;color:var(--txt2);margin-bottom:18px}

/* TWO-COL GRID */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}

/* TABLES */
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;padding:0 10px 10px 0;font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--txt3);border-bottom:1px solid var(--border)}
.tbl th.r{text-align:right}
.tbl td{padding:9px 10px 9px 0;border-bottom:1px solid var(--border);vertical-align:middle}
.tbl td.r{text-align:right;color:var(--txt2);font-variant-numeric:tabular-nums}
.tbl tr:last-child td{border-bottom:none}
.total-row td{padding-top:12px;font-weight:600;border-top:2px solid var(--border2);border-bottom:none!important}

/* BARS */
.bar-outer{background:var(--border);border-radius:var(--radius-sm);height:18px;position:relative;overflow:hidden;min-width:80px}
.bar-inner{background:var(--accent);border-radius:var(--radius-sm);height:100%;position:absolute;top:0;left:0}

/* ACTIVITY CHART */
.chart-wrap{position:relative}
.y-axis{position:absolute;left:0;top:0;bottom:24px;width:32px;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none}
.y-label{font-size:10px;color:var(--txt3);text-align:right;padding-right:6px}
.bar-chart-area{margin-left:36px}
.bar-chart{display:flex;align-items:flex-end;gap:3px;height:140px;border-bottom:1px solid var(--border2)}
.bc-bar{flex:1;background:var(--accent);border-radius:2px 2px 0 0;min-width:4px;position:relative;cursor:default;transition:opacity .1s}
.bc-bar:hover{opacity:.7}
.bc-bar:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--hdr);color:#fff;font-size:11px;padding:4px 8px;border-radius:var(--radius-sm);white-space:nowrap;z-index:10;pointer-events:none}
.bar-chart-axis{display:flex;gap:3px;margin-top:4px}
.bar-chart-label{flex:1;font-size:9px;color:var(--txt3);text-align:center;overflow:hidden}

/* SESSION LIST */
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.controls select,.controls input{padding:6px 10px;border:1.5px solid var(--border2);border-radius:var(--radius-sm);font-size:12px;background:var(--surface);color:var(--txt);outline:none;font-family:var(--font)}
.controls select:focus,.controls input:focus{border-color:var(--accent)}
.stats-bar{display:flex;gap:20px;padding:10px 0 14px;border-bottom:1px solid var(--border);margin-bottom:14px;font-size:12px;flex-wrap:wrap}
.stat-val{font-weight:600;color:var(--txt)}
.stat-lbl{color:var(--txt2)}
.sess-item{display:grid;grid-template-columns:76px 28px 150px 1fr 80px 70px;gap:10px;align-items:start;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px}
.sess-item:last-child{border-bottom:none}
.sess-date{font-size:11px;color:var(--txt3);padding-top:2px}
.sess-dot{width:8px;height:8px;border-radius:50%;margin-top:4px;flex-shrink:0}
.dot-done{background:var(--success)}.dot-skip{background:var(--border2);border:1.5px solid var(--txt3)}
.sess-wf{font-size:11px;font-weight:600;color:var(--txt2);padding-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sess-goal{line-height:1.4;color:var(--txt)}
.sess-no-goal{color:var(--txt3);font-style:italic}
.sess-meta{font-size:11px;color:var(--txt2);margin-top:var(--space-micro)}
.badge{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:var(--radius-sm);white-space:nowrap}
.b-success{background:#e1f8ec;color:#1a7a3a}
.b-partial{background:#fff8e0;color:#9a6000}
.b-abandoned{background:#f5f5f5;color:#999}
.b-error{background:#ffeaea;color:var(--error)}
.sess-num{font-size:11px;color:var(--txt2);text-align:right;padding-top:2px;font-variant-numeric:tabular-nums}
.pag{display:flex;gap:6px;justify-content:center;align-items:center;margin-top:16px;flex-wrap:wrap}
.pg-btn{padding:5px 11px;border:1.5px solid var(--border2);border-radius:var(--radius-sm);font-size:12px;cursor:pointer;background:var(--surface);color:#3a3a3c;font-family:var(--font)}
.pg-btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.pg-btn.active{background:var(--accent);color:#fff;border-color:var(--accent);cursor:default}
.pg-btn:disabled{opacity:.35;cursor:default}

/* QUALITY */
.qual-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.qual-card{background:var(--bg);border-radius:var(--radius-sm);padding:20px;text-align:center}
.qual-value{font-size:28px;font-weight:700;letter-spacing:-1px}
.qual-label{font-size:11px;color:var(--txt2);margin-top:var(--space-half)}
.qual-note{font-size:10px;color:var(--txt3);margin-top:var(--space-micro)}

/* TRUST BADGES */
.trust{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;padding:2px 7px;border-radius:var(--radius-pill);white-space:nowrap}
.trust-engine{background:var(--trust-engine-bg);color:var(--trust-engine)}
.trust-interp{background:var(--trust-interp-bg);color:var(--trust-interp)}
.trust-agent{background:var(--trust-agent-bg);color:var(--trust-agent)}
.trust-none{background:var(--trust-none-bg);color:var(--trust-none)}
/* HERO */
.hero{padding:40px 40px 32px;background:var(--hdr);border-bottom:1px solid rgba(255,255,255,.06)}
.hero-inner{max-width:940px;margin:0 auto}
.hero-nav{display:inline-flex;align-items:center;gap:0;margin-bottom:22px;background:rgba(0,0,0,.45);border:1px solid rgba(255,255,255,.10);border-radius:8px;padding:10px 16px;font-family:ui-monospace,"SF Mono","Fira Code",monospace;font-size:13px;line-height:1;white-space:nowrap;overflow-x:auto;max-width:100%}
.nav-prompt{color:#30d158;margin-right:10px;font-weight:700;user-select:none}
.nav-cmd{color:#fff;font-weight:600}
.nav-sub{color:rgba(255,255,255,.55)}
.nav-flag{color:#5ac8fa}
.nav-val{color:#ffd60a}
.nav-cursor{display:inline-block;width:8px;height:13px;background:#fff;vertical-align:middle;margin-left:6px;animation:blink 1.1s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.hero-h1{font-size:36px;font-weight:700;letter-spacing:-1px;color:#fff;line-height:1.15;margin-bottom:12px}
.hero-h1 span{color:var(--accent)}
.hero-sub{font-size:14px;color:rgba(255,255,255,.55);line-height:1.6;max-width:640px;margin-bottom:20px}
.hero-pills{display:flex;gap:8px;flex-wrap:wrap}
.hero-pill{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:var(--radius-pill);padding:4px 12px;font-size:12px;color:rgba(255,255,255,.6);cursor:default}
/* META BAR */
.meta-bar{background:var(--hdr);border-top:1px solid rgba(255,255,255,.06);padding:8px 40px}
.meta-bar-inner{max-width:940px;margin:0 auto;display:flex;justify-content:space-between;font-size:11px;color:rgba(255,255,255,.22);font-family:ui-monospace,monospace}
/* MAIN */
.main{max-width:940px;margin:0 auto;padding:28px 24px}
/* KPI GRID */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
.kpi{background:var(--surface);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow)}
.kpi-value{font-size:36px;font-weight:700;letter-spacing:-1.5px;color:var(--txt);line-height:1;margin-bottom:6px}
.kpi-label{font-size:12px;color:var(--txt2);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.kpi-delta{font-size:11px;color:var(--txt3);margin-top:4px}
/* SECTION HEADERS */
.section-hdr{display:flex;align-items:baseline;gap:12px;margin:32px 0 16px}
.section-num{font-size:11px;font-weight:700;color:var(--txt3);font-variant-numeric:tabular-nums;min-width:16px}
.section-title{font-size:18px;font-weight:700;letter-spacing:-0.3px;color:var(--txt)}
.section-meta{font-size:12px;color:var(--txt3);margin-left:auto}
/* TRUST LEGEND */
.trust-legend{background:var(--surface);border-radius:var(--radius);padding:20px 24px;box-shadow:var(--shadow);margin-bottom:28px}
.trust-legend-title{font-size:13px;font-weight:600;color:var(--txt);margin-bottom:4px}
.trust-legend-sub{font-size:12px;color:var(--txt2);margin-bottom:16px}
.trust-legend-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.trust-legend-item h4{font-size:12px;font-weight:600;color:var(--txt);margin-bottom:3px;display:flex;align-items:center;gap:6px}
.trust-legend-item p{font-size:11px;color:var(--txt2);line-height:1.4}
/* COVERAGE */
.coverage-table{width:100%;font-size:13px;margin-bottom:8px}
.coverage-table td{padding:7px 0;border-bottom:1px solid var(--border)}
.coverage-table tr:last-child td{border-bottom:none}
.coverage-bar-outer{background:var(--border);border-radius:var(--radius-sm);height:8px;flex:1;overflow:hidden}
.coverage-bar-inner{height:100%;border-radius:var(--radius-sm)}
/* CARDS */
.card{background:var(--surface);border-radius:var(--radius);padding:24px 26px;box-shadow:var(--shadow);margin-bottom:18px}
.card-title{font-size:15px;font-weight:600;margin-bottom:4px;color:var(--txt)}
.card-sub{font-size:12px;color:var(--txt2);margin-bottom:16px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}
/* TABLES */
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;padding:0 10px 10px 0;font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--txt3);border-bottom:1px solid var(--border)}
.tbl th.r{text-align:right}
.tbl td{padding:9px 10px 9px 0;border-bottom:1px solid var(--border);vertical-align:middle}
.tbl td.r{text-align:right;color:var(--txt2);font-variant-numeric:tabular-nums}
.tbl tr:last-child td{border-bottom:none}
.total-row td{padding-top:12px;font-weight:600;border-top:2px solid var(--border2);border-bottom:none!important}
/* BARS */
.bar-outer{background:var(--border);border-radius:var(--radius-sm);height:18px;position:relative;overflow:hidden;min-width:80px}
.bar-inner{background:var(--accent);border-radius:var(--radius-sm);height:100%;position:absolute;top:0;left:0}
/* ACTIVITY CHART */
.chart-wrap{position:relative}
.y-axis{position:absolute;left:0;top:0;bottom:24px;width:32px;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none}
.y-label{font-size:10px;color:var(--txt3);text-align:right;padding-right:6px}
.bar-chart-area{margin-left:36px}
.bar-chart{display:flex;align-items:flex-end;gap:3px;height:140px;border-bottom:1px solid var(--border2)}
.bc-bar{flex:1;border-radius:2px 2px 0 0;min-width:4px;position:relative;cursor:default;transition:opacity .1s}
.bc-bar:hover{opacity:.75}
.bc-bar:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--hdr);color:#fff;font-size:11px;padding:4px 8px;border-radius:var(--radius-sm);white-space:nowrap;z-index:10;pointer-events:none}
.bar-chart-axis{display:flex;gap:3px;margin-top:4px}
.bar-chart-label{flex:1;font-size:9px;color:var(--txt3);text-align:center;overflow:hidden}
/* DONUT */
.workflow-mix{display:grid;grid-template-columns:1fr 200px;gap:24px;align-items:start}
.donut-wrap{display:flex;flex-direction:column;align-items:center}
.donut-list{font-size:12px}
.donut-list-row{display:flex;align-items:center;gap:8px;padding:4px 0}
.donut-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
/* SESSIONS */
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.controls select,.controls input{padding:6px 10px;border:1.5px solid var(--border2);border-radius:var(--radius-sm);font-size:12px;background:var(--surface);color:var(--txt);outline:none;font-family:var(--font)}
.controls select:focus,.controls input:focus{border-color:var(--accent)}
.stats-bar{display:flex;gap:20px;padding:10px 0 14px;border-bottom:1px solid var(--border);margin-bottom:14px;font-size:12px;flex-wrap:wrap}
.stat-val{font-weight:600;color:var(--txt)}
.stat-lbl{color:var(--txt2)}
.sess-item{display:grid;grid-template-columns:70px 24px 1fr auto;gap:10px;align-items:start;padding:11px 0;border-bottom:1px solid var(--border);font-size:13px}
.sess-item:last-child{border-bottom:none}
.sess-date{font-size:11px;color:var(--txt3);padding-top:2px;font-variant-numeric:tabular-nums}
.sess-dot{width:8px;height:8px;border-radius:50%;margin-top:4px;flex-shrink:0}
.dot-done{background:var(--success)}.dot-skip{background:var(--border2);border:1.5px solid var(--txt3)}
.sess-body{}
.sess-wf{font-size:11px;font-weight:600;color:var(--txt2);margin-bottom:2px}
.sess-goal{line-height:1.4;color:var(--txt);margin-bottom:4px}
.sess-no-goal{color:var(--txt3);font-style:italic}
.sess-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.badge{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:var(--radius-sm);white-space:nowrap}
.b-success{background:#e1f8ec;color:#1a7a3a}
.b-partial{background:#fff8e0;color:#9a6000}
.b-abandoned{background:#f5f5f5;color:#999}
.b-error{background:#ffeaea;color:var(--error)}
.sess-nums{display:flex;flex-direction:column;align-items:flex-end;gap:4px;padding-top:2px;flex-shrink:0;min-width:80px}
.sess-num-main{font-size:13px;font-weight:600;color:var(--txt);font-variant-numeric:tabular-nums}
.sess-num-sub{font-size:11px;color:var(--txt3);font-variant-numeric:tabular-nums}
.pag{display:flex;gap:6px;justify-content:center;align-items:center;margin-top:16px;flex-wrap:wrap}
.pg-btn{padding:5px 11px;border:1.5px solid var(--border2);border-radius:var(--radius-sm);font-size:12px;cursor:pointer;background:var(--surface);color:#3a3a3c;font-family:var(--font)}
.pg-btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.pg-btn.active{background:var(--accent);color:#fff;border-color:var(--accent);cursor:default}
.pg-btn:disabled{opacity:.35;cursor:default}
footer{text-align:center;font-size:11px;color:var(--txt3);margin-top:32px;padding-bottom:24px}
@media(max-width:700px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.hero-h1{font-size:26px}.trust-legend-grid{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}.workflow-mix{grid-template-columns:1fr}.sess-item{grid-template-columns:60px 20px 1fr}}
</style>
</head>
<body>

<!-- HERO -->
<div class="hero">
  <div class="hero-inner">
    <div class="hero-nav">
      <span class="nav-prompt">$</span><span class="nav-cmd">workrail</span>&nbsp;<span class="nav-sub">report</span>&nbsp;<span class="nav-flag">--since</span>&nbsp;<span class="nav-val">${htmlEscape(dateRange.since)}</span>&nbsp;<span class="nav-flag">--until</span>&nbsp;<span class="nav-val">${htmlEscape(dateRange.until)}</span>&nbsp;<span class="nav-flag">--format</span>&nbsp;<span class="nav-val">html</span><span class="nav-cursor"></span>
    </div>
    <h1 class="hero-h1">${htmlEscape(heroMain)} &mdash; <span>${htmlEscape(heroAccent)}</span></h1>
    <p class="hero-sub">
      Across ${htmlEscape(dateRange.since)} &ndash; ${htmlEscape(dateRange.until)}, WorkRail steered <strong>${summary.totalSessions} workflow runs</strong> through guided, step-by-step execution.
      Every number below is labeled by <strong>how much it can be trusted</strong> &mdash; git evidence, interpretation, or the agent&rsquo;s own word.
      Metrics that didn&rsquo;t exist yet read <strong>&ldquo;not tracked&rdquo;</strong>, never a misleading zero.
    </p>
    <div class="hero-pills">
      <span class="hero-pill">${summary.totalSessions} sessions</span>
      ${summary.totalLinesAdded > 0 ? `<span class="hero-pill">+${summary.totalLinesAdded.toLocaleString()} lines</span>` : ''}
      ${totalHours !== '0.0' ? `<span class="hero-pill">${totalHours}h autonomous</span>` : ''}
      ${estCostCents > 0 ? `<span class="hero-pill">${htmlEscape(estCostStr)} spend</span>` : ''}
      ${uniquePRs > 0 ? `<span class="hero-pill">${uniquePRs} PRs</span>` : ''}
    </div>
  </div>
</div>
<div class="meta-bar">
  <div class="meta-bar-inner">
    <span>May 2026 usage report &middot; generated ${new Date(generatedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>
    <span>workrail ${htmlEscape(dateRange.since)} to ${htmlEscape(dateRange.until)}</span>
  </div>
</div>

<div class="main">

<!-- KPI GRID -->
<div class="kpi-grid">
  <div class="kpi">
    <div class="kpi-value">${summary.totalLinesAdded > 0 ? summary.totalLinesAdded.toLocaleString() : '--'}</div>
    <div class="kpi-label">Net lines shipped <span class="trust trust-engine">engine</span></div>
    <div class="kpi-delta">from ${hasGitEvidence} sessions with git data</div>
  </div>
  <div class="kpi">
    <div class="kpi-value">${uniquePRs > 0 ? uniquePRs : '--'}</div>
    <div class="kpi-label">PRs attributed <span class="trust ${uniquePRs > 0 ? 'trust-interp' : 'trust-none'}">${uniquePRs > 0 ? 'from commits' : 'not tracked'}</span></div>
    <div class="kpi-delta">${uniquePRs > 0 ? `across ${hasGitEvidence} sessions with git data` : 'parsed from commit messages'}</div>
  </div>
  <div class="kpi">
    <div class="kpi-value">${totalHours}h</div>
    <div class="kpi-label">Autonomous work <span class="trust trust-engine">engine</span></div>
    <div class="kpi-delta">${summary.completedSessions} sessions completed</div>
  </div>
  <div class="kpi">
    <div class="kpi-value">${estCostCents > 0 ? htmlEscape(estCostStr) : '--'}</div>
    <div class="kpi-label">Total spend <span class="trust ${estCostCents > 0 ? 'trust-interp' : 'trust-none'}">${estCostCents > 0 ? 'estimated' : 'not tracked'}</span></div>
    <div class="kpi-delta">${estCostCents > 0 ? 'Anthropic list pricing' : 'requires Claude Code JSONL'}</div>
  </div>
</div>

<!-- TRUST LEGEND -->
<div class="trust-legend">
  <div class="trust-legend-title">How to read this report</div>
  <div class="trust-legend-sub">Every metric is labeled by its source. Never present unverified data as fact.</div>
  <div class="trust-legend-grid">
    <div class="trust-legend-item">
      <h4><span class="trust trust-engine">engine</span></h4>
      <p>Read from git, event logs, or JSONL. Primary evidence -- diff stats, token counts, timestamps.</p>
    </div>
    <div class="trust-legend-item">
      <h4><span class="trust trust-interp">interpretive</span></h4>
      <p>Real data, uncertain meaning. PR refs from commit messages, cost at list pricing, churn signal.</p>
    </div>
    <div class="trust-legend-item">
      <h4><span class="trust trust-agent">agent reported</span></h4>
      <p>The agent&rsquo;s own word. Outcome, PR numbers claimed. ~53% session coverage. Unverified.</p>
    </div>
    <div class="trust-legend-item">
      <h4><span class="trust trust-none">not tracked yet</span></h4>
      <p>Missing readers, pre-feature sessions, or coverage gaps. Always shown as &ldquo;--&rdquo;, never as zero.</p>
    </div>
  </div>
</div>

<!-- COVERAGE -->
<div class="section-hdr">
  <span class="section-num">01</span>
  <h2 class="section-title">Coverage for this period</h2>
</div>
<div class="card">
  <div class="card-sub">How much of the data was actually captured. Low coverage means sessions predate the feature or the reader isn&rsquo;t configured &mdash; not a pipeline failure.</div>
  <table style="width:100%;font-size:13px;border-collapse:collapse">
    ${[
      { label: 'Git diff captured', n: hasGitEvidence, badge: 'engine', note: '' },
      { label: 'Token data captured', n: hasTokenData, badge: 'engine', note: hasTokenData === 0 ? 'requires Claude Code JSONL reader' : '' },
      { label: 'Outcome reported', n: hasOutcome, badge: 'agent reported', note: '' },
      { label: 'PR refs in commits', n: hasPrRefs, badge: 'interpretive', note: hasPrRefs > 0 ? `from ${hasGitEvidence} sessions with git data` : '' },
    ].map(({ label, n, badge, note }) => {
      const pct = summary.totalSessions > 0 ? Math.round(n / summary.totalSessions * 100) : 0;
      const badgeCls = badge === 'engine' ? 'trust-engine' : badge === 'interpretive' ? 'trust-interp' : 'trust-agent';
      const noteHtml = note ? `<div style="font-size:11px;color:#aeaeb2;margin-top:2px">${htmlEscape(note)}</div>` : '';
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #f2f2f7;width:220px;white-space:nowrap"><span class="trust ${badgeCls}" style="margin-right:8px;vertical-align:middle">${htmlEscape(badge)}</span><span style="vertical-align:middle">${htmlEscape(label)}</span>${noteHtml}</td><td style="padding:8px 0 8px 16px;border-bottom:1px solid #f2f2f7"><div style="display:flex;align-items:center;gap:10px"><div style="flex:1;background:#f2f2f7;border-radius:4px;height:8px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${badge === 'engine' ? '#007aff' : badge === 'interpretive' ? '#6366f1' : '#ff9500'};border-radius:4px"></div></div><span style="font-size:12px;color:#6e6e73;width:60px;text-align:right;white-space:nowrap">${n} / ${summary.totalSessions}</span></div></td></tr>`;
    }).join('')}
  </table>
</div>

<!-- ACTIVITY -->
<div class="section-hdr">
  <span class="section-num">02</span>
  <h2 class="section-title">Activity over time</h2>
  <span class="section-meta">${summary.totalSessions} sessions &middot; daily</span>
</div>
<div class="card">
  <div class="card-sub">Sessions per day, by reported outcome. Stacked bars &mdash; &ldquo;unknown&rdquo; = no outcome reported.</div>
  <div style="display:flex;gap:16px;margin-bottom:12px;font-size:11px;align-items:center">
    <div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:10px;border-radius:2px;background:#34c759"></div>success</div>
    <div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:10px;border-radius:2px;background:#ff9500"></div>partial</div>
    <div style="display:flex;align-items:center;gap:5px"><div style="width:10px;height:10px;border-radius:2px;background:#e5e5ea"></div>unknown</div>
  </div>
  <div class="chart-wrap">
    <div class="y-axis" id="y-axis"></div>
    <div class="bar-chart-area">
      <div class="bar-chart" id="barchart"></div>
      <div class="bar-chart-axis" id="barchart-axis"></div>
    </div>
  </div>
</div>

<!-- WORKFLOW MIX -->
<div class="section-hdr">
  <span class="section-num">03</span>
  <h2 class="section-title">Workflow mix</h2>
  <span class="section-meta" id="wf-count"></span>
</div>
<div class="two-col" style="margin-bottom:18px;align-items:start">
  <div class="card" style="margin-bottom:0">
    <div class="card-title">Runs by workflow</div>
    <div class="card-sub">Bar = session count &middot; % = completion rate &middot; routines listed separately (they don&rsquo;t report outcomes)</div>
    <div id="wf-bars"></div>
  </div>
  <div class="card" style="margin-bottom:0">
    <div class="card-title">Share of sessions</div>
    <div class="card-sub">By workflow type</div>
    <div class="workflow-mix">
      <svg id="donut" width="120" height="120" viewBox="0 0 120 120" style="flex-shrink:0"></svg>
      <div class="donut-list" id="donut-list"></div>
    </div>
  </div>
</div>

<!-- SESSIONS -->
<div class="section-hdr">
  <span class="section-num">04</span>
  <h2 class="section-title">Sessions</h2>
  <span class="section-meta" id="sess-count-hdr"></span>
</div>
<div class="card">
  <div class="controls">
    <select id="sess-workflow"><option value="">All workflows</option></select>
    <select id="sess-status">
      <option value="">All statuses</option>
      <option value="done">Completed</option>
      <option value="partial">Incomplete</option>
    </select>
    <input type="text" id="sess-search" placeholder="Search goals, projects..." style="min-width:200px">
  </div>
  <div class="stats-bar" id="sess-stats"></div>
  <div id="sess-list"></div>
  <div class="pag" id="sess-pag"></div>
</div>

<footer>workrail &middot; <a href="https://github.com/EtienneBBeaulac/workrail" style="color:var(--txt3)">github.com/EtienneBBeaulac/workrail</a></footer>
</div>

<script>
const SESSIONS = ${safeJson(sessionsJs)};
const BREAKDOWN = ${safeJson(breakdown)};
const ROUTINE_BREAKDOWN = ${safeJson(routineBreakdown)};
const HEATMAP = ${safeJson(heatmap)};
const ACTIVITY = ${safeJson(activityData)};
const PAGE_SIZE = 30;

// ── Activity chart (stacked by outcome) ──────────────────────────────────────
(function(){
  const chart=document.getElementById('barchart'),axis=document.getElementById('barchart-axis'),yAxis=document.getElementById('y-axis');
  const keys=Object.keys(HEATMAP).sort(); if(!keys.length)return;
  const entries=[];
  const start=new Date(keys[0]),end=new Date(keys[keys.length-1]);
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
    const k=d.toISOString().slice(0,10);
    const a=ACTIVITY[k]||{success:0,partial:0,other:0};
    entries.push({date:k,label:d.toLocaleDateString('en-US',{month:'short',day:'numeric'}),count:HEATMAP[k]||0,...a});
  }
  const max=Math.max(...entries.map(e=>e.count),1);
  [max,Math.round(max*.5),0].forEach(v=>{const el=document.createElement('div');el.className='y-label';el.textContent=v;yAxis.appendChild(el);});
  entries.forEach(e=>{
    const col=document.createElement('div');col.style.cssText='flex:1;display:flex;flex-direction:column-reverse;align-items:stretch;min-width:4px;gap:1px;height:'+Math.max(4,Math.round(e.count/max*100))+'%';
    const mk=(h,c,tip)=>{if(!h)return;const b=document.createElement('div');b.className='bc-bar';b.style.cssText='flex:0 0 '+Math.round(h/e.count*100)+'%;background:'+c+';border-radius:0';b.setAttribute('data-tip',tip);col.appendChild(b);};
    mk(e.success,'#34c759',e.label+' success: '+e.success);
    mk(e.partial,'#ff9500',e.label+' partial: '+e.partial);
    mk(e.other,'#e5e5ea',e.label+' unknown: '+e.other);
    chart.appendChild(col);
    const lbl=document.createElement('div');lbl.className='bar-chart-label';
    if([1,7,14,21,28].includes(new Date(e.date+'T12:00:00').getDate()))lbl.textContent=e.label;
    axis.appendChild(lbl);
  });
})();

// ── Workflow bars + donut ─────────────────────────────────────────────────────
(function(){
  const COLORS=['#007aff','#34c759','#ff9500','#af52de','#ff3b30','#5ac8fa','#ffcc00','#ff6b6b','#00c7be','#30b0c7'];
  const totalWf=BREAKDOWN.length+(ROUTINE_BREAKDOWN.length>0?1:0);
  document.getElementById('wf-count').textContent=BREAKDOWN.length+' workflows'+(ROUTINE_BREAKDOWN.length>0?' + '+ROUTINE_BREAKDOWN.length+' routines':'');
  const container=document.getElementById('wf-bars');
  const maxS=Math.max(...BREAKDOWN.map(r=>r.started),...ROUTINE_BREAKDOWN.map(r=>r.started),1);
  const renderRow=(r,i,color)=>{
    const ok=r.started>0?Math.round(r.completed/r.started*100):0;
    const div=document.createElement('div');
    div.style.cssText='display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f2f2f7;font-size:12px';
    div.innerHTML='<div style="width:8px;height:8px;border-radius:50%;background:'+color+';flex-shrink:0"></div>'+
      '<span style="flex:1;color:#1d1d1f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+r.label+'</span>'+
      '<div style="width:100px;background:#f2f2f7;border-radius:4px;height:14px;overflow:hidden;flex-shrink:0"><div style="width:'+Math.round(r.started/maxS*100)+'%;height:100%;background:'+color+';opacity:.7"></div></div>'+
      '<span style="color:#6e6e73;width:50px;text-align:right;white-space:nowrap">'+r.started+' &middot; '+ok+'%</span>'+
      '<span style="color:#6e6e73;width:48px;text-align:right">'+r.median+'</span>';
    container.appendChild(div);
  };
  BREAKDOWN.forEach((r,i)=>renderRow(r,i,COLORS[i%COLORS.length]));
  if(ROUTINE_BREAKDOWN.length>0){
    const hdr=document.createElement('div');
    hdr.style.cssText='padding:10px 0 4px;font-size:11px;font-weight:600;color:#aeaeb2;letter-spacing:0.04em;text-transform:uppercase';
    hdr.textContent='Routines (sub-workflows -- outcome reporting does not apply)';
    container.appendChild(hdr);
    ROUTINE_BREAKDOWN.forEach((r,i)=>renderRow(r,i,'#aeaeb2'));
  }
  // Donut
  const svg=document.getElementById('donut');
  const list=document.getElementById('donut-list');
  const total=BREAKDOWN.reduce((a,r)=>a+r.started,0);
  let ang=-Math.PI/2;
  BREAKDOWN.slice(0,8).forEach((r,i)=>{
    const frac=r.started/Math.max(total,1);
    const a2=ang+frac*2*Math.PI;
    const x1=60+50*Math.cos(ang),y1=60+50*Math.sin(ang);
    const x2=60+50*Math.cos(a2),y2=60+50*Math.sin(a2);
    const large=frac>.5?1:0;
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d','M 60 60 L '+x1+' '+y1+' A 50 50 0 '+large+' 1 '+x2+' '+y2+' Z');
    path.setAttribute('fill',COLORS[i%COLORS.length]);
    svg.appendChild(path);
    // Center hole
    const hole=document.createElementNS('http://www.w3.org/2000/svg','circle');
    hole.setAttribute('cx','60');hole.setAttribute('cy','60');hole.setAttribute('r','30');hole.setAttribute('fill','white');
    svg.appendChild(hole);
    // Center label
    const ct=document.createElementNS('http://www.w3.org/2000/svg','text');
    ct.setAttribute('x','60');ct.setAttribute('y','57');ct.setAttribute('text-anchor','middle');ct.setAttribute('font-size','16');ct.setAttribute('font-weight','700');ct.setAttribute('fill','#1d1d1f');ct.textContent=total;
    svg.appendChild(ct);
    const cl=document.createElementNS('http://www.w3.org/2000/svg','text');
    cl.setAttribute('x','60');cl.setAttribute('y','70');cl.setAttribute('text-anchor','middle');cl.setAttribute('font-size','9');cl.setAttribute('fill','#6e6e73');cl.textContent='sessions';
    svg.appendChild(cl);
    // List
    const row=document.createElement('div');row.className='donut-list-row';
    row.innerHTML='<div class="donut-dot" style="background:'+COLORS[i%COLORS.length]+'"></div>'+
      '<span style="flex:1;color:#1d1d1f">'+r.label+'</span>'+
      '<span style="color:#6e6e73;margin-left:8px">'+r.started+'</span>'+
      '<span style="color:#aeaeb2;margin-left:6px;width:30px;text-align:right">'+Math.round(frac*100)+'%</span>';
    list.appendChild(row);
    ang=a2;
  });
})();

// ── Sessions ──────────────────────────────────────────────────────────────────
let sp=1,sf=SESSIONS.slice();
(function(){
  const sel=document.getElementById('sess-workflow');
  [...new Set(SESSIONS.map(s=>s.workflow_label))].sort().forEach(l=>{const o=document.createElement('option');o.value=l;o.textContent=l;sel.appendChild(o);});
  document.getElementById('sess-count-hdr').textContent=SESSIONS.length.toLocaleString()+' total';
})();
function fD(m){if(!m)return'--';return m<60?Math.round(m)+'m':(m/60).toFixed(1)+'h';}
function fT(n){if(!n)return'--';if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return Math.round(n/1e3)+'k';return String(n);}
function fC(c){if(!c)return null;return c>=100?'$'+(c/100).toFixed(0):'$'+(c/100).toFixed(2);}
function applyF(){
  const wf=document.getElementById('sess-workflow').value;
  const st=document.getElementById('sess-status').value;
  const q=document.getElementById('sess-search').value.toLowerCase();
  sf=SESSIONS.filter(s=>(!wf||s.workflow_label===wf)&&(!st||(st==='done'?s.completed:!s.completed))&&(!q||s.goal.toLowerCase().includes(q)||s.project.toLowerCase().includes(q)||s.date.includes(q)));
  sp=1;renderS();
}
function renderS(){
  const list=document.getElementById('sess-list');
  const total=sf.length,start=(sp-1)*PAGE_SIZE,page=sf.slice(start,Math.min(start+PAGE_SIZE,total));
  const comp=sf.filter(s=>s.completed).length;
  const tLines=sf.reduce((a,s)=>a+s.lines_added,0);
  const avgD=sf.filter(s=>s.duration_min).reduce((a,s)=>a+s.duration_min,0)/(sf.filter(s=>s.duration_min).length||1);
  document.getElementById('sess-stats').innerHTML=
    '<div><span class="stat-val">'+total+'</span> <span class="stat-lbl">sessions</span></div>'+
    '<div><span class="stat-val" style="color:#34c759">'+comp+'</span> <span class="stat-lbl">completed</span></div>'+
    '<div><span class="stat-val">'+Math.round(comp/Math.max(total,1)*100)+'%</span> <span class="stat-lbl">rate</span></div>'+
    (tLines?'<div><span class="stat-val trust trust-engine" style="font-size:12px">+'+tLines.toLocaleString()+' lines</span></div>':'')+
    '<div><span class="stat-val">'+fD(Math.round(avgD*10)/10)+'</span> <span class="stat-lbl">avg duration</span></div>'+
    '<div style="margin-left:auto;font-size:11px;color:#aeaeb2">'+( start+1)+'&#8211;'+Math.min(start+PAGE_SIZE,total)+'</div>';
  list.innerHTML='';
  for(const s of page){
    const div=document.createElement('div');div.className='sess-item';
    // Tags row
    const tags=[];
    if(s.lines_added>0) tags.push('<span class="trust trust-engine" style="font-size:10px">+'+s.lines_added+' lines</span>');
    if(s.tok_in+s.tok_out>0) tags.push('<span class="trust trust-engine" style="font-size:10px">'+fT(s.tok_in+s.tok_out)+' tok</span>');
    const cost=fC(s.est_cost_cents);
    if(cost) tags.push('<span class="trust trust-interp" style="font-size:10px">'+cost+'</span>');
    if(s.pr_refs.length) tags.push('<span class="trust trust-interp" style="font-size:10px">'+s.pr_refs.length+' PR'+(s.pr_refs.length>1?'s':'')+'</span>');
    if(s.retries>0) tags.push('<span class="trust trust-agent" style="font-size:10px;color:#ff9500">'+s.retries+' retr.</span>');
    if(s.outcome) tags.push('<span class="badge b-'+s.outcome+'" style="font-size:10px">'+s.outcome+'</span>');
    div.innerHTML=
      '<div class="sess-date">'+s.date+'</div>'+
      '<div><div class="sess-dot '+(s.completed?'dot-done':'dot-skip')+'"></div></div>'+
      '<div class="sess-body">'+
        '<div class="sess-wf">'+s.workflow_label+(s.project?' &middot; <span style="font-weight:400;color:#aeaeb2">'+s.project+'</span>':'')+'</div>'+
        '<div class="'+(s.goal?'sess-goal':'sess-no-goal')+'">'+(s.goal||'No goal recorded')+'</div>'+
        (tags.length?'<div class="sess-tags">'+tags.join('')+'</div>':'')+
      '</div>'+
      '<div class="sess-nums">'+
        '<div class="sess-num-main">'+fD(s.duration_min)+'</div>'+
        (s.steps?'<div class="sess-num-sub">'+s.steps+' steps</div>':'')+
      '</div>';
    list.appendChild(div);
  }
  const pag=document.getElementById('sess-pag');pag.innerHTML='';
  const pages=Math.ceil(total/PAGE_SIZE);if(pages<=1)return;
  const prev=document.createElement('button');prev.className='pg-btn';prev.textContent='Prev';prev.disabled=sp===1;
  prev.addEventListener('click',()=>{sp--;renderS();});pag.appendChild(prev);
  for(let p=Math.max(1,sp-2);p<=Math.min(pages,sp+2);p++){
    const b=document.createElement('button');b.className='pg-btn'+(p===sp?' active':'');b.textContent=p;
    b.addEventListener('click',()=>{sp=p;renderS();});pag.appendChild(b);
  }
  const next=document.createElement('button');next.className='pg-btn';next.textContent='Next';next.disabled=sp===pages;
  next.addEventListener('click',()=>{sp++;renderS();});pag.appendChild(next);
}
['sess-workflow','sess-status'].forEach(id=>document.getElementById(id).addEventListener('change',applyF));
document.getElementById('sess-search').addEventListener('input',applyF);
applyF();
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
