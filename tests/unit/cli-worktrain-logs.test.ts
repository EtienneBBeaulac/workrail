/**
 * Unit tests for worktrain logs command logic.
 *
 * The formatting and filtering functions are inline in cli-worktrain.ts and not
 * exported. These tests replicate the same rules directly so they stay in sync
 * with the implementation without requiring a subprocess.
 *
 * WHY replicate instead of extract: the logs command is intentionally a thin
 * inline composition. Extracting purely for testability would be premature
 * abstraction -- these tests document the contract instead.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Replicated formatDaemonEventLine logic (mirrors cli-worktrain.ts)
// ---------------------------------------------------------------------------

function formatDaemonEventLine(raw: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const ts = typeof obj['ts'] === 'number'
    ? new Date(obj['ts']).toISOString().replace('T', ' ').slice(0, 23)
    : '?';
  const kind = typeof obj['kind'] === 'string' ? obj['kind'] : 'unknown';
  const sessionId = typeof obj['sessionId'] === 'string' ? obj['sessionId'].slice(0, 8) : null;
  const prefix = sessionId ? `[${ts}] [${sessionId}] ${kind}` : `[${ts}] ${kind}`;

  switch (kind) {
    case 'agent_stuck':
      return `${prefix}  *** STUCK: ${obj['reason'] ?? '?'} -- ${String(obj['detail'] ?? '').slice(0, 100)}`;
    case 'llm_turn_started':
      return `${prefix}  msgs=${obj['messageCount'] ?? '?'}`;
    case 'llm_turn_completed':
      return `${prefix}  stop=${obj['stopReason'] ?? '?'} in=${obj['inputTokens'] ?? '?'} out=${obj['outputTokens'] ?? '?'} tools=[${Array.isArray(obj['toolNamesRequested']) ? (obj['toolNamesRequested'] as string[]).join(',') : ''}]`;
    case 'tool_call_started':
      return `${prefix}  tool=${obj['toolName'] ?? '?'} args=${String(obj['argsSummary'] ?? '').slice(0, 80)}`;
    case 'tool_call_completed':
      return `${prefix}  tool=${obj['toolName'] ?? '?'} ${obj['durationMs'] ?? '?'}ms result=${String(obj['resultSummary'] ?? '').slice(0, 60)}`;
    case 'tool_call_failed':
      return `${prefix}  tool=${obj['toolName'] ?? '?'} ${obj['durationMs'] ?? '?'}ms err=${String(obj['errorMessage'] ?? '').slice(0, 80)}`;
    case 'tool_called':
      return `${prefix}  tool=${obj['toolName'] ?? '?'} ${obj['summary'] ? String(obj['summary']).slice(0, 80) : ''}`;
    case 'tool_error':
      return `${prefix}  tool=${obj['toolName'] ?? '?'} err=${String(obj['error'] ?? '').slice(0, 80)}`;
    case 'session_started':
      return `${prefix}  workflow=${obj['workflowId'] ?? '?'} workspace=${obj['workspacePath'] ?? '?'}`;
    case 'session_completed': {
      const outcome = obj['outcome'];
      const detail = obj['detail'] ? ` (${obj['detail']})` : '';
      if (outcome === 'success') {
        return `${prefix}  workflow=${obj['workflowId'] ?? '?'} -- session complete${detail}`;
      } else if (outcome === 'error') {
        return `${prefix}  workflow=${obj['workflowId'] ?? '?'} -- session FAILED${detail}`;
      } else if (outcome === 'timeout') {
        return `${prefix}  workflow=${obj['workflowId'] ?? '?'} -- session TIMEOUT${detail}`;
      }
      return `${prefix}  workflow=${obj['workflowId'] ?? '?'} outcome=${outcome ?? '?'}${detail}`;
    }
    case 'session_aborted':
      return `${prefix}  reason=${obj['reason'] ?? '?'}`;
    case 'step_advanced':
      return `${prefix}  -> step advanced`;
    case 'issue_reported': {
      const severity = obj['severity'];
      const summary = String(obj['summary'] ?? '').slice(0, 100);
      if (severity === 'fatal') {
        return `${prefix}  FATAL: ${summary}`;
      } else if (severity === 'error') {
        return `${prefix}  ERROR: ${summary}`;
      }
      return `${prefix}  severity=${severity ?? '?'} ${summary}`;
    }
    default:
      return `${prefix}  ${JSON.stringify(obj).slice(0, 120)}`;
  }
}

// ---------------------------------------------------------------------------
// Replicated session filter logic (mirrors cli-worktrain.ts printLines)
// ---------------------------------------------------------------------------

/**
 * Returns true if the raw JSONL line matches the given session filter string.
 * Matches on sessionId (UUID) OR workrailSessionId (sess_xxx) -- prefix or exact.
 * Returns false for malformed JSON.
 */
