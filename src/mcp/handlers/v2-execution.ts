import * as os from 'os';
import type { ToolContext, ToolResult } from '../types.js';
import { error, success, errNotRetryable, errRetryAfterMs, detailsSessionHealth } from '../types.js';
import type { V2ContinueWorkflowInput, V2StartWorkflowInput } from '../v2/tools.js';
import { V2ContinueWorkflowOutputSchema, V2StartWorkflowOutputSchema } from '../output-schemas.js';
import { deriveIsComplete, derivePendingStep } from '../../v2/durable-core/projections/snapshot-state.js';
import type { ExecutionSnapshotFileV1, EngineStateV1, LoopPathFrameV1 } from '../../v2/durable-core/schemas/execution-snapshot/index.js';
import { asDelimiterSafeIdV1, stepInstanceKeyFromParts } from '../../v2/durable-core/schemas/execution-snapshot/step-instance-key.js';
import {
  assertTokenScopeMatchesStateBinary,
  parseTokenV1Binary,
  verifyTokenSignatureV1Binary,
  type ParsedTokenV1Binary,
  type TokenDecodeErrorV2,
  type TokenVerifyErrorV2,
  type TokenSignErrorV2,
  type TokenPayloadV1,
  type AttemptId,
  type OutputId,
  asAttemptId,
  asOutputId,
} from '../../v2/durable-core/tokens/index.js';
import { signTokenV1Binary } from '../../v2/durable-core/tokens/index.js';
import { createWorkflow, getStepById } from '../../types/workflow.js';
import type { DomainEventV1 } from '../../v2/durable-core/schemas/session/index.js';
import {
  asWorkflowId,
  asSessionId,
  asRunId,
  asNodeId,
  type SessionId,
  type RunId,
  type NodeId,
  type WorkflowHash,
  type WorkflowHashRef,
} from '../../v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../v2/durable-core/ids/workflow-hash-ref.js';
import { deriveChildAttemptId } from '../../v2/durable-core/ids/attempt-id-derivation.js';
import type { LoadedSessionTruthV2 } from '../../v2/ports/session-event-log-store.port.js';
import type { WithHealthySessionLock } from '../../v2/durable-core/ids/with-healthy-session-lock.js';
import type { ExecutionSessionGateErrorV2 } from '../../v2/usecases/execution-session-gate.js';
import type { SessionEventLogStoreError } from '../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../v2/ports/snapshot-store.port.js';
import type { PinnedWorkflowStoreError } from '../../v2/ports/pinned-workflow-store.port.js';
import type { Sha256PortV2 } from '../../v2/ports/sha256.port.js';
import type { TokenCodecPorts } from '../../v2/durable-core/tokens/token-codec-ports.js';
import { ResultAsync as RA, okAsync, errAsync as neErrorAsync, ok, err, type Result } from 'neverthrow';
import { compileV1WorkflowToPinnedSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { workflowHashForCompiledSnapshot } from '../../v2/durable-core/canonical/hashing.js';
import type { JsonObject, JsonValue } from '../../v2/durable-core/canonical/json-types.js';
import { toCanonicalBytes } from '../../v2/durable-core/canonical/jcs.js';
import {
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_DEPTH,
} from '../../v2/durable-core/constants.js';
import { toNotesMarkdownV1 } from '../../v2/durable-core/domain/notes-markdown.js';
import { normalizeOutputsForAppend } from '../../v2/durable-core/domain/outputs.js';
import { buildAckAdvanceAppendPlanV1 } from '../../v2/durable-core/domain/ack-advance-append-plan.js';
import { detectBlockingReasonsV1 } from '../../v2/durable-core/domain/blocking-decision.js';
import { buildBlockerReport, shouldBlock, reasonToGap } from '../../v2/durable-core/domain/reason-model.js';
import { getOutputRequirementStatusV1 } from '../../v2/durable-core/domain/validation-criteria-validator.js';
import { buildValidationPerformedEvent } from '../../v2/durable-core/domain/validation-event-builder.js';
import { buildBlockedNodeSnapshot } from '../../v2/durable-core/domain/blocked-node-builder.js';
import { loadValidationResultV1 } from '../../v2/durable-core/domain/validation-loader.js';
import { projectPreferencesV2 } from '../../v2/projections/preferences.js';
import { projectRunContextV2 } from '../../v2/projections/run-context.js';
import { mergeContext } from '../../v2/durable-core/domain/context-merge.js';
import { renderPendingPrompt } from '../../v2/durable-core/domain/prompt-renderer.js';
import { createBundledSource } from '../../types/workflow-source.js';
import type { WorkflowDefinition } from '../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../types/workflow-definition.js';
import { WorkflowCompiler } from '../../application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../application/services/workflow-interpreter.js';
import { ValidationEngine } from '../../application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../application/services/enhanced-loop-validator.js';
import type { ValidationResult } from '../../types/validation.js';
import type { ExecutionState, LoopFrame } from '../../domain/execution/state.js';
import type { WorkflowEvent } from '../../domain/execution/event.js';
import type { StepInstanceId } from '../../domain/execution/ids.js';
import {
  mapStartWorkflowErrorToToolError,
  mapContinueWorkflowErrorToToolError,
  mapTokenDecodeErrorToToolError,
  mapTokenVerifyErrorToToolError,
  type StartWorkflowError,
  type ContinueWorkflowError,
} from './v2-execution-helpers.js';
import * as z from 'zod';

/**
 * v2 Slice 3: token orchestration (`start_workflow` / `continue_workflow`).
 *
 * Locks (see `docs/design/v2-core-design-locks.md`):
 * - Token validation errors use the closed `TOKEN_*` set.
 * - Rehydrate is side-effect-free.
 * - Advance is idempotent and append-capable only under a witness.
 * - Replay is fact-returning (no recompute) and fail-closed on missing recorded facts.
 */

function normalizeTokenErrorMessage(message: string): string {
  // Keep errors deterministic and compact; avoid leaking environment-specific file paths.
  // NOTE: avoid String.prototype.replaceAll to keep compatibility with older TS lib targets.
  return message.split(os.homedir()).join('~');
}

type Bytes = number & { readonly __brand: 'Bytes' };

const MAX_CONTEXT_BYTES_V2 = MAX_CONTEXT_BYTES as Bytes;

type ContextToolNameV2 = 'start_workflow' | 'continue_workflow';

type ContextValidationIssue =
  | { readonly kind: 'unsupported_value'; readonly path: string; readonly valueType: string }
  | { readonly kind: 'non_finite_number'; readonly path: string; readonly value: string }
  | { readonly kind: 'circular_reference'; readonly path: string }
  | { readonly kind: 'too_deep'; readonly path: string; readonly maxDepth: number };

type ContextValidationDetails =
  | { readonly kind: 'context_invalid_shape'; readonly tool: ContextToolNameV2; readonly expected: 'object' }
  | {
      readonly kind: 'context_unsupported_value';
      readonly tool: ContextToolNameV2;
      readonly path: string;
      readonly valueType: string;
    }
  | {
      readonly kind: 'context_non_finite_number';
      readonly tool: ContextToolNameV2;
      readonly path: string;
      readonly value: string;
    }
  | { readonly kind: 'context_circular_reference'; readonly tool: ContextToolNameV2; readonly path: string }
  | {
      readonly kind: 'context_too_deep';
      readonly tool: ContextToolNameV2;
      readonly path: string;
      readonly maxDepth: number;
    }
  | {
      readonly kind: 'context_not_canonical_json';
      readonly tool: ContextToolNameV2;
      readonly measuredAs: 'jcs_utf8_bytes';
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: 'context_budget_exceeded';
      readonly tool: ContextToolNameV2;
      readonly measuredBytes: number;
      readonly maxBytes: number;
      readonly measuredAs: 'jcs_utf8_bytes';
    };

type ContextBudgetCheck = { readonly ok: true } | { readonly ok: false; readonly error: ToolFailure };

function validateJsonValueOrIssue(value: unknown, path: string, depth: number, seen: WeakSet<object>): ContextValidationIssue | null {
  if (depth > MAX_CONTEXT_DEPTH) return { kind: 'too_deep', path, maxDepth: MAX_CONTEXT_DEPTH };

  if (value === null) return null;

  const t = typeof value;
  if (t === 'string' || t === 'boolean') return null;

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      return { kind: 'non_finite_number', path, value: String(value) };
    }
    return null;
  }

  if (t === 'object') {
    if (Array.isArray(value)) {
      if (seen.has(value)) return { kind: 'circular_reference', path };
      seen.add(value);
      for (let i = 0; i < value.length; i++) {
        const child = validateJsonValueOrIssue(value[i], `${path}[${i}]`, depth + 1, seen);
        if (child) return child;
      }
      return null;
    }

    // Plain object
    if (seen.has(value as object)) return { kind: 'circular_reference', path };
    seen.add(value as object);

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = validateJsonValueOrIssue(v, path === '$' ? `$.${k}` : `${path}.${k}`, depth + 1, seen);
      if (child) return child;
    }

    return null;
  }

  return { kind: 'unsupported_value', path, valueType: t };
}

function checkContextBudget(args: { readonly tool: ContextToolNameV2; readonly context: unknown }): ContextBudgetCheck {
  if (args.context === undefined) return { ok: true };

  if (typeof args.context !== 'object' || args.context === null || Array.isArray(args.context)) {
    const details = {
      kind: 'context_invalid_shape',
      tool: args.tool,
      expected: 'object',
    } satisfies ContextValidationDetails & JsonObject;

    return {
      ok: false,
      error: errNotRetryable('VALIDATION_ERROR', `context must be a JSON object for ${args.tool}.`, {
        suggestion:
          'Pass context as an object of external inputs (e.g., {"ticketId":"...","repoPath":"..."}). Do not pass arrays or primitives.',
        details,
      }) as ToolFailure,
    };
  }

  const contextObj = args.context as JsonObject;

  const issue = validateJsonValueOrIssue(contextObj, '$', 0, new WeakSet());
  if (issue) {
    const details = (() => {
      switch (issue.kind) {
        case 'unsupported_value':
          return {
            kind: 'context_unsupported_value',
            tool: args.tool,
            path: issue.path,
            valueType: issue.valueType,
          } satisfies ContextValidationDetails & JsonObject;
        case 'non_finite_number':
          return {
            kind: 'context_non_finite_number',
            tool: args.tool,
            path: issue.path,
            value: issue.value,
          } satisfies ContextValidationDetails & JsonObject;
        case 'circular_reference':
          return {
            kind: 'context_circular_reference',
            tool: args.tool,
            path: issue.path,
          } satisfies ContextValidationDetails & JsonObject;
        case 'too_deep':
          return {
            kind: 'context_too_deep',
            tool: args.tool,
            path: issue.path,
            maxDepth: issue.maxDepth,
          } satisfies ContextValidationDetails & JsonObject;
        default: {
          const _exhaustive: never = issue;
          return {
            kind: 'context_invalid_shape',
            tool: args.tool,
            expected: 'object',
          } satisfies ContextValidationDetails & JsonObject;
        }
      }
    })();

    return {
      ok: false,
      error: errNotRetryable(
        'VALIDATION_ERROR',
        normalizeTokenErrorMessage(`context is not JSON-serializable for ${args.tool} (see details).`),
        {
          suggestion:
            'Remove non-JSON values (undefined/functions/symbols), circular references, and non-finite numbers. Keep context to plain JSON objects/arrays/primitives only.',
          details: details as unknown as JsonValue,
        }
      ) as ToolFailure,
    };
  }

  const canonicalRes = toCanonicalBytes(contextObj);
  if (canonicalRes.isErr()) {
    const details = {
      kind: 'context_not_canonical_json',
      tool: args.tool,
      measuredAs: 'jcs_utf8_bytes',
      code: canonicalRes.error.code,
      message: canonicalRes.error.message,
    } satisfies ContextValidationDetails & JsonObject;

    const suggestion =
      canonicalRes.error.code === 'CANONICAL_JSON_NON_FINITE_NUMBER'
        ? 'Remove NaN/Infinity/-Infinity from context. Canonical JSON forbids non-finite numbers.'
        : 'Ensure context contains only JSON primitives, arrays, and objects (no undefined/functions/symbols).';

    return {
      ok: false,
      error: errNotRetryable(
        'VALIDATION_ERROR',
        normalizeTokenErrorMessage(`context cannot be canonicalized for ${args.tool}: ${canonicalRes.error.code}`),
        {
          suggestion,
          details,
        }
      ) as ToolFailure,
    };
  }

  const measuredBytes = (canonicalRes.value as unknown as Uint8Array).length as Bytes;
  if (measuredBytes > MAX_CONTEXT_BYTES_V2) {
    const details = {
      kind: 'context_budget_exceeded',
      tool: args.tool,
      measuredBytes,
      maxBytes: MAX_CONTEXT_BYTES_V2,
      measuredAs: 'jcs_utf8_bytes',
    } satisfies ContextValidationDetails & JsonObject;

    return {
      ok: false,
      error: errNotRetryable(
        'VALIDATION_ERROR',
        `context is too large for ${args.tool}: ${measuredBytes} bytes (max ${MAX_CONTEXT_BYTES_V2}). Size is measured as UTF-8 bytes of RFC 8785 (JCS) canonical JSON.`,
        {
          suggestion:
            'Remove large blobs from context (docs/logs/diffs). Pass references instead (file paths, IDs, hashes). If you must include text, include only the minimal excerpt, then retry.',
          details,
        }
      ) as ToolFailure,
    };
  }

  return { ok: true };
}

