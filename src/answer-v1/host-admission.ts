import { classifyAnswerWorkflow } from './workflow-support.js';
import type { HostEnrollment, ExecutionRef, OwnerFence } from './contracts/invocation-contract.js';
import type { RecoveryRef } from './contracts/answer-contract.js';
import { startExecutionDeadline, type DeadlineClock, type ExecutionDeadline, type DeadlineStopReason, type StartDeadlineResult } from './execution-deadline.js';
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
import { hasWorkflowDefinitionShape } from '../types/workflow-definition.js';

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
  const output = classifyAnswerWorkflow(prepared.pinnedWorkflow.definition);
  if (output === 'unsupported') return { kind: 'refused', reason: 'invalid_candidate' };
  const requiredOutput = output === 'review' ? { requiredOutput: 'wr.contracts.review_verdict' as const } : {};
  const recovery = ids.idFactory.mintEventId();
  const initial = { v: 1, eventId: ids.idFactory.mintEventId(), eventIndex: events.length,
    sessionId: prepared.sessionId, timestampMs: now(), kind: 'answer_host_recorded', scope: { runId: prepared.runId },
    dedupeKey: `answer_host:${prepared.sessionId}:${events.length}`,
    data: { kind: 'enrolled', mode: 'host_bound', recovery, initialNode: prepared.nodeId, request, ...requiredOutput } };
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

type AdmissionContentReader = Pick<AdmissionEngine, 'crypto' | 'pinnedStore' | 'snapshotStore'>;

