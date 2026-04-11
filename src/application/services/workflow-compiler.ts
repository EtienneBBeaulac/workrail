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
import { resolveFeaturesPass } from './compiler/resolve-features';
import { createFeatureRegistry } from './compiler/feature-registry';
import { resolveTemplatesPass } from './compiler/resolve-templates';
import {
  createTemplateRegistry,
  createRoutineExpander,
  routineIdToTemplateId,
  type TemplateExpander,
  type TemplateRegistry,
} from './compiler/template-registry';
import { loadRoutineDefinitions } from './compiler/routine-loader';
import { resolveBindingsPass } from './compiler/resolve-bindings';
import { getProjectBindings } from './compiler/binding-registry';
import { sentinelScanPass } from './compiler/sentinel-scan';
import type { ExtensionPoint } from '../../types/workflow-definition';

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
  /**
   * Full binding manifest: slotId → resolved routineId for all {{wr.bindings.*}}
   * tokens substituted during compilation (project overrides + defaults).
   * Empty map for workflows without extensionPoints.
   */
  readonly resolvedBindings: ReadonlyMap<string, string>;
  /**
   * Project-override subset of resolvedBindings.
   * Only slots sourced from .workrail/bindings.json — not extensionPoint defaults.
   * Used by drift detection so that override-removal is correctly flagged.
   */
  readonly resolvedOverrides: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Shared resolution pipeline — pure function, no I/O
// ---------------------------------------------------------------------------

const _refRegistry = createRefRegistry();
const _featureRegistry = createFeatureRegistry();

/**
 * Build template registry populated with routine-derived expanders.
 * Loads routine definitions from disk (sync, startup-only) and creates
 * expanders for each. The registry is then frozen and reused for all compilations.
 */
function buildTemplateRegistry(): TemplateRegistry {
  const routineExpanders = new Map<string, TemplateExpander>();

  const loadResult = loadRoutineDefinitions();
  if (loadResult.isErr()) {
    // Directory-level failure is non-fatal — system works without routine injection
    console.warn(`[WorkflowCompiler] Failed to load routine definitions: ${loadResult.error}`);
    return createTemplateRegistry();
  }

  const { routines, warnings } = loadResult.value;

  // Surface loader warnings as structured log entries
  for (const w of warnings) {
    console.warn(`[WorkflowCompiler] Skipped routine file '${w.file}': ${w.reason}`);
  }

  for (const [routineId, definition] of routines) {
    const expanderResult = createRoutineExpander(routineId, definition);
    if (expanderResult.isOk()) {
      routineExpanders.set(routineIdToTemplateId(routineId), expanderResult.value);
    } else {
      console.warn(`[WorkflowCompiler] Failed to create expander for routine '${routineId}': ${expanderResult.error.message}`);
    }
  }

  return createTemplateRegistry(routineExpanders.size > 0 ? routineExpanders : undefined);
}

// Lazy singleton: built on first use, not at module import time.
// Avoids sync filesystem I/O as a side effect of importing this module.
let _templateRegistryCache: TemplateRegistry | undefined;
function getTemplateRegistry(): TemplateRegistry {
  if (!_templateRegistryCache) {
    _templateRegistryCache = buildTemplateRegistry();
  }
  return _templateRegistryCache;
}

/**
 * Result shape for resolveDefinitionSteps — includes the resolved steps array
 * and the binding manifest captured during compilation.
 */
export interface ResolvedDefinitionResult {
  readonly steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[];
  /**
   * Full binding manifest: slotId → resolved routineId for all {{wr.bindings.*}}
   * tokens substituted during this compilation (both project overrides and defaults).
   * Empty map for workflows without extensionPoints.
   */
  readonly resolvedBindings: ReadonlyMap<string, string>;
  /**
   * Project-override subset of resolvedBindings: only slots sourced from
   * .workrail/bindings.json (not from extensionPoint defaults).
   *
   * Used by drift detection so that override-removal is correctly identified as
   * drift. Slots missing from this map were resolved via defaults — if they
   * have no current override at resume time, that is not drift.
   */
  readonly resolvedOverrides: ReadonlyMap<string, string>;
}