type ToolFailure = Extract<ToolResult<unknown>, { readonly type: 'error' }>;

// Typed error discriminators for internal flow control (not exposed to users)
type InternalError = 
  | { readonly kind: 'missing_node_or_run' }
  | { readonly kind: 'workflow_hash_mismatch' }
  | { readonly kind: 'missing_snapshot' }
  | { readonly kind: 'no_pending_step' }
  | { readonly kind: 'token_scope_mismatch'; readonly message: string }
  | { readonly kind: 'invariant_violation'; readonly message: string }
  | { readonly kind: 'advance_apply_failed'; readonly message: string }
  | { readonly kind: 'advance_next_failed'; readonly message: string };

/**
 * Type guard for InternalError discriminated union.
 * Returns true only if `e` is a valid InternalError with known kind.
 */
function isInternalError(e: unknown): e is InternalError {
  if (typeof e !== 'object' || e === null || !('kind' in e)) return false;
  const kind = (e as { kind: unknown }).kind;
  return (
    kind === 'missing_node_or_run' ||
    kind === 'workflow_hash_mismatch' ||
    kind === 'missing_snapshot' ||
    kind === 'no_pending_step' ||
    kind === 'token_scope_mismatch' ||
    kind === 'invariant_violation' ||
    kind === 'advance_apply_failed' ||
    kind === 'advance_next_failed'
  );
}

/**
 * Map InternalError to ToolError using exhaustive switch.
 * Compile error if new InternalError kind added without handler.
 */
function mapInternalErrorToToolError(e: InternalError): ToolFailure {
  switch (e.kind) {
    case 'missing_node_or_run':
      return errNotRetryable(
        'PRECONDITION_FAILED',
        'No durable run/node state was found for this stateToken. Advancement cannot be recorded.',
        { suggestion: 'Use a stateToken returned by WorkRail for an existing run/node.' }
      ) as ToolFailure;
    case 'workflow_hash_mismatch':
      return errNotRetryable(
        'TOKEN_WORKFLOW_HASH_MISMATCH',
        'workflowHash mismatch for this node.',
        { suggestion: 'Use the stateToken returned by WorkRail for this node.' }
      ) as ToolFailure;
    case 'token_scope_mismatch':
      return errNotRetryable(
        'TOKEN_SCOPE_MISMATCH',
        normalizeTokenErrorMessage(e.message),
        { suggestion: 'Use the correct token type for this operation.' }
      ) as ToolFailure;
    case 'missing_snapshot':
    case 'no_pending_step':
      return internalError('Incomplete execution state.', 'Retry; if this persists, treat as invariant violation.');
    case 'invariant_violation':
      return internalError(normalizeTokenErrorMessage(e.message), 'Treat as invariant violation.');
    case 'advance_apply_failed':
    case 'advance_next_failed':
      return internalError(normalizeTokenErrorMessage(e.message), 'Retry; if this persists, treat as invariant violation.');
    default:
      const _exhaustive: never = e;
      return internalError('Unknown internal error kind', 'Treat as invariant violation.');
  }
}

/**
 * Replay response from recorded advance facts (idempotent path).
 * Fact-returning response: load recorded outcome and return from durable facts without recompute.
 */
function replayFromRecordedAdvance(args: {
  readonly recordedEvent: Extract<DomainEventV1, { kind: 'advance_recorded' }>;
  readonly truth: LoadedSessionTruthV2;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly workflowHash: WorkflowHash;
  readonly attemptId: AttemptId;
  readonly inputStateToken: string;
  readonly inputAckToken: string;
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly snapshotStore: import('../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly sha256: Sha256PortV2;
  readonly tokenCodecPorts: TokenCodecPorts;
}): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  const {
    recordedEvent,
    truth,
    sessionId,
    runId,
    nodeId,
    workflowHash,
    attemptId,
    inputStateToken,
    inputAckToken,
    pinnedWorkflow,
    snapshotStore,
    sha256,
    tokenCodecPorts,
  } = args;

  if (recordedEvent.data.outcome.kind === 'blocked') {
    const blockers = recordedEvent.data.outcome.blockers;
    const snapNode = truth.events.find(
      (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
        e.kind === 'node_created' && e.scope?.nodeId === String(nodeId)
    );

    const snapRA = snapNode
      ? snapshotStore.getExecutionSnapshotV1(snapNode.data.snapshotRef).mapErr((cause) => ({ kind: 'snapshot_load_failed' as const, cause }))
      : okAsync(null);

    return snapRA.map((snap) => {
      const pendingNow = snap ? derivePendingStep(snap.enginePayload.engineState) : null;
      const isCompleteNow = snap ? deriveIsComplete(snap.enginePayload.engineState) : false;

      // S9: Use renderPendingPrompt (no recovery for replay; fact-returning)
      const meta = pendingNow
        ? renderPendingPrompt({
            workflow: pinnedWorkflow,
            stepId: String(pendingNow.stepId),
            loopPath: pendingNow.loopPath,
            truth,
            runId: asRunId(String(runId)),
            nodeId: asNodeId(String(nodeId)),
            rehydrateOnly: false,
          }).unwrapOr({
            stepId: String(pendingNow.stepId),
            title: String(pendingNow.stepId),
            prompt: `Pending step: ${String(pendingNow.stepId)}`,
            requireConfirmation: false,
          })
        : null;

      const preferences = derivePreferencesForNode({ truth, runId, nodeId });
      const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete: isCompleteNow, pending: meta });

      return V2ContinueWorkflowOutputSchema.parse({
        kind: 'blocked',
        stateToken: inputStateToken,
        ackToken: inputAckToken,
        isComplete: isCompleteNow,
        pending: meta ? { stepId: meta.stepId, title: meta.title, prompt: meta.prompt } : null,
        preferences,
        nextIntent,
        blockers,
        retryable: undefined,
        retryAckToken: undefined,
        validation: loadValidationResultV1(truth.events, `validation_${String(attemptId)}`).unwrapOr(null) ?? undefined,
      });
    });
  }

  const toNodeId = recordedEvent.data.outcome.toNodeId;
  const toNodeIdBranded = asNodeId(String(toNodeId));
  const toNode = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
      e.kind === 'node_created' && e.scope?.nodeId === String(toNodeId)
  );
  if (!toNode) {
    return neErrorAsync({
      kind: 'invariant_violation' as const,
      message: 'Missing node_created for advanced toNodeId (invariant violation).',
      suggestion: 'Retry; if this persists, treat as invariant violation.',
    });
  }

  return snapshotStore
    .getExecutionSnapshotV1(toNode.data.snapshotRef)
    .mapErr((cause) => ({ kind: 'snapshot_load_failed' as const, cause }))
    .andThen((snap) => {
      if (!snap) {
        return neErrorAsync({
          kind: 'invariant_violation' as const,
          message: 'Missing execution snapshot for advanced node (invariant violation).',
          suggestion: 'Retry; if this persists, treat as invariant violation.',
        });
      }

      const pending = derivePendingStep(snap.enginePayload.engineState);
      const isComplete = deriveIsComplete(snap.enginePayload.engineState);

      const nextAttemptId = attemptIdForNextNode(attemptId, sha256);
      const nextAckTokenRes = pending
        ? signTokenOrErr({
            payload: { tokenVersion: 1, tokenKind: 'ack', sessionId, runId, nodeId: toNodeIdBranded, attemptId: nextAttemptId },
            ports: tokenCodecPorts,
          })
        : ok(undefined);
      if (nextAckTokenRes.isErr()) {
        return neErrorAsync({ kind: 'token_signing_failed' as const, cause: nextAckTokenRes.error });
      }

      const wfRefRes = deriveWorkflowHashRef(workflowHash);
      if (wfRefRes.isErr()) {
        return neErrorAsync({ kind: 'precondition_failed' as const, message: wfRefRes.error.message, suggestion: 'Ensure workflowHash is a valid sha256 digest.' });
      }
      const nextStateTokenRes = signTokenOrErr({
        payload: { tokenVersion: 1, tokenKind: 'state', sessionId, runId, nodeId: toNodeIdBranded, workflowHashRef: wfRefRes.value },
        ports: tokenCodecPorts,
      });
      if (nextStateTokenRes.isErr()) {
        return neErrorAsync({ kind: 'token_signing_failed' as const, cause: nextStateTokenRes.error });
      }

      if (snap.enginePayload.engineState.kind === 'blocked') {
        const blocked = snap.enginePayload.engineState.blocked;
        const blockers = blocked.blockers;
        const retryable = blocked.kind === 'retryable_block';
        const retryAckTokenRes = retryable
          ? signTokenOrErr({
              payload: {
                tokenVersion: 1,
                tokenKind: 'ack',
                sessionId,
                runId,
                nodeId: toNodeIdBranded,
                attemptId: asAttemptId(String(blocked.retryAttemptId)),
              },
              ports: tokenCodecPorts,
            })
          : ok(undefined);
        if (retryAckTokenRes.isErr()) {
          return neErrorAsync({ kind: 'token_signing_failed' as const, cause: retryAckTokenRes.error });
        }
        const validation = loadValidationResultV1(truth.events, String(blocked.validationRef)).unwrapOr(null) ?? undefined;

        // S9: Use renderPendingPrompt (no recovery for replay; fact-returning)
        const meta = pending
          ? renderPendingPrompt({
              workflow: pinnedWorkflow,
              stepId: String(pending.stepId),
              loopPath: pending.loopPath,
              truth,
              runId: asRunId(String(runId)),
              nodeId: asNodeId(String(toNodeIdBranded)),
              rehydrateOnly: false,
            }).unwrapOr({
              stepId: String(pending.stepId),
              title: String(pending.stepId),
              prompt: `Pending step: ${String(pending.stepId)}`,
              requireConfirmation: false,
            })
          : null;

        const preferences = derivePreferencesForNode({ truth, runId, nodeId: toNodeIdBranded });
        const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete, pending: meta });

        return okAsync(
          V2ContinueWorkflowOutputSchema.parse({
            kind: 'blocked',
            stateToken: nextStateTokenRes.value,
            ackToken: pending ? nextAckTokenRes.value : undefined,
            isComplete,
            pending: meta ? { stepId: meta.stepId, title: meta.title, prompt: meta.prompt } : null,
            preferences,
            nextIntent,
            blockers,
            retryable,
            retryAckToken: retryAckTokenRes.value,
            validation,
          })
        );
      }

      // S9: Use renderPendingPrompt (no recovery for replay; fact-returning)
      const meta = pending
        ? renderPendingPrompt({
            workflow: pinnedWorkflow,
            stepId: String(pending.stepId),
            loopPath: pending.loopPath,
            truth,
            runId: asRunId(String(runId)),
            nodeId: asNodeId(String(toNodeIdBranded)),
            rehydrateOnly: false,
          }).unwrapOr({
            stepId: String(pending.stepId),
            title: String(pending.stepId),
            prompt: `Pending step: ${String(pending.stepId)}`,
            requireConfirmation: false,
          })
        : { stepId: '', title: '', prompt: '', requireConfirmation: false };

      const preferences = derivePreferencesForNode({ truth, runId, nodeId: toNodeIdBranded });
      const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete, pending: pending ? meta : null });

      return okAsync(
        V2ContinueWorkflowOutputSchema.parse({
          kind: 'ok',
          stateToken: nextStateTokenRes.value,
          ackToken: pending ? nextAckTokenRes.value : undefined,
          isComplete,
          pending: pending ? { stepId: meta.stepId, title: meta.title, prompt: meta.prompt } : null,
          preferences,
          nextIntent,
        })
      );
    });
}

