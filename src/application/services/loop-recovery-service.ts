import { singleton, inject } from 'tsyringe';
import { Workflow } from '../../types/mcp-types';
import { ILoopRecoveryService } from './i-loop-recovery-service';
import { LoopStackFrame, LoopStep, EnhancedContext, isLoopStep, setBodyIndex } from '../../types/workflow-types';
import { LoopStackManager } from './loop-stack-manager';
import { ContextOptimizer } from './context-optimizer';
import { createLogger } from '../../utils/logger';

/**
 * Default implementation of loop state recovery.
 * 
 * Responsibilities:
 * - Reconstruct loop stack from completed steps when _loopStack is missing
 * - Calculate correct iteration count
 * - Fast-forward loop context to current iteration
 * - Set correct body index for resumption
 * 
 * This service enables stateless MCP agents to recover mid-loop execution state.
 */
@singleton()
export class DefaultLoopRecoveryService implements ILoopRecoveryService {
  private readonly logger = createLogger('LoopRecoveryService');

  constructor(@inject(LoopStackManager) private readonly loopStackManager: LoopStackManager) {}

  recoverLoopStack(
    workflow: Workflow,
    completed: string[],
    context: EnhancedContext,
    loopBodySteps: Set<string>
  ): LoopStackFrame[] {
    const loopStack: LoopStackFrame[] = [];
    
    // Early exit: Loop stack already exists
    if (context._loopStack && context._loopStack.length > 0) {
      this.logger.debug('Loop stack already exists, no recovery needed');
      return context._loopStack;
    }
    
    // Early exit: No completed steps to analyze
    if (completed.length === 0) {
      return loopStack;
    }
    
    // Find completed loop body steps
    const completedLoopBodySteps = completed.filter(stepId => loopBodySteps.has(stepId));
    
    if (completedLoopBodySteps.length === 0) {
      return loopStack;
    }
    
    this.logger.debug('Attempting loop state recovery', {
      completedLoopBodySteps: completedLoopBodySteps.length,
      totalCompleted: completed.length
    });
    
    // Find which loop these steps belong to
    for (const step of workflow.steps) {
      if (!isLoopStep(step)) continue;
      
      const loopStep = step as LoopStep;
      const bodyStepIds = this.getBodyStepIds(loopStep);
      
      // Check if any completed steps are from this loop's body
      const loopBodyMatches = completedLoopBodySteps.filter(id => bodyStepIds.has(id));
      
      if (loopBodyMatches.length > 0 && !completed.includes(loopStep.id)) {
        // We're in this loop but lost the stack - reconstruct it
        this.logger.debug('Recovering loop state', {
          loopId: loopStep.id,
          matchedBodySteps: loopBodyMatches.length
        });
        
        try {
          const loopFrame = this.reconstructLoopFrame(
            workflow,
            loopStep,
            context,
            loopBodyMatches,
            bodyStepIds,
            completed
          );
          
          if (loopFrame) {
            loopStack.push(loopFrame);
            this.logger.debug('Loop state recovered successfully', {
              loopId: loopFrame.loopId,
              iteration: loopFrame.loopContext.getCurrentState().iteration,
              bodyIndex: loopFrame.currentBodyIndex
            });
          }
        } catch (error) {
          // Recovery failed - log and continue without recovery
          this.logger.warn('Failed to recover loop state', error, {
            loopId: loopStep.id
          });
        }
        
        // Only recover one loop at a time
        break;
      }
    }
    
    return loopStack;
  }

  /**
   * Reconstructs a loop frame from execution history.
   * 
   * @param workflow - The workflow containing the loop
   * @param loopStep - The loop step to reconstruct
   * @param context - Current context (may contain iteration variables)
   * @param loopBodyMatches - Completed body steps for this loop
   * @param bodyStepIds - All body step IDs for this loop
   * @param completed - Completed steps array (MUTATED - body steps removed)
   * @returns Reconstructed loop frame or null if reconstruction fails
   */
  private reconstructLoopFrame(
    workflow: Workflow,
    loopStep: LoopStep,
    context: EnhancedContext,
    loopBodyMatches: string[],
    bodyStepIds: Set<string>,
    completed: string[]
  ): LoopStackFrame | null {
    // Create initial loop frame
    const loopFrame = this.loopStackManager.createLoopFrame(
      workflow,
      loopStep,
      context
    );
    
    if (!loopFrame) {
      return null; // Loop shouldn't execute
    }
    
    // Calculate how many iterations have been completed
    const bodySteps = loopFrame.bodySteps;
    const hasConditionalSteps = bodySteps.some(s => s.runCondition);
    
    let iterationsCompleted = 0;
    
    // Check if loop has an iteration variable in the context (most reliable)
    const iterationVar = loopStep.loop.iterationVar || 'currentIteration';
    const contextIteration = context[iterationVar];
    
    if (typeof contextIteration === 'number' && contextIteration > 0) {
      // Use iteration from context (most accurate)
      // Subtract 1 because iterations are 1-indexed but we increment from 0
      iterationsCompleted = contextIteration - 1;
      
      this.logger.debug('Using iteration from context', {
        iterationVar,
        contextValue: contextIteration,
        iterationsCompleted
      });
    } else if (hasConditionalSteps) {
      // For conditional bodies: use conservative estimate
      // (completed steps - 1) to stay in current iteration
      iterationsCompleted = Math.max(0, loopBodyMatches.length - 1);
      
      this.logger.debug('Estimated iterations for conditional body', {
        completedBodySteps: loopBodyMatches.length,
        iterationsCompleted
      });
    } else {
      // For non-conditional bodies: completed steps / body length = complete iterations
      iterationsCompleted = Math.floor(loopBodyMatches.length / bodySteps.length);
      
      this.logger.debug('Calculated iterations for non-conditional body', {
        completedBodySteps: loopBodyMatches.length,
        bodyStepCount: bodySteps.length,
        iterationsCompleted
      });
    }
    
    // Fast-forward the loop context to the correct iteration
    // NOTE: loopContext is intentionally mutable - manages iteration state
    for (let i = 0; i < iterationsCompleted; i++) {
      loopFrame.loopContext.incrementIteration();
    }
    
    // Calculate resume index
    // Find the index of the last completed body step + 1
    let resumeIndex = 0;
    for (let i = loopFrame.bodySteps.length - 1; i >= 0; i--) {
      if (completed.includes(loopFrame.bodySteps[i].id)) {
        resumeIndex = i + 1;
        break;
      }
    }
    
    // Create frame with correct index (immutable operation)
    const frameWithCorrectIndex = setBodyIndex(loopFrame, resumeIndex);
    
    // Clear completed body steps so iteration logic works correctly
    bodyStepIds.forEach(stepId => {
      const idx = completed.indexOf(stepId);
      if (idx > -1) completed.splice(idx, 1);
    });
    
    this.logger.debug('Cleared completed body steps for clean iteration tracking', {
      clearedCount: loopBodyMatches.length,
      resumeIndex
    });
    
    return frameWithCorrectIndex;
  }

  /**
   * Gets the set of body step IDs for a specific loop.
   * 
   * @param loopStep - The loop step to analyze
   * @returns Set of step IDs in this loop's body
   */
  private getBodyStepIds(loopStep: LoopStep): Set<string> {
    const bodyStepIds = new Set<string>();
    
    if (typeof loopStep.body === 'string') {
      bodyStepIds.add(loopStep.body);
    } else if (Array.isArray(loopStep.body)) {
      loopStep.body.forEach(bodyStep => {
        bodyStepIds.add(bodyStep.id);
      });
    }
    
    return bodyStepIds;
  }
}
