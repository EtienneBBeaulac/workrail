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
  WorkflowStep,
  WorkflowGuidance
} from '../../types/mcp-types';
import { createDefaultWorkflowStorage } from '../../infrastructure/storage';
import { IWorkflowStorage } from '../../types/storage';
import {
  WorkflowNotFoundError,
  StepNotFoundError
} from '../../core/error-handler';
import { evaluateCondition, ConditionContext } from '../../utils/condition-evaluator';
import { ValidationEngine } from './validation-engine';
import { LoopStep, isLoopStep, EnhancedContext } from '../../types/workflow-types';
import { LoopExecutionContext } from './loop-execution-context';
import { LoopStepResolver } from './loop-step-resolver';
import { checkContextSize } from '../../utils/context-size';

/**
 * Default implementation of {@link WorkflowService} that relies on
 * the existing {@link FileWorkflowStorage} backend.
 */
export class DefaultWorkflowService implements WorkflowService {
  private loopStepResolver: LoopStepResolver;

  constructor(
    private readonly storage: IWorkflowStorage = createDefaultWorkflowStorage(),
    private readonly validationEngine: ValidationEngine = new ValidationEngine()
  ) {
    this.loopStepResolver = new LoopStepResolver();
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
  ): Promise<{ step: WorkflowStep | null; guidance: WorkflowGuidance; isComplete: boolean; context?: ConditionContext }> {
    // Check context size before processing
    const sizeCheck = checkContextSize(context);
    if (sizeCheck.isError) {
      throw new Error(`Context size (${Math.round(sizeCheck.sizeBytes / 1024)}KB) exceeds maximum allowed size (256KB)`);
    }
    
    const checkedContext = sizeCheck.context;
    
    const workflow = await this.storage.getWorkflowById(workflowId);
    if (!workflow) {
      throw new WorkflowNotFoundError(workflowId);
    }

    // Validate workflow structure including loops
    const validationResult = this.validationEngine.validateWorkflow(workflow);
    if (!validationResult.valid) {
      throw new Error(`Invalid workflow structure: ${validationResult.issues.join('; ')}`);
    }

    // Create a mutable copy of completed steps
    const completed = [...(completedSteps || [])];
    const enhancedContext = checkedContext as EnhancedContext;
    
    // Build a set of step IDs that are loop bodies
    const loopBodySteps = new Set<string>();
    for (const step of workflow.steps) {
      if (isLoopStep(step)) {
        const loopStep = step as LoopStep;
        if (typeof loopStep.body === 'string') {
          loopBodySteps.add(loopStep.body);
        }
      }
    }
    
    // Check if we're currently executing a loop body
    if (enhancedContext._currentLoop) {
      const { loopId, loopStep } = enhancedContext._currentLoop;
      const loopContext = new LoopExecutionContext(
        loopId,
        loopStep.loop,
        enhancedContext._loopState?.[loopId]
      );
      
      // Check if loop should continue
      if (loopContext.shouldContinue(context)) {
        // Resolve the loop body step
        const bodyStep = this.loopStepResolver.resolveLoopBody(workflow, loopStep.body, loopStep.id);
        
        // Handle single step body
        if (!Array.isArray(bodyStep)) {
          // Always inject loop variables first
          const loopEnhancedContext = loopContext.injectVariables(context);
          
          // Check context size after injection
          const loopSizeCheck = checkContextSize(loopEnhancedContext);
          if (loopSizeCheck.isError) {
            throw new Error(`Context size (${Math.round(loopSizeCheck.sizeBytes / 1024)}KB) exceeds maximum allowed size (256KB) during loop execution`);
          }
          
          // Return the body step for execution
          return {
            step: bodyStep,
            guidance: {
              prompt: this.buildStepPrompt(bodyStep, loopContext)
            },
            isComplete: false,
            context: loopSizeCheck.context
          };
        } else {
          // Multi-step body support will be implemented in Phase 3
          throw new Error('Multi-step loop bodies not yet supported');
        }
      } else {
        // Loop has completed, mark it as completed
        completed.push(loopId);
        // Remove current loop from context
        delete enhancedContext._currentLoop;
      }
    }
    
    const nextStep = workflow.steps.find((step) => {
      // Skip if step is already completed
      if (completed.includes(step.id)) {
        return false;
      }
      
      // Skip if step is a loop body (unless we're executing that loop)
      if (loopBodySteps.has(step.id) && (!enhancedContext._currentLoop || enhancedContext._currentLoop.loopStep.body !== step.id)) {
        return false;
      }
      
      // If step has a runCondition, evaluate it
      if (step.runCondition) {
        return evaluateCondition(step.runCondition, context);
      }
      
      // No condition means step is eligible
      return true;
    }) || null;
    
    // Check if the next step is a loop
    if (nextStep && isLoopStep(nextStep)) {
      const loopStep = nextStep as LoopStep;
      // Initialize loop context
      const loopContext = new LoopExecutionContext(
        nextStep.id,
        loopStep.loop,
        enhancedContext._loopState?.[nextStep.id]
      );
      
      // Initialize forEach loops
      if (loopStep.loop.type === 'forEach') {
        loopContext.initializeForEach(context);
      }
      
      // Check if loop should execute at all
      if (!loopContext.shouldContinue(context)) {
        // Loop condition is false from the start, skip it
        completed.push(nextStep.id);
        return this.getNextStep(workflowId, completed, context);
      }
      
      // Set current loop in context
      const newContext: EnhancedContext = {
        ...context,
        _currentLoop: {
          loopId: nextStep.id,
          loopStep: loopStep
        }
      };
      
      // Check context size when starting loop
      const loopStartSizeCheck = checkContextSize(newContext);
      if (loopStartSizeCheck.isError) {
        throw new Error(`Context size (${Math.round(loopStartSizeCheck.sizeBytes / 1024)}KB) exceeds maximum allowed size (256KB) when starting loop`);
      }
      
      // Return to get loop body
      return this.getNextStep(workflowId, completedSteps, loopStartSizeCheck.context);
    }
    
    const isComplete = !nextStep;

    let finalPrompt = 'Workflow complete.';
    if (nextStep) {
      finalPrompt = this.buildStepPrompt(nextStep);
    }

    return {
      step: nextStep,
      guidance: {
        prompt: finalPrompt
      },
      isComplete,
      context: enhancedContext
    };
  }

