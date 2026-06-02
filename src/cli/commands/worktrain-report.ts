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

  // ── Breakdown: per-workflow ──────────────────────────────────────────────────
  const wfMap = new Map<string, { started: number; completed: number; durations: number[]; linesAdded: number }>();
  for (const s of sessionsJs) {
    const label = s.workflow_label;
    if (!wfMap.has(label)) wfMap.set(label, { started: 0, completed: 0, durations: [], linesAdded: 0 });
    const e = wfMap.get(label)!;
    e.started++;
    if (s.completed) e.completed++;
    if (s.duration_min != null) e.durations.push(s.duration_min);
    e.linesAdded += s.lines_added;
  }
  const breakdown = Array.from(wfMap.entries()).map(([label, d]) => {
    const sorted = [...d.durations].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]!.toFixed(0) + 'm' : '--';
    return { label, started: d.started, completed: d.completed, median, linesAdded: d.linesAdded };
  }).sort((a, b) => b.completed - a.completed);

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

  // ── Main HTML output ─────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WorkRail Report -- ${htmlEscape(dateRange.since)} to ${htmlEscape(dateRange.until)}</title>
<style>
:root{
  --bg:#f5f5f7;--surface:#fff;--hdr:#1d1d1f;
  --accent:#007aff;--txt:#1d1d1f;--txt2:#6e6e73;--txt3:#aeaeb2;
  --border:#f2f2f7;--border2:#e5e5ea;
  --success:#34c759;--error:#ff3b30;--warn:#ff9500;
  --radius:14px;--radius-sm:6px;--radius-pill:20px;
  --shadow:0 1px 4px rgba(0,0,0,.07);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --space-micro:2px;--space-half:4px;
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

footer{text-align:center;font-size:11px;color:var(--txt3);margin-top:28px}
@media(max-width:700px){.kpi-row{grid-template-columns:repeat(2,1fr)}.hdr-stats{display:none}.two-col{grid-template-columns:1fr}.qual-grid{grid-template-columns:repeat(2,1fr)}.sess-item{grid-template-columns:60px 24px 1fr}}
</style>
</head>
<body>

<!-- DARK HEADER -->
<div class="site-header">
  <div class="hdr-inner">
    <div>
      <div class="hdr-cost-value">${htmlEscape(estCostStr)}</div>
      <div class="hdr-cost-label">ESTIMATED COST THIS PERIOD</div>
      <div class="hdr-cost-disclaimer">Anthropic list pricing &middot; actual cost varies by tier &amp; model</div>
    </div>
    <div class="hdr-stats">
      <div>
        <div class="hdr-stat-value">${summary.totalSessions.toLocaleString()}</div>
        <div class="hdr-stat-label">Sessions</div>
      </div>
      <div>
        <div class="hdr-stat-value">${completionPct}%</div>
        <div class="hdr-stat-label">Completion rate</div>
      </div>
    </div>
  </div>
</div>
<div class="hdr-meta">
  <div class="hdr-meta-inner">
    <span>WorkRail Report &middot; ${htmlEscape(dateRange.since)} to ${htmlEscape(dateRange.until)}</span>
    <span>Generated ${new Date(generatedAt).toLocaleString()}</span>
  </div>
</div>

<div class="main">

<div class="callout" id="callout">Loading...</div>

<div class="kpi-row">
  <div class="kpi">
    <div class="kpi-value">${totalHours}h</div>
    <div class="kpi-label">Autonomous runtime</div>
    <div class="kpi-sub">wall clock, ${dateRange.since} to ${dateRange.until}</div>
  </div>
  <div class="kpi">
    <div class="kpi-value">${fmtTokens(summary.totalLinesAdded)}</div>
    <div class="kpi-label">Lines of code added</div>
    <div class="kpi-sub">engine-authoritative git diff</div>
  </div>
  <div class="kpi">
    <div class="kpi-value">${fmtTokens(totalTokens)}</div>
    <div class="kpi-label">Total tokens</div>
    <div class="kpi-sub">input + output + cache</div>
  </div>
  <div class="kpi">
    <div class="kpi-value">${fmtDuration(summary.totalDurationMs / summary.completedSessions || undefined)}</div>
    <div class="kpi-label">Avg session duration</div>
    <div class="kpi-sub">completed sessions only</div>
  </div>
</div>

<div class="tabs">
  <button class="tab active" data-view="overview">Overview</button>
  <button class="tab" data-view="tokens">Tokens &amp; Cost</button>
  <button class="tab" data-view="activity">Activity</button>
  <button class="tab" data-view="quality">Quality</button>
  <button class="tab" data-view="sessions">Sessions</button>
</div>

<!-- OVERVIEW TAB -->
<div class="view active" id="view-overview">
  <div class="two-col">
    <div class="card">
      <h2>By project</h2>
      <p class="card-sub">Sessions and lines added per repository</p>
      <table class="tbl">
        <thead><tr><th>Project</th><th>Sessions</th><th class="r">+Lines</th><th class="r">Languages</th></tr></thead>
        <tbody>${projRowsHtml}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Language breakdown</h2>
      <p class="card-sub">Files changed by extension across all sessions</p>
      ${langBarsHtml}
    </div>
  </div>
  <div class="card">
    <h2>By workflow</h2>
    <p class="card-sub">Completion rate and median duration</p>
    <table class="tbl">
      <thead><tr><th>Workflow</th><th style="min-width:160px">Completed</th><th class="r">Rate</th><th class="r">Median</th><th class="r">+Lines</th></tr></thead>
      <tbody id="breakdown-body"></tbody>
    </table>
  </div>
</div>

<!-- TOKENS TAB -->
<div class="view" id="view-tokens">
  <div class="card">
    <h2>Token cost breakdown</h2>
    <p class="card-sub">Cache reads are priced at $0.30/1M vs $3.00/1M for input -- 10x cheaper. High cache hit rate means lower effective cost.</p>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">
      ${tokCards}
    </div>
    <h2 style="margin-bottom:12px">By model</h2>
    <table class="tbl">
      <thead><tr><th>Model</th><th class="r">Tokens</th><th class="r">Sessions</th><th class="r">Est. cost</th></tr></thead>
      <tbody>${modelRowsHtml}</tbody>
    </table>
    <p style="font-size:11px;color:#aeaeb2;margin-top:16px">Estimates use Anthropic list pricing and do not account for enterprise agreements, Bedrock pricing, or prompt caching tier differences.</p>
  </div>
</div>

<!-- ACTIVITY TAB -->
<div class="view" id="view-activity">
  <div class="card">
    <h2>Daily activity</h2>
    <p class="card-sub">Sessions started per day. Blue = weekday, lighter = weekend.</p>
    <div class="chart-wrap">
      <div class="y-axis" id="y-axis"></div>
      <div class="bar-chart-area">
        <div class="bar-chart" id="barchart"></div>
        <div class="bar-chart-axis" id="barchart-axis"></div>
      </div>
    </div>
  </div>
</div>

<!-- QUALITY TAB -->
<div class="view" id="view-quality">
  <div class="card">
    <h2>Quality signals</h2>
    <p class="card-sub">Step retries, code churn, and git capture confidence indicate output quality.</p>
    <div class="qual-grid">
      <div class="qual-card">
        <div class="qual-value" style="color:${parseFloat(avgRetryRate) < 10 ? 'var(--success)' : parseFloat(avgRetryRate) < 25 ? 'var(--warn)' : 'var(--error)'}">${avgRetryRate}%</div>
        <div class="qual-label">Avg retry rate</div>
        <div class="qual-note">retries / steps per session</div>
      </div>
      <div class="qual-card">
        <div class="qual-value" style="color:var(--accent)">${avgChurn ?? '--'}</div>
        <div class="qual-label">Avg files re-modified</div>
        <div class="qual-note">within 7 days of session end</div>
      </div>
      <div class="qual-card">
        <div class="qual-value" style="color:var(--success)">${summary.totalStepsCompleted.toLocaleString()}</div>
        <div class="qual-label">Steps completed</div>
        <div class="qual-note">total across all sessions</div>
      </div>
    </div>
    <h2 style="margin-top:24px;margin-bottom:12px">Git capture confidence</h2>
    <p class="card-sub" style="margin-bottom:16px">High = authoritative diff from engine. Partial = SHA available but diff incomplete. None = no git data.</p>
    <div style="display:flex;gap:24px;font-size:13px">
      <div><span style="font-size:22px;font-weight:700;color:var(--success)">${confHigh}</span> <span style="color:var(--txt2)">high</span></div>
      <div><span style="font-size:22px;font-weight:700;color:var(--warn)">${confPartial}</span> <span style="color:var(--txt2)">partial</span></div>
      <div><span style="font-size:22px;font-weight:700;color:var(--txt3)">${confNone}</span> <span style="color:var(--txt2)">none</span></div>
    </div>
  </div>
  <div class="card">
    <h2>Outcome distribution</h2>
    <p class="card-sub">Agent-reported outcomes (requires metricsProfile on workflow, ~53% coverage)</p>
    <div style="display:flex;gap:24px;flex-wrap:wrap;font-size:13px">
      ${Object.entries(summary.outcomeBreakdown).map(([outcome, count]) =>
    `<div><span class="badge b-${outcome}" style="font-size:12px;padding:3px 10px">${outcome}</span> <strong style="margin-left:6px">${count}</strong></div>`,
  ).join('')}
    </div>
  </div>
</div>

<!-- SESSIONS TAB -->
<div class="view" id="view-sessions">
  <div class="card">
    <h2>Workflow runs</h2>
    <p class="card-sub"><span id="sess-total"></span></p>
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
</div>

<footer>WorkRail session metrics &middot; <a href="https://github.com/EtienneBBeaulac/workrail" style="color:var(--txt3)">github.com/EtienneBBeaulac/workrail</a></footer>
</div>

<script>
const SESSIONS = ${safeJson(sessionsJs)};
const BREAKDOWN = ${safeJson(breakdown)};
const HEATMAP = ${safeJson(heatmap)};
const PAGE_SIZE = 30;

// Tab switching
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

// Callout
(function(){
  const counts = {};
  for (const s of SESSIONS) { if (s.completed) counts[s.workflow_label] = (counts[s.workflow_label]||0)+1; }
  const totalDays = Math.max(1, Object.keys(HEATMAP).length);
  const avgPerDay = Math.round(SESSIONS.length / totalDays);
  const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3);
  const parts = top.map(([l,n])=>'<strong>'+n+' '+l.toLowerCase()+(n===1?'':'s')+'</strong>');
  document.getElementById('callout').innerHTML = parts.length
    ? 'Over '+totalDays+' days, this agent completed '+parts.join(', ')+' and more -- running autonomously at an average of <strong>'+avgPerDay+' sessions per day</strong>.'
    : 'No completed sessions in this window.';
})();