/**
 * Compute next state, append events, and return success sentinel (first-advance path).
 * Executed under a healthy session lock witness.
 */
function advanceAndRecord(args: {
  readonly truth: LoadedSessionTruthV2;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly workflowHash: WorkflowHash;
  readonly dedupeKey: string;
  readonly inputContext: JsonValue | undefined;
  readonly inputOutput: V2ContinueWorkflowInput['output'];
  readonly lock: WithHealthySessionLock;
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly snapshotStore: import('../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly sessionStore: import('../../v2/ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2;
  readonly sha256: Sha256PortV2;
  readonly idFactory: { readonly mintNodeId: () => NodeId; readonly mintEventId: () => string };
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { truth, sessionId, runId, nodeId, attemptId, workflowHash, dedupeKey, inputContext, inputOutput, lock, pinnedWorkflow, snapshotStore, sessionStore, sha256, idFactory } = args;

  // Enforce invariants: do not record advance attempts for unknown nodes.
  const hasRun = truth.events.some((e) => e.kind === 'run_started' && e.scope?.runId === String(runId));
  const hasNode = truth.events.some(
    (e) => e.kind === 'node_created' && e.scope?.runId === String(runId) && e.scope?.nodeId === String(nodeId)
  );
  if (!hasRun || !hasNode) {
    return errAsync({ kind: 'missing_node_or_run' as const });
  }

  // NOW instantiate compiler/interpreter
  const compiler = new WorkflowCompiler();
  const interpreter = new WorkflowInterpreter();
  const compiledWf = compiler.compile(pinnedWorkflow);
  if (compiledWf.isErr()) {
    return errAsync({ kind: 'advance_apply_failed', message: compiledWf.error.message } as const);
  }

  // Load current node snapshot to compute next state.
  const nodeCreated = truth.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_created' }> => e.kind === 'node_created' && e.scope?.nodeId === String(nodeId)
  );
  if (!nodeCreated) {
    return errAsync({ kind: 'missing_node_or_run' as const });
  }
  if (String(nodeCreated.data.workflowHash) !== String(workflowHash)) {
    return errAsync({ kind: 'workflow_hash_mismatch' as const });
  }

  return snapshotStore.getExecutionSnapshotV1(nodeCreated.data.snapshotRef).andThen((snap) => {
    if (!snap) return errAsync({ kind: 'missing_snapshot' as const });
    const engineState = snap.enginePayload.engineState;
    
    // Blocked node retry path: nodeKind === 'blocked_attempt' signals a retry attempt.
    if (nodeCreated.data.nodeKind === 'blocked_attempt') {
      if (engineState.kind !== 'blocked') {
        return errAsync({ kind: 'invariant_violation' as const, message: 'blocked_attempt node requires engineState.kind=blocked' });
      }
      
      const blocked = engineState.blocked;
      if (blocked.kind !== 'retryable_block') {
        // Terminal blocks cannot be retried; reject with TOKEN_SCOPE_MISMATCH.
        return errAsync({
          kind: 'token_scope_mismatch' as const,
          message: 'Cannot retry a terminal blocked_attempt node (blocked.kind=terminal_block).',
        });
      }
      
      // Retry advance logic: re-run validation with new output and either advance or chain another blocked node.
      return handleRetryAdvance({
        truth,
        sessionId,
        runId,
        blockedNodeId: nodeId,
        retryAttemptId: attemptId,
        workflowHash,
        dedupeKey,
        inputContext,
        inputOutput,
        lock,
        pinnedWorkflow,
        blockedSnapshot: snap,
        snapshotStore,
        sessionStore,
        sha256,
        idFactory,
      });
    }
    
    // Normal advance path (not a retry).
    const currentState = toV1ExecutionState(engineState);
    const pendingStep = (currentState.kind === 'running' && currentState.pendingStep) ? currentState.pendingStep : null;
    if (!pendingStep) {
      return errAsync({ kind: 'no_pending_step' as const });
    }
    // S8: Auto-load stored context from context_set events, merge with input delta
    const storedContextRes = projectRunContextV2(truth.events);
    const storedContext = storedContextRes.isOk() ? storedContextRes.value.byRunId[String(runId)]?.context : undefined;
    
    const inputContextObj =
      inputContext && typeof inputContext === 'object' && inputContext !== null && !Array.isArray(inputContext)
        ? (inputContext as JsonObject)
        : undefined;
    
    const mergedContextRes = mergeContext(storedContext, inputContextObj);
    if (mergedContextRes.isErr()) {
      return errAsync({
        kind: 'invariant_violation' as const,
        message: `Context merge failed: ${mergedContextRes.error.message}`,
      });
    }
    
    const ctxObj = mergedContextRes.value as Record<string, unknown>;

    const step = getStepById(pinnedWorkflow, String(pendingStep.stepId)) as unknown as Record<string, unknown> | null;
    const validationCriteria = step && typeof step === 'object' && step !== null ? (step.validationCriteria as any) : undefined;

    const notesMarkdown = inputOutput?.notesMarkdown;
    const validator = validationCriteria ? new ValidationEngine(new EnhancedLoopValidator()) : null;

    const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T> => {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      return Promise.race([operation, timeoutPromise]);
    };

    const validationRes: RA<ValidationResult | undefined, InternalError> =
      validator && notesMarkdown
        ? RA.fromPromise(
            withTimeout(validator.validate(notesMarkdown, validationCriteria as any, ctxObj as any), 30_000, 'ValidationEngine.validate'),
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
      const outputRequirement = getOutputRequirementStatusV1({
        validationCriteria,
        notesMarkdown,
        validation,
      });

      const reasonsRes = detectBlockingReasonsV1({ outputRequirement });
      if (reasonsRes.isErr()) {
        return errAsync({ kind: 'invariant_violation' as const, message: reasonsRes.error.message } as const);
      }

      const reasons = reasonsRes.value;

      // Derive autonomy from durable preferences snapshot (defaults to guided).
      const parentByNodeId: Record<string, string | null> = {};
      for (const e of truth.events) {
        if (e.kind !== 'node_created') continue;
        if (e.scope?.runId !== String(runId)) continue;
        parentByNodeId[String(e.scope.nodeId)] = e.data.parentNodeId;
      }

      const prefs = projectPreferencesV2(truth.events, parentByNodeId);
      const autonomy = prefs.isOk() ? prefs.value.byNodeId[String(nodeId)]?.effective.autonomy ?? 'guided' : 'guided';

      // If there are any reasons that would block, either:
      // - block (guided / stop-on-user-deps)
      // - record gap(s) and continue (never-stop)
      const shouldBlockNow = reasons.length > 0 && shouldBlock(autonomy, reasons);

      if (shouldBlockNow) {
        const blockersRes = buildBlockerReport(reasons);
        if (blockersRes.isErr()) {
          return errAsync({ kind: 'invariant_violation' as const, message: blockersRes.error.message } as const);
        }

        const validationEventId = idFactory.mintEventId();
        const validationId = `validation_${String(attemptId)}`;
        const contractRefForEvent = outputRequirement.kind !== 'not_required' ? outputRequirement.contractRef : 'none';
        const validationForEvent: ValidationResult =
          validation ??
          (outputRequirement.kind === 'missing'
            ? {
                valid: false,
                issues: [`Missing required output for contractRef=${contractRefForEvent}`],
                suggestions: [],
                warnings: undefined,
              }
            : {
                valid: false,
                issues: ['Validation result missing'],
                suggestions: [],
                warnings: undefined,
              });

        const validationEventRes = buildValidationPerformedEvent({
          sessionId: String(sessionId),
          validationId,
          attemptId: String(attemptId),
          contractRef: contractRefForEvent,
          scope: { runId: String(runId), nodeId: String(nodeId) },
          minted: { eventId: validationEventId },
          result: validationForEvent,
        });
        if (validationEventRes.isErr()) {
          return errAsync({ kind: 'invariant_violation' as const, message: validationEventRes.error.message } as const);
        }

        const extraEventsToAppend = [validationEventRes.value];
        if (!extraEventsToAppend.some((e) => e.kind === 'validation_performed')) {
          return errAsync({
            kind: 'invariant_violation' as const,
            message: 'Blocked outcomes require validation event',
          });
        }

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
          const toNodeId = String(idFactory.mintNodeId());
          const nextEventIndex = truth.events.length === 0 ? 0 : truth.events[truth.events.length - 1]!.eventIndex + 1;

          const evtAdvanceRecorded = idFactory.mintEventId();
          const evtNodeCreated = idFactory.mintEventId();
          const evtEdgeCreated = idFactory.mintEventId();

          const hasChildren = truth.events.some(
            (e): e is Extract<DomainEventV1, { kind: 'edge_created' }> =>
              e.kind === 'edge_created' && e.data.fromNodeId === String(nodeId)
          );
          const causeKind: 'non_tip_advance' | 'intentional_fork' = hasChildren ? 'non_tip_advance' : 'intentional_fork';

          const planRes = buildAckAdvanceAppendPlanV1({
            sessionId: String(sessionId),
            runId: String(runId),
            fromNodeId: String(nodeId),
            workflowHash,
            attemptId: String(attemptId),
            nextEventIndex,
            extraEventsToAppend,
            toNodeId,
            toNodeKind: 'blocked_attempt',
            snapshotRef: blockedSnapshotRef,
            causeKind,
            minted: {
              advanceRecordedEventId: evtAdvanceRecorded,
              nodeCreatedEventId: evtNodeCreated,
              edgeCreatedEventId: evtEdgeCreated,
              outputEventIds: [],
            },
            outputsToAppend: [],
          });
          if (planRes.isErr()) return errAsync({ kind: 'invariant_violation' as const, message: planRes.error.message });

          return sessionStore.append(lock, planRes.value);
        });
      }

      const allowNotesAppend = validationCriteria
        ? Boolean(notesMarkdown && validation && validation.valid)
        : Boolean(notesMarkdown);

      const gapEventsToAppend: readonly Omit<DomainEventV1, 'eventIndex' | 'sessionId'>[] =
        autonomy === 'full_auto_never_stop' && reasons.length > 0
          ? reasons.map((r, idx) => {
              const g = reasonToGap(r);
              const gapId = `gap_${String(attemptId)}_${idx}`;
              return {
                v: 1 as const,
                eventId: idFactory.mintEventId(),
                kind: 'gap_recorded' as const,
                dedupeKey: `gap_recorded:${String(sessionId)}:${gapId}`,
                scope: { runId: String(runId), nodeId: String(nodeId) },
                data: {
                  gapId,
                  severity: g.severity,
                  reason: g.reason,
                  summary: g.summary,
                  resolution: { kind: 'unresolved' as const },
                },
              };
            })
          : [];

      // S8: Emit context_set if input delta provided
      const contextSetEvents: readonly Omit<DomainEventV1, 'eventIndex' | 'sessionId'>[] =
        inputContextObj
          ? [
              {
                v: 1 as const,
                eventId: idFactory.mintEventId(),
                kind: 'context_set' as const,
                dedupeKey: `context_set:${String(sessionId)}:${String(runId)}:${idFactory.mintEventId()}`,
                scope: { runId: String(runId) },
                data: {
                  contextId: idFactory.mintEventId(),
                  context: mergedContextRes.value as unknown as JsonValue,
                  source: 'agent_delta' as const,
                },
              } as Omit<DomainEventV1, 'eventIndex' | 'sessionId'>,
            ]
          : [];

      const extraEventsToAppend = [...gapEventsToAppend, ...contextSetEvents];

      const event: WorkflowEvent = { kind: 'step_completed', stepInstanceId: pendingStep };
      const advanced = interpreter.applyEvent(currentState, event);
      if (advanced.isErr()) {
        return errAsync({ kind: 'advance_apply_failed', message: advanced.error.message } as const);
      }

      const nextRes = interpreter.next(compiledWf.value, advanced.value, ctxObj);
      if (nextRes.isErr()) {
        return errAsync({ kind: 'advance_next_failed', message: nextRes.error.message } as const);
      }

      const out = nextRes.value;
    const newEngineState = fromV1ExecutionState(out.state);
    const snapshotFile: ExecutionSnapshotFileV1 = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: { v: 1, engineState: newEngineState },
    };

    return snapshotStore.putExecutionSnapshotV1(snapshotFile).andThen((newSnapshotRef) => {
      const toNodeId = String(idFactory.mintNodeId());
      const nextEventIndex = truth.events.length === 0 ? 0 : truth.events[truth.events.length - 1]!.eventIndex + 1;

      const evtAdvanceRecorded = idFactory.mintEventId();
      const evtNodeCreated = idFactory.mintEventId();
      const evtEdgeCreated = idFactory.mintEventId();

      const hasChildren = truth.events.some(
        (e): e is Extract<DomainEventV1, { kind: 'edge_created' }> =>
          e.kind === 'edge_created' && e.data.fromNodeId === String(nodeId)
      );
      const causeKind: 'non_tip_advance' | 'intentional_fork' = hasChildren ? 'non_tip_advance' : 'intentional_fork';

      const outputId = asOutputId(`out_recap_${String(attemptId)}`);
      const outputsToAppend =
        allowNotesAppend && inputOutput?.notesMarkdown
          ? [
              {
                outputId: String(outputId),
                outputChannel: 'recap' as const,
                payload: {
                  payloadKind: 'notes' as const,
                  notesMarkdown: toNotesMarkdownV1(inputOutput.notesMarkdown),
                },
              },
            ]
          : [];

      const normalizedOutputs = normalizeOutputsForAppend(outputsToAppend);
      const outputEventIds = normalizedOutputs.map(() => idFactory.mintEventId());

      const planRes = buildAckAdvanceAppendPlanV1({
        sessionId: String(sessionId),
        runId: String(runId),
        fromNodeId: String(nodeId),
        workflowHash,
        attemptId: String(attemptId),
        nextEventIndex,
        extraEventsToAppend,
        toNodeId,
        snapshotRef: newSnapshotRef,
        causeKind,
        minted: {
          advanceRecordedEventId: evtAdvanceRecorded,
          nodeCreatedEventId: evtNodeCreated,
          edgeCreatedEventId: evtEdgeCreated,
          outputEventIds,
        },
        outputsToAppend,
      });
      if (planRes.isErr()) return errAsync({ kind: 'invariant_violation' as const, message: planRes.error.message });

      return sessionStore.append(lock, planRes.value);
    });
    });
  });
}

