/**
 * v2 Advance Core
 *
 * Unified advance logic for both fresh and retry paths.
 * Replaces the duplicated advanceAndRecord / handleRetryAdvance pair.
 *
 * Design:
 * - AdvanceMode discriminant carries node identity + snapshot per mode
 * - ValidatedAdvanceInputs is the boundary type: validation happens once, core trusts it
 * - Event emission rules (e.g. "always emit validation_performed on retry success") are
 *   derived from mode, not from if-branches
 *
 * Why: the two old functions were ~70% structurally identical, differing only in
 * how the snapshot/pending step is sourced and whether validation events are emitted
 * on the success path.
 */

import { ResultAsync as RA, okAsync, errAsync as neErrorAsync, ok, err, type Result } from 'neverthrow';
import type { DomainEventV1 } from '../../v2/durable-core/schemas/session/index.js';
import type { ExecutionSnapshotFileV1, EngineStateV1 } from '../../v2/durable-core/schemas/execution-snapshot/index.js';
import type { SessionId, RunId, NodeId, WorkflowHash } from '../../v2/durable-core/ids/index.js';
import { asOutputId, type AttemptId, type OutputId } from '../../v2/durable-core/tokens/index.js';
import type { LoadedSessionTruthV2 } from '../../v2/ports/session-event-log-store.port.js';
import type { SessionEventLogStoreError } from '../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../v2/ports/snapshot-store.port.js';
import type { WithHealthySessionLock } from '../../v2/durable-core/ids/with-healthy-session-lock.js';
import type { Sha256PortV2 } from '../../v2/ports/sha256.port.js';
import type { JsonObject, JsonValue } from '../../v2/durable-core/canonical/json-types.js';
import type { V2ContinueWorkflowInput } from '../v2/tools.js';
import type { OutputContract } from '../../types/workflow-definition.js';
import type { ValidationCriteria, ValidationResult } from '../../types/validation.js';
import type { ConditionContext } from '../../utils/condition-evaluator.js';
import type { WorkflowEvent } from '../../domain/execution/event.js';

import { createWorkflow, getStepById } from '../../types/workflow.js';
import { derivePendingStep } from '../../v2/durable-core/projections/snapshot-state.js';
import { projectRunContextV2 } from '../../v2/projections/run-context.js';
import { projectPreferencesV2 } from '../../v2/projections/preferences.js';
import { mergeContext } from '../../v2/durable-core/domain/context-merge.js';
import { toCanonicalBytes } from '../../v2/durable-core/canonical/jcs.js';
import { toNotesMarkdownV1 } from '../../v2/durable-core/domain/notes-markdown.js';
import { normalizeOutputsForAppend, type OutputToAppend } from '../../v2/durable-core/domain/outputs.js';
import { buildAckAdvanceAppendPlanV1 } from '../../v2/durable-core/domain/ack-advance-append-plan.js';
import { detectBlockingReasonsV1 } from '../../v2/durable-core/domain/blocking-decision.js';
import { type ReasonV1, buildBlockerReport, shouldBlock, reasonToGap } from '../../v2/durable-core/domain/reason-model.js';
import { applyGuardrails } from '../../v2/durable-core/domain/risk-policy-guardrails.js';
import { checkRecommendationExceedance } from '../../v2/durable-core/domain/recommendation-warnings.js';
import { getOutputRequirementStatusWithArtifactsV1 } from '../../v2/durable-core/domain/validation-criteria-validator.js';
import { buildValidationPerformedEvent } from '../../v2/durable-core/domain/validation-event-builder.js';
import { buildBlockedNodeSnapshot } from '../../v2/durable-core/domain/blocked-node-builder.js';
import { buildDecisionTraceEventData } from '../../v2/durable-core/domain/decision-trace-builder.js';
import { ValidationEngine } from '../../application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../application/services/enhanced-loop-validator.js';
import { WorkflowCompiler } from '../../application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../application/services/workflow-interpreter.js';

import type { InternalError } from './v2-error-mapping.js';
import { toV1ExecutionState, fromV1ExecutionState } from './v2-state-conversion.js';
import { collectArtifactsForEvaluation } from './v2-context-budget.js';
import { withTimeout } from './shared/with-timeout.js';

