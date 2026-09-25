import type { GateSubject, WorkRevisionRef, TrustedGateResolverOptions } from '../v2/ports/trusted-gate-resolver.port.js';
import type { LoadedSessionTruthV2 } from '../v2/ports/session-event-log-store.port.js';
import type { ExecutionSnapshotFileV1 } from '../v2/durable-core/schemas/execution-snapshot/index.js';
import type { DomainEventV1 } from '../v2/durable-core/schemas/session/index.js';
import type { OutputToAppend } from '../v2/durable-core/domain/outputs.js';
import type { V2ContinueWorkflowInput } from '../mcp/v2/tools.js';
import { asNodeId } from '../v2/durable-core/ids/index.js';
import { toCanonicalBytes } from '../v2/durable-core/canonical/jcs.js';
import type { JsonValue } from '../v2/durable-core/canonical/json-types.js';

export interface Pending {
  readonly subject: GateSubject;
  readonly truth: LoadedSessionTruthV2;
  readonly snapshot: ExecutionSnapshotFileV1;
  readonly run: Extract<DomainEventV1, { kind: 'run_started' }>;
  readonly retainedOutputs: readonly OutputToAppend[];
  readonly sourceNodeId: GateSubject['gateNodeId'];
  readonly output: NonNullable<V2ContinueWorkflowInput['output']>;
}

/** Read the exact retained occurrence shared by resolution and correction. */
export function createGateReader(v2: TrustedGateResolverOptions['toolContext']['v2']) {
  const readPending = async (sessionId: GateSubject['sessionId'], runId: GateSubject['runId'], nodeId: GateSubject['gateNodeId']): Promise<{ readonly kind: 'found'; readonly value: Pending } | { readonly kind: 'absent' } | { readonly kind: 'missing_work' } | { readonly kind: 'unavailable'; readonly detail: string }> => {
    const loaded = await v2.sessionStore.load(sessionId);
    if (loaded.isErr()) return { kind: 'unavailable', detail: loaded.error.message };
    const truth = loaded.value;
    const run = truth.events.find((e): e is Pending['run'] => e.kind === 'run_started' && e.scope.runId === runId);
    const node = truth.events.find(e => e.kind === 'node_created' && e.scope.runId === runId && e.scope.nodeId === nodeId);
    if (!run || node?.kind !== 'node_created' || node.data.nodeKind !== 'gate_checkpoint') return { kind: 'absent' };
    const snapshot = await v2.snapshotStore.getExecutionSnapshotV1(node.data.snapshotRef);
    if (snapshot.isErr()) return { kind: 'unavailable', detail: snapshot.error.message };
    if (!snapshot.value?.enginePayload.gateCheckpoint) return { kind: 'absent' };
    const incoming = truth.events.find(e => e.kind === 'edge_created' && e.scope.runId === runId && e.data.toNodeId === nodeId);
    if (incoming?.kind !== 'edge_created') return { kind: 'absent' };
    const advance = truth.events.find(e => e.eventId === incoming.data.cause.eventId);
    if (advance?.kind !== 'advance_recorded') return { kind: 'absent' };
    const corrected = truth.events.some(e => e.kind === 'gate_correction_recorded' && e.scope.runId === runId && e.data.newSubject.gateNodeId === nodeId);
    const outputNodeId = corrected ? nodeId : incoming.data.fromNodeId;
    const outputs = truth.events.filter((e): e is Extract<DomainEventV1, {kind: 'node_output_appended'}> =>
      e.kind === 'node_output_appended' && e.scope.runId === runId && e.scope.nodeId === outputNodeId &&
      (e.data.outputId === `out_recap_${advance.data.attemptId}` || e.data.outputId.startsWith(`out_artifact_${advance.data.attemptId}_`)))
      .sort((a, b) => a.data.outputId.localeCompare(b.data.outputId, 'en', { numeric: true }));
    // New snapshots prove an accepted submission even when notes are optional.
    // Legacy snapshots without that evidence must not silently approve lost work.
    if (!outputs.length && snapshot.value.enginePayload.gateCheckpoint.acceptedContext === undefined) return { kind: 'missing_work' };
    if (outputs.some(e => e.data.payload.payloadKind === 'artifact_ref' && e.data.payload.content === undefined)) return { kind: 'missing_work' };
    const notes = outputs.flatMap(e => e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes' ? [e.data.payload.notesMarkdown] : []);
    const artifacts = outputs.flatMap(e => e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'artifact_ref' && e.data.payload.content !== undefined ? [e.data.payload.content] : []);
    const revision = gateWorkRevision(v2, node.data.snapshotRef, outputs);
    if (revision.isErr()) return { kind: 'unavailable', detail: revision.error.message };
    const workRevision = revision.value;
    return { kind: 'found', value: { subject: { sessionId, runId, gateNodeId: nodeId, stepId: snapshot.value.enginePayload.gateCheckpoint.stepId, workRevision },
      truth, snapshot: snapshot.value, run, retainedOutputs: outputs.map(e => e.data), sourceNodeId: asNodeId(outputNodeId), output: { ...(notes.length ? { notesMarkdown: notes.join('\n\n') } : {}), artifacts } } };
  };
  return readPending;
}

export function gateWorkRevision(v2: TrustedGateResolverOptions['toolContext']['v2'], snapshotRef: string,
  outputs: readonly Extract<DomainEventV1, { kind: 'node_output_appended' }>[]) {
  return toCanonicalBytes([snapshotRef, [...outputs].sort((a, b) => a.data.outputId.localeCompare(b.data.outputId, 'en', { numeric: true }))] as unknown as JsonValue)
    .map(bytes => String(v2.sha256.sha256(bytes)) as WorkRevisionRef);
}