function errAsync(e: InternalError): RA<never, InternalError> {
  return neErrorAsync(e);
}

/**
 * Handle retry advance from a blocked_attempt node.
 * This runs validation again with new output and either creates the next step or chains another blocked node.
 */
function handleRetryAdvance(args: {
  readonly truth: LoadedSessionTruthV2;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly blockedNodeId: NodeId;
  readonly retryAttemptId: AttemptId;
  readonly workflowHash: WorkflowHash;
  readonly dedupeKey: string;
  readonly inputContext: JsonValue | undefined;
  readonly inputOutput: V2ContinueWorkflowInput['output'];
  readonly lock: WithHealthySessionLock;
  readonly pinnedWorkflow: ReturnType<typeof createWorkflow>;
  readonly blockedSnapshot: ExecutionSnapshotFileV1;
  readonly snapshotStore: import('../../v2/ports/snapshot-store.port.js').SnapshotStorePortV2;
  readonly sessionStore: import('../../v2/ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2;
  readonly sha256: Sha256PortV2;
  readonly idFactory: { readonly mintNodeId: () => NodeId; readonly mintEventId: () => string };
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { truth, sessionId, runId, blockedNodeId, retryAttemptId, workflowHash, inputContext, inputOutput, lock, pinnedWorkflow, blockedSnapshot, snapshotStore, sessionStore, sha256, idFactory } = args;
  
  const engineState = blockedSnapshot.enginePayload.engineState;
  if (engineState.kind !== 'blocked') {
    return errAsync({ kind: 'invariant_violation' as const, message: 'blocked snapshot must have engineState.kind=blocked' });
  }
  
  const pendingStep = derivePendingStep(engineState);
  if (!pendingStep) {
    return errAsync({ kind: 'no_pending_step' as const });
  }
  
  const storedContextRes = projectRunContextV2(truth.events);
  const storedContext = storedContextRes.isOk() ? storedContextRes.value.byRunId[String(runId)]?.context : undefined;
  
  const inputContextObj =
    inputContext && typeof inputContext === 'object' && inputContext !== null && !Array.isArray(inputContext)
      ? (inputContext as JsonObject)
      : undefined;
  
  const mergedContextRes = mergeContext(storedContext, inputContextObj);
  if (mergedContextRes.isErr()) {
    return errAsync({
      kind: 'invariant_violation' as const,
      message: `Context merge failed: ${mergedContextRes.error.message}`,
    });
  }
  
  const ctxObj = mergedContextRes.value as Record<string, unknown>;
  
  const step = getStepById(pinnedWorkflow, String(pendingStep.stepId)) as unknown as Record<string, unknown> | null;
  const validationCriteria = step && typeof step === 'object' && step !== null ? (step.validationCriteria as any) : undefined;
  
  const notesMarkdown = inputOutput?.notesMarkdown;
  const validator = validationCriteria ? new ValidationEngine(new EnhancedLoopValidator()) : null;
  
  const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T> => {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([operation, timeoutPromise]);
  };
  
  const validationRes: RA<ValidationResult | undefined, InternalError> =
    validator && notesMarkdown
      ? RA.fromPromise(
          withTimeout(validator.validate(notesMarkdown, validationCriteria as any, ctxObj as any), 30_000, 'ValidationEngine.validate'),
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
    const outputRequirement = getOutputRequirementStatusV1({
      validationCriteria,
      notesMarkdown,
      validation,
    });
    
    const reasonsRes = detectBlockingReasonsV1({ outputRequirement });
    if (reasonsRes.isErr()) {
      return errAsync({ kind: 'invariant_violation' as const, message: reasonsRes.error.message } as const);
    }
    
    const reasons = reasonsRes.value;
    
    const parentByNodeId: Record<string, string | null> = {};
    for (const e of truth.events) {
      if (e.kind !== 'node_created') continue;
      if (e.scope?.runId !== String(runId)) continue;
      parentByNodeId[String(e.scope.nodeId)] = e.data.parentNodeId;
    }
    
    const prefs = projectPreferencesV2(truth.events, parentByNodeId);
    const autonomy = prefs.isOk() ? prefs.value.byNodeId[String(blockedNodeId)]?.effective.autonomy ?? 'guided' : 'guided';
    
    const shouldBlockNow = reasons.length > 0 && shouldBlock(autonomy, reasons);
    
    if (shouldBlockNow) {
      // Retry failed validation → create chained blocked node (parent = previous blocked node).
      const blockersRes = buildBlockerReport(reasons);
      if (blockersRes.isErr()) {
        return errAsync({ kind: 'invariant_violation' as const, message: blockersRes.error.message } as const);
      }
      
      const validationEventId = idFactory.mintEventId();
      const validationId = `validation_${String(retryAttemptId)}`;
      const contractRefForEvent = outputRequirement.kind !== 'not_required' ? outputRequirement.contractRef : 'none';
      const validationForEvent: ValidationResult =
        validation ??
        (outputRequirement.kind === 'missing'
          ? {
              valid: false,
              issues: [`Missing required output for contractRef=${contractRefForEvent}`],
              suggestions: [],
              warnings: undefined,
            }
          : {
              valid: false,
              issues: ['Validation result missing'],
              suggestions: [],
              warnings: undefined,
            });
      
      const validationEventRes = buildValidationPerformedEvent({
        sessionId: String(sessionId),
        validationId,
        attemptId: String(retryAttemptId),
        contractRef: contractRefForEvent,
        scope: { runId: String(runId), nodeId: String(blockedNodeId) },
        minted: { eventId: validationEventId },
        result: validationForEvent,
      });
      if (validationEventRes.isErr()) {
        return errAsync({ kind: 'invariant_violation' as const, message: validationEventRes.error.message } as const);
      }
      
      const primaryReason = reasons[0];
      if (!primaryReason) {
        return errAsync({ kind: 'invariant_violation' as const, message: 'shouldBlockNow=true requires at least one reason' } as const);
      }
      
      const chainedBlockedSnapshotRes = buildBlockedNodeSnapshot({
        priorSnapshot: blockedSnapshot,
        primaryReason,
        attemptId: retryAttemptId,
        validationRef: validationId,
        blockers: blockersRes.value,
        sha256,
      });
      if (chainedBlockedSnapshotRes.isErr()) {
        return errAsync({ kind: 'invariant_violation' as const, message: chainedBlockedSnapshotRes.error.message } as const);
      }
      
      return snapshotStore.putExecutionSnapshotV1(chainedBlockedSnapshotRes.value).andThen((chainedSnapshotRef) => {
        const toNodeId = String(idFactory.mintNodeId());
        const nextEventIndex = truth.events.length === 0 ? 0 : truth.events[truth.events.length - 1]!.eventIndex + 1;
        
        const evtAdvanceRecorded = idFactory.mintEventId();
        const evtNodeCreated = idFactory.mintEventId();
        const evtEdgeCreated = idFactory.mintEventId();
        
        const hasChildren = truth.events.some(
          (e): e is Extract<DomainEventV1, { kind: 'edge_created' }> =>
            e.kind === 'edge_created' && e.data.fromNodeId === String(blockedNodeId)
        );
        const causeKind: 'non_tip_advance' | 'intentional_fork' = hasChildren ? 'non_tip_advance' : 'intentional_fork';
        
        const planRes = buildAckAdvanceAppendPlanV1({
          sessionId: String(sessionId),
          runId: String(runId),
          fromNodeId: String(blockedNodeId),
          workflowHash,
          attemptId: String(retryAttemptId),
          nextEventIndex,
          extraEventsToAppend: [validationEventRes.value],
          toNodeId,
          toNodeKind: 'blocked_attempt',
          snapshotRef: chainedSnapshotRef,
          causeKind,
          minted: {
            advanceRecordedEventId: evtAdvanceRecorded,
            nodeCreatedEventId: evtNodeCreated,
            edgeCreatedEventId: evtEdgeCreated,
            outputEventIds: [],
          },
          outputsToAppend: [],
        });
        if (planRes.isErr()) return errAsync({ kind: 'invariant_violation' as const, message: planRes.error.message });
        
        return sessionStore.append(lock, planRes.value);
      });
    }
    
    // Retry succeeded → advance to next step.
    const compiler = new WorkflowCompiler();
    const interpreter = new WorkflowInterpreter();
    const compiledWf = compiler.compile(pinnedWorkflow);
    if (compiledWf.isErr()) {
      return errAsync({ kind: 'advance_apply_failed', message: compiledWf.error.message } as const);
    }
    
    const currentState = toV1ExecutionState(engineState);
    const gapEventsToAppend: readonly Omit<DomainEventV1, 'eventIndex' | 'sessionId'>[] =
      autonomy === 'full_auto_never_stop' && reasons.length > 0
        ? reasons.map((r, idx) => {
            const g = reasonToGap(r);
            const gapId = `gap_${String(retryAttemptId)}_${idx}`;
            return {
              v: 1 as const,
              eventId: idFactory.mintEventId(),
              kind: 'gap_recorded' as const,
              dedupeKey: `gap_recorded:${String(sessionId)}:${gapId}`,
              scope: { runId: String(runId), nodeId: String(blockedNodeId) },
              data: {
                gapId,
                severity: g.severity,
                reason: g.reason,
                summary: g.summary,
                resolution: { kind: 'unresolved' as const },
              },
            };
          })
        : [];
    
    const contextSetEvents: readonly Omit<DomainEventV1, 'eventIndex' | 'sessionId'>[] =
      inputContextObj
        ? [
            {
              v: 1 as const,
              eventId: idFactory.mintEventId(),
              kind: 'context_set' as const,
              dedupeKey: `context_set:${String(sessionId)}:${String(runId)}:${idFactory.mintEventId()}`,
              scope: { runId: String(runId) },
              data: {
                contextId: idFactory.mintEventId(),
                context: mergedContextRes.value as unknown as JsonValue,
                source: 'agent_delta' as const,
              },
            } as Omit<DomainEventV1, 'eventIndex' | 'sessionId'>,
          ]
        : [];
    
    const validationEventId = idFactory.mintEventId();
    const validationId = `validation_${String(retryAttemptId)}`;
    const contractRefForEvent = outputRequirement.kind !== 'not_required' ? outputRequirement.contractRef : 'none';
    const validationForEvent: ValidationResult =
      validation ??
      (outputRequirement.kind === 'missing'
        ? {
            valid: false,
            issues: [`Missing required output for contractRef=${contractRefForEvent}`],
            suggestions: [],
            warnings: undefined,
          }
        : {
            valid: true,
            issues: [],
            suggestions: [],
            warnings: undefined,
          });
    
    const validationEventRes = buildValidationPerformedEvent({
      sessionId: String(sessionId),
      validationId,
      attemptId: String(retryAttemptId),
      contractRef: contractRefForEvent,
      scope: { runId: String(runId), nodeId: String(blockedNodeId) },
      minted: { eventId: validationEventId },
      result: validationForEvent,
    });
    if (validationEventRes.isErr()) {
      return errAsync({ kind: 'invariant_violation' as const, message: validationEventRes.error.message } as const);
    }
    
    const extraEventsToAppend = [validationEventRes.value, ...gapEventsToAppend, ...contextSetEvents];
    
    const event: WorkflowEvent = {
      kind: 'step_completed',
      stepInstanceId: {
        stepId: String(pendingStep.stepId),
        loopPath: pendingStep.loopPath.map((f) => ({ loopId: String(f.loopId), iteration: f.iteration })),
      },
    };
    const advanced = interpreter.applyEvent(currentState, event);
    if (advanced.isErr()) {
      return errAsync({ kind: 'advance_apply_failed', message: advanced.error.message } as const);
    }
    
    const nextRes = interpreter.next(compiledWf.value, advanced.value, ctxObj);
    if (nextRes.isErr()) {
      return errAsync({ kind: 'advance_next_failed', message: nextRes.error.message } as const);
    }
    
    const out = nextRes.value;
    const newEngineState = fromV1ExecutionState(out.state);
    const snapshotFile: ExecutionSnapshotFileV1 = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: { v: 1, engineState: newEngineState },
    };
    
    return snapshotStore.putExecutionSnapshotV1(snapshotFile).andThen((newSnapshotRef) => {
      const toNodeId = String(idFactory.mintNodeId());
      const nextEventIndex = truth.events.length === 0 ? 0 : truth.events[truth.events.length - 1]!.eventIndex + 1;
      
      const evtAdvanceRecorded = idFactory.mintEventId();
      const evtNodeCreated = idFactory.mintEventId();
      const evtEdgeCreated = idFactory.mintEventId();
      
      const hasChildren = truth.events.some(
        (e): e is Extract<DomainEventV1, { kind: 'edge_created' }> =>
          e.kind === 'edge_created' && e.data.fromNodeId === String(blockedNodeId)
      );
      const causeKind: 'non_tip_advance' | 'intentional_fork' = hasChildren ? 'non_tip_advance' : 'intentional_fork';
      
      const allowNotesAppend = validationCriteria
        ? Boolean(notesMarkdown && validation && validation.valid)
        : Boolean(notesMarkdown);
      
      const outputId = asOutputId(`out_recap_${String(retryAttemptId)}`);
      const outputsToAppend =
        allowNotesAppend && inputOutput?.notesMarkdown
          ? [
              {
                outputId: String(outputId),
                outputChannel: 'recap' as const,
                payload: {
                  payloadKind: 'notes' as const,
                  notesMarkdown: toNotesMarkdownV1(inputOutput.notesMarkdown),
                },
              },
            ]
          : [];
      
      const normalizedOutputs = normalizeOutputsForAppend(outputsToAppend);
      const outputEventIds = normalizedOutputs.map(() => idFactory.mintEventId());
      
      const planRes = buildAckAdvanceAppendPlanV1({
        sessionId: String(sessionId),
        runId: String(runId),
        fromNodeId: String(blockedNodeId),
        workflowHash,
        attemptId: String(retryAttemptId),
        nextEventIndex,
        extraEventsToAppend,
        toNodeId,
        toNodeKind: 'step',
        snapshotRef: newSnapshotRef,
        causeKind,
        minted: {
          advanceRecordedEventId: evtAdvanceRecorded,
          nodeCreatedEventId: evtNodeCreated,
          edgeCreatedEventId: evtEdgeCreated,
          outputEventIds,
        },
        outputsToAppend,
      });
      if (planRes.isErr()) return errAsync({ kind: 'invariant_violation' as const, message: planRes.error.message });
      
      return sessionStore.append(lock, planRes.value);
    });
  });
}