// ── AdvanceMode: the single branching discriminant ────────────────────

/**
 * Discriminated union controlling mode-specific behavior.
 * Node identity, snapshot source, and event emission rules are all
 * encoded in the variant — no separate boolean flags.
 */
export type AdvanceMode =
  | {
      readonly kind: 'fresh';
      readonly sourceNodeId: NodeId;
      readonly snapshot: ExecutionSnapshotFileV1;
    }
  | {
      readonly kind: 'retry';
      readonly blockedNodeId: NodeId;
      readonly blockedSnapshot: ExecutionSnapshotFileV1;
    };

/** Extract the node ID that events should be scoped to. */
function nodeIdOf(mode: AdvanceMode): NodeId {
  switch (mode.kind) {
    case 'fresh': return mode.sourceNodeId;
    case 'retry': return mode.blockedNodeId;
  }
}

/** Extract the snapshot for the current advance. */
function snapshotOf(mode: AdvanceMode): ExecutionSnapshotFileV1 {
  switch (mode.kind) {
    case 'fresh': return mode.snapshot;
    case 'retry': return mode.blockedSnapshot;
  }
}

/** Whether validation_performed events should be emitted on success path. */
function emitValidationOnSuccess(mode: AdvanceMode): boolean {
  switch (mode.kind) {
    case 'fresh': return false;
    case 'retry': return true;
  }
}

/** The toNodeKind to use when the advance succeeds (not blocked). */
function successNodeKind(mode: AdvanceMode): 'step' | undefined {
  switch (mode.kind) {
    case 'fresh': return undefined; // uses default in buildAckAdvanceAppendPlanV1
    case 'retry': return 'step';
  }
}

// ── ValidatedAdvanceInputs: boundary type ─────────────────────────────

/**
 * Result of validating advance inputs at the boundary.
 * Once constructed, the core logic can trust all fields without re-checking.
 */
interface ValidatedAdvanceInputs {
  readonly pendingStep: { readonly stepId: string; readonly loopPath: readonly { readonly loopId: string; readonly iteration: number }[] };
  readonly mergedContext: Record<string, unknown>;
  readonly inputContextObj: JsonObject | undefined;
  readonly validationCriteria: ValidationCriteria | undefined;
  readonly outputContract: OutputContract | undefined;
  readonly notesMarkdown: string | undefined;
  readonly artifacts: readonly unknown[];
  readonly autonomy: 'guided' | 'full_auto_stop_on_user_deps' | 'full_auto_never_stop';
  readonly riskPolicy: 'conservative' | 'balanced' | 'aggressive';
  readonly effectivePrefs: { readonly autonomy: string; readonly riskPolicy: string } | undefined;
}

// ── Shared ports interface ────────────────────────────────────────────

