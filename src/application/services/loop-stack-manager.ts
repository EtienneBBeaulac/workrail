import { singleton, inject } from 'tsyringe';
import { WorkflowStep, Workflow } from '../../types/mcp-types';
import { 
  LoopStep, 
  LoopStackFrame, 
  EnhancedContext, 
  LoopHandlerResult,
  isValidLoopStackFrame
} from '../../types/workflow-types';
import { LoopExecutionContext } from './loop-execution-context';
import { LoopStepResolver } from './loop-step-resolver';
import { ILoopContextOptimizer } from '../../types/loop-context-optimizer';
import { evaluateCondition } from '../../utils/condition-evaluator';
import { checkContextSize } from '../../utils/context-size';
import { ContextOptimizer } from './context-optimizer';
import {
  LoopStackCorruptionError,
  EmptyLoopBodyError,
  LoopBodyResolutionError
} from '../../core/error-handler';
import { createLogger } from '../../utils/logger';
import { LoopExecutionState } from '../../types/workflow-types';
import { DI } from '../../di/tokens.js';

/**
 * Manages loop stack lifecycle and operations.
 * 
 * Responsibilities:
 * - Create loop frames when entering loops
 * - Execute loop iterations without recursion
 * - Manage loop state and context
 * - Validate loop stack invariants
 * 
 * This class is extracted from DefaultWorkflowService to follow
 * Single Responsibility Principle and match the existing pattern
 * where LoopExecutionContext is a separate class.
 */
@singleton()
export class LoopStackManager {
  private readonly logger = createLogger('LoopStackManager');

  constructor(
    @inject(LoopStepResolver) private readonly loopStepResolver: LoopStepResolver,
    @inject(DI.Services.LoopContextOptimizer) private readonly contextOptimizer?: ILoopContextOptimizer
  ) {}
  
  /**
   * Creates a loop frame for the given loop step.
   * Returns null if the loop should be skipped (condition false from start).
   * 
   * @param workflow - The workflow containing the loop
   * @param loopStep - The loop step to create a frame for
   * @param context - Current execution context
   * @returns Loop frame if loop should execute, null if should be skipped
   * 
   * @throws {EmptyLoopBodyError} if loop body has no steps
   * @throws {LoopBodyResolutionError} if body step references are invalid
   */
  createLoopFrame(
    workflow: Workflow,
    loopStep: LoopStep,
    context: EnhancedContext
  ): LoopStackFrame | null {
    // Initialize loop context
    const loopContext = new LoopExecutionContext(loopStep.id, loopStep.loop);
    
    // Initialize forEach loops
    if (loopStep.loop.type === 'forEach') {
      loopContext.initializeForEach(context);
    }
    
    // Check if loop should execute at all
    if (!loopContext.shouldContinue(context)) {
      // Loop condition false from start - skip and preserve warnings
      const loopState = loopContext.getCurrentState();
      if (loopState.warnings && loopState.warnings.length > 0) {
        // Note: addWarnings returns a new context, but we don't return the context from this method
        // The warnings will be preserved in the passed context reference for the caller
        const updatedContext = ContextOptimizer.addWarnings(
          context,
          'loops',
          loopStep.id,
          loopState.warnings
        );
        // Copy warnings back to the passed context (since we can't return context from this method)
        context._warnings = updatedContext._warnings;
      }
      return null;
    }
    
    // Resolve and normalize body steps to array
    let bodySteps: WorkflowStep[];
    
    try {
      if (Array.isArray(loopStep.body)) {
        bodySteps = loopStep.body;
      } else {
        const resolved = this.loopStepResolver.resolveLoopBody(
          workflow,
          loopStep.body,
          loopStep.id
        );
        // resolveLoopBody can return WorkflowStep or WorkflowStep[]
        bodySteps = Array.isArray(resolved) ? resolved : [resolved];
      }
    } catch (error) {
      throw new LoopBodyResolutionError(
        `Failed to resolve body for loop ${loopStep.id}: ${error instanceof Error ? error.message : String(error)}`,
        { 
          loopId: loopStep.id, 
          body: loopStep.body, 
          cause: error 
        }
      );
    }
    
    // Validate body is not empty
    if (bodySteps.length === 0) {
      throw new EmptyLoopBodyError(
        `Loop ${loopStep.id} has no body steps`,
        { loopId: loopStep.id }
      );
    }
    
    // Create frame with immutable properties
    const frame: LoopStackFrame = {
      loopId: loopStep.id,
      loopStep,
      loopContext,
      bodySteps: Object.freeze([...bodySteps]),  // Immutable array
      currentBodyIndex: 0
    };
    
    // Validate frame invariants
    this.assertFrameInvariant(frame);
    
    return frame;
  }
  
