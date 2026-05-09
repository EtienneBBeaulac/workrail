/**
 * WorkTrain Diagnose Command
 *
 * Pure functions for diagnosing failed daemon sessions by reading the daemon event log.
 * All I/O is injected -- these functions are pure and fully testable without filesystem access.
 *
 * Design invariants:
 * - parseDaemonEvents() is a pure function: no direct I/O, readFile is injected
 * - DiagnosticResult is a discriminated union -- exhaustiveness enforced at compile time
 * - parseDaemonEvents() reads ALL daysBack files before classifying (cross-midnight safety)
 * - Prefix collision check happens BEFORE merging events -- ambiguous prefixes produce AMBIGUOUS
 * - Malformed JSONL lines are skipped silently (never throw)
 * - SUCCESS guard fires before any failure classification
 * - NOT_FOUND is distinct from ORPHANED
 */

import chalk from 'chalk';

// ---------------------------------------------------------------------------
// DiagnosticResult -- discriminated union
// ---------------------------------------------------------------------------

export interface DiagnosticNotFound {
  readonly kind: 'NOT_FOUND';
  readonly sessionIdQuery: string;
  readonly daysBack: number;
}

export interface DiagnosticAmbiguous {
  readonly kind: 'AMBIGUOUS';
  readonly sessionIdQuery: string;
  readonly candidates: readonly string[];
}

export interface DiagnosticSuccess {
  readonly kind: 'SUCCESS';
  readonly sessionId: string;
  readonly workflowId: string;
  readonly startedAt: number | null;
  readonly durationMs: number;
  readonly metrics: SessionMetrics;
}

export interface DiagnosticConfigError {
  readonly kind: 'CONFIG_ERROR';
  readonly sessionId: string;
  readonly workflowId: string;
  readonly startedAt: number | null;
  readonly durationMs: number;
  readonly detail: string;
  readonly detailTruncated: boolean;
  readonly metrics: SessionMetrics;
  readonly steps: readonly StepRecord[];
  readonly processState: ProcessState;
}

export interface DiagnosticWorkflowStuck {
  readonly kind: 'WORKFLOW_STUCK';
  readonly sessionId: string;
  readonly workflowId: string;
  readonly startedAt: number | null;
  readonly durationMs: number;
  readonly stuckReason: 'repeated_tool_call' | 'no_progress' | 'stall';
  readonly stuckDetail: string;
  readonly toolName?: string;
  readonly argsSummary?: string;
  readonly metrics: SessionMetrics;
  readonly steps: readonly StepRecord[];
  readonly processState: ProcessState;
}

export interface DiagnosticWorkflowTimeout {
  readonly kind: 'WORKFLOW_TIMEOUT';
  readonly sessionId: string;
  readonly workflowId: string;
  readonly startedAt: number | null;
  readonly durationMs: number;
  readonly timeoutReason: 'wall_clock' | 'max_turns' | 'unknown';
  readonly stepAdvances: number;
  readonly metrics: SessionMetrics;
  readonly steps: readonly StepRecord[];
  readonly processState: ProcessState;
}

export interface DiagnosticInfraError {
  readonly kind: 'INFRA_ERROR';
  readonly sessionId: string;
  readonly workflowId: string;
  readonly startedAt: number | null;
  readonly durationMs: number;
  readonly infraReason: 'daemon_shutdown' | 'daemon_killed' | 'aborted' | 'network' | 'unknown';
  readonly detail: string;
  readonly metrics: SessionMetrics;
  readonly steps: readonly StepRecord[];
  readonly processState: ProcessState;
}

export interface DiagnosticOrphaned {
  readonly kind: 'ORPHANED';
  readonly sessionId: string;
  readonly workflowId: string;
  readonly startedAt: number | null;
  readonly durationMs: number;
  readonly lastEventKind: string | null;
  readonly lastEventTs: number | null;
  readonly metrics: SessionMetrics;
  readonly steps: readonly StepRecord[];
}

export interface DiagnosticDefault {
  readonly kind: 'DEFAULT';
  readonly sessionId: string;
  readonly workflowId: string;
  readonly startedAt: number | null;
  readonly durationMs: number;
  readonly outcome: string;
  readonly detail: string;
  readonly rawEventLine: string;
  readonly metrics: SessionMetrics;
  readonly steps: readonly StepRecord[];
  readonly processState: ProcessState;
}

