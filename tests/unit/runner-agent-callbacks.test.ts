/**
 * Unit tests for runner/agent-loop-runner.ts -- buildAgentCallbacks
 *
 * Focuses on: event emission, ring buffer management, stall detection,
 * and the first-writer-wins invariant for terminal signals.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildAgentCallbacks } from '../../src/daemon/runner/agent-loop-runner.js';
import { createSessionState, setTerminalSignal } from '../../src/daemon/state/index.js';
import type { DaemonEventEmitter } from '../../src/daemon/daemon-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmitter() {
  const events: unknown[] = [];
  return {
    emitter: { emit: (e: unknown) => events.push(e) } as unknown as DaemonEventEmitter,
    events,
  };
}

// ---------------------------------------------------------------------------
// Tests: onLlmTurnStarted / onLlmTurnCompleted
// ---------------------------------------------------------------------------

describe('buildAgentCallbacks -- LLM turn events', () => {
  it('onLlmTurnStarted emits llm_turn_started with messageCount and modelId', () => {
    const state = createSessionState('ct_test');
    const { emitter, events } = makeEmitter();
    const cbs = buildAgentCallbacks('sess1', state, 'claude-sonnet-4-6', emitter, 3);

    cbs.onLlmTurnStarted?.({ messageCount: 5, modelId: 'claude-sonnet-4-6' });

    expect(events).toHaveLength(1);
    const evt = events[0] as { kind: string; messageCount: number; modelId: string };
    expect(evt.kind).toBe('llm_turn_started');
    expect(evt.messageCount).toBe(5);
    expect(evt.modelId).toBe('claude-sonnet-4-6');
  });

  it('onLlmTurnCompleted emits llm_turn_completed with token counts', () => {
    const state = createSessionState('ct_test');
    const { emitter, events } = makeEmitter();
    const cbs = buildAgentCallbacks('sess1', state, 'claude-sonnet-4-6', emitter, 3);

    cbs.onLlmTurnCompleted?.({ stopReason: 'end_turn', outputTokens: 100, inputTokens: 500, toolNamesRequested: [] });

    const evt = events[0] as { kind: string; outputTokens: number; inputTokens: number };
    expect(evt.kind).toBe('llm_turn_completed');
    expect(evt.outputTokens).toBe(100);
    expect(evt.inputTokens).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Tests: onToolCallStarted -- ring buffer
// ---------------------------------------------------------------------------

describe('buildAgentCallbacks -- tool call ring buffer', () => {
  it('populates lastNToolCalls up to threshold', () => {
    const state = createSessionState('ct_test');
    const cbs = buildAgentCallbacks('sess1', state, 'model', undefined, 3);

    cbs.onToolCallStarted?.({ toolName: 'Bash', argsSummary: 'ls' });
    cbs.onToolCallStarted?.({ toolName: 'Read', argsSummary: '/foo' });
    cbs.onToolCallStarted?.({ toolName: 'Bash', argsSummary: 'pwd' });

    expect(state.lastNToolCalls).toHaveLength(3);
    expect(state.lastNToolCalls[0]?.toolName).toBe('Bash');
    expect(state.lastNToolCalls[2]?.toolName).toBe('Bash');
  });

  it('evicts oldest entry when threshold exceeded', () => {
    const state = createSessionState('ct_test');
    const cbs = buildAgentCallbacks('sess1', state, 'model', undefined, 3);

    cbs.onToolCallStarted?.({ toolName: 'A', argsSummary: '1' });
    cbs.onToolCallStarted?.({ toolName: 'B', argsSummary: '2' });
    cbs.onToolCallStarted?.({ toolName: 'C', argsSummary: '3' });
    cbs.onToolCallStarted?.({ toolName: 'D', argsSummary: '4' }); // evicts A

    expect(state.lastNToolCalls).toHaveLength(3);
    expect(state.lastNToolCalls[0]?.toolName).toBe('B');
    expect(state.lastNToolCalls[2]?.toolName).toBe('D');
  });

  it('emits tool_call_started event for each call', () => {
    const state = createSessionState('ct_test');
    const { emitter, events } = makeEmitter();
    const cbs = buildAgentCallbacks('sess1', state, 'model', emitter, 3);

    cbs.onToolCallStarted?.({ toolName: 'Bash', argsSummary: 'echo hi' });

    const evt = events[0] as { kind: string; toolName: string };
    expect(evt.kind).toBe('tool_call_started');
    expect(evt.toolName).toBe('Bash');
  });
});

// ---------------------------------------------------------------------------
// Tests: onToolCallCompleted / onToolCallFailed
// ---------------------------------------------------------------------------

describe('buildAgentCallbacks -- tool completion events', () => {
  it('onToolCallCompleted emits tool_call_completed with durationMs', () => {
    const state = createSessionState('ct_test');
    const { emitter, events } = makeEmitter();
    const cbs = buildAgentCallbacks('sess1', state, 'model', emitter, 3);

    cbs.onToolCallCompleted?.({ toolName: 'Bash', durationMs: 42, resultSummary: 'ok' });

    const evt = events[0] as { kind: string; durationMs: number };
    expect(evt.kind).toBe('tool_call_completed');
    expect(evt.durationMs).toBe(42);
  });

  it('onToolCallFailed emits tool_call_failed with errorMessage', () => {
    const state = createSessionState('ct_test');
    const { emitter, events } = makeEmitter();
    const cbs = buildAgentCallbacks('sess1', state, 'model', emitter, 3);

    cbs.onToolCallFailed?.({ toolName: 'Bash', durationMs: 10, errorMessage: 'ENOENT' });

    const evt = events[0] as { kind: string; errorMessage: string };
    expect(evt.kind).toBe('tool_call_failed');
    expect(evt.errorMessage).toBe('ENOENT');
  });
});

// ---------------------------------------------------------------------------
// Tests: onStallDetected
// ---------------------------------------------------------------------------

describe('buildAgentCallbacks -- stall detection', () => {
  it('onStallDetected sets terminalSignal to stuck/stall', () => {
    const state = createSessionState('ct_test');
    const cbs = buildAgentCallbacks('sess1', state, 'model', undefined, 3, 'wr.test');

    cbs.onStallDetected?.();

    expect(state.terminalSignal).toEqual({ kind: 'stuck', reason: 'stall' });
  });

  it('onStallDetected emits agent_stuck event with reason stall', () => {
    const state = createSessionState('ct_test');
    const { emitter, events } = makeEmitter();
    const cbs = buildAgentCallbacks('sess1', state, 'model', emitter, 3, 'wr.test');

    cbs.onStallDetected?.();

    const evt = events.find((e: unknown) => (e as { kind?: string }).kind === 'agent_stuck') as { kind: string; reason: string } | undefined;
    expect(evt).toBeDefined();
    expect(evt?.reason).toBe('stall');
  });

  it('onStallDetected respects first-writer-wins -- does not overwrite prior stuck signal', () => {
    const state = createSessionState('ct_test');
    setTerminalSignal(state, { kind: 'stuck', reason: 'repeated_tool_call' });

    const cbs = buildAgentCallbacks('sess1', state, 'model', undefined, 3);
    cbs.onStallDetected?.();

    // Prior signal preserved
    expect(state.terminalSignal).toEqual({ kind: 'stuck', reason: 'repeated_tool_call' });
  });

  it('onStallDetected without emitter does not throw', () => {
    const state = createSessionState('ct_test');
    const cbs = buildAgentCallbacks('sess1', state, 'model', undefined, 3);
    expect(() => cbs.onStallDetected?.()).not.toThrow();
  });

  it('workflowId falls back to sessionId when not provided', () => {
    const state = createSessionState('ct_test');
    // No workflowId provided -- should not throw, outbox write is fire-and-forget
    const cbs = buildAgentCallbacks('sess-fallback', state, 'model', undefined, 3);
    expect(() => cbs.onStallDetected?.()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: workrailSessionId in event correlation
// ---------------------------------------------------------------------------

describe('buildAgentCallbacks -- workrailSessionId correlation', () => {
  it('events include workrailSessionId when state has it set', () => {
    const state = createSessionState('ct_test');
    state.workrailSessionId = 'sess_abc123';
    const { emitter, events } = makeEmitter();
    const cbs = buildAgentCallbacks('local-id', state, 'model', emitter, 3);

    cbs.onLlmTurnStarted?.({ messageCount: 1, modelId: 'model' });

    const evt = events[0] as { workrailSessionId?: string };
    expect(evt.workrailSessionId).toBe('sess_abc123');
  });

  it('events work when workrailSessionId is null', () => {
    const state = createSessionState('ct_test');
    // workrailSessionId starts null
    const { emitter, events } = makeEmitter();
    const cbs = buildAgentCallbacks('local-id', state, 'model', emitter, 3);

    cbs.onLlmTurnStarted?.({ messageCount: 1, modelId: 'model' });

    expect(events).toHaveLength(1); // event emitted without throwing
  });
});
