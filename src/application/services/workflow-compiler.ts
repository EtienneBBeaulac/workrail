import { singleton } from 'tsyringe';
import {
  Workflow,
  WorkflowStepDefinition,
  LoopStepDefinition,
  isLoopStepDefinition,
} from '../../types/workflow';
import type { LoopConditionSource } from '../../types/workflow-definition';
import { LOOP_CONTROL_CONTRACT_REF, isValidContractRef } from '../../v2/durable-core/schemas/artifacts/index';
import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import { type DomainError, Err } from '../../domain/execution/error';
import { resolvePromptBlocksPass } from './compiler/prompt-blocks';
import { resolveRefsPass } from './compiler/resolve-refs';
import { createRefRegistry } from './compiler/ref-registry';

export interface CompiledLoop {
  readonly loop: LoopStepDefinition;
  readonly bodySteps: readonly WorkflowStepDefinition[];
  /**
   * Derived condition source for while/until loops.
   * Undefined for for/forEach loops (which don't use condition evaluation).
   * 
   * Auto-derived during compilation:
   * - Explicit conditionSource in loop config → used as-is
   * - Loop body has a step with outputContract matching loop_control → artifact_contract
   * - Otherwise → context_variable (legacy, deprecated)
   */
  readonly conditionSource?: LoopConditionSource;
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
  private readonly refRegistry = createRefRegistry();

  compile(workflow: Workflow): Result<CompiledWorkflow, DomainError> {
    // Phase 1a: Resolve wr.refs.* in promptBlocks (must run before rendering)
    const refsResult = resolveRefsPass(workflow.definition.steps, this.refRegistry);
    if (refsResult.isErr()) {
      const e = refsResult.error;
      return err(Err.invalidState(
        `Step '${e.stepId}': ref resolution error — ${e.cause.message}`
      ));
    }

    // Phase 1b: Resolve promptBlocks into prompt strings (compile-time rendering)
    const blocksResult = resolvePromptBlocksPass(refsResult.value);
    if (blocksResult.isErr()) {
      const e = blocksResult.error;
      const message = e.code === 'PROMPT_AND_BLOCKS_BOTH_SET'
        ? e.message
        : `Step '${e.stepId}': promptBlocks error — ${e.cause.message}`;
      return err(Err.invalidState(message));
    }
    const steps = blocksResult.value;

    const stepById = new Map<string, WorkflowStepDefinition | LoopStepDefinition>();
    for (const step of steps) {
      if (stepById.has(step.id)) {
        return err(Err.invalidState(`Duplicate step id '${step.id}' in workflow '${workflow.definition.id}'`));
      }
      stepById.set(step.id, step);
    }

    // Validate outputContract refs at compile time (fail fast on unknown contracts)
    for (const step of steps) {
      const contractRef = (step as WorkflowStepDefinition).outputContract?.contractRef;
      if (contractRef && !isValidContractRef(contractRef)) {
        return err(Err.invalidState(
          `Step '${step.id}' declares unknown outputContract.contractRef '${contractRef}'. ` +
          `Known contracts: ${LOOP_CONTROL_CONTRACT_REF}`
        ));
      }
    }

    const compiledLoops = new Map<string, CompiledLoop>();
    const loopBodyStepIds = new Set<string>();

    for (const step of steps) {
      if (!isLoopStepDefinition(step)) continue;

      const loop = step;
      const bodyResolved = this.resolveLoopBody(loop, stepById, workflow);
      if (bodyResolved.isErr()) return err(bodyResolved.error);

      for (const bodyStep of bodyResolved.value) {
        loopBodyStepIds.add(bodyStep.id);
        // Validate outputContract refs on inline body steps
        const ref = bodyStep.outputContract?.contractRef;
        if (ref && !isValidContractRef(ref)) {
          return err(Err.invalidState(
            `Loop body step '${bodyStep.id}' in loop '${loop.id}' declares unknown outputContract.contractRef '${ref}'. ` +
            `Known contracts: ${LOOP_CONTROL_CONTRACT_REF}`
          ));
        }
      }

      const conditionSource = this.deriveConditionSource(loop, bodyResolved.value);

      compiledLoops.set(loop.id, {
        loop,
        bodySteps: bodyResolved.value,
        conditionSource,
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

  /**
   * Derive the loop condition source from the loop definition and body steps.
   * 
   * Priority:
   * 1. Explicit conditionSource in loop config (author declared)
   * 2. Body step has outputContract with loop_control → artifact_contract
   * 3. Loop has condition → context_variable (legacy, deprecated)
   * 4. Undefined for for/forEach (not condition-driven)
   */
  private deriveConditionSource(
    loop: LoopStepDefinition,
    bodySteps: readonly WorkflowStepDefinition[]
  ): LoopConditionSource | undefined {
    // Only while/until use conditions
    if (loop.loop.type !== 'while' && loop.loop.type !== 'until') {
      return undefined;
    }

    // 1. Explicit conditionSource takes priority
    if (loop.loop.conditionSource) {
      return loop.loop.conditionSource;
    }

    // 2. Auto-derive from body steps: only loop_control contracts imply condition source.
    // This is safe with any number of contract types because we match the specific
    // LOOP_CONTROL_CONTRACT_REF — other contracts (e.g. evidence_validation) don't
    // imply loop condition derivation and correctly fall through to the legacy path.
    const loopControlStep = bodySteps.find(
      (s) => s.outputContract?.contractRef === LOOP_CONTROL_CONTRACT_REF
    );
    if (loopControlStep) {
      return {
        kind: 'artifact_contract',
        contractRef: LOOP_CONTROL_CONTRACT_REF,
        loopId: loop.id,
      };
    }

    // 3. Legacy: derive from condition field
    if (loop.loop.condition) {
      return {
        kind: 'context_variable',
        condition: loop.loop.condition,
      };
    }

    // No condition source derivable (will fail at interpreter time)
    return undefined;
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
          return err(Err.invalidLoop(loop.id, `Nested loops are not supported (inline step '${s.id}' is a loop)`));
        }
      }

      // Register inline steps into the compiled lookup map so the interpreter can materialize them.
      // Fail fast if an inline step ID collides with any top-level ID or previously registered inline ID.
      for (const s of loop.body) {
        const existing = stepById.get(s.id);
        if (existing) {
          return err(
            Err.invalidState(
              `Inline loop body step id '${s.id}' collides with existing step id in workflow '${workflow.definition.id}'`
            )
          );
        }
        stepById.set(s.id, s);
      }
      return ok(loop.body);
    }

    // String body reference
    const bodyRef = loop.body as string;
    const referenced = stepById.get(bodyRef);
    if (!referenced) {
      return err(Err.invalidLoop(loop.id, `Loop body references missing step '${bodyRef}'`));
    }

    if (isLoopStepDefinition(referenced)) {
      return err(Err.invalidLoop(loop.id, `Nested loops are not supported (referenced step '${referenced.id}' is a loop)`));
    }

    return ok([referenced]);
  }
}
