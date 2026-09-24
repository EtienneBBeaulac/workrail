import { classifyAnswerWorkflow } from './workflow-support.js';
import { createExecutionRunner, createExecutorPorts } from './execution-runner.js';
import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { AnswerHostRequestSchema } from '../v2/durable-core/schemas/session/answer-host.js';
import { errAsync } from 'neverthrow';
import type { AnswerHostConfig, CreateAnswerHostResult, TrustedAnswerScheduler, RuntimeCapabilityDescriptor, RecoverHostSessionResult, BoundTurnRunner, ReleaseOwnershipResult } from './contracts/host-composition.js';
import type { ClaimUnownedResult } from './contracts/automatic-recovery-contract.js';
import type { ConditionalRecoveryResult } from './contracts/conditional-recovery-contract.js';
import type { HostEnrollment, ExecutionRef, OwnerFence, HostExecutorPorts } from './contracts/invocation-contract.js';
import type { RecoveryRef, ReceiptRef } from './contracts/answer-contract.js';
import { composeAnswerEngine } from './engine-composition.js';
import { hostEvent, readHostState, workView, owns, type HostState } from './host-state.js';
import { SessionJournal } from './journal.js';
import { executeStartWorkflow } from '../v2/usecases/start-workflow.js';
import { createWorkflow } from '../types/workflow.js';
import { createUserDirectorySource } from '../types/workflow-source.js';
import { hasWorkflowDefinitionShape } from '../types/workflow-definition.js';
export const runtimeCapabilities: RuntimeCapabilityDescriptor = Object.freeze({ enrollmentFormatVersion: 1, journalFormatVersion: 1, supportedOutputs: Object.freeze(['notes' as const, 'wr.contracts.review_verdict' as const]) });
const Pointer = z.object({ formatVersion: z.literal(1), executionId: z.string().regex(/^sess_[a-z0-9]+$/), recoveryLocator: z.string().min(1) }).strict();
const Request = AnswerHostRequestSchema.refine(request => isAbsolute(request.workspacePath));
export async function createAnswerRuntime(config: AnswerHostConfig, lifetime: AbortSignal, mode: 'host_bound' | 'unbound'): Promise<CreateAnswerHostResult> {
    if (lifetime.aborted)
        return { kind: 'refused', reason: 'storage_unavailable', detail: 'Host creation cancelled' };
    if (![config.storage.journalRootDir, config.storage.hostIndexRootDir, config.keyringPath, config.workflowStoragePath].every(isAbsolute))
        return { kind: 'refused', reason: 'missing_authority', detail: 'Explicit absolute authority paths required' };
    const composition = await composeAnswerEngine(config);
    if (composition.kind !== 'ready')
        return { kind: 'refused', reason: 'storage_unavailable', detail: composition.detail };
    const engine = composition;
    const shutdown = new AbortController();
    let closed = false;
    const active = new Set<Promise<unknown>>();
    const available = (s: AbortSignal) => !closed && !lifetime.aborted && !s.aborted;
    const track = async <T>(operation: Promise<T>): Promise<T> => {
        active.add(operation);
        try {
            return await operation;
        }
        finally {
            active.delete(operation);
        }
    };
    const tracked = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A): Promise<R> => track(fn(...args));
    const journal = (enrollment: HostEnrollment) => new SessionJournal(engine, enrollment, config, available);
    const ports = (enrollment: HostEnrollment): HostExecutorPorts => createExecutorPorts(engine, config, enrollment, available, track);
    const ownerOf = (state: HostState): OwnerFence => ({ execution: state.enrollment.execution, epoch: state.epoch }) as OwnerFence;
    const hydrator: TrustedAnswerScheduler['hydrator'] = {
        dehydrate(enrollment) { return { formatVersion: 1, executionId: enrollment.execution, recoveryLocator: enrollment.recovery }; },
        async hydrate(raw, signal) {
            if (!available(signal))
                return { kind: 'refused', reason: 'storage_unavailable', detail: 'Host unavailable' };
            const parsed = Pointer.safeParse(raw);
            if (!parsed.success) {
                const version = z.object({ formatVersion: z.number() }).safeParse(raw);
                return { kind: 'refused', reason: version.success && version.data.formatVersion !== 1 ? 'unsupported_version' : 'corrupt', detail: 'Invalid enrollment pointer' };
            }
            const enrollment = { execution: parsed.data.executionId as ExecutionRef, recovery: parsed.data.recoveryLocator as RecoveryRef } as HostEnrollment;
            const loaded = await readHostState(engine, enrollment);
            return loaded.kind === 'loaded' && loaded.state.mode !== mode ? { kind: 'refused', reason: 'missing', detail: 'Enrollment belongs to a different execution boundary' } : loaded.kind === 'loaded' ? { kind: 'hydrated', enrollment } : { kind: 'refused', reason: loaded.reason, detail: loaded.detail };
        },
    };
    const runner = (enrollment: HostEnrollment, owner: OwnerFence): BoundTurnRunner =>
        createExecutionRunner(engine, config, enrollment, owner, AbortSignal.any([lifetime, shutdown.signal]), track, { kind: 'host_lifetime' });
    type RecoveryMode = {
        kind: 'trusted';
    } | {
        kind: 'unowned';
    } | {
        kind: 'conditional';
        expected: OwnerFence;
    };
    async function recover(raw: unknown, mode: RecoveryMode, signal: AbortSignal): Promise<RecoverHostSessionResult | ClaimUnownedResult> {
        const hydrated = await hydrator.hydrate(raw, signal);
        if (hydrated.kind !== 'hydrated')
            return hydrated;
        const enrollment = hydrated.enrollment, j = journal(enrollment);
        return j.locked<RecoverHostSessionResult | ClaimUnownedResult>(signal, { kind: 'refused', reason: 'storage_unavailable', detail: 'Cannot lock recovery' }, async (state, lock) => {
            if (state.records.some(record => record.kind === 'enrolled' && record.request?.daemonPolicy))
                return { kind: 'refused', reason: 'unsupported_execution_policy', detail: 'This runtime cannot enforce retained daemon policy' };
            const view = await workView(engine, state);
            if (view.kind === 'unavailable')
                return { kind: 'refused', reason: 'storage_unavailable', detail: view.detail };
            if (view.kind === 'finished') {
                if (view.execution.kind === 'incomplete')
                    return { kind: 'stopped', execution: enrollment.execution, reason: view.execution.reason, detail: view.execution.detail, read: view.read };
                const last = [...state.records].reverse().find(r => r.kind === 'committed' || r.kind === 'review_committed');
                return (last?.kind === 'committed' || last?.kind === 'review_committed') ? { kind: 'settled', receipt: last.receipt as ReceiptRef, view } : { kind: 'refused', reason: 'corrupt', detail: 'Missing completion receipt' };
            }
            if (mode.kind === 'conditional' && !owns(state, mode.expected))
                return { kind: 'refused', reason: 'ownership_changed', detail: 'Expected owner is no longer current' };
            if (mode.kind === 'unowned' && state.owned)
                return { kind: 'busy', detail: 'Execution has an owner' };
            const owner = { execution: enrollment.execution, epoch: state.epoch + 1n } as OwnerFence;
            if (!await j.append(state, lock, { kind: 'owner_acquired', epoch: owner.epoch.toString() }, signal))
                return { kind: 'unconfirmed', reason: 'commit_uncertain' };
            return { kind: 'ready', enrollment, owner, runner: runner(enrollment, owner) };
        }, error => error.code === 'SESSION_LOCKED' || error.code === 'SESSION_LOCK_REENTRANT'
            ? mode.kind === 'unowned' ? { kind: 'busy', detail: 'Recovery already in progress' }
                : { kind: 'refused', reason: 'ownership_changed', detail: 'Concurrent recovery holds ownership lock' }
            : { kind: 'refused', reason: 'storage_unavailable', detail: error.message });
    }
    const scheduler: TrustedAnswerScheduler = {
        hydrator, bindDiagnosticPorts: ports,
        automaticRecovery: { claimUnowned: (raw, signal) => recover(raw, { kind: 'unowned' }, signal) },
        conditionalRecovery: { async replaceIfCurrent(raw, expected, signal): Promise<ConditionalRecoveryResult> {
                const result = await recover(raw, { kind: 'conditional', expected }, signal);
                return result.kind === 'busy' ? { kind: 'refused', reason: 'ownership_changed', detail: result.detail } : result;
            } },
        async recover(raw, signal) { const result = await recover(raw, { kind: 'trusted' }, signal); return result.kind === 'busy' ? { kind: 'refused', reason: 'ownership_changed', detail: result.detail } : result; },
        async enroll(input, signal) {
            if (!available(signal))
                return { kind: 'refused', reason: 'storage_unavailable', detail: 'Host unavailable' };
            const parsed = Request.safeParse(input);
            if (!parsed.success)
                return { kind: 'refused', reason: 'unsupported_workflow', detail: 'Invalid host work request' };
            if (parsed.data.daemonPolicy)
                return { kind: 'refused', reason: 'unsupported_execution_policy', detail: 'This runtime cannot enforce retained daemon policy' };
            let raw: unknown;
            try {
                raw = JSON.parse(await readFile(join(config.workflowStoragePath, parsed.data.workflowId + '.json'), 'utf8'));
            }
            catch {
                return { kind: 'refused', reason: 'unsupported_workflow', detail: 'Cannot load requested workflow' };
            }
            if (!hasWorkflowDefinitionShape(raw) || raw.id !== input.workflowId || classifyAnswerWorkflow(raw) === 'unsupported')
                return { kind: 'refused', reason: 'unsupported_workflow', detail: 'This build enrolls linear notes and review workflows without gates' };
            const requiredOutput = classifyAnswerWorkflow(raw) === 'review'
                ? { requiredOutput: 'wr.contracts.review_verdict' as const } : {};
            const workflow = createWorkflow(raw, createUserDirectorySource(config.workflowStoragePath));
            const recovery = engine.idFactory.mintEventId() as RecoveryRef;
            let enrollment: HostEnrollment | undefined;
            const started = await executeStartWorkflow({ ...engine, fallbackWorkflowReader: { getWorkflowById: async (id) => id === workflow.definition.id ? workflow : null }, sessionStore: { load: id => engine.sessionStore.load(id), loadValidatedPrefix: id => engine.sessionStore.loadValidatedPrefix(id), append: (lock, plan) => {
                        const run = plan.events.find(e => e.kind === 'run_started'), node = plan.events.find(e => e.kind === 'node_created');
                        if (run?.kind !== 'run_started' || node?.kind !== 'node_created' || !available(signal))
                            return errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'Enrollment cancelled or incomplete' });
                        enrollment = { execution: lock.sessionId as string as ExecutionRef, recovery } as HostEnrollment;
                        const state = { enrollment, run };
                        return engine.sessionStore.append(lock, { ...plan, events: [...plan.events, hostEvent(engine, state, { kind: 'enrolled', mode, recovery, initialNode: node.scope.nodeId, request: parsed.data, ...requiredOutput }, plan.events.length), hostEvent(engine, state, { kind: 'owner_acquired', epoch: '1' }, plan.events.length + 1)] });
                    } } }, parsed.data, { triggerSource: 'daemon' });
            if (started.isErr() || !enrollment)
                return enrollment ? { kind: 'unconfirmed', reason: 'commit_uncertain', pointer: hydrator.dehydrate(enrollment) } : { kind: 'refused', reason: started.isErr() && ['pinned_workflow_store_failed', 'snapshot_creation_failed', 'session_append_failed', 'keyring_load_failed'].includes(started.error.kind) ? 'storage_unavailable' : 'initialization_failed', detail: started.isErr() ? started.error.kind : 'Missing enrollment' };
            const loaded = await readHostState(engine, enrollment);
            const view = loaded.kind === 'loaded' ? await workView(engine, loaded.state) : undefined;
            if (!view || view.kind === 'unavailable')
                return { kind: 'unconfirmed', reason: 'commit_uncertain', pointer: hydrator.dehydrate(enrollment) };
            const owner = { execution: enrollment.execution, epoch: 1n } as OwnerFence;
            return { kind: 'enrolled', enrollment, runner: runner(enrollment, owner), initialView: view, owner };
        },
        async releaseOwnership(enrollment, owner, signal): Promise<ReleaseOwnershipResult> {
            const j = journal(enrollment);
            return j.locked<ReleaseOwnershipResult>(signal, { kind: 'refused', reason: 'storage_unavailable' }, async (state, lock) => {
                if (!owns(state, owner))
                    return { kind: 'stale_owner' };
                if (state.records.some(record => record.kind === 'enrolled' && record.request?.daemonPolicy))
                    return { kind: 'refused', reason: 'supervised_cleanup_required' };
                return await j.append(state, lock, { kind: 'owner_released', epoch: owner.epoch.toString() }, signal) ? { kind: 'released' } : { kind: 'unconfirmed', reason: 'commit_uncertain' };
            });
        },
        async close(signal) {
            closed = true;
            shutdown.abort();
            if (signal.aborted)
                return { kind: 'incomplete', reason: 'cancelled', detail: 'Close cancelled' };
            return active.size ? { kind: 'incomplete', reason: 'work_in_flight', detail: 'Operations are settling' } : { kind: 'closed' };
        },
    };
    return { kind: 'created', scheduler: { ...scheduler,
            enroll: tracked(scheduler.enroll), recover: tracked(scheduler.recover), releaseOwnership: tracked(scheduler.releaseOwnership),
            hydrator: { ...hydrator, hydrate: tracked(hydrator.hydrate) },
            automaticRecovery: { claimUnowned: tracked(scheduler.automaticRecovery.claimUnowned) },
            conditionalRecovery: { replaceIfCurrent: tracked(scheduler.conditionalRecovery.replaceIfCurrent) },
        } };
}
export function createAnswerHost(config: AnswerHostConfig, lifetime: AbortSignal): Promise<CreateAnswerHostResult> {
    return createAnswerRuntime(config, lifetime, 'host_bound');
}
