/**
 * WorkTrain session-log command.
 *
 * Reads the daemon event log and renders a time-annotated turn-by-turn replay
 * of any session (live or completed) in the last N days.
 *
 * Design invariants:
 * - parseSessionLog() is a pure function: no direct I/O, readFile is injected
 * - SessionLogResult is a discriminated union -- exhaustiveness enforced at compile time
 * - tool_called events are skipped; only tool_call_started/completed/failed produce lines
 * - argsSummary is tracked via a FIFO queue per toolName (tools run sequentially)
 * - Orphaned tool_call_started (daemon crash mid-tool) emits a tool line with durationMs null
 * - Events are sorted by ts after merging across daily files (cross-midnight safety)
 */

import chalk from 'chalk';

// ---------------------------------------------------------------------------
// SessionLogLine -- discriminated union of renderable log line types
// ---------------------------------------------------------------------------

export type SessionLogLine =
  | {
      readonly kind: 'llm_turn';
      readonly ts: number;
      readonly messageCount: number;
      readonly modelId?: string;
    }
  | {
      readonly kind: 'tool';
      readonly ts: number;
      readonly toolName: string;
      /** First 200 chars of the tool call params (from tool_call_started argsSummary). */
      readonly argsSummary: string;
      /** Wall-clock duration in ms. null when daemon crashed mid-tool. */
      readonly durationMs: number | null;
      readonly isError: boolean;
      /** First 200 chars of the result or error message. */
      readonly summary: string;
    }
  | {
      readonly kind: 'step_advance';
      readonly ts: number;
      readonly stepId?: string;
    }
  | {
      readonly kind: 'agent_stuck';
      readonly ts: number;
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly kind: 'session_end';
      readonly ts: number;
      readonly outcome: string;
      readonly detail?: string;
    };

// ---------------------------------------------------------------------------
// SessionLogResult -- discriminated union of parse outcomes
// ---------------------------------------------------------------------------

