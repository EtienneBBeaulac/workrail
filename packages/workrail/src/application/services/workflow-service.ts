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
import { LoopStep, isLoopStep, EnhancedContext, isFirstLoopIteration } from '../../types/workflow-types';
import { LoopExecutionContext } from './loop-execution-context';
import { LoopStepResolver } from './loop-step-resolver';
import { checkContextSize } from '../../utils/context-size';
import { ContextOptimizer } from './context-optimizer';
import { ILoopContextOptimizer } from '../../types/loop-context-optimizer';

/**
 * Default implementation of {@link WorkflowService} that relies on
 * the existing {@link FileWorkflowStorage} backend.
 */
export class DefaultWorkflowService implements WorkflowService {
  private loopStepResolver: LoopStepResolver;

  constructor(
    private readonly storage: IWorkflowStorage = createDefaultWorkflowStorage(),
    private readonly validationEngine: ValidationEngine = new ValidationEngine(),
    private readonly loopContextOptimizer?: ILoopContextOptimizer
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
      // Check if body step(s) are completed - if so, increment iteration
      const bodyStep = this.loopStepResolver.resolveLoopBody(workflow, loopStep.body, loopStep.id);
      const bodyIsCompleted = Array.isArray(bodyStep)
        ? bodyStep.every(step => completed.includes(step.id))
        : completed.includes(bodyStep.id);
      
      if (bodyIsCompleted) {
        // Body completed, increment iteration and clear body steps from completed
        loopContext.incrementIteration();
        
        // Update loop state in context
        if (!enhancedContext._loopState) {
          enhancedContext._loopState = {};
        }
        enhancedContext._loopState[loopId] = loopContext.getCurrentState();
        
        // Clear completed body steps for next iteration
        if (Array.isArray(bodyStep)) {
          bodyStep.forEach(step => {
            const index = completed.indexOf(step.id);
            if (index > -1) {
              completed.splice(index, 1);
            }
          });
        } else {
          const index = completed.indexOf(bodyStep.id);
          if (index > -1) {
            completed.splice(index, 1);
          }
        }
        
        // Check if loop should continue with next iteration
        if (!loopContext.shouldContinue(context)) {
          // Loop completed, mark it as done
          completed.push(loopId);
          delete enhancedContext._currentLoop;
          // Continue to next step after loop
          const nextStep = await this.getNextStep(workflow.id, completed, enhancedContext);
          return nextStep;
        }
        // Loop continues, fall through to return body step for next iteration
      }
      
      if (loopContext.shouldContinue(context)) {
        // Handle single step body
        if (!Array.isArray(bodyStep)) {
          // Check if this is the first iteration
          const isFirst = loopContext.isFirstIteration();
          
          // Check if loop is empty to avoid phase overview
          if (isFirst && loopContext.isEmpty(context)) {
            // Skip this loop entirely
            const skipContext = ContextOptimizer.createEnhancedContext(context, completed);
            delete skipContext._currentLoop; // Remove loop context
            const nextStep = await this.getNextStep(workflow.id, completed, skipContext);
            return nextStep;
          }
          
          // Use optimizer if available for subsequent iterations
          const useMinimal = !isFirst && !!this.loopContextOptimizer;
          const loopEnhancedContext = loopContext.injectVariables(context, useMinimal);
          
          // Apply additional optimization if available
          const optimizedContext = useMinimal && this.loopContextOptimizer
            ? this.loopContextOptimizer.stripLoopMetadata(loopEnhancedContext as EnhancedContext)
            : loopEnhancedContext;
          
          // Check context size after injection
          const loopSizeCheck = checkContextSize(optimizedContext as any);
          if (loopSizeCheck.isError) {
            throw new Error(`Context size (${Math.round(loopSizeCheck.sizeBytes / 1024)}KB) exceeds maximum allowed size (256KB) during loop execution`);
          }
          
          // Return the body step for execution
          return {
            step: bodyStep,
            guidance: {
              prompt: this.buildStepPrompt(bodyStep, loopContext, useMinimal)
            },
            isComplete: false,
            context: loopSizeCheck.context
          };
        } else {
          // Handle multi-step body
          // Check if this is the first iteration
          const isFirst = loopContext.isFirstIteration();
          
          // Check if loop is empty to avoid phase overview
          if (isFirst && loopContext.isEmpty(context)) {
            // Skip this loop entirely
            const skipContext = ContextOptimizer.createEnhancedContext(context, completed);
            delete skipContext._currentLoop; // Remove loop context
            const nextStep = await this.getNextStep(workflow.id, completed, skipContext);
            return nextStep;
          }
          
          // CRITICAL FIX: Inject loop variables BEFORE evaluating body step runConditions
          // This ensures iteration variables (e.g., analysisPhase) are available when checking conditions
          const useMinimal = !isFirst && !!this.loopContextOptimizer;
          const loopEnhancedContext = loopContext.injectVariables(context, useMinimal);
          
          // Find the first uncompleted step in the body that meets its condition
          // NOW using loopEnhancedContext which has iteration variables
          const uncompletedBodyStep = bodyStep.find(step => {
            // Skip if already completed
            if (completed.includes(step.id)) {
              return false;
            }
            
            // Check runCondition if present - use loopEnhancedContext with iteration vars
            if (step.runCondition) {
              return evaluateCondition(step.runCondition, loopEnhancedContext);
            }
            
            return true;
          });
          
          if (uncompletedBodyStep) {
            
            // Apply additional optimization if available
            const optimizedContext = useMinimal && this.loopContextOptimizer
              ? this.loopContextOptimizer.stripLoopMetadata(loopEnhancedContext as EnhancedContext)
              : loopEnhancedContext;
            
            // Check context size after injection
            const loopSizeCheck = checkContextSize(optimizedContext as any);
            if (loopSizeCheck.isError) {
              throw new Error(`Context size (${Math.round(loopSizeCheck.sizeBytes / 1024)}KB) exceeds maximum allowed size (256KB) during loop execution`);
            }
            
            // Return the next uncompleted step in the body
            return {
              step: uncompletedBodyStep,
              guidance: {
                prompt: this.buildStepPrompt(uncompletedBodyStep, loopContext, useMinimal)
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
    
    // If no next step is eligible, determine whether we're actually complete
    // or blocked due to unmet runCondition variables. This avoids false
    // "Workflow complete" responses when context is missing or mismatched.
    if (!nextStep) {
      const remainingConditionalSteps = workflow.steps.filter((step) => {
        if (completed.includes(step.id)) return false;
        if (loopBodySteps.has(step.id)) return false;
        return !!(step as any).runCondition;
      });

      if (remainingConditionalSteps.length > 0) {
        // Collect variables referenced by remaining step conditions and any
        // enumerated equals values to provide actionable guidance.
        const requiredVars = new Set<string>();
        const allowedValues: Record<string, Set<string>> = {};

        for (const step of remainingConditionalSteps) {
          const condition = (step as any).runCondition as any;
          this.collectConditionVars(condition, requiredVars);
          this.collectEqualsValues(condition, allowedValues);
        }

        // Build guidance message indicating what is missing or mismatched
        const issues: string[] = [];
        for (const variableName of requiredVars) {
          const currentValue = (enhancedContext as any)[variableName];
          const allowed = allowedValues[variableName]
            ? Array.from(allowedValues[variableName])
            : [];

          if (currentValue === undefined || currentValue === null || currentValue === '') {
            if (allowed.length > 0) {
              issues.push(`Set '${variableName}' to one of: ${allowed.map(v => `'${v}'`).join(', ')}`);
            } else {
              issues.push(`Provide a value for '${variableName}'`);
            }
          } else if (allowed.length > 0) {
            // If we have an allowed set and the current value does not match any exactly,
            // provide corrective guidance. Also hint if it only differs by case.
            const matchesExactly = allowed.some(v => v === String(currentValue));
            const matchesCaseInsensitive = allowed.some(v => v.toLowerCase() === String(currentValue).toLowerCase());
            if (!matchesExactly) {
              if (matchesCaseInsensitive) {
                issues.push(`Normalize casing for '${variableName}': use one of ${allowed.map(v => `'${v}'`).join(', ')} (current '${currentValue}')`);
              } else {
                issues.push(`Adjust '${variableName}' to one of: ${allowed.map(v => `'${v}'`).join(', ')} (current '${currentValue}')`);
              }
            }
          }
        }

        // If we identified any issues, return a blocked response, not complete
        if (issues.length > 0) {
          return {
            step: null,
            guidance: {
              prompt: `No eligible step due to unmet conditions. Please update context:\n- ${issues.join('\n- ')}`
            },
            isComplete: false,
            context: enhancedContext
          };
        }
      }
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
  private buildStepPrompt(step: WorkflowStep, loopContext?: LoopExecutionContext, useMinimal: boolean = false): string {
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
      
      if (useMinimal && this.loopContextOptimizer) {
        // Minimal context for subsequent iterations
        finalPrompt += `\n\n## Loop Context\n- Iteration: ${state.iteration + 1}`;
        
        // Add phase reference if not first iteration
        if (!loopContext.isFirstIteration()) {
          finalPrompt += '\n\n_Note: Refer to the phase overview provided in the first iteration for overall context._';
        }
      } else {
        // Full context for first iteration or when optimizer not available
        finalPrompt += `\n\n## Loop Context\n- Iteration: ${state.iteration + 1}`;
        if (state.items) {
          finalPrompt += `\n- Total Items: ${state.items.length}`;
          finalPrompt += `\n- Current Index: ${state.index}`;
        }
      }
    }
    
    return finalPrompt;
  }

  /**
   * Recursively collect variable names referenced in a condition tree.
   */
  private collectConditionVars(condition: any, sink: Set<string>): void {
    if (!condition || typeof condition !== 'object') return;
    if (typeof condition.var === 'string' && condition.var.length > 0) {
      sink.add(condition.var);
    }
    if (Array.isArray(condition.and)) {
      for (const sub of condition.and) this.collectConditionVars(sub, sink);
    }
    if (Array.isArray(condition.or)) {
      for (const sub of condition.or) this.collectConditionVars(sub, sink);
    }
    if (condition.not) this.collectConditionVars(condition.not, sink);
  }

  /**
   * Recursively collect enumerated equals values per variable from conditions.
   * Only simple { var: 'x', equals: value } pairs are captured.
   */
  private collectEqualsValues(condition: any, sink: Record<string, Set<string>>): void {
    if (!condition || typeof condition !== 'object') return;
    if (typeof condition.var === 'string' && Object.prototype.hasOwnProperty.call(condition, 'equals')) {
      const variableName = condition.var;
      const value = condition.equals;
      if (value !== undefined && value !== null) {
        if (!sink[variableName]) sink[variableName] = new Set<string>();
        sink[variableName].add(String(value));
      }
    }
    if (Array.isArray(condition.and)) {
      for (const sub of condition.and) this.collectEqualsValues(sub, sink);
    }
    if (Array.isArray(condition.or)) {
      for (const sub of condition.or) this.collectEqualsValues(sub, sink);
    }
    if (condition.not) this.collectEqualsValues(condition.not, sink);
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