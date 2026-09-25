/** Supervisor-only correction, retaining both evaluated occurrences in canonical history. */
import { z } from 'zod';
import { ResultAsync, okAsync, errAsync } from 'neverthrow';
import type { CreateTrustedGateCorrector, GateCorrectionAuthorityRef, GateCorrectionReceiptRef, GateCorrectionResult } from '../v2/ports/trusted-gate-correction.port.js';
import type { GateSubject, WorkRevisionRef } from '../v2/ports/trusted-gate-resolver.port.js';
import type { DomainEventV1 } from '../v2/durable-core/schemas/session/index.js';
import type { JsonValue } from '../v2/durable-core/canonical/json-types.js';
import { asSessionId, asRunId, asNodeId } from '../v2/durable-core/ids/index.js';
import { createGateReader, gateWorkRevision } from './trusted-gate-state.js';
import { projectRunLifecycle } from '../v2/durable-core/projections/run-lifecycle.js';
import { parseContinueTokenOrFail, mintSingleShortToken } from '../v2/usecases/v2-token-ops.js';
import { deriveWorkflowHashRef } from '../v2/durable-core/ids/workflow-hash-ref.js';
import { toCanonicalBytes } from '../v2/durable-core/canonical/jcs.js';
import { asSortedEventLog } from '../v2/durable-core/sorted-event-log.js';
import { buildSessionIndex } from '../v2/durable-core/session-index.js';
import { getCachedWorkflow } from '../v2/usecases/workflow-object-cache.js';
import { derivePendingStep } from '../v2/durable-core/projections/snapshot-state.js';
import { validateAdvanceInputs } from '../mcp/handlers/v2-advance-core/input-validation.js';
import { buildGateCheckpointOutcome } from '../mcp/handlers/v2-advance-core/outcome-gate-checkpoint.js';
import { getOutputRequirementStatusWithArtifactsV1 } from '../v2/durable-core/domain/validation-criteria-validator.js';
import { ValidationEngine } from '../application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../application/services/enhanced-loop-validator.js';
import { withTimeout } from '../mcp/handlers/shared/with-timeout.js';
import { NullGitSnapshotV2 } from '../v2/ports/git-snapshot.port.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { ConditionContext } from '../utils/condition-evaluator.js';
import * as Artifacts from '../v2/durable-core/schemas/artifacts/index.js';

const ArtifactSchema = z.union([Artifacts.AssessmentArtifactV1Schema, Artifacts.LoopControlArtifactV1Schema,
  Artifacts.CoordinatorSignalArtifactV1Schema, Artifacts.ReviewVerdictArtifactV1Schema,
  Artifacts.DiscoveryHandoffArtifactV1Schema, Artifacts.GateVerdictArtifactV1Schema,
  Artifacts.ShapingHandoffArtifactV1Schema, Artifacts.CodingHandoffArtifactV1Schema, Artifacts.DifferentiationHandoffArtifactV1Schema]);
const OutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notes'), notesMarkdown: z.string().refine(value => value.trim().length > 0) }).strict(),
  z.object({ kind: z.literal('artifacts'), artifacts: z.array(ArtifactSchema).nonempty(), notesMarkdown: z.string().optional() }).strict(),
]);
const SubjectSchema = z.object({ sessionId: z.string().min(1), runId: z.string().min(1),
  gateNodeId: z.string().min(1), stepId: z.string().min(1), workRevision: z.string().min(1) }).strict();
const subjectFrom = (s: z.infer<typeof SubjectSchema>): GateSubject => ({ ...s, sessionId: asSessionId(s.sessionId), runId: asRunId(s.runId), gateNodeId: asNodeId(s.gateNodeId), workRevision: s.workRevision as WorkRevisionRef });
const subjectText = (s: GateSubject) => JSON.stringify([s.sessionId, s.runId, s.gateNodeId, s.stepId, s.workRevision]);
type CorrectionEvent = Extract<DomainEventV1, { kind: 'gate_correction_recorded' }>;
const refused = (reason: Extract<GateCorrectionResult, { kind: 'refused' }>['reason'], detail: string): GateCorrectionResult => ({ kind: 'refused', reason, detail });
const fromEvent = (event: CorrectionEvent, replay: boolean): GateCorrectionResult => ({ kind: replay ? 'replay' : 'accepted',
  receipt: event.data.receipt as GateCorrectionReceiptRef, reviewGateToken: event.data.reviewGateToken,
  priorSubject: subjectFrom(event.data.priorSubject), newSubject: subjectFrom(event.data.newSubject) });

