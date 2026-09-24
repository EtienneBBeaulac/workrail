import type { ExecutionSessionGateErrorV2 } from '../v2/usecases/execution-session-gate.js';
import { AnswerJsonSchema } from './answer-json.js';
import { toCanonicalBytes } from '../v2/durable-core/canonical/jcs.js';
import { ResultAsync, okAsync } from 'neverthrow';
import { z } from 'zod';
import type { AnswerEngine } from './engine-composition.js';
import { capability, hostEvent, inspection, owns, readHostState, workView, type HostState } from './host-state.js';
import type { AnswerHostRecord } from '../v2/durable-core/schemas/session/answer-host.js';
import type { WithHealthySessionLock } from '../v2/durable-core/ids/with-healthy-session-lock.js';
import { asSessionId } from '../v2/durable-core/ids/index.js';
import type { DurableJournalFaultSeam, JournalFaultBoundary } from './contracts/host-composition.js';
import type { InvocationJournal, HostEnrollment, OwnerFence, DeliveryRef, CapturedResponse, ResponseRef, PreparedAnswer, InvocationRef, AppendDeliveryResult, CaptureResult, PrepareResult, RecoveryResult, CommitStopResult, RedeliverResult } from './contracts/invocation-contract.js';
import type { ReplyRef, ReceiptRef } from './contracts/answer-contract.js';
import { CapturePolicy, decodeResponse, decideCapture } from './response-capture.js';
const policy = CapturePolicy.parse({ maxBytes: 1024 * 1024 });
const NotesAnswer = z.object({ answer: z.object({ notes: z.string().min(1) }).strict() }).strict();
/** Any uncaptured model work requires explicit reconciliation, even if a newer
 * delivery exists. A completed effect does not make the missing answer replayable. */
function hasUncapturedModelWork(records: readonly AnswerHostRecord[]): boolean {
    const captured = new Set(records.flatMap(r => r.kind === 'captured' ? [r.delivery] : []));
    return records.some(r => r.kind === 'model_call_reserved' && !captured.has(r.delivery));
}
export type PreparedRecord = Extract<AnswerHostRecord, {
    kind: 'prepared';
}>;
export function preparedAnswer(state: HostState, record: PreparedRecord): PreparedAnswer {
    const delivery = state.records.find(r => r.kind === 'delivered' && r.delivery === record.delivery);
    return { execution: state.enrollment.execution, delivery: record.delivery as DeliveryRef, response: record.response as ResponseRef,
        invocation: record.invocation as InvocationRef, toolCallId: record.toolCallId,
        reply: (delivery?.kind === 'delivered' ? delivery.reply : '') as ReplyRef,
        answer: { kind: 'notes', notes: record.notes } } as PreparedAnswer;
}
export type JournalConfig = Readonly<{ faultSeam?: DurableJournalFaultSeam }>;

