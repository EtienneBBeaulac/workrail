/**
 * Unit tests for runner/agent-loop-runner.ts -- runAgentLoop
 *
 * Focuses on: wall-clock timeout, successful completion, error/abort paths,
 * conversation flush in finally, and handle disposal.
 */

import { tmpPath } from '../helpers/platform.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgentLoop } from '../../src/daemon/runner/agent-loop-runner.js';
import { createSessionState, setTerminalSignal } from '../../src/daemon/state/index.js';
import type { AgentLoop, AgentEvent } from '../../src/daemon/agent-loop.js';
import type { AgentReadySession } from '../../src/daemon/runner/runner-types.js';
import type { WorkflowTrigger } from '../../src/daemon/types.js';
import type { SessionContext } from '../../src/daemon/core/session-context.js';
import type { SessionScope } from '../../src/daemon/session-scope.js';
import type { SessionHandle } from '../../src/daemon/active-sessions.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrigger(overrides: Partial<WorkflowTrigger> = {}): WorkflowTrigger {
  return { workflowId: 'wr.test', goal: 'test goal', workspacePath: tmpPath('ws'), ...overrides };
}

function makeSessionCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    systemPrompt: 'system prompt',
    initialPrompt: 'initial prompt',
    sessionTimeoutMs: 30_000,
    maxTurns: 200,
    stallTimeoutMs: 120_000,
    ...overrides,
  };
}

function makeScope(emitter?: SessionScope['emitter']): SessionScope {
  return {
    fileTracker: {} as never,
    onAdvance: vi.fn(),
    onComplete: vi.fn(),
    onTokenUpdate: vi.fn(),
    onIssueReported: vi.fn(),
    onSteer: vi.fn(),
    getCurrentToken: vi.fn(() => 'ct_test'),
    sessionWorkspacePath: tmpPath('ws'),
    spawnCurrentDepth: 0,
    spawnMaxDepth: 3,
    workrailSessionId: 'sess_test',
    emitter,
    sessionId: 'local-sess',
    workflowId: 'wr.test',
    activeSessionSet: undefined,
  };
}

function makeAgent(overrides: {
  promptFn?: () => Promise<void>;
  messages?: unknown[];
} = {}): AgentLoop {
  const messages: unknown[] = overrides.messages ?? [
    { role: 'user', content: 'initial', timestamp: Date.now() },
    { role: 'assistant', stopReason: 'end_turn', content: [] },
  ];
  return {
    abort: vi.fn(),
    steer: vi.fn(),
    subscribe: vi.fn((listener: (e: AgentEvent) => Promise<void> | void) => {
      // Store listener for manual firing in tests
      (makeAgent as unknown as { _listener?: typeof listener })._listener = listener;
      return () => {};
    }),
    prompt: overrides.promptFn ?? vi.fn(async () => {}),
    state: { messages },
  } as unknown as AgentLoop;
}

