import 'reflect-metadata';
import { describe, vi, it, expect, beforeEach, jest } from 'vitest';
import { DefaultWorkflowService } from '../../src/application/services/workflow-service';
import { IWorkflowStorage } from '../../src/types/storage';
import { Workflow } from '../../src/types/mcp-types';
import { LoopStep } from '../../src/types/workflow-types';
import { ValidationEngine } from '../../src/application/services/validation-engine';
import { EnhancedLoopValidator } from '../../src/application/services/enhanced-loop-validator';
import { IterativeStepResolutionStrategy } from '../../src/application/services/step-resolution/iterative-step-resolution-strategy';
import { DefaultWorkflowLoader } from '../../src/application/services/workflow-loader';
import { DefaultLoopRecoveryService } from '../../src/application/services/loop-recovery-service';
import { LoopStackManager } from '../../src/application/services/loop-stack-manager';
import { DefaultStepSelector } from '../../src/application/services/step-selector';
import { LoopStepResolver } from '../../src/application/services/loop-step-resolver';
import { FakeLoggerFactory } from '../helpers/FakeLoggerFactory.js';

// Helper function to create a workflow service with a mock storage
function createTestWorkflowService(mockStorage: IWorkflowStorage): DefaultWorkflowService {
  const loggerFactory = new FakeLoggerFactory();
  const loopValidator = new EnhancedLoopValidator();
  const validator = new ValidationEngine(loopValidator);
  const resolver = new LoopStepResolver();
  const stackManager = new LoopStackManager(resolver, undefined, loggerFactory);
  const recoveryService = new DefaultLoopRecoveryService(stackManager, loggerFactory);
  const stepSelector = new DefaultStepSelector(loggerFactory);
  const workflowLoader = new DefaultWorkflowLoader(mockStorage, validator, loggerFactory);
  const strategy = new IterativeStepResolutionStrategy(
    workflowLoader,
    recoveryService,
    stackManager,
    stepSelector,
    loggerFactory
  );
  
  return new DefaultWorkflowService(mockStorage, validator, strategy, loggerFactory);
}

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
    vi.clearAllMocks();
    
    mockStorage = {
      listWorkflowSummaries: vi.fn(),
      getWorkflowById: vi.fn(),
      saveWorkflow: vi.fn(),
      deleteWorkflow: vi.fn(),
      listWorkflowsByPattern: vi.fn(),
      getStorageInfo: vi.fn(),
      loadAllWorkflows: vi.fn()
    } as unknown as jest.Mocked<IWorkflowStorage>;

    // Set default mock implementation
    mockStorage.getWorkflowById.mockImplementation(async (id: string) => {
      if (id === mockWorkflowWithLoop.id) return mockWorkflowWithLoop;
      return null;
    });
    mockStorage.loadAllWorkflows.mockResolvedValue([mockWorkflowWithLoop]);
    
    service = createTestWorkflowService(mockStorage);
  });

  describe('Loop Step Recognition', () => {
    it('should enter loop and return first body step', async () => {
      // New behavior: loops are automatically entered, returning the body step
      mockStorage.getWorkflowById.mockResolvedValue(mockWorkflowWithLoop);
      
      const context = { itemsToProcess: ['item1', 'item2'] };
      const result = await service.getNextStep('test-workflow-loop', ['step1'], context);

      // Loop is automatically entered, returning the body step
      expect(result.step).toBeDefined();
      expect(result.step?.id).toBe('process-item');
      expect(result.isComplete).toBe(false);
    });

    it('should include loop context in guidance when in loop', async () => {
      mockStorage.getWorkflowById.mockResolvedValue(mockWorkflowWithLoop);
      
      const context = { itemsToProcess: ['item1', 'item2'] };
      const result = await service.getNextStep('test-workflow-loop', ['step1'], context);

      // New format: Loop Context with iteration info
      expect(result.guidance.prompt).toContain('## Loop Context');
      expect(result.guidance.prompt).toContain('Iteration: 1');
    });

    it('should skip completed loop steps', async () => {
      mockStorage.getWorkflowById.mockResolvedValue(mockWorkflowWithLoop);

      const result = await service.getNextStep('test-workflow-loop', ['step1', 'loop-step'], {});

      expect(result.step).toBeDefined();
      expect(result.step?.id).toBe('step3');
      expect(result.isComplete).toBe(false);
    });

    it('should initialize loop context and inject variables', async () => {
      mockStorage.getWorkflowById.mockResolvedValue(mockWorkflowWithLoop);

      const context = {
        itemsToProcess: ['item1', 'item2', 'item3']
      };

      const result = await service.getNextStep('test-workflow-loop', ['step1'], context);

      expect(result.step).toBeDefined();
      // Loop is entered, body step returned
      expect(result.step?.id).toBe('process-item');
      // Loop context should have forEach variables injected
      expect(result.context?._loopStack).toBeDefined();
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
      expect(result.guidance.prompt).not.toContain('## Loop Context');
    });

    it('should handle loop steps with runCondition', async () => {
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
          },
          {
            id: 'after-loop',
            title: 'After Loop',
            prompt: 'After the loop'
          }
        ]
      };

      mockStorage.getWorkflowById.mockResolvedValue(workflowWithConditionalLoop);

      // Test when runCondition is false - skip loop, move to next step
      let result = await service.getNextStep('conditional-loop-workflow', [], { loopEnabled: false });
      expect(result.step?.id).toBe('after-loop');

      // Test when runCondition is true and loop condition is true - enter loop
      result = await service.getNextStep('conditional-loop-workflow', [], { 
        loopEnabled: true, 
        continueLoop: true 
      });
      expect(result.step?.id).toBe('loop-body');
    });
  });
}); 