// Breakdown table
(function(){
  const tbody = document.getElementById('breakdown-body');
  const max = Math.max(...BREAKDOWN.map(r=>r.completed),1);
  let totS=0,totC=0;
  for (const r of BREAKDOWN) {
    const pct=Math.round(r.completed/max*100), rate=Math.round(r.completed/r.started*100);
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+r.label+'</td><td><div style="display:flex;align-items:center;gap:8px"><div class="bar-outer" style="flex:1"><div class="bar-inner" style="width:'+pct+'%"></div></div><span style="font-size:13px;font-weight:600;color:#1d1d1f;width:32px;text-align:right">'+r.completed+'</span></div></td><td class="r" style="color:#aeaeb2;font-size:12px">'+rate+'%</td><td class="r">'+r.median+'</td><td class="r" style="color:#1a7a3a">+'+(r.linesAdded||0).toLocaleString()+'</td>';
    tbody.appendChild(tr); totS+=r.started; totC+=r.completed;
  }
  const tr=document.createElement('tr'); tr.className='total-row';
  tr.innerHTML='<td>Total</td><td><div style="display:flex;align-items:center;gap:8px"><div class="bar-outer" style="flex:1"><div class="bar-inner" style="width:100%"></div></div><span style="font-size:13px;font-weight:600;color:#1d1d1f;width:32px;text-align:right">'+totC+'</span></div></td><td class="r" style="color:#aeaeb2;font-size:12px">'+Math.round(totC/Math.max(totS,1)*100)+'%</td><td class="r">--</td><td class="r">--</td>';
  tbody.appendChild(tr);
})();

