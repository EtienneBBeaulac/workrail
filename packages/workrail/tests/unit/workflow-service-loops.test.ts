import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { DefaultWorkflowService } from '../../src/application/services/workflow-service';
import { IWorkflowStorage } from '../../src/types/storage';
import { Workflow } from '../../src/types/mcp-types';
import { LoopStep } from '../../src/types/workflow-types';

describe('WorkflowService - Loop Recognition', () => {
  let mockStorage: jest.Mocked<IWorkflowStorage>;
  let service: DefaultWorkflowService;

  const mockWorkflowWithLoop: Workflow = {
    id: 'test-workflow-loop',
    name: 'Test Workflow with Loop',
    description: 'A workflow with a loop step',
    version: '0.1.0',
    steps: [
      {
        id: 'step1',
        title: 'Step 1',
        prompt: 'First step'
      },
      {
        id: 'loop-step',
        type: 'loop',
        title: 'Process Items Loop',
        prompt: 'Loop through items',
        loop: {
          type: 'forEach',
          items: 'itemsToProcess',
          maxIterations: 10
        },
        body: 'process-item'
      } as LoopStep,
      {
        id: 'process-item',
        title: 'Process Item',
        prompt: 'Process a single item'
      },
      {
        id: 'step3',
        title: 'Step 3',
        prompt: 'Final step'
      }
    ]
  };

  beforeEach(() => {
    mockStorage = {
      listWorkflowSummaries: jest.fn(),
      getWorkflowById: jest.fn(),
      saveWorkflow: jest.fn(),
      deleteWorkflow: jest.fn(),
      listWorkflowsByPattern: jest.fn(),
      getStorageInfo: jest.fn()
    } as unknown as jest.Mocked<IWorkflowStorage>;

    service = new DefaultWorkflowService(mockStorage);
  });

  describe('Loop Step Recognition', () => {
    it('should recognize a loop step as next step', async () => {
      mockStorage.getWorkflowById.mockResolvedValue(mockWorkflowWithLoop);

      const result = await service.getNextStep('test-workflow-loop', ['step1'], {});

      expect(result.step).toBeDefined();
      expect(result.step?.id).toBe('loop-step');
      expect((result.step as any).type).toBe('loop');
      expect(result.isComplete).toBe(false);
    });

    it('should include loop information in guidance', async () => {
      mockStorage.getWorkflowById.mockResolvedValue(mockWorkflowWithLoop);

      const result = await service.getNextStep('test-workflow-loop', ['step1'], {});

      expect(result.guidance.prompt).toContain('## Loop Information');
      expect(result.guidance.prompt).toContain('Type: forEach');
      expect(result.guidance.prompt).toContain('Max Iterations: 10');
    });

    it('should skip completed loop steps', async () => {
      mockStorage.getWorkflowById.mockResolvedValue(mockWorkflowWithLoop);

      const result = await service.getNextStep('test-workflow-loop', ['step1', 'loop-step'], {});

      expect(result.step).toBeDefined();
      expect(result.step?.id).toBe('step3');
      expect(result.isComplete).toBe(false);
    });

    it('should initialize loop context for new loop steps', async () => {
      mockStorage.getWorkflowById.mockResolvedValue(mockWorkflowWithLoop);

      const context = {
        itemsToProcess: ['item1', 'item2', 'item3']
      };

      const result = await service.getNextStep('test-workflow-loop', ['step1'], context);

      expect(result.step).toBeDefined();
      expect(result.step?.id).toBe('loop-step');
      
      // The loop context should be initialized internally
      // Full verification will be added in Phase 2
    });

    it('should handle workflows without loops normally', async () => {
      const regularWorkflow: Workflow = {
        id: 'regular-workflow',
        name: 'Regular Workflow',
        description: 'No loops',
        version: '0.0.1',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'First' },
          { id: 'step2', title: 'Step 2', prompt: 'Second' }
        ]
      };

      mockStorage.getWorkflowById.mockResolvedValue(regularWorkflow);

      const result = await service.getNextStep('regular-workflow', ['step1'], {});

      expect(result.step).toBeDefined();
      expect(result.step?.id).toBe('step2');
      expect(result.guidance.prompt).not.toContain('## Loop Information');
    });

    it('should handle loop steps with conditions', async () => {
      const workflowWithConditionalLoop: Workflow = {
        id: 'conditional-loop-workflow',
        name: 'Conditional Loop Workflow',
        description: 'Loop with run condition',
        version: '0.1.0',
        steps: [
          {
            id: 'loop-step',
            type: 'loop',
            title: 'Conditional Loop',
            prompt: 'Loop if enabled',
            runCondition: { var: 'loopEnabled', equals: true },
            loop: {
              type: 'while',
              condition: { var: 'continueLoop', equals: true },
              maxIterations: 5
            },
            body: 'loop-body'
          } as LoopStep,
          {
            id: 'loop-body',
            title: 'Loop Body',
            prompt: 'Execute loop body'
          }
        ]
      };

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithConditionalLoop);

      // Test when condition is false
      let result = await service.getNextStep('conditional-loop-workflow', [], { loopEnabled: false });
      expect(result.step).toBeNull();
      expect(result.isComplete).toBe(true);

      // Test when condition is true
      result = await service.getNextStep('conditional-loop-workflow', [], { loopEnabled: true });
      expect(result.step).toBeDefined();
      expect(result.step?.id).toBe('loop-step');
    });
  });
}); 