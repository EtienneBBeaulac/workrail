/**
 * Unit tests for worktrain session-log -- parseSessionEvents() and formatSessionEvents().
 *
 * parseSessionEvents() is exported and tested with an injected readFile fake.
 * No filesystem access. Pattern follows cli-worktrain-diagnose.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  parseSessionEvents,
  formatSessionEvents,
  type SessionLogResult,
} from '../../src/cli/commands/worktrain-session-log.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const EVENTS_DIR = '/fake/events/daemon';
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

function makeReadFile(files: Record<string, string>): (path: string) => string | null {
  return (p: string) => files[p] ?? null;
}

function evt(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function sessionStarted(sessionId: string, workflowId = 'wr.test', ts = 1000): string {
  return evt({ kind: 'session_started', sessionId, workflowId, ts });
}
function llmTurnStarted(sessionId: string, ts = 1100, messageCount = 1, modelId = 'claude-test'): string {
  return evt({ kind: 'llm_turn_started', sessionId, messageCount, modelId, ts });
}
function toolCallStarted(sessionId: string, toolName: string, argsSummary: string, ts = 1200): string {
  return evt({ kind: 'tool_call_started', sessionId, toolName, argsSummary, ts });
}
function toolCallCompleted(sessionId: string, toolName: string, durationMs: number, resultSummary: string, ts = 1300): string {
  return evt({ kind: 'tool_call_completed', sessionId, toolName, durationMs, resultSummary, ts });
}
function toolCallFailed(sessionId: string, toolName: string, durationMs: number, errorMessage: string, ts = 1300): string {
  return evt({ kind: 'tool_call_failed', sessionId, toolName, durationMs, errorMessage, ts });
}
function toolCalled(sessionId: string, toolName: string, ts = 1250): string {
  return evt({ kind: 'tool_called', sessionId, toolName, ts });
}
function stepAdvanced(sessionId: string, stepId: string, ts = 1400): string {
  return evt({ kind: 'step_advanced', sessionId, stepId, ts });
}
function sessionCompleted(sessionId: string, outcome: string, detail = '', ts = 2000): string {
  return evt({ kind: 'session_completed', sessionId, workflowId: 'wr.test', outcome, detail, ts });
}
function agentStuck(sessionId: string, reason: string, detail = '', ts = 1500): string {
  return evt({ kind: 'agent_stuck', sessionId, reason, detail, ts });
}

const SID = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
const EVENTS_FILE = `${EVENTS_DIR}/${TODAY}.jsonl`;

// ---------------------------------------------------------------------------
// parseSessionEvents
// ---------------------------------------------------------------------------

describe('parseSessionEvents', () => {
  it('returns not_found when no events match', () => {
    const result = parseSessionEvents(SID, EVENTS_DIR, 7, makeReadFile({}));
    expect(result.kind).toBe('not_found');
    if (result.kind === 'not_found') {
      expect(result.sessionIdQuery).toBe(SID);
      expect(result.daysBack).toBe(7);
    }
  });

  it('returns found with all line types for a full session', () => {
    const lines = [
      sessionStarted(SID),
      llmTurnStarted(SID, 1100, 3, 'claude-haiku'),
      toolCallStarted(SID, 'Bash', '{"command":"ls"}', 1200),
      toolCallCompleted(SID, 'Bash', 500, 'file1.ts\nfile2.ts', 1700),
      stepAdvanced(SID, 'phase-1', 1800),
      sessionCompleted(SID, 'success', 'stop', 2000),
    ].join('\n');

    const result = parseSessionEvents(SID, EVENTS_DIR, 7, makeReadFile({ [EVENTS_FILE]: lines }));
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;

    expect(result.sessionId).toBe(SID);
    expect(result.workflowId).toBe('wr.test');

    const kinds = result.lines.map((l) => l.kind);
    expect(kinds).toEqual(['llm_turn', 'tool', 'step_advance', 'session_end']);

    const toolLine = result.lines[1];
    expect(toolLine?.kind).toBe('tool');
    if (toolLine?.kind === 'tool') {
      expect(toolLine.toolName).toBe('Bash');
      expect(toolLine.argsSummary).toBe('{"command":"ls"}');
      expect(toolLine.durationMs).toBe(500);
      expect(toolLine.isError).toBe(false);
    }
  });

  it('returns ambiguous when multiple sessions match the prefix', () => {
    const sid2 = 'aaaa1111-bbbb-cccc-dddd-ffffffffffff';
    const lines = [
      sessionStarted(SID),
      sessionStarted(sid2),
    ].join('\n');
    const result = parseSessionEvents('aaaa1111', EVENTS_DIR, 7, makeReadFile({ [EVENTS_FILE]: lines }));
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toContain(SID);
      expect(result.candidates).toContain(sid2);
    }
  });

  it('skips tool_called events -- only tool_call_completed produces a tool line', () => {
    const lines = [
      sessionStarted(SID),
      llmTurnStarted(SID),
      toolCallStarted(SID, 'Bash', '{"command":"echo hi"}', 1200),
      toolCalled(SID, 'Bash', 1250), // coarse event -- must be skipped
      toolCallCompleted(SID, 'Bash', 100, 'hi', 1300),
      sessionCompleted(SID, 'success'),
    ].join('\n');

    const result = parseSessionEvents(SID, EVENTS_DIR, 7, makeReadFile({ [EVENTS_FILE]: lines }));
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;

    // Must be exactly one tool line (not two)
    const toolLines = result.lines.filter((l) => l.kind === 'tool');
    expect(toolLines.length).toBe(1);
  });

  it('emits a tool line with durationMs null for an orphaned tool_call_started (daemon crash)', () => {
    const lines = [
      sessionStarted(SID),
      llmTurnStarted(SID),
      toolCallStarted(SID, 'Bash', '{"command":"sleep 999"}', 1200),
      // No tool_call_completed -- daemon crashed
    ].join('\n');

    const result = parseSessionEvents(SID, EVENTS_DIR, 7, makeReadFile({ [EVENTS_FILE]: lines }));
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;

    const toolLines = result.lines.filter((l) => l.kind === 'tool');
    expect(toolLines.length).toBe(1);
    const tl = toolLines[0];
    if (tl?.kind === 'tool') {
      expect(tl.durationMs).toBeNull();
      expect(tl.toolName).toBe('Bash');
    }
  });

  it('merges events from two daily files for cross-midnight sessions', () => {
    const yesterdayFile = `${EVENTS_DIR}/${YESTERDAY}.jsonl`;
    const todayFile = `${EVENTS_DIR}/${TODAY}.jsonl`;

    const yesterdayEvents = [
      sessionStarted(SID, 'wr.test', 1000),
      llmTurnStarted(SID, 1100),
    ].join('\n');

    const todayEvents = [
      toolCallStarted(SID, 'Read', '{"filePath":"/src/foo.ts"}', 2000),
      toolCallCompleted(SID, 'Read', 200, '(file contents)', 2200),
      sessionCompleted(SID, 'success', '', 3000),
    ].join('\n');

    const result = parseSessionEvents(SID, EVENTS_DIR, 7, makeReadFile({
      [yesterdayFile]: yesterdayEvents,
      [todayFile]: todayEvents,
    }));

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    const kinds = result.lines.map((l) => l.kind);
    expect(kinds).toEqual(['llm_turn', 'tool', 'session_end']);
  });

  it('skips malformed JSONL lines silently', () => {
    const lines = [
      sessionStarted(SID),
      'not valid json {{{}',
      sessionCompleted(SID, 'success'),
    ].join('\n');

    expect(() => {
      const result = parseSessionEvents(SID, EVENTS_DIR, 7, makeReadFile({ [EVENTS_FILE]: lines }));
      expect(result.kind).toBe('found');
    }).not.toThrow();
  });

  it('emits agent_stuck line for agent_stuck event', () => {
    const lines = [
      sessionStarted(SID),
      llmTurnStarted(SID),
      agentStuck(SID, 'stall', 'LLM API call timed out', 1500),
      sessionCompleted(SID, 'stuck', 'stall', 2000),
    ].join('\n');

    const result = parseSessionEvents(SID, EVENTS_DIR, 7, makeReadFile({ [EVENTS_FILE]: lines }));
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;

    const stuckLine = result.lines.find((l) => l.kind === 'agent_stuck');
    expect(stuckLine).toBeDefined();
    if (stuckLine?.kind === 'agent_stuck') {
      expect(stuckLine.reason).toBe('stall');
    }
  });

  it('marks tool line as isError for tool_call_failed', () => {
    const lines = [
      sessionStarted(SID),
      llmTurnStarted(SID),
      toolCallStarted(SID, 'Bash', '{"command":"bad"}', 1200),
      toolCallFailed(SID, 'Bash', 50, 'command not found', 1250),
      sessionCompleted(SID, 'error'),
    ].join('\n');

    const result = parseSessionEvents(SID, EVENTS_DIR, 7, makeReadFile({ [EVENTS_FILE]: lines }));
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;

    const toolLine = result.lines.find((l) => l.kind === 'tool');
    expect(toolLine?.kind).toBe('tool');
    if (toolLine?.kind === 'tool') {
      expect(toolLine.isError).toBe(true);
      expect(toolLine.summary).toBe('command not found');
    }
  });
});

// ---------------------------------------------------------------------------
// formatSessionEvents
// ---------------------------------------------------------------------------

describe('formatSessionEvents', () => {
  it('not_found output contains the session ID query', () => {
    const result: SessionLogResult = { kind: 'not_found', sessionIdQuery: 'abc123', daysBack: 7 };
    const output = formatSessionEvents(result);
    expect(output).toContain('abc123');
    expect(output).toContain('7');
  });

  it('ambiguous output lists candidate sessions', () => {
    const result: SessionLogResult = {
      kind: 'ambiguous',
      sessionIdQuery: 'aaaa',
      candidates: ['aaaa-1111', 'aaaa-2222'],
    };
    const output = formatSessionEvents(result);
    expect(output).toContain('aaaa-1111');
    expect(output).toContain('aaaa-2222');
  });

  it('found output contains session ID and tool name', () => {
    const result: SessionLogResult = {
      kind: 'found',
      sessionId: SID,
      workflowId: 'wr.test',
      startedAt: 1000,
      lines: [
        { kind: 'tool', ts: 1200, toolName: 'Bash', argsSummary: '{"command":"ls"}', durationMs: 500, isError: false, summary: 'file1.ts' },
        { kind: 'session_end', ts: 2000, outcome: 'success' },
      ],
    };
    const output = formatSessionEvents(result);
    expect(output).toContain(SID);
    expect(output).toContain('Bash');
    expect(output).toContain('500ms');
    expect(output).toContain('success');
  });

  it('SLOW annotation appears for tools taking >10s', () => {
    const result: SessionLogResult = {
      kind: 'found',
      sessionId: SID,
      workflowId: 'wr.test',
      startedAt: 1000,
      lines: [
        { kind: 'tool', ts: 1200, toolName: 'Bash', argsSummary: '', durationMs: 15000, isError: false, summary: '' },
      ],
    };
    const output = formatSessionEvents(result);
    expect(output).toContain('SLOW');
    expect(output).toContain('15.0s');
  });

  it('crashed annotation appears for durationMs null', () => {
    const result: SessionLogResult = {
      kind: 'found',
      sessionId: SID,
      workflowId: 'wr.test',
      startedAt: 1000,
      lines: [
        { kind: 'tool', ts: 1200, toolName: 'Bash', argsSummary: '', durationMs: null, isError: false, summary: '' },
      ],
    };
    const output = formatSessionEvents(result);
    expect(output).toContain('crashed');
  });
});
