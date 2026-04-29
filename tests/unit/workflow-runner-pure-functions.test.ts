/**
 * Unit tests for the pure functions extracted from runWorkflow() as part of the
 * functional core / imperative shell refactor.
 *
 * ## Functions tested
 *
 * - `tagToStatsOutcome(tag)` -- exhaustive mapping from WorkflowRunResult._tag to stats string
 * - `buildAgentClient(trigger, apiKey, env)` -- pure model selection / client construction
 * - `evaluateStuckSignals(state, config)` -- pure stuck detection logic
 * - `createSessionState(initialToken)` -- factory for SessionState
 * - `buildSessionContext(trigger, inputs)` -- pure session configuration assembly
 *
 * ## Why pure function tests here (not inline with runWorkflow() tests)
 *
 * These functions are small, well-defined, and testable without mocking the LLM API,
 * filesystem, or WorkRail engine. Isolating them here keeps the tests fast and
 * deterministic. The runWorkflow() integration tests (in other files) cover end-to-end
 * behavior via vi.mock.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpPath } from '../helpers/platform.js';
import {
  tagToStatsOutcome,
  buildAgentClient,
  evaluateStuckSignals,
  createSessionState,
  buildSessionContext,
  buildSessionResult,
  buildAgentCallbacks,
  sidecardLifecycleFor,
  DAEMON_SOUL_DEFAULT,
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  DEFAULT_MAX_TURNS,
} from '../../src/daemon/workflow-runner.js';
import type { SessionState, StuckConfig } from '../../src/daemon/workflow-runner.js';
import type { WorkflowRunResult, WorkflowTrigger } from '../../src/daemon/workflow-runner.js';
import type { ContextBundle } from '../../src/daemon/context-loader.js';

// ── tagToStatsOutcome ─────────────────────────────────────────────────────────
//
// This is the truth table from worktrain-daemon-invariants.md section 1.3.
// Every row must be tested; the assertNever default case is the compile-time
// enforcement for exhaustiveness.

describe('tagToStatsOutcome', () => {
  const cases: Array<{ tag: WorkflowRunResult['_tag']; expected: ReturnType<typeof tagToStatsOutcome> }> = [
    { tag: 'success', expected: 'success' },
    { tag: 'error', expected: 'error' },
    { tag: 'timeout', expected: 'timeout' },
    { tag: 'stuck', expected: 'stuck' },
    // delivery_failed: workflow succeeded; only the POST failed -- record as success.
    // See WorkflowDeliveryFailed and invariants doc section 1.3.
    { tag: 'delivery_failed', expected: 'success' },
  ];

  for (const { tag, expected } of cases) {
    it(`_tag='${tag}' maps to '${expected}'`, () => {
      expect(tagToStatsOutcome(tag)).toBe(expected);
    });
  }
});

// ── buildAgentClient ──────────────────────────────────────────────────────────
//
// Tests model selection and client construction. Uses vi.stubEnv to inject
// fake AWS env vars without touching the real process.env.

describe('buildAgentClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeTrigger(overrides: Partial<WorkflowTrigger> = {}): WorkflowTrigger {
    return {
      workflowId: 'wr.coding-task',
      goal: 'test',
      workspacePath: tmpPath('test-workspace'),
      ...overrides,
    };
  }

  it('returns Bedrock client when AWS_PROFILE is set and no model override', () => {
    vi.stubEnv('AWS_PROFILE', 'my-profile');
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    const { agentClient, modelId } = buildAgentClient(makeTrigger(), 'sk-test', process.env);
    expect(agentClient.constructor.name).toBe('AnthropicBedrock');
    expect(modelId).toBe('us.anthropic.claude-sonnet-4-6');
  });

  it('returns Bedrock client when AWS_ACCESS_KEY_ID is set and no model override', () => {
    vi.stubEnv('AWS_PROFILE', '');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    const { agentClient, modelId } = buildAgentClient(makeTrigger(), 'sk-test', process.env);
    expect(agentClient.constructor.name).toBe('AnthropicBedrock');
    expect(modelId).toBe('us.anthropic.claude-sonnet-4-6');
  });

  it('returns direct Anthropic client when no AWS env vars set and no model override', () => {
    vi.stubEnv('AWS_PROFILE', '');
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    const { agentClient, modelId } = buildAgentClient(makeTrigger(), 'sk-test', process.env);
    expect(agentClient.constructor.name).toBe('Anthropic');
    expect(modelId).toBe('claude-sonnet-4-6');
  });

  it('uses Bedrock when agentConfig.model is "amazon-bedrock/..."', () => {
    const trigger = makeTrigger({ agentConfig: { model: 'amazon-bedrock/claude-sonnet-4-5' } });
    vi.stubEnv('AWS_PROFILE', '');
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    const { agentClient, modelId } = buildAgentClient(trigger, 'sk-test', process.env);
    expect(agentClient.constructor.name).toBe('AnthropicBedrock');
    expect(modelId).toBe('claude-sonnet-4-5');
  });

  it('uses direct Anthropic when agentConfig.model is "anthropic/..."', () => {
    const trigger = makeTrigger({ agentConfig: { model: 'anthropic/claude-3-haiku-20240307' } });
    vi.stubEnv('AWS_PROFILE', '');
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    const { agentClient, modelId } = buildAgentClient(trigger, 'sk-test', process.env);
    expect(agentClient.constructor.name).toBe('Anthropic');
    expect(modelId).toBe('claude-3-haiku-20240307');
  });

  it('throws with a clear message when model format has no slash', () => {
    const trigger = makeTrigger({ agentConfig: { model: 'badformat-no-slash' } });
    expect(() => buildAgentClient(trigger, 'sk-test', process.env)).toThrow(
      'agentConfig.model must be in "provider/model-id" format',
    );
  });

  it('uses the part after the first slash as modelId when multiple slashes present', () => {
    const trigger = makeTrigger({ agentConfig: { model: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6' } });
    vi.stubEnv('AWS_PROFILE', '');
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    const { modelId } = buildAgentClient(trigger, 'sk-test', process.env);
    expect(modelId).toBe('us.anthropic.claude-sonnet-4-6');
  });
});

// ── createSessionState ────────────────────────────────────────────────────────

describe('createSessionState', () => {
  it('initializes with the provided token and all defaults', () => {
    const state = createSessionState('ct_initial_token');
    expect(state.currentContinueToken).toBe('ct_initial_token');
    expect(state.isComplete).toBe(false);
    expect(state.lastStepNotes).toBeUndefined();
    expect(state.lastStepArtifacts).toBeUndefined();
    expect(state.workrailSessionId).toBeNull();
    expect(state.stepAdvanceCount).toBe(0);
    expect(state.lastNToolCalls).toEqual([]);
    expect(state.issueSummaries).toEqual([]);
    expect(state.pendingSteerParts).toEqual([]);
    expect(state.stuckReason).toBeNull();
    expect(state.timeoutReason).toBeNull();
    expect(state.turnCount).toBe(0);
  });

  it('creates independent instances (no shared state)', () => {
    const state1 = createSessionState('token1');
    const state2 = createSessionState('token2');
    state1.stepAdvanceCount = 5;
    expect(state2.stepAdvanceCount).toBe(0);
    state1.pendingSteerParts.push('hello');
    expect(state2.pendingSteerParts).toEqual([]);
  });
});

// ── evaluateStuckSignals ─────────────────────────────────────────────────────

/** Helper to make a Readonly<SessionState> for evaluation tests. */
function makeState(overrides: Partial<SessionState> = {}): Readonly<SessionState> {
  return Object.freeze({
    ...createSessionState('ct_test'),
    ...overrides,
  });
}