  /**
   * Handles execution of the current loop (top of stack).
   * Returns the next step to execute, or signals to continue/complete.
   * 
   * CRITICAL: This method contains NO RECURSION.
   * Uses an inner while loop to handle multiple iterations without recursive calls.
   * 
   * @param loopStack - The loop execution stack (will be mutated - frames popped)
   * @param completed - Array of completed step IDs (will be mutated - steps cleared per iteration)
   * @param context - Current execution context
   * @returns Result indicating whether to return a step, continue, or complete
   */
  handleCurrentLoop(
    loopStack: LoopStackFrame[],
    completed: string[],
    context: EnhancedContext
  ): LoopHandlerResult {
    // Create child logger for this specific loop
    const loopLogger = loopStack.length > 0 
      ? this.logger.child(`Loop:${loopStack[loopStack.length - 1]?.loopId || 'unknown'}`)
      : this.logger;
    
    // State transition logging helper
    let currentState: LoopExecutionState | undefined;
    const logTransition = (to: LoopExecutionState, data?: Record<string, unknown>) => {
      loopLogger.debug('Loop state transition', {
        from: currentState,
        to,
        ...data
      });
      currentState = to;
    };
    
    // Inner while loop to handle iterations - NO RECURSION
    while (true) {
      // Stack empty check
      if (loopStack.length === 0) {
        return { type: 'complete' };
      }
      
      const frame = loopStack[loopStack.length - 1];
      
      loopLogger.debug('Handling loop iteration', {
        iteration: frame.loopContext.getCurrentState().iteration,
        bodyIndex: frame.currentBodyIndex,
        bodyLength: frame.bodySteps.length,
        completedCount: completed.length
      });
      
      // Assert frame invariants for corruption detection
      this.assertFrameInvariant(frame);
      
      // Check if loop should continue
      logTransition(LoopExecutionState.CHECKING_LOOP_CONDITION, {
        iteration: frame.loopContext.getCurrentState().iteration
      });
      
      if (!frame.loopContext.shouldContinue(context)) {
        // Loop complete - pop frame and mark as completed
        loopLogger.debug('Loop condition false, popping frame', {
          totalIterations: frame.loopContext.getCurrentState().iteration
        });
        loopStack.pop();
        completed.push(frame.loopId);
        return { type: 'complete' };
      }
      
      // Find next eligible body step in current iteration
      logTransition(LoopExecutionState.SCANNING_BODY, {
        bodyIndex: frame.currentBodyIndex,
        bodyLength: frame.bodySteps.length
      });
      
      while (frame.currentBodyIndex < frame.bodySteps.length) {
        const bodyStep = frame.bodySteps[frame.currentBodyIndex];
        
        // Check if already completed
        if (completed.includes(bodyStep.id)) {
          loopLogger.debug('Step already completed, skipping', { stepId: bodyStep.id });
          frame.currentBodyIndex++;
          continue;
        }
        
        // Inject loop variables for condition evaluation
        const isFirst = frame.loopContext.isFirstIteration();
        const useMinimal = !isFirst && !!this.contextOptimizer;
        let loopEnhancedContext = frame.loopContext.injectVariables(context, useMinimal);
        
        // Apply context optimization if available
        if (useMinimal && this.contextOptimizer) {
          loopEnhancedContext = this.contextOptimizer.stripLoopMetadata(
            loopEnhancedContext as EnhancedContext
          );
        }
        
        // Check context size after injection
        const sizeCheck = checkContextSize(loopEnhancedContext);
        if (sizeCheck.isError) {
          // Context too large - abort loop gracefully
          loopLogger.warn('Context size exceeded, aborting loop', {
            sizeKB: Math.round(sizeCheck.sizeBytes / 1024),
            iteration: frame.loopContext.getCurrentState().iteration
          });
          loopStack.pop();
          completed.push(frame.loopId);
          
          const warning = `Loop ${frame.loopId} aborted at iteration ${frame.loopContext.getCurrentState().iteration}: context size (${Math.round(sizeCheck.sizeBytes / 1024)}KB) exceeded maximum (256KB)`;
          // Note: addWarnings returns a new context, copy warnings back
          const updatedContext = ContextOptimizer.addWarnings(context, 'loops', frame.loopId, [warning]);
          context._warnings = updatedContext._warnings;
          
          return { type: 'complete' };
        }
        
        // Check runCondition for this body step (using loop-enhanced context)
        logTransition(LoopExecutionState.CHECKING_ELIGIBILITY, {
          stepId: bodyStep.id,
          hasCondition: !!bodyStep.runCondition
        });
        
        if (bodyStep.runCondition) {
          const conditionMet = evaluateCondition(bodyStep.runCondition, loopEnhancedContext);
          if (!conditionMet) {
            loopLogger.debug('Step condition false, skipping', { 
              stepId: bodyStep.id,
              condition: bodyStep.runCondition
            });
            frame.currentBodyIndex++;
            continue;
          }
        }
        
        // Found eligible step - return it
        logTransition(LoopExecutionState.RETURNING_BODY_STEP, {
          stepId: bodyStep.id,
          iteration: frame.loopContext.getCurrentState().iteration
        });
        
        return {
          type: 'step',
          result: {
            step: bodyStep,
            isComplete: false,
            guidance: this.buildStepPrompt(bodyStep, frame.loopContext, useMinimal),
            context: sizeCheck.context
          }
        };
      }
      
      // All body steps scanned for this iteration
      logTransition(LoopExecutionState.VALIDATING_ITERATION_COMPLETE);
      
      // Clear completed body steps from this iteration FIRST
      // This ensures we don't double-count steps when checking if iteration is complete
      const clearedSteps: string[] = [];
      frame.bodySteps.forEach(step => {
        const index = completed.indexOf(step.id);
        if (index > -1) {
          clearedSteps.push(step.id);
          completed.splice(index, 1);
        }
      });
      
      if (clearedSteps.length > 0) {
        loopLogger.debug('Cleared body steps from iteration', {
          clearedSteps,
          remainingCompleted: completed.length
        });
      }
      
      // Now check if all eligible steps were completed in this iteration
      // Inject loop variables to evaluate runConditions
      const isFirst = frame.loopContext.isFirstIteration();
      const useMinimal = !isFirst && !!this.contextOptimizer;
      const loopEnhancedContext = frame.loopContext.injectVariables(context, useMinimal);
      
      const eligibleSteps = frame.bodySteps.filter(step => {
        if (!step.runCondition) return true; // No condition = always eligible
        return evaluateCondition(step.runCondition, loopEnhancedContext);
      });
      
      loopLogger.debug('Checking iteration completion', {
        eligible: eligibleSteps.map(s => s.id),
        cleared: clearedSteps
      });
      
      const allEligibleCompleted = eligibleSteps.every(step => clearedSteps.includes(step.id));
      
      if (!allEligibleCompleted) {
        // Not all eligible steps completed - iteration not done
        // This shouldn't normally happen, but could occur if steps are completed out of order
        loopLogger.debug('Not all eligible steps completed, waiting', {
          eligible: eligibleSteps.map(s => s.id),
          completed: clearedSteps
        });
        return { type: 'complete' };
      }
      
      // All eligible body steps completed - increment iteration
      logTransition(LoopExecutionState.INCREMENTING_ITERATION, {
        from: frame.loopContext.getCurrentState().iteration,
        to: frame.loopContext.getCurrentState().iteration + 1
      });
      
      frame.loopContext.incrementIteration();
      frame.currentBodyIndex = 0;
      
      loopLogger.debug('Iteration complete, incremented counter', {
        newIteration: frame.loopContext.getCurrentState().iteration
      });
      
      // Update loop state in context
      context = ContextOptimizer.mergeLoopState(
        context,
        frame.loopId,
        frame.loopContext.getCurrentState()
      );
      
      // Continue to top of while loop (checks shouldContinue again)
      // ✅ NO RECURSION - just loops back to check if loop should continue
    }
  }
  
