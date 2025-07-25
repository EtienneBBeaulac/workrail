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
import { ContextOptimizer } from './context-optimizer';

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
        } else if (Array.isArray(loopStep.body)) {
          // Add all step IDs from multi-step body
          loopStep.body.forEach(bodyStep => loopBodySteps.add(bodyStep.id));
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
          // Handle multi-step body
          // Find the first uncompleted step in the body that meets its condition
          const uncompletedBodyStep = bodyStep.find(step => {
            // Skip if already completed
            if (completed.includes(step.id)) {
              return false;
            }
            
            // Check runCondition if present
            if (step.runCondition) {
              return evaluateCondition(step.runCondition, context);
            }
            
            return true;
          });
          
          if (uncompletedBodyStep) {
            // Always inject loop variables first
            const loopEnhancedContext = loopContext.injectVariables(context);
            
            // Check context size after injection
            const loopSizeCheck = checkContextSize(loopEnhancedContext);
            if (loopSizeCheck.isError) {
              throw new Error(`Context size (${Math.round(loopSizeCheck.sizeBytes / 1024)}KB) exceeds maximum allowed size (256KB) during loop execution`);
            }
            
            // Return the next uncompleted step in the body
            return {
              step: uncompletedBodyStep,
              guidance: {
                prompt: this.buildStepPrompt(uncompletedBodyStep, loopContext)
              },
              isComplete: false,
              context: loopSizeCheck.context
            };
          } else {
            // All body steps completed for this iteration, increment and check if we should continue
            loopContext.incrementIteration();
            
            // Update loop state in context
            if (!enhancedContext._loopState) {
              enhancedContext._loopState = {};
            }
            enhancedContext._loopState[loopId] = loopContext.getCurrentState();
            
            // Clear completed body steps for next iteration
            bodyStep.forEach(step => {
              const index = completed.indexOf(step.id);
              if (index > -1) {
                completed.splice(index, 1);
              }
            });
            
            // Continue to check if loop should execute again
            return this.getNextStep(workflowId, completed, enhancedContext);
          }
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
      if (loopBodySteps.has(step.id)) {
        // If we're not in a loop, skip all loop body steps
        if (!enhancedContext._currentLoop) {
          return false;
        }
        
        // If we're in a loop, check if this step is part of the current loop's body
        const currentLoopBody = enhancedContext._currentLoop.loopStep.body;
        if (typeof currentLoopBody === 'string') {
          // Single-step body
          return currentLoopBody === step.id;
        } else if (Array.isArray(currentLoopBody)) {
          // Multi-step body - check if this step is in the array
          return currentLoopBody.some(bodyStep => bodyStep.id === step.id);
        }
        
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
        
        // Preserve loop state including any warnings
        const loopStateData = loopContext.getCurrentState();
        let skipContext = ContextOptimizer.mergeLoopState(
          context as EnhancedContext,
          nextStep.id,
          loopStateData
        );
        
        // Inject any warnings from the skipped loop
        if (loopStateData.warnings && loopStateData.warnings.length > 0) {
          skipContext = ContextOptimizer.addWarnings(
            skipContext,
            'loops',
            nextStep.id,
            loopStateData.warnings
          );
        }
        
        return this.getNextStep(workflowId, completed, skipContext);
      }
      
      // Set current loop in context
      let newContext = ContextOptimizer.createEnhancedContext(context, {
        _currentLoop: {
          loopId: nextStep.id,
          loopStep: loopStep
        }
      });
      
      // Save loop state after initialization
      newContext = ContextOptimizer.mergeLoopState(
        newContext,
        nextStep.id,
        loopContext.getCurrentState()
      );
      
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
    let enhancedContext = context as EnhancedContext;
    
    // Check if we're in a loop and this is a loop body step
    if (enhancedContext._currentLoop) {
      const { loopId, loopStep } = enhancedContext._currentLoop;
      const workflow = await this.storage.getWorkflowById(workflowId);
      
      if (workflow) {
        // Check if the completed step is part of the loop body
        const bodyStep = this.loopStepResolver.resolveLoopBody(workflow, loopStep.body, loopStep.id);
        
        // Only increment iteration for single-step bodies
        // Multi-step bodies are incremented in getNextStep when all steps complete
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

// Legacy singleton – retained for backwards compatibility. New code should
// prefer explicit instantiation and dependency injection.
export const defaultWorkflowService: WorkflowService = new DefaultWorkflowService(); 