export type DiagnosticResult =
  | DiagnosticNotFound
  | DiagnosticAmbiguous
  | DiagnosticSuccess
  | DiagnosticConfigError
  | DiagnosticWorkflowStuck
  | DiagnosticWorkflowTimeout
  | DiagnosticInfraError
  | DiagnosticOrphaned
  | DiagnosticDefault;

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface SessionMetrics {
  readonly llmTurns: number;
  readonly stepAdvances: number;
  readonly toolCallsTotal: number;
  readonly toolCallsFailed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface StepRecord {
  /** 1-based step index */
  readonly index: number;
  readonly status: 'completed' | 'terminal' | 'not_reached';
  /** Turn count for this step (turns between previous step_advanced and this one) */
  readonly turns: number;
}

export type ProcessState = 'STOPPED' | 'RUNNING' | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Internal accumulated state during event scan
// ---------------------------------------------------------------------------

interface SessionAccumulator {
  readonly sessionId: string;
  workflowId: string;
  startedAt: number | null;
  lastTs: number | null;
  llmTurns: number;
  stepAdvances: number;
  toolCallsTotal: number;
  toolCallsFailed: number;
  inputTokens: number;
  outputTokens: number;
  stuckReason: 'repeated_tool_call' | 'no_progress' | 'stall' | null;
  stuckDetail: string | null;
  stuckToolName: string | null;
  stuckArgsSummary: string | null;
  completedEvent: { outcome: string; detail: string; rawLine: string } | null;
  abortedEvent: { reason: string } | null;
  lastEventKind: string | null;
  // Track LLM turns per step for step timeline
  turnsAtLastStep: number;
  stepTurnCounts: number[];
}

// ---------------------------------------------------------------------------
// parseDaemonEvents -- pure, injected I/O
// ---------------------------------------------------------------------------

/**
 * Read daemon event logs and return a diagnostic result for the given session.
 *
 * @param sessionIdQuery - Full session ID or prefix to search for
 * @param eventsDir - Absolute path to ~/.workrail/events/daemon/
 * @param daysBack - How many days back to scan (default 7)
 * @param readFile - Injected file reader: returns file contents or null if not found
 */
export function parseDaemonEvents(
  sessionIdQuery: string,
  eventsDir: string,
  daysBack: number,
  readFile: (path: string) => string | null,
): DiagnosticResult {
  // Build the list of file paths to scan, newest-first
  const filePaths = buildFilePaths(eventsDir, daysBack);

  // Collect ALL events across all files, grouped by full sessionId
  // WHY: collect across all files before classifying (cross-midnight safety, prefix collision detection)
  const sessionEvents = new Map<string, SessionAccumulator>();

  for (const filePath of filePaths) {
    const content = readFile(filePath);
    if (content === null) continue;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Malformed JSONL line -- skip silently
        continue;
      }

      const eventSessionId = extractSessionId(obj);
      if (!eventSessionId) continue;

      // Check if this event belongs to a session matching the query
      if (!matchesQuery(eventSessionId, sessionIdQuery)) continue;

      // Get or create accumulator for this full session ID
      let acc = sessionEvents.get(eventSessionId);
      if (!acc) {
        acc = createAccumulator(eventSessionId);
        sessionEvents.set(eventSessionId, acc);
      }

      accumulateEvent(acc, obj, trimmed);
    }
  }

  // Session not found
  if (sessionEvents.size === 0) {
    return { kind: 'NOT_FOUND', sessionIdQuery, daysBack };
  }

  // Prefix collision: multiple distinct sessions match
  if (sessionEvents.size > 1) {
    return {
      kind: 'AMBIGUOUS',
      sessionIdQuery,
      candidates: Array.from(sessionEvents.keys()).sort(),
    };
  }

  const acc = sessionEvents.values().next().value as SessionAccumulator;
  return classify(acc);
}

// ---------------------------------------------------------------------------
// Classification logic
// ---------------------------------------------------------------------------

