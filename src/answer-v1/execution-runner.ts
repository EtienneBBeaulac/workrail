import type { AnswerEngine } from './engine-composition.js';
import type { AnswerHostConfig, BoundTurnRunner, ModelCompletionResult, TurnOutcome } from './contracts/host-composition.js';
import type { HostEnrollment, OwnerFence, HostExecutorPorts, PreparedAnswer, CapturedResponse } from './contracts/invocation-contract.js';
import { SessionJournal } from './journal.js';
import { AnswerCommitter } from './committer.js';
import { createInspector } from './inspector.js';
import { readHostState, workView } from './host-state.js';
import type { ExecutionDeadline } from './execution-deadline.js';

export type OperationTracker = <T>(operation: Promise<T>) => Promise<T>;
export type ExecutionConstraint = Readonly<{ kind: 'host_lifetime' }> | Readonly<{ kind: 'deadline'; deadline: ExecutionDeadline }>;

export function createExecutorPorts(engine: AnswerEngine, config: AnswerHostConfig, enrollment: HostEnrollment,
    available: (signal: AbortSignal) => boolean, track: OperationTracker): HostExecutorPorts {
    const tracked = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A): Promise<R> => track(fn(...args));
    const journal = (value: HostEnrollment) => new SessionJournal(engine, value, config, available);
        const j = journal(enrollment), committer = new AnswerCommitter(j);
        const inspector = createInspector(engine, enrollment);
        return { journal: {
                appendDelivery: tracked(j.appendDelivery.bind(j)), redeliver: tracked(j.redeliver.bind(j)),
                captureResponse: tracked(j.captureResponse.bind(j)), prepare: tracked(j.prepare.bind(j)),
                commitStop: tracked(j.commitStop.bind(j)), recover: tracked(j.recover.bind(j)),
            }, inspector: { scope: inspector.scope, inspect: tracked(inspector.inspect), inspectReceipt: tracked(inspector.inspectReceipt) }, dispatcher: { dispatch: tracked(async (answer, owner, signal) => {
                    const outcome = await committer.commit(answer, owner, signal);
                    return outcome.kind === 'commit_uncertain' ? { kind: 'dispatch_unconfirmed', invocation: outcome.invocation } : outcome;
                }) } };
}

/** Trusted engine composition. The scheduler owns policy admission; this constructor
 * cannot authorize recovery or workspace tools. A deadline is retained, never recreated. */
