import { singleton } from 'tsyringe';
import { evaluateCondition } from '../../utils/condition-evaluator';
import { isLoopStepDefinition, WorkflowStepDefinition, LoopStepDefinition } from '../../types/workflow';
import { CompiledWorkflow, CompiledLoop } from './workflow-compiler';
import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import { type DomainError, Err } from '../../domain/execution/error';
import { ExecutionState, LoopFrame } from '../../domain/execution/state';
import { WorkflowEvent } from '../../domain/execution/event';
import { StepInstanceId, toStepInstanceKey } from '../../domain/execution/ids';
import { computeLoopDecision, type LoopKernelError } from '../../v2/durable-core/domain/loop-runtime';
import { evaluateLoopControlFromArtifacts } from '../../v2/durable-core/domain/loop-control-evaluator';
import type { LoopConditionSource } from '../../types/workflow-definition';

export interface NextStep {
  readonly step: WorkflowStepDefinition;
  readonly stepInstanceId: StepInstanceId;
  readonly guidance: { readonly prompt: string; readonly requiresConfirmation?: boolean };
}

export interface InterpreterOutput {
  readonly state: ExecutionState;
  readonly next: NextStep | null;
  readonly isComplete: boolean;
}

@singleton()
export class WorkflowInterpreter {
  applyEvent(state: ExecutionState, event: WorkflowEvent): Result<ExecutionState, DomainError> {
    if (state.kind === 'complete') return ok(state);
    const running = this.ensureRunning(state);
    if (running.isErr()) return err(running.error);

    const s = running.value;
    if (!s.pendingStep) {
      return err(Err.invalidState('No pending step to complete'));
    }

    switch (event.kind) {
      case 'step_completed': {
        const expectedKey = toStepInstanceKey(s.pendingStep);
        const actualKey = toStepInstanceKey(event.stepInstanceId);
        if (expectedKey !== actualKey) {
          return err(
            Err.invalidState(`StepCompleted does not match pendingStep (expected '${expectedKey}', got '${actualKey}')`)
          );
        }

        return ok({
          kind: 'running',
          completed: [...s.completed, expectedKey],
          loopStack: s.loopStack,
          pendingStep: undefined,
        });
      }
      default: {
        // Exhaustive by type; TS should ensure never.
        return err(Err.invalidState('Unsupported event'));
      }
    }
  }

  next(
    compiled: CompiledWorkflow,
    state: ExecutionState,
    context: Record<string, unknown> = {},
    artifacts: readonly unknown[] = []
  ): Result<InterpreterOutput, DomainError> {
    if (state.kind === 'complete') {
      return ok({ state, next: null, isComplete: true });
    }

    const runningRes = this.ensureRunning(state);
    if (runningRes.isErr()) return err(runningRes.error);
    let running = runningRes.value;

    // If a step is pending, return it again (idempotent "what should I do now?")
    if (running.pendingStep) {
      const step = this.lookupStepInstance(compiled, running.pendingStep);
      if (step.isErr()) return err(step.error);
      return ok({
        state: running,
        next: step.value,
        isComplete: false,
      });
    }

    // Main selection loop (bounded to prevent engine infinite loops)
    for (let guard = 0; guard < 10_000; guard++) {
      // If inside a loop, drive it first.
      if (running.loopStack.length > 0) {
        const inLoop = this.nextInCurrentLoop(compiled, running, context, artifacts);
        if (inLoop.isErr()) return err(inLoop.error);
        const result = inLoop.value;
        running = result.state;
        if (result.next) {
          return ok({ state: running, next: result.next, isComplete: false });
        }
        // No next means either:
        // - the loop frame was popped (exited), OR
        // - we advanced loop iteration / skipped within the loop and should continue driving the loop.
        if (running.loopStack.length > 0) {
          continue;
        }
      }

      // Top-level selection
      const top = this.nextTopLevel(compiled, running, context);
      if (top.isErr()) return err(top.error);
      const out = top.value;
      running = out.state;
      if (out.next) {
        return ok({ state: running, next: out.next, isComplete: false });
      }

      // If we entered a loop (or otherwise changed state), continue selection.
      // Only declare completion when we're not in a loop and top-level has nothing eligible.
      if (running.loopStack.length > 0) {
        continue;
      }

      return ok({ state: { kind: 'complete' }, next: null, isComplete: true });
    }

    return err(Err.invalidState('Interpreter exceeded guard iterations (possible infinite loop)'));
  }