function classify(acc: SessionAccumulator): DiagnosticResult {
  const metrics = buildMetrics(acc);
  const steps = buildSteps(acc);
  const durationMs = acc.startedAt !== null && acc.lastTs !== null
    ? acc.lastTs - acc.startedAt
    : 0;

  // SUCCESS guard -- must be first
  if (acc.completedEvent?.outcome === 'success') {
    return {
      kind: 'SUCCESS',
      sessionId: acc.sessionId,
      workflowId: acc.workflowId,
      startedAt: acc.startedAt,
      durationMs,
      metrics,
    };
  }

  // Determine process state
  const processState = determineProcessState(acc);

  // INFRA: daemon graceful stop or killed
  if (acc.abortedEvent !== null) {
    const infraReason = acc.abortedEvent.reason === 'daemon_shutdown' ? 'daemon_shutdown'
      : acc.abortedEvent.reason === 'daemon_killed' ? 'daemon_killed'
      : 'unknown';
    return {
      kind: 'INFRA_ERROR',
      sessionId: acc.sessionId,
      workflowId: acc.workflowId,
      startedAt: acc.startedAt,
      durationMs,
      infraReason,
      detail: `Session interrupted: ${acc.abortedEvent.reason}`,
      metrics,
      steps,
      processState,
    };
  }

  // ORPHANED: events exist but no terminal event
  if (acc.completedEvent === null) {
    return {
      kind: 'ORPHANED',
      sessionId: acc.sessionId,
      workflowId: acc.workflowId,
      startedAt: acc.startedAt,
      durationMs,
      lastEventKind: acc.lastEventKind,
      lastEventTs: acc.lastTs,
      metrics,
      steps,
    };
  }

  const { outcome, detail, rawLine } = acc.completedEvent;
  const detailTruncated = detail.length >= 198; // detail field is capped at 200 chars by emitter

  // WORKFLOW: stuck
  // WHY fallback to 'no_progress' when outcome=stuck but no agent_stuck event: log ordering
  // races (agent_stuck emitted after session_completed in the same flush) can lose the event.
  if (outcome === 'stuck') {
    return {
      kind: 'WORKFLOW_STUCK',
      sessionId: acc.sessionId,
      workflowId: acc.workflowId,
      startedAt: acc.startedAt,
      durationMs,
      stuckReason: acc.stuckReason ?? 'no_progress',
      stuckDetail: acc.stuckDetail ?? detail,
      toolName: acc.stuckToolName ?? undefined,
      argsSummary: acc.stuckArgsSummary ?? undefined,
      metrics,
      steps,
      processState,
    };
  }

  // WORKFLOW: timeout
  if (outcome === 'timeout') {
    const timeoutReason = detail.includes('wall_clock') ? 'wall_clock'
      : detail.includes('max_turns') ? 'max_turns'
      : 'unknown';
    return {
      kind: 'WORKFLOW_TIMEOUT',
      sessionId: acc.sessionId,
      workflowId: acc.workflowId,
      startedAt: acc.startedAt,
      durationMs,
      timeoutReason,
      stepAdvances: acc.stepAdvances,
      metrics,
      steps,
      processState,
    };
  }

  // CONFIG: bad model ID or API key error
  // WHY not bare /400/: "400" matches unrelated strings like "Timeout after 400 attempts".
  // Require model/key/auth context alongside the status code to avoid mis-classification.
  if (outcome === 'error' && (/model identifier|invalid model|api.*key|authentication/i.test(detail) || /\b400\b.*model|\bmodel\b.*\b400\b/i.test(detail))) {
    return {
      kind: 'CONFIG_ERROR',
      sessionId: acc.sessionId,
      workflowId: acc.workflowId,
      startedAt: acc.startedAt,
      durationMs,
      detail,
      detailTruncated,
      metrics,
      steps,
      processState,
    };
  }

  // INFRA: aborted or network error (caught via detail field, not session_aborted event)
  if (outcome === 'error' && /aborted|SIGKILL|SIGTERM|network|ECONNRESET|ENOTFOUND/i.test(detail)) {
    return {
      kind: 'INFRA_ERROR',
      sessionId: acc.sessionId,
      workflowId: acc.workflowId,
      startedAt: acc.startedAt,
      durationMs,
      infraReason: /aborted/i.test(detail) ? 'aborted' : 'network',
      detail,
      metrics,
      steps,
      processState,
    };
  }

  // DEFAULT: unrecognized failure
  return {
    kind: 'DEFAULT',
    sessionId: acc.sessionId,
    workflowId: acc.workflowId,
    startedAt: acc.startedAt,
    durationMs,
    outcome,
    detail,
    rawEventLine: rawLine,
    metrics,
    steps,
    processState,
  };
}

