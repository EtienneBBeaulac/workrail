/**
 * Unit tests for makeSpawnAgentTool() result mapping in workflow-runner.ts.
 *
 * Strategy: inject a stub runWorkflowFn that returns each WorkflowRunResult
 * variant, and mock executeStartWorkflow to return a successful pre-created
 * session (minimal shape -- only the fields makeSpawnAgentTool reads).
 *
 * WHY stub runWorkflowFn (not vi.mock): runWorkflowFn is an injected parameter
 * on makeSpawnAgentTool, so we can pass a plain function stub without module
 * mocking. This follows the "prefer fakes over mocks" principle.
 *
 * WHY vi.mock for executeStartWorkflow: makeSpawnAgentTool calls
 * executeStartWorkflow() directly (not via injection), so module mocking is
 * required. Same approach as workflow-runner-pre-allocated.test.ts.
 *
 * WHY continueToken is undefined in the fake startResult: makeSpawnAgentTool
 * skips the parseContinueTokenOrFail block when continueToken is empty, so
 * childSessionId is null and ctx.v2 is never accessed. This avoids needing a
 * real V2ToolContext.
 */

import os from 'os';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock variables (hoisted alongside vi.mock) ────────────────────────────────
const { mockExecuteStartWorkflow } = vi.hoisted(() => ({
  mockExecuteStartWorkflow: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────
//
// Mock executeStartWorkflow so no real session store is needed.
vi.mock('../../src/mcp/handlers/v2-execution/start.js', () => ({
  executeStartWorkflow: mockExecuteStartWorkflow,
}));

import { makeSpawnAgentTool } from '../../src/daemon/workflow-runner.js';
import type {
  ChildWorkflowRunResult,
  WorkflowRunSuccess,
  WorkflowRunError,
  WorkflowRunTimeout,
  WorkflowRunStuck,
} from '../../src/daemon/workflow-runner.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Minimal fake V2ToolContext -- ctx.v2 is never accessed in these tests. */
const FAKE_CTX = {} as V2ToolContext;

/** Minimal fake API key. */
const FAKE_API_KEY = 'test-api-key';

/** Minimal fake schemas -- only the SpawnAgentParams key is read. */
const FAKE_SCHEMAS = {
  SpawnAgentParams: {
    type: 'object',
    properties: {
      workflowId: { type: 'string' },
      goal: { type: 'string' },
      workspacePath: { type: 'string' },
    },
    required: ['workflowId', 'goal', 'workspacePath'],
  },
};

/** Minimal spawn_agent tool call params. */
const FAKE_PARAMS = {
  workflowId: 'test-workflow',
  goal: 'do the thing',
  workspacePath: os.tmpdir(),
};

/**
 * Build a fake StartWorkflowResult that makeSpawnAgentTool accepts.
 *
 * WHY continueToken is undefined: makeSpawnAgentTool checks `if (childContinueToken)`
 * before calling parseContinueTokenOrFail. An empty string skips the decode block,
 * so ctx.v2 is never accessed and childSessionId remains null.
 */
function makeFakeStartResult() {
  return {
    isErr: () => false,
    isOk: () => true,
    value: {
      response: {
        continueToken: undefined,
        checkpointToken: undefined,
      },
    },
  };
}

/**
 * Build a stub runWorkflowFn that returns the given ChildWorkflowRunResult.
 * The return type is cast to WorkflowRunResult to satisfy the typeof runWorkflow
 * signature -- this matches the production cast in makeSpawnAgentTool.
 */
function makeRunWorkflowStub(result: ChildWorkflowRunResult): typeof import('../../src/daemon/workflow-runner.js').runWorkflow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async () => result as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('makeSpawnAgentTool() result mapping', () => {
  beforeEach(() => {
    mockExecuteStartWorkflow.mockReturnValue(makeFakeStartResult());
  });

  it('maps success result to outcome: success with lastStepNotes', async () => {
    const successResult: WorkflowRunSuccess = {
      _tag: 'success',
      workflowId: 'test-workflow',
      stopReason: 'completed',
      lastStepNotes: 'Child completed successfully.',
    };

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      makeRunWorkflowStub(successResult),
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('success');
    expect(parsed.notes).toBe('Child completed successfully.');
    expect(parsed.childSessionId).toBeNull();
  });

  it('uses fallback notes when success has no lastStepNotes', async () => {
    const successResult: WorkflowRunSuccess = {
      _tag: 'success',
      workflowId: 'test-workflow',
      stopReason: 'completed',
      lastStepNotes: undefined,
    };

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      makeRunWorkflowStub(successResult),
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('success');
    expect(parsed.notes).toBe('(no notes from child session)');
  });

  it('maps error result to outcome: error with message', async () => {
    const errorResult: WorkflowRunError = {
      _tag: 'error',
      workflowId: 'test-workflow',
      message: 'Child workflow failed: tool threw',
      stopReason: 'tool_failure',
    };

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      makeRunWorkflowStub(errorResult),
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('error');
    expect(parsed.notes).toBe('Child workflow failed: tool threw');
    expect(parsed.childSessionId).toBeNull();
  });

  it('maps timeout result to outcome: timeout with message', async () => {
    const timeoutResult: WorkflowRunTimeout = {
      _tag: 'timeout',
      workflowId: 'test-workflow',
      reason: 'wall_clock',
      message: 'Session exceeded 30 minute limit',
      stopReason: 'aborted',
    };

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      makeRunWorkflowStub(timeoutResult),
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('timeout');
    expect(parsed.notes).toBe('Session exceeded 30 minute limit');
    expect(parsed.childSessionId).toBeNull();
  });

  it('returns outcome: error when depth limit is exceeded (before runWorkflow is called)', async () => {
    // The runWorkflowFn stub should never be called -- depth check is synchronous and early.
    const runWorkflowStub = vi.fn().mockResolvedValue({ _tag: 'success' });

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      3, // currentDepth
      3, // maxDepth -- currentDepth >= maxDepth triggers early return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runWorkflowStub as any,
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('error');
    expect(parsed.childSessionId).toBeNull();
    expect(parsed.notes).toContain('Max spawn depth exceeded');
    expect(runWorkflowStub).not.toHaveBeenCalled();
  });

  it('returns outcome: error when executeStartWorkflow fails', async () => {
    mockExecuteStartWorkflow.mockReturnValue({
      isErr: () => true,
      isOk: () => false,
      error: { kind: 'workflow_not_found' },
    });

    const runWorkflowStub = vi.fn();

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runWorkflowStub as any,
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('error');
    expect(parsed.childSessionId).toBeNull();
    expect(parsed.notes).toContain('Failed to start child workflow');
    expect(runWorkflowStub).not.toHaveBeenCalled();
  });

  it('maps stuck result to outcome: stuck with message and issueSummaries', async () => {
    // Verifies that the stuck branch in makeSpawnAgentTool produces the correct
    // result shape: outcome='stuck', notes from message, and issueSummaries forwarded.
    // The stuck branch is exercised when a child session is aborted by the stuck heuristic.
    const stuckResult: WorkflowRunStuck = {
      _tag: 'stuck',
      workflowId: 'test-workflow',
      reason: 'repeated_tool_call',
      message: 'Child session stuck: repeated_tool_call after 3 identical Bash calls',
      stopReason: 'aborted',
      issueSummaries: ['npm run build failed with exit 1', 'Could not find expected file'],
    };

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      makeRunWorkflowStub(stuckResult),
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('stuck');
    expect(parsed.notes).toBe('Child session stuck: repeated_tool_call after 3 identical Bash calls');
    expect(parsed.childSessionId).toBeNull();
    expect(parsed.issueSummaries).toEqual(['npm run build failed with exit 1', 'Could not find expected file']);
  });

  it('omits issueSummaries from stuck result when child session had no report_issue calls', async () => {
    const stuckResult: WorkflowRunStuck = {
      _tag: 'stuck',
      workflowId: 'test-workflow',
      reason: 'no_progress',
      message: 'Child session stuck: no_progress after 8/10 turns with 0 step advances',
      stopReason: 'aborted',
      // issueSummaries intentionally absent
    };

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      makeRunWorkflowStub(stuckResult),
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('stuck');
    // issueSummaries must be absent (not null, not undefined) when child had none.
    expect(parsed).not.toHaveProperty('issueSummaries');
  });

  it('throws via assertNever when runWorkflow returns delivery_failed -- regression: old code silently mapped this to success', async () => {
    const deliveryFailedResult = {
      _tag: 'delivery_failed' as const,
      workflowId: 'test-workflow',
      stopReason: 'completed',
      deliveryError: 'HTTP POST to callbackUrl failed with 503',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = async () => deliveryFailedResult as any;
    const tool = makeSpawnAgentTool(
      'sess-1', FAKE_CTX, FAKE_API_KEY, 'parent-session-id', 0, 3, stub, FAKE_SCHEMAS,
    );
    await expect(tool.execute('call-1', FAKE_PARAMS)).rejects.toThrow('Unexpected value');
  });

  it('includes artifacts in return value when success has lastStepArtifacts', async () => {
    const artifacts = [{ kind: 'wr.review_verdict', verdict: 'approve' }, { kind: 'wr.summary', text: 'done' }];
    const successResult: WorkflowRunSuccess = {
      _tag: 'success',
      workflowId: 'test-workflow',
      stopReason: 'completed',
      lastStepNotes: 'Reviewed and approved.',
      lastStepArtifacts: artifacts,
    };

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      makeRunWorkflowStub(successResult),
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('success');
    expect(parsed.artifacts).toEqual(artifacts);
  });

  it('omits artifacts key from return value when success has no lastStepArtifacts', async () => {
    const successResult: WorkflowRunSuccess = {
      _tag: 'success',
      workflowId: 'test-workflow',
      stopReason: 'completed',
      lastStepNotes: 'Done.',
      // lastStepArtifacts intentionally absent
    };

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      makeRunWorkflowStub(successResult),
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('success');
    // artifacts key must be absent (not null, not undefined) -- omit-not-null invariant
    expect(parsed).not.toHaveProperty('artifacts');
  });

  it('returns artifacts: [] (not omitted) when lastStepArtifacts is empty array', async () => {
    // WHY this test: the spread guard uses !== undefined (not ?.length), so an empty array
    // is preserved and returned as artifacts: [] rather than omitted. This distinguishes
    // "child produced no artifacts" (undefined) from "child confirmed empty artifacts" ([]).
    const successResult: WorkflowRunSuccess = {
      _tag: 'success',
      workflowId: 'test-workflow',
      stopReason: 'completed',
      lastStepNotes: 'Done.',
      lastStepArtifacts: [],
    };

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      makeRunWorkflowStub(successResult),
      FAKE_SCHEMAS,
    );

    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.outcome).toBe('success');
    // artifacts key must be present with value [] -- [] !== undefined, so the spread fires
    expect(parsed.artifacts).toEqual([]);
  });

  it('threads activeSessionSet through to child runWorkflowFn (F2: child sessions abortable on SIGTERM)', async () => {
    // Verifies that makeSpawnAgentTool passes activeSessionSet to the child runWorkflowFn call.
    // Without this, child sessions created via spawn_agent are invisible to the shutdown handler
    // and cannot be aborted on SIGTERM.
    const { ActiveSessionSet } = await import('../../src/daemon/active-sessions.js');
    const activeSessionSet = new ActiveSessionSet();
    let capturedSessionSet: unknown;

    // The stub captures the activeSessionSet argument (6th positional param of runWorkflow:
    // trigger, ctx, apiKey, daemonRegistry, emitter, activeSessionSet).
    const runWorkflowStub: typeof import('../../src/daemon/workflow-runner.js').runWorkflow = async (
      _trigger,
      _ctx,
      _apiKey,
      _daemonRegistry,
      _emitter,
      capturedSet,
    ) => {
      capturedSessionSet = capturedSet;
      return {
        _tag: 'success',
        workflowId: 'test-workflow',
        stopReason: 'completed',
        lastStepNotes: 'done',
      } as WorkflowRunSuccess;
    };

    const tool = makeSpawnAgentTool(
      'sess-1',
      FAKE_CTX,
      FAKE_API_KEY,
      'parent-session-id',
      0,
      3,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runWorkflowStub as any,
      FAKE_SCHEMAS,
      undefined, // emitter
      activeSessionSet,
    );

    await tool.execute('call-1', FAKE_PARAMS);

    // The activeSessionSet passed to makeSpawnAgentTool MUST be forwarded to the child session.
    expect(capturedSessionSet).toBe(activeSessionSet);
  });
});

// ── Parallel spawn tests ──────────────────────────────────────────────────────

describe('makeSpawnAgentTool() parallel spawn (agents[])', () => {
  beforeEach(() => {
    mockExecuteStartWorkflow.mockReturnValue(makeFakeStartResult());
  });

  function makeParallelParams(count: number) {
    return {
      agents: Array.from({ length: count }, (_, i) => ({
        workflowId: `workflow-${i}`,
        goal: `goal ${i}`,
        workspacePath: os.tmpdir(),
      })),
    };
  }

  it('returns kind: parallel with results array matching input order', async () => {
    const results: ChildWorkflowRunResult[] = [
      { _tag: 'success', workflowId: 'workflow-0', stopReason: 'done', lastStepNotes: 'notes-0' },
      { _tag: 'success', workflowId: 'workflow-1', stopReason: 'done', lastStepNotes: 'notes-1' },
    ];
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowStub = async () => results[callIndex++]! as any;

    const tool = makeSpawnAgentTool('sess-1', FAKE_CTX, FAKE_API_KEY, 'parent', 0, 3, runWorkflowStub, FAKE_SCHEMAS);
    const result = await tool.execute('call-1', makeParallelParams(2));
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.kind).toBe('parallel');
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].outcome).toBe('success');
    expect(parsed.results[0].notes).toBe('notes-0');
    expect(parsed.results[1].outcome).toBe('success');
    expect(parsed.results[1].notes).toBe('notes-1');
  });

  it('returns partial results when one child fails', async () => {
    const childResults: ChildWorkflowRunResult[] = [
      { _tag: 'success', workflowId: 'w0', stopReason: 'done', lastStepNotes: 'ok' },
      { _tag: 'error', workflowId: 'w1', message: 'child failed', stopReason: 'error' },
    ];
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowStub = async () => childResults[callIndex++]! as any;

    const tool = makeSpawnAgentTool('sess-1', FAKE_CTX, FAKE_API_KEY, 'parent', 0, 3, runWorkflowStub, FAKE_SCHEMAS);
    const result = await tool.execute('call-1', makeParallelParams(2));
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.kind).toBe('parallel');
    expect(parsed.results[0].outcome).toBe('success');
    expect(parsed.results[1].outcome).toBe('error');
    expect(parsed.results[1].notes).toBe('child failed');
  });

  it('returns depth error per child when depth limit exceeded', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowStub = async () => ({ _tag: 'success', workflowId: 'w', stopReason: 'done' } as any);

    // currentDepth === maxDepth: depth limit already hit
    const tool = makeSpawnAgentTool('sess-1', FAKE_CTX, FAKE_API_KEY, 'parent', 3, 3, runWorkflowStub, FAKE_SCHEMAS);
    const result = await tool.execute('call-1', makeParallelParams(2));
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.kind).toBe('parallel');
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].outcome).toBe('error');
    expect(parsed.results[0].notes).toContain('Max spawn depth exceeded');
    expect(parsed.results[1].outcome).toBe('error');
    expect(parsed.results[1].notes).toContain('Max spawn depth exceeded');
  });

  it('throws when agents array is empty', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowStub = async () => ({ _tag: 'success', workflowId: 'w', stopReason: 'done' } as any);
    const tool = makeSpawnAgentTool('sess-1', FAKE_CTX, FAKE_API_KEY, 'parent', 0, 3, runWorkflowStub, FAKE_SCHEMAS);

    await expect(tool.execute('call-1', { agents: [] })).rejects.toThrow('spawn_agent: agents must be a non-empty array');
  });

  it('single-spawn result includes kind: single', async () => {
    const successResult: WorkflowRunSuccess = {
      _tag: 'success',
      workflowId: 'test-workflow',
      stopReason: 'done',
      lastStepNotes: 'done',
    };
    const tool = makeSpawnAgentTool('sess-1', FAKE_CTX, FAKE_API_KEY, 'parent', 0, 3, makeRunWorkflowStub(successResult), FAKE_SCHEMAS);
    const result = await tool.execute('call-1', FAKE_PARAMS);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.kind).toBe('single');
    expect(parsed.outcome).toBe('success');
  });

  it('agents form wins when both workflowId and agents are present', async () => {
    const childResults: ChildWorkflowRunResult[] = [
      { _tag: 'success', workflowId: 'w', stopReason: 'done', lastStepNotes: 'parallel' },
    ];
    let callIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowStub = async () => childResults[callIndex++]! as any;

    const tool = makeSpawnAgentTool('sess-1', FAKE_CTX, FAKE_API_KEY, 'parent', 0, 3, runWorkflowStub, FAKE_SCHEMAS);
    // Both forms present -- agents wins
    const params = { workflowId: 'should-be-ignored', goal: 'ignored', workspacePath: os.tmpdir(), ...makeParallelParams(1) };
    const result = await tool.execute('call-1', params);
    const parsed = JSON.parse(result.content[0]!.text as string);

    expect(parsed.kind).toBe('parallel');
    expect(parsed.results).toHaveLength(1);
  });

  it('throws when agents array exceeds maxItems of 10', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowStub = async () => ({ _tag: 'success', workflowId: 'w', stopReason: 'done' } as any);
    const tool = makeSpawnAgentTool('sess-1', FAKE_CTX, FAKE_API_KEY, 'parent', 0, 3, runWorkflowStub, FAKE_SCHEMAS);
    await expect(tool.execute('call-1', makeParallelParams(11))).rejects.toThrow('exceeds maximum of 10');
  });

  it('throws when agents[N].context is not a plain object', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowStub = async () => ({ _tag: 'success', workflowId: 'w', stopReason: 'done' } as any);
    const tool = makeSpawnAgentTool('sess-1', FAKE_CTX, FAKE_API_KEY, 'parent', 0, 3, runWorkflowStub, FAKE_SCHEMAS);
    const params = { agents: [{ workflowId: 'w', goal: 'g', workspacePath: os.tmpdir(), context: 'not-an-object' }] };
    await expect(tool.execute('call-1', params)).rejects.toThrow('agents[0].context must be a plain object');
  });
});

