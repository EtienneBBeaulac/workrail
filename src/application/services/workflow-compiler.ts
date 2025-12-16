import { singleton } from 'tsyringe';
import {
  Workflow,
  WorkflowStepDefinition,
  LoopStepDefinition,
  isLoopStepDefinition,
} from '../../types/workflow';
import { ok, err, Result } from '../../domain/execution/result';
import { DomainError } from '../../domain/execution/error';

export interface CompiledLoop {
  readonly loop: LoopStepDefinition;
  readonly bodySteps: readonly WorkflowStepDefinition[];
}

export interface CompiledWorkflow {
  readonly workflow: Workflow;
  readonly steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[];
  readonly stepById: ReadonlyMap<string, WorkflowStepDefinition | LoopStepDefinition>;
  readonly compiledLoops: ReadonlyMap<string, CompiledLoop>;
  /**
   * Step IDs that are loop body steps (either inline or referenced).
   * These must never run as top-level steps.
   */
  readonly loopBodyStepIds: ReadonlySet<string>;
}

@singleton()
export class WorkflowCompiler {
  compile(workflow: Workflow): Result<CompiledWorkflow, DomainError> {
    const steps = workflow.definition.steps;

    const stepById = new Map<string, WorkflowStepDefinition | LoopStepDefinition>();
    for (const step of steps) {
      if (stepById.has(step.id)) {
        return err({
          kind: 'invalid_state',
          message: `Duplicate step id '${step.id}' in workflow '${workflow.definition.id}'`,
        });
      }
      stepById.set(step.id, step);
    }

    const compiledLoops = new Map<string, CompiledLoop>();
    const loopBodyStepIds = new Set<string>();

    for (const step of steps) {
      if (!isLoopStepDefinition(step)) continue;

      const loop = step;
      const bodyResolved = this.resolveLoopBody(loop, stepById, workflow);
      if (bodyResolved.kind === 'err') return bodyResolved;

      for (const bodyStep of bodyResolved.value) {
        loopBodyStepIds.add(bodyStep.id);
      }

      compiledLoops.set(loop.id, {
        loop,
        bodySteps: bodyResolved.value,
      });
    }

    return ok({
      workflow,
      steps,
      stepById,
      compiledLoops,
      loopBodyStepIds,
    });
  }

  private resolveLoopBody(
    loop: LoopStepDefinition,
    stepById: Map<string, WorkflowStepDefinition | LoopStepDefinition>,
    workflow: Workflow
  ): Result<readonly WorkflowStepDefinition[], DomainError> {
    // Inline body
    if (Array.isArray(loop.body)) {
      // v1: forbid nested loops in body
      for (const s of loop.body) {
        if (isLoopStepDefinition(s as any)) {
          return err({
            kind: 'invalid_loop',
            loopId: loop.id,
            message: `Nested loops are not supported (inline step '${s.id}' is a loop)`,
          });
        }
      }

      // Register inline steps into the compiled lookup map so the interpreter can materialize them.
      // Fail fast if an inline step ID collides with any top-level ID or previously registered inline ID.
      for (const s of loop.body) {
        const existing = stepById.get(s.id);
        if (existing) {
          return err({
            kind: 'invalid_state',
            message: `Inline loop body step id '${s.id}' collides with existing step id in workflow '${workflow.definition.id}'`,
          });
        }
        stepById.set(s.id, s);
      }
      return ok(loop.body);
    }

    // String body reference
    const bodyRef = loop.body as string;
    const referenced = stepById.get(bodyRef);
    if (!referenced) {
      return err({
        kind: 'invalid_loop',
        loopId: loop.id,
        message: `Loop body references missing step '${bodyRef}'`,
      });
    }

    if (isLoopStepDefinition(referenced)) {
      return err({
        kind: 'invalid_loop',
        loopId: loop.id,
        message: `Nested loops are not supported (referenced step '${referenced.id}' is a loop)`,
      });
    }

    return ok([referenced]);
  }
}
