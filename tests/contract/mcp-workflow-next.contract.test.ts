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

  it('loop exits naturally when maxIterations bound is reached', async () => {
    // Lock: maxIterations is a count; allowed iterations are 0..(maxIterations-1).
    // Test: create a loop with count=5 but maxIterations=2; loop should only run iterations 0 and 1.
    const wf = buildLoopWorkflow('loop-max', 5, 2); // count=5 but max=2 (bound is enforced)
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

    // Iteration 0
    const r1 = await handleWorkflowNext(
      { workflowId: 'loop-max', state: initialExecutionState(), event: undefined, context: {} },
      ctx
    );
    expect(r1.type).toBe('success');
    const step1 = (r1 as any).data.next.stepInstanceId;

    // Complete iteration 0; shouldContinueLoop checks: next iteration (1) < maxIterations (2) → continue
    const r2 = await handleWorkflowNext(
      { workflowId: 'loop-max', state: (r1 as any).data.state, event: { kind: 'step_completed', stepInstanceId: step1 }, context: {} },
      ctx
    );
    expect(r2.type).toBe('success');
    const step2 = (r2 as any).data.next.stepInstanceId;

    // Complete iteration 1; shouldContinueLoop checks: next iteration (2) < maxIterations (2) → false → exit
    const r3 = await handleWorkflowNext(
      { workflowId: 'loop-max', state: (r2 as any).data.state, event: { kind: 'step_completed', stepInstanceId: step2 }, context: {} },
      ctx
    );
    // Loop should exit naturally because maxIterations=2 allows only iterations 0 and 1
    expect(r3.type).toBe('success');
    expect((r3 as any).data.isComplete).toBe(true);
  });
});
