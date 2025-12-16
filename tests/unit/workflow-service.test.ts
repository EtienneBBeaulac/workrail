import 'reflect-metadata';
import { describe, vi, it, expect, beforeEach, afterEach, jest } from 'vitest';
import { DefaultWorkflowService } from '../../src/application/services/workflow-service';
import { IWorkflowStorage } from '../../src/types/storage';
import { Workflow, WorkflowSummary, createWorkflow, createBundledSource, WorkflowDefinition } from '../../src/types/workflow';
import { LoopStep } from '../../src/types/workflow-types';
import { ValidationEngine } from '../../src/application/services/validation-engine';
import { EnhancedLoopValidator } from '../../src/application/services/enhanced-loop-validator';
import { IterativeStepResolutionStrategy } from '../../src/application/services/step-resolution/iterative-step-resolution-strategy';
import { DefaultWorkflowLoader } from '../../src/application/services/workflow-loader';
import { DefaultLoopRecoveryService } from '../../src/application/services/loop-recovery-service';
import { LoopStackManager } from '../../src/application/services/loop-stack-manager';
import { DefaultStepSelector } from '../../src/application/services/step-selector';
import { LoopStepResolver } from '../../src/application/services/loop-step-resolver';

const mockWorkflow = createWorkflow({
  id: 'test-workflow',
  name: 'Test Workflow',
  description: 'A workflow for testing.',
      version: '0.0.1',
  steps: [
    { id: 'step1', title: 'Step 1', prompt: 'Prompt for step 1' },
    {
      id: 'step2',
      title: 'Step 2',
      prompt: 'Prompt for step 2',
      guidance: ['Guidance 1 for step 2', 'Guidance 2 for step 2'],
    },
    { id: 'step3', title: 'Step 3', prompt: 'Prompt for step 3' },
  ],
}, createBundledSource());

const mockWorkflowWithAgentRole = createWorkflow({
  id: 'test-workflow-agent-role',
  name: 'Test Workflow with Agent Role',
  description: 'A workflow for testing agentRole functionality.',
  version: '0.0.1',
  steps: [
    { 
      id: 'step1', 
      title: 'Step 1', 
      prompt: 'User-facing prompt for step 1',
      agentRole: 'You are a helpful coding assistant. Focus on best practices.'
    },
    {
      id: 'step2',
      title: 'Step 2',
      prompt: 'User-facing prompt for step 2',
      agentRole: 'Act as a code reviewer. Be thorough and constructive.',
      guidance: ['Check for bugs', 'Verify style guidelines'],
    },
    { 
      id: 'step3', 
      title: 'Step 3', 
      prompt: 'User-facing prompt for step 3'
      // No agentRole - should work normally
    },
    {
      id: 'step4',
      title: 'Step 4',
      prompt: 'User-facing prompt for step 4',
      agentRole: '', // Empty agentRole should be handled gracefully
      guidance: ['Handle empty agentRole']
    },
  ],
}, createBundledSource());

// Helper function to create a workflow service with a mock storage
function createTestWorkflowService(mockStorage: IWorkflowStorage): DefaultWorkflowService {
  const loopValidator = new EnhancedLoopValidator();
  const validator = new ValidationEngine(loopValidator);
  const resolver = new LoopStepResolver();
  const stackManager = new LoopStackManager(resolver);
  const recoveryService = new DefaultLoopRecoveryService(stackManager);
  const stepSelector = new DefaultStepSelector();
  const workflowLoader = new DefaultWorkflowLoader(mockStorage, validator);
  const strategy = new IterativeStepResolutionStrategy(
    workflowLoader,
    recoveryService,
    stackManager,
    stepSelector
  );
  
  return new DefaultWorkflowService(mockStorage, validator, strategy);
}

