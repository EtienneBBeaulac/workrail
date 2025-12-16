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

  next(compiled: CompiledWorkflow, state: ExecutionState, context: Record<string, unknown> = {}): Result<InterpreterOutput, DomainError> {
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
        const inLoop = this.nextInCurrentLoop(compiled, running, context);
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
    context: Record<string, unknown>
  ): Result<{ state: Extract<ExecutionState, { kind: 'running' }>; next: NextStep | null }, DomainError> {
    const frame = state.loopStack[state.loopStack.length - 1];
    const loopCompiled = compiled.compiledLoops.get(frame.loopId);
    if (!loopCompiled) {
      return err(Err.invalidLoop(frame.loopId, 'Loop not found in compiled metadata'));
    }

    // Check continuation before selecting body step
    const shouldContinue = this.shouldContinueLoop(loopCompiled.loop, frame, context);
    if (shouldContinue.isErr()) return err(shouldContinue.error);
    if (!shouldContinue.value) {
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

    // Find next eligible body step
    const body = loopCompiled.bodySteps;
    for (let i = frame.bodyIndex; i < body.length; i++) {
      const bodyStep = body[i];
      const instance: StepInstanceId = {
        stepId: bodyStep.id,
        loopPath: [...state.loopStack.map((f) => ({ loopId: f.loopId, iteration: f.iteration }))],
      };
      const key = toStepInstanceKey(instance);
      if (state.completed.includes(key)) continue;

      const projectedContext = this.projectLoopContext(loopCompiled.loop, frame, context);
      if (bodyStep.runCondition && !evaluateCondition(bodyStep.runCondition as any, projectedContext as any)) {
        continue;
      }

      const next = this.materializeStep(compiled, instance, projectedContext);
      if (next.isErr()) return err(next.error);

      // Update frame body index to point at the selected step (still needs completion)
      const updatedTop: LoopFrame = { ...frame, bodyIndex: i };
      const updatedStack = [...state.loopStack.slice(0, -1), updatedTop];
      return ok({
        state: { ...state, loopStack: updatedStack, pendingStep: instance },
        next: next.value,
      });
    }

    // No eligible steps left in this iteration => advance iteration
    if (frame.iteration + 1 >= loopCompiled.loop.loop.maxIterations) {
      return err(Err.maxIterationsExceeded(frame.loopId, loopCompiled.loop.loop.maxIterations));
    }

    const advanced: LoopFrame = { ...frame, iteration: frame.iteration + 1, bodyIndex: 0 };
    const updatedStack = [...state.loopStack.slice(0, -1), advanced];
    return ok({ state: { ...state, loopStack: updatedStack }, next: null });
  }

  private shouldContinueLoop(
    loop: LoopStepDefinition,
    frame: LoopFrame,
    context: Record<string, unknown>
  ): Result<boolean, DomainError> {
    // Safety first
    if (frame.iteration >= loop.loop.maxIterations) {
      return ok(false);
    }

    switch (loop.loop.type) {
      case 'for': {
        const count = loop.loop.count;
        if (typeof count === 'number') {
          return ok(frame.iteration < count);
        }
        if (typeof count === 'string') {
          const raw = (context as any)[count];
          if (typeof raw !== 'number') {
            return err(Err.missingContext(`for loop '${loop.id}' requires numeric context['${count}']`));
          }
          return ok(frame.iteration < raw);
        }
        return err(Err.invalidLoop(loop.id, `for loop '${loop.id}' missing count`));
      }
      case 'forEach': {
        const itemsVar = loop.loop.items;
        if (!itemsVar) return err(Err.invalidLoop(loop.id, `forEach loop '${loop.id}' missing items`));
        const raw = (context as any)[itemsVar];
        if (!Array.isArray(raw)) {
          return err(Err.missingContext(`forEach loop '${loop.id}' requires array context['${itemsVar}']`));
        }
        return ok(frame.iteration < raw.length);
      }
      case 'while': {
        if (!loop.loop.condition) return err(Err.invalidLoop(loop.id, `while loop '${loop.id}' missing condition`));
        return ok(evaluateCondition(loop.loop.condition as any, this.projectLoopContext(loop, frame, context) as any));
      }
      case 'until': {
        if (!loop.loop.condition) return err(Err.invalidLoop(loop.id, `until loop '${loop.id}' missing condition`));
        return ok(!evaluateCondition(loop.loop.condition as any, this.projectLoopContext(loop, frame, context) as any));
      }
      default:
        return err(Err.invalidLoop(loop.id, `Unknown loop type '${(loop.loop as any).type}'`));
    }
  }

  private projectLoopContext(loop: LoopStepDefinition, frame: LoopFrame, base: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };

    const iterationVar = loop.loop.iterationVar || 'currentIteration';
    out[iterationVar] = frame.iteration + 1; // 1-based for agents

    if (loop.loop.type === 'forEach') {
      const itemsVar = loop.loop.items!;
      const raw = (base as any)[itemsVar];
      if (Array.isArray(raw)) {
        const index = frame.iteration;
        const itemVar = loop.loop.itemVar || 'currentItem';
        const indexVar = loop.loop.indexVar || 'currentIndex';
        out[itemVar] = raw[index];
        out[indexVar] = index;
      }
    }

    return out;
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