/**
 * Extract step metadata (title, prompt) from a workflow step with type-safe property access.
 * Returns sealed StepMetadata with guaranteed non-empty strings.
 *
 * @param workflow - The workflow instance
 * @param stepId - The step ID to extract metadata for (can be null for optional cases)
 * @param options - Optional { defaultTitle, defaultPrompt } for fallback values
 */
interface StepMetadata {
  readonly stepId: string;
  readonly title: string;
  readonly prompt: string;
  readonly requireConfirmation: boolean;
}

function extractStepMetadata(
  workflow: ReturnType<typeof createWorkflow>,
  stepId: string | null,
  options?: { defaultTitle?: string; defaultPrompt?: string }
): StepMetadata {
  const resolvedStepId = stepId ?? '';
  const step = stepId ? getStepById(workflow, stepId) : null;

  // Type guard for object with string property
  const hasStringProp = (obj: unknown, prop: string): boolean =>
    typeof obj === 'object' &&
    obj !== null &&
    prop in obj &&
    typeof (obj as unknown as Record<string, unknown>)[prop] === 'string';

  const title = hasStringProp(step, 'title')
    ? String((step as unknown as Record<string, unknown>).title)
    : options?.defaultTitle ?? resolvedStepId;

  const prompt = hasStringProp(step, 'prompt')
    ? String((step as unknown as Record<string, unknown>).prompt)
    : options?.defaultPrompt ?? (stepId ? `Pending step: ${stepId}` : '');

  const requireConfirmation =
    typeof step === 'object' && step !== null && 'requireConfirmation' in step
      ? Boolean((step as unknown as Record<string, unknown>).requireConfirmation)
      : false;

  return { stepId: resolvedStepId, title, prompt, requireConfirmation };
}

type NextIntentV2 = 'perform_pending_then_continue' | 'await_user_confirmation' | 'rehydrate_only' | 'complete';

type PreferencesV2 = { readonly autonomy: 'guided' | 'full_auto_stop_on_user_deps' | 'full_auto_never_stop'; readonly riskPolicy: 'conservative' | 'balanced' | 'aggressive' };

const defaultPreferences: PreferencesV2 = { autonomy: 'guided', riskPolicy: 'conservative' };

function derivePreferencesForNode(args: { readonly truth: LoadedSessionTruthV2; readonly runId: RunId; readonly nodeId: NodeId }): PreferencesV2 {
  const parentByNodeId: Record<string, string | null> = {};
  for (const e of args.truth.events) {
    if (e.kind !== 'node_created') continue;
    if (e.scope?.runId !== String(args.runId)) continue;
    parentByNodeId[String(e.scope.nodeId)] = e.data.parentNodeId;
  }

  const prefs = projectPreferencesV2(args.truth.events, parentByNodeId);
  if (prefs.isErr()) return defaultPreferences;

  const p = prefs.value.byNodeId[String(args.nodeId)]?.effective;
  if (!p) return defaultPreferences;

  return { autonomy: p.autonomy, riskPolicy: p.riskPolicy };
}

function deriveNextIntent(args: {
  readonly rehydrateOnly: boolean;
  readonly isComplete: boolean;
  readonly pending: StepMetadata | null;
}): NextIntentV2 {
  if (args.isComplete && !args.pending) return 'complete';
  if (args.rehydrateOnly) return 'rehydrate_only';
  if (!args.pending) return 'complete';
  return args.pending.requireConfirmation ? 'await_user_confirmation' : 'perform_pending_then_continue';
}