  /**
   * Builds the step prompt with loop context information.
   * 
   * @param step - The workflow step
   * @param loopContext - Loop execution context for iteration info
   * @param useMinimal - Whether to use minimal context (for subsequent iterations)
   * @returns Guidance object with formatted prompt
   */
  private buildStepPrompt(
    step: WorkflowStep,
    loopContext: LoopExecutionContext,
    useMinimal: boolean
  ): { prompt: string } {
    let prompt = '';
    
    // Add agent role if present
    if (step.agentRole) {
      prompt += `## Agent Role Instructions\n${step.agentRole}\n\n`;
    }
    
    // Add step guidance if present
    if (step.guidance && step.guidance.length > 0) {
      const guidanceHeader = '## Step Guidance';
      const guidanceList = step.guidance.map(g => `- ${g}`).join('\n');
      prompt += `${guidanceHeader}\n${guidanceList}\n\n`;
    }
    
    // Add step prompt
    prompt += step.prompt;
    
    // Add loop context information
    const state = loopContext.getCurrentState();
    prompt += `\n\n## Loop Context\n- Iteration: ${state.iteration + 1}`;
    
    if (useMinimal && !loopContext.isFirstIteration()) {
      prompt += '\n\n_Note: Refer to the phase overview provided in the first iteration for overall context._';
    } else if (state.items) {
      prompt += `\n- Total Items: ${state.items.length}`;
      prompt += `\n- Current Index: ${state.index}`;
    }
    
    return { prompt };
  }
  
