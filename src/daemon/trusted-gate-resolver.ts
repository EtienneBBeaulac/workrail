import { projectRunLifecycle } from '../v2/durable-core/projections/run-lifecycle.js';
import { createGateReader } from './trusted-gate-state.js';
/** Privileged host composition. This factory is never registered as a worker tool. */
import { z } from 'zod';
import { ResultAsync, okAsync, errAsync } from 'neverthrow';
import type { CreateGateResolver, GateSubject, GateAuthorityRef, WorkRevisionRef, GateReceiptRef, GateResolutionResult, GateResolutionDecision } from '../v2/ports/trusted-gate-resolver.port.js';
import type { DomainEventV1 } from '../v2/durable-core/schemas/session/index.js';
import { asSessionId, asRunId, asNodeId } from '../v2/durable-core/ids/index.js';
import { asSortedEventLog } from '../v2/durable-core/sorted-event-log.js';
import { buildSessionIndex } from '../v2/durable-core/session-index.js';
import { parseContinueTokenOrFail, mintSingleShortToken } from '../v2/usecases/v2-token-ops.js';
import { deriveWorkflowHashRef } from '../v2/durable-core/ids/workflow-hash-ref.js';
import { getCachedWorkflow } from '../v2/usecases/workflow-object-cache.js';
import { derivePendingStep } from '../v2/durable-core/projections/snapshot-state.js';
import { validateAdvanceInputs } from '../mcp/handlers/v2-advance-core/input-validation.js';
import { buildSuccessOutcome } from '../mcp/handlers/v2-advance-core/outcome-success.js';
import { NullGitSnapshotV2 } from '../v2/ports/git-snapshot.port.js';
import { toCanonicalBytes } from '../v2/durable-core/canonical/jcs.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

type ResolutionEvent = Extract<DomainEventV1, { kind: 'gate_resolution_recorded' }>;
const SubjectSchema = z.object({ sessionId: z.string().min(1), runId: z.string().min(1),
  stepId: z.string().min(1), gateNodeId: z.string().min(1), workRevision: z.string().min(1) }).strict();
const refusal = (reason: Extract<GateResolutionResult, { kind: 'refused' }>['reason'], detail: string): GateResolutionResult => ({ kind: 'refused', reason, detail });
const subjectText = (s: GateSubject) => JSON.stringify([s.sessionId, s.runId, s.stepId, s.gateNodeId, s.workRevision]);
const decisionText = (d: GateResolutionDecision) => JSON.stringify([d.kind, d.rationale, d.kind === 'approved' ? d.evidenceRef ?? null : null]);


