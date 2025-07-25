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

/**
 * Default implementation of {@link WorkflowService} that relies on
 * the existing {@link FileWorkflowStorage} backend.
 */
export class DefaultWorkflowService implements WorkflowService {
  private loopContexts: Map<string, LoopExecutionContext> = new Map();

  constructor(
    private readonly storage: IWorkflowStorage = createDefaultWorkflowStorage(),
    private readonly validationEngine: ValidationEngine = new ValidationEngine()
  ) {}

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
  ): Promise<{ step: WorkflowStep | null; guidance: WorkflowGuidance; isComplete: boolean }> {
    const workflow = await this.storage.getWorkflowById(workflowId);
    if (!workflow) {
      throw new WorkflowNotFoundError(workflowId);
    }

    const completed = completedSteps || [];
    
    // Check if we're currently in a loop
    const activeLoopContext = this.findActiveLoopContext(workflowId, context);
    if (activeLoopContext) {
      const loopStep = this.findLoopStepById(workflow, activeLoopContext.getLoopId());
      if (loopStep && activeLoopContext.shouldContinue(context)) {
        // We're still in a loop, return the loop body step
        // For now, just stub this out - full implementation in Phase 2
        console.log('Loop step detected:', loopStep.id);
      }
    }
    
    const nextStep = workflow.steps.find((step) => {
      // Skip if step is already completed
      if (completed.includes(step.id)) {
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
      // Initialize loop context for the new loop
      const loopContext = new LoopExecutionContext(
        nextStep.id,
        (nextStep as LoopStep).loop,
        (context as EnhancedContext)._loopState?.[nextStep.id]
      );
      
      this.loopContexts.set(`${workflowId}:${nextStep.id}`, loopContext);
      
      // Initialize forEach loops
      if ((nextStep as LoopStep).loop.type === 'forEach') {
        loopContext.initializeForEach(context);
      }
      
      // For now, return the loop step itself
      // Full loop body resolution will be implemented in Phase 2
    }
    
    const isComplete = !nextStep;

    let finalPrompt = 'Workflow complete.';
    if (nextStep) {
      let stepGuidance = '';
      if (nextStep.guidance && nextStep.guidance.length > 0) {
        const guidanceHeader = '## Step Guidance';
        const guidanceList = nextStep.guidance.map((g: string) => `- ${g}`).join('\n');
        stepGuidance = `${guidanceHeader}\n${guidanceList}\n\n`;
      }
      
      // Build user-facing prompt (unchanged for backward compatibility)
      finalPrompt = `${stepGuidance}${nextStep.prompt}`;
      
      // If agentRole exists, include it in the guidance for agent processing
      if (nextStep.agentRole) {
        // Add agentRole instructions to the guidance prompt for agent consumption
        // This maintains the existing API while providing agent-specific instructions
        finalPrompt = `## Agent Role Instructions\n${nextStep.agentRole}\n\n${finalPrompt}`;
      }
      
      // Add loop-specific information to the prompt if it's a loop step
      if (isLoopStep(nextStep)) {
        const loopStep = nextStep as LoopStep;
        finalPrompt += `\n\n## Loop Information\n- Type: ${loopStep.loop.type}\n- Max Iterations: ${loopStep.loop.maxIterations}`;
      }
    }

    return {
      step: nextStep,
      guidance: {
        prompt: finalPrompt
      },
      isComplete
    };
  }

  /**
   * Find an active loop context for the current workflow
   * @private
   */
  private findActiveLoopContext(workflowId: string, context: ConditionContext): LoopExecutionContext | null {
    // This will be fully implemented in Phase 2
    // For now, just check if we have any loop contexts
    for (const [key, loopContext] of this.loopContexts) {
      if (key.startsWith(`${workflowId}:`)) {
        if (loopContext.shouldContinue(context)) {
          return loopContext;
        }
      }
    }
    return null;
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
}

// Legacy singleton – retained for backwards compatibility. New code should
// prefer explicit instantiation and dependency injection.
export const defaultWorkflowService: WorkflowService = new DefaultWorkflowService(); 