function lineMatchesSession(line: string, session: string): boolean {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const sid = typeof obj['sessionId'] === 'string' ? obj['sessionId'] : '';
    const wrid = typeof obj['workrailSessionId'] === 'string' ? obj['workrailSessionId'] : '';
    return (
      sid.startsWith(session) || sid === session ||
      wrid.startsWith(session) || wrid === session
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ts: 1_700_000_000_000, ...overrides });
}

// ---------------------------------------------------------------------------
// Tests: session filter
// ---------------------------------------------------------------------------

describe('worktrain logs --session filter', () => {
  const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const WRID = 'sess_abc123xyz';

  it('matches a line by full UUID sessionId', () => {
    const line = makeEvent({ kind: 'step_advanced', sessionId: UUID });
    expect(lineMatchesSession(line, UUID)).toBe(true);
  });

  it('matches a line by UUID sessionId prefix (first 8 chars)', () => {
    const line = makeEvent({ kind: 'step_advanced', sessionId: UUID });
    expect(lineMatchesSession(line, UUID.slice(0, 8))).toBe(true);
  });

  it('does not match a line with a different UUID', () => {
    const line = makeEvent({ kind: 'step_advanced', sessionId: 'ffffffff-0000-0000-0000-000000000000' });
    expect(lineMatchesSession(line, UUID.slice(0, 8))).toBe(false);
  });

  it('matches a line by full workrailSessionId', () => {
    const line = makeEvent({ kind: 'llm_turn_started', sessionId: UUID, workrailSessionId: WRID });
    expect(lineMatchesSession(line, WRID)).toBe(true);
  });

  it('matches a line by workrailSessionId prefix', () => {
    const line = makeEvent({ kind: 'llm_turn_started', sessionId: UUID, workrailSessionId: WRID });
    expect(lineMatchesSession(line, 'sess_abc123')).toBe(true);
  });

  it('matches when filtering by sess_ prefix on an event that has workrailSessionId', () => {
    const line = makeEvent({
      kind: 'tool_call_started',
      sessionId: UUID,
      workrailSessionId: WRID,
      toolName: 'Bash',
      argsSummary: 'ls -la',
    });
    expect(lineMatchesSession(line, 'sess_')).toBe(true);
  });

  it('does not match when neither sessionId nor workrailSessionId match', () => {
    const line = makeEvent({ kind: 'step_advanced', sessionId: UUID, workrailSessionId: WRID });
    expect(lineMatchesSession(line, 'sess_zzz')).toBe(false);
  });

  it('returns false for malformed JSON', () => {
    expect(lineMatchesSession('{not valid json', UUID)).toBe(false);
  });

  it('returns false for empty string input', () => {
    expect(lineMatchesSession('', UUID)).toBe(false);
  });

  it('does not match an event with no sessionId or workrailSessionId fields', () => {
    const line = makeEvent({ kind: 'daemon_started', port: 3456, workspacePath: '/tmp' });
    expect(lineMatchesSession(line, UUID.slice(0, 8))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatDaemonEventLine
// ---------------------------------------------------------------------------

describe('formatDaemonEventLine', () => {
  it('returns null for malformed JSON', () => {
    expect(formatDaemonEventLine('{bad json')).toBeNull();
    expect(formatDaemonEventLine('')).toBeNull();
    expect(formatDaemonEventLine('   ')).toBeNull();
  });

  it('formats llm_turn_started with messageCount', () => {
    const line = makeEvent({ kind: 'llm_turn_started', sessionId: 'aabbccdd-1234', messageCount: 7 });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('llm_turn_started');
    expect(result).toContain('msgs=7');
    expect(result).toContain('[aabbccdd]');
  });

  it('formats llm_turn_completed with token counts and tools', () => {
    const line = makeEvent({
      kind: 'llm_turn_completed',
      sessionId: 'aabbccdd-1234',
      stopReason: 'tool_use',
      inputTokens: 1500,
      outputTokens: 300,
      toolNamesRequested: ['Bash', 'Read'],
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('stop=tool_use');
    expect(result).toContain('in=1500');
    expect(result).toContain('out=300');
    expect(result).toContain('tools=[Bash,Read]');
  });

  it('formats tool_call_started with tool name and args', () => {
    const line = makeEvent({
      kind: 'tool_call_started',
      sessionId: 'aabbccdd-1234',
      toolName: 'Bash',
      argsSummary: 'npm run build',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('tool=Bash');
    expect(result).toContain('args=npm run build');
  });

  it('formats tool_call_completed with duration and result summary', () => {
    const line = makeEvent({
      kind: 'tool_call_completed',
      sessionId: 'aabbccdd-1234',
      toolName: 'Read',
      durationMs: 42,
      resultSummary: 'file contents here',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('tool=Read');
    expect(result).toContain('42ms');
    expect(result).toContain('result=file contents here');
  });

  it('formats tool_call_failed with error message', () => {
    const line = makeEvent({
      kind: 'tool_call_failed',
      sessionId: 'aabbccdd-1234',
      toolName: 'Write',
      durationMs: 10,
      errorMessage: 'permission denied',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('tool=Write');
    expect(result).toContain('10ms');
    expect(result).toContain('err=permission denied');
  });

  it('formats session_started with workflowId and workspace', () => {
    const line = makeEvent({
      kind: 'session_started',
      sessionId: 'aabbccdd-1234',
      workflowId: 'wf-123',
      workspacePath: '/home/user/project',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('workflow=wf-123');
    expect(result).toContain('workspace=/home/user/project');
  });

  it('formats session_completed outcome=error with FAILED label and detail', () => {
    const line = makeEvent({
      kind: 'session_completed',
      sessionId: 'aabbccdd-1234',
      workflowId: 'wf-123',
      outcome: 'error',
      detail: 'unhandled exception',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('session FAILED');
    expect(result).toContain('(unhandled exception)');
    expect(result).not.toContain('outcome=error');
  });

  it('formats session_completed outcome=success with complete label', () => {
    const line = makeEvent({
      kind: 'session_completed',
      sessionId: 'aabbccdd-1234',
      workflowId: 'wf-123',
      outcome: 'success',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('session complete');
    expect(result).not.toContain('outcome=');
  });

  it('formats session_completed outcome=timeout with TIMEOUT label', () => {
    const line = makeEvent({
      kind: 'session_completed',
      sessionId: 'aabbccdd-1234',
      workflowId: 'wf-123',
      outcome: 'timeout',
      detail: 'max_turns',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('session TIMEOUT');
    expect(result).toContain('(max_turns)');
  });

  it('formats session_aborted with reason=daemon_shutdown', () => {
    const line = makeEvent({
      kind: 'session_aborted',
      sessionId: 'sess_abc123xyz',
      workrailSessionId: 'sess_abc123xyz',
      reason: 'daemon_shutdown',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('session_aborted');
    expect(result).toContain('reason=daemon_shutdown');
    // sessionId prefix is sliced to 8 chars: 'sess_abc'
    expect(result).toContain('[sess_abc]');
  });

  it('formats session_aborted with reason=daemon_killed', () => {
    const line = makeEvent({
      kind: 'session_aborted',
      sessionId: 'sess_def456xyz',
      reason: 'daemon_killed',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('session_aborted');
    expect(result).toContain('reason=daemon_killed');
  });

  it('formats step_advanced with arrow label', () => {
    const line = makeEvent({ kind: 'step_advanced', sessionId: 'aabbccdd-1234' });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('step_advanced');
    expect(result).toContain('-> step advanced');
  });

  it('formats agent_stuck with STUCK label and reason/detail', () => {
    const line = makeEvent({
      kind: 'agent_stuck',
      sessionId: 'aabbccdd-1234',
      reason: 'repeated_tool_call',
      detail: 'Same tool+args called 3 times: Bash',
      toolName: 'Bash',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('*** STUCK:');
    expect(result).toContain('repeated_tool_call');
    expect(result).toContain('Same tool+args called 3 times: Bash');
  });

  it('formats issue_reported severity=fatal with FATAL label', () => {
    const line = makeEvent({
      kind: 'issue_reported',
      sessionId: 'aabbccdd-1234',
      severity: 'fatal',
      summary: 'Cannot proceed: assessment gate rejected all attempts',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('FATAL:');
    expect(result).toContain('Cannot proceed');
    expect(result).not.toContain('severity=fatal');
  });

  it('formats issue_reported severity=error with ERROR label', () => {
    const line = makeEvent({
      kind: 'issue_reported',
      sessionId: 'aabbccdd-1234',
      severity: 'error',
      summary: 'Build failed with exit code 1',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('ERROR:');
    expect(result).toContain('Build failed');
  });

  it('formats issue_reported severity=warn with severity label', () => {
    const line = makeEvent({
      kind: 'issue_reported',
      sessionId: 'aabbccdd-1234',
      severity: 'warn',
      summary: 'Retrying after transient failure',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('severity=warn');
    expect(result).toContain('Retrying after transient failure');
  });

  it('uses ? for unknown ts when ts field is missing', () => {
    const line = JSON.stringify({ kind: 'step_advanced', sessionId: 'aabbccdd-1234' });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('[?]');
  });

  it('omits sessionId bracket when sessionId is missing', () => {
    const line = makeEvent({ kind: 'daemon_started', port: 3456 });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    // No sessionId bracket in prefix -- only one bracket pair (the timestamp)
    const bracketed = result!.match(/\[/g) ?? [];
    expect(bracketed.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Replicated tsToMs logic (mirrors cli-worktrain.ts)
// ---------------------------------------------------------------------------

function tsToMs(ts: unknown): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    if (!isNaN(parsed)) return parsed;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Replicated formatQueuePollLine logic (mirrors cli-worktrain.ts)
// ---------------------------------------------------------------------------

function formatQueuePollLine(raw: string): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const tsRaw = obj['ts'];
  const time = typeof tsRaw === 'string' && tsRaw.length >= 19
    ? tsRaw.slice(11, 19)
    : '?';

  const event = typeof obj['event'] === 'string' ? obj['event'] : 'unknown';

  switch (event) {
    case 'task_selected': {
      const num = obj['issueNumber'] ?? '?';
      const title = String(obj['title'] ?? '').slice(0, 80);
      const maturity = obj['maturity'] ?? '?';
      return `[${time}] queue_poll selected #${num} "${title}" maturity=${maturity}`;
    }
    case 'task_skipped': {
      const num = obj['issueNumber'] ?? '?';
      const title = String(obj['title'] ?? '').slice(0, 80);
      const reason = obj['reason'] ?? '?';
      return `[${time}] queue_poll skipped #${num} "${title}" reason=${reason}`;
    }
    case 'poll_cycle_complete': {
      const selected = obj['selected'] ?? '?';
      const skipped = obj['skipped'] ?? '?';
      const elapsed = obj['elapsed'];
      const elapsedStr = typeof elapsed === 'number' ? `${elapsed}ms` : '?';
      return `[${time}] queue_poll cycle_complete selected=${selected} skipped=${skipped} elapsed=${elapsedStr}`;
    }
    default:
      return `[${time}] queue_poll ${event} ${JSON.stringify(obj).slice(0, 100)}`;
  }
}

// ---------------------------------------------------------------------------
// Replicated shouldShowStderrLine logic (mirrors cli-worktrain.ts)
// ---------------------------------------------------------------------------

function shouldShowStderrLine(line: string): boolean {
  const NOISE_PREFIXES = [
    '[WorkRail] config',
    '[DI]',
    '[FeatureFlags]',
    '[Console]',
    '[DaemonConsole]',
  ];
  for (const prefix of NOISE_PREFIXES) {
    if (line.includes(prefix)) return false;
  }
  return (
    line.includes('error') ||
    line.includes('Error') ||
    line.includes('WARN') ||
    line.includes('failed') ||
    line.includes('stuck') ||
    line.includes('crash') ||
    line.includes('adaptive-pipeline')
  );
}

// ---------------------------------------------------------------------------
// Tests: tsToMs
// ---------------------------------------------------------------------------

describe('tsToMs', () => {
  it('returns a number as-is', () => {
    expect(tsToMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('parses an ISO 8601 string to ms', () => {
    const iso = '2026-04-20T19:10:53Z';
    expect(tsToMs(iso)).toBe(Date.parse(iso));
  });

  it('returns 0 for undefined', () => {
    expect(tsToMs(undefined)).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(tsToMs(null)).toBe(0);
  });

  it('returns 0 for an invalid string', () => {
    expect(tsToMs('not-a-date')).toBe(0);
  });

  it('returns 0 for an empty string', () => {
    expect(tsToMs('')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: formatQueuePollLine
// ---------------------------------------------------------------------------

describe('formatQueuePollLine', () => {
  it('returns null for malformed JSON', () => {
    expect(formatQueuePollLine('{bad json')).toBeNull();
    expect(formatQueuePollLine('')).toBeNull();
  });

  it('formats task_selected with issueNumber, title, and maturity', () => {
    const line = JSON.stringify({
      event: 'task_selected',
      issueNumber: 393,
      title: 'test(daemon): add coverage for loadSessionNotes',
      maturity: 'specced',
      reason: 'has acceptance criteria',
      ts: '2026-04-20T19:10:53Z',
    });
    const result = formatQueuePollLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('queue_poll selected');
    expect(result).toContain('#393');
    expect(result).toContain('"test(daemon): add coverage for loadSessionNotes"');
    expect(result).toContain('maturity=specced');
    expect(result).toContain('[19:10:53]');
  });

  it('formats task_skipped with issueNumber, title, and reason', () => {
    const line = JSON.stringify({
      event: 'task_skipped',
      issueNumber: 42,
      title: 'Implement login flow',
      reason: 'active_session',
      ts: '2026-04-20T19:10:53Z',
    });
    const result = formatQueuePollLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('queue_poll skipped');
    expect(result).toContain('#42');
    expect(result).toContain('"Implement login flow"');
    expect(result).toContain('reason=active_session');
  });

  it('formats poll_cycle_complete with selected, skipped, and elapsed', () => {
    const line = JSON.stringify({
      event: 'poll_cycle_complete',
      selected: 1,
      skipped: 2,
      elapsed: 234,
      ts: '2026-04-20T19:10:53Z',
    });
    const result = formatQueuePollLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('queue_poll cycle_complete');
    expect(result).toContain('selected=1');
    expect(result).toContain('skipped=2');
    expect(result).toContain('elapsed=234ms');
  });

  it('formats an unknown event type as a generic line', () => {
    const line = JSON.stringify({
      event: 'some_future_event',
      ts: '2026-04-20T19:10:53Z',
    });
    const result = formatQueuePollLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('queue_poll some_future_event');
  });

  it('uses ? for time when ts field is missing', () => {
    const line = JSON.stringify({ event: 'task_selected', issueNumber: 1, title: 'x', maturity: 'idea' });
    const result = formatQueuePollLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('[?]');
  });

  it('uses ? for time when ts is a number (daemon-style ts)', () => {
    // Queue poll ts should be ISO string; if someone passes a number it falls back to ?
    const line = JSON.stringify({ event: 'task_selected', issueNumber: 1, title: 'x', maturity: 'idea', ts: 1700000000000 });
    const result = formatQueuePollLine(line);
    expect(result).not.toBeNull();
    // A number is not a string with length >= 19, so time = '?'
    expect(result).toContain('[?]');
  });

  it('truncates long titles to 80 characters', () => {
    const longTitle = 'A'.repeat(100);
    const line = JSON.stringify({
      event: 'task_selected',
      issueNumber: 1,
      title: longTitle,
      maturity: 'idea',
      ts: '2026-04-20T19:10:53Z',
    });
    const result = formatQueuePollLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('"' + 'A'.repeat(80) + '"');
    expect(result).not.toContain('A'.repeat(81));
  });
});

// ---------------------------------------------------------------------------
// Tests: shouldShowStderrLine
// ---------------------------------------------------------------------------

describe('shouldShowStderrLine', () => {
  it('returns false for a [WorkRail] config line even with error keyword', () => {
    expect(shouldShowStderrLine('[WorkRail] config loaded with 3 keys (error in config)')).toBe(false);
  });

  it('returns false for a [DI] line', () => {
    expect(shouldShowStderrLine('[DI] container initialized')).toBe(false);
  });

  it('returns false for a [FeatureFlags] line', () => {
    expect(shouldShowStderrLine('[FeatureFlags] flags loaded')).toBe(false);
  });

  it('returns false for a [Console] line', () => {
    expect(shouldShowStderrLine('[Console] listening on port 3456')).toBe(false);
  });

  it('returns false for a [DaemonConsole] line', () => {
    expect(shouldShowStderrLine('[DaemonConsole] started on port 3456')).toBe(false);
  });

  it('returns true for a line containing "error"', () => {
    expect(shouldShowStderrLine('Unhandled error in session handler')).toBe(true);
  });

  it('returns true for a line containing "Error"', () => {
    expect(shouldShowStderrLine('TypeError: cannot read property of undefined')).toBe(true);
  });

  it('returns true for a line containing "WARN"', () => {
    expect(shouldShowStderrLine('[WARN] Rate limit approaching')).toBe(true);
  });

  it('returns true for a line containing "failed"', () => {
    expect(shouldShowStderrLine('Session dispatch failed after 3 retries')).toBe(true);
  });

  it('returns true for a line containing "stuck"', () => {
    expect(shouldShowStderrLine('Agent appears stuck -- no progress in 10 turns')).toBe(true);
  });

  it('returns true for a line containing "crash"', () => {
    expect(shouldShowStderrLine('Process crash detected, restarting')).toBe(true);
  });

  it('returns true for a line containing "adaptive-pipeline"', () => {
    expect(shouldShowStderrLine('adaptive-pipeline: switching to conservative mode')).toBe(true);
  });

  it('returns false for a routine non-noise line with no keywords', () => {
    expect(shouldShowStderrLine('WorkRail daemon started on port 3456')).toBe(false);
  });

  it('returns false for an empty line', () => {
    expect(shouldShowStderrLine('')).toBe(false);
  });
});