function makeHandle(): SessionHandle {
  return {
    sessionId: 'sess_test',
    steer: vi.fn(),
    setAgent: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeSession(overrides: Partial<AgentReadySession> = {}): AgentReadySession {
  const state = createSessionState('ct_test');
  const agent = makeAgent();
  const handle = makeHandle();
  return {
    preAgentSession: {
      sessionId: 'local-sess',
      workrailSessionId: 'sess_test',
      continueToken: 'ct_test',
      checkpointToken: null,
      sessionWorkspacePath: tmpPath('ws'),
      sessionWorktreePath: undefined,
      firstStepPrompt: 'Step 1',
      state,
      spawnCurrentDepth: 0,
      spawnMaxDepth: 3,
      readFileState: new Map(),
      agentClient: {} as never,
      modelId: 'claude-test',
      startMs: Date.now(),
      handle,
    },
    contextBundle: {} as never,
    scope: makeScope(),
    tools: [],
    sessionCtx: makeSessionCtx(),
    handle,
    sessionId: 'local-sess',
    workflowId: 'wr.test',
    worktreePath: undefined,
    agent,
    stuckRepeatThreshold: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: successful completion
// ---------------------------------------------------------------------------

describe('runAgentLoop -- successful completion', () => {
  it('returns completed with stopReason when agent finishes cleanly', async () => {
    const agent = makeAgent();
    const session = makeSession({ agent });

    const outcome = await runAgentLoop(session, makeTrigger(), tmpPath('conversation.jsonl'));

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.stopReason).toBe('end_turn');
    }
  });

  it('calls handle.dispose() in finally block', async () => {
    const handle = makeHandle();
    const session = makeSession({ handle });

    await runAgentLoop(session, makeTrigger(), tmpPath('conversation.jsonl'));

    expect(handle.dispose).toHaveBeenCalled();
  });

  it('disposes handle even when agent throws', async () => {
    const handle = makeHandle();
    const agent = makeAgent({ promptFn: async () => { throw new Error('API error'); } });
    const session = makeSession({ agent, handle });

    const outcome = await runAgentLoop(session, makeTrigger(), tmpPath('conversation.jsonl'));

    expect(handle.dispose).toHaveBeenCalled();
    expect(outcome.kind).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// Tests: error / abort paths
// ---------------------------------------------------------------------------

describe('runAgentLoop -- error paths', () => {
  it('returns aborted when agent.prompt() throws', async () => {
    const agent = makeAgent({ promptFn: async () => { throw new Error('API failure'); } });
    const session = makeSession({ agent });

    const outcome = await runAgentLoop(session, makeTrigger(), tmpPath('conversation.jsonl'));

    expect(outcome.kind).toBe('aborted');
    if (outcome.kind === 'aborted') {
      expect(outcome.errorMessage).toContain('API failure');
    }
  });

  it('calls agent.abort() when timeout fires', async () => {
    vi.useFakeTimers();
    try {
      const agent = makeAgent({ promptFn: () => new Promise(() => {}) }); // never resolves
      const session = makeSession({
        agent,
        sessionCtx: makeSessionCtx({ sessionTimeoutMs: 100 }),
      });

      const outcomePromise = runAgentLoop(session, makeTrigger(), tmpPath('conversation.jsonl'));
      await vi.runAllTimersAsync();
      const outcome = await outcomePromise;

      expect(agent.abort).toHaveBeenCalled();
      expect(outcome.kind).toBe('aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sets terminalSignal to timeout/wall_clock when timer fires', async () => {
    vi.useFakeTimers();
    try {
      const state = createSessionState('ct_test');
      const agent = makeAgent({ promptFn: () => new Promise(() => {}) });
      const handle = makeHandle();
      const session = makeSession({
        agent, handle,
        preAgentSession: {
          sessionId: 'local', workrailSessionId: 'sess_t', continueToken: 'ct_t',
          checkpointToken: null, sessionWorkspacePath: tmpPath('runner-test'), sessionWorktreePath: undefined,
          firstStepPrompt: '', state, spawnCurrentDepth: 0, spawnMaxDepth: 3,
          readFileState: new Map(), agentClient: {} as never, modelId: 'test', startMs: Date.now(), handle,
        },
        sessionCtx: makeSessionCtx({ sessionTimeoutMs: 100 }),
      });

      const outcomePromise = runAgentLoop(session, makeTrigger(), tmpPath('conversation.jsonl'));
      await vi.runAllTimersAsync();
      await outcomePromise;

      expect(state.terminalSignal).toEqual({ kind: 'timeout', reason: 'wall_clock' });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: stuck detection integration
// ---------------------------------------------------------------------------

describe('runAgentLoop -- stuck detection via stuckConfig', () => {
  it('stuckConfig respects trigger agentConfig.stuckAbortPolicy', async () => {
    // notify_only means stuck fires but agent is not aborted by subscriber
    const state = createSessionState('ct_test');
    const agent = makeAgent({
      messages: [
        { role: 'user', content: 'prompt', timestamp: Date.now() },
        { role: 'assistant', stopReason: 'end_turn', content: [] },
      ],
    });
    const session = makeSession({
      agent,
      preAgentSession: {
        sessionId: 'local', workrailSessionId: 'sess_t', continueToken: 'ct_t',
        checkpointToken: null, sessionWorkspacePath: tmpPath('runner-test'), sessionWorktreePath: undefined,
        firstStepPrompt: '', state, spawnCurrentDepth: 0, spawnMaxDepth: 3,
        readFileState: new Map(), agentClient: {} as never, modelId: 'test', startMs: Date.now(),
      },
    });

    const outcome = await runAgentLoop(
      session,
      makeTrigger({ agentConfig: { stuckAbortPolicy: 'notify_only' } }),
      tmpPath('conv.jsonl'),
    );

    // Should complete normally (no abort triggered by subscriber for notify_only)
    expect(outcome.kind).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Tests: extracts stopReason from last assistant message
// ---------------------------------------------------------------------------

describe('runAgentLoop -- stop reason extraction', () => {
  it('uses end_turn from last assistant message', async () => {
    const agent = makeAgent({
      messages: [
        { role: 'user', content: 'initial', timestamp: Date.now() },
        { role: 'assistant', stopReason: 'tool_use', content: [] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: [] }] },
        { role: 'assistant', stopReason: 'end_turn', content: [] },
      ],
    });
    const session = makeSession({ agent });

    const outcome = await runAgentLoop(session, makeTrigger(), tmpPath('conversation.jsonl'));

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.stopReason).toBe('end_turn');
    }
  });

  it('returns stop as default when no assistant message found', async () => {
    const agent = makeAgent({
      messages: [{ role: 'user', content: 'only user message', timestamp: Date.now() }],
    });
    const session = makeSession({ agent });

    const outcome = await runAgentLoop(session, makeTrigger(), tmpPath('conversation.jsonl'));

    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.stopReason).toBe('stop');
    }
  });
});