/** Default config: maxTurns=100, abort policy, no noProgress, threshold=3. */
function makeConfig(overrides: Partial<StuckConfig> = {}): StuckConfig {
  return {
    maxTurns: 100,
    stuckAbortPolicy: 'abort',
    noProgressAbortEnabled: false,
    stuckRepeatThreshold: 3,
    ...overrides,
  };
}

describe('evaluateStuckSignals', () => {
  // ---- max_turns_exceeded ----

  it('returns max_turns_exceeded when turnCount reaches maxTurns and no timeout set', () => {
    const state = makeState({ turnCount: 100, timeoutReason: null });
    const config = makeConfig({ maxTurns: 100 });
    const signal = evaluateStuckSignals(state, config);
    expect(signal?.kind).toBe('max_turns_exceeded');
  });

  it('does not return max_turns_exceeded when turnCount < maxTurns', () => {
    const state = makeState({ turnCount: 99, timeoutReason: null });
    const config = makeConfig({ maxTurns: 100 });
    const signal = evaluateStuckSignals(state, config);
    expect(signal?.kind).not.toBe('max_turns_exceeded');
  });

  it('does not return max_turns_exceeded when timeoutReason is already set', () => {
    const state = makeState({ turnCount: 100, timeoutReason: 'wall_clock' });
    const config = makeConfig({ maxTurns: 100 });
    const signal = evaluateStuckSignals(state, config);
    // Should return timeout_imminent instead (timeoutReason is set)
    expect(signal?.kind).not.toBe('max_turns_exceeded');
  });

  it('does not check max_turns when maxTurns is 0', () => {
    const state = makeState({ turnCount: 9999, timeoutReason: null });
    const config = makeConfig({ maxTurns: 0 });
    const signal = evaluateStuckSignals(state, config);
    expect(signal).toBeNull();
  });

  // ---- repeated_tool_call (Signal 1) ----

  it('returns repeated_tool_call when last 3 calls are identical', () => {
    const repeatCall = { toolName: 'Bash', argsSummary: '{"command":"ls"}' };
    const state = makeState({
      lastNToolCalls: [repeatCall, repeatCall, repeatCall],
      turnCount: 1,
    });
    const signal = evaluateStuckSignals(state, makeConfig());
    expect(signal?.kind).toBe('repeated_tool_call');
    if (signal?.kind === 'repeated_tool_call') {
      expect(signal.toolName).toBe('Bash');
      expect(signal.argsSummary).toBe('{"command":"ls"}');
    }
  });

  it('does not return repeated_tool_call when calls are different', () => {
    const state = makeState({
      lastNToolCalls: [
        { toolName: 'Bash', argsSummary: '{"command":"ls"}' },
        { toolName: 'Bash', argsSummary: '{"command":"pwd"}' },
        { toolName: 'Bash', argsSummary: '{"command":"ls"}' },
      ],
      turnCount: 1,
    });
    const signal = evaluateStuckSignals(state, makeConfig());
    // Should be null (no stuck signal since calls differ)
    expect(signal?.kind).not.toBe('repeated_tool_call');
  });

  it('does not return repeated_tool_call when fewer than threshold calls recorded', () => {
    const repeatCall = { toolName: 'Bash', argsSummary: '{"command":"ls"}' };
    const state = makeState({
      lastNToolCalls: [repeatCall, repeatCall], // only 2, threshold is 3
      turnCount: 1,
    });
    const signal = evaluateStuckSignals(state, makeConfig({ stuckRepeatThreshold: 3 }));
    expect(signal?.kind).not.toBe('repeated_tool_call');
  });

  // ---- no_progress (Signal 2) ----

  it('returns no_progress when >= 80% of turns used with 0 step advances', () => {
    const state = makeState({
      turnCount: 80,
      stepAdvanceCount: 0,
      lastNToolCalls: [], // no repeated tool calls
    });
    const signal = evaluateStuckSignals(state, makeConfig({ maxTurns: 100, noProgressAbortEnabled: true }));
    expect(signal?.kind).toBe('no_progress');
    if (signal?.kind === 'no_progress') {
      expect(signal.turnCount).toBe(80);
      expect(signal.maxTurns).toBe(100);
    }
  });

  it('does not return no_progress when stepAdvanceCount > 0', () => {
    const state = makeState({
      turnCount: 80,
      stepAdvanceCount: 1,
      lastNToolCalls: [],
    });
    const signal = evaluateStuckSignals(state, makeConfig({ maxTurns: 100, noProgressAbortEnabled: true }));
    expect(signal?.kind).not.toBe('no_progress');
  });

  it('does not return no_progress when below 80% threshold', () => {
    const state = makeState({
      turnCount: 79,
      stepAdvanceCount: 0,
      lastNToolCalls: [],
    });
    const signal = evaluateStuckSignals(state, makeConfig({ maxTurns: 100, noProgressAbortEnabled: true }));
    expect(signal?.kind).not.toBe('no_progress');
  });

  // ---- timeout_imminent (Signal 3) ----

  it('returns timeout_imminent when timeoutReason is set', () => {
    const state = makeState({ timeoutReason: 'wall_clock', turnCount: 5, lastNToolCalls: [] });
    const signal = evaluateStuckSignals(state, makeConfig());
    expect(signal?.kind).toBe('timeout_imminent');
    if (signal?.kind === 'timeout_imminent') {
      expect(signal.timeoutReason).toBe('wall_clock');
    }
  });

  it('returns timeout_imminent for max_turns timeoutReason', () => {
    const state = makeState({ timeoutReason: 'max_turns', turnCount: 5, lastNToolCalls: [] });
    const signal = evaluateStuckSignals(state, makeConfig());
    expect(signal?.kind).toBe('timeout_imminent');
    if (signal?.kind === 'timeout_imminent') {
      expect(signal.timeoutReason).toBe('max_turns');
    }
  });

  // ---- null (no signal) ----

  it('returns null when no signals fire', () => {
    const state = makeState({
      turnCount: 5,
      stepAdvanceCount: 2,
      lastNToolCalls: [
        { toolName: 'Bash', argsSummary: '{"command":"ls"}' },
        { toolName: 'Read', argsSummary: '{"filePath":"/foo"}' },
        { toolName: 'Bash', argsSummary: '{"command":"pwd"}' },
      ],
      stuckReason: null,
      timeoutReason: null,
    });
    const signal = evaluateStuckSignals(state, makeConfig());
    expect(signal).toBeNull();
  });

  // ---- Priority: max_turns_exceeded before repeated_tool_call ----
  // WHY: the subscriber returns early on max_turns_exceeded (no steer injection).
  // If we returned repeated_tool_call when max_turns also fired, the subscriber
  // would handle the wrong signal.

  it('returns max_turns_exceeded before repeated_tool_call when both fire', () => {
    const repeatCall = { toolName: 'Bash', argsSummary: '{"command":"ls"}' };
    const state = makeState({
      turnCount: 100,
      timeoutReason: null,
      lastNToolCalls: [repeatCall, repeatCall, repeatCall],
    });
    const signal = evaluateStuckSignals(state, makeConfig({ maxTurns: 100 }));
    expect(signal?.kind).toBe('max_turns_exceeded');
  });

  // ---- no_progress is not gated by noProgressAbortEnabled ----
  // This documents the contract: evaluateStuckSignals() is pure and always returns
  // no_progress when the condition is met. The noProgressAbortEnabled flag is a
  // subscriber concern -- the turn_end subscriber checks it before deciding to abort.
  //
  // WHY both directions are tested: the deleted workflow-runner-stuck-escalation.test.ts
  // had a misleading test name suggesting noProgressAbortEnabled: false meant the pure
  // function would NOT return no_progress. That was wrong. These two tests make the
  // correct contract explicit: the flag is irrelevant to evaluateStuckSignals().

  it('returns no_progress even when noProgressAbortEnabled is false (subscriber is gatekeeper, not this function)', () => {
    // 80%+ of turns used with 0 step advances, flag is OFF.
    // The pure function fires regardless -- the subscriber is the gatekeeper.
    const state = makeState({
      turnCount: 80,
      stepAdvanceCount: 0,
      lastNToolCalls: [],
    });
    const signal = evaluateStuckSignals(state, makeConfig({ maxTurns: 100, noProgressAbortEnabled: false }));
    expect(signal?.kind).toBe('no_progress');
    if (signal?.kind === 'no_progress') {
      expect(signal.turnCount).toBe(80);
      expect(signal.maxTurns).toBe(100);
    }
  });

  it('returns no_progress when noProgressAbortEnabled is true (flag has no effect on pure function)', () => {
    // 80%+ of turns used with 0 step advances, flag is ON.
    // The pure function result is identical to when the flag is OFF.
    // The subscriber uses the flag to decide whether to abort; the pure function does not.
    const state = makeState({
      turnCount: 80,
      stepAdvanceCount: 0,
      lastNToolCalls: [],
    });
    const signal = evaluateStuckSignals(state, makeConfig({ maxTurns: 100, noProgressAbortEnabled: true }));
    expect(signal?.kind).toBe('no_progress');
    if (signal?.kind === 'no_progress') {
      expect(signal.turnCount).toBe(80);
      expect(signal.maxTurns).toBe(100);
    }
  });
});

