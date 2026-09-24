import { z } from 'zod';
import type { JsonValue } from '../v2/durable-core/canonical/json-types.js';
import { ResultAsync } from 'neverthrow';
import { decodeAdmissionReservation, matchesAdmissionPrefix, type AdmissionReservation } from './admission-reservation.js';
import { publishAdmissionFile, readAdmissionFile } from './immutable-admission-file.js';
import type { AnswerEngine } from './engine-composition.js';
import type { PreparedWorkflowStart } from '../v2/usecases/start-workflow.js';
import type { HostWorkRequest, PersistedHostPointer } from './contracts/host-composition.js';
import { DomainEventV1Schema } from '../v2/durable-core/schemas/session/index.js';
import { JsonValueSchema } from '../v2/durable-core/canonical/json-zod.js';
import { workflowHashForCompiledSnapshot, snapshotRefForExecutionSnapshotFileV1 } from '../v2/durable-core/canonical/hashing.js';
import { asSessionId, asSha256Digest, asSnapshotRef, asWorkflowHash } from '../v2/durable-core/ids/index.js';
import { hasWorkflowDefinitionShape, isStandardStepDefinition } from '../types/workflow-definition.js';

export type HostAdmissionResult =
  | Readonly<{ kind: 'admitted'; pointer: PersistedHostPointer }>
  | Readonly<{ kind: 'refused'; reason: 'invalid_candidate' | 'operation_conflict' | 'request_conflict' | 'corrupt_reservation'
      | 'unsupported_version' | 'unsupported_platform' | 'invalid_input' | 'invalid_file' | 'invalid_content' | 'journal_conflict' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'cancelled' | 'storage_unavailable' }>;

/** Produces host-only initial intent before publication. Does not allocate a session or
 * acquire an owner. The core's legacy EAT context is intentionally excluded. */
export function buildHostAdmissionCandidate(
  prepared: PreparedWorkflowStart,
  request: HostWorkRequest,
  operationId: string,
  ids: Pick<AnswerEngine, 'idFactory'>,
  now: () => number,
): Readonly<{ kind: 'candidate'; bytes: Uint8Array }> | Readonly<{ kind: 'refused'; reason: 'invalid_candidate' }> {
  const events = prepared.appendPlan.events.map(event => {
    if (event.kind !== 'context_set') return event;
    const context = event.data.context;
    if (context === null || typeof context !== 'object' || Array.isArray(context)) return event;
    const parsedContext = z.record(z.string()).safeParse(context);
    if (!parsedContext.success) return event;
    const { eat_token: _legacyToken, ...hostContext } = parsedContext.data;
    return { ...event, data: { ...event.data, context: hostContext } };
  });
  const recovery = ids.idFactory.mintEventId();
  const initial = { v: 1, eventId: ids.idFactory.mintEventId(), eventIndex: events.length,
    sessionId: prepared.sessionId, timestampMs: now(), kind: 'answer_host_recorded', scope: { runId: prepared.runId },
    dedupeKey: `answer_host:${prepared.sessionId}:${events.length}`,
    data: { kind: 'enrolled', mode: 'host_bound', recovery, initialNode: prepared.nodeId, request } };
  const bytes = Buffer.from(JSON.stringify({ formatVersion: request.daemonPolicy ? 2 : 1, operationId, request, sessionId: prepared.sessionId,
    runId: prepared.runId, nodeId: prepared.nodeId, workflowHash: prepared.workflowHash, recovery, mode: 'host_bound',
    plan: { events: [...events, initial], snapshotPins: prepared.appendPlan.snapshotPins } }));
  return decodeAdmissionReservation(bytes, { operationId, request }).kind === 'validated'
    ? { kind: 'candidate', bytes } : { kind: 'refused', reason: 'invalid_candidate' };
}

type AdmissionEngine = Readonly<{
  crypto: AnswerEngine['crypto'];
  pinnedStore: Pick<AnswerEngine['pinnedStore'], 'get'>;
  snapshotStore: Pick<AnswerEngine['snapshotStore'], 'getExecutionSnapshotV1'>;
  gate: Pick<AnswerEngine['gate'], 'withHealthySessionLock'>;
  sessionStore: Pick<AnswerEngine['sessionStore'], 'load' | 'append'>;
}>;

