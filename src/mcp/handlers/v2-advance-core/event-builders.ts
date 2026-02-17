/**
 * Event and output builders for advance operations.
 * Handles building event plans and output payloads.
 */

import { ResultAsync as RA, errAsync as neErrorAsync, ok, err, type Result } from 'neverthrow';
import type { DomainEventV1 } from '../../../v2/durable-core/schemas/session/index.js';
import type { SessionId, RunId, NodeId, WorkflowHash } from '../../../v2/durable-core/ids/index.js';
import type { AttemptId, OutputId } from '../../../v2/durable-core/tokens/index.js';
import { asOutputId } from '../../../v2/durable-core/tokens/index.js';
import type { LoadedSessionTruthV2 } from '../../../v2/ports/session-event-log-store.port.js';
import type { SessionEventLogStoreError } from '../../../v2/ports/session-event-log-store.port.js';
import type { WithHealthySessionLock } from '../../../v2/durable-core/ids/with-healthy-session-lock.js';
import type { Sha256PortV2 } from '../../../v2/ports/sha256.port.js';
import type { JsonValue } from '../../../v2/durable-core/canonical/json-types.js';
import type { V2ContinueWorkflowInput } from '../../v2/tools.js';

import { toCanonicalBytes } from '../../../v2/durable-core/canonical/jcs.js';
import { toNotesMarkdownV1 } from '../../../v2/durable-core/domain/notes-markdown.js';
import { normalizeOutputsForAppend, type OutputToAppend } from '../../../v2/durable-core/domain/outputs.js';
import { buildAckAdvanceAppendPlanV1 } from '../../../v2/durable-core/domain/ack-advance-append-plan.js';
import type { InternalError } from '../v2-error-mapping.js';
import { EVENT_KIND, OUTPUT_CHANNEL, EDGE_CAUSE } from '../../../v2/durable-core/constants.js';
import type { AdvanceCorePorts } from './index.js';

// ── buildAndAppendPlan ────────────────────────────────────────────────

type BuildAppendPlanArgs = {
  readonly truth: LoadedSessionTruthV2;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly currentNodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly workflowHash: WorkflowHash;
  readonly extraEventsToAppend: readonly Omit<DomainEventV1, 'eventIndex' | 'sessionId'>[];
  readonly sessionStore: import('../../../v2/ports/session-event-log-store.port.js').SessionEventLogAppendStorePortV2;
  readonly idFactory: AdvanceCorePorts['idFactory'];
  readonly lock: WithHealthySessionLock;
} & (
  | {
      readonly kind: 'blocked';
      readonly blockers: import('../../../v2/durable-core/domain/reason-model.js').BlockerReportV1;
      readonly snapshotRef: import('../../../v2/durable-core/ids/index.js').SnapshotRef;
    }
  | {
      readonly kind: 'advanced';
      readonly toNodeKind: 'step' | 'blocked_attempt' | undefined;
      readonly snapshotRef: import('../../../v2/durable-core/ids/index.js').SnapshotRef;
      readonly outputsToAppend: readonly OutputToAppend[];
    }
);

export function buildAndAppendPlan(args: BuildAppendPlanArgs): RA<void, InternalError | SessionEventLogStoreError> {
  const { truth, sessionId, runId, currentNodeId, attemptId, workflowHash, extraEventsToAppend, sessionStore, idFactory, lock } = args;

  const nextEventIndex = truth.events.length === 0 ? 0 : truth.events[truth.events.length - 1]!.eventIndex + 1;
  const evtAdvanceRecorded = idFactory.mintEventId();

  if (args.kind === 'blocked') {
    const planRes = buildAckAdvanceAppendPlanV1({
      sessionId: String(sessionId),
      runId: String(runId),
      fromNodeId: String(currentNodeId),
      workflowHash,
      attemptId: String(attemptId),
      nextEventIndex,
      extraEventsToAppend,
      outcome: { kind: 'blocked', blockers: args.blockers },
      minted: {
        advanceRecordedEventId: evtAdvanceRecorded,
      },
    });
    if (planRes.isErr()) return neErrorAsync({ kind: 'invariant_violation' as const, message: planRes.error.message });
    return sessionStore.append(lock, planRes.value);
  }

  // Advanced path
  const toNodeId = String(idFactory.mintNodeId());
  const evtNodeCreated = idFactory.mintEventId();
  const evtEdgeCreated = idFactory.mintEventId();

  const hasChildren = truth.events.some(
    (e): e is Extract<DomainEventV1, { kind: 'edge_created' }> =>
      e.kind === EVENT_KIND.EDGE_CREATED && e.data.fromNodeId === String(currentNodeId)
  );
  const causeKind: 'non_tip_advance' | 'intentional_fork' = hasChildren ? EDGE_CAUSE.NON_TIP_ADVANCE : EDGE_CAUSE.INTENTIONAL_FORK;

  const normalizedOutputs = normalizeOutputsForAppend(args.outputsToAppend);
  const outputEventIds = normalizedOutputs.map(() => idFactory.mintEventId());

  const planRes = buildAckAdvanceAppendPlanV1({
    sessionId: String(sessionId),
    runId: String(runId),
    fromNodeId: String(currentNodeId),
    workflowHash,
    attemptId: String(attemptId),
    nextEventIndex,
    extraEventsToAppend,
    outcome: { kind: 'advanced', toNodeId },
    toNodeKind: args.toNodeKind ?? 'step',
    toNodeId,
    snapshotRef: args.snapshotRef,
    causeKind,
    minted: {
      advanceRecordedEventId: evtAdvanceRecorded,
      nodeCreatedEventId: evtNodeCreated,
      edgeCreatedEventId: evtEdgeCreated,
      outputEventIds,
    },
    outputsToAppend: [...args.outputsToAppend],
  });
  if (planRes.isErr()) return neErrorAsync({ kind: 'invariant_violation' as const, message: planRes.error.message });

  return sessionStore.append(lock, planRes.value);
}

// ── Output builders ───────────────────────────────────────────────────

export function buildNotesOutputs(
  allowNotesAppend: boolean,
  attemptId: AttemptId,
  inputOutput: V2ContinueWorkflowInput['output'],
): readonly OutputToAppend[] {
  if (!allowNotesAppend || !inputOutput?.notesMarkdown) return [];
  return [{
    outputId: String(asOutputId(`out_recap_${String(attemptId)}`)),
    outputChannel: OUTPUT_CHANNEL.RECAP,
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
export function buildArtifactOutputs(
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
      outputChannel: OUTPUT_CHANNEL.ARTIFACT,
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