export type SessionLogResult =
  | {
      readonly kind: 'found';
      readonly sessionId: string;
      readonly workflowId: string;
      readonly startedAt: number;
      readonly lines: readonly SessionLogLine[];
    }
  | {
      readonly kind: 'not_found';
      readonly sessionIdQuery: string;
      readonly daysBack: number;
    }
  | {
      readonly kind: 'ambiguous';
      readonly sessionIdQuery: string;
      readonly candidates: readonly string[];
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build file paths for the last `daysBack` days. Newest first. */
function buildFilePaths(eventsDir: string, daysBack: number): string[] {
  const paths: string[] = [];
  const now = Date.now();
  for (let i = 0; i < daysBack; i++) {
    const date = new Date(now - i * 86400000).toISOString().slice(0, 10);
    paths.push(`${eventsDir}/${date}.jsonl`);
  }
  return paths;
}

/** Returns true if the event's sessionId starts with the query (case-sensitive prefix match). */
function matchesQuery(eventSessionId: string, query: string): boolean {
  return eventSessionId.startsWith(query);
}

// ---------------------------------------------------------------------------
// parseSessionLog -- pure, injected I/O
// ---------------------------------------------------------------------------

/**
 * Parse daemon event log files and produce a turn-by-turn SessionLogResult.
 *
 * @param sessionIdQuery - Full session ID or prefix to search for
 * @param eventsDir - Absolute path to ~/.workrail/events/daemon/
 * @param daysBack - How many days back to scan (default 7)
 * @param readFile - Injected file reader: returns file contents or null if not found
 */
export function parseSessionLog(
  sessionIdQuery: string,
  eventsDir: string,
  daysBack: number,
  readFile: (path: string) => string | null,
): SessionLogResult {
  const filePaths = buildFilePaths(eventsDir, daysBack);

  // Collect raw events for matching session IDs
  const eventsBySession = new Map<string, Array<Record<string, unknown>>>();

  for (const filePath of filePaths) {
    const content = readFile(filePath);
    if (!content) continue;

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // malformed JSONL -- skip silently
      }

      const eventSessionId = typeof event['sessionId'] === 'string' ? event['sessionId'] : null;
      if (!eventSessionId) continue;
      if (!matchesQuery(eventSessionId, sessionIdQuery)) continue;

      let bucket = eventsBySession.get(eventSessionId);
      if (!bucket) {
        bucket = [];
        eventsBySession.set(eventSessionId, bucket);
      }
      bucket.push(event);
    }
  }

  // No matching sessions
  if (eventsBySession.size === 0) {
    return { kind: 'not_found', sessionIdQuery, daysBack };
  }

  // Ambiguous prefix
  if (eventsBySession.size > 1) {
    return {
      kind: 'ambiguous',
      sessionIdQuery,
      candidates: [...eventsBySession.keys()],
    };
  }

  const [sessionId, rawEvents] = [...eventsBySession.entries()][0]!;

  // Sort all events by ts
  rawEvents.sort((a, b) => {
    const ta = typeof a['ts'] === 'number' ? a['ts'] : 0;
    const tb = typeof b['ts'] === 'number' ? b['ts'] : 0;
    return ta - tb;
  });

  // Extract session metadata
  let workflowId = 'unknown';
  let startedAt = 0;

  for (const event of rawEvents) {
    if (event['kind'] === 'session_started') {
      if (typeof event['workflowId'] === 'string') workflowId = event['workflowId'];
      if (typeof event['ts'] === 'number') startedAt = event['ts'];
      break;
    }
  }

  // Fold events into SessionLogLine[]
  // Pending argsSummary per toolName: FIFO queue because tools run sequentially.
  // WHY Map<string, string[]>: same tool can be called multiple times in one turn.
  // Sequential execution guarantees tool_call_started fires before tool_call_completed
  // for the same tool, so FIFO pop gives the correct argsSummary.
  const pendingArgs = new Map<string, string[]>();

  const lines: SessionLogLine[] = [];

  for (const event of rawEvents) {
    const kind = event['kind'];
    const ts = typeof event['ts'] === 'number' ? event['ts'] : 0;

    // Skip coarse tool_called events -- tool_call_started/completed/failed are used instead.
    // WHY: both fire for every tool call. Using tool_called would double-render every tool.
    if (kind === 'tool_called') continue;

    if (kind === 'llm_turn_started') {
      lines.push({
        kind: 'llm_turn',
        ts,
        messageCount: typeof event['messageCount'] === 'number' ? event['messageCount'] : 0,
        ...(typeof event['modelId'] === 'string' ? { modelId: event['modelId'] } : {}),
      });
      continue;
    }

    if (kind === 'tool_call_started') {
      const toolName = typeof event['toolName'] === 'string' ? event['toolName'] : 'unknown';
      const argsSummary = typeof event['argsSummary'] === 'string' ? event['argsSummary'] : '';
      const queue = pendingArgs.get(toolName) ?? [];
      queue.push(argsSummary);
      pendingArgs.set(toolName, queue);
      continue;
    }

    if (kind === 'tool_call_completed') {
      const toolName = typeof event['toolName'] === 'string' ? event['toolName'] : 'unknown';
      const durationMs = typeof event['durationMs'] === 'number' ? event['durationMs'] : null;
      const resultSummary = typeof event['resultSummary'] === 'string' ? event['resultSummary'] : '';
      const queue = pendingArgs.get(toolName);
      const argsSummary = queue?.shift() ?? '';
      if (queue && queue.length === 0) pendingArgs.delete(toolName);
      lines.push({ kind: 'tool', ts, toolName, argsSummary, durationMs, isError: false, summary: resultSummary });
      continue;
    }

    if (kind === 'tool_call_failed') {
      const toolName = typeof event['toolName'] === 'string' ? event['toolName'] : 'unknown';
      const durationMs = typeof event['durationMs'] === 'number' ? event['durationMs'] : null;
      const errorMessage = typeof event['errorMessage'] === 'string' ? event['errorMessage'] : '';
      const queue = pendingArgs.get(toolName);
      const argsSummary = queue?.shift() ?? '';
      if (queue && queue.length === 0) pendingArgs.delete(toolName);
      lines.push({ kind: 'tool', ts, toolName, argsSummary, durationMs, isError: true, summary: errorMessage });
      continue;
    }

    if (kind === 'step_advanced') {
      lines.push({
        kind: 'step_advance',
        ts,
        ...(typeof event['stepId'] === 'string' ? { stepId: event['stepId'] } : {}),
      });
      continue;
    }

    if (kind === 'agent_stuck') {
      lines.push({
        kind: 'agent_stuck',
        ts,
        reason: typeof event['reason'] === 'string' ? event['reason'] : 'unknown',
        ...(typeof event['detail'] === 'string' ? { detail: event['detail'] } : {}),
      });
      continue;
    }

    if (kind === 'session_completed' || kind === 'session_aborted') {
      const outcome = kind === 'session_aborted'
        ? 'aborted'
        : (typeof event['outcome'] === 'string' ? event['outcome'] : 'unknown');
      lines.push({
        kind: 'session_end',
        ts,
        outcome,
        ...(typeof event['detail'] === 'string' ? { detail: event['detail'] } : {}),
      });
      continue;
    }
  }

  // Flush any orphaned tool_call_started (daemon crashed mid-tool)
  for (const [toolName, queue] of pendingArgs.entries()) {
    for (const argsSummary of queue) {
      lines.push({
        kind: 'tool',
        ts: lines.length > 0 ? (lines[lines.length - 1]!.ts + 1) : startedAt,
        toolName,
        argsSummary,
        durationMs: null,
        isError: false,
        summary: '',
      });
    }
  }

  return { kind: 'found', sessionId, workflowId, startedAt, lines };
}

