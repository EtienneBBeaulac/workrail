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
});