  private ensureRunning(state: ExecutionState): Result<Extract<ExecutionState, { kind: 'running' }>, DomainError> {
    if (state.kind === 'init') {
      return ok({ kind: 'running', completed: [], loopStack: [], pendingStep: undefined });
    }
    if (state.kind !== 'running') {
      return err(Err.invalidState(`Unsupported state kind '${(state as any).kind}'`));
    }
    return ok(state);
  }

  private nextTopLevel(
    compiled: CompiledWorkflow,
    state: Extract<ExecutionState, { kind: 'running' }>,
    context: Record<string, unknown>
  ): Result<{ state: Extract<ExecutionState, { kind: 'running' }>; next: NextStep | null }, DomainError> {
    for (const step of compiled.steps) {
      // Skip body steps at top-level
      if (compiled.loopBodyStepIds.has(step.id)) continue;

      // Already completed as top-level instance
      if (state.completed.includes(step.id)) continue;

      // runCondition on top-level step (uses external context)
      if (step.runCondition && !evaluateCondition(step.runCondition as any, context as any)) {
        continue;
      }

      if (isLoopStepDefinition(step)) {
        // Enter loop by pushing a frame, but do not mark loop step as completed.
        const entered: LoopFrame = { loopId: step.id, iteration: 0, bodyIndex: 0 };
        return ok({
          state: { ...state, loopStack: [...state.loopStack, entered] },
          next: null,
        });
      }

      const instance: StepInstanceId = { stepId: step.id, loopPath: [] };
      const next = this.materializeStep(compiled, instance, context);
      if (next.isErr()) return err(next.error);

      return ok({
        state: { ...state, pendingStep: instance },
        next: next.value,
      });
    }

    return ok({ state, next: null });
  }