// ── buildSessionContext ────────────────────────────────────────────────────────
//
// Tests for the pure function that assembles the session configuration from
// pre-loaded I/O results. No I/O is performed in these tests.

/** Helper to build a minimal WorkflowTrigger for buildSessionContext tests. */
function makeSessionTrigger(overrides: Partial<WorkflowTrigger> = {}): WorkflowTrigger {
  return {
    workflowId: 'wr.coding-task',
    goal: 'test goal',
    workspacePath: tmpPath('test-workspace'),
    ...overrides,
  };
}

/**
 * Thin wrapper around buildSessionContext that passes trigger.workspacePath as
 * effectiveWorkspacePath, representing branchStrategy:'none' (no worktree) sessions.
 * WHY a wrapper: avoids threading trigger.workspacePath through every single test call
 * while keeping the required-parameter enforcement on the real function.
 */
function callBuildSessionContext(
  trigger: WorkflowTrigger,
  context: ContextBundle,
  firstStepPrompt: string,
  effectiveWorkspacePath?: string,
): ReturnType<typeof buildSessionContext> {
  return buildSessionContext(trigger, context, firstStepPrompt, effectiveWorkspacePath ?? trigger.workspacePath);
}

/**
 * Helper to build a minimal ContextBundle for buildSessionContext tests.
 *
 * WHY a helper (not inline construction): mirrors the old makeInputs() pattern
 * and keeps tests readable. The ContextBundle shape (workspaceRules, sessionHistory)
 * is slightly more verbose than the old flat SessionContextInputs, so a helper
 * reduces per-test boilerplate.
 */
