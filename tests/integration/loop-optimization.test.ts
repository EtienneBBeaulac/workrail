import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTest, teardownTest, resolve } from '../di/test-container.js';
import { DI } from '../../src/di/tokens.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';
import type { WorkflowDefinition } from '../../src/types/workflow.js';
import type { ExecutionState } from '../../src/domain/execution/state.js';
import type { WorkflowEvent } from '../../src/domain/execution/event.js';

function expectOk<T>(result: any): T {
  expect(result.isOk()).toBe(true);
  if (result.isErr()) {
    throw new Error(`Expected Ok but got Err: ${JSON.stringify(result.error)}`);
  }
  return result.value as T;
}

describe('Loop Optimization Integration', () => {
  let storage: InMemoryWorkflowStorage;

  beforeEach(async () => {
    storage = new InMemoryWorkflowStorage();
    await setupTest({ storage });
  });

  afterEach(() => {
    teardownTest();
  });

  describe('Progressive Context Disclosure', () => {
    it('should provide full context on first iteration and minimal on subsequent', async () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test workflow with optimized loop',
        version: '1.0.0',
        steps: [
          {
            id: 'setup',
            title: 'Setup',
            prompt: 'Initialize data'
          },
          {
            id: 'process-loop',
            type: 'loop',
            title: 'Process Items Loop',
            prompt: 'Loop over dataItems',
            loop: {
              type: 'forEach',
              items: 'dataItems',
              itemVar: 'currentDataItem',
              indexVar: 'itemIndex',
              maxIterations: 100
            },
            body: [
              {
                id: 'validate-item',
                title: 'Validate Item',
                prompt: 'Validate {{currentDataItem}} at index {{itemIndex}}'
              },
              {
                id: 'process-item',
                title: 'Process Item',
                prompt: 'Process the validated item'
              }
            ],
            functionDefinitions: [
              {
                name: 'validateFormat',
                definition: 'Check if item matches expected format: { id: string, value: number }'
              }
            ]
          },
          {
            id: 'finish',
            title: 'Finish',
            prompt: 'Complete the workflow'
          }
        ]
      };

      await storage.save(workflow);

      const initialContext = {
        dataItems: [
          { id: 'a', value: 1 },
          { id: 'b', value: 2 },
          { id: 'c', value: 3 }
        ]
      };

      // New contract: state + events (no completedSteps/context optimizer)
      const workflowService = resolve(DI.Services.Workflow);

      let state: ExecutionState = { kind: 'init' };
      let event: WorkflowEvent | undefined = undefined;

      // 1) setup
      const r1 = await workflowService.getNextStep('test-workflow', state, event, initialContext);
      const v1 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(r1);
      expect(v1.next?.step.id).toBe('setup');
      state = v1.state;

      // 2) complete setup -> first loop body step (iteration 1)
      event = { kind: 'step_completed', stepInstanceId: v1.next!.stepInstanceId };
      const r2 = await workflowService.getNextStep('test-workflow', state, event, initialContext);
      const v2 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(r2);
      expect(v2.next?.step.id).toBe('validate-item');
      expect(v2.next?.guidance.prompt).toContain('## Loop Context');
      expect(v2.next?.guidance.prompt).toContain('Iteration: 1');
      state = v2.state;

      // 3) complete validate-item -> process-item (still iteration 1)
      event = { kind: 'step_completed', stepInstanceId: v2.next!.stepInstanceId };
      const r3 = await workflowService.getNextStep('test-workflow', state, event, initialContext);
      const v3 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(r3);
      expect(v3.next?.step.id).toBe('process-item');
      state = v3.state;

      // 4) complete process-item -> validate-item again (iteration 2)
      event = { kind: 'step_completed', stepInstanceId: v3.next!.stepInstanceId };
      const r4 = await workflowService.getNextStep('test-workflow', state, event, initialContext);
      const v4 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(r4);
      expect(v4.next?.step.id).toBe('validate-item');
      expect(v4.next?.guidance.prompt).toContain('## Loop Context');
      expect(v4.next?.guidance.prompt).toContain('Iteration: 2');
    });

    it('should skip empty loops entirely', async () => {
      const workflow: WorkflowDefinition = {
        id: 'empty-loop-workflow',
        name: 'Empty Loop Workflow',
        description: 'Test skipping empty loops',
        version: '1.0.0',
        steps: [
          {
            id: 'start',
            title: 'Start',
            prompt: 'Starting workflow'
          },
          {
            id: 'empty-loop',
            type: 'loop',
            title: 'Process Empty Array',
            prompt: 'Loop over emptyArray',
            loop: {
              type: 'forEach',
              items: 'emptyArray',
              maxIterations: 100
            },
            body: [
              {
              id: 'never-executed',
              title: 'Never Executed',
              prompt: 'This should never run'
              }
            ]
          },
          {
            id: 'end',
            title: 'End',
            prompt: 'Workflow complete'
          }
        ]
      };

      await storage.save(workflow);

      const context = {
        emptyArray: []
      };

      const workflowService = resolve(DI.Services.Workflow);
      let state: ExecutionState = { kind: 'init' };

      const r1 = await workflowService.getNextStep('empty-loop-workflow', state, undefined, context);
      const v1 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(r1);
      expect(v1.next?.step.id).toBe('start');
      state = v1.state;

      const r2 = await workflowService.getNextStep(
        'empty-loop-workflow',
        state,
        { kind: 'step_completed', stepInstanceId: v1.next!.stepInstanceId },
        context
      );
      const v2 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(r2);
      expect(v2.next?.step.id).toBe('end');
    });

    it('treats skipped body steps as completed iterations', async () => {
      const workflow: WorkflowDefinition = {
        id: 'skip-body-loop-workflow',
        name: 'Skip Body Loop Workflow',
        description: 'Test that iterations still advance when body steps are ineligible',
        version: '1.0.0',
        steps: [
          {
            id: 'start',
            title: 'Start',
            prompt: 'Starting workflow',
          },
          {
            id: 'skip-loop',
            type: 'loop',
            title: 'Skip Body Loop',
            prompt: 'Loop where body never becomes eligible',
            loop: {
              type: 'for',
              count: 2,
              maxIterations: 10,
            },
            body: [
              {
                id: 'never-executed',
                title: 'Never Executed',
                prompt: 'This should never run',
                runCondition: { var: 'doWork', equals: true },
              },
            ],
          },
          {
            id: 'end',
            title: 'End',
            prompt: 'Workflow complete',
          },
        ],
      };

      await storage.save(workflow);

      const context = { doWork: false };
      const workflowService = resolve(DI.Services.Workflow);
      let state: ExecutionState = { kind: 'init' };

      const r1 = await workflowService.getNextStep('skip-body-loop-workflow', state, undefined, context);
      const v1 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(r1);
      expect(v1.next?.step.id).toBe('start');
      state = v1.state;

      const r2 = await workflowService.getNextStep(
        'skip-body-loop-workflow',
        state,
        { kind: 'step_completed', stepInstanceId: v1.next!.stepInstanceId },
        context
      );
      const v2 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(r2);
      expect(v2.next?.step.id).toBe('end');
    });
  });

  describe('Context Size Reduction', () => {
    it('should return step with loop context for forEach loops', async () => {
      const workflow: WorkflowDefinition = {
        id: 'size-test-workflow',
        name: 'Size Test Workflow',
        description: 'Test context handling in loops',
        version: '1.0.0',
        steps: [
          {
            id: 'setup-step',
            title: 'Setup Step',
            prompt: 'Setup before loop'
          },
          {
            id: 'large-loop',
            type: 'loop',
            title: 'Process Large Dataset',
            prompt: 'Loop over largeDataset',
            loop: {
              type: 'forEach',
              items: 'largeDataset',
              maxIterations: 200
            },
            body: [
              {
              id: 'process',
              title: 'Process Item',
              prompt: 'Process {{currentItem}}'
              }
            ]
          }
        ]
      };

      await storage.save(workflow);

      // Create a small dataset for this test
      const largeDataset = Array(3).fill(null).map((_, i) => ({
        id: i,
        data: 'test-data'
      }));

      const context = { largeDataset };

      const workflowService = resolve(DI.Services.Workflow);
      let state: ExecutionState = { kind: 'init' };

      const first = await workflowService.getNextStep('size-test-workflow', state, undefined, context);
      const v1 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(first);
      expect(v1.next?.step.id).toBe('setup-step');
      state = v1.state;

      const second = await workflowService.getNextStep(
        'size-test-workflow',
        state,
        { kind: 'step_completed', stepInstanceId: v1.next!.stepInstanceId },
        context
      );
      const v2 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(second);
      expect(v2.next?.guidance.prompt).toContain('## Loop Context');
    });
  });

  describe('Function DSL Integration', () => {
    it('should support function definitions in workflows', async () => {
      const workflow: WorkflowDefinition = {
        id: 'dsl-workflow',
        name: 'DSL Workflow',
        description: 'Test function DSL',
        version: '1.0.0',
        functionDefinitions: [
          {
            name: 'globalValidate',
            definition: 'Validates any item against global rules'
          }
        ],
        steps: [
          {
            id: 'use-functions',
            title: 'Use Functions',
            prompt: 'Apply validation using functions',
            functionReferences: ['globalValidate()']
          }
        ]
      };

      await storage.save(workflow);

      const workflowService = resolve(DI.Services.Workflow);
      const result = await workflowService.getNextStep('dsl-workflow', { kind: 'init' }, undefined, {});
      const v1 = expectOk<{ state: ExecutionState; next: any | null; isComplete: boolean }>(result);
      expect(v1.next?.step.id).toBe('use-functions');
      expect(v1.next?.step.functionReferences).toContain('globalValidate()');
      
      // Workflow should have function definitions
      expect(workflow.functionDefinitions).toHaveLength(1);
      expect(workflow.functionDefinitions[0]?.name).toBe('globalValidate');
    });
  });
});