function internalError(message: string, suggestion?: string): ToolFailure {
  return errNotRetryable('INTERNAL_ERROR', normalizeTokenErrorMessage(message), suggestion ? { suggestion } : undefined) as ToolFailure;
}

function sessionStoreErrorToToolError(e: SessionEventLogStoreError): ToolFailure {
  switch (e.code) {
    case 'SESSION_STORE_LOCK_BUSY':
      // CRITICAL FIX: This is a storage error, NOT a token error
      return errRetryAfterMs('INTERNAL_ERROR', normalizeTokenErrorMessage(e.message), e.retry.afterMs, {
        suggestion: 'Another WorkRail process may be writing to this session; retry.',
      }) as ToolFailure;
    case 'SESSION_STORE_CORRUPTION_DETECTED':
      return errNotRetryable('SESSION_NOT_HEALTHY', `Session corruption detected: ${e.reason.code}`, {
        suggestion: 'Execution requires a healthy session. Export salvage view, then recreate.',
        details: detailsSessionHealth({ kind: e.location === 'head' ? 'corrupt_head' : 'corrupt_tail', reason: e.reason }) as unknown as JsonValue,
      }) as ToolFailure;
    case 'SESSION_STORE_IO_ERROR':
      return internalError(e.message, 'Retry; check filesystem permissions.');
    case 'SESSION_STORE_INVARIANT_VIOLATION':
      return internalError(e.message, 'Treat as invariant violation.');
    default:
      const _exhaustive: never = e;
      return internalError('Unknown session store error', 'Treat as invariant violation.');
  }
}

function gateErrorToToolError(e: ExecutionSessionGateErrorV2): ToolFailure {
  switch (e.code) {
    case 'SESSION_LOCKED':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED', e.message, e.retry.afterMs, { suggestion: 'Retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running.' }) as ToolFailure;
    case 'LOCK_RELEASE_FAILED':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED', e.message, e.retry.afterMs, { suggestion: 'Retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running.' }) as ToolFailure;
    case 'SESSION_NOT_HEALTHY':
      return errNotRetryable('SESSION_NOT_HEALTHY', e.message, { suggestion: 'Execution requires healthy session.', details: detailsSessionHealth(e.health) as unknown as JsonValue }) as ToolFailure;
    case 'SESSION_LOCK_REENTRANT':
      // Concurrent execution detected (in-process or cross-process).
      // This is retryable per design locks - agents can make parallel tool calls.
      return errRetryAfterMs('TOKEN_SESSION_LOCKED', e.message, 1000, {
        suggestion: 'Session is locked by concurrent execution. Retry in 1 second.',
      }) as ToolFailure;
    case 'SESSION_LOAD_FAILED':
    case 'LOCK_ACQUIRE_FAILED':
    case 'GATE_CALLBACK_FAILED':
      return internalError(e.message, 'Retry; if persists, treat as invariant violation.');
    default:
      const _exhaustive: never = e;
      return internalError('Unknown gate error', 'Treat as invariant violation.');
  }
}

function snapshotStoreErrorToToolError(e: SnapshotStoreError, suggestion?: string): ToolFailure {
  return internalError(`Snapshot store error: ${e.message}`, suggestion);
}

function pinnedWorkflowStoreErrorToToolError(e: PinnedWorkflowStoreError, suggestion?: string): ToolFailure {
  return internalError(`Pinned workflow store error: ${e.message}`, suggestion);
}

// Branded token input types (compile-time guarantee of token kind)
type StateTokenInput = ParsedTokenV1Binary & { readonly payload: import('../../v2/durable-core/tokens/payloads.js').StateTokenPayloadV1 };
type AckTokenInput = ParsedTokenV1Binary & { readonly payload: import('../../v2/durable-core/tokens/payloads.js').AckTokenPayloadV1 };

function parseStateTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
): { ok: true; token: StateTokenInput } | { ok: false; failure: ToolFailure } {
  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return { ok: false, failure: mapTokenDecodeErrorToToolError(parsedRes.error) };
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return { ok: false, failure: mapTokenVerifyErrorToToolError(verified.error) };
  }

  if (parsedRes.value.payload.tokenKind !== 'state') {
    return {
      ok: false,
      failure: errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a state token (st1...).', {
        suggestion: 'Use the stateToken returned by WorkRail.',
      }) as ToolFailure,
    };
  }

  return { ok: true, token: parsedRes.value as StateTokenInput };
}

function parseAckTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
): { ok: true; token: AckTokenInput } | { ok: false; failure: ToolFailure } {
  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return { ok: false, failure: mapTokenDecodeErrorToToolError(parsedRes.error) };
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return { ok: false, failure: mapTokenVerifyErrorToToolError(verified.error) };
  }

  if (parsedRes.value.payload.tokenKind !== 'ack') {
    return {
      ok: false,
      failure: errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected an ack token (ack1...).', {
        suggestion: 'Use the ackToken returned by WorkRail.',
      }) as ToolFailure,
    };
  }

  return { ok: true, token: parsedRes.value as AckTokenInput };
}

function newAttemptId(idFactory: { readonly mintAttemptId: () => AttemptId }): AttemptId {
  return idFactory.mintAttemptId();
}

function attemptIdForNextNode(parentAttemptId: AttemptId, sha256: Sha256PortV2): AttemptId {
  // Deterministic and bounded derivation so replay can re-mint the same next-node tokens.
  return deriveChildAttemptId(parentAttemptId, sha256);
}

function signTokenOrErr(args: {
  payload: TokenPayloadV1;
  ports: TokenCodecPorts;
}): Result<string, TokenDecodeErrorV2 | TokenVerifyErrorV2 | TokenSignErrorV2> {
  const token = signTokenV1Binary(args.payload, args.ports);
  if (token.isErr()) return err(token.error);
  return ok(token.value);
}

function toV1ExecutionState(engineState: EngineStateV1): ExecutionState {
  if (engineState.kind === 'init') return { kind: 'init' as const };
  if (engineState.kind === 'complete') return { kind: 'complete' as const };

  const pendingStep =
    engineState.pending.kind === 'some'
      ? {
          stepId: String(engineState.pending.step.stepId),
          loopPath: engineState.pending.step.loopPath.map((f: LoopPathFrameV1) => ({
            loopId: String(f.loopId),
            iteration: f.iteration,
          })),
        }
      : undefined;

  return {
    kind: 'running' as const,
    completed: [...engineState.completed.values].map(String),
    loopStack: engineState.loopStack.map((f) => ({
      loopId: String(f.loopId),
      iteration: f.iteration,
      bodyIndex: f.bodyIndex,
    })),
    pendingStep,
  };
}

function convertRunningExecutionStateToEngineState(
  state: Extract<ExecutionState, { kind: 'running' }>
): Extract<EngineStateV1, { kind: 'running' }> {
  const completedArray: readonly string[] = [...state.completed].sort((a: string, b: string) =>
    a.localeCompare(b)
  );
  const completed = completedArray.map(s => stepInstanceKeyFromParts(asDelimiterSafeIdV1(s), []));

  const loopStack = state.loopStack.map((f: LoopFrame) => ({
    loopId: asDelimiterSafeIdV1(f.loopId),
    iteration: f.iteration,
    bodyIndex: f.bodyIndex,
  }));

  const pending = state.pendingStep
    ? {
        kind: 'some' as const,
        step: {
          stepId: asDelimiterSafeIdV1(state.pendingStep.stepId),
          loopPath: state.pendingStep.loopPath.map((p) => ({
            loopId: asDelimiterSafeIdV1(p.loopId),
            iteration: p.iteration,
          })),
        },
      }
    : { kind: 'none' as const };

  return {
    kind: 'running' as const,
    completed: { kind: 'set' as const, values: completed },
    loopStack,
    pending,
  };
}

function fromV1ExecutionState(state: ExecutionState): EngineStateV1 {
  if (state.kind === 'init') {
    return { kind: 'init' as const };
  }
  if (state.kind === 'complete') {
    return { kind: 'complete' as const };
  }
  return convertRunningExecutionStateToEngineState(state);
}

// Sealed mapper for workflowSourceKind (no substring matching)
type WorkflowSourceKind = 'bundled' | 'user' | 'project' | 'remote' | 'plugin';
const workflowSourceKindMap: Record<string, WorkflowSourceKind> = {
  bundled: 'bundled',
  user: 'user',
  project: 'project',
  remote: 'remote',
  plugin: 'plugin',
  git: 'remote',
  custom: 'project',
};

function mapWorkflowSourceKind(kind: string): WorkflowSourceKind {
  const mapped = workflowSourceKindMap[kind];
  return mapped ?? 'project';
}

export async function handleV2StartWorkflow(
  input: V2StartWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  return executeStartWorkflow(input, ctx).match(
    (payload) => success(payload),
    (e) => mapStartWorkflowErrorToToolError(e)
  );
}

