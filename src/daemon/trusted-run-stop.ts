/** Supervisor-only run cancellation. Never registered as a worker tool. */
import { z } from 'zod';
import { ResultAsync, okAsync } from 'neverthrow';
import type { CreateTrustedRunStopper, RunSubject, RunStopAuthorityRef, RunStopReceiptRef, RunStopResult } from '../v2/ports/trusted-run-stop.port.js';
import { asSessionId, asRunId } from '../v2/durable-core/ids/index.js';
import { parseContinueTokenOrFail } from '../v2/usecases/v2-token-ops.js';
import { deriveWorkflowHashRef } from '../v2/durable-core/ids/workflow-hash-ref.js';
import { projectRunLifecycle } from '../v2/durable-core/projections/run-lifecycle.js';
import { asSortedEventLog } from '../v2/durable-core/sorted-event-log.js';
import { buildSessionIndex } from '../v2/durable-core/session-index.js';
import type { DomainEventV1 } from '../v2/durable-core/schemas/session/index.js';

const SubjectSchema = z.object({ sessionId: z.string().min(1), runId: z.string().min(1) }).strict();
const subjectText = (subject: RunSubject) => JSON.stringify([subject.sessionId, subject.runId]);
const refused = (reason: 'invalid_authority' | 'subject_mismatch' | 'storage_unavailable', detail: string): RunStopResult => ({ kind: 'refused', reason, detail });

