/**
 * Unit tests for worktrain diagnose -- parseDaemonEvents() and formatDiagnosticCard().
 *
 * parseDaemonEvents() is exported from the module and tested directly (no subprocess,
 * no filesystem -- readFile is injected). formatDiagnosticCard() is also tested directly.
 *
 * Test coverage:
 *   parseDaemonEvents():
 *   - NOT_FOUND: no events in any file
 *   - SUCCESS: session_completed outcome=success
 *   - CONFIG_ERROR: outcome=error, detail matches bad model ID pattern
 *   - WORKFLOW_STUCK: agent_stuck reason=repeated_tool_call
 *   - WORKFLOW_TIMEOUT: outcome=timeout
 *   - INFRA_ERROR: session_aborted reason=daemon_shutdown
 *   - ORPHANED: events but no terminal event
 *   - DEFAULT: outcome=error with unrecognized detail
 *   - Cross-midnight: session start in file N, terminal event in file N+1
 *   - Prefix collision: two sessions share prefix -> AMBIGUOUS
 *   - Prefix exact match: prefix resolves to one session
 *   - Malformed JSONL: skipped silently, no throw
 *
 *   formatDiagnosticCard():
 *   - Zone 3 capped at 8 steps with ellipsis for 12-step workflow
 *   - Zone 3 empty state sentinel for 0-step session
 *   - --ascii flag substitutes glyphs
 *   - Truncation indicator present when detailTruncated=true
 *   - Zone 3 → marker does NOT contain chalk.red ANSI code
 */

import { describe, it, expect } from 'vitest';
import {
  parseDaemonEvents,
  formatDiagnosticCard,
  type DiagnosticResult,
  type SessionMetrics,
  type StepRecord,
} from '../../src/cli/commands/worktrain-diagnose.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const EVENTS_DIR = '/fake/events/daemon';
const TODAY = '2026-05-09';
const YESTERDAY = '2026-05-08';

function makeReadFile(files: Record<string, string>): (path: string) => string | null {
  return (path: string) => files[path] ?? null;
}

function sessionStarted(sessionId: string, workflowId = 'wr.test', ts = 1000): string {
  return JSON.stringify({ kind: 'session_started', sessionId, workflowId, ts });
}

function sessionCompleted(sessionId: string, outcome: string, detail = '', ts = 2000): string {
  return JSON.stringify({ kind: 'session_completed', sessionId, workflowId: 'wr.test', outcome, detail, ts });
}

function sessionAborted(sessionId: string, reason: string, ts = 2000): string {
  return JSON.stringify({ kind: 'session_aborted', sessionId, reason, ts });
}

function agentStuck(sessionId: string, reason: string, toolName?: string, argsSummary?: string, ts = 1500): string {
  return JSON.stringify({ kind: 'agent_stuck', sessionId, reason, detail: `stuck: ${reason}`, toolName, argsSummary, ts });
}

function llmTurn(sessionId: string, inputTokens = 100, outputTokens = 50, ts = 1200): string {
  return JSON.stringify({ kind: 'llm_turn_completed', sessionId, stopReason: 'tool_use', inputTokens, outputTokens, ts });
}

function toolCallStarted(sessionId: string, toolName: string, ts = 1100): string {
  return JSON.stringify({ kind: 'tool_call_started', sessionId, toolName, argsSummary: 'args', ts });
}

function stepAdvanced(sessionId: string, ts = 1300): string {
  return JSON.stringify({ kind: 'step_advanced', sessionId, ts });
}

// ---------------------------------------------------------------------------
// parseDaemonEvents() tests
// ---------------------------------------------------------------------------