function executeStartWorkflow(
  input: V2StartWorkflowInput,
  ctx: ToolContext
): RA<z.infer<typeof V2StartWorkflowOutputSchema>, StartWorkflowError> {
  if (!ctx.v2) {
    return neErrorAsync({ kind: 'precondition_failed', message: 'v2 tools disabled', suggestion: 'Enable v2Tools flag' });
  }

  const { gate, sessionStore, snapshotStore, pinnedStore, crypto, tokenCodecPorts, idFactory } = ctx.v2;
  if (!idFactory) {
    return neErrorAsync({
      kind: 'precondition_failed',
      message: 'v2 context missing idFactory',
      suggestion: 'Reinitialize v2 tool context (idFactory must be provided when v2Tools are enabled).',
    });
  }
  if (!tokenCodecPorts) {
    return neErrorAsync({
      kind: 'precondition_failed',
      message: 'v2 context missing tokenCodecPorts dependency',
      suggestion: 'Reinitialize v2 tool context (tokenCodecPorts must be provided when v2Tools are enabled).',
    });
  }

  const ctxCheck = checkContextBudget({ tool: 'start_workflow', context: input.context });
  if (!ctxCheck.ok) return neErrorAsync({ kind: 'validation_failed', failure: ctxCheck.error });

  return RA.fromPromise(ctx.workflowService.getWorkflowById(input.workflowId), (e) => ({
    kind: 'precondition_failed' as const,
    message: e instanceof Error ? e.message : String(e),
  }))
    .andThen((workflow) => {
      if (!workflow) {
        return neErrorAsync({ kind: 'workflow_not_found' as const, workflowId: asWorkflowId(input.workflowId) });
      }
      const firstStep = workflow.definition.steps[0];
      if (!firstStep) {
        return neErrorAsync({ kind: 'workflow_has_no_steps' as const, workflowId: asWorkflowId(input.workflowId) });
      }
      return okAsync({ workflow, firstStep });
    })
    .andThen(({ workflow, firstStep }) => {
      // Pin the full v1 workflow definition for determinism.
      const compiled = compileV1WorkflowToPinnedSnapshot(workflow);
      const workflowHashRes = workflowHashForCompiledSnapshot(compiled as unknown as JsonValue, crypto);
      if (workflowHashRes.isErr()) {
        return neErrorAsync({ kind: 'hash_computation_failed' as const, message: workflowHashRes.error.message });
      }
      const workflowHash = workflowHashRes.value;

      return pinnedStore.get(workflowHash)
        .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }))
        .andThen((existingPinned) => {
          if (!existingPinned) {
            return pinnedStore.put(workflowHash, compiled)
              .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }));
          }
          return okAsync(undefined);
        })
        .andThen(() => pinnedStore.get(workflowHash).mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause })))
        .andThen((pinned) => {
          if (!pinned || pinned.sourceKind !== 'v1_pinned' || !hasWorkflowDefinitionShape(pinned.definition)) {
            return neErrorAsync({
              kind: 'invariant_violation' as const,
              message: 'Failed to pin executable workflow snapshot (missing or invalid pinned workflow).',
              suggestion: 'Retry start_workflow; if this persists, treat as invariant violation.',
            });
          }
          const pinnedWorkflow = createWorkflow(pinned.definition as WorkflowDefinition, createBundledSource());
          return okAsync({ workflow, firstStep, workflowHash, pinnedWorkflow });
        });
    })
    .andThen(({ workflow, firstStep, workflowHash, pinnedWorkflow }) => {
      const sessionId = idFactory.mintSessionId();
      const runId = idFactory.mintRunId();
      const nodeId = idFactory.mintNodeId();

      const snapshot: ExecutionSnapshotFileV1 = {
        v: 1 as const,
        kind: 'execution_snapshot' as const,
        enginePayload: {
          v: 1 as const,
          engineState: {
            kind: 'running' as const,
            completed: { kind: 'set' as const, values: [] },
            loopStack: [],
            pending: { kind: 'some' as const, step: { stepId: asDelimiterSafeIdV1(firstStep.id), loopPath: [] } },
          },
        },
      };

      return snapshotStore.putExecutionSnapshotV1(snapshot)
        .mapErr((cause) => ({ kind: 'snapshot_creation_failed' as const, cause }))
        .andThen((snapshotRef) => {
          const evtSessionCreated = idFactory.mintEventId();
          const evtRunStarted = idFactory.mintEventId();
          const evtNodeCreated = idFactory.mintEventId();

          return gate.withHealthySessionLock(sessionId, (lock) => {
            const evtPreferencesChanged = idFactory.mintEventId();
            const changeId = idFactory.mintEventId();
            const evtContextSet = idFactory.mintEventId();
            const contextId = idFactory.mintEventId();

            const baseEvents: DomainEventV1[] = [
              {
                v: 1,
                eventId: evtSessionCreated,
                eventIndex: 0,
                sessionId,
                kind: 'session_created' as const,
                dedupeKey: `session_created:${sessionId}`,
                data: {},
              },
              {
                v: 1,
                eventId: evtRunStarted,
                eventIndex: 1,
                sessionId,
                kind: 'run_started' as const,
                dedupeKey: `run_started:${sessionId}:${runId}`,
                scope: { runId },
                data: {
                  workflowId: workflow.definition.id,
                  workflowHash,
                  workflowSourceKind: mapWorkflowSourceKind(workflow.source.kind),
                  workflowSourceRef:
                    workflow.source.kind === 'user' || workflow.source.kind === 'project' || workflow.source.kind === 'custom'
                      ? workflow.source.directoryPath
                      : workflow.source.kind === 'git'
                        ? `${workflow.source.repositoryUrl}#${workflow.source.branch}`
                        : workflow.source.kind === 'remote'
                          ? workflow.source.registryUrl
                          : workflow.source.kind === 'plugin'
                            ? `${workflow.source.pluginName}@${workflow.source.pluginVersion}`
                            : '(bundled)',
                },
              },
              {
                v: 1,
                eventId: evtNodeCreated,
                eventIndex: 2,
                sessionId,
                kind: 'node_created' as const,
                dedupeKey: `node_created:${sessionId}:${runId}:${nodeId}`,
                scope: { runId, nodeId },
                data: {
                  nodeKind: 'step' as const,
                  parentNodeId: null,
                  workflowHash,
                  snapshotRef,
                },
              },
              {
                v: 1,
                eventId: evtPreferencesChanged,
                eventIndex: 3,
                sessionId,
                kind: 'preferences_changed' as const,
                dedupeKey: `preferences_changed:${sessionId}:${runId}:${nodeId}:${changeId}`,
                scope: { runId, nodeId },
                data: {
                  changeId,
                  source: 'system' as const,
                  delta: [
                    { key: 'autonomy' as const, value: defaultPreferences.autonomy },
                    { key: 'riskPolicy' as const, value: defaultPreferences.riskPolicy },
                  ],
                  effective: {
                    autonomy: defaultPreferences.autonomy,
                    riskPolicy: defaultPreferences.riskPolicy,
                  },
                },
              },
            ];

            // Emit context_set if initial context provided (S8: context persistence)
            const eventsArray: readonly DomainEventV1[] = input.context
              ? [
                  ...baseEvents,
                  {
                    v: 1,
                    eventId: evtContextSet,
                    eventIndex: 4,
                    sessionId,
                    kind: 'context_set' as const,
                    dedupeKey: `context_set:${sessionId}:${runId}:${contextId}`,
                    scope: { runId },
                    data: {
                      contextId,
                      context: input.context as unknown as JsonValue,
                      source: 'initial' as const,
                    },
                  } as DomainEventV1,
                ]
              : baseEvents;

            return sessionStore.append(lock, {
              events: eventsArray,
              snapshotPins: [{ snapshotRef, eventIndex: 2, createdByEventId: evtNodeCreated }],
            });
          })
            .mapErr((cause) => ({ kind: 'session_append_failed' as const, cause }))
            .map(() => ({ workflow, firstStep, workflowHash, pinnedWorkflow, sessionId, runId, nodeId }));
        });
    })
    .andThen(({ pinnedWorkflow, firstStep, workflowHash, sessionId, runId, nodeId }) => {
      const wfRefRes = deriveWorkflowHashRef(workflowHash);
      if (wfRefRes.isErr()) {
        return neErrorAsync({
          kind: 'precondition_failed' as const,
          message: wfRefRes.error.message,
          suggestion: 'Ensure the pinned workflowHash is a valid sha256 digest.',
        });
      }
      const statePayload = {
        tokenVersion: 1 as const,
        tokenKind: 'state' as const,
        sessionId,
        runId,
        nodeId,
        workflowHashRef: wfRefRes.value,
      };
      const attemptId = newAttemptId(idFactory);
      const ackPayload = {
        tokenVersion: 1 as const,
        tokenKind: 'ack' as const,
        sessionId,
        runId,
        nodeId,
        attemptId,
      };
      const stateToken = signTokenOrErr({ payload: statePayload, ports: tokenCodecPorts });
      if (stateToken.isErr()) return neErrorAsync({ kind: 'token_signing_failed' as const, cause: stateToken.error });
      
      const ackToken = signTokenOrErr({ payload: ackPayload, ports: tokenCodecPorts });
      if (ackToken.isErr()) return neErrorAsync({ kind: 'token_signing_failed' as const, cause: ackToken.error });

      // S9: Use renderPendingPrompt for consistency (no recovery for start)
      const metaRes = renderPendingPrompt({
        workflow: pinnedWorkflow,
        stepId: firstStep.id,
        loopPath: [],
        truth: { events: [], manifest: [] }, // start has no prior events
                    runId: asRunId(String(runId)),
            nodeId: asNodeId(String(nodeId)),
            rehydrateOnly: false,
      });
      
      const meta = metaRes.isOk() ? metaRes.value : {
        stepId: firstStep.id,
        title: firstStep.title,
        prompt: firstStep.prompt,
        requireConfirmation: Boolean(firstStep.requireConfirmation),
      };
      
      const pending = { stepId: meta.stepId, title: meta.title, prompt: meta.prompt };

      const preferences = defaultPreferences;
      const nextIntent = deriveNextIntent({ rehydrateOnly: false, isComplete: false, pending: meta });

      return okAsync(V2StartWorkflowOutputSchema.parse({
        stateToken: stateToken.value,
        ackToken: ackToken.value,
        isComplete: false,
        pending,
        preferences,
        nextIntent,
      }));
    });
}

export async function handleV2ContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  return executeContinueWorkflow(input, ctx).match(
    (payload) => success(payload),
    (e) => mapContinueWorkflowErrorToToolError(e)
  );
}

function executeContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: ToolContext
): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  if (!ctx.v2) {
    return neErrorAsync({ kind: 'precondition_failed', message: 'v2 tools disabled', suggestion: 'Enable v2Tools flag' });
  }

  const { gate, sessionStore, snapshotStore, pinnedStore, sha256, tokenCodecPorts, idFactory } = ctx.v2;
  if (!sha256 || !idFactory) {
    return neErrorAsync({
      kind: 'precondition_failed',
      message: 'v2 context missing required dependencies',
      suggestion: 'Reinitialize v2 tool context (sha256 and idFactory must be provided when v2Tools are enabled).',
    });
  }
  if (!tokenCodecPorts) {
    return neErrorAsync({
      kind: 'precondition_failed',
      message: 'v2 context missing tokenCodecPorts dependency',
      suggestion: 'Reinitialize v2 tool context (tokenCodecPorts must be provided when v2Tools are enabled).',
    });
  }

  const stateRes = parseStateTokenOrFail(input.stateToken, tokenCodecPorts);
  if (!stateRes.ok) return neErrorAsync({ kind: 'validation_failed', failure: stateRes.failure });
  const state = stateRes.token;

  const ctxCheck = checkContextBudget({ tool: 'continue_workflow', context: input.context });
  if (!ctxCheck.ok) return neErrorAsync({ kind: 'validation_failed', failure: ctxCheck.error });

  const sessionId = asSessionId(state.payload.sessionId);
  const runId = asRunId(state.payload.runId);
  const nodeId = asNodeId(state.payload.nodeId);
  const workflowHashRef = state.payload.workflowHashRef;

  if (!input.ackToken) {
    // REHYDRATE PATH
    return sessionStore.load(sessionId)
      .mapErr((cause) => ({ kind: 'session_load_failed' as const, cause }))
      .andThen((truth) => {
        const runStarted = truth.events.find(
          (e): e is Extract<DomainEventV1, { kind: 'run_started' }> => e.kind === 'run_started' && e.scope.runId === String(runId)
        );
        const workflowId = runStarted?.data.workflowId;
        if (!runStarted || typeof workflowId !== 'string' || workflowId.trim() === '') {
          return neErrorAsync({
            kind: 'token_unknown_node' as const,
            message: 'No durable run state was found for this stateToken (missing run_started).',
            suggestion: 'Use start_workflow to mint a new run, or use a stateToken returned by WorkRail for an existing run.',
          });
        }
        const workflowHash = runStarted.data.workflowHash;
        const expectedRefRes = deriveWorkflowHashRef(workflowHash);
        if (expectedRefRes.isErr()) {
          return neErrorAsync({
            kind: 'precondition_failed' as const,
            message: expectedRefRes.error.message,
            suggestion: 'Re-pin the workflow via start_workflow.',
          });
        }
        if (String(expectedRefRes.value) !== String(workflowHashRef)) {
          return neErrorAsync({ kind: 'precondition_failed' as const, message: 'workflowHash mismatch for this run.', suggestion: 'Use the stateToken returned by WorkRail for this run.' });
        }

        const nodeCreated = truth.events.find(
          (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
            e.kind === 'node_created' && e.scope.nodeId === String(nodeId) && e.scope.runId === String(runId)
        );
        if (!nodeCreated) {
          return neErrorAsync({
            kind: 'token_unknown_node' as const,
            message: 'No durable node state was found for this stateToken (missing node_created).',
            suggestion: 'Use a stateToken returned by WorkRail for an existing node.',
          });
        }
        const expectedNodeRefRes = deriveWorkflowHashRef(nodeCreated.data.workflowHash);
        if (expectedNodeRefRes.isErr()) {
          return neErrorAsync({
            kind: 'precondition_failed' as const,
            message: expectedNodeRefRes.error.message,
            suggestion: 'Re-pin the workflow via start_workflow.',
          });
        }
        if (String(expectedNodeRefRes.value) !== String(workflowHashRef)) {
          return neErrorAsync({ kind: 'precondition_failed' as const, message: 'workflowHash mismatch for this node.', suggestion: 'Use the stateToken returned by WorkRail for this node.' });
        }

        return snapshotStore.getExecutionSnapshotV1(nodeCreated.data.snapshotRef)
          .mapErr((cause) => ({ kind: 'snapshot_load_failed' as const, cause }))
          .andThen((snapshot) => {
            if (!snapshot) {
              return neErrorAsync({
                kind: 'token_unknown_node' as const,
                message: 'No execution snapshot was found for this node.',
                suggestion: 'Use a stateToken returned by WorkRail for an existing node.',
              });
            }

            const engineState = snapshot.enginePayload.engineState;
            const pending = derivePendingStep(engineState);
            const isComplete = deriveIsComplete(engineState);

            if (!pending) {
              const preferences = derivePreferencesForNode({ truth, runId, nodeId });
              const nextIntent = deriveNextIntent({ rehydrateOnly: true, isComplete, pending: null });

              return okAsync(V2ContinueWorkflowOutputSchema.parse({
                kind: 'ok',
                stateToken: input.stateToken,
                isComplete,
                pending: null,
                preferences,
                nextIntent,
              }));
            }

            const attemptId = newAttemptId(idFactory);
            const ackTokenRes = signTokenOrErr({
              payload: { tokenVersion: 1, tokenKind: 'ack', sessionId, runId, nodeId, attemptId },
              ports: tokenCodecPorts,
            });
            if (ackTokenRes.isErr()) return neErrorAsync({ kind: 'token_signing_failed' as const, cause: ackTokenRes.error });

            return pinnedStore.get(workflowHash)
              .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }))
              .andThen((pinned) => {
                if (!pinned) return neErrorAsync({ kind: 'pinned_workflow_missing' as const, workflowHash });
                if (pinned.sourceKind !== 'v1_pinned') return neErrorAsync({ kind: 'precondition_failed' as const, message: 'Pinned workflow snapshot is read-only (v1_preview) and cannot be executed.' });
                if (!hasWorkflowDefinitionShape(pinned.definition)) {
                  return neErrorAsync({
                    kind: 'precondition_failed' as const,
                    message: 'Pinned workflow snapshot has an invalid workflow definition shape.',
                    suggestion: 'Re-pin the workflow via start_workflow.',
                  });
                }
                
                const wf = createWorkflow(pinned.definition as WorkflowDefinition, createBundledSource());
                
                // S9: Use renderPendingPrompt (includes recap recovery + function expansion)
                const metaRes = renderPendingPrompt({
                  workflow: wf,
                  stepId: String(pending.stepId),
                  loopPath: pending.loopPath,
                  truth,
                  runId: asRunId(String(runId)),
                  nodeId: asNodeId(String(nodeId)),
                  rehydrateOnly: true,
                });
                
                if (metaRes.isErr()) {
                  return neErrorAsync({
                    kind: 'invariant_violation' as const,
                    message: `Prompt rendering failed: ${metaRes.error.message}`,
                    suggestion: 'Retry; if this persists, treat as invariant violation.',
                  });
                }
                
                const meta = metaRes.value;

                const preferences = derivePreferencesForNode({ truth, runId, nodeId });
                const nextIntent = deriveNextIntent({ rehydrateOnly: true, isComplete, pending: meta });

                return okAsync(V2ContinueWorkflowOutputSchema.parse({
                  kind: 'ok',
                  stateToken: input.stateToken,
                  ackToken: ackTokenRes.value,
                  isComplete,
                  pending: { stepId: meta.stepId, title: meta.title, prompt: meta.prompt },
                  preferences,
                  nextIntent,
                }));
              });
          });
      });
  }

  // ADVANCE PATH
  const ackRes = parseAckTokenOrFail(input.ackToken, tokenCodecPorts);
  if (!ackRes.ok) return neErrorAsync({ kind: 'validation_failed', failure: ackRes.failure });
  const ack = ackRes.token;

  const scopeRes = assertTokenScopeMatchesStateBinary(state, ack);
  if (scopeRes.isErr()) return neErrorAsync({ kind: 'validation_failed', failure: mapTokenDecodeErrorToToolError(scopeRes.error) });

  const attemptId = asAttemptId(ack.payload.attemptId);
  const dedupeKey = `advance_recorded:${sessionId}:${nodeId}:${attemptId}`;

  return sessionStore.load(sessionId)
    .mapErr((cause) => ({ kind: 'session_load_failed' as const, cause }))
    .andThen((truth) => {
      const runStarted = truth.events.find(
        (e): e is Extract<DomainEventV1, { kind: 'run_started' }> => e.kind === 'run_started' && e.scope.runId === String(runId)
      );
      if (!runStarted) {
        return neErrorAsync({
          kind: 'token_unknown_node' as const,
          message: 'No durable run state was found for this token (missing run_started).',
          suggestion: 'Use start_workflow to mint a new run, or use tokens returned by WorkRail for an existing run.',
        });
      }
      const workflowHash = runStarted.data.workflowHash;
      const refRes = deriveWorkflowHashRef(workflowHash);
      if (refRes.isErr()) {
        return neErrorAsync({
          kind: 'precondition_failed' as const,
          message: refRes.error.message,
          suggestion: 'Re-pin the workflow via start_workflow.',
        });
      }
      if (String(refRes.value) !== String(workflowHashRef)) {
        return neErrorAsync({
          kind: 'precondition_failed' as const,
          message: 'workflowHash mismatch for this run.',
          suggestion: 'Use the stateToken returned by WorkRail for this run.',
        });
      }

      const nodeCreated = truth.events.find(
        (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
          e.kind === 'node_created' && e.scope.nodeId === String(nodeId) && e.scope.runId === String(runId)
      );
      if (!nodeCreated) {
        return neErrorAsync({
          kind: 'token_unknown_node' as const,
          message: 'No durable node state was found for this token (missing node_created).',
          suggestion: 'Use tokens returned by WorkRail for an existing node.',
        });
      }
      const nodeRefRes = deriveWorkflowHashRef(nodeCreated.data.workflowHash);
      if (nodeRefRes.isErr()) {
        return neErrorAsync({
          kind: 'precondition_failed' as const,
          message: nodeRefRes.error.message,
          suggestion: 'Re-pin the workflow via start_workflow.',
        });
      }
      if (String(nodeRefRes.value) !== String(workflowHashRef)) {
        return neErrorAsync({
          kind: 'precondition_failed' as const,
          message: 'workflowHash mismatch for this node.',
          suggestion: 'Use the stateToken returned by WorkRail for this node.',
        });
      }

      const existing = truth.events.find(
        (e): e is Extract<DomainEventV1, { kind: 'advance_recorded' }> => e.kind === 'advance_recorded' && e.dedupeKey === dedupeKey
      );

      return pinnedStore.get(workflowHash)
        .mapErr((cause) => ({ kind: 'pinned_workflow_store_failed' as const, cause }))
        .andThen((compiled) => {
          if (!compiled) return neErrorAsync({ kind: 'pinned_workflow_missing' as const, workflowHash });
          if (compiled.sourceKind !== 'v1_pinned') return neErrorAsync({ kind: 'precondition_failed' as const, message: 'Pinned workflow snapshot is read-only (v1_preview) and cannot be executed.' });
          if (!hasWorkflowDefinitionShape(compiled.definition)) {
            return neErrorAsync({
              kind: 'precondition_failed' as const,
              message: 'Pinned workflow snapshot has an invalid workflow definition shape.',
              suggestion: 'Re-pin the workflow via start_workflow.',
            });
          }

          const pinnedWorkflow = createWorkflow(compiled.definition as WorkflowDefinition, createBundledSource());

          if (existing) {
            return replayFromRecordedAdvance({
              recordedEvent: existing,
              truth,
              sessionId,
              runId,
              nodeId,
              workflowHash,
              attemptId,
              inputStateToken: input.stateToken,
              inputAckToken: input.ackToken!,
              pinnedWorkflow,
              snapshotStore,
              sha256,
              tokenCodecPorts,
            });
          }

          // Acquire the lock only for the first-advance path. Re-check for existing facts under the lock to avoid
          // a race where another writer records advance_recorded after our initial read but before we acquire the lock.
          return gate
            .withHealthySessionLock(sessionId, (lock) =>
              sessionStore.load(sessionId).andThen((truthLocked) => {
                const existingLocked = truthLocked.events.find(
                  (e): e is Extract<DomainEventV1, { kind: 'advance_recorded' }> =>
                    e.kind === 'advance_recorded' && e.dedupeKey === dedupeKey
                );
                if (existingLocked) return okAsync({ kind: 'replay' as const, truth: truthLocked, recordedEvent: existingLocked });

                return advanceAndRecord({
                  truth: truthLocked,
                  sessionId,
                  runId,
                  nodeId,
                  attemptId,
                  workflowHash,
                  dedupeKey,
                  inputContext: input.context as JsonValue | undefined,
                  inputOutput: input.output,
                  lock,
                  pinnedWorkflow,
                  snapshotStore,
                  sessionStore,
                  sha256,
                  idFactory,
                }).andThen(() =>
                  sessionStore
                    .load(sessionId)
                    .map((truthAfter) => ({ kind: 'replay' as const, truth: truthAfter, recordedEvent: null }))
                );
              })
            )
            .mapErr((cause) => {
              if (isInternalError(cause)) {
                return {
                  kind: 'invariant_violation' as const,
                  message: `Advance failed due to internal invariant violation: ${cause.kind}`,
                  suggestion: 'Retry; if this persists, treat as invariant violation.',
                };
              }
              if (typeof cause === 'object' && cause !== null && 'code' in cause) {
                const code = (cause as { code: string }).code;
                if (code.startsWith('SNAPSHOT_STORE_')) {
                  return { kind: 'snapshot_load_failed' as const, cause: cause as SnapshotStoreError };
                }
                return { kind: 'advance_execution_failed' as const, cause: cause as ExecutionSessionGateErrorV2 | SessionEventLogStoreError };
              }
              return {
                kind: 'invariant_violation' as const,
                message: 'Advance failed with an unknown error shape (invariant violation).',
                suggestion: 'Retry; if this persists, treat as invariant violation.',
              };
            })
            .andThen((res) => {
              const truth2 = res.truth;
              const recordedEvent =
                res.recordedEvent ??
                truth2.events.find(
                  (e): e is Extract<DomainEventV1, { kind: 'advance_recorded' }> =>
                    e.kind === 'advance_recorded' && e.dedupeKey === dedupeKey
                );

              if (!recordedEvent) {
                return neErrorAsync({
                  kind: 'invariant_violation' as const,
                  message: 'Missing recorded advance outcome after successful append (invariant violation).',
                  suggestion: 'Retry; if this persists, treat as invariant violation.',
                });
              }

              return replayFromRecordedAdvance({
                recordedEvent,
                truth: truth2,
                sessionId,
                runId,
                nodeId,
                workflowHash,
                attemptId,
                inputStateToken: input.stateToken,
                inputAckToken: input.ackToken!,
                pinnedWorkflow,
                snapshotStore,
                sha256,
                tokenCodecPorts,
              });
            });
        });
    });
}

