import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { DefaultWorkflowService } from '../../src/application/services/workflow-service';
import { IWorkflowStorage } from '../../src/types/storage';
import { Workflow, WorkflowSummary } from '../../src/types/mcp-types';
import { LoopStep } from '../../src/types/workflow-types';

const mockWorkflow: Workflow = {
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
};

const mockWorkflowWithAgentRole: Workflow = {
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
};

describe('DefaultWorkflowService', () => {
  let service: DefaultWorkflowService;
  let mockStorage: jest.Mocked<IWorkflowStorage>;

  beforeEach(() => {
    mockStorage = {
      getWorkflowById: jest.fn(),
      listWorkflowSummaries: jest.fn(),
      loadAllWorkflows: jest.fn()
    };
    
    // Default mock implementations
    mockStorage.getWorkflowById.mockImplementation(async (id: string) => {
      if (id === mockWorkflow.id) {
        return mockWorkflow;
      }
      if (id === mockWorkflowWithAgentRole.id) {
        return mockWorkflowWithAgentRole;
      }
      return null;
    });
    
    mockStorage.listWorkflowSummaries.mockResolvedValue([]);
    mockStorage.loadAllWorkflows.mockResolvedValue([mockWorkflow, mockWorkflowWithAgentRole]);
    
    service = new DefaultWorkflowService(mockStorage);
    jest.clearAllMocks();
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
      const workflowWithLoop: Workflow = {
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
      };

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
      const workflowWithWhile: Workflow = {
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
      };

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithWhile);

      // First iteration
      let context: any = { counter: 0 };
      const result1 = await service.getNextStep('while-workflow', [], context);
      expect(result1.step?.id).toBe('increment');

      // Simulate completing the step and update context
      context = await service.updateContextForStepCompletion('while-workflow', 'increment', result1.context || context);

      // Second iteration
      context.counter = 1;
      const result2 = await service.getNextStep('while-workflow', [], context);
      expect(result2.step?.id).toBe('increment');
      expect(result2.guidance.prompt).toContain('Iteration: 2');

      // Third iteration
      context = await service.updateContextForStepCompletion('while-workflow', 'increment', result2.context || context);
      context.counter = 2;
      const result3 = await service.getNextStep('while-workflow', [], context);
      expect(result3.step?.id).toBe('increment');
      expect(result3.guidance.prompt).toContain('Iteration: 3');

      // Loop should exit when condition is false
      context = await service.updateContextForStepCompletion('while-workflow', 'increment', result3.context || context);
      context.counter = 3;
      const result4 = await service.getNextStep('while-workflow', [], context);
      expect(result4.isComplete).toBe(true);
    });

    it('should inject loop variables into context', async () => {
      const workflowWithVars: Workflow = {
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
      };

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithVars);

      // First iteration should have loopCount = 0
      const result1 = await service.getNextStep('vars-workflow', [], { shouldContinue: true });
      expect(result1.step?.id).toBe('check-var');
      // Context should have loop variables injected
      expect(result1.context).toHaveProperty('loopCount', 0);
    });

    it('should respect max iterations limit', async () => {
      const workflowWithLimit: Workflow = {
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
      };

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithLimit);

      // First iteration
      let context: any = { alwaysTrue: true };
      const result1 = await service.getNextStep('limit-workflow', [], context);
      expect(result1.step?.id).toBe('simple-step');

      // Second iteration
      context = await service.updateContextForStepCompletion('limit-workflow', 'simple-step', result1.context || context);
      const result2 = await service.getNextStep('limit-workflow', [], context);
      expect(result2.step?.id).toBe('simple-step');

      // Should exit after max iterations even though condition is true
      context = await service.updateContextForStepCompletion('limit-workflow', 'simple-step', result2.context || context);
      const result3 = await service.getNextStep('limit-workflow', [], context);
      expect(result3.isComplete).toBe(true);
    });

    it('should skip loop if initial condition is false', async () => {
      const workflowWithFalseCondition: Workflow = {
        id: 'false-workflow',
        name: 'False Condition Workflow',
        description: 'Workflow where loop never executes',
        version: '0.1.0',
        steps: [
          {
            id: 'never-loop',
            type: 'loop',
            title: 'Never Loop',
            prompt: 'This loop should not execute',
            loop: {
              type: 'while',
              condition: { var: 'shouldRun', equals: true },
              maxIterations: 10
            },
            body: 'never-reached'
          } as LoopStep,
          { 
            id: 'never-reached', 
            title: 'Never Reached', 
            prompt: 'Should not see this'
          },
          { id: 'after-loop', title: 'After Loop', prompt: 'Continue after skipped loop' }
        ]
      };

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithFalseCondition);

      // Should skip the loop entirely and go to after-loop
      const result = await service.getNextStep('false-workflow', [], { shouldRun: false });
      expect(result.step?.id).toBe('after-loop');
    });
  });

  describe('getNextStep with context size monitoring', () => {
    it('should track context size and add warnings', async () => {
      const workflowWithContext: Workflow = {
        id: 'context-workflow',
        name: 'Context Workflow',
        description: 'Workflow for testing context size',
        version: '0.1.0',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'First step' },
          { id: 'step2', title: 'Step 2', prompt: 'Second step' }
        ]
      };

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithContext);

      // Create a large context (but not too large)
      const largeData = 'x'.repeat(50 * 1024); // 100KB
      const result = await service.getNextStep('context-workflow', [], { data: largeData });
      
      expect(result.step?.id).toBe('step1');
      expect(result.context?._contextSize).toBeGreaterThan(100000);
      expect(result.context?._warnings).toBeUndefined(); // No warning yet
    });

    it('should add warning when context approaches size limit', async () => {
      const workflowWithContext: Workflow = {
        id: 'context-workflow',
        name: 'Context Workflow',
        description: 'Workflow for testing context size',
        version: '0.1.0',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'First step' }
        ]
      };

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithContext);

      // Create a large context that triggers warning (>204KB)
      const largeData = 'x'.repeat(105 * 1024); // 210KB
      const result = await service.getNextStep('context-workflow', [], { data: largeData });
      
      expect(result.step?.id).toBe('step1');
      expect(result.context?._warnings?.contextSize).toBeDefined();
      expect(result.context?._warnings?.contextSize[0]).toContain('exceeds 80%');
    });

    it('should throw error when context exceeds max size', async () => {
      const workflowWithContext: Workflow = {
        id: 'context-workflow',
        name: 'Context Workflow',
        description: 'Workflow for testing context size',
        version: '0.1.0',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'First step' }
        ]
      };

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithContext);

      // Create a very large context that exceeds limit (>256KB)
      const veryLargeData = 'x'.repeat(130 * 1024); // 260KB
      
      await expect(
        service.getNextStep('context-workflow', [], { data: veryLargeData })
      ).rejects.toThrow('exceeds maximum allowed size');
    });

    it('should monitor context size during loop execution', async () => {
      const loopWorkflow: Workflow = {
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
      };

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
      const invalidLoopWorkflow: Workflow = {
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
      };

      mockStorage.getWorkflowById.mockResolvedValue(invalidLoopWorkflow);

      await expect(
        service.getNextStep('invalid-loop-workflow', [], {})
      ).rejects.toThrow('Invalid workflow structure');
    });

    it('should validate and reject workflow with non-existent loop body', async () => {
      const invalidBodyWorkflow: Workflow = {
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
      };

      mockStorage.getWorkflowById.mockResolvedValue(invalidBodyWorkflow);

      await expect(
        service.getNextStep('invalid-body-workflow', [], {})
      ).rejects.toThrow('non-existent step');
    });

    it('should accept valid loop workflows', async () => {
      const validLoopWorkflow: Workflow = {
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
      };

      mockStorage.getWorkflowById.mockResolvedValue(validLoopWorkflow);

      const result = await service.getNextStep('valid-loop-workflow', [], {});
      expect(result.step?.id).toBe('process'); // Should start loop body
    });
  });
}); 