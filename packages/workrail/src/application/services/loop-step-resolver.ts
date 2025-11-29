import { singleton } from 'tsyringe';
import { Workflow, WorkflowStep } from '../../types/mcp-types';
import { LoopStep, isLoopStep } from '../../types/workflow-types';
import { StepNotFoundError } from '../../core/error-handler';

/**
 * Resolves step references within loop bodies.
 * Handles both string references and inline step arrays.
 */
@singleton()
export class LoopStepResolver {
  private resolvedStepsCache: Map<string, WorkflowStep | WorkflowStep[]> = new Map();
  private static readonly MAX_CACHE_SIZE = 1000; // Prevent unbounded growth

  /**
   * Resolves a loop body reference to actual steps
   * @param workflow The workflow containing the steps
   * @param body The loop body (string reference or inline steps)
   * @param currentLoopId Optional current loop ID to check for self-reference
   * @returns Resolved steps
   * @throws StepNotFoundError if referenced step doesn't exist
   */
  resolveLoopBody(
    workflow: Workflow, 
    body: string | WorkflowStep[], 
    currentLoopId?: string
  ): WorkflowStep | WorkflowStep[] {
    // Handle inline steps directly
    if (Array.isArray(body)) {
      return body;
    }

    // Check cache first
    const cacheKey = `${workflow.id}:${body}`;
    if (this.resolvedStepsCache.has(cacheKey)) {
      return this.resolvedStepsCache.get(cacheKey)!;
    }

    // Find the referenced step
    const referencedStep = this.findStepById(workflow, body);
    if (!referencedStep) {
      throw new StepNotFoundError(workflow.id, body);
    }

    // Prevent circular references - a loop step cannot reference itself
    if (currentLoopId && body === currentLoopId) {
      throw new Error(`Circular reference detected: loop step '${body}' references itself`);
    }

    // Cache and return (with eviction policy to prevent memory leak)
    if (this.resolvedStepsCache.size >= LoopStepResolver.MAX_CACHE_SIZE) {
      // Simple FIFO eviction: remove oldest entry
      const firstKey = this.resolvedStepsCache.keys().next().value;
      if (firstKey) {
        this.resolvedStepsCache.delete(firstKey);
      }
    }
    
    this.resolvedStepsCache.set(cacheKey, referencedStep);
    return referencedStep;
  }

  /**
   * Validates that a step reference exists in the workflow
   * @param workflow The workflow to search
   * @param stepId The step ID to validate
   * @returns true if the step exists
   */
  validateStepReference(workflow: Workflow, stepId: string): boolean {
    return this.findStepById(workflow, stepId) !== null;
  }

  /**
   * Finds all step references in a workflow (for validation)
   * @param workflow The workflow to analyze
   * @returns Array of step IDs that are referenced by loops
   */
  findAllLoopReferences(workflow: Workflow): string[] {
    const references: string[] = [];
    
    for (const step of workflow.steps) {
      if (isLoopStep(step)) {
        const loopStep = step as LoopStep;
        if (typeof loopStep.body === 'string') {
          references.push(loopStep.body);
        }
      }
    }
    
    return references;
  }

  /**
   * Validates all loop references in a workflow
   * @param workflow The workflow to validate
   * @throws Error if any invalid references are found
   */
  validateAllReferences(workflow: Workflow): void {
    const references = this.findAllLoopReferences(workflow);
    const stepIds = new Set(workflow.steps.map(s => s.id));
    
    for (const ref of references) {
      if (!stepIds.has(ref)) {
        throw new StepNotFoundError(workflow.id, ref);
      }
    }

    // Check for circular references
    for (const step of workflow.steps) {
      if (isLoopStep(step)) {
        const loopStep = step as LoopStep;
        if (typeof loopStep.body === 'string' && loopStep.body === loopStep.id) {
          throw new Error(`Circular reference detected: loop step '${loopStep.id}' references itself`);
        }
      }
    }
  }

  /**
   * Clears the resolved steps cache
   */
  clearCache(): void {
    this.resolvedStepsCache.clear();
  }

  /**
   * Gets the current cache size (for monitoring)
   */
  getCacheSize(): number {
    return this.resolvedStepsCache.size;
  }

  /**
   * Find a step by ID in the workflow
   * @private
   */
  private findStepById(workflow: Workflow, stepId: string): WorkflowStep | null {
    return workflow.steps.find(s => s.id === stepId) || null;
  }
} 