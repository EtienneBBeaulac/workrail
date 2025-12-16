import { describe, it, expect, beforeEach } from 'vitest';
import { createGetWorkflow, WorkflowGetMode } from '../../src/application/use-cases/get-workflow';
import { WorkflowService } from '../../src/application/services/workflow-service';
import { Workflow, createWorkflow, createBundledSource, WorkflowDefinition } from '../../src/types/workflow';
import { evaluateCondition } from '../../src/utils/condition-evaluator';
import { ok, err } from '../../src/domain/execution/result';
import { Err } from '../../src/domain/execution/error';
import type { ExecutionState } from '../../src/domain/execution/state';
import type { WorkflowEvent } from '../../src/domain/execution/event';

const mockWorkflow = createWorkflow({
  id: 'test-workflow',
  name: 'Test Workflow',
  description: 'A workflow for testing.',
  version: '0.0.1',
  preconditions: ['User has access to system'],
  clarificationPrompts: ['What is your goal?'],
  metaGuidance: ['Follow best practices'],
  steps: [
    { id: 'step1', title: 'Step 1', prompt: 'Prompt for step 1' },
    { id: 'step2', title: 'Step 2', prompt: 'Prompt for step 2' },
    { id: 'step3', title: 'Step 3', prompt: 'Prompt for step 3' },
  ],
}, createBundledSource());

const mockWorkflowWithConditions = createWorkflow({
  id: 'conditional-workflow',
  name: 'Conditional Workflow',
  description: 'A workflow with conditional steps.',
  version: '0.0.1',
  steps: [
    { 
      id: 'step1', 
      title: 'Step 1', 
      prompt: 'Always executable step',
    },
    {
      id: 'step2',
      title: 'Step 2',
      prompt: 'Only for complex tasks',
      runCondition: { var: 'complexity', equals: 'high' }
    },
    { 
      id: 'step3', 
      title: 'Step 3', 
      prompt: 'Simple task step',
      runCondition: { var: 'complexity', equals: 'low' }
    },
  ],
}, createBundledSource());

const mockEmptyWorkflow = createWorkflow({
  id: 'empty-workflow',
  name: 'Empty Workflow',
  description: 'A workflow with no steps.',
  version: '0.0.1',
  steps: [],
}, createBundledSource());

const mockWorkflowWithUndefinedOptionals = createWorkflow({
  id: 'minimal-workflow',
  name: 'Minimal Workflow',
  description: 'A minimal workflow.',
  version: '0.0.1',
  steps: [
    { id: 'step1', title: 'Step 1', prompt: 'Prompt for step 1' },
  ],
}, createBundledSource());

// Create a mock service that can be controlled by tests
class MockWorkflowService implements WorkflowService {
  private workflows: Map<string, Workflow> = new Map();
  private shouldThrowError = false;
  private errorToThrow: Error | null = null;

  setWorkflow(workflow: Workflow): void {
    this.workflows.set(workflow.definition.id, workflow);
  }

  setError(error: Error): void {
    this.shouldThrowError = true;
    this.errorToThrow = error;
  }

  clear(): void {
    this.workflows.clear();
    this.shouldThrowError = false;
    this.errorToThrow = null;
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    if (this.shouldThrowError && this.errorToThrow) {
      throw this.errorToThrow;
    }
    return this.workflows.get(id) || null;
  }

  async listWorkflowSummaries() {
    return [];
  }

  async getNextStep(
    workflowId: string,
    state: ExecutionState,
    _event?: WorkflowEvent,
    context: Record<string, unknown> = {}
  ) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return err(Err.workflowNotFound(workflowId));

    // Minimal behavior for tests: pick the first step whose runCondition passes (or has none).
    const first = workflow.definition.steps.find((s: any) => {
      if (!s.runCondition) return true;
      return evaluateCondition(s.runCondition as any, context as any);
    }) as any | undefined;

    if (!first) {
      return ok({ state: { kind: 'complete' } as any, next: null, isComplete: true });
    }

    return ok({
      state: { kind: 'running', completed: [], loopStack: [], pendingStep: { stepId: first.id, loopPath: [] } } as any,
      next: { step: first, stepInstanceId: { stepId: first.id, loopPath: [] }, guidance: { prompt: first.prompt } },
      isComplete: false,
    });
  }

  async validateStepOutput() {
    return { valid: true, issues: [], suggestions: [] };
  }
}

