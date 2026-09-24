import { foldSupervisor } from './supervisor-state.js';
import type { AnswerEngine } from './engine-composition.js';
import type { AnswerHostRecord } from '../v2/durable-core/schemas/session/answer-host.js';
import type { DomainEventV1 } from '../v2/durable-core/schemas/session/index.js';
import type { LoadedSessionTruthV2 } from '../v2/ports/session-event-log-store.port.js';
import type { HostEnrollment, OwnerFence } from './contracts/invocation-contract.js';
import type { WorkView, ReadRef, ReplyRef, ReceiptRef, InspectionView } from './contracts/answer-contract.js';
import { asSessionId, asRunId, asNodeId } from '../v2/durable-core/ids/index.js';
import { getCachedWorkflow } from '../v2/usecases/workflow-object-cache.js';
import { hasWorkflowDefinitionShape } from '../types/workflow-definition.js';
import { derivePendingStep } from '../v2/durable-core/projections/snapshot-state.js';
import { renderPendingPrompt } from '../v2/durable-core/domain/prompt-renderer.js';
export type HostEvent = Extract<DomainEventV1, {
    kind: 'answer_host_recorded';
}>;
export type HostState = Readonly<{
    truth: LoadedSessionTruthV2;
    mode: 'host_bound' | 'unbound';
    enrollment: HostEnrollment;
    run: Extract<DomainEventV1, {
        kind: 'run_started';
    }>;
    records: readonly AnswerHostRecord[];
    node: string;
    epoch: bigint;
    owned: boolean;
}>;
export type StateResult = {
    readonly kind: 'loaded';
    readonly state: HostState;
} | {
    readonly kind: 'unavailable';
    readonly reason: 'missing' | 'corrupt' | 'unsupported_version' | 'storage_unavailable';
    readonly detail: string;
};
export async function readHostState(engine: AnswerEngine, enrollment: HostEnrollment): Promise<StateResult> {
    if (!/^sess_[a-z0-9]+$/.test(enrollment.execution))
        return { kind: 'unavailable', reason: 'corrupt', detail: 'Invalid execution locator' };
    const loaded = await engine.sessionStore.load(asSessionId(enrollment.execution));
    if (loaded.isErr())
        return { kind: 'unavailable',
            reason: loaded.error.code === 'SESSION_STORE_CORRUPTION_DETECTED'
                ? loaded.error.reason.code === 'unknown_schema_version' ? 'unsupported_version' : 'corrupt'
                : 'storage_unavailable', detail: loaded.error.message };
    const events = loaded.value.events.filter((e): e is HostEvent => e.kind === 'answer_host_recorded');
    const entries = events.filter(e => e.data.kind === 'enrolled');
    const entry = entries[0];
    if (entries.length !== 1 || entry?.data.kind !== 'enrolled' || entry.data.recovery !== enrollment.recovery)
        return { kind: 'unavailable', reason: 'missing', detail: 'Unknown enrollment' };
    const run = loaded.value.events.find((e): e is HostState['run'] => e.kind === 'run_started' && e.scope.runId === entry.scope.runId);
    if (!run)
        return { kind: 'unavailable', reason: 'corrupt', detail: 'Missing engine run' };
    const records = events.filter(e => e.scope.runId === run.scope.runId).map(e => e.data);
    const supervisor = foldSupervisor(records);
    if (supervisor.kind === 'invalid')
        return { kind: 'unavailable', reason: 'corrupt', detail: `Invalid supervisor history at record ${supervisor.recordIndex}: ${supervisor.reason}` };
    const owner = [...records].reverse().find(e => e.kind === 'owner_acquired' || e.kind === 'owner_released');
    const committed = [...records].reverse().find(e => e.kind === 'committed');
    return { kind: 'loaded', state: { truth: loaded.value, mode: entry.data.mode, enrollment, run, records,
            node: committed?.kind === 'committed' ? committed.successorNode : entry.data.initialNode,
            epoch: owner ? BigInt(owner.epoch) : 0n, owned: owner?.kind === 'owner_acquired' } };
}
export function owns(state: HostState, owner: OwnerFence): boolean {
    return state.owned && owner.execution === state.enrollment.execution && owner.epoch === state.epoch;
}
export function hostEvent(engine: AnswerEngine, state: Pick<HostState, 'enrollment' | 'run'>, data: AnswerHostRecord, index: number): HostEvent {
    const eventId = engine.idFactory.mintEventId();
    return { v: 1, kind: 'answer_host_recorded', sessionId: state.enrollment.execution, scope: { runId: state.run.scope.runId },
        eventId, eventIndex: index, timestampMs: Date.now(), dedupeKey: `answer_host:${state.enrollment.execution}:${index}`, data };
}
export function capability(engine: AnswerEngine, state: Pick<HostState, 'enrollment' | 'run'>, role: string, ref = ''): string {
    const bytes = Buffer.from(JSON.stringify(['answer-host-v1', state.enrollment.execution, state.run.scope.runId, role, ref]));
    const signature = engine.tokenCodecPorts.hmac.hmacSha256(Buffer.from(engine.tokenCodecPorts.keyring.current.keyBase64Url, 'base64url'), bytes);
    return `ah1.${state.enrollment.execution}.${Buffer.from(signature).toString('base64url')}`;
}
export function inspection(view: WorkView): InspectionView {
    if (view.kind !== 'question')
        return view;
    const { reply: _reply, ...readonly } = view;
    return readonly;
}
export async function workView(engine: AnswerEngine, state: HostState, node = state.node): Promise<WorkView | {
    kind: 'unavailable';
    detail: string;
}> {
    const read = capability(engine, state, 'read') as ReadRef;
    const retained = state.records.flatMap(r => r.kind === 'committed' || r.kind === 'rejected' ? [{ receipt: r.receipt as ReceiptRef, description: 'Retained answer' }] : []);
    const stopped = state.records.find(r => r.kind === 'stopped');
    if (stopped?.kind === 'stopped')
        return { kind: 'finished', read, retained, execution: { kind: 'incomplete', reason: stopped.reason, detail: stopped.detail }, taskOutcome: 'unknown' };
    const event = state.truth.events.find(e => e.kind === 'node_created' && e.scope.nodeId === node && e.scope.runId === state.run.scope.runId);
    if (event?.kind !== 'node_created')
        return { kind: 'unavailable', detail: 'Missing current engine node' };
    const snapshot = await engine.snapshotStore.getExecutionSnapshotV1(event.data.snapshotRef);
    if (snapshot.isErr() || !snapshot.value)
        return { kind: 'unavailable', detail: 'Missing engine snapshot' };
    const pending = derivePendingStep(snapshot.value.enginePayload.engineState);
    if (!pending) {
        if (!state.truth.events.some(e => e.kind === 'run_completed' && e.scope.runId === state.run.scope.runId))
            return { kind: 'unavailable', detail: 'Engine neither pending nor completed' };
        return { kind: 'finished', read, retained, execution: { kind: 'completed' }, taskOutcome: 'unknown' };
    }
    const pinned = await engine.pinnedStore.get(state.run.data.workflowHash);
    if (pinned.isErr() || pinned.value?.sourceKind !== 'v1_pinned' || !hasWorkflowDefinitionShape(pinned.value.definition))
        return { kind: 'unavailable', detail: 'Missing pinned workflow' };
    const workflow = getCachedWorkflow(state.run.data.workflowHash, pinned.value.definition);
    const rendered = renderPendingPrompt({ workflow, stepId: pending.stepId, loopPath: pending.loopPath, truth: state.truth, runId: asRunId(state.run.scope.runId), nodeId: asNodeId(node), rehydrateOnly: false, cleanResponseFormat: true });
    if (rendered.isErr())
        return { kind: 'unavailable', detail: rendered.error.message };
    const rejected = [...state.records].reverse().find(r => r.kind === 'rejected');
    const lastResult = [...state.records].reverse().find(r => r.kind === 'rejected' || r.kind === 'committed');
    const issues = lastResult?.kind === 'rejected' ? [{ kind: 'field' as const, field: 'notes' as const, reason: lastResult.reason }] : [];
    const revision = rejected?.kind === 'rejected' ? rejected.receipt : '';
    return { kind: 'question', read, reply: capability(engine, state, 'reply', node + ':' + revision) as ReplyRef, instruction: rendered.value.prompt, issues, retained };
}