function makeContextBundle(overrides: {
  soulContent?: string;
  workspaceContext?: string | null;
  sessionNotes?: readonly string[];
} = {}): ContextBundle {
  const soulContent = overrides.soulContent ?? DAEMON_SOUL_DEFAULT;
  const workspaceContext = overrides.workspaceContext !== undefined ? overrides.workspaceContext : null;
  const sessionNotes = overrides.sessionNotes ?? [];
  return {
    soulContent,
    workspaceRules: workspaceContext !== null
      ? [{ source: 'workspace-context', content: workspaceContext, truncated: false }]
      : [],
    sessionHistory: sessionNotes.map((content) => ({ nodeId: '', stepId: '', content })),
  };
}

describe('buildSessionContext', () => {
  // ---- System prompt ----

  it('system prompt contains the soul content', () => {
    const { systemPrompt } = callBuildSessionContext(makeSessionTrigger(), makeContextBundle({
      soulContent: 'custom-soul-content-marker',
    }), 'Step 1: Do the work.');
    expect(systemPrompt).toContain('custom-soul-content-marker');
  });

  it('system prompt contains workspace context when present', () => {
    const { systemPrompt } = callBuildSessionContext(makeSessionTrigger(), makeContextBundle({
      workspaceContext: '## Agent Rules\n- Use TypeScript strict mode',
    }), 'Step 1: Do the work.');
    expect(systemPrompt).toContain('## Workspace Context (from AGENTS.md / CLAUDE.md)');
    expect(systemPrompt).toContain('## Agent Rules');
    expect(systemPrompt).toContain('Use TypeScript strict mode');
  });

  it('system prompt omits workspace context section when workspaceContext is null', () => {
    const { systemPrompt } = callBuildSessionContext(makeSessionTrigger(), makeContextBundle({
      workspaceContext: null,
    }), 'Step 1: Do the work.');
    expect(systemPrompt).not.toContain('## Workspace Context');
  });

  // ---- Initial prompt ----

  it('initial prompt contains the first step prompt', () => {
    const { initialPrompt } = callBuildSessionContext(makeSessionTrigger(), makeContextBundle(),
      'unique-first-step-marker-12345',
    );
    expect(initialPrompt).toContain('unique-first-step-marker-12345');
  });

  it('initial prompt contains trigger context JSON when trigger.context is present', () => {
    const trigger = makeSessionTrigger({
      context: { task: 'implement-oauth', priority: 'high' },
    });
    const { initialPrompt } = callBuildSessionContext(trigger, makeContextBundle(), 'Step 1: Do the work.');
    expect(initialPrompt).toContain('Trigger context:');
    expect(initialPrompt).toContain('"task"');
    expect(initialPrompt).toContain('"implement-oauth"');
    expect(initialPrompt).toContain('"priority"');
    expect(initialPrompt).toContain('"high"');
  });

  it('initial prompt omits context JSON block when trigger.context is absent', () => {
    const trigger = makeSessionTrigger(); // no context field
    const { initialPrompt } = callBuildSessionContext(trigger, makeContextBundle(), 'Step 1: Do the work.');
    expect(initialPrompt).not.toContain('Trigger context:');
  });

  it('initial prompt contains the closing directive to call complete_step', () => {
    const { initialPrompt } = callBuildSessionContext(makeSessionTrigger(), makeContextBundle(), 'Step 1: Do the work.');
    expect(initialPrompt).toContain(
      'Complete all step work, then call complete_step with your notes to advance.',
    );
  });

  it('initial prompt contains reference URL section when referenceUrls is set', () => {
    const trigger = makeSessionTrigger({
      referenceUrls: ['https://example.com/spec.md', 'https://example.com/design.md'],
    });
    // referenceUrls appear in the system prompt, not the initial prompt
    // (they are injected by buildSystemPrompt via trigger.referenceUrls)
    const { systemPrompt } = callBuildSessionContext(trigger, makeContextBundle(), 'Step 1: Do the work.');
    expect(systemPrompt).toContain('## Reference documents');
    expect(systemPrompt).toContain('https://example.com/spec.md');
    expect(systemPrompt).toContain('https://example.com/design.md');
  });

  // ---- Session limits ----

  it('sessionTimeoutMs = trigger.agentConfig.maxSessionMinutes * 60 * 1000 when set', () => {
    const trigger = makeSessionTrigger({
      agentConfig: { maxSessionMinutes: 45 },
    });
    const { sessionTimeoutMs } = callBuildSessionContext(trigger, makeContextBundle(), 'Step 1: Do the work.');
    expect(sessionTimeoutMs).toBe(45 * 60 * 1000);
  });

  it('sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MINUTES * 60 * 1000 when agentConfig absent', () => {
    const trigger = makeSessionTrigger(); // no agentConfig
    const { sessionTimeoutMs } = callBuildSessionContext(trigger, makeContextBundle(), 'Step 1: Do the work.');
    expect(sessionTimeoutMs).toBe(DEFAULT_SESSION_TIMEOUT_MINUTES * 60 * 1000);
  });

  it('maxTurns = trigger.agentConfig.maxTurns when set', () => {
    const trigger = makeSessionTrigger({
      agentConfig: { maxTurns: 50 },
    });
    const { maxTurns } = callBuildSessionContext(trigger, makeContextBundle(), 'Step 1: Do the work.');
    expect(maxTurns).toBe(50);
  });

  it('maxTurns = DEFAULT_MAX_TURNS when agentConfig.maxTurns is absent', () => {
    const trigger = makeSessionTrigger(); // no agentConfig
    const { maxTurns } = callBuildSessionContext(trigger, makeContextBundle(), 'Step 1: Do the work.');
    expect(maxTurns).toBe(DEFAULT_MAX_TURNS);
  });

  // ---- Session recap in system prompt ----

  it('session recap appears in system prompt when sessionNotes is non-empty', () => {
    const { systemPrompt } = callBuildSessionContext(makeSessionTrigger(), makeContextBundle({
      sessionNotes: ['Prior step note: found 3 bugs.', 'Step 2: fixed all 3.'],
    }), 'Step 1: Do the work.');
    // buildSessionRecap wraps notes in <workrail_session_state>
    expect(systemPrompt).toContain('Prior step note: found 3 bugs.');
    expect(systemPrompt).toContain('Step 2: fixed all 3.');
    expect(systemPrompt).toContain('<workrail_session_state>');
  });

  it('assembled context summary appears in system prompt when provided via trigger.context', () => {
    const trigger = makeSessionTrigger({
      context: { assembledContextSummary: 'prior-session-diff-summary' },
    });
    const { systemPrompt } = callBuildSessionContext(trigger, makeContextBundle(), 'Step 1: Do the work.');
    expect(systemPrompt).toContain('## Prior Context');
    expect(systemPrompt).toContain('prior-session-diff-summary');
  });

  // ---- Worktree workspace path injection (Issue #880) ----

  it('system prompt names trigger.workspacePath when sessionWorkspacePath is absent', () => {
    const trigger = makeSessionTrigger();
    const { systemPrompt } = callBuildSessionContext(trigger, makeContextBundle(), 'Step 1.');
    expect(systemPrompt).toContain(`## Workspace: ${trigger.workspacePath}`);
    expect(systemPrompt).not.toContain('Worktree session scope');
  });

  it('system prompt names the worktree path when sessionWorkspacePath differs from trigger.workspacePath', () => {
    const trigger = makeSessionTrigger();
    const worktreePath = '/Users/test/.workrail/worktrees/session-abc123';
    const { systemPrompt } = buildSessionContext(trigger, makeContextBundle(), 'Step 1.', worktreePath);
    expect(systemPrompt).toContain(`## Workspace: ${worktreePath}`);
    expect(systemPrompt).not.toContain(`## Workspace: ${trigger.workspacePath}`);
  });

  it('system prompt adds worktree scope boundary when sessionWorkspacePath differs from trigger.workspacePath', () => {
    const trigger = makeSessionTrigger();
    const worktreePath = '/Users/test/.workrail/worktrees/session-abc123';
    const { systemPrompt } = buildSessionContext(trigger, makeContextBundle(), 'Step 1.', worktreePath);
    expect(systemPrompt).toContain('Worktree session scope');
    expect(systemPrompt).toContain(`Do not access, read, or modify the main checkout at \`${trigger.workspacePath}\``);
  });

  it('does not add worktree scope boundary when sessionWorkspacePath equals trigger.workspacePath', () => {
    const trigger = makeSessionTrigger();
    const { systemPrompt } = callBuildSessionContext(trigger, makeContextBundle(), 'Step 1.');
    expect(systemPrompt).not.toContain('Worktree session scope');
  });

  // ---- Purity guarantee ----

  it('buildSessionContext is a pure function: same inputs always produce the same output', () => {
    const trigger = makeSessionTrigger({
      referenceUrls: ['https://example.com/spec.md'],
      context: { task: 'test' },
      agentConfig: { maxSessionMinutes: 20, maxTurns: 100 },
    });
    const bundle = makeContextBundle({
      soulContent: 'soul-marker',
      workspaceContext: 'workspace-marker',
      sessionNotes: ['prior note'],
    });
    const firstStepPrompt = 'Do the work';

    const result1 = callBuildSessionContext(trigger, bundle, firstStepPrompt);
    const result2 = callBuildSessionContext(trigger, bundle, firstStepPrompt);

    expect(result1.systemPrompt).toBe(result2.systemPrompt);
    expect(result1.initialPrompt).toBe(result2.initialPrompt);
    expect(result1.sessionTimeoutMs).toBe(result2.sessionTimeoutMs);
    expect(result1.maxTurns).toBe(result2.maxTurns);
  });
});

