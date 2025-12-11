import { singleton } from 'tsyringe';
import { Workflow, WorkflowStepDefinition } from '../../types/workflow';
import { WorkflowGuidance } from '../../types/mcp-types';
import { IStepSelector } from './i-step-selector';
import { EnhancedContext } from '../../types/workflow-types';
import { evaluateCondition } from '../../utils/condition-evaluator';
import { createLogger } from '../../utils/logger';

/**
 * Default implementation of step selection logic.
 * 
 * Responsibilities:
 * - Find eligible steps based on conditions and state
 * - Generate guidance when no eligible steps found
 */
@singleton()
export class DefaultStepSelector implements IStepSelector {
  private readonly logger = createLogger('StepSelector');

  findEligibleStep(
    workflow: Workflow,
    loopBodySteps: Set<string>,
    completed: string[],
    context: EnhancedContext
  ): WorkflowStepDefinition | null {
    return workflow.definition.steps.find(step => {
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
    // Check if there are conditional steps with unmet conditions
    const remainingConditionalSteps = workflow.definition.steps.filter((step) => {
      if (completed.includes(step.id)) return false;
      if (loopBodySteps.has(step.id)) return false;
      return !!step.runCondition;
    });

    if (remainingConditionalSteps.length > 0) {
      // Collect variables referenced by remaining step conditions
      const requiredVars = new Set<string>();
      const allowedValues: Record<string, Set<string>> = {};

      for (const step of remainingConditionalSteps) {
        const condition = step.runCondition;
        this.collectConditionVars(condition, requiredVars);
        this.collectEqualsValues(condition, allowedValues);
      }

      // Build guidance message
      const issues: string[] = [];
      for (const variableName of requiredVars) {
        const currentValue = (context as any)[variableName];
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

      if (issues.length > 0) {
        return {
          prompt: `No eligible step due to unmet conditions. Please update context:\n- ${issues.join('\n- ')}`
        };
      }
    }

    // No conditional steps or all conditions met - workflow is truly complete
    return null;
  }

  /**
   * Recursively collect variable names referenced in a condition tree.
   * @param condition - The condition to analyze
   * @param sink - Set to collect variable names into
   */
  private collectConditionVars(condition: unknown, sink: Set<string>): void {
    if (!condition || typeof condition !== 'object') return;
    const cond = condition as Record<string, unknown>;
    if (typeof cond['var'] === 'string' && cond['var'].length > 0) {
      sink.add(cond['var']);
    }
    if (Array.isArray(cond['and'])) {
      for (const sub of cond['and']) this.collectConditionVars(sub, sink);
    }
    if (Array.isArray(cond['or'])) {
      for (const sub of cond['or']) this.collectConditionVars(sub, sink);
    }
    if (cond['not']) this.collectConditionVars(cond['not'], sink);
  }

  /**
   * Recursively collect enumerated equals values per variable from conditions.
   * Only simple { var: 'x', equals: value } pairs are captured.
   * @param condition - The condition to analyze
   * @param sink - Map of variable name to set of allowed values
   */
  private collectEqualsValues(condition: unknown, sink: Record<string, Set<string>>): void {
    if (!condition || typeof condition !== 'object') return;
    const cond = condition as Record<string, unknown>;
    if (typeof cond['var'] === 'string' && Object.prototype.hasOwnProperty.call(cond, 'equals')) {
      const variableName = cond['var'];
      const value = cond['equals'];
      if (value !== undefined && value !== null) {
        if (!sink[variableName]) sink[variableName] = new Set<string>();
        sink[variableName].add(String(value));
      }
    }
    if (Array.isArray(cond['and'])) {
      for (const sub of cond['and']) this.collectEqualsValues(sub, sink);
    }
    if (Array.isArray(cond['or'])) {
      for (const sub of cond['or']) this.collectEqualsValues(sub, sink);
    }
    if (cond['not']) this.collectEqualsValues(cond['not'], sink);
  }
}