  /**
   * Assert that a loop stack frame is in a valid state.
   * Helps catch corruption early before it cascades to other failures.
   * 
   * Can be disabled in production if performance impact is a concern
   * by setting SKIP_INVARIANT_CHECKS=true environment variable.
   * 
   * @param frame - The frame to validate
   * @throws {LoopStackCorruptionError} if frame is invalid
   */
  private assertFrameInvariant(frame: LoopStackFrame): void {
    // Allow disabling for performance (only if absolutely necessary)
    if (process.env.SKIP_INVARIANT_CHECKS === 'true') {
      return;
    }
    
    // Use type guard for comprehensive validation
    if (!isValidLoopStackFrame(frame)) {
      const loopId = (frame && typeof frame === 'object' && 'loopId' in frame) 
        ? (frame as any).loopId 
        : 'unknown';
      throw new LoopStackCorruptionError(
        `Invalid loop stack frame structure for loop ${loopId}`,
        { frame }
      );
    }
    
    // Additional specific checks with clear error messages
    if (frame.currentBodyIndex < 0) {
      throw new LoopStackCorruptionError(
        `Loop ${frame.loopId} has negative body index: ${frame.currentBodyIndex}`,
        { loopId: frame.loopId, bodyIndex: frame.currentBodyIndex }
      );
    }
    
    if (frame.currentBodyIndex > frame.bodySteps.length) {
      throw new LoopStackCorruptionError(
        `Loop ${frame.loopId} body index ${frame.currentBodyIndex} exceeds body length ${frame.bodySteps.length}`,
        { 
          loopId: frame.loopId, 
          bodyIndex: frame.currentBodyIndex, 
          bodyLength: frame.bodySteps.length 
        }
      );
    }
    
    if (frame.bodySteps.length === 0) {
      throw new LoopStackCorruptionError(
        `Loop ${frame.loopId} has empty body steps array`,
        { loopId: frame.loopId }
      );
    }
  }
}
