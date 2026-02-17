import { describe, it, expect } from 'vitest';
import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../src/mcp/types.js';

function ctxWithV2(v2: ToolContext['v2']): ToolContext {
  return {
    workflowService: {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async () => null,
      getNextStep: async () => {
        throw new Error('not used');
      },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    v2,
  };
}

describe('v2 execution preconditions (v2 context gate)', () => {
  it('fails fast when ctx.v2 is null (start_workflow)', async () => {
    const ctx = ctxWithV2(null);
    const res = await handleV2StartWorkflow({ workflowId: 'any' } as any, ctx);

    expect(res.type).toBe('error');
    if (res.type !== 'error') return;
    expect(res.code).toBe('PRECONDITION_FAILED');
    expect(res.message).toContain('v2 tools disabled');
  });

  it('fails fast when ctx.v2 is null (continue_workflow)', async () => {
    const ctx = ctxWithV2(null);
    const res = await handleV2ContinueWorkflow({ intent: 'rehydrate', stateToken: 'invalid-token' } as any, ctx);

    expect(res.type).toBe('error');
    if (res.type !== 'error') return;
    expect(res.code).toBe('PRECONDITION_FAILED');
    expect(res.message).toContain('v2 tools disabled');
  });
});