export const createTrustedRunStopper: CreateTrustedRunStopper = async ({ toolContext, faultSeam }, lifetime) => {
  const v2 = toolContext.v2;
  let closed = false;
  const active = new Set<Promise<unknown>>();
  const unavailable = (signal: AbortSignal) => closed || lifetime.aborted || signal.aborted;
  const cancelled = () => ({ kind: 'cancelled_operation' as const, reason: 'operation_aborted' as const });
  const mac = (bytes: Uint8Array, key: string) => v2.tokenCodecPorts.hmac.hmacSha256(Buffer.from(key, 'base64url'), bytes);
  const issue = (subject: RunSubject): RunStopAuthorityRef => {
    const bytes = Buffer.from(JSON.stringify(subject));
    const signed = Buffer.concat([Buffer.from('workrail-run-stop-authority-v1\0'), bytes]);
    return ('rs1.' + bytes.toString('base64url') + '.' + Buffer.from(mac(signed, v2.tokenCodecPorts.keyring.current.keyBase64Url)).toString('base64url')) as RunStopAuthorityRef;
  };
  const verify = (authority: RunStopAuthorityRef): RunSubject | null => {
    try {
      const parts = authority.split('.');
      if (parts.length !== 3 || parts[0] !== 'rs1') return null;
      const bytes = Buffer.from(parts[1]!, 'base64url');
      const signature = Buffer.from(parts[2]!, 'base64url');
      const signed = Buffer.concat([Buffer.from('workrail-run-stop-authority-v1\0'), bytes]);
      const keys = [v2.tokenCodecPorts.keyring.current, v2.tokenCodecPorts.keyring.previous].filter(key => key !== null);
      if (!keys.some(key => v2.tokenCodecPorts.hmac.timingSafeEqual(signature, mac(signed, key.keyBase64Url)))) return null;
      const parsed = SubjectSchema.safeParse(JSON.parse(bytes.toString()));
      return parsed.success ? { sessionId: asSessionId(parsed.data.sessionId), runId: asRunId(parsed.data.runId) } : null;
    } catch { return null; }
  };
  return {
    async inspectTarget(token, signal) {
      if (unavailable(signal)) return cancelled();
      const parsed = await parseContinueTokenOrFail(token, v2.tokenCodecPorts, v2.tokenAliasStore);
      if (parsed.isErr()) return { kind: 'refused', reason: 'invalid_token', detail: 'Invalid run token' };
      const subject = { sessionId: parsed.value.sessionId, runId: parsed.value.runId };
      const loaded = await v2.sessionStore.load(subject.sessionId);
      if (loaded.isErr()) return { kind: 'refused', reason: 'storage_unavailable', detail: loaded.error.message };
      const run = loaded.value.events.find(event => event.kind === 'run_started' && event.scope.runId === subject.runId);
      if (run?.kind !== 'run_started' || !loaded.value.events.some(event => event.kind === 'node_created' && event.scope.runId === subject.runId && event.scope.nodeId === parsed.value.nodeId)) {
        return { kind: 'refused', reason: 'not_found', detail: 'Run occurrence unavailable' };
      }
      const hash = deriveWorkflowHashRef(run.data.workflowHash);
      if (hash.isErr() || hash.value !== parsed.value.workflowHashRef) return { kind: 'refused', reason: 'invalid_token', detail: 'Token names another workflow' };
      if (unavailable(signal)) return cancelled();
      const state = projectRunLifecycle(loaded.value.events, subject.runId);
      if (state.kind === 'completed') return { kind: 'already_completed', subject };
      if (state.kind === 'stopped') return { kind: 'already_stopped', subject, ...state.event.data, receipt: state.event.data.receipt as RunStopReceiptRef };
      return { kind: 'eligible', subject, authority: issue(subject) };
    },
    async stop(authority, subject, detail, signal) {
      const issued = verify(authority);
      if (!issued) return refused('invalid_authority', 'Invalid stop authority');
      if (subjectText(issued) !== subjectText(subject)) return refused('subject_mismatch', 'Authority names another run');
      if (unavailable(signal)) return cancelled();
      let commitAttempted = false;
      const operation = v2.gate.withHealthySessionLock(subject.sessionId, lock => ResultAsync.fromPromise((async (): Promise<RunStopResult> => {
        const loaded = await v2.sessionStore.load(subject.sessionId);
        if (loaded.isErr()) return refused('storage_unavailable', loaded.error.message);
        const truth = loaded.value;
        const state = projectRunLifecycle(truth.events, subject.runId);
        if (state.kind === 'stopped') return { kind: 'replay', subject, ...state.event.data, receipt: state.event.data.receipt as RunStopReceiptRef };
        if (state.kind === 'completed') return { kind: 'already_completed', subject };
        if (!truth.events.some(event => event.kind === 'run_started' && event.scope.runId === subject.runId)) return refused('storage_unavailable', 'Run unavailable');
        const sorted = asSortedEventLog(truth.events);
        if (sorted.isErr()) return refused('storage_unavailable', sorted.error.message);
        if (unavailable(signal)) return cancelled();
        const receipt = String(v2.idFactory.mintEventId()) as RunStopReceiptRef;
        const event: DomainEventV1 = { v: 1, eventId: receipt, sessionId: subject.sessionId,
          eventIndex: buildSessionIndex(sorted.value).nextEventIndex, timestampMs: Date.now(), kind: 'run_stopped',
          dedupeKey: 'run_stopped:' + subject.runId, scope: { runId: subject.runId }, data: { receipt, reason: 'cancelled', detail } };
        commitAttempted = true;
        const appended = await v2.sessionStore.append(lock, { events: [event], snapshotPins: [] }, truth);
        if (appended.isErr()) return { kind: 'unconfirmed', reason: 'commit_uncertain' };
        if (faultSeam && await faultSeam.afterCommit(subject, signal) === 'suppress_acknowledgement') return { kind: 'unconfirmed', reason: 'commit_uncertain' };
        return { kind: 'stopped', subject, receipt, reason: 'cancelled', detail };
      })(), (): RunStopResult => commitAttempted ? { kind: 'unconfirmed', reason: 'commit_uncertain' } : refused('storage_unavailable', 'Stop I/O failed')).orElse(error => okAsync(error)))
        .match(value => value, error => refused('storage_unavailable', error.message));
      active.add(operation);
      try { return await operation; } finally { active.delete(operation); }
    },
    async close(signal) {
      closed = true;
      if (signal.aborted) return { kind: 'incomplete', reason: 'cancelled', detail: 'Close cancelled' };
      if (active.size) return { kind: 'incomplete', reason: 'work_in_flight', detail: 'Stop still settling' };
      return { kind: 'closed' };
    },
  };
};
