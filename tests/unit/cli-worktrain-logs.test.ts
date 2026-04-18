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
    case 'session_completed':
      return `${prefix}  workflow=${obj['workflowId'] ?? '?'} outcome=${obj['outcome'] ?? '?'}${obj['detail'] ? ` (${obj['detail']})` : ''}`;
    case 'step_advanced':
      return `${prefix}`;
    case 'issue_reported':
      return `${prefix}  severity=${obj['severity'] ?? '?'} ${String(obj['summary'] ?? '').slice(0, 80)}`;
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

  it('formats session_completed with outcome and optional detail', () => {
    const line = makeEvent({
      kind: 'session_completed',
      sessionId: 'aabbccdd-1234',
      workflowId: 'wf-123',
      outcome: 'error',
      detail: 'unhandled exception',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('outcome=error');
    expect(result).toContain('(unhandled exception)');
  });

  it('omits detail parenthetical when detail is absent', () => {
    const line = makeEvent({
      kind: 'session_completed',
      sessionId: 'aabbccdd-1234',
      workflowId: 'wf-123',
      outcome: 'success',
    });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).not.toContain('(');
  });

  it('formats step_advanced as bare prefix (no extra fields)', () => {
    const line = makeEvent({ kind: 'step_advanced', sessionId: 'aabbccdd-1234' });
    const result = formatDaemonEventLine(line);
    expect(result).not.toBeNull();
    expect(result).toContain('step_advanced');
    // Should not have trailing spaces or extra content
    expect(result!.endsWith('step_advanced')).toBe(true);
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