export const createTrustedGateResolver: CreateGateResolver = async ({ toolContext }, lifetime) => {
  const v2 = toolContext.v2;
  let closed = false;
  const active = new Set<Promise<unknown>>();
  const unavailable = (signal: AbortSignal) => closed || lifetime.aborted || signal.aborted;
  const mac = (bytes: Uint8Array, key: string) => v2.tokenCodecPorts.hmac.hmacSha256(Buffer.from(key, 'base64url'), bytes);
  const issue = (subject: GateSubject): GateAuthorityRef => {
    const bytes = Buffer.from(JSON.stringify(subject));
    const signed = Buffer.concat([Buffer.from('workrail-gate-authority-v1\0'), bytes]);
    return ('ga1.' + bytes.toString('base64url') + '.' + Buffer.from(mac(signed, v2.tokenCodecPorts.keyring.current.keyBase64Url)).toString('base64url')) as GateAuthorityRef;
  };
  const verify = (authority: GateAuthorityRef): GateSubject | null => {
    try {
      const parts = authority.split('.');
      if (parts.length !== 3 || parts[0] !== 'ga1') return null;
      const bytes = Buffer.from(parts[1]!, 'base64url');
      const sig = Buffer.from(parts[2]!, 'base64url');
      const signed = Buffer.concat([Buffer.from('workrail-gate-authority-v1\0'), bytes]);
      const keys = [v2.tokenCodecPorts.keyring.current, v2.tokenCodecPorts.keyring.previous].filter(k => k !== null);
      if (!keys.some(key => v2.tokenCodecPorts.hmac.timingSafeEqual(sig, mac(signed, key.keyBase64Url)))) return null;
      const subject = SubjectSchema.safeParse(JSON.parse(bytes.toString()));
      if (!subject.success) return null;
      return { ...subject.data, sessionId: asSessionId(subject.data.sessionId), runId: asRunId(subject.data.runId),
        gateNodeId: asNodeId(subject.data.gateNodeId), workRevision: subject.data.workRevision as WorkRevisionRef };
    } catch { return null; }
  };
  const readPending = createGateReader(v2);
  const resultFromEvent = (event: ResolutionEvent, subject: GateSubject, replay: boolean): GateResolutionResult => {
    const receipt = event.data.receipt as GateReceiptRef;
    if (event.data.decision.kind === 'approved' && event.data.continuation.kind === 'available') {
      return { kind: replay ? 'replay' : 'accepted', disposition: 'approved', receipt, subject, continueToken: event.data.continuation.token };
    }
    if (event.data.decision.kind !== 'approved') return { kind: replay ? 'replay' : 'held', disposition: event.data.decision.kind, receipt, subject };
    return refusal('storage_unavailable', 'Inconsistent persisted gate resolution');
  };
  return {
    async inspectPending(token, signal) {
      if (unavailable(signal)) return { kind: 'refused', reason: 'session_cancelled', detail: 'Resolver closed or cancelled' };
      const parsed = await parseContinueTokenOrFail(token, v2.tokenCodecPorts, v2.tokenAliasStore);
      if (parsed.isErr()) return { kind: 'refused', reason: 'invalid_token', detail: 'Invalid gate token' };
      const read = await readPending(parsed.value.sessionId, parsed.value.runId, parsed.value.nodeId);
      if (read.kind === 'unavailable') return { kind: 'refused', reason: 'storage_unavailable', detail: read.detail };
      if (read.kind === 'missing_work') return { kind: 'refused', reason: 'missing_work', detail: 'Gate work is unavailable' };
      if (read.kind === 'absent') return { kind: 'refused', reason: 'not_pending', detail: 'No retained gate work at this occurrence' };
      const p = read.value;
      if (projectRunLifecycle(p.truth.events, p.subject.runId).kind === 'stopped') return { kind: 'refused', reason: 'session_cancelled', detail: 'Run stopped' };
      if (projectRunLifecycle(p.truth.events, p.subject.runId).kind === 'completed') return { kind: 'refused', reason: 'not_pending', detail: 'Run completed' };
      const hashRef = deriveWorkflowHashRef(p.run.data.workflowHash);
      if (hashRef.isErr() || hashRef.value !== parsed.value.workflowHashRef) return { kind: 'refused', reason: 'invalid_token', detail: 'Token names a different workflow' };
      if (p.truth.events.some(e => e.kind === 'gate_resolution_recorded' && e.scope.runId === p.subject.runId && e.scope.nodeId === p.subject.gateNodeId && e.data.decision.kind !== 'uncertain')) {
        return { kind: 'refused', reason: 'not_pending', detail: 'Gate has a terminal resolution' };
      }
      if (p.truth.events.some(e => e.kind === 'edge_created' && e.scope.runId === p.subject.runId && e.data.fromNodeId === p.subject.gateNodeId)) return { kind: 'refused', reason: 'not_pending', detail: 'Gate has advanced' };
      if (unavailable(signal)) return { kind: 'refused', reason: 'session_cancelled', detail: 'Inspection cancelled' };
      return { kind: 'inspected', subject: p.subject, authority: issue(p.subject) };
    },
    async resolveGate(authority, subject, decision, signal) {
      const issued = verify(authority);
      if (!issued) return refusal('invalid_authority', 'Invalid resolver authority');
      if (subjectText(issued) !== subjectText(subject)) return refusal(
        issued.sessionId === subject.sessionId && issued.runId === subject.runId && issued.gateNodeId === subject.gateNodeId && issued.stepId === subject.stepId ? 'stale_revision' : 'subject_mismatch', 'Authority names a different subject');
      if (unavailable(signal)) return refusal('session_cancelled', 'Resolver closed or cancelled');
      let commitAttempted = false;
      const operation = v2.gate.withHealthySessionLock(subject.sessionId, lock => ResultAsync.fromPromise((async (): Promise<GateResolutionResult> => {
        const read = await readPending(subject.sessionId, subject.runId, subject.gateNodeId);
        if (read.kind === 'unavailable') return refusal('storage_unavailable', read.detail);
        if (read.kind === 'missing_work') return refusal('stale_revision', 'Gate work is unavailable');
        if (read.kind === 'absent') return refusal('stale_revision', 'Gate unavailable');
        const p = read.value;
      if (projectRunLifecycle(p.truth.events, p.subject.runId).kind === 'stopped') return { kind: 'refused', reason: 'session_cancelled', detail: 'Run stopped' };
        if (subjectText(p.subject) !== subjectText(subject)) return refusal('stale_revision', 'Retained gate changed or unavailable');
        if (p.truth.events.some(e => e.kind === 'gate_correction_recorded' && e.scope.runId === subject.runId && e.scope.nodeId === subject.gateNodeId)) return refusal('stale_revision', 'Gate was corrected');
        const decisions = p.truth.events.filter((e): e is ResolutionEvent => e.kind === 'gate_resolution_recorded' && e.scope.runId === subject.runId && e.scope.nodeId === subject.gateNodeId);
        const same = decisions.find(e => decisionText(e.data.decision) === decisionText(decision));
        if (same && (same.data.decision.kind !== 'uncertain' || !decisions.some(e => e.data.decision.kind !== 'uncertain'))) return resultFromEvent(same, subject, true);
        if (projectRunLifecycle(p.truth.events, subject.runId).kind === 'completed') return refusal('conflicting_decision', 'Run completed');
        if (decisions.some(e => e.data.decision.kind !== 'uncertain')) return refusal('conflicting_decision', 'Gate already has a terminal decision');
        if (p.truth.events.some(e => e.kind === 'edge_created' && e.scope.runId === subject.runId && e.data.fromNodeId === subject.gateNodeId)) return refusal('conflicting_decision', 'Gate has already advanced');
        if (unavailable(signal)) return refusal('session_cancelled', 'Resolution cancelled');
        const sorted = asSortedEventLog(p.truth.events);
        if (sorted.isErr()) return refusal('storage_unavailable', sorted.error.message);
        const index = buildSessionIndex(sorted.value);
        const receipt = String(v2.idFactory.mintEventId());
        const event = (resolution: ResolutionEvent['data'], eventIndex: number): ResolutionEvent => ({
          v: 1, eventId: receipt, sessionId: subject.sessionId, eventIndex, timestampMs: Date.now(),
          kind: 'gate_resolution_recorded', dedupeKey: 'gate_resolution:' + String(v2.sha256.sha256(
            Buffer.from(JSON.stringify([subjectText(subject), decisionText(decision)])))),
          scope: { runId: subject.runId, nodeId: subject.gateNodeId },
          data: resolution,
        });
        if (decision.kind !== 'approved') {
          const recorded = event({ workRevision: subject.workRevision, receipt, decision, continuation: { kind: 'held' } }, index.nextEventIndex);
          commitAttempted = true;
          const append = await v2.sessionStore.append(lock, { events: [recorded], snapshotPins: [] }, p.truth);
          return append.isErr() ? { kind: 'unconfirmed', reason: 'commit_uncertain' } : resultFromEvent(recorded, subject, false);
        }
        const pinned = await v2.pinnedStore.get(p.run.data.workflowHash);
        if (pinned.isErr() || pinned.value?.sourceKind !== 'v1_pinned') return refusal('storage_unavailable', 'Pinned workflow unavailable');
        const workflow = getCachedWorkflow(p.run.data.workflowHash, pinned.value.definition as WorkflowDefinition);
        const pendingStep = derivePendingStep(p.snapshot.enginePayload.engineState);
        if (!pendingStep) return refusal('stale_revision', 'Gate has no retained pending step');
        const validation = validateAdvanceInputs({ truth: p.truth, runId: subject.runId, currentNodeId: subject.gateNodeId,
          inputContext: undefined, inputOutput: p.output, pinnedWorkflow: workflow, pendingStep, precomputedIndex: index });
        if (validation.isErr()) return refusal('storage_unavailable', validation.error.kind);
        const hashRef = deriveWorkflowHashRef(p.run.data.workflowHash);
        if (hashRef.isErr()) return refusal('storage_unavailable', hashRef.error.message);
        const attemptId = v2.idFactory.mintAttemptId();
        // Compose the existing advancement with its durable receipt in one append.
        const appendStore = {
          append: (_lock: typeof lock, plan: Parameters<typeof v2.sessionStore.append>[1]) => {
            const next = plan.events.find(e => e.kind === 'node_created');
            if (next?.kind !== 'node_created') return errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'No successor' });
            return mintSingleShortToken({ kind: 'continue', entry: { sessionId: subject.sessionId, runId: subject.runId,
              nodeId: next.scope.nodeId, attemptId: String(v2.idFactory.mintAttemptId()), workflowHashRef: String(hashRef.value) },
              ports: v2.tokenCodecPorts, aliasStore: v2.tokenAliasStore, entropy: v2.entropy })
              .mapErr(error => ({ code: 'SESSION_STORE_IO_ERROR' as const, message: error.message }))
              .andThen(token => {
                const events = plan.events;
                if (unavailable(signal)) return errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'Resolution cancelled before append' });
                commitAttempted = true;
                return v2.sessionStore.append(lock, { ...plan, events: [...events, event({ workRevision: subject.workRevision, receipt, decision, continuation: { kind: 'available', token } }, index.nextEventIndex + events.length)] }, p.truth);
              });
          },
        };
        const advanced = await buildSuccessOutcome({ retainedWork: { outputs: p.retainedOutputs, sourceNodeId: p.sourceNodeId }, mode: { kind: 'fresh', sourceNodeId: subject.gateNodeId, snapshot: p.snapshot },
          ctx: { truth: p.truth, sessionId: subject.sessionId, runId: subject.runId, currentNodeId: subject.gateNodeId,
            attemptId, workflowHash: p.run.data.workflowHash, inputOutput: p.output, pinnedWorkflow: workflow,
            engineState: p.snapshot.enginePayload.engineState, pendingStep },
          computed: { reasons: [], outputRequirement: { kind: 'not_required' }, validation: undefined },
          v: p.snapshot.enginePayload.gateCheckpoint?.acceptedContext !== undefined
            ? { ...validation.value, mergedContext: p.snapshot.enginePayload.gateCheckpoint.acceptedContext, inputContextObj: (() => {
              const retained = p.snapshot.enginePayload.gateCheckpoint!.acceptedContext!;
              const current = toCanonicalBytes(index.runContextByRunId.get(String(subject.runId)) ?? {});
              const accepted = toCanonicalBytes(retained);
              return current.isOk() && accepted.isOk() && Buffer.from(current.value).equals(Buffer.from(accepted.value)) ? undefined : retained;
            })() }
            : validation.value, lock, lockedIndex: index, ports: { ...v2, gitSnapshot: v2.gitSnapshot ?? new NullGitSnapshotV2(), sessionStore: appendStore } });
        if (advanced.isErr()) {
          if (commitAttempted) return { kind: 'unconfirmed', reason: 'commit_uncertain' };
          return unavailable(signal) ? refusal('session_cancelled', 'Resolution cancelled') : refusal('storage_unavailable', 'Preparation failed before journal append');
        }
        const after = await v2.sessionStore.load(subject.sessionId);
        const recorded = after.isOk() ? after.value.events.find((e): e is ResolutionEvent => e.kind === 'gate_resolution_recorded' && e.data.receipt === receipt) : undefined;
        return recorded ? resultFromEvent(recorded, subject, false) : { kind: 'unconfirmed', reason: 'commit_uncertain' };
      })(), (): GateResolutionResult => commitAttempted ? { kind: 'unconfirmed', reason: 'commit_uncertain' } : refusal('storage_unavailable', 'Resolver I/O failed')).orElse(error => okAsync(error))).match(value => value,
        error => refusal(error.code === 'SESSION_LOCKED' || error.code === 'SESSION_LOCK_REENTRANT' ? 'session_busy' : 'storage_unavailable', error.message));
      active.add(operation);
      try { return await operation; } finally { active.delete(operation); }
    },
    async close(signal) {
      closed = true;
      if (signal.aborted) return { kind: 'incomplete', reason: 'cancelled', detail: 'Close cancelled' };
      if (active.size) return { kind: 'incomplete', reason: 'work_in_flight', detail: 'Resolution still settling' };
      return { kind: 'closed' };
    },
  };
};