// ── buildAgentCallbacks ───────────────────────────────────────────────────────

describe('buildAgentCallbacks', () => {
  it('returns an object with all five callback keys', () => {
    const state = createSessionState('ct_test');
    const callbacks = buildAgentCallbacks('sess-1', state, 'claude-sonnet-4-6', undefined, 3);
    expect(typeof callbacks.onLlmTurnStarted).toBe('function');
    expect(typeof callbacks.onLlmTurnCompleted).toBe('function');
    expect(typeof callbacks.onToolCallStarted).toBe('function');
    expect(typeof callbacks.onToolCallCompleted).toBe('function');
    expect(typeof callbacks.onToolCallFailed).toBe('function');
  });

  it('onToolCallStarted pushes to state.lastNToolCalls', () => {
    const state = createSessionState('ct_test');
    const callbacks = buildAgentCallbacks('sess-1', state, 'model', undefined, 3);
    callbacks.onToolCallStarted?.({ toolName: 'Bash', argsSummary: '{}' });
    expect(state.lastNToolCalls).toHaveLength(1);
    expect(state.lastNToolCalls[0]).toEqual({ toolName: 'Bash', argsSummary: '{}' });
  });

  it('onToolCallStarted caps ring buffer at stuckRepeatThreshold', () => {
    const state = createSessionState('ct_test');
    const callbacks = buildAgentCallbacks('sess-1', state, 'model', undefined, 3);
    callbacks.onToolCallStarted?.({ toolName: 'A', argsSummary: '1' });
    callbacks.onToolCallStarted?.({ toolName: 'B', argsSummary: '2' });
    callbacks.onToolCallStarted?.({ toolName: 'C', argsSummary: '3' });
    callbacks.onToolCallStarted?.({ toolName: 'D', argsSummary: '4' }); // 4th should evict 1st
    expect(state.lastNToolCalls).toHaveLength(3);
    expect(state.lastNToolCalls[0]?.toolName).toBe('B');
    expect(state.lastNToolCalls[2]?.toolName).toBe('D');
  });
});