// ---------------------------------------------------------------------------
// Event accumulation
// ---------------------------------------------------------------------------

function accumulateEvent(acc: SessionAccumulator, obj: Record<string, unknown>, rawLine: string): void {
  const kind = typeof obj['kind'] === 'string' ? obj['kind'] : null;
  const ts = typeof obj['ts'] === 'number' ? obj['ts'] : null;

  if (ts !== null) {
    if (acc.startedAt === null || ts < acc.startedAt) {
      acc.startedAt = ts;
    }
    if (acc.lastTs === null || ts > acc.lastTs) {
      acc.lastTs = ts;
    }
  }
  if (kind !== null) acc.lastEventKind = kind;

  if (!kind) return;

  switch (kind) {
    case 'session_started': {
      if (typeof obj['workflowId'] === 'string') acc.workflowId = obj['workflowId'];
      break;
    }
    case 'session_completed': {
      const outcome = typeof obj['outcome'] === 'string' ? obj['outcome'] : 'unknown';
      const detail = typeof obj['detail'] === 'string' ? obj['detail'] : '';
      acc.completedEvent = { outcome, detail, rawLine };
      break;
    }
    case 'session_aborted': {
      const reason = typeof obj['reason'] === 'string' ? obj['reason'] : 'unknown';
      acc.abortedEvent = { reason };
      break;
    }
    case 'agent_stuck': {
      const reason = typeof obj['reason'] === 'string' ? obj['reason'] : null;
      if (reason === 'repeated_tool_call' || reason === 'no_progress' || reason === 'stall') {
        acc.stuckReason = reason;
      }
      acc.stuckDetail = typeof obj['detail'] === 'string' ? obj['detail'] : null;
      acc.stuckToolName = typeof obj['toolName'] === 'string' ? obj['toolName'] : null;
      acc.stuckArgsSummary = typeof obj['argsSummary'] === 'string' ? obj['argsSummary'] : null;
      break;
    }
    case 'llm_turn_completed': {
      acc.llmTurns++;
      const inputTokens = typeof obj['inputTokens'] === 'number' ? obj['inputTokens'] : 0;
      const outputTokens = typeof obj['outputTokens'] === 'number' ? obj['outputTokens'] : 0;
      acc.inputTokens += inputTokens;
      acc.outputTokens += outputTokens;
      break;
    }
    case 'step_advanced': {
      // Record turns used for this step (turns since last step or session start)
      const turnsForStep = acc.llmTurns - acc.turnsAtLastStep;
      acc.stepTurnCounts.push(turnsForStep);
      acc.turnsAtLastStep = acc.llmTurns;
      acc.stepAdvances++;
      break;
    }
    case 'tool_call_started': {
      acc.toolCallsTotal++;
      break;
    }
    case 'tool_call_failed': {
      acc.toolCallsFailed++;
      break;
    }
    case 'tool_called': {
      // Legacy coarse event -- only count if tool_call_started is absent (old sessions)
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFilePaths(eventsDir: string, daysBack: number): string[] {
  const paths: string[] = [];
  const now = new Date();
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    paths.push(`${eventsDir}/${dateStr}.jsonl`);
  }
  return paths;
}

function extractSessionId(obj: Record<string, unknown>): string | null {
  // Events use either sessionId or workrailSessionId; prefer sessionId for process-local UUID
  const sid = typeof obj['sessionId'] === 'string' ? obj['sessionId'] : null;
  const wrid = typeof obj['workrailSessionId'] === 'string' ? obj['workrailSessionId'] : null;
  return sid ?? wrid;
}

function matchesQuery(sessionId: string, query: string): boolean {
  return sessionId === query || sessionId.startsWith(query);
}

function createAccumulator(sessionId: string): SessionAccumulator {
  return {
    sessionId,
    workflowId: 'unknown',
    startedAt: null,
    lastTs: null,
    llmTurns: 0,
    stepAdvances: 0,
    toolCallsTotal: 0,
    toolCallsFailed: 0,
    inputTokens: 0,
    outputTokens: 0,
    stuckReason: null,
    stuckDetail: null,
    stuckToolName: null,
    stuckArgsSummary: null,
    completedEvent: null,
    abortedEvent: null,
    lastEventKind: null,
    turnsAtLastStep: 0,
    stepTurnCounts: [],
  };
}

function buildMetrics(acc: SessionAccumulator): SessionMetrics {
  return {
    llmTurns: acc.llmTurns,
    stepAdvances: acc.stepAdvances,
    toolCallsTotal: acc.toolCallsTotal,
    toolCallsFailed: acc.toolCallsFailed,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
  };
}

function buildSteps(acc: SessionAccumulator): StepRecord[] {
  const steps: StepRecord[] = [];
  for (let i = 0; i < acc.stepTurnCounts.length; i++) {
    steps.push({ index: i + 1, status: 'completed', turns: acc.stepTurnCounts[i] ?? 0 });
  }
  // Add terminal step (the one that failed/timed out)
  if (acc.stepAdvances > 0 || acc.llmTurns > 0) {
    const turnsOnTerminalStep = acc.llmTurns - acc.turnsAtLastStep;
    steps.push({
      index: steps.length + 1,
      status: acc.completedEvent?.outcome === 'success' ? 'completed' : 'terminal',
      turns: turnsOnTerminalStep,
    });
  }
  return steps;
}

function determineProcessState(acc: SessionAccumulator): ProcessState {
  if (acc.completedEvent !== null || acc.abortedEvent !== null) return 'STOPPED';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// formatDiagnosticCard -- pure renderer
// ---------------------------------------------------------------------------

export interface FormatOptions {
  readonly ascii?: boolean;
  readonly noColor?: boolean;
}

const GLYPHS = {
  done: '✓',
  terminal: '→',
  pending: '·',
};
const ASCII_GLYPHS = {
  done: '[ok]',
  terminal: '[->]',
  pending: '[ ]',
};
const ZONE3_CAP = 8;

function getGlyph(key: keyof typeof GLYPHS, opts: FormatOptions): string {
  return opts.ascii ? ASCII_GLYPHS[key] : GLYPHS[key];
}

function applyChalk(text: string, fn: (t: string) => string, opts: FormatOptions): string {
  return opts.noColor ? text : fn(text);
}

/**
 * Format a DiagnosticResult as a human-readable failure card for terminal output.
 * Pure function -- no I/O.
 */
export function formatDiagnosticCard(result: DiagnosticResult, opts: FormatOptions = {}): string {
  switch (result.kind) {
    case 'NOT_FOUND':
      return formatNotFound(result, opts);
    case 'AMBIGUOUS':
      return formatAmbiguous(result, opts);
    case 'SUCCESS':
      return formatSuccess(result, opts);
    case 'CONFIG_ERROR':
      return formatConfigError(result, opts);
    case 'WORKFLOW_STUCK':
      return formatWorkflowStuck(result, opts);
    case 'WORKFLOW_TIMEOUT':
      return formatWorkflowTimeout(result, opts);
    case 'INFRA_ERROR':
      return formatInfraError(result, opts);
    case 'ORPHANED':
      return formatOrphaned(result, opts);
    case 'DEFAULT':
      return formatDefault(result, opts);
    default: {
      const _exhaustive: never = result;
      return `Unknown diagnostic kind: ${JSON.stringify(_exhaustive)}`;
    }
  }
}

function formatHeader(
  categoryBadge: string,
  sessionId: string,
  workflowId: string,
  startedAt: number | null,
  durationMs: number,
  processState: ProcessState | null,
): string {
  const startedStr = startedAt !== null
    ? `Started: ${formatStartedAt(startedAt)}`
    : '';
  const durationStr = formatDuration(durationMs);
  const stateStr = processState !== null ? `  [${processState}]` : '';
  const parts = [categoryBadge, sessionId, workflowId, startedStr, durationStr].filter(Boolean);
  return parts.join('  ') + stateStr;
}

function formatStartedAt(ts: number): string {
  const d = new Date(ts);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = days[d.getDay()] ?? '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${totalSec}s`;
}

function formatMetricsLine(m: SessionMetrics): string {
  const failRate = m.toolCallsTotal > 0
    ? ` (${m.toolCallsFailed} failed, ${Math.round((m.toolCallsFailed / m.toolCallsTotal) * 100)}%)`
    : '';
  const tokensIn = m.inputTokens > 0 ? `${Math.round(m.inputTokens / 1000)}k in` : null;
  const tokensOut = m.outputTokens > 0 ? `${Math.round(m.outputTokens / 1000)}k out` : null;
  const tokensStr = [tokensIn, tokensOut].filter(Boolean).join(' / ');
  const parts = [
    `Turns: ${m.llmTurns}`,
    `Steps: ${m.stepAdvances}`,
    `Tool calls: ${m.toolCallsTotal}${failRate}`,
    tokensStr ? `Tokens: ${tokensStr}` : null,
  ].filter(Boolean);
  return parts.join('  |  ');
}

function formatStepTimeline(steps: readonly StepRecord[], opts: FormatOptions): string {
  if (steps.length === 0) {
    return 'Step timeline:\n  (session terminated before first step)';
  }

  let displaySteps = steps as StepRecord[];
  let ellipsisLine: string | null = null;

  if (steps.length > ZONE3_CAP) {
    // Show first 2, ellipsis, last 3
    const firstTwo = steps.slice(0, 2);
    const lastThree = steps.slice(-3);
    const omitted = steps.length - 5;
    ellipsisLine = `  ... (${omitted} steps omitted, use --verbose to see all) ...`;
    displaySteps = [...firstTwo, ...lastThree];
  }

  const lines = ['Step timeline:'];
  let ellipsisInserted = false;

  for (const step of displaySteps) {
    if (ellipsisLine && !ellipsisInserted && step === steps[steps.length - 3] && steps.length > ZONE3_CAP) {
      lines.push(ellipsisLine);
      ellipsisInserted = true;
    }
    const glyph = step.status === 'completed' ? getGlyph('done', opts)
      : step.status === 'terminal' ? getGlyph('terminal', opts)
      : getGlyph('pending', opts);

    const turnsStr = step.turns > 0 ? `${step.turns} turns` : '';
    const statusLabel = step.status === 'terminal' ? '  [STOPPED]' : '';
    // WHY no chalk.red on terminal step: Zone 3 → must not use red, which is reserved
    // for Zone 2 STUCK/error category label (Von Restorff: two red elements cancel each other).
    // Terminal step is plain text; the [STOPPED] label carries the semantic weight.
    const stepLine = step.status === 'terminal'
      ? `  ${applyChalk(glyph, chalk.bold, opts)}  step ${step.index}${turnsStr ? `  ${turnsStr}` : ''}${statusLabel}`
      : `  ${glyph}  step ${step.index}${turnsStr ? `  ${turnsStr}` : ''}`;

    lines.push(stepLine);
  }

  if (ellipsisLine && !ellipsisInserted) {
    // Edge case: less than 5 total steps but still over cap (shouldn't happen)
    lines.push(ellipsisLine);
  }

  return lines.join('\n');
}

// --- Individual card formatters ---

function formatNotFound(result: DiagnosticNotFound, _opts: FormatOptions): string {
  return [
    `Session not found in the last ${result.daysBack} days.`,
    `Query: "${result.sessionIdQuery}"`,
    ``,
    `Verify the session ID, or check execution-stats.jsonl for older sessions:`,
    `  cat ~/.workrail/data/execution-stats.jsonl | grep "${result.sessionIdQuery.slice(0, 8)}"`,
  ].join('\n');
}

function formatAmbiguous(result: DiagnosticAmbiguous, _opts: FormatOptions): string {
  return [
    `Multiple sessions match "${result.sessionIdQuery}". Be more specific:`,
    ...result.candidates.map(c => `  ${c}`),
  ].join('\n');
}

function formatSuccess(result: DiagnosticSuccess, opts: FormatOptions): string {
  const badge = applyChalk('[SUCCESS]', chalk.green, opts);
  const header = formatHeader(badge, result.sessionId, result.workflowId, result.startedAt, result.durationMs, null);
  return [
    header,
    ``,
    `DIAGNOSIS: SUCCESS -- session completed normally`,
    ``,
    `  No failure detected.`,
    `  Run: worktrain logs --session ${result.sessionId} to see session activity.`,
    ``,
    formatMetricsLine(result.metrics),
  ].join('\n');
}

function formatConfigError(result: DiagnosticConfigError, opts: FormatOptions): string {
  const badge = applyChalk('[CONFIG]', chalk.red, opts);
  const header = formatHeader(badge, result.sessionId, result.workflowId, result.startedAt, result.durationMs, result.processState);
  const truncNote = result.detailTruncated ? `\n  (truncated at 200 chars -- see conversation log for full text)` : '';
  return [
    header,
    ``,
    applyChalk(`DIAGNOSIS: CONFIG -- invalid model or API configuration`, chalk.red, opts),
    ``,
    `  Error: "${result.detail}"${truncNote}`,
    `  Fix:   Check agentConfig.model in triggers.yml.`,
    `         Use format: provider/model-id`,
    `         e.g. amazon-bedrock/us.anthropic.claude-sonnet-4-6`,
    ``,
    formatMetricsLine(result.metrics),
    ``,
    formatStepTimeline(result.steps, opts),
  ].join('\n');
}

function formatWorkflowStuck(result: DiagnosticWorkflowStuck, opts: FormatOptions): string {
  const badge = applyChalk('[STUCK]', chalk.red, opts);
  const header = formatHeader(badge, result.sessionId, result.workflowId, result.startedAt, result.durationMs, result.processState);

  const reasonLabel = result.stuckReason === 'repeated_tool_call' ? 'repeated tool call'
    : result.stuckReason === 'no_progress' ? 'no step progress'
    : 'stalled tool call';

  const toolLine = result.toolName ? `  Tool:   ${result.toolName}` : null;
  const argsLine = result.argsSummary ? `  Args:   "${result.argsSummary}"` : null;

  let fixLine: string;
  if (result.stuckReason === 'repeated_tool_call') {
    fixLine = result.toolName
      ? `  Fix:   ${result.toolName} called with identical args repeatedly. Review step prompt to clarify the observation loop.`
      : `  Fix:   Agent called the same tool with identical args repeatedly. Review step prompt.`;
  } else if (result.stuckReason === 'no_progress') {
    fixLine = `  Fix:   Agent used ${result.metrics.llmTurns} turns with 0 step advances. Step 1 prompt may be unclear or impossible with available tools.`;
  } else {
    fixLine = `  Fix:   A tool call hung and never completed. Check network connectivity or file lock issues.`;
  }

  return [
    header,
    ``,
    applyChalk(`DIAGNOSIS: STUCK -- ${reasonLabel}`, chalk.red, opts),
    ``,
    toolLine,
    argsLine,
    fixLine,
    ``,
    formatMetricsLine(result.metrics),
    ``,
    formatStepTimeline(result.steps, opts),
  ].filter(line => line !== null).join('\n');
}

function formatWorkflowTimeout(result: DiagnosticWorkflowTimeout, opts: FormatOptions): string {
  const badge = applyChalk('[TIMEOUT]', chalk.yellow, opts);
  const header = formatHeader(badge, result.sessionId, result.workflowId, result.startedAt, result.durationMs, result.processState);

  const reasonLabel = result.timeoutReason === 'wall_clock' ? 'wall clock limit reached'
    : result.timeoutReason === 'max_turns' ? 'turn limit reached'
    : 'limit reached';

  let fixLine: string;
  if (result.timeoutReason === 'wall_clock') {
    fixLine = result.stepAdvances === 0
      ? `  Fix:   Agent never advanced a step before timeout. The workflow prompt may be unclear.`
      : `  Fix:   Increase maxSessionMinutes in triggers.yml agentConfig, or narrow the workflow scope.`;
  } else if (result.timeoutReason === 'max_turns') {
    fixLine = `  Fix:   Increase maxTurns in triggers.yml agentConfig, or simplify the workflow.`;
  } else {
    fixLine = `  Fix:   Increase maxSessionMinutes or maxTurns in triggers.yml agentConfig.`;
  }

  return [
    header,
    ``,
    applyChalk(`DIAGNOSIS: TIMEOUT -- ${reasonLabel}`, chalk.yellow, opts),
    ``,
    `  Steps completed: ${result.stepAdvances}`,
    fixLine,
    ``,
    formatMetricsLine(result.metrics),
    ``,
    formatStepTimeline(result.steps, opts),
  ].join('\n');
}

function formatInfraError(result: DiagnosticInfraError, opts: FormatOptions): string {
  const badge = applyChalk('[INFRA]', chalk.yellow, opts);
  const header = formatHeader(badge, result.sessionId, result.workflowId, result.startedAt, result.durationMs, result.processState);

  const reasonLabel = result.infraReason === 'daemon_shutdown' ? 'daemon stopped mid-session'
    : result.infraReason === 'daemon_killed' ? 'daemon killed mid-session'
    : result.infraReason === 'network' ? 'network error'
    : result.infraReason === 'aborted' ? 'session aborted'
    : 'infrastructure error';

  const fixLine = (result.infraReason === 'daemon_shutdown' || result.infraReason === 'daemon_killed')
    ? `  Fix:   Restart the daemon: worktrain daemon start\n         Re-queue the trigger or re-run the session manually.`
    : `  Fix:   Check daemon logs: worktrain logs --session ${result.sessionId}`;

  return [
    header,
    ``,
    applyChalk(`DIAGNOSIS: INFRA -- ${reasonLabel}`, chalk.yellow, opts),
    ``,
    `  Detail: ${result.detail}`,
    fixLine,
    ``,
    formatMetricsLine(result.metrics),
    ``,
    formatStepTimeline(result.steps, opts),
  ].join('\n');
}

function formatOrphaned(result: DiagnosticOrphaned, opts: FormatOptions): string {
  const badge = applyChalk('[ORPHANED]', chalk.gray ?? chalk.dim, opts);
  const header = formatHeader(badge, result.sessionId, result.workflowId, result.startedAt, result.durationMs, null);

  const lastEventStr = result.lastEventKind && result.lastEventTs !== null
    ? `  Last event: ${result.lastEventKind} (${formatRelativeTime(result.lastEventTs)} ago)`
    : `  Last event: unknown`;

  return [
    header,
    ``,
    applyChalk(`DIAGNOSIS: ORPHANED -- session ended without a completion event`, chalk.dim, opts),
    ``,
    lastEventStr,
    `  Note: The daemon may have crashed or been killed mid-session.`,
    `  Fix:   Check daemon process: worktrain daemon --status`,
    `         If stopped, restart: worktrain daemon start`,
    ``,
    formatMetricsLine(result.metrics),
    ``,
    formatStepTimeline(result.steps, opts),
  ].join('\n');
}

function formatDefault(result: DiagnosticDefault, opts: FormatOptions): string {
  const badge = `[${result.outcome.toUpperCase()}]`;
  const header = formatHeader(badge, result.sessionId, result.workflowId, result.startedAt, result.durationMs, result.processState);

  return [
    header,
    ``,
    `DIAGNOSIS: UNKNOWN -- unrecognized failure type`,
    ``,
    `  Outcome: ${result.outcome}`,
    result.detail ? `  Detail:  ${result.detail}` : null,
    `  Raw:     ${result.rawEventLine.slice(0, 200)}`,
    ``,
    `  No automated fix suggestion available for this failure type.`,
    `  File an issue: https://github.com/EtienneBBeaulac/workrail/issues`,
    ``,
    formatMetricsLine(result.metrics),
    ``,
    formatStepTimeline(result.steps, opts),
  ].filter(line => line !== null).join('\n');
}

function formatRelativeTime(ts: number): string {
  const elapsed = Date.now() - ts;
  const min = Math.floor(elapsed / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60);
  return `${h} hours`;
}

// ---------------------------------------------------------------------------
// formatDiagnosticJson -- pure JSON serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a DiagnosticResult to a machine-readable JSON object.
 * No additional truncation is applied -- all fields from the parsed events are included as-is.
 * Note: the daemon event log truncates detail/argsSummary at 200 chars at write time;
 * this function cannot recover the original text.
 */
export function formatDiagnosticJson(result: DiagnosticResult): string {
  return JSON.stringify(result, null, 2);
}