describe('createGetWorkflow', () => {
  let mockService: MockWorkflowService;
  let getWorkflow: ReturnType<typeof createGetWorkflow>;

  beforeEach(() => {
    mockService = new MockWorkflowService();
    mockService.clear();
    getWorkflow = createGetWorkflow(mockService);
  });

  describe('when workflow exists', () => {
    beforeEach(() => {
      mockService.setWorkflow(mockWorkflow);
    });

    describe('preview mode (default)', () => {
      it('should return workflow metadata with first step', async () => {
        const result = await getWorkflow('test-workflow');

        expect(result.isOk()).toBe(true);
        expect(result.value).toMatchObject({
          id: 'test-workflow',
          name: 'Test Workflow',
          description: 'A workflow for testing.',
          version: '0.0.1',
          preconditions: ['User has access to system'],
          clarificationPrompts: ['What is your goal?'],
          metaGuidance: ['Follow best practices'],
          totalSteps: 3,
          firstStep: { id: 'step1', title: 'Step 1', prompt: 'Prompt for step 1' },
        });
      });

      it('should return workflow metadata with first step when explicitly set to preview', async () => {
        const result = await getWorkflow('test-workflow', 'preview');

        expect(result.isOk()).toBe(true);
        expect(result.value).toMatchObject({
          id: 'test-workflow',
          name: 'Test Workflow',
          description: 'A workflow for testing.',
          version: '0.0.1',
          preconditions: ['User has access to system'],
          clarificationPrompts: ['What is your goal?'],
          metaGuidance: ['Follow best practices'],
          totalSteps: 3,
          firstStep: { id: 'step1', title: 'Step 1', prompt: 'Prompt for step 1' },
        });
      });

      it('should return null firstStep for empty workflow', async () => {
        mockService.setWorkflow(mockEmptyWorkflow);
        
        const result = await getWorkflow('empty-workflow', 'preview');
        
        expect(result.isOk()).toBe(true);
        expect(result.value).toEqual({
          id: 'empty-workflow',
          name: 'Empty Workflow',
          description: 'A workflow with no steps.',
          version: '0.0.1',
          totalSteps: 0,
          firstStep: null
        });
      });
    });

    describe('metadata mode', () => {
      it('should return workflow metadata without steps', async () => {
        const result = await getWorkflow('test-workflow', 'metadata');
        
        expect(result.isOk()).toBe(true);
        expect(result.value).toEqual({
          id: 'test-workflow',
          name: 'Test Workflow',
          description: 'A workflow for testing.',
          version: '0.0.1',
          preconditions: ['User has access to system'],
          clarificationPrompts: ['What is your goal?'],
          metaGuidance: ['Follow best practices'],
          totalSteps: 3
        });
      });

      it('should handle workflows with undefined optional fields', async () => {
        mockService.setWorkflow(mockWorkflowWithUndefinedOptionals);
        
        const result = await getWorkflow('minimal-workflow', 'metadata');
        
        expect(result.isOk()).toBe(true);
        expect(result.value).toEqual({
          id: 'minimal-workflow',
          name: 'Minimal Workflow',
          description: 'A minimal workflow.',
          version: '0.0.1',
          preconditions: undefined,
          clarificationPrompts: undefined,
          metaGuidance: undefined,
          totalSteps: 1
        });
      });
    });

    describe('conditional step handling', () => {
      beforeEach(() => {
        mockService.setWorkflow(mockWorkflowWithConditions);
      });

      it('should return first unconditional step as firstStep', async () => {
        const result = await getWorkflow('conditional-workflow', 'preview');

        expect(result.isOk()).toBe(true);
        expect(result.value).toMatchObject({
          id: 'conditional-workflow',
          name: 'Conditional Workflow',
          description: 'A workflow with conditional steps.',
          version: '0.0.1',
          totalSteps: 3,
          firstStep: { id: 'step1', title: 'Step 1', prompt: 'Always executable step' },
        });
      });

      it('should return null firstStep if all steps have unmet conditions', async () => {
        const mockAllConditionalWorkflow = createWorkflow({
          id: 'all-conditional',
          name: 'All Conditional',
          description: 'All steps are conditional.',
          version: '0.0.1',
          steps: [
            {
              id: 'step1',
              title: 'Step 1',
              prompt: 'High complexity step',
              runCondition: { var: 'complexity', equals: 'high' }
            },
            {
              id: 'step2',
              title: 'Step 2',
              prompt: 'Low complexity step',
              runCondition: { var: 'complexity', equals: 'low' }
            }
          ]
        }, createBundledSource());

        mockService.setWorkflow(mockAllConditionalWorkflow);
        
        const result = await getWorkflow('all-conditional', 'preview');
        
        expect(result.isOk()).toBe(true);
        expect(result.value).toEqual({
          id: 'all-conditional',
          name: 'All Conditional',
          description: 'All steps are conditional.',
          version: '0.0.1',
          totalSteps: 2,
          firstStep: null
        });
      });
    });
  });

  describe('when workflow does not exist', () => {
    it('should return WorkflowNotFound as Err for metadata mode', async () => {
      const result = await getWorkflow('nonexistent-workflow', 'metadata');
      expect(result.isErr()).toBe(true);
      expect(result.error._tag).toBe('WorkflowNotFound');
    });

    it('should return WorkflowNotFound as Err for preview mode', async () => {
      const result = await getWorkflow('nonexistent-workflow', 'preview');
      expect(result.isErr()).toBe(true);
      expect(result.error._tag).toBe('WorkflowNotFound');
    });

    it('should return WorkflowNotFound as Err for default mode', async () => {
      const result = await getWorkflow('nonexistent-workflow');
      expect(result.isErr()).toBe(true);
      expect(result.error._tag).toBe('WorkflowNotFound');
    });
  });

  describe('service integration', () => {
    it('should handle service errors gracefully', async () => {
      const serviceError = new Error('Service error');
      mockService.setError(serviceError);
      
      await expect(getWorkflow('test-workflow')).rejects.toThrow('Service error');
    });
  });

  describe('type safety', () => {
    it('should accept valid mode values', async () => {
      mockService.setWorkflow(mockWorkflow);
      
      const modes: WorkflowGetMode[] = ['metadata', 'preview', undefined];
      
      for (const mode of modes) {
        await expect(getWorkflow('test-workflow', mode)).resolves.toBeDefined();
      }
    });
  });
}); 