async function contentMatches(engine: AdmissionContentReader, reservation: AdmissionReservation): Promise<'valid' | 'invalid' | 'unavailable'> {
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
  const output = classifyAnswerWorkflow(workflow);
  if (workflow.id !== reservation.request.workflowId || output === 'unsupported') return 'invalid';
  const enrollment = reservation.plan.events.at(-1);
  if (enrollment?.kind !== 'answer_host_recorded' || enrollment.data.kind !== 'enrolled'
    || enrollment.data.requiredOutput !== (output === 'review' ? 'wr.contracts.review_verdict' : undefined)) return 'invalid';
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

export type InspectHostAdmissionResult = Exclude<HostAdmissionResult, { kind: 'admitted' }>
  | Readonly<{ kind: 'missing' | 'not_initialized' }>
  | Readonly<{ kind: 'located'; enrollment: HostEnrollment }>;

/** Observation never invokes admission reconciliation: that path may append an
 * uninitialized session. The restricted engine has no lock, append or owner capability. */
export async function inspectHostAdmission(
  engine: AdmissionContentReader & Readonly<{ sessionStore: Pick<AdmissionEngine['sessionStore'], 'load'> }>,
  root: string, expected: Readonly<{ operationId: string; request: HostWorkRequest }>, signal: AbortSignal,
): Promise<InspectHostAdmissionResult> {
  try {
  if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' } as const;
  const retained = await readAdmissionFile(root, expected.operationId, signal);
  if (retained.kind !== 'durable') return retained;
  const decoded = decodeAdmissionReservation(retained.bytes, expected);
  if (decoded.kind === 'refused') return decoded;
  const { reservation } = decoded;
  const content = await contentMatches(engine, reservation);
  if (content === 'unavailable') return { kind: 'unconfirmed', reason: 'storage_unavailable' } as const;
  if (content === 'invalid') return { kind: 'refused', reason: 'invalid_content' } as const;
  const loaded = await engine.sessionStore.load(asSessionId(reservation.sessionId));
  if (loaded.isErr()) return { kind: 'unconfirmed', reason: 'storage_unavailable' } as const;
  if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' } as const;
  if (!loaded.value.events.length && !loaded.value.manifest.length) return { kind: 'not_initialized' } as const;
  if (!matchesAdmissionPrefix(reservation, loaded.value.events)) return { kind: 'refused', reason: 'journal_conflict' } as const;
  const enrollment = { execution: reservation.sessionId as ExecutionRef, recovery: reservation.recovery as RecoveryRef } as HostEnrollment;
  return { kind: 'located', enrollment } as const;
  } catch { return { kind: 'unconfirmed', reason: 'storage_unavailable' }; }
}

async function reconcileHostAdmission(
  engine: AdmissionEngine, reservation: AdmissionReservation, signal: AbortSignal,
  mode: Readonly<{ kind: 'reconcile' }> | Readonly<{ kind: 'fresh'; deadline: ExecutionDeadline }> = { kind: 'reconcile' },
): Promise<HostAdmissionResult> {
  const deadline = mode.kind === 'fresh' ? mode.deadline : undefined;
  const available = () => !signal.aborted && deadline?.check().kind !== 'stopped';
  if (!available()) return { kind: 'unconfirmed', reason: 'cancelled' };
  const pointer: PersistedHostPointer = { formatVersion: 1, executionId: reservation.sessionId, recoveryLocator: reservation.recovery };
  const result = await engine.gate.withHealthySessionLock(asSessionId(reservation.sessionId), lock =>
    ResultAsync.fromPromise((async (): Promise<HostAdmissionResult> => {
      if (!available()) return { kind: 'unconfirmed', reason: 'cancelled' };
      const content = await contentMatches(engine, reservation);
      if (content === 'unavailable') return { kind: 'unconfirmed', reason: 'storage_unavailable' };
      if (content === 'invalid') return { kind: 'refused', reason: 'invalid_content' };
      const loaded = await engine.sessionStore.load(asSessionId(reservation.sessionId));
      if (loaded.isErr()) return { kind: 'unconfirmed', reason: 'storage_unavailable' };
      if (loaded.value.events.length || loaded.value.manifest.length) {
        if (mode.kind === 'fresh') return { kind: 'refused', reason: 'journal_conflict' };
        return matchesAdmissionPrefix(reservation, loaded.value.events)
          ? { kind: 'admitted', pointer } : { kind: 'refused', reason: 'journal_conflict' };
      }
      if (!available()) return { kind: 'unconfirmed', reason: 'cancelled' };
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
  return !available() ? { kind: 'unconfirmed', reason: 'cancelled' }
    : result.isOk() ? result.value : { kind: 'unconfirmed', reason: 'storage_unavailable' };
}


const freshAdmissionBrand = Symbol('fresh-admission');
/** Opaque process-local handoff. The private registry, not this brand, is authority. */
export type FreshAdmission = Readonly<{ [freshAdmissionBrand]: true }>;
type FreshAdmissionFailure = Exclude<HostAdmissionResult, { kind: 'admitted' }>
  | Readonly<{ kind: 'refused'; reason: 'missing_policy' | 'clock_continuity_unavailable' | 'expired' | 'invalid_expiration' | 'cancelled' }>;
export type FreshAdmissionResult = FreshAdmissionFailure
  | Readonly<{ kind: 'fresh'; handoff: FreshAdmission }>
  | Readonly<{ kind: 'existing'; pointer: PersistedHostPointer }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'deadline_stopped'; deadlineReason: DeadlineStopReason }>;
export type ClaimFreshAdmissionResult =
  | Readonly<{ kind: 'owned'; reservation: AdmissionReservation; deadline: ExecutionDeadline; enrollment: HostEnrollment; owner: OwnerFence }>
  | Readonly<{ kind: 'refused'; reason: 'invalid_handoff' | 'journal_changed' | 'cancelled' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'storage_unavailable' | 'cancelled' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'deadline_stopped'; deadlineReason: DeadlineStopReason }>;


/** Trusted admission composition only. Claiming transfers deadline cleanup and the first
 * canonical owner to the host. It does not grant a runner or workspace tool capabilities. */
export function createFreshAdmissionAuthority(engine: AdmissionEngine & Pick<AnswerEngine, 'idFactory'>, clock: DeadlineClock, lifetime: AbortSignal) {
  const shutdown = new AbortController();
  const parent = AbortSignal.any([lifetime, shutdown.signal]);
  const pending = new Map<FreshAdmission, Readonly<{ reservation: AdmissionReservation; deadline: ExecutionDeadline; detach(): void; state: 'pending' | 'claiming' }>>();
  const discard = () => { for (const entry of pending.values()) entry.deadline.close(); pending.clear(); };
  parent.addEventListener('abort', discard, { once: true });
  return {
    async admit(root: string, expected: Readonly<{ operationId: string; request: HostWorkRequest }>, candidate: Uint8Array,
      requestSignal: AbortSignal): Promise<FreshAdmissionResult> {
      const bytes = Uint8Array.from(candidate);
      const decoded = decodeAdmissionReservation(bytes, expected);
      if (decoded.kind !== 'validated') return decoded;
      const reservation = decoded.reservation;
      const policy = reservation.request.daemonPolicy;
      if (!policy) return { kind: 'refused', reason: 'missing_policy' };
      if (requestSignal.aborted) return { kind: 'refused', reason: 'cancelled' };
      const started: StartDeadlineResult = startExecutionDeadline({ kind: 'new_execution', expiresAtMs: policy.limits.expiresAtMs }, clock, parent);
      if (started.kind !== 'started') return started;
      const deadline = started.deadline;
      const signal = AbortSignal.any([requestSignal, deadline.signal]);
      const diagnose = (result: FreshAdmissionResult): FreshAdmissionResult => {
        const status = deadline.check();
        return status.kind === 'stopped'
          ? { kind: 'unconfirmed', reason: 'deadline_stopped', deadlineReason: status.reason } : result;
      };
      let transferred = false;
      try {
        const publication = await publishAdmissionFile(root, reservation.operationId, bytes, signal, deadline);
        if (publication.kind !== 'durable') return diagnose(publication);
        const winner = decodeAdmissionReservation(publication.bytes, { operationId: reservation.operationId, request: reservation.request });
        if (winner.kind !== 'validated') return winner;
        // Existing reservations may be inspected, but this new timer cannot attest their lifetime.
        if (publication.publication === 'existing_winner') return { kind: 'existing', pointer: {
          formatVersion: 1, executionId: winner.reservation.sessionId, recoveryLocator: winner.reservation.recovery,
        } };
        if (!Buffer.from(publication.bytes).equals(Buffer.from(bytes))) return { kind: 'refused', reason: 'journal_conflict' };
        const admitted = await reconcileHostAdmission(engine, winner.reservation, signal, { kind: 'fresh', deadline });
        if (admitted.kind !== 'admitted') return diagnose(admitted);
        if (signal.aborted || deadline.check().kind === 'stopped') return diagnose({ kind: 'unconfirmed', reason: 'cancelled' });
        const handoff: FreshAdmission = Object.freeze({ [freshAdmissionBrand]: true });
        const expired = () => { pending.delete(handoff); };
        deadline.signal.addEventListener('abort', expired, { once: true });
        pending.set(handoff, { reservation: winner.reservation, deadline, state: 'pending',
          detach() { deadline.signal.removeEventListener('abort', expired); } });
        transferred = true;
        return { kind: 'fresh', handoff };
      } catch { return diagnose({ kind: 'unconfirmed', reason: 'storage_unavailable' }); }
      finally { if (!transferred) deadline.close(); }
    },
    /** One attempt owns the handoff; a failed/uncertain append never grants a retry. */
    async claim(handoff: FreshAdmission, requestSignal: AbortSignal): Promise<ClaimFreshAdmissionResult> {
      const entry = pending.get(handoff);
      if (!entry || entry.state !== 'pending') return { kind: 'refused', reason: 'invalid_handoff' };
      const claiming = { ...entry, state: 'claiming' as const };
      pending.set(handoff, claiming);
      const signal = AbortSignal.any([requestSignal, entry.deadline.signal]);
      const available = () => !signal.aborted && entry.deadline.check().kind === 'active';
      let transferred = false;
      try {
        const initialStatus = entry.deadline.check();
        if (initialStatus.kind === 'stopped') return { kind: 'unconfirmed', reason: 'deadline_stopped', deadlineReason: initialStatus.reason };
        if (requestSignal.aborted) return { kind: 'refused', reason: 'cancelled' };
        const reservation = entry.reservation;
        const result = await engine.gate.withHealthySessionLock(asSessionId(reservation.sessionId), lock =>
          ResultAsync.fromPromise((async (): Promise<ClaimFreshAdmissionResult> => {
            if (pending.get(handoff) !== claiming || !available()) return { kind: 'refused', reason: 'invalid_handoff' };
            pending.delete(handoff); entry.detach();
            const loaded = await engine.sessionStore.load(asSessionId(reservation.sessionId));
            if (loaded.isErr()) return { kind: 'unconfirmed', reason: 'storage_unavailable' };
            // Exact initial truth excludes even released prior owners and uncaptured effects.
            if (loaded.value.events.length !== reservation.plan.events.length || !matchesAdmissionPrefix(reservation, loaded.value.events))
              return { kind: 'refused', reason: 'journal_changed' };
            if (!available()) return { kind: 'refused', reason: 'cancelled' };
            const enrollment = { execution: reservation.sessionId as ExecutionRef, recovery: reservation.recovery as RecoveryRef } as HostEnrollment;
            const owner = { execution: enrollment.execution, epoch: 1n } as OwnerFence;
            const now = clock.read();
            if (now.kind !== 'reading' || !Number.isSafeInteger(now.wallMs) || now.wallMs < 0) return { kind: 'unconfirmed', reason: 'deadline_stopped', deadlineReason: 'clock_continuity_unavailable' };
            const event = DomainEventV1Schema.safeParse({ v: 1, kind: 'answer_host_recorded', sessionId: reservation.sessionId,
              scope: { runId: reservation.runId }, eventId: engine.idFactory.mintEventId(), eventIndex: loaded.value.events.length,
              timestampMs: now.wallMs,
              dedupeKey: `answer_host:${reservation.sessionId}:${loaded.value.events.length}`, data: { kind: 'owner_acquired', epoch: '1' } });
            if (!event.success) return { kind: 'unconfirmed', reason: 'storage_unavailable' };
            if (!available()) return { kind: 'refused', reason: 'cancelled' };
            const appended = await engine.sessionStore.append(lock, { events: [event.data], snapshotPins: [] }, loaded.value);
            if (appended.isErr()) return { kind: 'unconfirmed', reason: 'storage_unavailable' };
            if (requestSignal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
            if (!available()) return { kind: 'unconfirmed', reason: 'storage_unavailable' };
            return { kind: 'owned', enrollment, owner, reservation, deadline: entry.deadline };
          })(), () => ({ code: 'FRESH_OWNER_IO_ERROR' as const })));
        const status = entry.deadline.check();
        if (status.kind === 'stopped') return { kind: 'unconfirmed', reason: 'deadline_stopped', deadlineReason: status.reason };
        if (requestSignal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
        if (result.isErr()) return { kind: 'unconfirmed', reason: 'storage_unavailable' };
        transferred = result.value.kind === 'owned';
        return result.value;
      } catch { return { kind: 'unconfirmed', reason: 'storage_unavailable' }; }
      finally {
        if (pending.get(handoff) === claiming) pending.delete(handoff);
        entry.detach();
        if (!transferred) entry.deadline.close();
      }
    },
    close() { shutdown.abort(); discard(); },
  };
}