export interface AdvanceCorePorts {
  readonly snapshotStore: import('../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly sessionStore: import('../../v2/ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2;
  readonly sha256: Sha256PortV2;
  readonly idFactory: {
    readonly mintNodeId: () => NodeId;
    readonly mintEventId: () => string;
  };
}

// ── Partial event type (eventIndex + sessionId added by append plan) ──

type PartialEvent = Omit<DomainEventV1, 'eventIndex' | 'sessionId'>;

/** Type-safe constructor for partial events — avoids `as` casts at call sites. */
function partialEvent(fields: PartialEvent): PartialEvent {
  return fields;
}

// ── Grouped parameter interfaces (reduce arg-bag in outcome builders) ─

/** Execution identity + workflow state shared by both outcome paths. */
interface AdvanceContext {
  readonly truth: LoadedSessionTruthV2;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly currentNodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly workflowHash: WorkflowHash;
  readonly inputOutput: V2ContinueWorkflowInput['output'];
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly engineState: EngineStateV1;
  readonly pendingStep: ValidatedAdvanceInputs['pendingStep'];
}

/** Computed blocking/validation results from the advance evaluation phase. */
interface ComputedAdvanceResults {
  readonly reasons: readonly ReasonV1[];
  readonly effectiveReasons: readonly ReasonV1[];
  readonly outputRequirement: ReturnType<typeof getOutputRequirementStatusWithArtifactsV1>;
  readonly validation: ValidationResult | undefined;
}

// ── Core function ─────────────────────────────────────────────────────

/**
 * Unified advance execution for both fresh and retry paths.
 *
 * Flow:
 * 1. Derive pending step from mode
 * 2. Validate inputs at boundary (context, step metadata, validation)
 * 3. Detect blocking reasons + apply guardrails
 * 4. If blocked → build blocked snapshot + append
 * 5. If success → compile/interpret → build outputs + append
 *
 * Note: compilation (WorkflowCompiler.compile) only runs on the success path,
 * not before the blocked check. This is intentional — there's no point compiling
 * if the advance will be blocked. The original code compiled eagerly before
 * checking blocking reasons; this is a deliberate lazy improvement.
 */
export function executeAdvanceCore(args: {
  readonly mode: AdvanceMode;
  readonly truth: LoadedSessionTruthV2;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly workflowHash: WorkflowHash;
  readonly dedupeKey: string;
  readonly inputContext: JsonValue | undefined;
  readonly inputOutput: V2ContinueWorkflowInput['output'];
  readonly lock: WithHealthySessionLock;
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly ports: AdvanceCorePorts;
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { mode, truth, sessionId, runId, attemptId, workflowHash, inputContext, inputOutput, lock, pinnedWorkflow, ports } = args;
  const { snapshotStore, sessionStore, sha256, idFactory } = ports;
  const currentNodeId = nodeIdOf(mode);
  const snap = snapshotOf(mode);
  const engineState = snap.enginePayload.engineState;

  // ── 1. Derive pending step ──────────────────────────────────────────

  const pendingStep = derivePendingStepForMode(mode, engineState);
  if (!pendingStep) {
    return errAsync({ kind: 'no_pending_step' as const });
  }

  // ── 2. Validate inputs at boundary ──────────────────────────────────

  const validatedRes = validateAdvanceInputs({
    truth, runId, currentNodeId, inputContext, inputOutput, pinnedWorkflow, pendingStep,
  });
  if (validatedRes.isErr()) return errAsync(validatedRes.error);
  const v = validatedRes.value;

  // ── 3. Run validation engine (async boundary) ───────────────────────

  const validator = v.validationCriteria ? new ValidationEngine(new EnhancedLoopValidator()) : null;
  const validationRes: RA<ValidationResult | undefined, InternalError> =
    validator && v.notesMarkdown
      ? RA.fromPromise(
          // validationCriteria is guaranteed non-undefined here: validator is only non-null when v.validationCriteria is truthy (line 192)
          withTimeout(validator.validate(v.notesMarkdown, v.validationCriteria!, v.mergedContext as ConditionContext), 30_000, 'ValidationEngine.validate'),
          (cause) => ({ kind: 'advance_apply_failed' as const, message: String(cause) } as const)
        ).andThen((res) => {
          if (res.isErr()) {
            return neErrorAsync({
              kind: 'advance_apply_failed' as const,
              message: `ValidationEngineError: ${res.error.kind} (${res.error.message})`,
            } as const);
          }
          return okAsync(res.value);
        })
      : okAsync(undefined);

  return validationRes.andThen((validation: ValidationResult | undefined) => {

    // ── 4. Detect blocking reasons + guardrails ─────────────────────────

    const outputRequirement = getOutputRequirementStatusWithArtifactsV1({
      outputContract: v.outputContract,
      artifacts: v.artifacts,
      validationCriteria: v.validationCriteria,
      notesMarkdown: v.notesMarkdown,
      validation,
    });

    const reasonsRes = detectBlockingReasonsV1({ outputRequirement });
    if (reasonsRes.isErr()) {
      return errAsync({ kind: 'invariant_violation' as const, message: reasonsRes.error.message } as const);
    }
    const reasons = reasonsRes.value;

    const { blocking: effectiveReasons } = applyGuardrails(v.riskPolicy, reasons);
    const shouldBlockNow = effectiveReasons.length > 0 && shouldBlock(v.autonomy, effectiveReasons);

    const ctx: AdvanceContext = { truth, sessionId, runId, currentNodeId, attemptId, workflowHash, inputOutput, pinnedWorkflow, engineState, pendingStep };
    const computed: ComputedAdvanceResults = { reasons, effectiveReasons, outputRequirement, validation };
    const ports: AdvanceCorePorts = { snapshotStore, sessionStore, sha256, idFactory };

    // ── 5. Blocked path ─────────────────────────────────────────────────

    if (shouldBlockNow) {
      return buildBlockedOutcome({ mode, snap, ctx, computed, lock, ports });
    }

    // ── 6. Success path ─────────────────────────────────────────────────

    return buildSuccessOutcome({ mode, ctx, computed, v, lock, ports });
  });
}

// ── Pending step derivation (mode-specific) ───────────────────────────

function derivePendingStepForMode(
  mode: AdvanceMode,
  engineState: EngineStateV1,
): { readonly stepId: string; readonly loopPath: readonly { readonly loopId: string; readonly iteration: number }[] } | null {
  switch (mode.kind) {
    case 'fresh': {
      const currentState = toV1ExecutionState(engineState);
      return (currentState.kind === 'running' && currentState.pendingStep) ? currentState.pendingStep : null;
    }
    case 'retry': {
      if (engineState.kind !== 'blocked') return null;
      const pending = derivePendingStep(engineState);
      return pending ? {
        stepId: String(pending.stepId),
        loopPath: pending.loopPath.map(f => ({ loopId: String(f.loopId), iteration: f.iteration })),
      } : null;
    }
  }
}

// ── Input validation (boundary) ───────────────────────────────────────

function validateAdvanceInputs(args: {
  readonly truth: LoadedSessionTruthV2;
  readonly runId: RunId;
  readonly currentNodeId: NodeId;
  readonly inputContext: JsonValue | undefined;
  readonly inputOutput: V2ContinueWorkflowInput['output'];
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly pendingStep: { readonly stepId: string; readonly loopPath: readonly { readonly loopId: string; readonly iteration: number }[] };
}): Result<ValidatedAdvanceInputs, InternalError> {
  const { truth, runId, currentNodeId, inputContext, inputOutput, pinnedWorkflow, pendingStep } = args;

  // Context merge
  const storedContextRes = projectRunContextV2(truth.events);
  const storedContext = storedContextRes.isOk() ? storedContextRes.value.byRunId[String(runId)]?.context : undefined;

  const inputContextObj =
    inputContext && typeof inputContext === 'object' && inputContext !== null && !Array.isArray(inputContext)
      ? (inputContext as JsonObject)
      : undefined;

  const mergedContextRes = mergeContext(storedContext, inputContextObj);
  if (mergedContextRes.isErr()) {
    return err({ kind: 'invariant_violation' as const, message: `Context merge failed: ${mergedContextRes.error.message}` });
  }

  // Step metadata — getStepById returns WorkflowStepDefinition | LoopStepDefinition | null,
  // both of which carry validationCriteria? and outputContract? as typed fields.
  const step = getStepById(pinnedWorkflow, pendingStep.stepId);
  const validationCriteria = step?.validationCriteria;
  const outputContract = step?.outputContract;

  // Preferences
  const parentByNodeId: Record<string, string | null> = {};
  for (const e of truth.events) {
    if (e.kind !== 'node_created') continue;
    if (e.scope?.runId !== String(runId)) continue;
    parentByNodeId[String(e.scope.nodeId)] = e.data.parentNodeId;
  }
  const prefs = projectPreferencesV2(truth.events, parentByNodeId);
  const effectivePrefs = prefs.isOk() ? prefs.value.byNodeId[String(currentNodeId)]?.effective : undefined;
  const rawAutonomy = effectivePrefs?.autonomy ?? 'guided';
  const rawRiskPolicy = effectivePrefs?.riskPolicy ?? 'conservative';

  // Validate at boundary — narrow from string to literal union, fail fast on unknown values
  const VALID_AUTONOMY = ['guided', 'full_auto_stop_on_user_deps', 'full_auto_never_stop'] as const;
  const VALID_RISK_POLICY = ['conservative', 'balanced', 'aggressive'] as const;

  if (!VALID_AUTONOMY.includes(rawAutonomy as typeof VALID_AUTONOMY[number])) {
    return err({ kind: 'invariant_violation' as const, message: `Unknown autonomy mode: ${rawAutonomy}` });
  }
  if (!VALID_RISK_POLICY.includes(rawRiskPolicy as typeof VALID_RISK_POLICY[number])) {
    return err({ kind: 'invariant_violation' as const, message: `Unknown risk policy: ${rawRiskPolicy}` });
  }

  const autonomy = rawAutonomy as typeof VALID_AUTONOMY[number];
  const riskPolicy = rawRiskPolicy as typeof VALID_RISK_POLICY[number];

  return ok({
    pendingStep,
    mergedContext: mergedContextRes.value as Record<string, unknown>,
    inputContextObj,
    validationCriteria,
    outputContract,
    notesMarkdown: inputOutput?.notesMarkdown,
    artifacts: inputOutput?.artifacts ?? [],
    autonomy,
    riskPolicy,
    effectivePrefs,
  });
}

// ── Blocked outcome builder ───────────────────────────────────────────

function buildBlockedOutcome(args: {
  readonly mode: AdvanceMode;
  readonly snap: ExecutionSnapshotFileV1;
  readonly ctx: AdvanceContext;
  readonly computed: ComputedAdvanceResults;
  readonly lock: WithHealthySessionLock;
  readonly ports: AdvanceCorePorts;
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { mode, snap, lock, ports } = args;
  const { truth, sessionId, runId, currentNodeId, attemptId, workflowHash } = args.ctx;
  const { reasons, effectiveReasons, outputRequirement, validation } = args.computed;
  const { snapshotStore, sessionStore, sha256, idFactory } = ports;

  const blockersRes = buildBlockerReport(effectiveReasons);
  if (blockersRes.isErr()) {
    return errAsync({ kind: 'invariant_violation' as const, message: blockersRes.error.message } as const);
  }

  // Build validation event
  const validationEventId = idFactory.mintEventId();
  const validationId = `validation_${String(attemptId)}`;
  const contractRefForEvent = outputRequirement.kind !== 'not_required' ? outputRequirement.contractRef : 'none';
  const validationForEvent: ValidationResult =
    validation ??
    (outputRequirement.kind === 'missing'
      ? { valid: false, issues: [`Missing required output for contractRef=${contractRefForEvent}`], suggestions: [], warnings: undefined }
      : { valid: false, issues: ['Validation result missing'], suggestions: [], warnings: undefined });

  const validationEventRes = buildValidationPerformedEvent({
    sessionId: String(sessionId),
    validationId,
    attemptId: String(attemptId),
    contractRef: contractRefForEvent,
    scope: { runId: String(runId), nodeId: String(currentNodeId) },
    minted: { eventId: validationEventId },
    result: validationForEvent,
  });
  if (validationEventRes.isErr()) {
    return errAsync({ kind: 'invariant_violation' as const, message: validationEventRes.error.message } as const);
  }

  const extraEventsToAppend = [validationEventRes.value];
  const primaryReason = reasons[0];
  if (!primaryReason) {
    return errAsync({ kind: 'invariant_violation' as const, message: 'shouldBlockNow=true requires at least one reason' } as const);
  }

  const blockedSnapshotRes = buildBlockedNodeSnapshot({
    priorSnapshot: snap,
    primaryReason,
    attemptId,
    validationRef: validationId,
    blockers: blockersRes.value,
    sha256,
  });
  if (blockedSnapshotRes.isErr()) {
    return errAsync({ kind: 'invariant_violation' as const, message: blockedSnapshotRes.error.message } as const);
  }

  return snapshotStore.putExecutionSnapshotV1(blockedSnapshotRes.value).andThen((blockedSnapshotRef) => {
    return buildAndAppendPlan({
      truth, sessionId, runId, currentNodeId, attemptId, workflowHash,
      extraEventsToAppend, toNodeKind: 'blocked_attempt', snapshotRef: blockedSnapshotRef,
      outputsToAppend: [], sessionStore, idFactory, lock,
    });
  });
}

// ── Success outcome builder ───────────────────────────────────────────

function buildSuccessOutcome(args: {
  readonly mode: AdvanceMode;
  readonly ctx: AdvanceContext;
  readonly computed: ComputedAdvanceResults;
  readonly v: ValidatedAdvanceInputs;
  readonly lock: WithHealthySessionLock;
  readonly ports: AdvanceCorePorts;
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { mode, v, lock, ports } = args;
  const { truth, sessionId, runId, currentNodeId, attemptId, workflowHash, inputOutput, pinnedWorkflow, engineState, pendingStep } = args.ctx;
  const { effectiveReasons, outputRequirement, validation } = args.computed;
  const { snapshotStore, sessionStore, sha256, idFactory } = ports;

  // Compile + interpret
  const compiler = new WorkflowCompiler();
  const interpreter = new WorkflowInterpreter();
  const compiledWf = compiler.compile(pinnedWorkflow);
  if (compiledWf.isErr()) {
    return errAsync({ kind: 'advance_apply_failed', message: compiledWf.error.message } as const);
  }

  const currentState = toV1ExecutionState(engineState);
  const event: WorkflowEvent = {
    kind: 'step_completed',
    stepInstanceId: {
      stepId: pendingStep.stepId,
      loopPath: pendingStep.loopPath.map(f => ({ loopId: f.loopId, iteration: f.iteration })),
    },
  };
  const advanced = interpreter.applyEvent(currentState, event);
  if (advanced.isErr()) {
    return errAsync({ kind: 'advance_apply_failed', message: advanced.error.message } as const);
  }

  const artifactsForEval = collectArtifactsForEvaluation({
    truthEvents: truth.events,
    inputArtifacts: inputOutput?.artifacts ?? [],
  });
  const nextRes = interpreter.next(compiledWf.value, advanced.value, v.mergedContext, artifactsForEval);
  if (nextRes.isErr()) {
    return errAsync({ kind: 'advance_next_failed', message: nextRes.error.message } as const);
  }

  const out = nextRes.value;

  // ── Build extra events ──────────────────────────────────────────────

  const extraEventsToAppend: PartialEvent[] = [];

  // Gap events (never-stop mode)
  if (v.autonomy === 'full_auto_never_stop' && effectiveReasons.length > 0) {
    for (const [idx, r] of effectiveReasons.entries()) {
      const g = reasonToGap(r);
      const gapId = `gap_${String(attemptId)}_${idx}`;
      extraEventsToAppend.push({
        v: 1 as const,
        eventId: idFactory.mintEventId(),
        kind: 'gap_recorded' as const,
        dedupeKey: `gap_recorded:${String(sessionId)}:${gapId}`,
        scope: { runId: String(runId), nodeId: String(currentNodeId) },
        data: { gapId, severity: g.severity, reason: g.reason, summary: g.summary, resolution: { kind: 'unresolved' as const } },
      });
    }
  }

  // Recommendation warnings
  const workflowRecommendations = pinnedWorkflow.definition.recommendedPreferences;
  if (workflowRecommendations && v.effectivePrefs) {
    const warnings = checkRecommendationExceedance(
      { autonomy: v.autonomy, riskPolicy: v.riskPolicy },
      workflowRecommendations,
    );
    for (const [idx, w] of warnings.entries()) {
      const gapId = `rec_warn_${String(currentNodeId)}_${idx}`;
      extraEventsToAppend.push(partialEvent({
        v: 1 as const,
        eventId: idFactory.mintEventId(),
        kind: 'gap_recorded' as const,
        dedupeKey: `gap_recorded:${String(sessionId)}:${gapId}`,
        scope: { runId: String(runId), nodeId: String(currentNodeId) },
        data: { gapId, severity: 'warning', reason: w.kind, summary: w.summary, resolution: { kind: 'unresolved' as const } },
      }));
    }
  }

  // Context set events
  if (v.inputContextObj) {
    extraEventsToAppend.push(partialEvent({
      v: 1 as const,
      eventId: idFactory.mintEventId(),
      kind: 'context_set' as const,
      // Intentionally unique per emission — context_set events should never deduplicate
      dedupeKey: `context_set:${String(sessionId)}:${String(runId)}:${idFactory.mintEventId()}`,
      scope: { runId: String(runId) },
      data: {
        contextId: idFactory.mintEventId(),
        context: v.mergedContext as unknown as JsonValue,
        source: 'agent_delta' as const,
      },
    }));
  }

  // Validation event — mode-driven: retry always emits, fresh never emits on success
  if (emitValidationOnSuccess(mode)) {
    const validationId = `validation_${String(attemptId)}`;
    const contractRefForEvent = outputRequirement.kind !== 'not_required' ? outputRequirement.contractRef : 'none';
    const validationForEvent: ValidationResult =
      validation ??
      (outputRequirement.kind === 'missing'
        ? { valid: false, issues: [`Missing required output for contractRef=${contractRefForEvent}`], suggestions: [], warnings: undefined }
        : { valid: true, issues: [], suggestions: [], warnings: undefined });

    const validationEventRes = buildValidationPerformedEvent({
      sessionId: String(sessionId),
      validationId,
      attemptId: String(attemptId),
      contractRef: contractRefForEvent,
      scope: { runId: String(runId), nodeId: String(currentNodeId) },
      minted: { eventId: idFactory.mintEventId() },
      result: validationForEvent,
    });
    if (validationEventRes.isOk()) {
      extraEventsToAppend.push(validationEventRes.value);
    }
  }

  // Decision trace
  if (out.trace.length > 0) {
    const traceId = idFactory.mintEventId();
    const traceDataRes = buildDecisionTraceEventData(traceId, out.trace);
    if (traceDataRes.isOk()) {
      extraEventsToAppend.push(partialEvent({
        v: 1 as const,
        eventId: idFactory.mintEventId(),
        kind: 'decision_trace_appended' as const,
        dedupeKey: `decision_trace_appended:${String(sessionId)}:${traceId}`,
        scope: { runId: String(runId), nodeId: String(currentNodeId) },
        data: traceDataRes.value,
      }));
    }
  }

  // ── Build outputs ───────────────────────────────────────────────────

  const newEngineState = fromV1ExecutionState(out.state);
  const snapshotFile: ExecutionSnapshotFileV1 = {
    v: 1,
    kind: 'execution_snapshot',
    enginePayload: { v: 1, engineState: newEngineState },
  };

  return snapshotStore.putExecutionSnapshotV1(snapshotFile).andThen((newSnapshotRef) => {
    const allowNotesAppend = v.validationCriteria
      ? Boolean(v.notesMarkdown && validation && validation.valid)
      : Boolean(v.notesMarkdown);

    const notesOutputs = buildNotesOutputs(allowNotesAppend, attemptId, inputOutput);
    const artifactOutputsRes = buildArtifactOutputs(inputOutput?.artifacts ?? [], attemptId, sha256);
    if (artifactOutputsRes.isErr()) {
      return errAsync(artifactOutputsRes.error);
    }

    const outputsToAppend = [...notesOutputs, ...artifactOutputsRes.value];

    return buildAndAppendPlan({
      truth, sessionId, runId, currentNodeId, attemptId, workflowHash,
      extraEventsToAppend, toNodeKind: successNodeKind(mode),
      snapshotRef: newSnapshotRef, outputsToAppend,
      sessionStore, idFactory, lock,
    });
  });
}

// ── buildAndAppendPlan ────────────────────────────────────────────────

function buildAndAppendPlan(args: {
  readonly truth: LoadedSessionTruthV2;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly currentNodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly workflowHash: WorkflowHash;
  readonly extraEventsToAppend: readonly Omit<DomainEventV1, 'eventIndex' | 'sessionId'>[];
  readonly toNodeKind: 'step' | 'blocked_attempt' | undefined;
  readonly snapshotRef: import('../../v2/durable-core/ids/index.js').SnapshotRef;
  readonly outputsToAppend: readonly OutputToAppend[];
  readonly sessionStore: import('../../v2/ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2;
  readonly idFactory: AdvanceCorePorts['idFactory'];
  readonly lock: WithHealthySessionLock;
}): RA<void, InternalError | SessionEventLogStoreError> {
  const { truth, sessionId, runId, currentNodeId, attemptId, workflowHash, extraEventsToAppend, toNodeKind, snapshotRef, outputsToAppend, sessionStore, idFactory, lock } = args;

  const toNodeId = String(idFactory.mintNodeId());
  const nextEventIndex = truth.events.length === 0 ? 0 : truth.events[truth.events.length - 1]!.eventIndex + 1;
  const evtAdvanceRecorded = idFactory.mintEventId();
  const evtNodeCreated = idFactory.mintEventId();
  const evtEdgeCreated = idFactory.mintEventId();

  const hasChildren = truth.events.some(
    (e): e is Extract<DomainEventV1, { kind: 'edge_created' }> =>
      e.kind === 'edge_created' && e.data.fromNodeId === String(currentNodeId)
  );
  const causeKind: 'non_tip_advance' | 'intentional_fork' = hasChildren ? 'non_tip_advance' : 'intentional_fork';

  const normalizedOutputs = normalizeOutputsForAppend(outputsToAppend);
  const outputEventIds = normalizedOutputs.map(() => idFactory.mintEventId());

  const planRes = buildAckAdvanceAppendPlanV1({
    sessionId: String(sessionId),
    runId: String(runId),
    fromNodeId: String(currentNodeId),
    workflowHash,
    attemptId: String(attemptId),
    nextEventIndex,
    extraEventsToAppend,
    toNodeId,
    toNodeKind,
    snapshotRef,
    causeKind,
    minted: {
      advanceRecordedEventId: evtAdvanceRecorded,
      nodeCreatedEventId: evtNodeCreated,
      edgeCreatedEventId: evtEdgeCreated,
      outputEventIds,
    },
    outputsToAppend: [...outputsToAppend],
  });
  if (planRes.isErr()) return neErrorAsync({ kind: 'invariant_violation' as const, message: planRes.error.message });

  return sessionStore.append(lock, planRes.value);
}

// ── Output builders ───────────────────────────────────────────────────

function buildNotesOutputs(
  allowNotesAppend: boolean,
  attemptId: AttemptId,
  inputOutput: V2ContinueWorkflowInput['output'],
): readonly OutputToAppend[] {
  if (!allowNotesAppend || !inputOutput?.notesMarkdown) return [];
  return [{
    outputId: String(asOutputId(`out_recap_${String(attemptId)}`)),
    outputChannel: 'recap' as const,
    payload: {
      payloadKind: 'notes' as const,
      notesMarkdown: toNotesMarkdownV1(inputOutput.notesMarkdown),
    },
  }];
}

/**
 * Canonicalize and hash artifact outputs.
 * Fails fast on first non-canonicalizable artifact.
 */
function buildArtifactOutputs(
  inputArtifacts: readonly unknown[],
  attemptId: AttemptId,
  sha256: Sha256PortV2,
): Result<readonly OutputToAppend[], InternalError> {
  const outputs: OutputToAppend[] = [];
  for (let idx = 0; idx < inputArtifacts.length; idx++) {
    const artifact = inputArtifacts[idx];
    const canonicalBytesRes = toCanonicalBytes(artifact as JsonValue);
    if (canonicalBytesRes.isErr()) {
      return err({ kind: 'invariant_violation' as const, message: `Artifact canonicalization failed at index ${idx}: ${canonicalBytesRes.error.message}` });
    }
    const canonicalBytes = canonicalBytesRes.value;
    outputs.push({
      outputId: asOutputId(`out_artifact_${String(attemptId)}_${idx}`),
      outputChannel: 'artifact' as const,
      payload: {
        payloadKind: 'artifact_ref' as const,
        sha256: sha256.sha256(canonicalBytes),
        contentType: 'application/json',
        byteLength: canonicalBytes.length,
        content: artifact,
      },
    });
  }
  return ok(outputs);
}

// ── Utility ───────────────────────────────────────────────────────────

function errAsync(e: InternalError): RA<never, InternalError> {
  return neErrorAsync(e);
}