// ── buildSessionResult ────────────────────────────────────────────────────────
//
// Tests the four result paths: stuck, timeout, error, success.
// These mirror the truth table from worktrain-daemon-invariants.md invariants 1.1-1.5.

function makeTrigger(overrides: Partial<WorkflowTrigger> = {}): WorkflowTrigger {
  return {
    workflowId: 'wr.coding-task',
    goal: 'test goal',
    workspacePath: tmpPath('workspace'),
    ...overrides,
  };
}

describe('buildSessionResult', () => {
  const SESSION_ID = 'sess_test123';

  it('returns _tag: stuck when stuckReason is set (stuck takes priority over timeout)', () => {
    const state = createSessionState('ct_test');
    state.stuckReason = 'repeated_tool_call';
    state.timeoutReason = 'wall_clock'; // both set -- stuck wins
    const result = buildSessionResult(state, 'stop', undefined, makeTrigger(), SESSION_ID, undefined);
    expect(result._tag).toBe('stuck');
    if (result._tag === 'stuck') {
      expect(result.reason).toBe('repeated_tool_call');
      expect(result.stopReason).toBe('aborted');
    }
  });

  it('stuck result includes issueSummaries when present', () => {
    const state = createSessionState('ct_test');
    state.stuckReason = 'no_progress';
    state.issueSummaries = ['issue 1', 'issue 2'];
    const result = buildSessionResult(state, 'stop', undefined, makeTrigger(), SESSION_ID, undefined);
    expect(result._tag).toBe('stuck');
    if (result._tag === 'stuck') {
      expect(result.issueSummaries).toEqual(['issue 1', 'issue 2']);
    }
  });

  it('returns _tag: timeout when timeoutReason is set and stuckReason is null', () => {
    const state = createSessionState('ct_test');
    state.timeoutReason = 'wall_clock';
    const trigger = makeTrigger({ agentConfig: { maxSessionMinutes: 30 } });
    const result = buildSessionResult(state, 'stop', undefined, trigger, SESSION_ID, undefined);
    expect(result._tag).toBe('timeout');
    if (result._tag === 'timeout') {
      expect(result.reason).toBe('wall_clock');
      expect(result.message).toContain('30 minutes');
      expect(result.stopReason).toBe('aborted');
    }
  });

  it('returns _tag: timeout for max_turns with correct message', () => {
    const state = createSessionState('ct_test');
    state.timeoutReason = 'max_turns';
    const trigger = makeTrigger({ agentConfig: { maxTurns: 100 } });
    const result = buildSessionResult(state, 'stop', undefined, trigger, SESSION_ID, undefined);
    expect(result._tag).toBe('timeout');
    if (result._tag === 'timeout') {
      expect(result.reason).toBe('max_turns');
      expect(result.message).toContain('100 turns');
    }
  });

  it('returns _tag: error when stopReason is error', () => {
    const state = createSessionState('ct_test');
    const result = buildSessionResult(state, 'error', 'agent crashed', makeTrigger(), SESSION_ID, undefined);
    expect(result._tag).toBe('error');
    if (result._tag === 'error') {
      expect(result.message).toBe('agent crashed');
      expect(result.lastStepNotes).toContain('WORKTRAIN_STUCK');
    }
  });

  it('returns _tag: error when errorMessage is set even with stopReason stop', () => {
    const state = createSessionState('ct_test');
    const result = buildSessionResult(state, 'stop', 'unexpected error', makeTrigger(), SESSION_ID, undefined);
    expect(result._tag).toBe('error');
  });

  it('returns _tag: success on clean stop', () => {
    const state = createSessionState('ct_test');
    state.isComplete = true;
    state.lastStepNotes = 'final notes';
    const result = buildSessionResult(state, 'end_turn', undefined, makeTrigger(), SESSION_ID, undefined);
    expect(result._tag).toBe('success');
    if (result._tag === 'success') {
      expect(result.stopReason).toBe('end_turn');
      expect(result.lastStepNotes).toBe('final notes');
    }
  });

  it('success result includes sessionWorkspacePath and sessionId when worktree present', () => {
    const state = createSessionState('ct_test');
    const worktreePath = tmpPath('worktree-abc');
    const result = buildSessionResult(state, 'end_turn', undefined, makeTrigger(), SESSION_ID, worktreePath);
    expect(result._tag).toBe('success');
    if (result._tag === 'success') {
      expect(result.sessionWorkspacePath).toBe(worktreePath);
      expect(result.sessionId).toBe(SESSION_ID);
    }
  });

  it('success result omits sessionWorkspacePath when no worktree', () => {
    const state = createSessionState('ct_test');
    const result = buildSessionResult(state, 'end_turn', undefined, makeTrigger(), SESSION_ID, undefined);
    expect(result._tag).toBe('success');
    if (result._tag === 'success') {
      expect(result.sessionWorkspacePath).toBeUndefined();
      expect(result.sessionId).toBeUndefined();
    }
  });

  it('success result threads botIdentity from trigger', () => {
    const state = createSessionState('ct_test');
    const trigger = makeTrigger({ botIdentity: { name: 'bot', email: 'bot@example.com' } });
    const result = buildSessionResult(state, 'end_turn', undefined, trigger, SESSION_ID, undefined);
    expect(result._tag).toBe('success');
    if (result._tag === 'success') {
      expect(result.botIdentity).toEqual({ name: 'bot', email: 'bot@example.com' });
    }
  });
});

