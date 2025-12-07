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

import { singleton, inject } from 'tsyringe';
import { DI } from '../../di/tokens.js';
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
import type { Logger, ILoggerFactory } from '../../core/logging/index.js';
import { getBootstrapLogger } from '../../core/logging/index.js';
import { IterativeStepResolutionStrategy } from './step-resolution/iterative-step-resolution-strategy';
import { DefaultWorkflowLoader } from './workflow-loader';
import { DefaultLoopRecoveryService } from './loop-recovery-service';
import { LoopStackManager } from './loop-stack-manager';
import { DefaultStepSelector } from './step-selector';
import { EnhancedLoopValidator } from './enhanced-loop-validator';

/**
 * Default implementation of WorkflowService.
 * 
 * Orchestrates workflow execution by delegating to injected services.
 * Follows Clean Architecture - orchestrates but doesn't contain business logic.
 * 
 * The service delegates step resolution to an injected IStepResolutionStrategy,
 * which allows swapping between iterative and recursive implementations via DI.
 */
@singleton()
export class DefaultWorkflowService implements WorkflowService {
  private readonly logger: Logger;

  constructor(
    @inject(DI.Storage.Primary) private readonly storage: IWorkflowStorage,
    @inject(ValidationEngine) private readonly validationEngine: ValidationEngine,
    @inject(IterativeStepResolutionStrategy) private readonly stepResolutionStrategy: IterativeStepResolutionStrategy,
    @inject(DI.Logging.Factory) loggerFactory: ILoggerFactory,
  ) {
    this.logger = loggerFactory.create('WorkflowService');
    this.logger.info({ strategy: stepResolutionStrategy.constructor.name }, 'WorkflowService initialized');
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
 * Legacy helper for backward compatibility.
 * @deprecated Use DI container: container.resolve(DI.Services.Workflow)
 */
export function createWorkflowService(): DefaultWorkflowService {
  console.warn(
    '[DEPRECATION] createWorkflowService() is deprecated. ' +
    'Use container.resolve(DI.Services.Workflow) from \'./di/container\' instead.'
  );
  
  // For backward compatibility, manually create dependencies
  // This bypasses DI but allows legacy code to continue working
  // Use bootstrap logger for legacy code (can't use DI here)
  const fakeFactory: ILoggerFactory = {
    create: (component: string) => getBootstrapLogger().child({ component }),
    root: getBootstrapLogger(),
  };
  
  const storage = createDefaultWorkflowStorage();
  const loopValidator = new EnhancedLoopValidator();
  const validator = new ValidationEngine(loopValidator);
  const resolver = new LoopStepResolver();
  const stackManager = new LoopStackManager(resolver, undefined, fakeFactory);
  const recoveryService = new DefaultLoopRecoveryService(stackManager, fakeFactory);
  const stepSelector = new DefaultStepSelector(fakeFactory);
  const workflowLoader = new DefaultWorkflowLoader(storage, validator, fakeFactory);
  const strategy = new IterativeStepResolutionStrategy(
    workflowLoader,
    recoveryService,
    stackManager,
    stepSelector,
    fakeFactory
  );
  
  return new DefaultWorkflowService(storage, validator, strategy, fakeFactory);
}
