/**
 * Blocked outcome builder.
 * Handles the path when an advance is blocked by validation or requirements.
 */

import { ResultAsync as RA, errAsync as neErrorAsync } from 'neverthrow';
import type { ExecutionSnapshotFileV1 } from '../../../v2/durable-core/schemas/execution-snapshot/index.js';
import type { SessionId, RunId, NodeId, WorkflowHash } from '../../../v2/durable-core/ids/index.js';
import type { AttemptId } from '../../../v2/durable-core/tokens/index.js';
import type { LoadedSessionTruthV2 } from '../../../v2/ports/session-event-log-store.port.js';
import type { SessionEventLogStoreError } from '../../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../../v2/ports/snapshot-store.port.js';
import type { WithHealthySessionLock } from '../../../v2/durable-core/ids/with-healthy-session-lock.js';
import type { ValidationResult } from '../../../types/validation.js';

import { buildBlockerReport } from '../../../v2/durable-core/domain/reason-model.js';
import { buildValidationPerformedEvent } from '../../../v2/durable-core/domain/validation-event-builder.js';
import { buildBlockedNodeSnapshot } from '../../../v2/durable-core/domain/blocked-node-builder.js';
import type { InternalError } from '../v2-error-mapping.js';
import type { AdvanceMode } from './index.js';
import { buildAndAppendPlan } from './event-builders.js';
import type { AdvanceContext, ComputedAdvanceResults, AdvanceCorePorts } from './index.js';

export function buildBlockedOutcome(args: {
  readonly mode: AdvanceMode;
  readonly snap: ExecutionSnapshotFileV1;
  readonly ctx: AdvanceContext;
  readonly computed: ComputedAdvanceResults;
  readonly lock: WithHealthySessionLock;
  readonly ports: AdvanceCorePorts;
}): RA<void, InternalError | SessionEventLogStoreError | SnapshotStoreError> {
  const { mode, snap, lock, ports } = args;
  const { truth, sessionId, runId, currentNodeId, attemptId, workflowHash } = args.ctx;
  const { reasons, outputRequirement, validation } = args.computed;
  const { snapshotStore, sessionStore, sha256, idFactory } = ports;

  // Single source of truth: reasons = post-guardrail blocking reasons.
  // Use the same array for both blockers and primaryReason (architectural fix).
  const blockersRes = buildBlockerReport(reasons);
  if (blockersRes.isErr()) {
    return errAsync({ kind: 'invariant_violation' as const, message: blockersRes.error.message } as const);
  }

  // Build validation event
  const validationEventId = idFactory.mintEventId();
  const validationId = `validation_${String(attemptId)}`;
  const contractRefForEvent = (outputRequirement.kind !== 'not_required' && outputRequirement.kind !== 'satisfied') ? outputRequirement.contractRef : 'none';
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
    // Invariant: shouldBlockNow=true requires reasons.length > 0 (checked at call site).
    // If this fires, the shouldBlock logic is broken.
    return errAsync({ kind: 'invariant_violation' as const, message: 'shouldBlockNow=true requires at least one effective reason (post-guardrails)' } as const);
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
      kind: 'blocked',
      truth, sessionId, runId, currentNodeId, attemptId, workflowHash,
      extraEventsToAppend, blockers: blockersRes.value, snapshotRef: blockedSnapshotRef,
      sessionStore, idFactory, lock,
    });
  });
}

function errAsync(e: InternalError): RA<never, InternalError> {
  return neErrorAsync(e);
}
