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
  analyzeFleet,
  resultCategory,
  formatDiagnosticCard,
  formatFleetSummary,
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

function stepAdvanced(sessionId: string, ts = 1300, stepId?: string): string {
  return JSON.stringify({ kind: 'step_advanced', sessionId, ts, ...(stepId ? { stepId } : {}) });
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

  it('populates stepId on StepRecord when step_advanced event includes stepId', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        llmTurn('sess_abc123', 100, 50, 1100),
        stepAdvanced('sess_abc123', 1200, 'phase-0-reframe'),
        llmTurn('sess_abc123', 100, 50, 1300),
        stepAdvanced('sess_abc123', 1400, 'phase-1a-landscape'),
        sessionCompleted('sess_abc123', 'timeout', 'wall_clock', 2000),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('WORKFLOW_TIMEOUT');
    if (result.kind === 'WORKFLOW_TIMEOUT') {
      expect(result.steps[0]?.stepId).toBe('phase-0-reframe');
      expect(result.steps[1]?.stepId).toBe('phase-1a-landscape');
      // Terminal step has no stepId
      expect(result.steps[2]?.stepId).toBeUndefined();
    }
  });

  it('handles step_advanced events without stepId (backward compat with old daemon logs)', () => {
    const readFile = makeReadFile({
      [`${EVENTS_DIR}/${TODAY}.jsonl`]: [
        sessionStarted('sess_abc123'),
        llmTurn('sess_abc123', 100, 50, 1100),
        stepAdvanced('sess_abc123', 1200), // no stepId
        sessionCompleted('sess_abc123', 'timeout', 'wall_clock', 2000),
      ].join('\n'),
    });
    const result = parseDaemonEvents('sess_abc123', EVENTS_DIR, 7, readFile);
    expect(result.kind).toBe('WORKFLOW_TIMEOUT');
    if (result.kind === 'WORKFLOW_TIMEOUT') {
      // stepId absent -- backward compat
      expect(result.steps[0]?.stepId).toBeUndefined();
    }
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

// ---------------------------------------------------------------------------
// resultCategory() tests
// ---------------------------------------------------------------------------

describe('resultCategory', () => {
  it('maps SUCCESS -> success', () => {
    const result: DiagnosticResult = {
      kind: 'SUCCESS', sessionId: 'a', workflowId: 'w', startedAt: 0, durationMs: 0,
      metrics: { llmTurns: 0, stepAdvances: 0, toolCallsTotal: 0, toolCallsFailed: 0, inputTokens: 0, outputTokens: 0 },
    };
    expect(resultCategory(result)).toBe('success');
  });

  it('maps WORKFLOW_TIMEOUT -> workflow_timeout', () => {
    const result: DiagnosticResult = {
      kind: 'WORKFLOW_TIMEOUT', sessionId: 'a', workflowId: 'w', startedAt: 0, durationMs: 0,
      timeoutReason: 'wall_clock', stepAdvances: 0, steps: [], processState: 'STOPPED',
      metrics: { llmTurns: 5, stepAdvances: 0, toolCallsTotal: 0, toolCallsFailed: 0, inputTokens: 0, outputTokens: 0 },
    };
    expect(resultCategory(result)).toBe('workflow_timeout');
  });

  it('maps WORKFLOW_STUCK -> workflow_stuck', () => {
    const result: DiagnosticResult = {
      kind: 'WORKFLOW_STUCK', sessionId: 'a', workflowId: 'w', startedAt: 0, durationMs: 0,
      stuckReason: 'repeated_tool_call', stuckDetail: 'stuck', steps: [], processState: 'STOPPED',
      metrics: { llmTurns: 5, stepAdvances: 0, toolCallsTotal: 0, toolCallsFailed: 0, inputTokens: 0, outputTokens: 0 },
    };
    expect(resultCategory(result)).toBe('workflow_stuck');
  });
});

// ---------------------------------------------------------------------------
// analyzeFleet() + formatFleetSummary() tests
// ---------------------------------------------------------------------------

describe('analyzeFleet', () => {
  const FLEET_EVENTS_DIR = '/fleet/events';
  const TODAY_FILE = `${FLEET_EVENTS_DIR}/2026-05-09.jsonl`;

  function makeReadDir(files: Record<string, string>): (dir: string) => readonly string[] | null {
    return (dir: string) => {
      const entries = Object.keys(files)
        .filter(p => p.startsWith(dir + '/'))
        .map(p => p.slice(dir.length + 1));
      return entries.length > 0 ? entries : null;
    };
  }

  function makeReadFile(files: Record<string, string>): (path: string) => string | null {
    return (path: string) => files[path] ?? null;
  }

  it('returns empty analysis when no files exist', () => {
    const result = analyzeFleet(
      makeReadDir({}),
      makeReadFile({}),
      FLEET_EVENTS_DIR,
    );
    expect(result.sessionCount).toBe(0);
    expect(result.categoryBreakdown).toHaveLength(0);
    expect(result.daysBack).toBe(7);
  });

  it('counts sessions by category', () => {
    const lines = [
      JSON.stringify({ kind: 'session_started', sessionId: 'sess_aaa', workflowId: 'wr.discovery', ts: 1000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_aaa', inputTokens: 100, outputTokens: 50, ts: 2000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_aaa', inputTokens: 100, outputTokens: 50, ts: 3000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_aaa', inputTokens: 100, outputTokens: 50, ts: 4000 }),
      JSON.stringify({ kind: 'session_completed', sessionId: 'sess_aaa', workflowId: 'wr.discovery', outcome: 'success', detail: '', ts: 5000 }),

      JSON.stringify({ kind: 'session_started', sessionId: 'sess_bbb', workflowId: 'wr.discovery', ts: 1000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_bbb', inputTokens: 200, outputTokens: 80, ts: 2000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_bbb', inputTokens: 200, outputTokens: 80, ts: 3000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_bbb', inputTokens: 200, outputTokens: 80, ts: 4000 }),
      JSON.stringify({ kind: 'session_completed', sessionId: 'sess_bbb', workflowId: 'wr.discovery', outcome: 'timeout', detail: 'wall_clock', ts: 5000 }),
    ].join('\n');

    const files = { [TODAY_FILE]: lines };
    const result = analyzeFleet(makeReadDir(files), makeReadFile(files), FLEET_EVENTS_DIR);

    expect(result.sessionCount).toBe(2);
    const cats = Object.fromEntries(result.categoryBreakdown);
    expect(cats['success']).toBe(1);
    expect(cats['workflow_timeout']).toBe(1);
  });

  it('filters by workflowFilter', () => {
    const lines = [
      JSON.stringify({ kind: 'session_started', sessionId: 'sess_disc', workflowId: 'wr.discovery', ts: 1000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_disc', inputTokens: 100, outputTokens: 50, ts: 2000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_disc', inputTokens: 100, outputTokens: 50, ts: 3000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_disc', inputTokens: 100, outputTokens: 50, ts: 4000 }),
      JSON.stringify({ kind: 'session_completed', sessionId: 'sess_disc', workflowId: 'wr.discovery', outcome: 'success', detail: '', ts: 5000 }),

      JSON.stringify({ kind: 'session_started', sessionId: 'sess_code', workflowId: 'wr.coding-task', ts: 1000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_code', inputTokens: 100, outputTokens: 50, ts: 2000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_code', inputTokens: 100, outputTokens: 50, ts: 3000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_code', inputTokens: 100, outputTokens: 50, ts: 4000 }),
      JSON.stringify({ kind: 'session_completed', sessionId: 'sess_code', workflowId: 'wr.coding-task', outcome: 'success', detail: '', ts: 5000 }),
    ].join('\n');

    const files = { [TODAY_FILE]: lines };
    const result = analyzeFleet(makeReadDir(files), makeReadFile(files), FLEET_EVENTS_DIR, 'wr.discovery');

    expect(result.sessionCount).toBe(1);
    expect(result.workflowStats[0]?.workflowId).toBe('wr.discovery');
  });

  it('excludes sessions with fewer than 3 LLM turns', () => {
    const lines = [
      JSON.stringify({ kind: 'session_started', sessionId: 'sess_tiny', workflowId: 'wr.test', ts: 1000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_tiny', inputTokens: 50, outputTokens: 10, ts: 2000 }),
      JSON.stringify({ kind: 'session_completed', sessionId: 'sess_tiny', workflowId: 'wr.test', outcome: 'success', detail: '', ts: 3000 }),
    ].join('\n');

    const files = { [TODAY_FILE]: lines };
    const result = analyzeFleet(makeReadDir(files), makeReadFile(files), FLEET_EVENTS_DIR);
    expect(result.sessionCount).toBe(0);
  });

  it('aggregates token burn and identifies timeout waste', () => {
    const lines = [
      JSON.stringify({ kind: 'session_started', sessionId: 'sess_ok', workflowId: 'wr.test', ts: 1000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_ok', inputTokens: 1000, outputTokens: 100, ts: 2000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_ok', inputTokens: 1000, outputTokens: 100, ts: 3000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_ok', inputTokens: 1000, outputTokens: 100, ts: 4000 }),
      JSON.stringify({ kind: 'session_completed', sessionId: 'sess_ok', workflowId: 'wr.test', outcome: 'success', detail: '', ts: 5000 }),

      JSON.stringify({ kind: 'session_started', sessionId: 'sess_tmo', workflowId: 'wr.test', ts: 1000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_tmo', inputTokens: 5000, outputTokens: 500, ts: 2000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_tmo', inputTokens: 5000, outputTokens: 500, ts: 3000 }),
      JSON.stringify({ kind: 'llm_turn_completed', sessionId: 'sess_tmo', inputTokens: 5000, outputTokens: 500, ts: 4000 }),
      JSON.stringify({ kind: 'session_completed', sessionId: 'sess_tmo', workflowId: 'wr.test', outcome: 'timeout', detail: 'wall_clock', ts: 5000 }),
    ].join('\n');

    const files = { [TODAY_FILE]: lines };
    const result = analyzeFleet(makeReadDir(files), makeReadFile(files), FLEET_EVENTS_DIR);

    expect(result.totalTokens).toBe(3 * (1000 + 100) + 3 * (5000 + 500));
    expect(result.timeoutTokens).toBe(3 * (5000 + 500));
    expect(result.timeoutReasonCounts).toEqual([['wall_clock', 1]]);
  });

  it('respects daysBack parameter', () => {
    const result = analyzeFleet(
      makeReadDir({}),
      makeReadFile({}),
      FLEET_EVENTS_DIR,
      undefined,
      30,
    );
    expect(result.daysBack).toBe(30);
  });
});

describe('formatFleetSummary', () => {
  it('shows "no sessions" message when sessionCount is 0', () => {
    const analysis = {
      daysBack: 7,
      sessionCount: 0,
      categoryBreakdown: [] as const,
      workflowStats: [] as const,
      timeoutReasonCounts: [] as const,
      totalTokens: 0,
      timeoutTokens: 0,
    };
    const out = formatFleetSummary(analysis, { noColor: true });
    expect(out).toContain('No sessions');
    expect(out).toContain('7 days');
  });

  it('shows category breakdown with percentages', () => {
    const analysis = {
      daysBack: 7,
      sessionCount: 4,
      categoryBreakdown: [['workflow_timeout', 3], ['success', 1]] as const,
      workflowStats: [] as const,
      timeoutReasonCounts: [['wall_clock', 3]] as const,
      totalTokens: 1_000_000,
      timeoutTokens: 750_000,
    };
    const out = formatFleetSummary(analysis, { noColor: true });
    expect(out).toContain('75%');
    expect(out).toContain('25%');
    expect(out).toContain('wall_clock');
  });

  it('includes daysBack in the header', () => {
    const analysis = {
      daysBack: 14,
      sessionCount: 2,
      categoryBreakdown: [['success', 2]] as const,
      workflowStats: [] as const,
      timeoutReasonCounts: [] as const,
      totalTokens: 0,
      timeoutTokens: 0,
    };
    const out = formatFleetSummary(analysis, { noColor: true });
    expect(out).toContain('14 days');
  });
});