export const createTrustedGateCorrector: CreateTrustedGateCorrector = async ({ toolContext, faultSeam }, lifetime) => {
  const v2 = toolContext.v2;
  const readPending = createGateReader(v2);
  let closed = false;
  const active = new Set<Promise<unknown>>();
  const unavailable = (signal: AbortSignal) => closed || lifetime.aborted || signal.aborted;
  const mac = (bytes: Uint8Array, key: string) => v2.tokenCodecPorts.hmac.hmacSha256(Buffer.from(key, 'base64url'), bytes);
  const issue = (subject: GateSubject): GateCorrectionAuthorityRef => {
    const bytes = Buffer.from(JSON.stringify(subject));
    const signed = Buffer.concat([Buffer.from('workrail-gate-correction-authority-v1\0'), bytes]);
    return ('gc1.' + bytes.toString('base64url') + '.' + Buffer.from(mac(signed, v2.tokenCodecPorts.keyring.current.keyBase64Url)).toString('base64url')) as GateCorrectionAuthorityRef;
  };
  const verify = (authority: GateCorrectionAuthorityRef): GateSubject | null => {
    try {
      const parts = authority.split('.');
      if (parts.length !== 3 || parts[0] !== 'gc1') return null;
      const bytes = Buffer.from(parts[1]!, 'base64url');
      const signature = Buffer.from(parts[2]!, 'base64url');
      const signed = Buffer.concat([Buffer.from('workrail-gate-correction-authority-v1\0'), bytes]);
      const keys = [v2.tokenCodecPorts.keyring.current, v2.tokenCodecPorts.keyring.previous].filter(key => key !== null);
      if (!keys.some(key => v2.tokenCodecPorts.hmac.timingSafeEqual(signature, mac(signed, key.keyBase64Url)))) return null;
      const parsed = SubjectSchema.safeParse(JSON.parse(bytes.toString()));
      return parsed.success ? subjectFrom(parsed.data) : null;
    } catch { return null; }
  };
  return {
    async inspectCorrectionTarget(token, signal) {
      if (unavailable(signal)) return { kind: 'cancelled', reason: 'operation_aborted' };
      const parsed = await parseContinueTokenOrFail(token, v2.tokenCodecPorts, v2.tokenAliasStore);
      if (parsed.isErr()) return { kind: 'refused', reason: 'invalid_token', detail: 'Invalid gate token' };
      const read = await readPending(parsed.value.sessionId, parsed.value.runId, parsed.value.nodeId);
      if (read.kind === 'unavailable') return { kind: 'refused', reason: 'storage_unavailable', detail: read.detail };
      if (read.kind !== 'found') return { kind: 'refused', reason: 'not_found', detail: 'Gate unavailable' };
      const p = read.value;
      const hash = deriveWorkflowHashRef(p.run.data.workflowHash);
      if (hash.isErr() || hash.value !== parsed.value.workflowHashRef) return { kind: 'refused', reason: 'invalid_token', detail: 'Token names another workflow' };
      const state = projectRunLifecycle(p.truth.events, p.subject.runId);
      if (state.kind === 'stopped') return { kind: 'cancelled', reason: 'session_cancelled' };
      if (state.kind === 'completed') return { kind: 'refused', reason: 'session_completed', detail: 'Run completed' };
      const decisions = p.truth.events.filter(e => e.kind === 'gate_resolution_recorded' && e.scope.runId === p.subject.runId && e.scope.nodeId === p.subject.gateNodeId);
      if (decisions.some(e => e.kind === 'gate_resolution_recorded' && e.data.decision.kind === 'approved')) return { kind: 'refused', reason: 'already_approved', detail: 'Gate approved' };
      if (p.truth.events.some(e => e.kind === 'edge_created' && e.scope.runId === p.subject.runId && e.data.fromNodeId === p.subject.gateNodeId)) return { kind: 'refused', reason: 'stale_revision', detail: 'Gate superseded' };
      if (unavailable(signal)) return { kind: 'cancelled', reason: 'operation_aborted' };
      const last = decisions.at(-1);
      return { kind: 'eligible', subject: p.subject, authority: issue(p.subject), priorDisposition: last?.kind === 'gate_resolution_recorded' && last.data.decision.kind !== 'approved' ? last.data.decision.kind : 'pending' };
    },
    async submitCorrection(authority, subject, output, signal) {
      const issued = verify(authority);
      if (!issued) return refused('invalid_authority', 'Invalid correction authority');
      if (subjectText(issued) !== subjectText(subject)) return refused(issued.sessionId === subject.sessionId && issued.runId === subject.runId && issued.gateNodeId === subject.gateNodeId ? 'stale_revision' : 'invalid_authority', 'Authority names another subject');
      if (unavailable(signal)) return { kind: 'cancelled', reason: 'operation_aborted' };
      const parsedOutput = OutputSchema.safeParse(output);
      if (!parsedOutput.success) return refused('validation_failed', 'Invalid correction output');
      const bytes = toCanonicalBytes(parsedOutput.data as unknown as JsonValue);
      if (bytes.isErr()) return refused('validation_failed', bytes.error.message);
      const digest = String(v2.sha256.sha256(bytes.value));
      const inputOutput = { notesMarkdown: parsedOutput.data.notesMarkdown,
        artifacts: parsedOutput.data.kind === 'artifacts' ? parsedOutput.data.artifacts : [] };
      let commitAttempted = false;
      const operation = v2.gate.withHealthySessionLock(subject.sessionId, lock => ResultAsync.fromPromise((async (): Promise<GateCorrectionResult> => {
        const read = await readPending(subject.sessionId, subject.runId, subject.gateNodeId);
        if (read.kind === 'unavailable') return refused('storage_unavailable', read.detail);
        if (read.kind !== 'found') return refused('stale_revision', 'Gate unavailable');
        const p = read.value;
        if (subjectText(p.subject) !== subjectText(subject)) return refused('stale_revision', 'Retained work changed');
        const existing = p.truth.events.find((e): e is CorrectionEvent => e.kind === 'gate_correction_recorded' && e.scope.runId === subject.runId && e.scope.nodeId === subject.gateNodeId);
        if (existing) return existing.data.outputDigest === digest ? fromEvent(existing, true) : refused('conflicting_correction', 'Different correction already committed');
        const state = projectRunLifecycle(p.truth.events, subject.runId);
        if (state.kind === 'stopped') return refused('session_cancelled', 'Run stopped');
        if (state.kind === 'completed') return refused('ineligible_gate_state', 'Run completed');
        if (p.truth.events.some(e => e.kind === 'gate_resolution_recorded' && e.scope.runId === subject.runId && e.scope.nodeId === subject.gateNodeId && e.data.decision.kind === 'approved')) return refused('ineligible_gate_state', 'Gate approved');
        if (p.truth.events.some(e => e.kind === 'edge_created' && e.scope.runId === subject.runId && e.data.fromNodeId === subject.gateNodeId)) return refused('stale_revision', 'Gate already advanced');
        const sorted = asSortedEventLog(p.truth.events);
        if (sorted.isErr()) return refused('storage_unavailable', sorted.error.message);
        const index = buildSessionIndex(sorted.value);
        const pinned = await v2.pinnedStore.get(p.run.data.workflowHash);
        if (pinned.isErr() || pinned.value?.sourceKind !== 'v1_pinned') return refused('storage_unavailable', 'Pinned workflow unavailable');
        const workflow = getCachedWorkflow(p.run.data.workflowHash, pinned.value.definition as WorkflowDefinition);
        const pendingStep = derivePendingStep(p.snapshot.enginePayload.engineState);
        if (!pendingStep) return refused('ineligible_gate_state', 'No pending step');
        const validated = validateAdvanceInputs({ truth: p.truth, runId: subject.runId, currentNodeId: subject.gateNodeId,
          inputContext: undefined, inputOutput, pinnedWorkflow: workflow, pendingStep, precomputedIndex: index });
        if (validated.isErr()) return refused('validation_failed', validated.error.kind);
        const v = validated.value;
        const evaluated = v.validationCriteria && v.notesMarkdown
          ? await withTimeout(new ValidationEngine(new EnhancedLoopValidator()).validate(v.notesMarkdown, v.validationCriteria, v.mergedContext as ConditionContext), 30_000, 'Correction validation') : undefined;
        if (evaluated?.isErr()) return refused('validation_failed', 'Validation could not complete');
        const validation = evaluated?.isOk() ? evaluated.value : undefined;
        const requirement = getOutputRequirementStatusWithArtifactsV1({ outputContract: v.outputContract, artifacts: v.artifacts,
          validationCriteria: v.validationCriteria, assessmentValidation: v.assessmentValidation?.validation, notesMarkdown: v.notesMarkdown, validation });
        if ((!v.notesOptional && !v.notesMarkdown?.trim()) || (validation && !validation.valid) ||
          (v.assessmentValidation && !v.assessmentValidation.validation.valid) || v.triggeredAssessmentConsequences.length ||
          (requirement.kind !== 'not_required' && requirement.kind !== 'satisfied')) return refused('validation_failed', 'Correction does not satisfy the pinned step');
        if (unavailable(signal)) return { kind: 'cancelled', reason: 'operation_aborted' };
        const hash = deriveWorkflowHashRef(p.run.data.workflowHash);
        if (hash.isErr()) return refused('storage_unavailable', hash.error.message);
        const receipt = String(v2.idFactory.mintEventId());
        let committed: CorrectionEvent | undefined;
        const appendStore = { append: (_lock: typeof lock, plan: Parameters<typeof v2.sessionStore.append>[1]) => {
          if (unavailable(signal)) return errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'Correction cancelled' });
          const next = plan.events.find(e => e.kind === 'node_created');
          if (next?.kind !== 'node_created') return errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'No corrected gate' });
          const correctedEvents = plan.events.map(e => e.kind === 'node_output_appended' ? { ...e, scope: { ...e.scope, nodeId: next.scope.nodeId } } : e);
          const outputs = correctedEvents.filter((e): e is Extract<DomainEventV1, { kind: 'node_output_appended' }> => e.kind === 'node_output_appended');
          const revision = gateWorkRevision(v2, next.data.snapshotRef, outputs);
          if (revision.isErr()) return errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: revision.error.message });
          const newSubject = { ...subject, gateNodeId: asNodeId(next.scope.nodeId), workRevision: revision.value };
          return mintSingleShortToken({ kind: 'continue', entry: { sessionId: subject.sessionId, runId: subject.runId, nodeId: newSubject.gateNodeId,
            attemptId: String(v2.idFactory.mintAttemptId()), workflowHashRef: String(hash.value) }, ports: v2.tokenCodecPorts,
            aliasStore: v2.tokenAliasStore, entropy: v2.entropy }).mapErr(error => ({ code: 'SESSION_STORE_IO_ERROR' as const, message: error.message }))
            .andThen(reviewGateToken => {
              if (unavailable(signal)) return errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'Correction cancelled' });
              committed = { v: 1, eventId: receipt, sessionId: subject.sessionId, eventIndex: index.nextEventIndex + plan.events.length,
                timestampMs: Date.now(), kind: 'gate_correction_recorded', dedupeKey: 'gate_correction:' + subject.gateNodeId,
                scope: { runId: subject.runId, nodeId: subject.gateNodeId }, data: { receipt, outputDigest: digest, reviewGateToken, priorSubject: subject, newSubject } };
              commitAttempted = true;
              return v2.sessionStore.append(lock, { ...plan, events: [...correctedEvents, committed] }, p.truth);
            });
        } };
        const result = await buildGateCheckpointOutcome({ snap: p.snapshot, validated: { ...v,
          mergedContext: p.snapshot.enginePayload.gateCheckpoint?.acceptedContext ?? v.mergedContext, inputContextObj: undefined },
          stepId: subject.stepId, gateKind: p.snapshot.enginePayload.gateCheckpoint!.gateKind === 'human_approval' ? 'human_approval' : 'coordinator_eval', lock, lockedIndex: index,
          ctx: { truth: p.truth, sessionId: subject.sessionId, runId: subject.runId, currentNodeId: subject.gateNodeId,
            attemptId: v2.idFactory.mintAttemptId(), workflowHash: p.run.data.workflowHash, inputOutput, pinnedWorkflow: workflow,
            engineState: p.snapshot.enginePayload.engineState, pendingStep },
          ports: { ...v2, gitSnapshot: v2.gitSnapshot ?? new NullGitSnapshotV2(), sessionStore: appendStore } });
        if (result.isErr() || !committed) return commitAttempted ? { kind: 'unconfirmed', reason: 'commit_uncertain' } : unavailable(signal) ? { kind: 'cancelled', reason: 'operation_aborted' } : refused('storage_unavailable', 'Correction preparation failed');
        if (faultSeam && await faultSeam.afterCommit(subjectFrom(committed.data.newSubject), signal) === 'suppress_acknowledgement') return { kind: 'unconfirmed', reason: 'commit_uncertain' };
        return fromEvent(committed, false);
      })(), (): GateCorrectionResult => commitAttempted ? { kind: 'unconfirmed', reason: 'commit_uncertain' } : refused('storage_unavailable', 'Correction I/O failed')).orElse(error => okAsync(error)))
        .match(value => value, error => refused('storage_unavailable', error.message));
      active.add(operation);
      try { return await operation; } finally { active.delete(operation); }
    },
    async close(signal) {
      closed = true;
      if (signal.aborted) return { kind: 'incomplete', reason: 'cancelled', detail: 'Close cancelled' };
      if (active.size) return { kind: 'incomplete', reason: 'work_in_flight', detail: 'Correction still settling' };
      return { kind: 'closed' };
    },
  };
};