// Activity chart
(function(){
  const chart=document.getElementById('barchart'), axis=document.getElementById('barchart-axis'), yAxis=document.getElementById('y-axis');
  const entries=[];
  const keys=Object.keys(HEATMAP).sort();
  if(!keys.length) return;
  const start=new Date(keys[0]), end=new Date(keys[keys.length-1]);
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
    const k=d.toISOString().slice(0,10);
    entries.push({date:k,label:d.toLocaleDateString('en-US',{month:'short',day:'numeric'}),count:HEATMAP[k]||0});
  }
  const max=Math.max(...entries.map(e=>e.count),1);
  [max,Math.round(max*.5),0].forEach(v=>{const el=document.createElement('div');el.className='y-label';el.textContent=v;yAxis.appendChild(el);});
  entries.forEach(e=>{
    const isWe=new Date(e.date+'T12:00:00').getDay()===0||new Date(e.date+'T12:00:00').getDay()===6;
    const bar=document.createElement('div'); bar.className='bc-bar';
    bar.style.height=Math.max(2,Math.round(e.count/max*100))+'%';
    if(isWe) bar.style.background='rgba(0,122,255,0.4)';
    bar.setAttribute('data-tip',e.label+': '+e.count+' sessions');
    chart.appendChild(bar);
    const lbl=document.createElement('div'); lbl.className='bar-chart-label';
    if([1,7,14,21,28].includes(new Date(e.date+'T12:00:00').getDate())) lbl.textContent=e.label;
    axis.appendChild(lbl);
  });
})();