  private nextInCurrentLoop(
    compiled: CompiledWorkflow,
    state: Extract<ExecutionState, { kind: 'running' }>,
    context: Record<string, unknown>,
    artifacts: readonly unknown[]
  ): Result<{ state: Extract<ExecutionState, { kind: 'running' }>; next: NextStep | null }, DomainError> {
    const frame = state.loopStack[state.loopStack.length - 1];
    const loopCompiled = compiled.compiledLoops.get(frame.loopId);
    if (!loopCompiled) {
      return err(Err.invalidLoop(frame.loopId, 'Loop not found in compiled metadata'));
    }

    const body = loopCompiled.bodySteps;
    const loopPath = [...state.loopStack.map((f) => ({ loopId: f.loopId, iteration: f.iteration }))];
    const completed = new Set(state.completed);

    const ports = {
      shouldEnterIteration: (iteration: number): Result<boolean, LoopKernelError> => {
        switch (loopCompiled.loop.loop.type) {
          case 'for': {
            const count = loopCompiled.loop.loop.count;
            if (typeof count === 'number') {
              return ok(iteration < count);
            }
            if (typeof count === 'string') {
              const raw = (context as any)[count];
              if (typeof raw !== 'number') {
                return err({
                  code: 'LOOP_MISSING_CONTEXT',
                  loopId: loopCompiled.loop.id,
                  message: `for loop '${loopCompiled.loop.id}' requires numeric context['${count}']`,
                });
              }
              return ok(iteration < raw);
            }
            return err({
              code: 'LOOP_INVALID_CONFIG',
              loopId: loopCompiled.loop.id,
              message: `for loop '${loopCompiled.loop.id}' missing count`,
            });
          }
          case 'forEach': {
            const itemsVar = loopCompiled.loop.loop.items;
            if (!itemsVar) {
              return err({
                code: 'LOOP_INVALID_CONFIG',
                loopId: loopCompiled.loop.id,
                message: `forEach loop '${loopCompiled.loop.id}' missing items`,
              });
            }
            const raw = (context as any)[itemsVar];
            if (!Array.isArray(raw)) {
              return err({
                code: 'LOOP_MISSING_CONTEXT',
                loopId: loopCompiled.loop.id,
                message: `forEach loop '${loopCompiled.loop.id}' requires array context['${itemsVar}']`,
              });
            }
            return ok(iteration < raw.length);
          }
          case 'while': {
            return this.evaluateWhileUntilCondition(loopCompiled, iteration, context, artifacts, frame, false);
          }
          case 'until': {
            return this.evaluateWhileUntilCondition(loopCompiled, iteration, context, artifacts, frame, true);
          }
          default:
            return err({
              code: 'LOOP_INVALID_CONFIG',
              loopId: loopCompiled.loop.id,
              message: `Unknown loop type '${(loopCompiled.loop.loop as any).type}'`,
            });
        }
      },

      isBodyIndexEligible: (bodyIndex: number): boolean => {
        const bodyStep = body[bodyIndex];
        if (!bodyStep) return false;

        const instance: StepInstanceId = { stepId: bodyStep.id, loopPath };
        const key = toStepInstanceKey(instance);
        if (completed.has(key)) return false;

        if (!bodyStep.runCondition) return true;

        const projectedContext = this.projectLoopContext(loopCompiled.loop, frame, context);
        return evaluateCondition(bodyStep.runCondition as any, projectedContext as any);
      },
    } as const;

    const decision = computeLoopDecision({
      loopId: frame.loopId,
      iteration: frame.iteration,
      bodyIndex: frame.bodyIndex,
      bodyLength: body.length,
      maxIterations: loopCompiled.loop.loop.maxIterations,
      ports,
    });

    if (decision.isErr()) {
      const e = decision.error;
      switch (e.code) {
        case 'LOOP_MAX_ITERATIONS_REACHED':
          return err(Err.maxIterationsExceeded(e.loopId, e.maxIterations));
        case 'LOOP_MISSING_CONTEXT':
          return err(Err.missingContext(e.message));
        case 'LOOP_INVALID_CONFIG':
          return err(Err.invalidLoop(e.loopId, e.message));
        case 'LOOP_INVALID_STATE':
          return err(Err.invalidState(e.message));
        default:
          return err(Err.invalidState('Unhandled loop kernel error'));
      }
    }

    switch (decision.value.kind) {
      case 'exit_loop': {
        // Exit loop: mark loop step completed as top-level instance and pop frame.
        const popped = state.loopStack.slice(0, -1);
        return ok({
          state: {
            ...state,
            loopStack: popped,
            completed: [...state.completed, frame.loopId],
          },
          next: null,
        });
      }
      case 'advance_iteration': {
        const advanced: LoopFrame = { ...frame, iteration: decision.value.toIteration, bodyIndex: 0 };
        const updatedStack = [...state.loopStack.slice(0, -1), advanced];
        return ok({ state: { ...state, loopStack: updatedStack }, next: null });
      }
      case 'execute_body_step': {
        const bodyStep = body[decision.value.bodyIndex];
        if (!bodyStep) {
          return err(Err.invalidState(`Loop '${frame.loopId}' selected missing bodyIndex ${decision.value.bodyIndex}`));
        }

        const instance: StepInstanceId = { stepId: bodyStep.id, loopPath };
        const projectedContext = this.projectLoopContext(loopCompiled.loop, frame, context);
        const next = this.materializeStep(compiled, instance, projectedContext);
        if (next.isErr()) return err(next.error);

        const updatedTop: LoopFrame = { ...frame, bodyIndex: decision.value.bodyIndex };
        const updatedStack = [...state.loopStack.slice(0, -1), updatedTop];

        return ok({
          state: { ...state, loopStack: updatedStack, pendingStep: instance },
          next: next.value,
        });
      }
      default:
        return err(Err.invalidState('Non-exhaustive loop decision'));
    }
  }

/**
   * Evaluate while/until loop condition by branching exhaustively on conditionSource.
   * 
   * No fallback chain: each source kind is handled independently.
   * - artifact_contract: ONLY checks artifacts. Missing artifact = error.
   * - context_variable: ONLY checks context. No artifact awareness.
   * - undefined (no source): falls back to raw condition field for backward compat.
   * 
   * @param invertForUntil - true for 'until' loops (inverts context-based evaluation)
   */
  private evaluateWhileUntilCondition(
    loopCompiled: CompiledLoop,
    iteration: number,
    context: Record<string, unknown>,
    artifacts: readonly unknown[],
    frame: LoopFrame,
    invertForUntil: boolean
  ): Result<boolean, LoopKernelError> {
    const source: LoopConditionSource | undefined = loopCompiled.conditionSource;

    if (!source) {
      // Legacy: no conditionSource derived (pre-compilation workflows)
      // Fall back to raw condition field
      if (!loopCompiled.loop.loop.condition) {
        return err({
          code: 'LOOP_INVALID_CONFIG',
          loopId: loopCompiled.loop.id,
          message: `${loopCompiled.loop.loop.type} loop '${loopCompiled.loop.id}' missing condition and conditionSource`,
        });
      }
      const raw = evaluateCondition(
        loopCompiled.loop.loop.condition as any,
        this.projectLoopContextAtIteration(loopCompiled.loop, iteration, context) as any
      );
      return ok(invertForUntil ? !raw : raw);
    }

    // Exhaustive switch on conditionSource.kind
    switch (source.kind) {
      case 'artifact_contract': {
        // ONLY artifacts. No context fallback.
        const result = evaluateLoopControlFromArtifacts(artifacts, source.loopId);
        if (result.kind === 'found') {
          return ok(result.decision === 'continue');
        }
        // Missing or invalid artifact = error (not silent exit)
        return err({
          code: 'LOOP_MISSING_CONTEXT',
          loopId: loopCompiled.loop.id,
          message: result.kind === 'not_found'
            ? `Loop '${source.loopId}' requires a wr.loop_control artifact but none was provided`
            : `Loop '${source.loopId}' has an invalid loop control artifact: ${result.reason}`,
        });
      }
      case 'context_variable': {
        // ONLY context. No artifact awareness.
        const raw = evaluateCondition(
          source.condition as any,
          this.projectLoopContextAtIteration(loopCompiled.loop, iteration, context) as any
        );
        return ok(invertForUntil ? !raw : raw);
      }
      default: {
        // Exhaustiveness check
        const _exhaustive: never = source;
        return err({
          code: 'LOOP_INVALID_CONFIG',
          loopId: loopCompiled.loop.id,
          message: `Unknown conditionSource kind: ${(_exhaustive as any).kind}`,
        });
      }
    }
  }

