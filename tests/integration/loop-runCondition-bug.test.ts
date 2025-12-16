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

describe('Loop runCondition Bug - Body Steps with Iteration Variable', () => {
  let service: DefaultWorkflowService;
  let storage: InMemoryWorkflowStorage;

  beforeEach(() => {
    storage = new InMemoryWorkflowStorage();
    service = createTestWorkflowService(storage);
  });

  it('should inject loop variables BEFORE evaluating body step runConditions', async () => {
    // This replicates the exact structure of phase-1-iterative-analysis
    const bugWorkflow: WorkflowDefinition = {
      id: 'bug-repro-workflow',
      name: 'Bug Reproduction',
      description: 'Reproduces the loop skipping bug',
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
            count: 3,
            maxIterations: 3,
            iterationVar: 'analysisPhase'
          },
          body: [
            {
              id: 'analysis-step-1',
              title: 'Analysis Step 1',
              prompt: 'Analyze phase 1',
              runCondition: { var: 'analysisPhase', equals: 1 }
            },
            {
              id: 'analysis-step-2',
              title: 'Analysis Step 2',
              prompt: 'Analyze phase 2',
              runCondition: { var: 'analysisPhase', equals: 2 }
            },
            {
              id: 'analysis-step-3',
              title: 'Analysis Step 3',
              prompt: 'Analyze phase 3',
              runCondition: { var: 'analysisPhase', equals: 3 }
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

    storage.setWorkflows([bugWorkflow]);

    let context: any = { initialized: true };
    let completedSteps: string[] = [];

    // Complete setup
    let result = await service.getNextStep('bug-repro-workflow', completedSteps, context);
    expect(result.step?.id).toBe('setup');
    completedSteps.push('setup');

    // Next step should be FIRST body step (analysis-step-1), NOT after-loop
    result = await service.getNextStep('bug-repro-workflow', completedSteps, context);
    
    // BUG: Without the fix, this returns 'after-loop' (loop was skipped)
    // EXPECTED: Should return 'analysis-step-1'
    expect(result.step?.id).toBe('analysis-step-1');
    expect(result.context?.analysisPhase).toBe(1); // One-indexed for agent

    // The loop should NOT be marked as completed
    // Note: _loopState.iteration is zero-indexed internally, so first iteration is 0
    expect(result.context?._loopState?.['analysis-loop']?.iteration).toBe(0);
    // Warnings array exists but should be empty (no max iterations warning)
    const warnings = result.context?._loopState?.['analysis-loop']?.warnings || [];
    expect(warnings.length).toBe(0);
  });

  it('should execute all loop iterations when body steps use iteration variable in runCondition', async () => {
    const workflow: WorkflowDefinition = {
      id: 'full-loop-test',
      name: 'Full Loop Test',
      description: 'Test complete loop execution',
      version: '1.0.0',
      steps: [
        {
          id: 'analysis-loop',
          type: 'loop',
          title: 'Analysis Loop',
          loop: {
            type: 'for',
            count: 3,
            maxIterations: 3,
            iterationVar: 'phase'
          },
          body: [
            {
              id: 'step-1',
              title: 'Step 1',
              prompt: 'Phase 1',
              runCondition: { var: 'phase', equals: 1 }
            },
            {
              id: 'step-2',
              title: 'Step 2',
              prompt: 'Phase 2',
              runCondition: { var: 'phase', equals: 2 }
            },
            {
              id: 'step-3',
              title: 'Step 3',
              prompt: 'Phase 3',
              runCondition: { var: 'phase', equals: 3 }
            }
          ]
        } as LoopStepDefinition,
        {
          id: 'done',
          title: 'Done',
          prompt: 'Complete'
        }
      ]
    };

    storage.setWorkflows([workflow]);

    let context: any = {};
    let completedSteps: string[] = [];
    const executionSequence: string[] = [];

    // Execute loop iterations
    for (let expectedPhase = 1; expectedPhase <= 3; expectedPhase++) {
      const result = await service.getNextStep('full-loop-test', completedSteps, context);
      const expectedStepId = `step-${expectedPhase}`;
      
      expect(result.step?.id).toBe(expectedStepId);
      expect(result.context?.phase).toBe(expectedPhase);
      
      executionSequence.push(result.step!.id);
      context = result.context || context;
      completedSteps.push(result.step!.id);
    }

    // After completing all body steps of iteration 3, should exit loop
    const finalResult = await service.getNextStep('full-loop-test', completedSteps, context);
    expect(finalResult.step?.id).toBe('done');
    
    // Verify all steps were executed
    expect(executionSequence).toEqual(['step-1', 'step-2', 'step-3']);
  });
});