export class SessionJournal implements InvocationJournal {
    readonly config: JournalConfig;
    constructor(readonly engine: AnswerEngine, readonly enrollment: HostEnrollment, config: JournalConfig, readonly available: (signal: AbortSignal) => boolean) {
        // Journal and cleanup capabilities do not need to retain inference dependencies.
        this.config = Object.freeze(config.faultSeam ? { faultSeam: config.faultSeam } : {});
    }
    async locked<T>(signal: AbortSignal, failure: T, fn: (state: HostState, lock: WithHealthySessionLock) => Promise<T>, gateFailure?: (error: ExecutionSessionGateErrorV2) => T): Promise<T> {
        if (!this.available(signal))
            return failure;
        return this.engine.gate.withHealthySessionLock(asSessionId(this.enrollment.execution), lock => ResultAsync.fromPromise((async () => {
            const loaded = await readHostState(this.engine, this.enrollment);
            if (loaded.kind !== 'loaded' || !this.available(signal))
                return failure;
            return fn(loaded.state, lock);
        })(), () => failure).orElse(value => okAsync(value))).match(value => value, error => gateFailure ? gateFailure(error) : failure);
    }
    async fault(boundary: JournalFaultBoundary, signal: AbortSignal): Promise<boolean> {
        if (!this.available(signal))
            return false;
        const action = await this.config.faultSeam?.intercept(boundary, this.enrollment.execution, signal);
        return this.available(signal) && (action === undefined || action.kind === 'proceed');
    }
    async append(state: HostState, lock: WithHealthySessionLock, data: AnswerHostRecord, signal: AbortSignal): Promise<boolean> {
        if (!this.available(signal))
            return false;
        const result = await this.engine.sessionStore.append(lock, { events: [hostEvent(this.engine, state, data, state.truth.events.length)], snapshotPins: [] }, state.truth);
        return result.isOk();
    }
    async appendDelivery(reply: ReplyRef, owner: OwnerFence, signal: AbortSignal): Promise<AppendDeliveryResult> {
        if (!await this.fault('before_delivery_append', signal))
            return { kind: 'refused', reason: 'storage_unavailable' };
        const result = await this.locked<AppendDeliveryResult>(signal, { kind: 'refused', reason: 'storage_unavailable' }, async (state, lock) => {
            if (!owns(state, owner))
                return { kind: 'stale_owner' };
            if (state.records.some(r => r.kind === 'stopped'))
                return { kind: 'refused', reason: 'stopped' };
            if (hasUncapturedModelWork(state.records))
                return {kind:'refused',reason:'reconciliation_required'};
            const view = await workView(this.engine, state);
            if (view.kind !== 'question' || view.reply !== reply)
                return { kind: 'refused', reason: 'stale_reply' };
            const old = [...state.records].reverse().find(r => r.kind === 'delivered' && r.reply === reply);
            if (old?.kind === 'delivered')
                return { kind: 'delivered', delivery: old.delivery as DeliveryRef };
            const delivery = this.engine.idFactory.mintEventId() as DeliveryRef;
            return await this.append(state, lock, { kind: 'delivered', delivery, node: state.node, reply, epoch: owner.epoch.toString() }, signal)
                ? { kind: 'delivered', delivery } : { kind: 'unconfirmed', reason: 'commit_uncertain' };
        });
        return result.kind === 'delivered' && !await this.fault('after_delivery_append', signal) ? { kind: 'unconfirmed', reason: 'commit_uncertain' } : result;
    }
    async redeliver(oldDelivery: DeliveryRef, reply: ReplyRef, owner: OwnerFence, signal: AbortSignal): Promise<RedeliverResult> {
        return this.locked<RedeliverResult>(signal, { kind: 'refused', reason: 'storage_unavailable' }, async (state, lock) => {
            if (!owns(state, owner))
                return { kind: 'stale_owner' };
            if (state.records.some(r => r.kind === 'stopped'))
                return { kind: 'refused', reason: 'stopped' };
            if (hasUncapturedModelWork(state.records))
                return {kind:'refused',reason:'reconciliation_required'};
            if (state.records.some(r => r.kind === 'captured' && r.delivery === oldDelivery))
                return { kind: 'refused', reason: 'already_captured' };
            const old = [...state.records].reverse().find(r => r.kind === 'delivered');
            const view = await workView(this.engine, state);
            if (old?.kind !== 'delivered' || old.delivery !== oldDelivery || view.kind !== 'question' || view.reply !== reply)
                return { kind: 'refused', reason: 'stale_reply' };
            const delivery = this.engine.idFactory.mintEventId() as DeliveryRef;
            return await this.append(state, lock, { kind: 'delivered', delivery, node: state.node, reply, epoch: owner.epoch.toString() }, signal)
                ? { kind: 'delivered', delivery } : { kind: 'unconfirmed', reason: 'commit_uncertain' };
        });
    }
    async captureResponse(delivery: DeliveryRef, raw: unknown, owner: OwnerFence, signal: AbortSignal): Promise<CaptureResult> {
        const decoded = decodeResponse(raw, policy);
        if (decoded.kind === 'refused')
            return { kind: 'refused', reason: decoded.reason === 'invalid_payload' ? 'invalid_delivery' : decoded.reason };
        if (!await this.fault('before_capture_append', signal))
            return { kind: 'refused', reason: 'storage_unavailable' };
        const result = await this.locked<CaptureResult>(signal, { kind: 'refused', reason: 'storage_unavailable' }, async (state, lock) => {
            if (!owns(state, owner))
                return { kind: 'stale_owner' };
            if (state.records.some(r => r.kind === 'stopped'))
                return { kind: 'refused', reason: 'stopped' };
            const delivered = state.records.find(r => r.kind === 'delivered' && r.delivery === delivery);
            if (delivered?.kind !== 'delivered')
                return { kind: 'refused', reason: 'invalid_delivery' };
            const previous = state.records.find(r => r.kind === 'captured' && r.delivery === delivery);
            if (previous?.kind === 'captured') {
                const prior = decodeResponse(previous.payload, policy);
                if (prior.kind !== 'decoded')
                    return { kind: 'refused', reason: 'storage_unavailable' };
                const decision = decideCapture({ kind: 'captured', payload: prior.payload }, decoded.payload);
                if (decision.kind === 'refused')
                    return decision;
                return { kind: 'captured', response: { execution: this.enrollment.execution, delivery, response: previous.response as ResponseRef } as CapturedResponse };
            }
            const latest = [...state.records].reverse().find(r => r.kind === 'delivered');
            const view = await workView(this.engine, state);
            if (latest?.kind !== 'delivered' || latest.delivery !== delivery || view.kind !== 'question' || view.reply !== delivered.reply)
                return { kind: 'refused', reason: 'invalid_delivery' };
            const response = this.engine.idFactory.mintEventId() as ResponseRef;
            return await this.append(state, lock, { kind: 'captured', delivery, response, payload: decoded.payload }, signal)
                ? { kind: 'captured', response: { execution: this.enrollment.execution, delivery, response } as CapturedResponse }
                : { kind: 'unconfirmed', reason: 'commit_uncertain' };
        });
        return result.kind === 'captured' && !await this.fault('after_capture_append', signal) ? { kind: 'unconfirmed', reason: 'commit_uncertain' } : result;
    }
    async prepare(response: CapturedResponse, owner: OwnerFence, signal: AbortSignal): Promise<PrepareResult> {
        if (!await this.fault('before_prepare_commit', signal))
            return { kind: 'unconfirmed', reason: 'storage_unavailable' };
        const result = await this.locked<PrepareResult>(signal, { kind: 'unconfirmed', reason: 'storage_unavailable' }, async (state, lock) => {
            if (!owns(state, owner))
                return { kind: 'refused', reason: 'stale_owner' };
            if (state.records.some(r => r.kind === 'stopped'))
                return { kind: 'refused', reason: 'stopped' };
            const captured = state.records.find(r => r.kind === 'captured' && r.response === response.response && r.delivery === response.delivery);
            if (response.execution !== this.enrollment.execution || captured?.kind !== 'captured')
                return { kind: 'refused', reason: 'invalid_delivery' };
            const old = state.records.find(r => r.kind === 'prepared' && r.response === response.response);
            if (old?.kind === 'prepared')
                return { kind: 'prepared', answer: preparedAnswer(state, old) };
            const rejection = state.records.find(r => r.kind === 'rejected' && r.response === response.response);
            if (rejection?.kind === 'rejected') {
                const view = await workView(this.engine, state);
                return view.kind === 'unavailable' ? { kind: 'unconfirmed', reason: 'storage_unavailable' } : { kind: 'rejected', receipt: rejection.receipt as ReceiptRef, view };
            }
            const delivered = state.records.find(r => r.kind === 'delivered' && r.delivery === response.delivery);
            const view = await workView(this.engine, state);
            if (delivered?.kind !== 'delivered' || view.kind !== 'question' || view.reply !== delivered.reply)
                return { kind: 'refused', reason: 'invalid_delivery' };
            const call = captured.payload.calls.find(c => c.name === 'answer_work');
            let input: unknown;
            try {
                input = call ? JSON.parse(call.argumentsJson) : undefined;
            }
            catch {
                input = undefined;
            }
            const answer = NotesAnswer.safeParse(input);
            if (!answer.success || !call) {
                const receipt = this.engine.idFactory.mintEventId() as ReceiptRef;
                const envelope = z.object({ answer: AnswerJsonSchema }).safeParse(input);
                const canonical = envelope.success ? toCanonicalBytes(envelope.data.answer) : undefined;
                const evidence = canonical?.isOk() ? { encoding: 'canonical_json' as const, rawAnswer: Buffer.from(canonical.value).toString('utf8') } : { encoding: 'raw_utf8' as const, rawAnswer: call?.argumentsJson ?? captured.payload.responseText };
                const record: AnswerHostRecord = { kind: 'rejected', delivery: response.delivery, response: response.response, receipt, reason: 'Provide answer_work with a nonempty notes answer.', ...evidence };
                if (!await this.append(state, lock, record, signal))
                    return { kind: 'unconfirmed', reason: 'commit_uncertain' };
                const next = await readHostState(this.engine, this.enrollment);
                const correction = next.kind === 'loaded' ? await workView(this.engine, next.state) : undefined;
                return correction && correction.kind !== 'unavailable' ? { kind: 'rejected', receipt, view: correction } : { kind: 'unconfirmed', reason: 'commit_uncertain' };
            }
            const record: PreparedRecord = { kind: 'prepared', delivery: response.delivery, response: response.response, invocation: this.engine.idFactory.mintEventId(), toolCallId: call.id, notes: answer.data.answer.notes };
            return await this.append(state, lock, record, signal) ? { kind: 'prepared', answer: preparedAnswer(state, record) } : { kind: 'unconfirmed', reason: 'commit_uncertain' };
        });
        return (result.kind === 'prepared' || result.kind === 'rejected') && !await this.fault('after_prepare_commit', signal) ? { kind: 'unconfirmed', reason: 'commit_uncertain' } : result;
    }
    async commitStop(owner: OwnerFence, reason: 'cancelled' | 'gate_rejected' | 'timeout' | 'failed', detail: string, signal: AbortSignal): Promise<CommitStopResult> {
        if (!await this.fault('before_stop_commit', signal))
            return { kind: 'refused', reason: 'storage_unavailable' };
        const result = await this.locked<CommitStopResult>(signal, { kind: 'refused', reason: 'storage_unavailable' }, async (state, lock) => {
            if (!owns(state, owner))
                return { kind: 'stale_owner' };
            if (state.records.some(r => r.kind === 'stopped'))
                return { kind: 'stopped', execution: this.enrollment.execution };
            const view = await workView(this.engine, state);
            if (view.kind === 'finished')
                return { kind: 'refused', reason: 'already_finished' };
            return await this.append(state, lock, { kind: 'stopped', reason, detail }, signal) ? { kind: 'stopped', execution: this.enrollment.execution } : { kind: 'unconfirmed', reason: 'commit_uncertain' };
        });
        return result.kind === 'stopped' && !await this.fault('after_stop_commit', signal) ? { kind: 'unconfirmed', reason: 'commit_uncertain' } : result;
    }
    async recover(enrollment: HostEnrollment, owner: OwnerFence, signal: AbortSignal): Promise<RecoveryResult> {
        if (enrollment.execution !== this.enrollment.execution || enrollment.recovery !== this.enrollment.recovery)
            return { kind: 'refused', reason: 'missing' };
        return this.locked<RecoveryResult>(signal, { kind: 'refused', reason: 'storage_unavailable' }, async (state) => {
            if (!owns(state, owner))
                return { kind: 'refused', reason: 'stale_owner' };
            if (state.records.some(r => r.kind === 'stopped'))
                return { kind: 'refused', reason: 'stopped' };
            if (hasUncapturedModelWork(state.records))
                return {kind:'refused',reason:'reconciliation_required'};
            const view = await workView(this.engine, state);
            if (view.kind === 'unavailable')
                return { kind: 'refused', reason: 'storage_unavailable' };
            const lastCommit = [...state.records].reverse().find(r => r.kind === 'committed');
            if (view.kind === 'finished' && lastCommit?.kind === 'committed')
                return { kind: 'settled', result: { kind: 'replay', receipt: lastCommit.receipt as ReceiptRef, original: inspection(view) }, view };
            if (view.kind !== 'question')
                return { kind: 'refused', reason: 'corrupt' };
            const delivery = [...state.records].reverse().find(r => r.kind === 'delivered' && r.reply === view.reply);
            if (delivery?.kind !== 'delivered')
                return { kind: 'deliver', view };
            const captured = state.records.find(r => r.kind === 'captured' && r.delivery === delivery.delivery);
            if (captured?.kind !== 'captured')
                return { kind: 'redeliver', oldDelivery: delivery.delivery as DeliveryRef, view };
            const prepared = state.records.find(r => r.kind === 'prepared' && r.response === captured.response);
            if (prepared?.kind === 'prepared')
                return { kind: 'replay', answer: preparedAnswer(state, prepared) };
            return { kind: 'prepare_response', response: { execution: this.enrollment.execution, delivery: delivery.delivery as DeliveryRef, response: captured.response as ResponseRef } as CapturedResponse };
        });
    }
}