// ── sidecardLifecycleFor ──────────────────────────────────────────────────────
//
// Truth table from worktrain-daemon-invariants.md section 2.2:
//
//   success + worktree  -> retain_for_delivery (TriggerRouter.maybeRunDelivery owns cleanup)
//   success + non-worktree -> delete_now
//   error / timeout / stuck (any branchStrategy) -> delete_now
//   delivery_failed -> assertNever (impossible from runWorkflow(); compile-time guard)
//
// WHY these tests: the function is the authoritative sidecar lifecycle decision.
// If a new WorkflowRunResult variant is added without updating this function,
// the assertNever guard causes a TypeScript compile error -- these tests document
// the contract that the guard enforces.

describe('sidecardLifecycleFor', () => {
  it('success + worktree -> retain_for_delivery', () => {
    expect(sidecardLifecycleFor('success', 'worktree')).toEqual({ kind: 'retain_for_delivery' });
  });

  it('success + none -> delete_now', () => {
    expect(sidecardLifecycleFor('success', 'none')).toEqual({ kind: 'delete_now' });
  });

  it('success + undefined branchStrategy -> delete_now', () => {
    expect(sidecardLifecycleFor('success', undefined)).toEqual({ kind: 'delete_now' });
  });

  it('error + worktree -> delete_now', () => {
    expect(sidecardLifecycleFor('error', 'worktree')).toEqual({ kind: 'delete_now' });
  });

  it('error + none -> delete_now', () => {
    expect(sidecardLifecycleFor('error', 'none')).toEqual({ kind: 'delete_now' });
  });

  it('timeout + worktree -> delete_now', () => {
    expect(sidecardLifecycleFor('timeout', 'worktree')).toEqual({ kind: 'delete_now' });
  });

  it('timeout + none -> delete_now', () => {
    expect(sidecardLifecycleFor('timeout', 'none')).toEqual({ kind: 'delete_now' });
  });

  it('stuck + worktree -> delete_now', () => {
    expect(sidecardLifecycleFor('stuck', 'worktree')).toEqual({ kind: 'delete_now' });
  });

  it('stuck + none -> delete_now', () => {
    expect(sidecardLifecycleFor('stuck', 'none')).toEqual({ kind: 'delete_now' });
  });

  it('delivery_failed -> throws via assertNever (impossible from runWorkflow())', () => {
    // delivery_failed is in WorkflowRunResult but is never produced by runWorkflow() directly
    // (invariant 1.2). assertNever fires if it ever reaches this function.
    expect(() => sidecardLifecycleFor('delivery_failed', 'none')).toThrow();
  });
});