// ── parseParams validation tests ─────────────────────────────────────────────

describe('makeSpawnAgentTool() single-form validation errors', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runWorkflowStub = async () => ({ _tag: 'success', workflowId: 'w', stopReason: 'done' } as any);

  function makeTool() {
    return makeSpawnAgentTool('sess-1', FAKE_CTX, FAKE_API_KEY, 'parent', 0, 3, runWorkflowStub, FAKE_SCHEMAS);
  }

  it('throws when workflowId is missing', async () => {
    await expect(makeTool().execute('call-1', { goal: 'g', workspacePath: os.tmpdir() })).rejects.toThrow('workflowId must be a non-empty string');
  });

  it('throws when workflowId is empty string', async () => {
    await expect(makeTool().execute('call-1', { workflowId: '', goal: 'g', workspacePath: os.tmpdir() })).rejects.toThrow('workflowId must be a non-empty string');
  });

  it('throws when goal is missing', async () => {
    await expect(makeTool().execute('call-1', { workflowId: 'w', workspacePath: os.tmpdir() })).rejects.toThrow('goal must be a non-empty string');
  });

  it('throws when workspacePath is missing', async () => {
    await expect(makeTool().execute('call-1', { workflowId: 'w', goal: 'g' })).rejects.toThrow('workspacePath must be a non-empty string');
  });
});
