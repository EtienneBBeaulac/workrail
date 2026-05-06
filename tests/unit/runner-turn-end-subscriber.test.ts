/**
 * Unit tests for runner/agent-loop-runner.ts -- buildTurnEndSubscriber
 *
 * Focuses on: stuck detection signals, max-turns handling, conversation
 * flush delegation, and steer injection.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildTurnEndSubscriber } from '../../src/daemon/runner/agent-loop-runner.js';
import type { TurnEndSubscriberContext } from '../../src/daemon/runner/agent-loop-runner.js';
import { createSessionState, setTerminalSignal } from '../../src/daemon/state/index.js';
import type { AgentLoop, AgentEvent } from '../../src/daemon/agent-loop.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentLoop> = {}): AgentLoop {
  return {
    abort: vi.fn(),
    steer: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(),
    state: { messages: [] },
    ...overrides,
  } as unknown as AgentLoop;
}

function makeTurnEndEvent(toolResults: Array<{ toolCallId: string; toolName: string; isError: boolean; result: { content: Array<{ type: 'text'; text: string }> } | null }> = []): AgentEvent {
  return { type: 'turn_end', toolResults };
}

function makeCtx(overrides: Partial<TurnEndSubscriberContext> = {}): TurnEndSubscriberContext {
  return {
    agent: makeAgent(),
    state: createSessionState('ct_test'),
    stuckConfig: {
      maxTurns: 200,
      stuckAbortPolicy: 'abort',
      noProgressAbortEnabled: false,
      stuckRepeatThreshold: 3,
    },
    sessionId: 'sess-001',
    workflowId: 'wr.test',
    emitter: undefined,
    conversationPath: '/tmp/fake-conversation.jsonl',
    lastFlushedRef: { count: 0 },
    stuckRepeatThreshold: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: basic behavior
// ---------------------------------------------------------------------------

describe('buildTurnEndSubscriber -- basic behavior', () => {
  it('ignores non-turn_end events', async () => {
    const ctx = makeCtx();
    const subscriber = buildTurnEndSubscriber(ctx);
    const agentEndEvent: AgentEvent = { type: 'agent_end' };
    await expect(subscriber(agentEndEvent)).resolves.toBeUndefined();
    // turnCount should not have changed
    expect(ctx.state.turnCount).toBe(0);
  });

  it('increments turnCount on turn_end', async () => {
    const ctx = makeCtx();
    const subscriber = buildTurnEndSubscriber(ctx);
    await subscriber(makeTurnEndEvent());
    expect(ctx.state.turnCount).toBe(1);
    await subscriber(makeTurnEndEvent());
    expect(ctx.state.turnCount).toBe(2);
  });

  it('emits tool_error for isError tool results', async () => {
    const emittedEvents: unknown[] = [];
    const ctx = makeCtx({
      emitter: { emit: (e: unknown) => emittedEvents.push(e) } as unknown as TurnEndSubscriberContext['emitter'],
    });
    const subscriber = buildTurnEndSubscriber(ctx);

    await subscriber(makeTurnEndEvent([
      { toolCallId: 'tc1', toolName: 'Bash', isError: true, result: { content: [{ type: 'text', text: 'command not found' }] } },
    ]));

    const errorEvt = emittedEvents.find((e): e is { kind: string; toolName: string } =>
      (e as { kind?: string }).kind === 'tool_error',
    );
    expect(errorEvt?.toolName).toBe('Bash');
  });

  it('does not emit tool_error for successful tool results', async () => {
    const emittedEvents: unknown[] = [];
    const ctx = makeCtx({
      emitter: { emit: (e: unknown) => emittedEvents.push(e) } as unknown as TurnEndSubscriberContext['emitter'],
    });
    const subscriber = buildTurnEndSubscriber(ctx);

    await subscriber(makeTurnEndEvent([
      { toolCallId: 'tc1', toolName: 'Bash', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } },
    ]));

    const errorEvt = emittedEvents.find((e) => (e as { kind?: string }).kind === 'tool_error');
    expect(errorEvt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: max_turns_exceeded
// ---------------------------------------------------------------------------

describe('buildTurnEndSubscriber -- max_turns_exceeded', () => {
  it('aborts agent and sets timeout/max_turns signal when maxTurns reached', async () => {
    const ctx = makeCtx({
      stuckConfig: { maxTurns: 3, stuckAbortPolicy: 'abort', noProgressAbortEnabled: false, stuckRepeatThreshold: 3 },
    });
    ctx.state.turnCount = 3; // already at limit when turnCount gets incremented to 3+1=4? No -- check logic
    // evaluateStuckSignals checks: turnCount >= maxTurns BEFORE incrementing (subscriber increments then evaluates)
    // Actually: subscriber does turnCount++ FIRST, then evaluates. So at turnCount=2 after ++, it becomes 3 >= 3 = true
    ctx.state.turnCount = 2; // will become 3 after increment in subscriber

    const subscriber = buildTurnEndSubscriber(ctx);
    await subscriber(makeTurnEndEvent());

    expect(ctx.agent.abort).toHaveBeenCalled();
    expect(ctx.state.terminalSignal).toEqual({ kind: 'timeout', reason: 'max_turns' });
  });

  it('returns early (no steer injection) when max_turns_exceeded', async () => {
    const ctx = makeCtx({
      stuckConfig: { maxTurns: 3, stuckAbortPolicy: 'abort', noProgressAbortEnabled: false, stuckRepeatThreshold: 3 },
    });
    ctx.state.turnCount = 2;
    ctx.state.pendingSteerParts = ['pending steer'];

    const subscriber = buildTurnEndSubscriber(ctx);
    await subscriber(makeTurnEndEvent());

    // Agent was aborted and function returned early -- steer not injected
    expect(ctx.agent.abort).toHaveBeenCalled();
    // The steer part stays unprocessed (subscriber returned early)
    expect(ctx.state.pendingSteerParts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: repeated_tool_call stuck detection
// ---------------------------------------------------------------------------

describe('buildTurnEndSubscriber -- repeated_tool_call stuck', () => {
  it('aborts and sets stuck/repeated_tool_call when same tool+args repeated 3 times', async () => {
    const ctx = makeCtx({
      stuckConfig: { maxTurns: 200, stuckAbortPolicy: 'abort', noProgressAbortEnabled: false, stuckRepeatThreshold: 3 },
    });
    // Fill ring buffer with 3 identical calls
    ctx.state.lastNToolCalls = [
      { toolName: 'Bash', argsSummary: 'ls -la' },
      { toolName: 'Bash', argsSummary: 'ls -la' },
      { toolName: 'Bash', argsSummary: 'ls -la' },
    ];

    const subscriber = buildTurnEndSubscriber(ctx);
    await subscriber(makeTurnEndEvent());

    expect(ctx.agent.abort).toHaveBeenCalled();
    expect(ctx.state.terminalSignal).toEqual({ kind: 'stuck', reason: 'repeated_tool_call' });
  });

  it('notify_only policy emits event but does not abort', async () => {
    const emittedEvents: unknown[] = [];
    const ctx = makeCtx({
      stuckConfig: { maxTurns: 200, stuckAbortPolicy: 'notify_only', noProgressAbortEnabled: false, stuckRepeatThreshold: 3 },
      emitter: { emit: (e: unknown) => emittedEvents.push(e) } as unknown as TurnEndSubscriberContext['emitter'],
    });
    ctx.state.lastNToolCalls = [
      { toolName: 'Bash', argsSummary: 'ls' },
      { toolName: 'Bash', argsSummary: 'ls' },
      { toolName: 'Bash', argsSummary: 'ls' },
    ];

    const subscriber = buildTurnEndSubscriber(ctx);
    await subscriber(makeTurnEndEvent());

    // Event emitted but agent NOT aborted
    const stuckEvt = emittedEvents.find((e) => (e as { kind?: string }).kind === 'agent_stuck');
    expect(stuckEvt).toBeDefined();
    expect(ctx.agent.abort).not.toHaveBeenCalled();
    expect(ctx.state.terminalSignal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: no_progress detection (disabled by default)
// ---------------------------------------------------------------------------

describe('buildTurnEndSubscriber -- no_progress detection', () => {
  it('does not abort when noProgressAbortEnabled is false (default)', async () => {
    const ctx = makeCtx({
      stuckConfig: { maxTurns: 10, stuckAbortPolicy: 'abort', noProgressAbortEnabled: false, stuckRepeatThreshold: 3 },
    });
    // 80% of 10 = 8 turns with 0 advances
    ctx.state.turnCount = 7; // becomes 8 after increment
    ctx.state.stepAdvanceCount = 0;

    const subscriber = buildTurnEndSubscriber(ctx);
    await subscriber(makeTurnEndEvent());

    // no_progress fires but noProgressAbortEnabled is false -- no abort
    expect(ctx.agent.abort).not.toHaveBeenCalled();
    expect(ctx.state.terminalSignal).toBeNull();
  });

  it('aborts when noProgressAbortEnabled is true and 80% turns used', async () => {
    const ctx = makeCtx({
      stuckConfig: { maxTurns: 10, stuckAbortPolicy: 'abort', noProgressAbortEnabled: true, stuckRepeatThreshold: 3 },
    });
    ctx.state.turnCount = 7; // becomes 8 after increment (80% of 10)
    ctx.state.stepAdvanceCount = 0;

    const subscriber = buildTurnEndSubscriber(ctx);
    await subscriber(makeTurnEndEvent());

    expect(ctx.agent.abort).toHaveBeenCalled();
    expect(ctx.state.terminalSignal).toEqual({ kind: 'stuck', reason: 'no_progress' });
  });
});

// ---------------------------------------------------------------------------
// Tests: first-writer-wins for terminal signal
// ---------------------------------------------------------------------------

describe('buildTurnEndSubscriber -- terminal signal first-writer-wins', () => {
  it('does not overwrite prior stuck signal with timeout', async () => {
    const ctx = makeCtx({
      stuckConfig: { maxTurns: 3, stuckAbortPolicy: 'abort', noProgressAbortEnabled: false, stuckRepeatThreshold: 3 },
    });
    // Set a prior stuck signal
    setTerminalSignal(ctx.state, { kind: 'stuck', reason: 'stall' });
    ctx.state.turnCount = 2; // would trigger max_turns if signal not set

    const subscriber = buildTurnEndSubscriber(ctx);
    await subscriber(makeTurnEndEvent());

    // max_turns_exceeded checks `terminalSignal === null` -- it was already set, so no overwrite
    expect(ctx.state.terminalSignal).toEqual({ kind: 'stuck', reason: 'stall' });
  });
});