  private projectLoopContextAtIteration(
    loop: LoopStepDefinition,
    iteration: number,
    base: Record<string, unknown>
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };

    const iterationVar = loop.loop.iterationVar || 'currentIteration';
    out[iterationVar] = iteration + 1; // 1-based for agents

    if (loop.loop.type === 'forEach') {
      const itemsVar = loop.loop.items!;
      const raw = (base as any)[itemsVar];
      if (Array.isArray(raw)) {
        const index = iteration;
        const itemVar = loop.loop.itemVar || 'currentItem';
        const indexVar = loop.loop.indexVar || 'currentIndex';
        out[itemVar] = raw[index];
        out[indexVar] = index;
      }
    }

    return out;
  }

  private projectLoopContext(loop: LoopStepDefinition, frame: LoopFrame, base: Record<string, unknown>): Record<string, unknown> {
    return this.projectLoopContextAtIteration(loop, frame.iteration, base);
  }

  private lookupStepInstance(compiled: CompiledWorkflow, id: StepInstanceId): Result<NextStep, DomainError> {
    const step = compiled.stepById.get(id.stepId) as WorkflowStepDefinition | LoopStepDefinition | undefined;
    if (!step) return err(Err.invalidState(`Unknown stepId '${id.stepId}'`));
    if (isLoopStepDefinition(step)) return err(Err.invalidState(`pendingStep cannot be a loop step ('${id.stepId}')`));
    return this.materializeStep(compiled, id, {});
  }

  private materializeStep(
    compiled: CompiledWorkflow,
    instance: StepInstanceId,
    context: Record<string, unknown>
  ): Result<NextStep, DomainError> {
    const step = compiled.stepById.get(instance.stepId) as WorkflowStepDefinition | LoopStepDefinition | undefined;
    if (!step) return err(Err.invalidState(`Unknown stepId '${instance.stepId}'`));
    if (isLoopStepDefinition(step)) {
      return err(Err.invalidState(`Cannot execute loop step '${step.id}' directly`));
    }

    const promptParts: string[] = [];
    if (step.agentRole) {
      promptParts.push(`## Agent Role Instructions\n${step.agentRole}\n`);
    }
    if (step.guidance && step.guidance.length > 0) {
      promptParts.push(`## Step Guidance\n${step.guidance.map((g) => `- ${g}`).join('\n')}\n`);
    }
    promptParts.push(step.prompt);

    // Minimal loop info for UX (derived from instance.loopPath)
    if (instance.loopPath.length > 0) {
      const current = instance.loopPath[instance.loopPath.length - 1];
      promptParts.push(`\n\n## Loop Context\n- Loop: ${current.loopId}\n- Iteration: ${current.iteration + 1}`);
    }

    return ok({
      step,
      stepInstanceId: instance,
      guidance: {
        prompt: promptParts.join('\n'),
        requiresConfirmation: !!step.requireConfirmation,
      },
    });
  }
}