// ---------------------------------------------------------------------------
// formatSessionLog -- pure renderer
// ---------------------------------------------------------------------------

const SLOW_THRESHOLD_MS = 10_000;

function fmtTs(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19); // HH:MM:SS
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format a SessionLogResult as a human-readable string.
 * Pure: no I/O, chalk for color.
 */
export function formatSessionLog(result: SessionLogResult): string {
  if (result.kind === 'not_found') {
    return chalk.red(`Session not found: ${result.sessionIdQuery}`) +
      `\nSearched the last ${result.daysBack} days of daemon event logs.`;
  }

  if (result.kind === 'ambiguous') {
    return chalk.yellow(`Ambiguous session ID prefix: ${result.sessionIdQuery}`) +
      '\nMatching sessions:\n' +
      result.candidates.map((c) => `  ${c}`).join('\n');
  }

  const header = [
    chalk.bold(`Session: ${result.sessionId}`),
    `Workflow: ${result.workflowId}`,
    `Started:  ${new Date(result.startedAt).toISOString()}`,
    '',
  ].join('\n');

  let turnIndex = 0;
  const renderedLines: string[] = [];

  for (const line of result.lines) {
    const ts = chalk.dim(`[${fmtTs(line.ts)}]`);

    if (line.kind === 'llm_turn') {
      turnIndex++;
      const model = line.modelId ? chalk.dim(` (${line.modelId})`) : '';
      renderedLines.push(`${ts} ${chalk.cyan(`Turn ${turnIndex}`)}  ${line.messageCount} msgs${model}`);
      continue;
    }

    if (line.kind === 'tool') {
      const arrow = chalk.dim('→');
      const name = chalk.yellow(line.toolName.padEnd(12));
      const args = chalk.dim(line.argsSummary.slice(0, 60));
      const startLine = `${ts} ${arrow} ${name} ${args}`;

      let endLine: string;
      if (line.durationMs === null) {
        endLine = `${ts} ${chalk.red('←')} ${name} ${chalk.red('[crashed mid-call]')}`;
      } else {
        const dur = fmtDuration(line.durationMs);
        const durStr = line.durationMs > SLOW_THRESHOLD_MS
          ? chalk.yellow(`(${dur}) ← SLOW`)
          : chalk.dim(`(${dur})`);
        const errStr = line.isError ? chalk.red(' ← ERROR') : '';
        const summaryStr = line.summary ? chalk.dim(`  "${line.summary.slice(0, 50)}"`) : '';
        endLine = `${ts} ${chalk.dim('←')} ${name} ${durStr}${errStr}${summaryStr}`;
      }

      renderedLines.push(startLine);
      renderedLines.push(endLine);
      continue;
    }

    if (line.kind === 'step_advance') {
      const stepStr = line.stepId ? chalk.dim(` → ${line.stepId}`) : '';
      renderedLines.push(`${ts} ${chalk.green('ADVANCE')}${stepStr}`);
      continue;
    }

    if (line.kind === 'agent_stuck') {
      const detail = line.detail ? chalk.dim(`  ${line.detail.slice(0, 80)}`) : '';
      renderedLines.push(`${ts} ${chalk.red(`STUCK [${line.reason}]`)}${detail}`);
      continue;
    }

    if (line.kind === 'session_end') {
      const outcomeColor = line.outcome === 'success' ? chalk.green : chalk.red;
      const detail = line.detail ? chalk.dim(`  ${line.detail.slice(0, 80)}`) : '';
      renderedLines.push(`${ts} ${outcomeColor(`DONE [${line.outcome}]`)}${detail}`);
      continue;
    }
  }

  if (renderedLines.length === 0) {
    renderedLines.push(chalk.dim('(no turn data -- session may predate fine-grained event logging)'));
  }

  return header + renderedLines.join('\n');
}
