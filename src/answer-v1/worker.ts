import { createAnswerRuntime } from './host.js';
import { composeAnswerEngine } from './engine-composition.js';
import { readHostState, workView, capability, inspection } from './host-state.js';
import { asSessionId } from '../v2/durable-core/ids/index.js';
import type { AnswerWorkerConfig, CreateAnswerWorkerResult, PersistedHostPointer } from './contracts/host-composition.js';
import type { HostEnrollment, ExecutionRef, OwnerFence } from './contracts/invocation-contract.js';
import type { RecoveryRef, OpenAttemptRef, OpenResult, ReceiptRef } from './contracts/answer-contract.js';
/** Worker authority is fixed at composition and checked against durable enrollment mode. */
export async function createAnswerWorker(config: AnswerWorkerConfig, lifetime: AbortSignal): Promise<CreateAnswerWorkerResult> {
    const runtime = await createAnswerRuntime({ ...config, model: { async generate() { return { kind: 'unavailable', detail: 'Unbound workers do not invoke a model' }; } } }, lifetime, 'unbound');
    if (runtime.kind !== 'created')
        return runtime;
    const composition = await composeAnswerEngine(config);
    if (composition.kind !== 'ready') {
        await runtime.scheduler.close(new AbortController().signal);
        return { kind: 'refused', reason: 'storage_unavailable', detail: composition.detail };
    }
    const engine = composition;
    const scheduler = runtime.scheduler;
    let closed = false;
    const operations = new Set<Promise<unknown>>();
    const track = async <T>(operation: Promise<T>): Promise<T> => { operations.add(operation); try {
        return await operation;
    }
    finally {
        operations.delete(operation);
    } };
    const live = (signal: AbortSignal) => !closed && !signal.aborted && !lifetime.aborted;
    type Lookup = {kind:'loaded';state:import('./host-state.js').HostState}|{kind:'invalid_reference'}|{kind:'unavailable';reason:string};
    async function stateFor(ref: string, signal: AbortSignal):Promise<Lookup> {
        if (!live(signal))
            return {kind:'unavailable',reason:'cancelled'};
        const parts = ref.split('.');
        if (parts.length !== 3 || !['ah1', 'wr1', 'wa1'].includes(parts[0]!) || !/^sess_[a-z0-9]+$/.test(parts[1]!))
            return {kind:'invalid_reference'};
        const truth = await engine.sessionStore.load(asSessionId(parts[1]!));
        if (truth.isErr())
            return {kind:'unavailable',reason:'storage_unavailable'};
        const enrollment = truth.value.events.find(e => e.kind === 'answer_host_recorded' && e.data.kind === 'enrolled');
        if (enrollment?.kind !== 'answer_host_recorded' || enrollment.data.kind !== 'enrolled')
            return {kind:'unavailable',reason:'missing'};
        const identity = { execution: parts[1] as ExecutionRef, recovery: enrollment.data.recovery as RecoveryRef } as HostEnrollment;
        const loaded = await readHostState(engine, identity);
        return loaded.kind === 'loaded' ? {kind:'loaded',state:loaded.state} : {kind:'unavailable',reason:loaded.reason};
    }
    function recovery(pointer: PersistedHostPointer): RecoveryRef { return `wr1.${pointer.executionId}.${pointer.recoveryLocator}` as RecoveryRef; }
    async function reconcile(ref: string, signal: AbortSignal): Promise<OpenResult | {
        kind: 'invalid_attempt';
    }> {
        const lookup = await stateFor(ref, signal);
        if(lookup.kind==='invalid_reference')return {kind:'invalid_attempt'};
        if(lookup.kind==='unavailable')return {kind:'unconfirmed',reason:'commit_uncertain',attempt:ref as OpenAttemptRef};
        const state=lookup.state;
        if (state.mode !== 'unbound' || ref.split('.')[2] !== state.enrollment.recovery)
            return { kind: 'invalid_attempt' };
        const view = await workView(engine, state);
        return view.kind === 'unavailable' ? { kind: 'refused', reason: 'storage_unavailable', detail: view.detail } : { kind: 'opened', recovery: recovery(scheduler.hydrator.dehydrate(state.enrollment)), view };
    }
    const worker: Extract<CreateAnswerWorkerResult, {
        kind: 'created';
    }> = {
        kind: 'created',
        opener: { open: (request, signal) => track((async () => {
                if (!live(signal))
                    return { kind: 'refused' as const, reason: 'storage_unavailable' as const, detail: 'Worker unavailable' };
                const result = await scheduler.enroll(request, signal);
                if (result.kind === 'enrolled')
                    return { kind: 'opened' as const, recovery: recovery(scheduler.hydrator.dehydrate(result.enrollment)), view: result.initialView };
                if (result.kind === 'unconfirmed')
                    return { kind: 'unconfirmed' as const, reason: 'commit_uncertain' as const, attempt: `wa1.${result.pointer.executionId}.${result.pointer.recoveryLocator}` as OpenAttemptRef };
                return result.reason === 'unsupported_workflow' ? { kind: 'unsupported_workflow' as const, message: result.detail } : { kind: 'refused' as const, reason: result.reason, detail: result.detail };
            })()) },
        worker: { answer: (reply, answer, signal) => track((async () => {
                const lookup = await stateFor(reply, signal);
                if(lookup.kind==='invalid_reference')return {kind:'not_retained' as const,reason:'invalid_reference' as const};
                if(lookup.kind==='unavailable')return {kind:'unconfirmed' as const,reason:'commit_uncertain' as const};
                const state=lookup.state;
                if (state.mode !== 'unbound')
                    return { kind: 'not_retained' as const, reason: 'bound_session_required' as const };
                const view = await workView(engine, state);
                if (view.kind === 'unavailable')
                    return { kind: 'not_retained' as const, reason: 'unavailable_storage' as const };
                const old = state.records.find(r => r.kind === 'delivered' && r.reply === reply);
                if (!old && (view.kind !== 'question' || view.reply !== reply))
                    return { kind: 'not_retained' as const, reason: 'invalid_reference' as const };
                const owner = { execution: state.enrollment.execution, epoch: state.epoch } as OwnerFence;
                const ports = scheduler.bindDiagnosticPorts(state.enrollment);
                const delivery = old?.kind === 'delivered' ? { kind: 'delivered' as const, delivery: old.delivery as import('./contracts/invocation-contract.js').DeliveryRef } : await ports.journal.appendDelivery(reply, owner, signal);
                if (delivery.kind === 'unconfirmed')
                    return { kind: 'unconfirmed' as const, reason: 'commit_uncertain' as const };
                if (delivery.kind !== 'delivered')
                    return { kind: 'not_retained' as const, reason: 'unavailable_storage' as const };
                const payload = answer.kind === 'unvalidated_json' ? answer.value
                    : answer.kind === 'notes' ? { notes: answer.notes } : answer;
                const captured = await ports.journal.captureResponse(delivery.delivery, { responseText: '', calls: [{ id: 'answer', name: 'answer_work', argumentsJson: JSON.stringify({ answer: payload }) }] }, owner, signal);
                if (captured.kind === 'unconfirmed')
                    return { kind: 'unconfirmed' as const, reason: 'commit_uncertain' as const };
                if (captured.kind !== 'captured') {
                    const current=await readHostState(engine,state.enrollment);
                    if(current.kind!=='loaded')return {kind:'unconfirmed' as const,reason:'commit_uncertain' as const};
                    const currentView=await workView(engine,current.state);
                    if(currentView.kind==='unavailable')return {kind:'unconfirmed' as const,reason:'commit_uncertain' as const};
                    const priorCapture = current.state.records.find(r => r.kind === 'captured' && r.delivery === delivery.delivery);
                    const priorPrepared = priorCapture?.kind === 'captured' ? current.state.records.find(r => r.kind === 'prepared' && r.response === priorCapture.response) : undefined;
                    const prior = current.state.records.find(r => (r.kind === 'committed' && priorPrepared?.kind === 'prepared' && r.invocation === priorPrepared.invocation) || (r.kind === 'rejected' && r.delivery === delivery.delivery));
                    if (captured.kind === 'refused' && captured.reason === 'conflict' && prior && (prior.kind === 'committed' || prior.kind === 'rejected'))
                        return { kind: 'conflict' as const, original: prior.receipt as ReceiptRef, current: inspection(currentView) };
                    return captured.kind==='refused'&&captured.reason==='payload_too_large'
                      ? {kind:'not_retained' as const,reason:'capture_limit' as const}
                      : {kind:'unconfirmed' as const,reason:'commit_uncertain' as const};
                }
                const prepared = await ports.journal.prepare(captured.response, owner, signal);
                if (prepared.kind === 'rejected')
                    return { kind: 'recorded' as const, receipt: prepared.receipt, disposition: 'rejected' as const, view: prepared.view };
                if (prepared.kind !== 'prepared')
                    return { kind: 'unconfirmed' as const, reason: 'commit_uncertain' as const };
                const result = await ports.dispatcher.dispatch(prepared.answer, owner, signal);
                return result.kind === 'dispatch_unconfirmed' || result.kind === 'stale_owner' ? { kind: 'unconfirmed' as const, reason: 'commit_uncertain' as const } : result;
            })()) },
        inspector: { scope: 'unbound',
            inspect: (read, signal) => track((async () => {
                const lookup = await stateFor(read, signal);
                if(lookup.kind!=='loaded')return {kind:'unavailable' as const,reason:lookup.kind==='invalid_reference'?'invalid_scope':lookup.reason};
                const state=lookup.state;
                if (state.mode !== 'unbound')
                    return { kind: 'unavailable' as const, reason: 'bound_session_required' };
                if (read !== capability(engine, state, 'read'))
                    return { kind: 'unavailable' as const, reason: 'invalid_scope' };
                return scheduler.bindDiagnosticPorts(state.enrollment).inspector.inspect(read, signal);
            })()),
            inspectReceipt: (read, receipt, signal, cursor) => track((async () => {
                const lookup = await stateFor(read, signal);
                if(lookup.kind!=='loaded')return {kind:'refused' as const,reason:lookup.kind==='invalid_reference'?'invalid_scope' as const:'storage_unavailable' as const};
                const state=lookup.state;
                if (state.mode !== 'unbound')
                    return { kind: 'refused' as const, reason: 'bound_session_required' as const };
                return scheduler.bindDiagnosticPorts(state.enrollment).inspector.inspectReceipt(read, receipt, signal, cursor);
            })()),
        },
        recovery: {
            recover: (ref, signal) => track((async () => { if (!ref.startsWith('wr1.'))
                return { kind: 'unavailable' as const, reason: 'invalid_reference' }; const result = await reconcile(ref, signal); return result.kind === 'opened' ? result.view : { kind: 'unavailable' as const, reason: 'reason' in result ? result.reason : result.kind }; })()),
            reconcileOpen: (attempt, signal) => track((async () => {
                if (!attempt.startsWith('wa1.'))
                    return { kind: 'invalid_attempt' as const };
                const result = await reconcile(attempt, signal);
                return result.kind === 'unconfirmed' ? { kind: 'unconfirmed' as const, reason: 'commit_uncertain' as const } : result;
            })()),
        },
        async close(signal) { closed = true; const result = await scheduler.close(signal); return operations.size ? { kind: 'incomplete', reason: 'work_in_flight', detail: 'Worker operations are settling' } : result; },
    };
    return worker;
}
