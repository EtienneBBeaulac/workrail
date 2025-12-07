import { inject, singleton } from 'tsyringe';
import { DI } from '../../di/tokens.js';
import { Workflow, WorkflowStep, WorkflowGuidance } from '../../types/mcp-types';
import { IStepSelector } from './i-step-selector';
import { EnhancedContext } from '../../types/workflow-types';
import { evaluateCondition, Condition, ConditionContext } from '../../utils/condition-evaluator';
import type { Logger, ILoggerFactory } from '../../core/logging/index.js';
import { 
  diagnoseConditionFailure, 
  buildConditionGuidance, 
  BlockedStepInfo 
} from '../../utils/condition-analysis';

/**
 * Default implementation of step selection logic.
 * 
 * Responsibilities:
 * - Find eligible steps based on conditions and state
 * - Generate guidance when no eligible steps found
 */
@singleton()
export class DefaultStepSelector implements IStepSelector {
  private readonly logger: Logger;
  
  constructor(@inject(DI.Logging.Factory) loggerFactory: ILoggerFactory) {
    this.logger = loggerFactory.create('StepSelector');
  }

  findEligibleStep(
    workflow: Workflow,
    loopBodySteps: Set<string>,
    completed: string[],
    context: EnhancedContext
  ): WorkflowStep | null {
    return workflow.steps.find(step => {
      // Skip if already completed
      if (completed.includes(step.id)) {
        return false;
      }
      
      // Skip if it's a loop body step (unless we're in that loop)
      if (loopBodySteps.has(step.id)) {
        // Check if we're in a loop and this step is part of its body
        const loopStack = context._loopStack || [];
        if (loopStack.length === 0) {
          return false; // Not in loop, skip all body steps
        }
        
        const currentFrame = loopStack[loopStack.length - 1];
        return currentFrame.bodySteps.some(s => s.id === step.id);
      }
      
      // Check runCondition
      if (step.runCondition) {
        return evaluateCondition(step.runCondition, context);
      }
      
      // No condition means step is eligible
      return true;
    }) || null;
  }

  handleNoEligibleStep(
    workflow: Workflow,
    completed: string[],
    context: EnhancedContext,
    loopBodySteps: Set<string>
  ): WorkflowGuidance | null {
    // Find all conditional steps that are blocked
    const blockedSteps = this.findBlockedSteps(
      workflow,
      completed,
      loopBodySteps,
      context
    );
    
    // If no conditional steps, workflow is truly complete
    if (blockedSteps.length === 0) {
      return null;
    }
    
    // Build guidance using pure utility functions
    return buildConditionGuidance(blockedSteps);
  }

  /**
   * Find all conditional steps that are blocked.
   * 
   * Private method - uses condition-analysis utilities for diagnosis.
   */
  private findBlockedSteps(
    workflow: Workflow,
    completed: string[],
    loopBodySteps: Set<string>,
    context: EnhancedContext
  ): BlockedStepInfo[] {
    return workflow.steps
      .filter(step => !completed.includes(step.id))
      .filter(step => !loopBodySteps.has(step.id))
      .filter(step => !!step.runCondition)
      .map(step => {
        const diagnosis = diagnoseConditionFailure(step.runCondition as Condition, context);
        return {
          stepId: step.id,
          stepTitle: step.title,
          condition: step.runCondition as Condition,
          diagnosis,
          relevantContext: this.extractRelevantContext(step.runCondition, context)
        };
      })
      .filter(blocked => blocked.diagnosis.type !== 'match');  // Filter out steps that actually pass
  }

  /**
   * Extract only the context variables referenced by this condition.
   * Reduces noise in diagnosis output.
   */
  private extractRelevantContext(
    condition: any,
    context: ConditionContext
  ): Record<string, any> {
    const vars = new Set<string>();
    this.collectConditionVars(condition, vars);
    
    const relevant: Record<string, any> = {};
    vars.forEach(varName => {
      relevant[varName] = context[varName];
    });
    
    return relevant;
  }

  /**
   * Recursively collect variable names referenced in a condition tree.
   * @param condition - The condition to analyze
   * @param sink - Set to collect variable names into
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

}