describe('DefaultWorkflowService', () => {
  let service: DefaultWorkflowService;
  let mockStorage: jest.Mocked<IWorkflowStorage>;

  beforeEach(() => {
    // Clear mocks from previous tests first
    vi.clearAllMocks();
    
    mockStorage = {
      kind: 'single' as const,
      source: createBundledSource(),
      getWorkflowById: vi.fn(),
      listWorkflowSummaries: vi.fn(),
      loadAllWorkflows: vi.fn()
    };
    
    // Default mock implementations - set AFTER clearing mocks
    mockStorage.getWorkflowById.mockImplementation(async (id: string) => {
      if (id === mockWorkflow.definition.id) {
        return mockWorkflow;
      }
      if (id === mockWorkflowWithAgentRole.definition.id) {
        return mockWorkflowWithAgentRole;
      }
      return null;
    });
    
    mockStorage.listWorkflowSummaries.mockResolvedValue([]);
    mockStorage.loadAllWorkflows.mockResolvedValue([mockWorkflow, mockWorkflowWithAgentRole]);
    
    service = createTestWorkflowService(mockStorage);
  });

  describe('getNextStep', () => {
    it('should return the first step if no steps are completed', async () => {
      const result = await service.getNextStep('test-workflow', []);
      expect(result.step?.id).toBe('step1');
      expect(result.guidance.prompt).toBe('Prompt for step 1');
      expect(result.isComplete).toBe(false);
    });

    it('should return the next step based on completed steps', async () => {
      const result = await service.getNextStep('test-workflow', ['step1']);
      expect(result.step?.id).toBe('step2');
    });

    it('should prepend guidance to the prompt if it exists', async () => {
      const result = await service.getNextStep('test-workflow', ['step1']);
      const expectedPrompt =
        '## Step Guidance\n- Guidance 1 for step 2\n- Guidance 2 for step 2\n\nPrompt for step 2';
      expect(result.guidance.prompt).toBe(expectedPrompt);
    });

    it('should not prepend guidance if it does not exist', async () => {
      const result = await service.getNextStep('test-workflow', ['step1', 'step2']);
      expect(result.step?.id).toBe('step3');
      expect(result.guidance.prompt).toBe('Prompt for step 3');
    });

    it('should indicate completion when all steps are done', async () => {
      const result = await service.getNextStep('test-workflow', ['step1', 'step2', 'step3']);
      expect(result.step).toBeNull();
      expect(result.isComplete).toBe(true);
      expect(result.guidance.prompt).toBe('Workflow complete.');
    });
  });

  describe('getNextStep with agentRole', () => {
    it('should include agentRole instructions at the top of guidance prompt', async () => {
      const result = await service.getNextStep('test-workflow-agent-role', []);
      expect(result.step?.id).toBe('step1');
      expect(result.step?.agentRole).toBe('You are a helpful coding assistant. Focus on best practices.');
      
      const expectedPrompt = 
        '## Agent Role Instructions\n' +
        'You are a helpful coding assistant. Focus on best practices.\n\n' +
        'User-facing prompt for step 1';
      expect(result.guidance.prompt).toBe(expectedPrompt);
      expect(result.isComplete).toBe(false);
    });

    it('should include agentRole with guidance when both are present', async () => {
      const result = await service.getNextStep('test-workflow-agent-role', ['step1']);
      expect(result.step?.id).toBe('step2');
      expect(result.step?.agentRole).toBe('Act as a code reviewer. Be thorough and constructive.');
      
      const expectedPrompt = 
        '## Agent Role Instructions\n' +
        'Act as a code reviewer. Be thorough and constructive.\n\n' +
        '## Step Guidance\n' +
        '- Check for bugs\n' +
        '- Verify style guidelines\n\n' +
        'User-facing prompt for step 2';
      expect(result.guidance.prompt).toBe(expectedPrompt);
    });

    it('should work normally for steps without agentRole', async () => {
      const result = await service.getNextStep('test-workflow-agent-role', ['step1', 'step2']);
      expect(result.step?.id).toBe('step3');
      expect(result.step?.agentRole).toBeUndefined();
      expect(result.guidance.prompt).toBe('User-facing prompt for step 3');
      expect(result.guidance.prompt).not.toContain('Agent Role Instructions');
    });

    it('should handle empty agentRole gracefully', async () => {
      const result = await service.getNextStep('test-workflow-agent-role', ['step1', 'step2', 'step3']);
      expect(result.step?.id).toBe('step4');
      expect(result.step?.agentRole).toBe('');
      
      // Empty agentRole should not add the Agent Role Instructions header
      const expectedPrompt = 
        '## Step Guidance\n' +
        '- Handle empty agentRole\n\n' +
        'User-facing prompt for step 4';
      expect(result.guidance.prompt).toBe(expectedPrompt);
      expect(result.guidance.prompt).not.toContain('Agent Role Instructions');
    });

    it('should maintain backward compatibility with existing workflows', async () => {
      // Test that the original workflow still works exactly as before
      const result = await service.getNextStep('test-workflow', []);
      expect(result.step?.id).toBe('step1');
      expect(result.step?.agentRole).toBeUndefined();
      expect(result.guidance.prompt).toBe('Prompt for step 1');
      expect(result.guidance.prompt).not.toContain('Agent Role Instructions');
    });
  });

  describe('getNextStep with loop steps', () => {
    it('should recognize loop steps and initialize loop context', async () => {
      const workflowWithLoop = createWorkflow({
        id: 'loop-workflow',
        name: 'Loop Workflow',
        description: 'Workflow with loops',
        version: '0.1.0',
        steps: [
          { id: 'start', title: 'Start', prompt: 'Starting workflow' },
          {
            id: 'while-loop',
            type: 'loop',
            title: 'While Loop',
            prompt: 'Loop prompt',
            loop: {
              type: 'while',
              condition: { var: 'continueLoop', equals: true },
              maxIterations: 10,
              iterationVar: 'currentIteration'
            },
            body: 'loop-body'
          } as LoopStep,
          { id: 'loop-body', title: 'Loop Body', prompt: 'Process item' },
          { id: 'end', title: 'End', prompt: 'Workflow complete' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithLoop);

      // First call should return start step
      const result1 = await service.getNextStep('loop-workflow', []);
      expect(result1.step?.id).toBe('start');

      // Second call should start the loop
      const result2 = await service.getNextStep('loop-workflow', ['start'], { continueLoop: true });
      expect(result2.step?.id).toBe('loop-body');
      expect(result2.guidance.prompt).toContain('Process item');
      expect(result2.guidance.prompt).toContain('Loop Context');
      expect(result2.guidance.prompt).toContain('Iteration: 1');
    });

    it('should handle while loop iterations correctly', async () => {
      const workflowWithWhile = createWorkflow({
        id: 'while-workflow',
        name: 'While Workflow',
        description: 'Workflow with while loop',
        version: '0.1.0',
        steps: [
          {
            id: 'while-loop',
            type: 'loop',
            title: 'While Loop',
            prompt: 'Loop prompt',
            loop: {
              type: 'while',
              condition: { var: 'counter', lt: 3 },
              maxIterations: 10,
              iterationVar: 'iteration'
            },
            body: 'increment'
          } as LoopStep,
          { 
            id: 'increment', 
            title: 'Increment', 
            prompt: 'Increment counter'
          }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithWhile);

      // First iteration - condition counter(0) < 3 is true
      let context: any = { counter: 0 };
      const result1 = await service.getNextStep('while-workflow', [], context);
      expect(result1.step?.id).toBe('increment');
      expect(result1.guidance.prompt).toContain('Iteration: 1');

      // After first iteration: mark step complete and update counter
      // The new API requires passing completed steps to trigger iteration advancement
      context = { ...(result1.context || context), counter: 1 };
      const result2 = await service.getNextStep('while-workflow', ['increment'], context);
      expect(result2.step?.id).toBe('increment');
      expect(result2.guidance.prompt).toContain('Iteration: 2');

      // After second iteration: counter = 2
      context = { ...(result2.context || context), counter: 2 };
      const result3 = await service.getNextStep('while-workflow', ['increment'], context);
      expect(result3.step?.id).toBe('increment');
      expect(result3.guidance.prompt).toContain('Iteration: 3');

      // After third iteration: counter = 3, condition counter < 3 becomes false
      context = { ...(result3.context || context), counter: 3 };
      const result4 = await service.getNextStep('while-workflow', ['increment'], context);
      // Loop exits, no more steps - workflow complete
      expect(result4.isComplete).toBe(true);
    });

    it('should handle until loop iterations correctly', async () => {
      const workflowWithUntil = createWorkflow({
        id: 'until-workflow',
        name: 'Until Workflow',
        description: 'Workflow with until loop',
        version: '0.1.0',
        steps: [
          {
            id: 'until-loop',
            type: 'loop',
            title: 'Until Loop',
            prompt: 'Loop until condition met',
            loop: {
              type: 'until',
              condition: { var: 'done', equals: true },
              maxIterations: 10,
              iterationVar: 'iteration'
            },
            body: 'check-done'
          } as LoopStep,
          { 
            id: 'check-done', 
            title: 'Check Done', 
            prompt: 'Check if done'
          },
          {
            id: 'final',
            title: 'Final',
            prompt: 'After loop'
          }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithUntil);

      // First iteration - done is false, until condition not met, loop continues
      let context: any = { done: false };
      const result1 = await service.getNextStep('until-workflow', [], context);
      expect(result1.step?.id).toBe('check-done');
      expect(result1.guidance.prompt).toContain('Iteration: 1');

      // Second iteration - still not done, complete previous step
      context = { ...(result1.context || context), done: false };
      const result2 = await service.getNextStep('until-workflow', ['check-done'], context);
      expect(result2.step?.id).toBe('check-done');
      expect(result2.guidance.prompt).toContain('Iteration: 2');

      // Third iteration - mark as done (until condition becomes true)
      context = { ...(result2.context || context), done: true };
      const result3 = await service.getNextStep('until-workflow', ['check-done'], context);
      
      // Should exit loop and go to final step
      expect(result3.step?.id).toBe('final');
    });

    it('should handle for loop with fixed count', async () => {
      const workflowWithFor = createWorkflow({
        id: 'for-workflow',
        name: 'For Workflow',
        description: 'Workflow with for loop',
        version: '0.1.0',
        steps: [
          {
            id: 'for-loop',
            type: 'loop',
            title: 'For Loop',
            prompt: 'Loop 3 times',
            loop: {
              type: 'for',
              count: 3,
              maxIterations: 10,
              iterationVar: 'i'
            },
            body: 'process-item'
          } as LoopStep,
          { 
            id: 'process-item', 
            title: 'Process Item', 
            prompt: 'Process current iteration'
          },
          {
            id: 'done',
            title: 'Done',
            prompt: 'All done'
          }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithFor);

      // First iteration (i=1)
      let context: any = {};
      const result1 = await service.getNextStep('for-workflow', [], context);
      expect(result1.step?.id).toBe('process-item');
      expect(result1.guidance.prompt).toContain('Iteration: 1');
      
      // Second iteration (i=2) - mark previous step complete
      context = result1.context || context;
      const result2 = await service.getNextStep('for-workflow', ['process-item'], context);
      expect(result2.step?.id).toBe('process-item');
      expect(result2.guidance.prompt).toContain('Iteration: 2');
      
      // Third iteration (i=3) - mark previous step complete
      context = result2.context || context;
      const result3 = await service.getNextStep('for-workflow', ['process-item'], context);
      expect(result3.step?.id).toBe('process-item');
      expect(result3.guidance.prompt).toContain('Iteration: 3');

      // After 3 iterations, should move to done
      context = result3.context || context;
      const finalResult = await service.getNextStep('for-workflow', ['process-item'], context);
      expect(finalResult.step?.id).toBe('done');
    });

    it('should handle for loop with variable count', async () => {
      const workflowWithVarFor = createWorkflow({
        id: 'var-for-workflow',
        name: 'Variable For Workflow',
        description: 'Workflow with variable for loop',
        version: '0.1.0',
        steps: [
          {
            id: 'for-loop',
            type: 'loop',
            title: 'For Loop',
            prompt: 'Loop n times',
            loop: {
              type: 'for',
              count: 'repeatCount',
              maxIterations: 10
            },
            body: 'action'
          } as LoopStep,
          { 
            id: 'action', 
            title: 'Action', 
            prompt: 'Do something'
          }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithVarFor);

      // Test with count from context (repeatCount = 2)
      let context: any = { repeatCount: 2 };
      
      // First iteration
      const result1 = await service.getNextStep('var-for-workflow', [], context);
      expect(result1.step?.id).toBe('action');
      expect(result1.guidance.prompt).toContain('Iteration: 1');
      
      // Second iteration - mark previous complete
      context = result1.context || context;
      const result2 = await service.getNextStep('var-for-workflow', ['action'], context);
      expect(result2.step?.id).toBe('action');
      expect(result2.guidance.prompt).toContain('Iteration: 2');
      
      // Should complete after 2 iterations
      context = result2.context || context;
      const result3 = await service.getNextStep('var-for-workflow', ['action'], context);
      expect(result3.isComplete).toBe(true);
    });

    it('should handle forEach loop over array', async () => {
      const workflowWithForEach = createWorkflow({
        id: 'foreach-workflow',
        name: 'ForEach Workflow',
        description: 'Workflow with forEach loop',
        version: '0.1.0',
        steps: [
          {
            id: 'foreach-loop',
            type: 'loop',
            title: 'ForEach Loop',
            prompt: 'Process each item',
            loop: {
              type: 'forEach',
              items: 'itemsToProcess',
              maxIterations: 10,
              itemVar: 'currentItem',
              indexVar: 'currentIndex'
            },
            body: 'process'
          } as LoopStep,
          { 
            id: 'process', 
            title: 'Process', 
            prompt: 'Process the item'
          },
          {
            id: 'summary',
            title: 'Summary',
            prompt: 'Summarize results'
          }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithForEach);

      const items = ['apple', 'banana', 'cherry'];
      let context: any = { itemsToProcess: items };

      // First item (apple)
      const result1 = await service.getNextStep('foreach-workflow', [], context);
      expect(result1.step?.id).toBe('process');
      expect(result1.context?.currentItem).toBe('apple');
      expect(result1.context?.currentIndex).toBe(0);
      
      // Second item (banana) - mark previous complete
      context = result1.context || context;
      const result2 = await service.getNextStep('foreach-workflow', ['process'], context);
      expect(result2.step?.id).toBe('process');
      expect(result2.context?.currentItem).toBe('banana');
      expect(result2.context?.currentIndex).toBe(1);
      
      // Third item (cherry) - mark previous complete
      context = result2.context || context;
      const result3 = await service.getNextStep('foreach-workflow', ['process'], context);
      expect(result3.step?.id).toBe('process');
      expect(result3.context?.currentItem).toBe('cherry');
      expect(result3.context?.currentIndex).toBe(2);

      // After all items, should move to summary
      context = result3.context || context;
      const finalResult = await service.getNextStep('foreach-workflow', ['process'], context);
      expect(finalResult.step?.id).toBe('summary');
    });

    it('should handle forEach with empty array', async () => {
      const workflowWithEmptyForEach = createWorkflow({
        id: 'empty-foreach-workflow',
        name: 'Empty ForEach Workflow',
        description: 'Workflow with empty forEach loop',
        version: '0.1.0',
        steps: [
          {
            id: 'foreach-loop',
            type: 'loop',
            title: 'ForEach Loop',
            prompt: 'Process each item',
            loop: {
              type: 'forEach',
              items: 'emptyList',
              maxIterations: 10
            },
            body: 'process'
          } as LoopStep,
          { 
            id: 'process', 
            title: 'Process', 
            prompt: 'Process the item'
          },
          {
            id: 'no-items',
            title: 'No Items',
            prompt: 'No items to process'
          }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithEmptyForEach);

      // Empty array should skip loop body entirely
      const context = { emptyList: [] };
      const result = await service.getNextStep('empty-foreach-workflow', [], context);
      expect(result.step?.id).toBe('no-items');
    });

    it('should handle forEach with non-array value gracefully', async () => {
      const workflowWithBadForEach = createWorkflow({
        id: 'bad-foreach-workflow',
        name: 'Bad ForEach Workflow',
        description: 'Workflow with bad forEach loop',
        version: '0.1.0',
        steps: [
          {
            id: 'foreach-loop',
            type: 'loop',
            title: 'ForEach Loop',
            prompt: 'Process each item',
            loop: {
              type: 'forEach',
              items: 'notAnArray',
              maxIterations: 10
            },
            body: 'process'
          } as LoopStep,
          { 
            id: 'process', 
            title: 'Process', 
            prompt: 'Process the item'
          },
          {
            id: 'fallback',
            title: 'Fallback',
            prompt: 'Fallback step'
          }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithBadForEach);

      // Non-array value should skip loop and add warning
      const context = { notAnArray: 'not an array' };
      const result = await service.getNextStep('bad-foreach-workflow', [], context);
      expect(result.step?.id).toBe('fallback');
      expect(result.context?._warnings?.loops?.['foreach-loop']).toBeDefined();
      expect(result.context?._warnings?.loops?.['foreach-loop'][0]).toContain('Expected array');
    });

    it('should inject loop variables into context', async () => {
      const workflowWithVars = createWorkflow({
        id: 'vars-workflow',
        name: 'Variables Workflow',
        description: 'Workflow with loop variables',
        version: '0.1.0',
        steps: [
          {
            id: 'var-loop',
            type: 'loop',
            title: 'Variable Loop',
            prompt: 'Loop with variables',
            loop: {
              type: 'while',
              condition: { var: 'shouldContinue', equals: true },
              maxIterations: 5,
              iterationVar: 'loopCount'
            },
            body: 'check-var'
          } as LoopStep,
          { 
            id: 'check-var', 
            title: 'Check Variable', 
            prompt: 'Check loop variable'
          }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithVars);

      // First iteration should have loopCount = 1 (1-based counting)
      const result1 = await service.getNextStep('vars-workflow', [], { shouldContinue: true });
      expect(result1.step?.id).toBe('check-var');
      // Context should have loop variables injected
      expect(result1.context).toHaveProperty('loopCount', 1);
    });

    it('should respect max iterations limit', async () => {
      const workflowWithLimit = createWorkflow({
        id: 'limit-workflow',
        name: 'Limit Workflow',
        description: 'Workflow with iteration limit',
        version: '0.1.0',
        steps: [
          {
            id: 'limited-loop',
            type: 'loop',
            title: 'Limited Loop',
            prompt: 'Loop with limit',
            loop: {
              type: 'while',
              condition: { var: 'alwaysTrue', equals: true },
              maxIterations: 2
            },
            body: 'simple-step'
          } as LoopStep,
          { 
            id: 'simple-step', 
            title: 'Simple Step', 
            prompt: 'Do something'
          }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithLimit);

      // First iteration
      let context: any = { alwaysTrue: true };
      const result1 = await service.getNextStep('limit-workflow', [], context);
      expect(result1.step?.id).toBe('simple-step');
      expect(result1.guidance.prompt).toContain('Iteration: 1');

      // Second iteration - mark previous complete
      context = result1.context || context;
      const result2 = await service.getNextStep('limit-workflow', ['simple-step'], context);
      expect(result2.step?.id).toBe('simple-step');
      expect(result2.guidance.prompt).toContain('Iteration: 2');

      // Should exit after max iterations even though condition is true
      context = result2.context || context;
      const result3 = await service.getNextStep('limit-workflow', ['simple-step'], context);
      expect(result3.isComplete).toBe(true);
    });

    it('should skip loop if initial condition is false', async () => {
      const workflowWithFalseLoop = createWorkflow({
        id: 'false-loop-workflow',
        name: 'False Loop Workflow',
        description: 'Workflow with initially false loop',
        version: '0.1.0',
        steps: [
          {
            id: 'never-loop',
            type: 'loop',
            title: 'Never Loop',
            prompt: 'Should not execute',
            loop: {
              type: 'while',
              condition: { var: 'shouldRun', equals: true },
              maxIterations: 10
            },
            body: 'never-run'
          } as LoopStep,
          { id: 'never-run', title: 'Never Run', prompt: 'Should not execute' },
          { id: 'after-loop', title: 'After Loop', prompt: 'Runs after skipped loop' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithFalseLoop);

      const result = await service.getNextStep('false-loop-workflow', [], { shouldRun: false });
      expect(result.step?.id).toBe('after-loop');
    });

    it('should handle multi-step loop body', async () => {
      const workflowWithMultiStep = createWorkflow({
        id: 'multi-step-workflow',
        name: 'Multi-Step Workflow',
        description: 'Workflow with multi-step loop body',
        version: '0.1.0',
        steps: [
          {
            id: 'multi-loop',
            type: 'loop',
            title: 'Multi-Step Loop',
            prompt: 'Loop with multiple steps',
            loop: {
              type: 'for',
              count: 2,
              maxIterations: 10,
              iterationVar: 'i'
            },
            body: [
              { id: 'step-a', title: 'Step A', prompt: 'First step in loop' },
              { id: 'step-b', title: 'Step B', prompt: 'Second step in loop' }
            ]
          } as LoopStep,
          { id: 'final', title: 'Final', prompt: 'After loop' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithMultiStep);

      let context: any = {};
      let completedSteps: string[] = [];
      const executionOrder: string[] = [];

      // First iteration - Step A
      let result = await service.getNextStep('multi-step-workflow', completedSteps, context);
      expect(result.step?.id).toBe('step-a');
      expect(result.context?.i).toBe(1);
      executionOrder.push(result.step!.id);
      context = result.context || context;
      completedSteps.push('step-a');

      // First iteration - Step B
      result = await service.getNextStep('multi-step-workflow', completedSteps, context);
      expect(result.step?.id).toBe('step-b');
      expect(result.context?.i).toBe(1);
      executionOrder.push(result.step!.id);
      context = result.context || context;
      completedSteps.push('step-b');

      // Second iteration - Step A
      // The service internally clears body steps when iteration completes
      result = await service.getNextStep('multi-step-workflow', completedSteps, context);
      expect(result.step?.id).toBe('step-a');
      expect(result.context?.i).toBe(2);
      executionOrder.push(result.step!.id);
      context = result.context || context;
      // Start fresh for second iteration
      completedSteps = ['step-a'];

      // Second iteration - Step B
      result = await service.getNextStep('multi-step-workflow', completedSteps, context);
      expect(result.step?.id).toBe('step-b');
      expect(result.context?.i).toBe(2);
      executionOrder.push(result.step!.id);
      context = result.context || context;
      completedSteps.push('step-b');

      // After loop completes
      result = await service.getNextStep('multi-step-workflow', completedSteps, context);
      expect(result.step?.id).toBe('final');

      // Verify execution order
      expect(executionOrder).toEqual(['step-a', 'step-b', 'step-a', 'step-b']);
    });

    it('should handle multi-step forEach loop', async () => {
      const workflowWithMultiForEach = createWorkflow({
        id: 'multi-foreach-workflow',
        name: 'Multi ForEach Workflow',
        description: 'Workflow with multi-step forEach loop',
        version: '0.1.0',
        steps: [
          {
            id: 'foreach-multi',
            type: 'loop',
            title: 'ForEach Multi',
            prompt: 'Process each item with multiple steps',
            loop: {
              type: 'forEach',
              items: 'tasks',
              maxIterations: 10,
              itemVar: 'task',
              indexVar: 'taskIndex'
            },
            body: [
              { id: 'validate', title: 'Validate', prompt: 'Validate task' },
              { id: 'execute', title: 'Execute', prompt: 'Execute task' },
              { id: 'report', title: 'Report', prompt: 'Report results' }
            ]
          } as LoopStep,
          { id: 'complete', title: 'Complete', prompt: 'All tasks done' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithMultiForEach);

      const tasks = ['task1', 'task2'];
      let context: any = { tasks, results: [] };
      let completedSteps: string[] = [];
      
      // First task
      // Validate step
      let result = await service.getNextStep('multi-foreach-workflow', completedSteps, context);
      expect(result.step?.id).toBe('validate');
      expect(result.context?.task).toBe('task1');
      expect(result.context?.taskIndex).toBe(0);
      context = result.context || context;
      completedSteps.push('validate');

      // Execute step
      result = await service.getNextStep('multi-foreach-workflow', completedSteps, context);
      expect(result.step?.id).toBe('execute');
      expect(result.context?.task).toBe('task1');
      context = result.context || context;
      completedSteps.push('execute');

      // Report step
      result = await service.getNextStep('multi-foreach-workflow', completedSteps, context);
      expect(result.step?.id).toBe('report');
      expect(result.context?.task).toBe('task1');
      context = result.context || context;
      completedSteps.push('report');

      // Second task - the service should have cleared body steps and incremented
      // Validate step
      result = await service.getNextStep('multi-foreach-workflow', completedSteps, context);
      expect(result.step?.id).toBe('validate');
      expect(result.context?.task).toBe('task2');
      expect(result.context?.taskIndex).toBe(1);
      context = result.context || context;
      completedSteps = ['validate']; // Reset for clarity

      // Execute step
      result = await service.getNextStep('multi-foreach-workflow', completedSteps, context);
      expect(result.step?.id).toBe('execute');
      expect(result.context?.task).toBe('task2');
      context = result.context || context;
      completedSteps.push('execute');

      // Report step
      result = await service.getNextStep('multi-foreach-workflow', completedSteps, context);
      expect(result.step?.id).toBe('report');
      expect(result.context?.task).toBe('task2');
      context = result.context || context;
      completedSteps.push('report');

      // After all tasks processed
      const finalResult = await service.getNextStep('multi-foreach-workflow', completedSteps, context);
      expect(finalResult.step?.id).toBe('complete');
    });

    it('should handle multi-step body with conditions', async () => {
      const workflowWithConditionalMulti = createWorkflow({
        id: 'conditional-multi-workflow',
        name: 'Conditional Multi Workflow',
        description: 'Multi-step loop with conditional steps',
        version: '0.1.0',
        steps: [
          {
            id: 'conditional-loop',
            type: 'loop',
            title: 'Conditional Loop',
            prompt: 'Loop with conditional steps',
            loop: {
              type: 'while',
              condition: { var: 'continue', equals: true },
              maxIterations: 10
            },
            body: [
              { id: 'always', title: 'Always', prompt: 'Always runs' },
              { 
                id: 'sometimes', 
                title: 'Sometimes', 
                prompt: 'Conditional step',
                runCondition: { var: 'runOptional', equals: true }
              },
              { id: 'final-body', title: 'Final Body', prompt: 'Last step in body' }
            ]
          } as LoopStep,
          { id: 'done', title: 'Done', prompt: 'Workflow complete' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithConditionalMulti);

      // First iteration with optional step
      let context: any = { continue: true, runOptional: true };
      let completedSteps: string[] = [];
      
      let result = await service.getNextStep('conditional-multi-workflow', completedSteps, context);
      expect(result.step?.id).toBe('always');
      context = result.context || context;
      completedSteps.push('always');
      
      result = await service.getNextStep('conditional-multi-workflow', completedSteps, context);
      expect(result.step?.id).toBe('sometimes'); // Should run due to condition
      context = result.context || context;
      completedSteps.push('sometimes');
      
      result = await service.getNextStep('conditional-multi-workflow', completedSteps, context);
      expect(result.step?.id).toBe('final-body');
      context = result.context || context;
      completedSteps.push('final-body');
      
      // Update context for next iteration without optional step
      context.runOptional = false;
      
      // Second iteration without optional step
      result = await service.getNextStep('conditional-multi-workflow', completedSteps, context);
      expect(result.step?.id).toBe('always');
      context = result.context || context;
      // Start fresh for second iteration
      completedSteps = ['always'];
      
      result = await service.getNextStep('conditional-multi-workflow', completedSteps, context);
      expect(result.step?.id).toBe('final-body'); // Should skip 'sometimes'
      context = result.context || context;
      completedSteps.push('final-body');
      
      // End the loop
      context.continue = false;
      
      result = await service.getNextStep('conditional-multi-workflow', completedSteps, context);
      expect(result.step?.id).toBe('done');
    });
  });

  describe('getNextStep with context size monitoring', () => {
    it('should track context size and add warnings', async () => {
      const workflowWithContext = createWorkflow({
        id: 'context-workflow',
        name: 'Context Workflow',
        description: 'Workflow for testing context size',
        version: '0.1.0',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'First step' },
          { id: 'step2', title: 'Step 2', prompt: 'Second step' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithContext);

      // Create a large context (but not too large)
      const largeData = 'x'.repeat(50 * 1024); // 100KB
      const result = await service.getNextStep('context-workflow', [], { data: largeData });
      
      expect(result.step?.id).toBe('step1');
      expect(result.context?._contextSize).toBeGreaterThan(100000);
      expect(result.context?._warnings).toBeUndefined(); // No warning yet
    });

    it('should add warning when context approaches size limit', async () => {
      const workflowWithContext = createWorkflow({
        id: 'context-workflow',
        name: 'Context Workflow',
        description: 'Workflow for testing context size',
        version: '0.1.0',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'First step' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithContext);

      // Create a large context that triggers warning (>204KB)
      const largeData = 'x'.repeat(105 * 1024); // 210KB
      const result = await service.getNextStep('context-workflow', [], { data: largeData });
      
      expect(result.step?.id).toBe('step1');
      expect(result.context?._warnings?.contextSize).toBeDefined();
      expect(result.context?._warnings?.contextSize[0]).toContain('exceeds 80%');
    });

    it('should throw error when context exceeds max size', async () => {
      const workflowWithContext = createWorkflow({
        id: 'context-workflow',
        name: 'Context Workflow',
        description: 'Workflow for testing context size',
        version: '0.1.0',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'First step' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithContext);

      // Create a very large context that exceeds limit (>256KB)
      const veryLargeData = 'x'.repeat(130 * 1024); // 260KB
      
      await expect(
        service.getNextStep('context-workflow', [], { data: veryLargeData })
      ).rejects.toThrow('exceeds maximum allowed size');
    });

    it('should monitor context size during loop execution', async () => {
      const loopWorkflow = createWorkflow({
        id: 'loop-size-workflow',
        name: 'Loop Size Workflow',
        description: 'Workflow with loop and growing context',
        version: '0.1.0',
        steps: [
          {
            id: 'accumulator-loop',
            type: 'loop',
            title: 'Accumulator Loop',
            prompt: 'Loop that accumulates data',
            loop: {
              type: 'while',
              condition: { var: 'iteration', lt: 3 },
              maxIterations: 5
            },
            body: 'accumulate'
          } as LoopStep,
          { 
            id: 'accumulate', 
            title: 'Accumulate Data', 
            prompt: 'Add more data'
          }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(loopWorkflow);

      // Start with moderate context
      let context: any = { 
        iteration: 0,
        accumulated: 'x'.repeat(50 * 1024) // 100KB
      };
      
      const result1 = await service.getNextStep('loop-size-workflow', [], context);
      expect(result1.step?.id).toBe('accumulate');
      expect(result1.context?._contextSize).toBeGreaterThan(100000);
      
      // Simulate accumulating more data
      context = await service.updateContextForStepCompletion('loop-size-workflow', 'accumulate', result1.context || context);
      context.iteration = 1;
      context.accumulated += 'y'.repeat(55 * 1024); // Add another 110KB to ensure we exceed 80%
      
      const result2 = await service.getNextStep('loop-size-workflow', [], context);
      expect(result2.step?.id).toBe('accumulate');
      expect(result2.context?._contextSize).toBeGreaterThan(204 * 1024); // Should be over 204KB
      expect(result2.context?._warnings?.contextSize).toBeDefined(); // Should warn now
    });
  });

  describe('getNextStep with loop validation', () => {
    it('should validate workflow structure and reject invalid loops', async () => {
      const invalidLoopWorkflow = createWorkflow({
        id: 'invalid-loop-workflow',
        name: 'Invalid Loop Workflow',
        description: 'Workflow with invalid loop',
        version: '0.1.0',
        steps: [
          {
            id: 'bad-loop',
            type: 'loop',
            title: 'Bad Loop',
            prompt: 'Invalid loop',
            loop: {
              type: 'while',
              // Missing required condition for while loop
              maxIterations: 10
            } as any,
            body: 'step1'
          } as LoopStep,
          { id: 'step1', title: 'Step 1', prompt: 'Body step' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(invalidLoopWorkflow);

      await expect(
        service.getNextStep('invalid-loop-workflow', [], {})
      ).rejects.toThrow('Invalid workflow structure');
    });

    it('should validate and reject workflow with non-existent loop body', async () => {
      const invalidBodyWorkflow = createWorkflow({
        id: 'invalid-body-workflow',
        name: 'Invalid Body Workflow',
        description: 'Workflow with non-existent loop body',
        version: '0.1.0',
        steps: [
          {
            id: 'loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop with bad body',
            loop: {
              type: 'while',
              condition: { var: 'active' },
              maxIterations: 10
            },
            body: 'non-existent-step'
          } as LoopStep
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(invalidBodyWorkflow);

      await expect(
        service.getNextStep('invalid-body-workflow', [], {})
      ).rejects.toThrow('non-existent step');
    });

    it('should accept valid loop workflows', async () => {
      const validLoopWorkflow = createWorkflow({
        id: 'valid-loop-workflow',
        name: 'Valid Loop Workflow',
        description: 'Workflow with valid loop',
        version: '0.1.0',
        steps: [
          {
            id: 'good-loop',
            type: 'loop',
            title: 'Good Loop',
            prompt: 'Valid loop',
            loop: {
              type: 'for',
              count: 3,
              maxIterations: 5
            },
            body: 'process'
          } as LoopStep,
          { id: 'process', title: 'Process', prompt: 'Do something' },
          { id: 'done', title: 'Done', prompt: 'Complete' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(validLoopWorkflow);

      const result = await service.getNextStep('valid-loop-workflow', [], {});
      expect(result.step?.id).toBe('process'); // Should start loop body
    });

    it('should accept valid multi-step loop workflows', async () => {
      const validMultiStepWorkflow = createWorkflow({
        id: 'valid-multi-workflow',
        name: 'Valid Multi-Step Workflow',
        description: 'Workflow with valid multi-step loop',
        version: '0.1.0',
        steps: [
          {
            id: 'multi-valid',
            type: 'loop',
            title: 'Multi Valid',
            prompt: 'Valid multi-step loop',
            loop: {
              type: 'while',
              condition: { var: 'keepGoing', equals: true },
              maxIterations: 100
            },
            body: [
              { id: 'first', title: 'First', prompt: 'First step' },
              { id: 'second', title: 'Second', prompt: 'Second step' },
              { id: 'third', title: 'Third', prompt: 'Third step' }
            ]
          } as LoopStep,
          { id: 'end', title: 'End', prompt: 'End of workflow' }
        ]
      }, createBundledSource());

      mockStorage.getWorkflowById.mockResolvedValue(validMultiStepWorkflow);

      // Should validate and return first step of multi-step body
      const result = await service.getNextStep('valid-multi-workflow', [], { keepGoing: true });
      expect(result.step?.id).toBe('first');
    });
  });
}); 