export function createExecutionRunner(engine: AnswerEngine, config: AnswerHostConfig,
    enrollment: HostEnrollment, owner: OwnerFence, lifetime: AbortSignal, track: OperationTracker,
    constraint: ExecutionConstraint): BoundTurnRunner {
        const deadline = constraint.kind === 'deadline' ? constraint.deadline : undefined;
        const available = (signal: AbortSignal) => !lifetime.aborted && !signal.aborted && deadline?.check().kind !== 'stopped';
        const journal = (value: HostEnrollment) => new SessionJournal(engine, value, config, available);
        const finish = () => {
            lifetime.removeEventListener('abort', finish);
            deadline?.signal.removeEventListener('abort', finish);
            deadline?.close();
        };
        if (deadline) {
            if (lifetime.aborted || deadline.signal.aborted) finish();
            else {
                lifetime.addEventListener('abort', finish, { once: true });
                deadline.signal.addEventListener('abort', finish, { once: true });
            }
        }
        let running = false;
        const p = createExecutorPorts(engine, config, enrollment, available, track);
        async function turn(signal: AbortSignal): Promise<TurnOutcome> {
            if (!available(signal))
                return { kind: 'cancelled' };
            const recovered = await p.journal.recover(enrollment, owner, signal);
            if (recovered.kind === 'refused' && recovered.reason === 'stopped') {
                const loaded = await readHostState(engine, enrollment);
                const stop = loaded.kind === 'loaded' ? loaded.state.records.find(r => r.kind === 'stopped') : undefined;
                if (stop?.kind === 'stopped')
                    return { kind: 'stopped', execution: enrollment.execution, reason: stop.reason, detail: stop.detail };
            }
            if (recovered.kind === 'refused' && recovered.reason === 'reconciliation_required')
                return {kind:'refused',reason:'reconciliation_required',detail:'Uncaptured delivery has prior model work'};
            if (recovered.kind === 'refused')
                return recovered.reason === 'stale_owner' ? { kind: 'stale_owner' } : { kind: 'refused', reason: 'storage_unavailable', detail: recovered.reason };
            if (recovered.kind === 'settled') {
                const result = recovered.result;
                if (result.kind === 'replay' || result.kind === 'recorded')
                    return { kind: 'settled', receipt: result.receipt, view: recovered.view };
                return { kind: 'refused', reason: 'dispatch_refused', detail: result.kind };
            }
            if (recovered.kind === 'reconciling')
                return { kind: 'unconfirmed', uncertainty: { stage: 'commit_or_dispatch', invocation: recovered.invocation } };
            let prepared: PreparedAnswer | undefined;
            let response: CapturedResponse | undefined;
            if (recovered.kind === 'replay')
                prepared = recovered.answer;
            else if (recovered.kind === 'prepare_response')
                response = recovered.response;
            else {
                const delivery = recovered.kind === 'redeliver'
                    ? await p.journal.redeliver(recovered.oldDelivery, recovered.view.reply, owner, signal)
                    : await p.journal.appendDelivery(recovered.view.reply, owner, signal);
                if (delivery.kind === 'stale_owner')
                    return delivery;
                if (delivery.kind === 'unconfirmed')
                    return { kind: 'unconfirmed', uncertainty: { stage: 'delivery', execution: enrollment.execution, reply: recovered.view.reply } };
                if (delivery.kind === 'refused')
                    return { kind: 'refused', reason: delivery.reason === 'reconciliation_required' ? 'reconciliation_required' : 'delivery_refused', detail: delivery.reason };
                if (!available(signal))
                    return { kind: 'cancelled' };
                let completion: ModelCompletionResult;
                try {
                    const bound = config.modelFactory
                        ? await config.modelFactory.create({ journal: journal(enrollment), delivery: delivery.delivery, owner }, signal)
                        : { kind: 'created' as const, model: config.model };
                    if (bound.kind === 'refused') {
                        if (bound.reason === 'stale_owner') return { kind: 'stale_owner' };
                        if (bound.reason === 'storage_unavailable') return { kind: 'refused', reason: 'storage_unavailable', detail: bound.reason };
                        return { kind: 'refused', reason: 'model_binding_refused', failure: bound.reason, detail: bound.reason };
                    }
                    if (!available(signal)) return { kind: 'cancelled' };
                    completion = await bound.model.generate({ instruction: recovered.view.instruction,
                        answerFormat: recovered.view.answerFormat, issues: recovered.view.issues, retainedSummaries: recovered.view.retained }, signal);
                }
                catch (error) {
                    return signal.aborted ? { kind: 'cancelled' } : { kind: 'refused', reason: 'model_unavailable', detail: String(error) };
                }
                if (completion.kind === 'workspace_failed')
                    return {kind:'unconfirmed',uncertainty:{stage:'workspace_effect',execution:enrollment.execution,delivery:delivery.delivery,failure:completion.failure}};
                if (completion.kind === 'call_failed')
                    return completion.failure.kind === 'unconfirmed'
                        ? { kind: 'unconfirmed', uncertainty: { stage: 'model_call', execution: enrollment.execution, delivery: delivery.delivery, failure: completion.failure } }
                        : { kind: 'refused', reason: 'model_call_refused', failure: completion.failure, detail: completion.failure.reason };
                if (completion.kind === 'cancelled')
                    return { kind: 'cancelled' };
                if (completion.kind === 'unavailable')
                    return { kind: 'refused', reason: 'model_unavailable', detail: completion.detail };
                const captured = await p.journal.captureResponse(delivery.delivery, completion.response, owner, signal);
                if (captured.kind === 'stale_owner')
                    return captured;
                if (captured.kind === 'refused')
                    return { kind: 'refused', reason: 'capture_refused', detail: captured.reason };
                if (captured.kind === 'unconfirmed')
                    return { kind: 'unconfirmed', uncertainty: { stage: 'capture', execution: enrollment.execution, delivery: delivery.delivery } };
                response = captured.response;
            }
            if (!prepared && response) {
                const result = await p.journal.prepare(response, owner, signal);
                if (result.kind === 'partial') return { kind: 'partial', receipt: result.receipt, nextView: result.view };
                if (result.kind === 'rejected')
                    return { kind: 'rejected', receipt: result.receipt, correctionView: result.view };
                if (result.kind === 'refused')
                    return result.reason === 'stale_owner' ? { kind: 'stale_owner' } : { kind: 'refused', reason: 'prepare_refused', detail: result.reason };
                if (result.kind === 'unconfirmed')
                    return { kind: 'unconfirmed', uncertainty: { stage: 'prepare', execution: enrollment.execution, delivery: response.delivery, response: response.response } };
                prepared = result.answer;
            }
            if (!prepared)
                return { kind: 'refused', reason: 'prepare_refused', detail: 'No prepared response' };
            const result = await p.dispatcher.dispatch(prepared, owner, signal);
            switch (result.kind) {
                case 'recorded': return { kind: 'advanced', receipt: result.receipt, nextView: result.view };
                case 'replay': {
                    const latest = await readHostState(engine, enrollment);
                    const view = latest.kind === 'loaded' ? await workView(engine, latest.state) : undefined;
                    return view && view.kind !== 'unavailable' ? { kind: 'settled', receipt: result.receipt, view } : { kind: 'refused', reason: 'storage_unavailable', detail: 'Cannot reload replay' };
                }
                case 'stale_owner': return result;
                case 'dispatch_unconfirmed': return { kind: 'unconfirmed', uncertainty: { stage: 'commit_or_dispatch', invocation: result.invocation } };
                case 'conflict': return { kind: 'refused', reason: 'dispatch_refused', detail: 'Conflicting answer' };
                case 'not_retained': return { kind: 'refused', reason: 'dispatch_refused', detail: result.reason };
            }
        }
        return { execution: enrollment.execution, async runTurn(signal) {
                if (running)
                    return { kind: 'refused', reason: 'dispatch_refused', detail: 'Runner already active' };
                running = true;
                const combined = AbortSignal.any(deadline ? [signal, lifetime, deadline.signal] : [signal, lifetime]);
                try {
                    const outcome = await track(turn(combined));
                    if (outcome.kind === 'stopped'
                        || (outcome.kind === 'settled' && outcome.view.kind === 'finished')
                        || (outcome.kind === 'advanced' && outcome.nextView.kind === 'finished')) finish();
                    return outcome;
                }
                catch (error) {
                    return { kind: 'refused', reason: 'storage_unavailable', detail: String(error) };
                }
                finally {
                    running = false;
                }
            } };
    }
