import { singleton, inject } from 'tsyringe';
import { WorkflowStep, Workflow } from '../../types/mcp-types';
import { 
  LoopStep, 
  LoopStackFrame, 
  EnhancedContext, 
  LoopHandlerResult,
  LoopContinuationResult,
  BodyScanResult,
  IterationCompletionResult,
  StepEligibilityResult,
  isValidLoopStackFrame,
  createLoopStackFrame,
  advanceBodyIndex,
  resetBodyIndex,
  replaceTopFrame
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
import type { Logger, ILoggerFactory } from '../../core/logging/index.js';
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
  private readonly logger: Logger;

  constructor(
    @inject(LoopStepResolver) private readonly loopStepResolver: LoopStepResolver,
    @inject(DI.Services.LoopContextOptimizer) private readonly contextOptimizer: ILoopContextOptimizer | undefined,
    @inject(DI.Logging.Factory) loggerFactory: ILoggerFactory,
  ) {
    this.logger = loggerFactory.create('LoopStackManager');
  }
  
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
    
    // Create frame using smart constructor (enforces immutability)
    const frame = createLoopStackFrame(
      loopStep.id,
      loopStep,
      loopContext,
      bodySteps,
      0
    );
    
    // Validate frame invariants
    this.assertFrameInvariant(frame);
    
    return frame;
  }
  
  /**
   * Handles execution of the current loop (top of stack).
   * Returns the next step to execute, or signals to continue/complete.
   * 
   * REFACTORED: Now delegates to lifecycle methods for clarity.
   * CRITICAL: This method contains NO RECURSION.
   * 
   * @param loopStack - The loop execution stack (will be mutated - frames popped/replaced)
   * @param completed - Array of completed step IDs (will be mutated - steps cleared per iteration)
   * @param context - Current execution context
   * @returns Result indicating whether to return a step, continue, or complete
   */
  handleCurrentLoop(
    loopStack: LoopStackFrame[],
    completed: string[],
    context: EnhancedContext
  ): LoopHandlerResult {
    // Main iteration loop - NO RECURSION
    while (true) {
      // Guard: Empty stack
      if (loopStack.length === 0) {
        return { type: 'complete' };
      }
      
      let frame = loopStack[loopStack.length - 1];
      
      this.logger.debug({
        loopId: frame.loopId,
        iteration: frame.loopContext.getCurrentState().iteration,
        bodyIndex: frame.currentBodyIndex,
      }, 'Handling loop iteration');
      
      // Validate frame structure
      this.assertFrameInvariant(frame);
      
      // PHASE 1: Should loop continue?
      const continuation = this.checkLoopContinuation(frame, context);
      if (continuation.type === 'stop') {
        return this.exitLoop(loopStack, frame, completed, context, continuation);
      }
      
      // PHASE 2: Find next eligible step in body
      const scan = this.scanBodyForNextStep(frame, loopStack, completed, context);
      
      if (scan.type === 'found-step') {
        return { type: 'step', result: scan.result };
      }
      
      if (scan.type === 'abort-loop') {
        return this.abortLoop(loopStack, frame, completed, context, scan);
      }
      
      // PHASE 3: Complete iteration and advance
      const iteration = this.completeIteration(
        scan.frame,  // Use frame from scan (may have advanced index)
        loopStack, 
        completed, 
        context
      );
      
      if (iteration.type === 'incomplete') {
        return { type: 'complete' };  // Waiting for steps
      }
      
      // Update for next iteration
      frame = iteration.frame;
      context = iteration.context;
      
      // Loop back to check continuation again
    }
  }
  
  /**
   * PHASE 1: Determine if loop should continue executing.
   * 
   * Checks loop-specific condition and safety limits.
   * 
   * @returns 'continue' if loop should keep running, 'stop' with reason if done
   */
  private checkLoopContinuation(
    frame: LoopStackFrame,
    context: EnhancedContext
  ): LoopContinuationResult {
    const shouldContinue = frame.loopContext.shouldContinue(context);
    
    if (!shouldContinue) {
      const state = frame.loopContext.getCurrentState();
      
      const reason = state.iteration >= frame.loopStep.loop.maxIterations
        ? 'max-iterations' as const
        : 'condition-false' as const;
      
      return {
        type: 'stop',
        reason,
        warnings: state.warnings
      };
    }
    
    return {
      type: 'continue',
      iteration: frame.loopContext.getCurrentState().iteration
    };
  }

  /**
   * Exit loop cleanly.
   * Pops frame, marks loop complete, preserves warnings.
   */
  private exitLoop(
    loopStack: LoopStackFrame[],
    frame: LoopStackFrame,
    completed: string[],
    context: EnhancedContext,
    continuation: Extract<LoopContinuationResult, { type: 'stop' }>
  ): LoopHandlerResult {
    this.logger.debug({
      loopId: frame.loopId,
      reason: continuation.reason,
      iterations: frame.loopContext.getCurrentState().iteration,
    }, 'Exiting loop');
    
    loopStack.pop();
    completed.push(frame.loopId);
    
    if (continuation.warnings && continuation.warnings.length > 0) {
      const updated = ContextOptimizer.addWarnings(
        context,
        'loops',
        frame.loopId,
        continuation.warnings
      );
      context._warnings = updated._warnings;
    }
    
    return { type: 'complete' };
  }

  /**
   * PHASE 2: Scan loop body for next eligible step.
   * 
   * Advances frame.currentBodyIndex as it scans (creates new frames).
   * Stops at first eligible step or when body complete.
   * 
   * @param frame - Current frame (will be replaced in stack if advanced)
   * @param loopStack - Stack (will be mutated - frame replaced at top)
   * @param completed - Completed steps
   * @param context - Execution context
   * @returns What the scan found (step, completion, or abort)
   */
  private scanBodyForNextStep(
    frame: LoopStackFrame,
    loopStack: LoopStackFrame[],
    completed: string[],
    context: EnhancedContext
  ): BodyScanResult {
    let currentFrame = frame;
    
    this.logger.debug({
      bodyIndex: currentFrame.currentBodyIndex,
      bodyLength: currentFrame.bodySteps.length,
    }, 'Scanning loop body');
    
    while (currentFrame.currentBodyIndex < currentFrame.bodySteps.length) {
      const bodyStep = currentFrame.bodySteps[currentFrame.currentBodyIndex];
      
      const eligibility = this.checkStepEligibility(bodyStep, currentFrame, completed, context);
      
      switch (eligibility.type) {
        case 'skip':
          this.logger.debug({
            stepId: bodyStep.id,
            reason: eligibility.reason,
          }, 'Skipping step');
          currentFrame = replaceTopFrame(loopStack, advanceBodyIndex(currentFrame));
          continue;
        
        case 'abort':
          this.logger.warn({
            loopId: currentFrame.loopId,
            reason: eligibility.reason,
            sizeKB: eligibility.sizeKB,
          }, 'Aborting loop');
          return {
            type: 'abort-loop',
            reason: eligibility.reason,
            sizeKB: eligibility.sizeKB
          };
        
        case 'eligible':
          this.logger.debug({
            stepId: bodyStep.id,
            iteration: currentFrame.loopContext.getCurrentState().iteration,
          }, 'Found eligible step');
          return {
            type: 'found-step',
            result: {
              step: bodyStep,
              isComplete: false,
              guidance: eligibility.guidance,
              context: eligibility.context
            }
          };
      }
    }
    
    this.logger.debug('Body scan complete, no eligible steps');
    return {
      type: 'body-complete',
      frame: currentFrame
    };
  }

  /**
   * Check if a specific step can run.
   * 
   * Checks (in order):
   * 1. Already completed? → skip
   * 2. Context too large? → abort loop
   * 3. Condition unmet? → skip
   * 4. Otherwise → eligible
   */
  private checkStepEligibility(
    step: WorkflowStep,
    frame: LoopStackFrame,
    completed: string[],
    context: EnhancedContext
  ): StepEligibilityResult {
    if (completed.includes(step.id)) {
      return { type: 'skip', reason: 'already-completed' };
    }
    
    const prepared = this.prepareLoopContext(frame, context);
    
    const sizeCheck = checkContextSize(prepared);
    if (sizeCheck.isError) {
      return {
        type: 'abort',
        reason: 'context-size',
        sizeKB: Math.round(sizeCheck.sizeBytes / 1024)
      };
    }
    
    if (step.runCondition) {
      const conditionMet = evaluateCondition(step.runCondition, prepared);
      if (!conditionMet) {
        return { type: 'skip', reason: 'condition-false' };
      }
    }
    
    // Determine if this is first iteration for prompt building
    const isFirst = frame.loopContext.isFirstIteration();
    const useMinimal = !isFirst && !!this.contextOptimizer;
    
    return {
      type: 'eligible',
      context: sizeCheck.context as EnhancedContext,
      guidance: this.buildStepPrompt(step, frame.loopContext, useMinimal)
    };
  }

  /**
   * Prepare context for step evaluation.
   * Injects loop variables and optimizes if not first iteration.
   */
  private prepareLoopContext(
    frame: LoopStackFrame,
    context: EnhancedContext
  ): EnhancedContext {
    const isFirst = frame.loopContext.isFirstIteration();
    const useMinimal = !isFirst && !!this.contextOptimizer;
    
    let prepared = frame.loopContext.injectVariables(context, useMinimal);
    
    if (useMinimal && this.contextOptimizer) {
      prepared = this.contextOptimizer.stripLoopMetadata(prepared as EnhancedContext);
    }
    
    return prepared;
  }

  /**
   * PHASE 3: Complete current iteration and advance to next.
   * 
   * Steps:
   * 1. Clear completed body steps from this iteration
   * 2. Validate all eligible steps were completed
   * 3. Increment iteration counter
   * 4. Reset body index to 0
   * 5. Update context with new iteration state
   * 
   * @returns 'complete' with updated frame/context, or 'incomplete' if waiting
   */
  private completeIteration(
    frame: LoopStackFrame,
    loopStack: LoopStackFrame[],
    completed: string[],
    context: EnhancedContext
  ): IterationCompletionResult {
    this.logger.debug({
      iteration: frame.loopContext.getCurrentState().iteration,
    }, 'Completing iteration');
    
    const clearedSteps = this.clearCompletedBodySteps(frame, completed);
    
    const validation = this.validateIterationComplete(frame, clearedSteps, context);
    if (validation.type === 'incomplete') {
      return validation;
    }
    
    frame.loopContext.incrementIteration();
    
    const newFrame = replaceTopFrame(loopStack, resetBodyIndex(frame));
    
    const newContext = ContextOptimizer.mergeLoopState(
      context,
      newFrame.loopId,
      newFrame.loopContext.getCurrentState()
    );
    
    this.logger.debug({
      newIteration: newFrame.loopContext.getCurrentState().iteration,
    }, 'Iteration advanced');
    
    return {
      type: 'complete',
      frame: newFrame,
      context: newContext
    };
  }

  /**
   * Clear completed body steps from the completed array.
   * This prevents double-counting when checking iteration completion.
   * 
   * @param frame - Current frame
   * @param completed - Completed steps array (MUTATED - steps removed)
   * @returns Array of step IDs that were cleared
   */
  private clearCompletedBodySteps(
    frame: LoopStackFrame,
    completed: string[]
  ): string[] {
    const clearedSteps: string[] = [];
    
    frame.bodySteps.forEach(step => {
      const index = completed.indexOf(step.id);
      if (index > -1) {
        clearedSteps.push(step.id);
        completed.splice(index, 1);
      }
    });
    
    if (clearedSteps.length > 0) {
      this.logger.debug({
        cleared: clearedSteps,
        remaining: completed.length,
      }, 'Cleared body steps from iteration');
    }
    
    return clearedSteps;
  }

  /**
   * Validate that all eligible steps in this iteration were completed.
   * 
   * A step is eligible if:
   * - It has no runCondition, OR
   * - Its runCondition evaluates to true
   * 
   * @returns 'valid' if ready to advance, 'incomplete' with missing steps if not
   */
  private validateIterationComplete(
    frame: LoopStackFrame,
    clearedSteps: string[],
    context: EnhancedContext
  ): { type: 'valid' } | IterationCompletionResult {
    const prepared = this.prepareLoopContext(frame, context);
    
    const eligibleSteps = frame.bodySteps.filter(step => {
      if (!step.runCondition) return true;
      return evaluateCondition(step.runCondition, prepared);
    });
    
    const missingSteps = eligibleSteps
      .filter(step => !clearedSteps.includes(step.id))
      .map(step => step.id);
    
    if (missingSteps.length > 0) {
      this.logger.debug({
        eligible: eligibleSteps.map(s => s.id),
        cleared: clearedSteps,
        missing: missingSteps,
      }, 'Iteration incomplete');
      
      return {
        type: 'incomplete',
        reason: 'waiting-for-steps',
        missingSteps
      };
    }
    
    return { type: 'valid' };
  }

  /**
   * Abort loop due to context size exceeded.
   */
  private abortLoop(
    loopStack: LoopStackFrame[],
    frame: LoopStackFrame,
    completed: string[],
    context: EnhancedContext,
    scan: Extract<BodyScanResult, { type: 'abort-loop' }>
  ): LoopHandlerResult {
    this.logger.warn({
      loopId: frame.loopId,
      sizeKB: scan.sizeKB,
      iteration: frame.loopContext.getCurrentState().iteration,
    }, 'Context size exceeded, aborting loop');
    
    loopStack.pop();
    completed.push(frame.loopId);
    
    const warning = 
      `Loop ${frame.loopId} aborted at iteration ${frame.loopContext.getCurrentState().iteration}: ` +
      `context size (${scan.sizeKB}KB) exceeded maximum (256KB)`;
    
    const updatedContext = ContextOptimizer.addWarnings(context, 'loops', frame.loopId, [warning]);
    context._warnings = updatedContext._warnings;
    
    return { type: 'complete' };
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