describe('parseDaemonEvents', () => {
  it('returns NOT_FOUND when no events in any file', () => {
    const readFile = makeReadFile({});
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('NOT_FOUND');
    if (result.kind === 'NOT_FOUND') {
      expect(result.sessionIdQuery).toBe('sess_abc123');
      expect(result.daysBack).toBe(7);
    }
  });

  it('returns NOT_FOUND when file exists but session is absent', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: sessionStarted('sess_other999'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('NOT_FOUND');
  });

  it('returns SUCCESS for session_completed outcome=success', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        llmTurn('sess_abc123'),
        sessionCompleted('sess_abc123', 'success'),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.sessionId).toBe('sess_abc123');
      expect(result.workflowId).toBe('wr.test');
    }
  });

  it('returns CONFIG_ERROR for outcome=error with bad model ID pattern', () => {
    const errorDetail = '400 The provided model identifier is invalid.';
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        sessionCompleted('sess_abc123', 'error', errorDetail),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('CONFIG_ERROR');
    if (result.kind === 'CONFIG_ERROR') {
      // Verify the specific string pattern that identifies this as CONFIG_ERROR
      expect(result.detail).toBe(errorDetail);
    }
  });

  it('returns WORKFLOW_STUCK for agent_stuck reason=repeated_tool_call with toolName and argsSummary', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        llmTurn('sess_abc123'),
        agentStuck('sess_abc123', 'repeated_tool_call', 'bash', 'grep -r SessionManager src/'),
        sessionCompleted('sess_abc123', 'stuck', 'repeated_tool_call'),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('WORKFLOW_STUCK');
    if (result.kind === 'WORKFLOW_STUCK') {
      expect(result.stuckReason).toBe('repeated_tool_call');
      expect(result.toolName).toBe('bash');
      expect(result.argsSummary).toBe('grep -r SessionManager src/');
    }
  });

  it('returns WORKFLOW_TIMEOUT for outcome=timeout', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        llmTurn('sess_abc123'),
        sessionCompleted('sess_abc123', 'timeout', 'wall_clock'),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('WORKFLOW_TIMEOUT');
    if (result.kind === 'WORKFLOW_TIMEOUT') {
      expect(result.timeoutReason).toBe('wall_clock');
    }
  });

  it('returns INFRA_ERROR for session_aborted reason=daemon_shutdown', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        llmTurn('sess_abc123'),
        sessionAborted('sess_abc123', 'daemon_shutdown'),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('INFRA_ERROR');
    if (result.kind === 'INFRA_ERROR') {
      expect(result.infraReason).toBe('daemon_shutdown');
    }
  });

  it('returns ORPHANED when session has events but no terminal event', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        llmTurn('sess_abc123'),
        toolCallStarted('sess_abc123', 'bash'),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('ORPHANED');
    if (result.kind === 'ORPHANED') {
      expect(result.lastEventKind).toBe('tool_call_started');
    }
  });

  it('returns DEFAULT for outcome=error with unrecognized detail, including raw event line', () => {
    const rawEventJson = JSON.stringify({
      kind: 'session_completed',
      sessionId: 'sess_abc123',
      workflowId: 'wr.test',
      outcome: 'error',
      detail: 'quota_exceeded',
      ts: 2000,
    });
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        rawEventJson,
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('DEFAULT');
    if (result.kind === 'DEFAULT') {
      expect(result.rawEventLine).toContain('quota_exceeded');
      expect(result.outcome).toBe('error');
    }
  });

  it('handles cross-midnight session: start in file N, terminal event in file N+1 (not ORPHANED)', () => {
    // Session starts late in yesterday's file, completes early in today's file
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionCompleted('sess_midnight', 'success', '', 86400001),
      ].join('\n'),
      [`${EVENTS_DIR}/${YESTERDAY}.jsonl`]: [
        JSON.stringify({ kind: 'session_started', sessionId: 'sess_midnight', workflowId: 'wr.test', ts: 86400000 - 5000 }),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_midnight', EVENTS_DIR, 7, readFile);
    // Must be SUCCESS, not ORPHANED -- cross-midnight assembly required
    expect(result.kind).toBe('SUCCESS');
  });

  it('returns AMBIGUOUS when prefix matches two distinct sessions, listing both candidates', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123full'),
        sessionCompleted('sess_abc123full', 'success'),
        sessionStarted('sess_abc456full'),
        sessionCompleted('sess_abc456full', 'error', 'some error'),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('AMBIGUOUS');
    if (result.kind === 'AMBIGUOUS') {
      expect(result.candidates).toContain('sess_abc123full');
      expect(result.candidates).toContain('sess_abc456full');
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('resolves a prefix that matches exactly one session', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_unique999x'),
        sessionCompleted('sess_unique999x', 'success'),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_unique', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.sessionId).toBe('sess_unique999x');
    }
  });

  it('skips malformed JSONL lines without throwing', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        'THIS IS NOT JSON {{{',
        null as unknown as string, // malformed
        sessionCompleted('sess_abc123', 'success'),
      ].join('\n'),
    });
    // Should not throw
    expect(() => parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile)).not.toThrow();
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('SUCCESS');
  });

  it('accumulates metrics across multiple turns and tool calls', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        llmTurn('sess_abc123', 1000, 500),
        llmTurn('sess_abc123', 2000, 800),
        toolCallStarted('sess_abc123', 'bash'),
        toolCallStarted('sess_abc123', 'bash'),
        JSON.stringify({ kind: 'tool_call_failed', sessionId: 'sess_abc123', toolName: 'bash', durationMs: 100, errorMessage: 'failed', ts: 1400 }),
        sessionCompleted('sess_abc123', 'success'),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('SUCCESS');
    if (result.kind === 'SUCCESS') {
      expect(result.metrics.llmTurns).toBe(2);
      expect(result.metrics.inputTokens).toBe(3000);
      expect(result.metrics.outputTokens).toBe(1300);
      expect(result.metrics.toolCallsTotal).toBe(2);
      expect(result.metrics.toolCallsFailed).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// formatDiagnosticCard() tests
// ---------------------------------------------------------------------------

describe('formatDiagnosticCard', () => {
  const baseMetrics: SessionMetrics = {
    llmTurns: 5,
    stepAdvances: 2,
    toolCallsTotal: 10,
    toolCallsFailed: 1,
    inputTokens: 5000,
    outputTokens: 2000,
  };

  it('Zone 3 capped at 8 steps with ellipsis for 12-step workflow', () => {
    const steps: StepRecord[] = Array.from({ length: 12 }, (_, i) => ({
      index: i + 1,
      status: i < 11 ? 'completed' : 'terminal',
      turns: 3,
    }));
    const result: DiagnosticResult = {
      kind: 'WORKFLOW_STUCK',
      sessionId: 'sess_abc123',
      workflowId: 'wr.test',
      startedAt: 1000,
      durationMs: 60000,
      stuckReason: 'repeated_tool_call',
      stuckDetail: 'stuck',
      toolName: 'bash',
      argsSummary: 'grep -r foo',
      metrics: baseMetrics,
      steps,
      processState: 'STOPPED',
    };
    const card = formatDiagnosticCard(result, { noColor: true });
    // Should contain ellipsis with omitted count
    expect(card).toContain('steps omitted');
    // Should not contain all 12 steps explicitly
    const stepLineCount = card.split('\n').filter(l => l.match(/step \d+/)).length;
    expect(stepLineCount).toBeLessThanOrEqual(8);
  });

  it('Zone 3 shows empty state sentinel for 0-step session', () => {
    const result: DiagnosticResult = {
      kind: 'WORKFLOW_TIMEOUT',
      sessionId: 'sess_abc123',
      workflowId: 'wr.test',
      startedAt: 1000,
      durationMs: 60000,
      timeoutReason: 'wall_clock',
      stepAdvances: 0,
      metrics: { ...baseMetrics, stepAdvances: 0, llmTurns: 0 },
      steps: [],
      processState: 'STOPPED',
    };
    const card = formatDiagnosticCard(result, { noColor: true });
    expect(card).toContain('session terminated before first step');
  });

  it('--ascii flag substitutes Unicode glyphs', () => {
    const steps: StepRecord[] = [
      { index: 1, status: 'completed', turns: 3 },
      { index: 2, status: 'terminal', turns: 5 },
    ];
    const result: DiagnosticResult = {
      kind: 'WORKFLOW_STUCK',
      sessionId: 'sess_abc123',
      workflowId: 'wr.test',
      startedAt: 1000,
      durationMs: 60000,
      stuckReason: 'repeated_tool_call',
      stuckDetail: 'stuck',
      metrics: baseMetrics,
      steps,
      processState: 'STOPPED',
    };
    const card = formatDiagnosticCard(result, { ascii: true, noColor: true });
    expect(card).toContain('[ok]');
    expect(card).toContain('[->]');
    expect(card).not.toContain('✓');
    expect(card).not.toContain('→');
  });

  it('shows truncation indicator when detailTruncated=true', () => {
    const result: DiagnosticResult = {
      kind: 'CONFIG_ERROR',
      sessionId: 'sess_abc123',
      workflowId: 'wr.test',
      startedAt: 1000,
      durationMs: 1000,
      detail: '400 The model identifier is'.padEnd(199, 'x'),
      detailTruncated: true,
      metrics: baseMetrics,
      steps: [],
      processState: 'STOPPED',
    };
    const card = formatDiagnosticCard(result, { noColor: true });
    expect(card).toContain('truncated at 200 chars');
  });

  it('Zone 3 terminal step does NOT contain red ANSI color code', () => {
    // The red ANSI escape code is [31m or [31m (chalk.red)
    const steps: StepRecord[] = [
      { index: 1, status: 'completed', turns: 3 },
      { index: 2, status: 'terminal', turns: 8 },
    ];
    const result: DiagnosticResult = {
      kind: 'WORKFLOW_STUCK',
      sessionId: 'sess_abc123',
      workflowId: 'wr.test',
      startedAt: 1000,
      durationMs: 60000,
      stuckReason: 'repeated_tool_call',
      stuckDetail: 'stuck',
      toolName: 'bash',
      metrics: baseMetrics,
      steps,
      processState: 'STOPPED',
    };
    // With color enabled (no noColor), check the step timeline section
    const card = formatDiagnosticCard(result);
    // Extract just the step timeline section
    const timelineStart = card.indexOf('Step timeline:');
    const timelineSection = timelineStart >= 0 ? card.slice(timelineStart) : card;
    // chalk.red produces ANSI escape [31m or the bright variant [91m
    const hasRedAnsi = /\[31m|\[91m|\[1;31m/.test(timelineSection);
    expect(hasRedAnsi).toBe(false);
  });

  it('AMBIGUOUS result lists all candidate session IDs', () => {
    const result: DiagnosticResult = {
      kind: 'AMBIGUOUS',
      sessionIdQuery: 'sess_abc',
      candidates: ['sess_abc123full', 'sess_abc456full'],
    };
    const card = formatDiagnosticCard(result, { noColor: true });
    expect(card).toContain('sess_abc123full');
    expect(card).toContain('sess_abc456full');
    expect(card).toContain('Multiple sessions match');
  });

  it('NOT_FOUND result suggests widening the search', () => {
    const result: DiagnosticResult = {
      kind: 'NOT_FOUND',
      sessionIdQuery: 'sess_missing',
      daysBack: 7,
    };
    const card = formatDiagnosticCard(result, { noColor: true });
    expect(card).toContain('not found');
    expect(card).toContain('execution-stats.jsonl');
  });

  it('SUCCESS result does not show DEFAULT fallback text', () => {
    const result: DiagnosticResult = {
      kind: 'SUCCESS',
      sessionId: 'sess_abc123',
      workflowId: 'wr.test',
      startedAt: 1000,
      durationMs: 60000,
      metrics: baseMetrics,
    };
    const card = formatDiagnosticCard(result, { noColor: true });
    expect(card).not.toContain('No automated fix suggestion');
    expect(card).toContain('SUCCESS');
    expect(card).toContain('completed normally');
  });
});
