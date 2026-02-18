/**
 * v2 Advance Core - Public API
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

import { ResultAsync as RA, okAsync, errAsync as neErrorAsync } from 'neverthrow';
import type { DomainEventV1 } from '../../../v2/durable-core/schemas/session/index.js';
import type { ExecutionSnapshotFileV1, EngineStateV1 } from '../../../v2/durable-core/schemas/execution-snapshot/index.js';
import type { SessionId, RunId, NodeId, WorkflowHash } from '../../../v2/durable-core/ids/index.js';
import type { AttemptId } from '../../../v2/durable-core/tokens/index.js';
import type { LoadedSessionTruthV2 } from '../../../v2/ports/session-event-log-store.port.js';
import type { SessionEventLogStoreError } from '../../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../../v2/ports/snapshot-store.port.js';
import type { WithHealthySessionLock } from '../../../v2/durable-core/ids/with-healthy-session-lock.js';
import type { Sha256PortV2 } from '../../../v2/ports/sha256.port.js';
import type { JsonValue } from '../../../v2/durable-core/canonical/json-types.js';
import type { V2ContinueWorkflowInput } from '../../v2/tools.js';
import type { ValidationResult } from '../../../types/validation.js';
import type { ConditionContext } from '../../../utils/condition-evaluator.js';

import { createWorkflow } from '../../../types/workflow.js';
import { derivePendingStep } from '../../../v2/durable-core/projections/snapshot-state.js';
import { type ReasonV1, shouldBlock } from '../../../v2/durable-core/domain/reason-model.js';
import { applyGuardrails } from '../../../v2/durable-core/domain/risk-policy-guardrails.js';
import { detectBlockingReasonsV1 } from '../../../v2/durable-core/domain/blocking-decision.js';
import { getOutputRequirementStatusWithArtifactsV1 } from '../../../v2/durable-core/domain/validation-criteria-validator.js';
import { ValidationEngine } from '../../../application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../../application/services/enhanced-loop-validator.js';

import type { InternalError } from '../v2-error-mapping.js';
import { toV1ExecutionState } from '../v2-state-conversion.js';
import { internalSuggestion } from '../v2-execution-helpers.js';
import { withTimeout } from '../shared/with-timeout.js';
import { validateAdvanceInputs, type ValidatedAdvanceInputs } from './input-validation.js';
import { buildBlockedOutcome } from './outcome-blocked.js';
import { buildSuccessOutcome } from './outcome-success.js';

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

// ── Shared ports interface ────────────────────────────────────────────

export interface AdvanceCorePorts {
  readonly snapshotStore: import('../../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly sessionStore: import('../../../v2/ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2;
  readonly sha256: Sha256PortV2;
  readonly idFactory: {
    readonly mintNodeId: () => NodeId;
    readonly mintEventId: () => string;
  };
}

// ── Grouped parameter interfaces (reduce arg-bag in outcome builders) ─

/** Execution identity + workflow state shared by both outcome paths. */
export interface AdvanceContext {
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
export interface ComputedAdvanceResults {
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
  //
  // ValidationEngine errors (bad schema, invalid criteria format, evaluation threw)
  // are routed to terminal_block instead of propagating as InternalError.
  // Rationale: a broken validation rule is a workflow authoring defect, not a system
  // error — the agent can't fix it by retrying, so we create a terminal blocked node
  // that's visible in the DAG and Studio.

  type ValidationPhaseResult =
    | { readonly kind: 'completed'; readonly validation: ValidationResult | undefined }
    | { readonly kind: 'evaluation_error'; readonly message: string };

  const validator = v.validationCriteria ? new ValidationEngine(new EnhancedLoopValidator()) : null;
  const validationPhase: RA<ValidationPhaseResult, InternalError> =
    validator && v.notesMarkdown
      ? RA.fromPromise(
          // validationCriteria is guaranteed non-undefined here: validator is only non-null when v.validationCriteria is truthy
          withTimeout(validator.validate(v.notesMarkdown, v.validationCriteria!, v.mergedContext as ConditionContext), 30_000, 'ValidationEngine.validate'),
          (cause) => ({ kind: 'advance_apply_failed' as const, message: String(cause) } as const)
        ).andThen((res): RA<ValidationPhaseResult, InternalError> => {
          if (res.isErr()) {
            // ValidationEngine returned a structured error → terminal block (not application error)
            return okAsync({ kind: 'evaluation_error' as const, message: `${res.error.kind}: ${res.error.message}` });
          }
          return okAsync({ kind: 'completed' as const, validation: res.value as ValidationResult | undefined });
        }).orElse((e): RA<ValidationPhaseResult, InternalError> => {
          // ValidationEngine threw unexpectedly → terminal block
          if (e.kind === 'advance_apply_failed') {
            return okAsync({ kind: 'evaluation_error' as const, message: e.message });
          }
          return neErrorAsync(e);
        })
      : okAsync({ kind: 'completed' as const, validation: undefined } as ValidationPhaseResult);

  return validationPhase.andThen((phase) => {

    // ── 3b. Evaluation error → force terminal block ───────────────────

    if (phase.kind === 'evaluation_error') {
      const evalReason: ReasonV1 = { kind: 'evaluation_error' };
      const reasons: readonly ReasonV1[] = [evalReason];
      const effectiveReasons: readonly ReasonV1[] = [evalReason];
      const outputRequirement = { kind: 'not_required' as const };
      const evalValidation: ValidationResult = {
        valid: false,
        issues: ['WorkRail could not evaluate the validation criteria for this step. This is not caused by your output.'],
        suggestions: [internalSuggestion('Retry your submission with the same output.', 'The validation criteria for this step may be misconfigured.')],
      };

      const ctx: AdvanceContext = { truth, sessionId, runId, currentNodeId, attemptId, workflowHash, inputOutput, pinnedWorkflow, engineState, pendingStep };
      const computed: ComputedAdvanceResults = { reasons, effectiveReasons, outputRequirement, validation: evalValidation };
      const portsLocal: AdvanceCorePorts = { snapshotStore, sessionStore, sha256, idFactory };

      return buildBlockedOutcome({ mode, snap, ctx, computed, lock, ports: portsLocal });
    }

    const validation = phase.validation;

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

// ── Utility ───────────────────────────────────────────────────────────

function errAsync(e: InternalError): RA<never, InternalError> {
  return neErrorAsync(e);
}
