import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupIntegrationTest, teardownIntegrationTest, resolveService } from '../di/integration-container';
import { DI } from '../../src/di/tokens.js';
import type { ToolContext } from '../../src/mcp/types.js';
import { handleWorkflowNext } from '../../src/mcp/handlers/workflow.js';
import { initialExecutionState } from '../../src/domain/execution/state.js';
import type { WorkflowEvent } from '../../src/domain/execution/event.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';
import type { WorkflowDefinition } from '../../src/types/workflow-definition.js';

function buildLoopWorkflow(workflowId: string, count: number, maxIterations: number): WorkflowDefinition {
  return {
    id: workflowId,
    name: 'Loop Contract Test',
    description: 'Validates MCP workflow_next state+event contract',
    version: '1.0.0',
    steps: [
      {
        id: 'loop',
        type: 'loop',
        title: 'Loop',
        prompt: 'Loop step',
        loop: { type: 'for', count, maxIterations },
        body: [
          {
            id: 'body',
            title: 'Body',
            prompt: 'Do the body step',
          },
        ],
      },
    ],
  };
}

describe('MCP contract: workflow_next (state + event)', () => {
  beforeEach(async () => {
    const wf = buildLoopWorkflow('loop-contract', 2, 10);
    await setupIntegrationTest({
      storage: new InMemoryWorkflowStorage([wf]),
      disableSessionTools: true,
    });
  });

  afterEach(() => teardownIntegrationTest());

  it('advances loop iteration when completing the pending step', async () => {
    const workflowService = resolveService<any>(DI.Services.Workflow);
    const featureFlags = resolveService<any>(DI.Infra.FeatureFlags);

    const ctx: ToolContext = {
      workflowService,
      featureFlags,
      sessionManager: null,
      httpServer: null,
    };

    const r1 = await handleWorkflowNext(
      { workflowId: 'loop-contract', state: initialExecutionState(), event: undefined, context: {} },
      ctx
    );
    expect(r1.type).toBe('success');
    expect((r1 as any).data.next).not.toBeNull();

    const firstStepInstanceId = (r1 as any).data.next.stepInstanceId;
    expect(firstStepInstanceId.stepId).toBe('body');
    expect(firstStepInstanceId.loopPath[0].iteration).toBe(0);

    const event: WorkflowEvent = { kind: 'step_completed', stepInstanceId: firstStepInstanceId };

    const r2 = await handleWorkflowNext(
      { workflowId: 'loop-contract', state: (r1 as any).data.state, event, context: {} },
      ctx
    );
    expect(r2.type).toBe('success');
    expect((r2 as any).data.next).not.toBeNull();

    const secondStepInstanceId = (r2 as any).data.next.stepInstanceId;
    expect(secondStepInstanceId.stepId).toBe('body');
    expect(secondStepInstanceId.loopPath[0].iteration).toBe(1);
  });

  it('rejects invalid events deterministically', async () => {
    const workflowService = resolveService<any>(DI.Services.Workflow);
    const featureFlags = resolveService<any>(DI.Infra.FeatureFlags);

    const ctx: ToolContext = {
      workflowService,
      featureFlags,
      sessionManager: null,
      httpServer: null,
    };

    const r1 = await handleWorkflowNext(
      { workflowId: 'loop-contract', state: initialExecutionState(), event: undefined, context: {} },
      ctx
    );
    expect(r1.type).toBe('success');

    const wrongEvent: WorkflowEvent = {
      kind: 'step_completed',
      stepInstanceId: { stepId: 'not-body', loopPath: [] },
    };

    const r2 = await handleWorkflowNext(
      { workflowId: 'loop-contract', state: (r1 as any).data.state, event: wrongEvent, context: {} },
      ctx
    );

    expect(r2.type).toBe('error');
    expect((r2 as any).code).toBe('VALIDATION_ERROR');
  });

  it('surfaces maxIterations as PRECONDITION_FAILED', async () => {
    const wf = buildLoopWorkflow('loop-max', 2, 1);
    await setupIntegrationTest({
      storage: new InMemoryWorkflowStorage([wf]),
      disableSessionTools: true,
    });

    const workflowService = resolveService<any>(DI.Services.Workflow);
    const featureFlags = resolveService<any>(DI.Infra.FeatureFlags);

    const ctx: ToolContext = {
      workflowService,
      featureFlags,
      sessionManager: null,
      httpServer: null,
    };

    const r1 = await handleWorkflowNext(
      { workflowId: 'loop-max', state: initialExecutionState(), event: undefined, context: {} },
      ctx
    );
    expect(r1.type).toBe('success');

    const stepInstanceId = (r1 as any).data.next.stepInstanceId;
    const event: WorkflowEvent = { kind: 'step_completed', stepInstanceId };

    const r2 = await handleWorkflowNext(
      { workflowId: 'loop-max', state: (r1 as any).data.state, event, context: {} },
      ctx
    );
    expect(r2.type).toBe('error');
    expect((r2 as any).code).toBe('PRECONDITION_FAILED');
  });
});