// Sessions
let sp=1, sf=SESSIONS.slice();
(function(){
  const sel=document.getElementById('sess-workflow');
  [...new Set(SESSIONS.map(s=>s.workflow_label))].sort().forEach(l=>{const o=document.createElement('option');o.value=l;o.textContent=l;sel.appendChild(o);});
  document.getElementById('sess-total').textContent=SESSIONS.length.toLocaleString()+' total sessions.';
})();
function fD(m){if(!m)return'--';return m<60?Math.round(m)+'m':(m/60).toFixed(1)+'h';}
function fT(n){if(!n)return'--';if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return Math.round(n/1e3)+'k';return n;}
function fC(c){if(!c)return'--';return c>=100?'$'+(c/100).toFixed(0):'$'+(c/100).toFixed(2);}
function applyF(){
  const wf=document.getElementById('sess-workflow').value;
  const st=document.getElementById('sess-status').value;
  const q=document.getElementById('sess-search').value.toLowerCase();
  sf=SESSIONS.filter(s=>
    (!wf||s.workflow_label===wf)&&
    (!st||(st==='done'?s.completed:!s.completed))&&
    (!q||s.goal.toLowerCase().includes(q)||s.project.toLowerCase().includes(q)||s.date.includes(q))
  );
  sp=1; renderS();
}
function renderS(){
  const list=document.getElementById('sess-list');
  const total=sf.length, start=(sp-1)*PAGE_SIZE, page=sf.slice(start,Math.min(start+PAGE_SIZE,total));
  const comp=sf.filter(s=>s.completed).length;
  const avgD=sf.filter(s=>s.duration_min).reduce((a,s)=>a+s.duration_min,0)/(sf.filter(s=>s.duration_min).length||1);
  const totalLines=sf.reduce((a,s)=>a+s.lines_added,0);
  document.getElementById('sess-stats').innerHTML=
    '<div><span class="stat-val">'+total+'</span> <span class="stat-lbl">sessions</span></div>'+
    '<div><span class="stat-val" style="color:#34c759">'+comp+'</span> <span class="stat-lbl">completed</span></div>'+
    '<div><span class="stat-val">'+Math.round(comp/Math.max(total,1)*100)+'%</span> <span class="stat-lbl">rate</span></div>'+
    '<div><span class="stat-val">'+fD(Math.round(avgD*10)/10)+'</span> <span class="stat-lbl">avg duration</span></div>'+
    '<div><span class="stat-val" style="color:#1a7a3a">+'+totalLines.toLocaleString()+'</span> <span class="stat-lbl">lines added</span></div>'+
    '<div style="margin-left:auto;font-size:11px;color:#aeaeb2">Showing '+(start+1)+'&#8211;'+Math.min(start+PAGE_SIZE,total)+'</div>';
  list.innerHTML='';
  for(const s of page){
    const div=document.createElement('div'); div.className='sess-item';
    const ob=s.outcome?'<span class="badge b-'+s.outcome+'">'+s.outcome+'</span>':'';
    const mp=[];
    if(s.lines_added) mp.push('<span style="color:#1a7a3a">+'+s.lines_added+' lines</span>');
    if(s.tokens) mp.push(fT(s.tok_in+s.tok_out)+' tokens');
    if(s.est_cost_cents) mp.push(fC(s.est_cost_cents));
    if(s.steps) mp.push(s.steps+' steps');
    if(s.retries) mp.push('<span style="color:#ff9500">'+s.retries+' retries</span>');
    if(s.commit_count) mp.push(s.commit_count+' commit'+(s.commit_count>1?'s':''));
    if(s.model) mp.push('<span style="color:#aeaeb2">'+s.model+'</span>');
    const meta=mp.length?'<div class="sess-meta">'+mp.join(' &middot; ')+'</div>':'';
    div.innerHTML=
      '<div class="sess-date">'+s.date+'</div>'+
      '<div><div class="sess-dot '+(s.completed?'dot-done':'dot-skip')+'"></div></div>'+
      '<div class="sess-wf" title="'+s.workflow_id+'">'+s.workflow_label+(s.project?'<br><span style="font-weight:400;color:#aeaeb2">'+s.project+'</span>':'')+'</div>'+
      '<div><div class="'+(s.goal?'sess-goal':'sess-no-goal')+'">'+(s.goal||'No goal recorded')+'</div>'+meta+'</div>'+
      '<div>'+ob+'</div>'+
      '<div class="sess-num">'+fD(s.duration_min)+'</div>';
    list.appendChild(div);
  }
  // Pagination
  const pag=document.getElementById('sess-pag'); pag.innerHTML='';
  const pages=Math.ceil(total/PAGE_SIZE); if(pages<=1)return;
  const prev=document.createElement('button'); prev.className='pg-btn'; prev.textContent='Prev'; prev.disabled=sp===1;
  prev.addEventListener('click',()=>{sp--;renderS();}); pag.appendChild(prev);
  for(let p=Math.max(1,sp-2);p<=Math.min(pages,sp+2);p++){
    const b=document.createElement('button'); b.className='pg-btn'+(p===sp?' active':''); b.textContent=p;
    b.addEventListener('click',()=>{sp=p;renderS();}); pag.appendChild(b);
  }
  const next=document.createElement('button'); next.className='pg-btn'; next.textContent='Next'; next.disabled=sp===pages;
  next.addEventListener('click',()=>{sp++;renderS();}); pag.appendChild(next);
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