/**
 * Run the full authoring-layer resolution pipeline on definition steps.
 *
 * Order: templates → bindings → features → refs → promptBlocks rendering → sentinel.
 *
 * Pure function — deterministic, no I/O. Used by both the compiler and
 * the pinning boundary to ensure stored definitions have all promptBlocks
 * and binding tokens resolved into prompt strings.
 *
 * @param extensionPoints - Extension point declarations from the workflow definition.
 *   Used as fallback defaults when no project-level override exists for a slot.
 *   Defaults to empty array for backward compatibility.
 * @param workflowId - ID of the workflow being compiled. Used to locate the
 *   per-workflow section in `.workrail/bindings.json`. Defaults to `''` which
 *   intentionally skips project-level binding overrides — used by the shim's
 *   preview call (single-step compilation) where project bindings are irrelevant
 *   and extensionPoints defaults to `[]`.
 * @param baseDir - Base directory for resolving `.workrail/bindings.json`.
 *   Defaults to `process.cwd()`. Inject a workspace-specific path in
 *   multi-workspace or shared-server setups to prevent bindings from one project
 *   silently resolving for another.
 */
export function resolveDefinitionSteps(
  steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[],
  features: readonly string[],
  extensionPoints: readonly ExtensionPoint[] = [],
  workflowId: string = '',
  baseDir?: string,
): Result<ResolvedDefinitionResult, DomainError> {
  // Phase 0: Expand template_call steps into real steps (must run first)
  const templatesResult = resolveTemplatesPass(steps, getTemplateRegistry());
  if (templatesResult.isErr()) {
    const e = templatesResult.error;
    const message = e.code === 'TEMPLATE_RESOLVE_ERROR'
      ? `Step '${e.stepId}': template error — ${e.cause.message}`
      : e.code === 'DUPLICATE_STEP_ID'
      ? e.message
      : `Step '${e.stepId}': template expansion error — ${e.cause.message}`;
    return err(Err.invalidState(message));
  }

  // Phase 0.5: Resolve {{wr.bindings.slotId}} tokens in step prompts and promptBlocks.
  // Must run after templates (so template-expanded steps are visible) and before
  // features (independent surface, no ordering dependency).
  const bindingsResult = resolveBindingsPass(
    templatesResult.value,
    extensionPoints,
    workflowId ? getProjectBindings(workflowId, baseDir) : new Map(),
  );
  if (bindingsResult.isErr()) {
    const e = bindingsResult.error;
    return err(Err.invalidState(e.message));
  }

  // Phase 1a: Apply declared features to promptBlocks (may inject refs)
  const featuresResult = resolveFeaturesPass(
    bindingsResult.value.steps,
    features,
    _featureRegistry,
  );
  if (featuresResult.isErr()) {
    const e = featuresResult.error;
    const message = e.code === 'FEATURE_RESOLVE_ERROR'
      ? `Feature error — ${e.cause.message}`
      : e.message;
    return err(Err.invalidState(message));
  }

  // Phase 1b: Resolve wr.refs.* in promptBlocks (must run before rendering)
  const refsResult = resolveRefsPass(featuresResult.value, _refRegistry);
  if (refsResult.isErr()) {
    const e = refsResult.error;
    return err(Err.invalidState(
      `Step '${e.stepId}': ref resolution error — ${e.cause.message}`
    ));
  }

  // Phase 1c: Resolve promptBlocks into prompt strings (compile-time rendering)
  const blocksResult = resolvePromptBlocksPass(refsResult.value);
  if (blocksResult.isErr()) {
    const e = blocksResult.error;
    const message = e.code === 'PROMPT_AND_BLOCKS_BOTH_SET'
      ? e.message
      : `Step '${e.stepId}': promptBlocks error — ${e.cause.message}`;
    return err(Err.invalidState(message));
  }

  // Phase 1d: Sentinel scan — fail fast on any surviving {{wr.*}} tokens.
  // If this fires, an upstream pass has a traversal bug.
  const sentinelResult = sentinelScanPass(blocksResult.value);
  if (sentinelResult.isErr()) {
    const e = sentinelResult.error;
    return err(Err.invalidState(e.message));
  }

  return ok({
    steps: blocksResult.value,
    resolvedBindings: bindingsResult.value.resolvedBindings,
    resolvedOverrides: bindingsResult.value.resolvedOverrides,
  });
}