  /**
   * Build the prompt for a step, including agent role and guidance
   * @private
   */
  private buildStepPrompt(step: WorkflowStep, loopContext?: LoopExecutionContext): string {
    let stepGuidance = '';
    if (step.guidance && step.guidance.length > 0) {
      const guidanceHeader = '## Step Guidance';
      const guidanceList = step.guidance.map((g: string) => `- ${g}`).join('\n');
      stepGuidance = `${guidanceHeader}\n${guidanceList}\n\n`;
    }
    
    // Build user-facing prompt
    let finalPrompt = `${stepGuidance}${step.prompt}`;
    
    // If agentRole exists, include it in the guidance for agent processing
    if (step.agentRole) {
      finalPrompt = `## Agent Role Instructions\n${step.agentRole}\n\n${finalPrompt}`;
    }
    
    // Add loop context information if in a loop
    if (loopContext) {
      const state = loopContext.getCurrentState();
      finalPrompt += `\n\n## Loop Context\n- Iteration: ${state.iteration + 1}`;
      if (state.items) {
        finalPrompt += `\n- Total Items: ${state.items.length}`;
        finalPrompt += `\n- Current Index: ${state.index}`;
      }
    }
    
    return finalPrompt;
  }



  /**
   * Find a loop step by ID in the workflow
   * @private
   */
  private findLoopStepById(workflow: Workflow, stepId: string): LoopStep | null {
    const step = workflow.steps.find(s => s.id === stepId);
    return step && isLoopStep(step) ? step as LoopStep : null;
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
   * Updates the context when a step is completed, handling loop iteration tracking
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
    const enhancedContext = { ...context } as EnhancedContext;
    
    // Check if we're in a loop and this is a loop body step
    if (enhancedContext._currentLoop) {
      const { loopId, loopStep } = enhancedContext._currentLoop;
      const workflow = await this.storage.getWorkflowById(workflowId);
      
      if (workflow) {
        // Check if the completed step is the loop body
        const bodyStep = this.loopStepResolver.resolveLoopBody(workflow, loopStep.body, loopStep.id);
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
          if (!enhancedContext._loopState) {
            enhancedContext._loopState = {};
          }
          enhancedContext._loopState[loopId] = loopContext.getCurrentState();
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

// Legacy singleton – retained for backwards compatibility. New code should
// prefer explicit instantiation and dependency injection.
export const defaultWorkflowService: WorkflowService = new DefaultWorkflowService(); 