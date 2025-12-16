import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultWorkflowService } from '../../src/application/services/workflow-service';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage';
import { WorkflowDefinition } from '../../src/types/workflow';
import { LoopStepDefinition } from '../../src/types/workflow-definition';
import { ValidationEngine } from '../../src/application/services/validation-engine';
import { EnhancedLoopValidator } from '../../src/application/services/enhanced-loop-validator';
import { IterativeStepResolutionStrategy } from '../../src/application/services/step-resolution/iterative-step-resolution-strategy';
import { DefaultWorkflowLoader } from '../../src/application/services/workflow-loader';
import { DefaultLoopRecoveryService } from '../../src/application/services/loop-recovery-service';
import { LoopStackManager } from '../../src/application/services/loop-stack-manager';
import { DefaultStepSelector } from '../../src/application/services/step-selector';
import { LoopStepResolver } from '../../src/application/services/loop-step-resolver';

// Helper function to create a workflow service with custom storage
function createTestWorkflowService(storage: InMemoryWorkflowStorage): DefaultWorkflowService {
  const loopValidator = new EnhancedLoopValidator();
  const validator = new ValidationEngine(loopValidator);
  const resolver = new LoopStepResolver();
  const stackManager = new LoopStackManager(resolver);
  const recoveryService = new DefaultLoopRecoveryService(stackManager);
  const stepSelector = new DefaultStepSelector();
  const workflowLoader = new DefaultWorkflowLoader(storage, validator);
  const strategy = new IterativeStepResolutionStrategy(
    workflowLoader,
    recoveryService,
    stackManager,
    stepSelector
  );
  
  return new DefaultWorkflowService(storage, validator, strategy);
}

