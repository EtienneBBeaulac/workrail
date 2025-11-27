export interface WorkflowService {
  /** Return lightweight summaries of all workflows. */
  listWorkflowSummaries(): Promise<import('../../types/mcp-types').WorkflowSummary[]>;

  /** Retrieve a workflow by ID, or null if not found. */
  getWorkflowById(id: string): Promise<import('../../types/mcp-types').Workflow | null>;

  /**
   * Determine the next step in a workflow given completed step IDs.
   */
  getNextStep(
    workflowId: string,
    completedSteps: string[],
    context?: ConditionContext
  ): Promise<{
    step: import('../../types/mcp-types').WorkflowStep | null;
    guidance: import('../../types/mcp-types').WorkflowGuidance;
    isComplete: boolean;
    context?: ConditionContext;
  }>;

  /** Validate an output for a given step. */
  validateStepOutput(
    workflowId: string,
    stepId: string,
    output: string
  ): Promise<{
    valid: boolean;
    issues: string[];
    suggestions: string[];
  }>;
}

import { 
  Workflow,
  WorkflowSummary,
  WorkflowStep
} from '../../types/mcp-types';
import { createDefaultWorkflowStorage } from '../../infrastructure/storage';
import { IWorkflowStorage } from '../../types/storage';
import { 
  WorkflowNotFoundError,
  StepNotFoundError
} from '../../core/error-handler';
import { ConditionContext } from '../../utils/condition-evaluator';
import { ValidationEngine } from './validation-engine';
import { EnhancedContext } from '../../types/workflow-types';
import { LoopExecutionContext } from './loop-execution-context';
import { LoopStepResolver } from './loop-step-resolver';
import { checkContextSize } from '../../utils/context-size';
import { ContextOptimizer } from './context-optimizer';
import { IStepResolutionStrategy, StepResolutionResult } from './step-resolution/i-step-resolution-strategy';
import { createLogger } from '../../utils/logger';
import { createServiceContainer } from '../../infrastructure/di/service-container';

/**
 * Default implementation of WorkflowService.
 * 
 * Orchestrates workflow execution by delegating to injected services.
 * Follows Clean Architecture - orchestrates but doesn't contain business logic.
 * 
 * The service delegates step resolution to an injected IStepResolutionStrategy,
 * which allows swapping between iterative and recursive implementations via DI.
 */
export class DefaultWorkflowService implements WorkflowService {
  private readonly logger = createLogger('WorkflowService');

  constructor(
    private readonly storage: IWorkflowStorage,
    private readonly validationEngine: ValidationEngine,
    private readonly stepResolutionStrategy: IStepResolutionStrategy
  ) {
    this.logger.info('WorkflowService initialized', {
      strategy: stepResolutionStrategy.constructor.name
    });
  }

  async listWorkflowSummaries(): Promise<WorkflowSummary[]> {
    return this.storage.listWorkflowSummaries();
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    return this.storage.getWorkflowById(id);
  }

  async getNextStep(
    workflowId: string,
    completedSteps: string[],
    context: ConditionContext = {}
  ): Promise<StepResolutionResult> {
    // Delegate to injected strategy - no more feature flag branching!
    return this.stepResolutionStrategy.getNextStep(workflowId, completedSteps, context);
  }

  async validateStepOutput(
    workflowId: string,
    stepId: string,
    output: string
  ): Promise<{ valid: boolean; issues: string[]; suggestions: string[] }> {
    const workflow = await this.storage.getWorkflowById(workflowId);
    if (!workflow) {
      throw new WorkflowNotFoundError(workflowId);
    }

    const step = workflow.steps.find((s) => s.id === stepId);
    if (!step) {
      throw new StepNotFoundError(stepId, workflowId);
    }

    // Use ValidationEngine to handle validation logic
    const criteria = (step as any).validationCriteria as any[] || [];
    return this.validationEngine.validate(output, criteria);
  }

  /**
   * Updates the context when a step is completed, handling loop iteration tracking.
   * 
   * Note: This method is kept for backward compatibility.
   * The strategy implementations handle most context updates internally.
   * 
   * @param workflowId The workflow ID
   * @param stepId The step ID that was completed
   * @param context The current execution context
   * @returns Updated context with loop state changes
   */
  async updateContextForStepCompletion(
    workflowId: string,
    stepId: string,
    context: ConditionContext
  ): Promise<EnhancedContext> {
    let enhancedContext = context as EnhancedContext;
    
    // Check if we're in a loop and this is a loop body step
    if (enhancedContext._currentLoop) {
      const { loopId, loopStep } = enhancedContext._currentLoop;
      const workflow = await this.storage.getWorkflowById(workflowId);
      
      if (workflow) {
        // Check if the completed step is part of the loop body
        const loopStepResolver = new LoopStepResolver();
        const bodyStep = loopStepResolver.resolveLoopBody(workflow, loopStep.body, loopStep.id);
        
        // Only increment iteration for single-step bodies
        // Multi-step bodies are incremented when all steps complete
        if (!Array.isArray(bodyStep) && bodyStep.id === stepId) {
          // Create loop context to increment iteration
          const loopContext = new LoopExecutionContext(
            loopId,
            loopStep.loop,
            enhancedContext._loopState?.[loopId]
          );
          
          // Increment the loop iteration
          loopContext.incrementIteration();
          
          // Update loop state in context
          enhancedContext = ContextOptimizer.mergeLoopState(
            enhancedContext,
            loopId,
            loopContext.getCurrentState()
          );
        }
      }
    }
    
    // Check context size after update
    const sizeCheck = checkContextSize(enhancedContext);
    if (sizeCheck.isError) {
      throw new Error(`Context size (${Math.round(sizeCheck.sizeBytes / 1024)}KB) exceeds maximum allowed size (256KB) after step completion`);
    }
    
    return sizeCheck.context as EnhancedContext;
  }
}

/**
 * Creates a DefaultWorkflowService with the given storage.
 * Helper for tests and simple usage.
 * 
 * @param storage - Optional storage (defaults to file storage)
 * @param validationEngine - Optional validation engine
 * @returns Configured DefaultWorkflowService
 */
export function createWorkflowService(
  storage?: IWorkflowStorage,
  validationEngine?: ValidationEngine
): DefaultWorkflowService {
  const container = createServiceContainer({ storage, validationEngine });
  return new DefaultWorkflowService(
    container.storage,
    container.validationEngine,
    container.stepResolutionStrategy
  );
}

// Legacy singleton – retained for backwards compatibility.
export const defaultWorkflowService: WorkflowService = createWorkflowService();