// ---------------------------------------------------------------------------
// WorkflowCompiler
// ---------------------------------------------------------------------------

@singleton()
export class WorkflowCompiler {
  /**
   * @param baseDir - Optional workspace root for resolving `.workrail/bindings.json`.
   *   Defaults to `process.cwd()`. Pass an explicit path in multi-workspace setups.
   */
  compile(workflow: Workflow, baseDir?: string): Result<CompiledWorkflow, DomainError> {
    const resolvedResult = resolveDefinitionSteps(
      workflow.definition.steps,
      workflow.definition.features ?? [],
      workflow.definition.extensionPoints ?? [],
      workflow.definition.id,
      baseDir,
    );
    if (resolvedResult.isErr()) return err(resolvedResult.error);
    const { steps, resolvedBindings, resolvedOverrides } = resolvedResult.value;

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

    // Validate step assessmentRefs against workflow-level declarations
    const declaredAssessmentIds = new Set((workflow.definition.assessments ?? []).map(assessment => assessment.id));
    for (const step of steps) {
      const assessmentRefs = (step as WorkflowStepDefinition).assessmentRefs;
      if (!assessmentRefs) continue;

      for (const assessmentRef of assessmentRefs) {
        if (!declaredAssessmentIds.has(assessmentRef)) {
          return err(Err.invalidState(
            `Step '${step.id}' declares unknown assessmentRef '${assessmentRef}'. ` +
            `Declared assessments: ${[...declaredAssessmentIds].join(', ')}`
          ));
        }
      }
    }

    for (const step of steps) {
      const typedStep = step as WorkflowStepDefinition;
      const assessmentConsequences = typedStep.assessmentConsequences;
      if (!assessmentConsequences) continue;

      if (!typedStep.assessmentRefs || typedStep.assessmentRefs.length === 0) {
        return err(Err.invalidState(
          `Step '${step.id}' declares assessmentConsequences but declares no assessmentRefs`
        ));
      }

      if (assessmentConsequences.length > 1) {
        return err(Err.invalidState(
          `Step '${step.id}' declares ${assessmentConsequences.length} assessment consequences. V1 supports exactly one assessment consequence per step.`
        ));
      }

      const allLevelsAcrossRefs = (workflow.definition.assessments ?? [])
        .filter(candidate => typedStep.assessmentRefs!.includes(candidate.id))
        .flatMap(assessment => assessment.dimensions.flatMap(d => d.levels));

      for (const consequence of assessmentConsequences) {
        const trigger = consequence.when;
        if (!allLevelsAcrossRefs.includes(trigger.anyEqualsLevel)) {
          return err(Err.invalidState(
            `Step '${step.id}' declares consequence with anyEqualsLevel '${trigger.anyEqualsLevel}' that is not declared in any dimension of any referenced assessment`
          ));
        }
        if (consequence.effect.kind !== 'require_followup') {
          return err(Err.invalidState(
            `Step '${step.id}' declares unsupported assessment consequence effect '${String((consequence.effect as { kind?: unknown }).kind)}'`
          ));
        }
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

        const assessmentRefs = bodyStep.assessmentRefs;
        if (assessmentRefs) {
          for (const assessmentRef of assessmentRefs) {
            if (!declaredAssessmentIds.has(assessmentRef)) {
              return err(Err.invalidState(
                `Loop body step '${bodyStep.id}' in loop '${loop.id}' declares unknown assessmentRef '${assessmentRef}'. ` +
                `Declared assessments: ${[...declaredAssessmentIds].join(', ')}`
              ));
            }
          }
        }

        if (bodyStep.assessmentConsequences) {
          if (!bodyStep.assessmentRefs || bodyStep.assessmentRefs.length === 0) {
            return err(Err.invalidState(
              `Loop body step '${bodyStep.id}' in loop '${loop.id}' declares assessmentConsequences but declares no assessmentRefs`
            ));
          }
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
      resolvedBindings,
      resolvedOverrides,
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