async function contentMatches(engine: AdmissionEngine, reservation: AdmissionReservation): Promise<'valid' | 'invalid' | 'unavailable'> {
  const workflowHash = asWorkflowHash(asSha256Digest(reservation.workflowHash));
  const snapshotRef = asSnapshotRef(asSha256Digest(reservation.plan.snapshotPins[0]!.snapshotRef));
  const [pinned, snapshot] = await Promise.all([
    engine.pinnedStore.get(workflowHash), engine.snapshotStore.getExecutionSnapshotV1(snapshotRef),
  ]);
  if (pinned.isErr() || snapshot.isErr()) return 'unavailable';
  if (!pinned.value || !snapshot.value) return 'invalid';
  const json = JsonValueSchema.safeParse(pinned.value);
  if (!json.success) return 'invalid';
  const computedWorkflow = workflowHashForCompiledSnapshot(json.data as JsonValue, engine.crypto);
  const computedSnapshot = snapshotRefForExecutionSnapshotFileV1(snapshot.value, engine.crypto);
  if (computedWorkflow.isErr() || computedWorkflow.value !== workflowHash
      || computedSnapshot.isErr() || computedSnapshot.value !== snapshotRef) return 'invalid';
  if (!('definition' in pinned.value) || !hasWorkflowDefinitionShape(pinned.value.definition)) return 'invalid';
  const workflow = pinned.value.definition;
  if (workflow.id !== reservation.request.workflowId || workflow.steps.length === 0
      || !workflow.steps.every(step => isStandardStepDefinition(step) && !step.requireConfirmation
        && !step.outputContract && !step.validationCriteria && !step.assessmentRefs && !step.runCondition)) return 'invalid';
  const state = snapshot.value.enginePayload.engineState;
  return !snapshot.value.enginePayload.gateCheckpoint && state.kind === 'running' && state.completed.values.length === 0
    && state.loopStack.length === 0 && state.pending.kind === 'some' && state.pending.step.loopPath.length === 0
    && state.pending.step.stepId === workflow.steps[0]!.id ? 'valid' : 'invalid';
}

/** Trusted transport boundary. The caller retains operation correlation and supplies
 * candidate bytes; an existing winner overrides a competing candidate only after full
 * request validation. Never call legacy enroll after an unconfirmed outcome.
 * Root creation, restart discovery and daemon routing remain separate integration work.
 */
export async function publishAndReconcileHostAdmission(
  engine: AdmissionEngine,
  root: string,
  expected: Readonly<{ operationId: string; request: HostWorkRequest }>,
  candidate: Uint8Array,
  signal: AbortSignal,
): Promise<HostAdmissionResult> {
  const checked = decodeAdmissionReservation(candidate, expected);
  if (checked.kind === 'refused') return checked;
  const publication = await publishAdmissionFile(root, expected.operationId, candidate, signal);
  if (publication.kind !== 'durable') return publication;
  const decoded = decodeAdmissionReservation(publication.bytes, expected);
  if (decoded.kind === 'refused') return decoded;
  return reconcileHostAdmission(engine, decoded.reservation, signal);
}

/** Recovery uses the original operation identity and request, never a new prepared
 * workflow. Missing reservations do not create sessions or fall back to legacy enroll.
 */
export async function recoverHostAdmission(
  engine: AdmissionEngine,
  root: string,
  expected: Readonly<{ operationId: string; request: HostWorkRequest }>,
  signal: AbortSignal,
): Promise<HostAdmissionResult | Readonly<{ kind: 'missing' }>> {
  const retained = await readAdmissionFile(root, expected.operationId, signal);
  if (retained.kind !== 'durable') return retained;
  const decoded = decodeAdmissionReservation(retained.bytes, expected);
  return decoded.kind === 'refused' ? decoded : reconcileHostAdmission(engine, decoded.reservation, signal);
}

async function reconcileHostAdmission(
  engine: AdmissionEngine, reservation: AdmissionReservation, signal: AbortSignal,
): Promise<HostAdmissionResult> {
  if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
  const pointer: PersistedHostPointer = { formatVersion: 1, executionId: reservation.sessionId, recoveryLocator: reservation.recovery };
  const result = await engine.gate.withHealthySessionLock(asSessionId(reservation.sessionId), lock =>
    ResultAsync.fromPromise((async (): Promise<HostAdmissionResult> => {
      if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
      const content = await contentMatches(engine, reservation);
      if (content === 'unavailable') return { kind: 'unconfirmed', reason: 'storage_unavailable' };
      if (content === 'invalid') return { kind: 'refused', reason: 'invalid_content' };
      const loaded = await engine.sessionStore.load(asSessionId(reservation.sessionId));
      if (loaded.isErr()) return { kind: 'unconfirmed', reason: 'storage_unavailable' };
      if (loaded.value.events.length || loaded.value.manifest.length) {
        return matchesAdmissionPrefix(reservation, loaded.value.events)
          ? { kind: 'admitted', pointer } : { kind: 'refused', reason: 'journal_conflict' };
      }
      if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
      // Parse into the journal port's event type; never cast deeply readonly data to
      // writable event payloads or expose the validated reservation to the store.
      const events = DomainEventV1Schema.array().safeParse(reservation.plan.events);
      if (!events.success) return { kind: 'refused', reason: 'corrupt_reservation' };
      const appended = await engine.sessionStore.append(lock, { events: events.data,
        snapshotPins: reservation.plan.snapshotPins.map(pin => ({ ...pin,
          snapshotRef: asSnapshotRef(asSha256Digest(pin.snapshotRef)) })) }, loaded.value);
      return appended.isOk() ? { kind: 'admitted', pointer }
        : { kind: 'unconfirmed', reason: 'storage_unavailable' };
    })(), () => ({ code: 'ADMISSION_IO_ERROR' as const })),
  );
  return signal.aborted ? { kind: 'unconfirmed', reason: 'cancelled' }
    : result.isOk() ? result.value : { kind: 'unconfirmed', reason: 'storage_unavailable' };
}