describe('Loop with Conditional Body Steps Bug Fix', () => {
  let service: DefaultWorkflowService;
  let storage: InMemoryWorkflowStorage;

  beforeEach(() => {
    storage = new InMemoryWorkflowStorage();
    service = createTestWorkflowService(storage);
  });

  it('should advance loop iteration when only eligible body steps are completed', async () => {
    // This replicates the exact structure of phase-1-multi-analysis from coding-task-workflow-with-loops
    const workflow: WorkflowDefinition = {
      id: 'conditional-body-workflow',
      name: 'Test Workflow with Conditional Body Steps',
      description: 'Test workflow',
      version: '1.0.0',
      steps: [
        {
          id: 'setup',
          title: 'Setup',
          prompt: 'Initialize'
        },
        {
          id: 'analysis-loop',
          type: 'loop',
          title: 'Analysis Loop',
          loop: {
            type: 'for',
            count: 4,
            maxIterations: 4,
            iterationVar: 'analysisStep'
          },
          body: [
            {
              id: 'phase-1-step-structure',
              title: 'Analysis Step 1/4: Structure',
              prompt: 'Analyze structure',
              runCondition: { var: 'analysisStep', equals: 1 }
            },
            {
              id: 'phase-1-step-modules',
              title: 'Analysis Step 2/4: Modules',
              prompt: 'Analyze modules',
              runCondition: { var: 'analysisStep', equals: 2 }
            },
            {
              id: 'phase-1-step-dependencies',
              title: 'Analysis Step 3/4: Dependencies',
              prompt: 'Analyze dependencies',
              runCondition: { var: 'analysisStep', equals: 3 }
            },
            {
              id: 'phase-1-step-patterns',
              title: 'Analysis Step 4/4: Patterns',
              prompt: 'Analyze patterns',
              runCondition: { var: 'analysisStep', equals: 4 }
            }
          ]
        } as LoopStepDefinition,
        {
          id: 'after-loop',
          title: 'After Loop',
          prompt: 'Process results'
        }
      ]
    };

    storage.setWorkflows([workflow]);

    let context: any = { initialized: true };
    let completedSteps: string[] = [];

    // Complete setup
    let result = await service.getNextStep('conditional-body-workflow', completedSteps, context);
    expect(result.step?.id).toBe('setup');
    completedSteps.push('setup');
    context = result.context || context;

    // === ITERATION 1 ===
    // Next step should be phase-1-step-structure (analysisStep=1)
    result = await service.getNextStep('conditional-body-workflow', completedSteps, context);
    expect(result.step?.id).toBe('phase-1-step-structure');
    expect(result.context?.analysisStep).toBe(1);
    completedSteps.push('phase-1-step-structure');
    context = result.context || context;

    // === ITERATION 2 ===
    // After completing step 1, should advance to iteration 2 and return phase-1-step-modules
    result = await service.getNextStep('conditional-body-workflow', completedSteps, context);
    expect(result.step?.id).toBe('phase-1-step-modules');
    expect(result.context?.analysisStep).toBe(2);
    completedSteps.push('phase-1-step-modules');
    context = result.context || context;

    // === ITERATION 3 ===
    // After completing step 2, should advance to iteration 3 and return phase-1-step-dependencies
    result = await service.getNextStep('conditional-body-workflow', completedSteps, context);
    expect(result.step?.id).toBe('phase-1-step-dependencies');
    expect(result.context?.analysisStep).toBe(3);
    completedSteps.push('phase-1-step-dependencies');
    context = result.context || context;

    // === ITERATION 4 ===
    // After completing step 3, should advance to iteration 4 and return phase-1-step-patterns
    result = await service.getNextStep('conditional-body-workflow', completedSteps, context);
    expect(result.step?.id).toBe('phase-1-step-patterns');
    expect(result.context?.analysisStep).toBe(4);
    completedSteps.push('phase-1-step-patterns');
    context = result.context || context;

    // === AFTER LOOP ===
    // After completing step 4, loop should be complete and move to after-loop
    result = await service.getNextStep('conditional-body-workflow', completedSteps, context);
    expect(result.step?.id).toBe('after-loop');
    expect(result.context?._currentLoop).toBeUndefined(); // Loop should be exited
  });

  it('should handle the exact bug scenario from the user report', async () => {
    // Replicate the exact scenario from the user's bug report
    const workflow: WorkflowDefinition = {
      id: 'coding-task-workflow-with-loops',
      name: 'Coding Task Workflow',
      description: 'Test workflow',
      version: '1.0.0',
      steps: [
        { id: 'phase-0-intelligent-triage', title: 'Triage', prompt: 'Triage task' },
        { id: 'phase-0b-user-rules-identification', title: 'User Rules', prompt: 'Identify rules' },
        { id: 'phase-0c-overview-gathering', title: 'Overview', prompt: 'Gather overview' },
        {
          id: 'phase-1-multi-analysis',
          type: 'loop',
          title: 'Analysis Loop',
          loop: {
            type: 'for',
            count: 4,
            maxIterations: 4,
            iterationVar: 'analysisStep'
          },
          body: [
            {
              id: 'phase-1-step-structure',
              title: 'Step 1/4',
              prompt: 'Step 1',
              runCondition: { var: 'analysisStep', equals: 1 }
            },
            {
              id: 'phase-1-step-modules',
              title: 'Step 2/4',
              prompt: 'Step 2',
              runCondition: { var: 'analysisStep', equals: 2 }
            },
            {
              id: 'phase-1-step-dependencies',
              title: 'Step 3/4',
              prompt: 'Step 3',
              runCondition: { var: 'analysisStep', equals: 3 }
            },
            {
              id: 'phase-1-step-patterns',
              title: 'Step 4/4',
              prompt: 'Step 4',
              runCondition: { var: 'analysisStep', equals: 4 }
            }
          ]
        } as LoopStepDefinition
      ]
    };

    storage.setWorkflows([workflow]);

    // Simulate the exact state from the bug report
    const completedSteps = [
      'phase-0-intelligent-triage',
      'phase-0b-user-rules-identification',
      'phase-0c-overview-gathering',
      'phase-1-step-structure',
      'phase-1-step-modules'
    ];
    const context = {
      taskComplexity: 'Medium',
      requestDeepAnalysis: true,
      automationLevel: 'High',
      analysisStep: 3
    };

    // Get next step
    const result = await service.getNextStep('coding-task-workflow-with-loops', completedSteps, context);

    // EXPECTED: Should return phase-1-step-dependencies (step 3) with analysisStep=3
    // BUG (before fix): Would return phase-1-step-modules (step 2) again with analysisStep=2
    expect(result.step?.id).toBe('phase-1-step-dependencies');
    expect(result.context?.analysisStep).toBe(3);
    expect(result.step?.title).toBe('Step 3/4');
  });
});

