import { createExecutionRunner } from '../../../src/answer-v1/execution-runner.js';
import type { AnswerHostConfig } from '../../../src/answer-v1/contracts/host-composition.js';
import { createFreshAdmissionAuthority } from '../../../src/answer-v1/host-admission.js';
import type { DeadlineClock } from '../../../src/answer-v1/execution-deadline.js';
import { createDeliveryAnswerModel } from '../../../src/daemon/runner/delivery-answer-model.js';
import { SessionJournal } from '../../../src/answer-v1/journal.js';
import { readHostState, workView } from '../../../src/answer-v1/host-state.js';
import { bindBudgetedProvider, reserveModelCall } from '../../../src/answer-v1/model-call-budget.js';
import type { OwnerFence } from '../../../src/answer-v1/contracts/invocation-contract.js';
import { decodeDaemonExecutionPolicy } from '../../../src/answer-v1/daemon-policy.js';
import { errAsync, okAsync } from 'neverthrow';
import { it, expect, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAnswerHost } from '../../../src/answer-v1/host.js';
import { composeAnswerEngine } from '../../../src/answer-v1/engine-composition.js';
import { prepareStartWorkflow } from '../../../src/v2/usecases/start-workflow.js';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createUserDirectorySource } from '../../../src/types/workflow-source.js';
import { buildHostAdmissionCandidate, publishAndReconcileHostAdmission, recoverHostAdmission } from '../../../src/answer-v1/host-admission.js';
import { publishAdmissionFile } from '../../../src/answer-v1/immutable-admission-file.js';
import { decodeAdmissionReservation } from '../../../src/answer-v1/admission-reservation.js';
import { asSessionId, asSnapshotRef, asSha256Digest } from '../../../src/v2/durable-core/ids/index.js';

async function setup(root: string, stepCount = 1) {
  const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
    keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'workflow-source') };
  const engine = await composeAnswerEngine(config);
  if (engine.kind !== 'ready') throw new Error(engine.kind);
  const workflow = createWorkflow({ id: 'admission', name: 'Admission', description: 'Admission fixture', version: '1.0.0',
    steps: Array.from({ length: stepCount }, (_, i) => ({ id: i === 0 ? 'first' : 'second', title: 'Step', prompt: 'Original' })) }, createUserDirectorySource(config.workflowStoragePath));
  const request = { workflowId: 'admission', goal: 'original goal', workspacePath: root };
  const prepare = async () => {
    const result = await prepareStartWorkflow({ ...engine, fallbackWorkflowReader: { getWorkflowById: async () => workflow } },
      { ...request, injectOnboarding: false }, { triggerSource: 'daemon' });
    if (result.isErr()) throw new Error(result.error.kind);
    return result.value;
  };
  const prepared = await prepare();
  const expected = { operationId: randomUUID(), request };
  const candidate = buildHostAdmissionCandidate(prepared, request, expected.operationId, engine, () => 1);
  if (candidate.kind !== 'candidate') throw new Error(candidate.kind);
  return { engine, prepared, expected, candidate, prepare, config };
}

it.skipIf(process.platform === 'win32')('publishes, reconciles once and resumes the same unowned identity across runtime restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-'));
  try {
    const { engine, prepared, expected, candidate, prepare, config } = await setup(root);
    expect(Buffer.from(candidate.bytes).toString()).not.toContain('eat_token');
    const signal = new AbortController().signal;
    const results = await Promise.all([1, 2].map(() => publishAndReconcileHostAdmission(engine, root, expected, candidate.bytes, signal)));
    expect(results.map(r => r.kind)).toEqual(['admitted', 'admitted']);
    const original = await engine.sessionStore.load(prepared.sessionId);
    if (original.isErr()) throw new Error(original.error.code);
    expect(original.value.events.filter(e => e.kind === 'run_started')).toHaveLength(1);
    expect(original.value.events.filter(e => e.kind === 'answer_host_recorded').map(e => e.data.kind)).toEqual(['enrolled']);
    const reopened = await composeAnswerEngine(config);
    if (reopened.kind !== 'ready') throw new Error(reopened.kind);
    expect(await publishAndReconcileHostAdmission(reopened, root, expected, candidate.bytes, signal)).toEqual(results[0]);
    expect(await reopened.sessionStore.load(prepared.sessionId)).toEqual(original);
    const otherPrepared = await prepare();
    const challenger = buildHostAdmissionCandidate(otherPrepared, expected.request, expected.operationId, engine, () => 2);
    if (challenger.kind !== 'candidate') throw new Error(challenger.kind);
    expect(await publishAndReconcileHostAdmission(reopened, root, expected, challenger.bytes, signal)).toEqual(results[0]);
    const unused = await reopened.sessionStore.load(otherPrepared.sessionId);
    if (unused.isErr()) throw new Error(unused.error.code);
    expect(unused.value.events).toEqual([]);
    const host = await createAnswerHost({ ...config,
      model: { generate: async () => ({ kind: 'unavailable', detail: 'No inference in admission test' }) } }, signal);
    if (host.kind !== 'created') throw new Error(host.kind);
    const admitted = results[0];
    if (!admitted || admitted.kind !== 'admitted') throw new Error('not admitted');
    const claimed = await host.scheduler.automaticRecovery.claimUnowned(admitted.pointer, signal);
    expect(claimed.kind).toBe('ready');
    const withOwner = await reopened.sessionStore.load(prepared.sessionId);
    expect(await publishAndReconcileHostAdmission(reopened, root, expected, candidate.bytes, signal)).toEqual(results[0]);
    expect(await reopened.sessionStore.load(prepared.sessionId)).toEqual(withOwner);
    expect((await host.scheduler.close(signal)).kind).toBe('closed');
    expect(decodeAdmissionReservation(await readFile(join(root, `${expected.operationId}.json`)), expected).kind).toBe('validated');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32').each(['workflow', 'snapshot'])('refuses schema-valid altered %s content before any session append', async target => {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-corrupt-'));
  try {
    const { engine, prepared, expected, candidate } = await setup(root);
    const path = target === 'workflow' ? engine.dataDir.pinnedWorkflowPath(prepared.workflowHash)
      : engine.dataDir.snapshotPath(prepared.appendPlan.snapshotPins[0]!.snapshotRef);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (target === 'workflow') raw.description = 'changed but schema valid';
    else raw.enginePayload.engineState.pending.step.stepId = 'changed';
    await writeFile(path, JSON.stringify(raw));
    expect(await publishAndReconcileHostAdmission(engine, root, expected, candidate.bytes, new AbortController().signal))
      .toEqual({ kind: 'refused', reason: 'invalid_content' });
    const truth = await engine.sessionStore.load(prepared.sessionId);
    if (truth.isErr()) throw new Error(truth.error.code);
    expect(truth.value.events).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('refuses an existing foreign journal prefix without changing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-conflict-'));
  try {
    const { engine, prepared, expected, candidate } = await setup(root);
    const foreign = await engine.gate.withHealthySessionLock(prepared.sessionId, lock =>
      engine.sessionStore.append(lock, { events: [prepared.appendPlan.events[0]!], snapshotPins: [] }));
    expect(foreign.isOk()).toBe(true);
    const before = await engine.sessionStore.load(asSessionId(prepared.sessionId));
    expect(await publishAndReconcileHostAdmission(engine, root, expected, candidate.bytes, new AbortController().signal))
      .toEqual({ kind: 'refused', reason: 'journal_conflict' });
    expect(await engine.sessionStore.load(prepared.sessionId)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('reconciles a lost append acknowledgement without repeating the append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-lost-reply-'));
  try {
    const { engine, prepared, expected, candidate } = await setup(root);
    let appendCalls = 0;
    const uncertainEngine = { ...engine, sessionStore: {
      load: engine.sessionStore.load.bind(engine.sessionStore),
      loadValidatedPrefix: engine.sessionStore.loadValidatedPrefix.bind(engine.sessionStore),
      append: (...args: Parameters<typeof engine.sessionStore.append>) => {
        appendCalls++;
        return engine.sessionStore.append(...args).andThen(() =>
          errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'lost acknowledgement after durable append' }));
      },
    } };
    expect(await publishAndReconcileHostAdmission(uncertainEngine, root, expected, candidate.bytes, new AbortController().signal))
      .toEqual({ kind: 'unconfirmed', reason: 'storage_unavailable' });
    const before = await engine.sessionStore.load(prepared.sessionId);
    expect((await publishAndReconcileHostAdmission(uncertainEngine, root, expected, candidate.bytes, new AbortController().signal)).kind)
      .toBe('admitted');
    expect(appendCalls).toBe(1);
    expect(await engine.sessionStore.load(prepared.sessionId)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('refuses valid initial snapshot bytes stored under the wrong content address', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-address-'));
  try {
    const { engine, prepared, expected, candidate } = await setup(root);
    const original = await readFile(engine.dataDir.snapshotPath(prepared.appendPlan.snapshotPins[0]!.snapshotRef));
    const wrongRef = asSnapshotRef(asSha256Digest('sha256:' + '0'.repeat(64)));
    await writeFile(engine.dataDir.snapshotPath(wrongRef), original);
    const raw = JSON.parse(Buffer.from(candidate.bytes).toString());
    raw.plan.events[2].data.snapshotRef = wrongRef;
    raw.plan.snapshotPins[0].snapshotRef = wrongRef;
    expect(await publishAndReconcileHostAdmission(engine, root, expected, Buffer.from(JSON.stringify(raw)), new AbortController().signal))
      .toEqual({ kind: 'refused', reason: 'invalid_content' });
    const truth = await engine.sessionStore.load(prepared.sessionId);
    if (truth.isErr()) throw new Error(truth.error.code);
    expect(truth.value.events).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('preserves cancellation when gate acquisition fails after abort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-cancel-'));
  try {
    const { engine, expected, candidate } = await setup(root);
    const controller = new AbortController();
    const failedGate = { ...engine, gate: { withHealthySessionLock: () => {
      controller.abort();
      return errAsync({ code: 'LOCK_ACQUIRE_FAILED' as const, sessionId: asSessionId('sess_cancelled'), message: 'interrupted' });
    } } };
    expect(await publishAndReconcileHostAdmission(failedGate, root, expected, candidate.bytes, controller.signal))
      .toEqual({ kind: 'unconfirmed', reason: 'cancelled' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// No workflow reader or candidate is passed to recovery. The source directory is
// absent, so this exercises retained immutable content rather than source preparation.
it.skipIf(process.platform === 'win32')('cold-recovers published intent before append and after a lost reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-cold-'));
  try {
    const { engine, prepared, expected, candidate, config } = await setup(root);
    const signal = new AbortController().signal;
    expect((await publishAdmissionFile(root, expected.operationId, candidate.bytes, signal)).kind).toBe('durable');
    const empty = await engine.sessionStore.load(prepared.sessionId);
    if (empty.isErr()) throw new Error(empty.error.code);
    expect(empty.value.events).toEqual([]);
    await rm(config.workflowStoragePath, { recursive: true, force: true });
    const reopened = await composeAnswerEngine(config);
    if (reopened.kind !== 'ready') throw new Error(reopened.kind);
    const results = await Promise.all([1, 2].map(() => recoverHostAdmission(reopened, root, expected, signal)));
    expect(results[0]).toEqual({ kind: 'admitted', pointer: { formatVersion: 1,
      executionId: prepared.sessionId, recoveryLocator: JSON.parse(Buffer.from(candidate.bytes).toString()).recovery } });
    expect(results[1]).toEqual(results[0]);
    const truth = await reopened.sessionStore.load(prepared.sessionId);
    if (truth.isErr()) throw new Error(truth.error.code);
    expect(truth.value.events.filter(e => e.kind === 'run_started')).toHaveLength(1);
    expect(truth.value.events.filter(e => e.kind === 'answer_host_recorded').map(e => e.data.kind)).toEqual(['enrolled']);
    expect(await recoverHostAdmission(reopened, root, expected, signal)).toEqual(results[0]);
    expect(await reopened.sessionStore.load(prepared.sessionId)).toEqual(truth);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('cold recovery refuses conflicting or corrupt intent and never fills a missing reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-admission-cold-refuse-'));
  try {
    const { engine, prepared, expected, candidate } = await setup(root);
    const signal = new AbortController().signal;
    const before = await readdir(root);
    expect(await recoverHostAdmission(engine, root, expected, signal)).toEqual({ kind: 'missing' });
    expect(await readdir(root)).toEqual(before);
    await publishAdmissionFile(root, expected.operationId, candidate.bytes, signal);
    expect(await recoverHostAdmission(engine, root, { ...expected, request: { ...expected.request, goal: 'different' } }, signal))
      .toEqual({ kind: 'refused', reason: 'request_conflict' });
    const path = join(root, `${expected.operationId}.json`);
    await writeFile(path, '{broken');
    expect(await recoverHostAdmission(engine, root, expected, signal)).toEqual({ kind: 'refused', reason: 'corrupt_reservation' });
    expect(await readFile(path, 'utf8')).toBe('{broken');
    const truth = await engine.sessionStore.load(prepared.sessionId);
    if (truth.isErr()) throw new Error(truth.error.code);
    expect(truth.value.events).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('binds retained policy and refuses every policy-unaware scheduler entry without writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'policy-admission-'));
  const signal = new AbortController().signal;
  try {
    const { engine, prepared, expected, candidate, prepare, config } = await setup(root);
    const policyResult = decodeDaemonExecutionPolicy({ formatVersion: 1, profile: 'daemon_answers_v1',
      model: { provider: 'anthropic', modelId: 'original-model' }, systemPrompt: 'original prompt',
      limits: { expiresAtMs: 100000, maxModelCalls: 5, maxOutputTokens: 100, stallTimeoutMs: 100, callTimeoutMs: 50 },
      workspace: { kind: 'existing', workspacePath: root }, delivery: { kind: 'none' },
      restart: { kind: 'requires_explicit_reconciliation' } });
    if (policyResult.kind !== 'validated') throw new Error('policy fixture invalid');
    const request = { ...expected.request, daemonPolicy: policyResult.policy };
    const policyExpected = { operationId: randomUUID(), request };
    const policyPrepared = await prepare();
    const policyCandidate = buildHostAdmissionCandidate(policyPrepared, request, policyExpected.operationId, engine, () => 1);
    if (policyCandidate.kind !== 'candidate') throw new Error(policyCandidate.kind);
    const decoded = decodeAdmissionReservation(policyCandidate.bytes, policyExpected);
    expect(decoded.kind).toBe('validated');
    if (decoded.kind !== 'validated') throw new Error('invalid candidate');
    expect(decoded.reservation.formatVersion).toBe(2);
    expect(decoded.reservation.request.daemonPolicy).toEqual(policyResult.policy);
    const admitted = await publishAndReconcileHostAdmission(engine, root, policyExpected, policyCandidate.bytes, signal);
    if (admitted.kind !== 'admitted') throw new Error(admitted.kind);
    const original = await engine.sessionStore.load(policyPrepared.sessionId);
    expect(await recoverHostAdmission(engine, root, policyExpected, signal)).toEqual(admitted);
    expect(await engine.sessionStore.load(policyPrepared.sessionId)).toEqual(original);
    const changed = { ...policyExpected, request: { ...request, daemonPolicy: { ...request.daemonPolicy, systemPrompt: 'changed' } } };
    expect(await recoverHostAdmission(engine, root, changed, signal)).toEqual({ kind: 'refused', reason: 'request_conflict' });
    const invalid = JSON.parse(Buffer.from(policyCandidate.bytes).toString());
    invalid.plan.events.at(-1).data.request.daemonPolicy.model.modelId = 'substituted';
    expect(decodeAdmissionReservation(Buffer.from(JSON.stringify(invalid)), policyExpected).kind).toBe('refused');
    const wrongPath = { ...request, workspacePath: join(root, 'different') };
    expect(buildHostAdmissionCandidate(policyPrepared, wrongPath, randomUUID(), engine, () => 1).kind).toBe('refused');
    const v1 = JSON.parse(Buffer.from(policyCandidate.bytes).toString()); v1.formatVersion = 1;
    expect(decodeAdmissionReservation(Buffer.from(JSON.stringify(v1)), policyExpected).kind).toBe('refused');
    let calls = 0;
    const host = await createAnswerHost({ ...config, model: { async generate() { calls++; return { kind: 'unavailable', detail: 'must not call' }; } } }, signal);
    if (host.kind !== 'created') throw new Error(host.kind);
    try {
      const legacy = await publishAndReconcileHostAdmission(engine, root, expected, candidate.bytes, signal);
      if (legacy.kind !== 'admitted') throw new Error(legacy.kind);
      const claimed = await host.scheduler.automaticRecovery.claimUnowned(legacy.pointer, signal);
      if (claimed.kind !== 'ready') throw new Error(claimed.kind);
      const directories = await readdir(config.storage.journalRootDir);
      for (const outcome of [
        await host.scheduler.enroll(request, signal),
        await host.scheduler.recover(admitted.pointer, signal),
        await host.scheduler.automaticRecovery.claimUnowned(admitted.pointer, signal),
        await host.scheduler.conditionalRecovery.replaceIfCurrent(admitted.pointer, claimed.owner, signal),
      ]) expect(outcome).toMatchObject({ kind: 'refused', reason: 'unsupported_execution_policy' });
      expect(await engine.sessionStore.load(policyPrepared.sessionId)).toEqual(original);
      expect(await readdir(config.storage.journalRootDir)).toEqual(directories);
      expect(calls).toBe(0);
      const legacyTruth = await engine.sessionStore.load(prepared.sessionId);
      expect(legacyTruth.isOk()).toBe(true);
    } finally { await host.scheduler.close(signal); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32').each(['reservation', 'provider'])('charges calls durably and retains %s uncertainty across recomposition', async failure => {
  const root = await mkdtemp(join(tmpdir(), 'budget-admission-'));
  const signal = new AbortController().signal;
  try {
    const { engine, prepared, expected, config } = await setup(root);
    const decoded = decodeDaemonExecutionPolicy({ formatVersion: 1, profile: 'daemon_answers_v1',
      model: { provider: 'anthropic', modelId: 'original-model' }, systemPrompt: 'original',
      limits: { expiresAtMs: 100000, maxModelCalls: 2, maxOutputTokens: 100, stallTimeoutMs: 100, callTimeoutMs: 50 },
      workspace: { kind: 'existing', workspacePath: root }, delivery: { kind: 'none' },
      restart: { kind: 'requires_explicit_reconciliation' } });
    if (decoded.kind !== 'validated') throw new Error('invalid fixture');
    const request = { ...expected.request, daemonPolicy: decoded.policy };
    const candidate = buildHostAdmissionCandidate(prepared, request, expected.operationId, engine, () => 1);
    if (candidate.kind !== 'candidate') throw new Error(candidate.kind);
    const admitted = await publishAndReconcileHostAdmission(engine, root, { ...expected, request }, candidate.bytes, signal);
    if (admitted.kind !== 'admitted') throw new Error(admitted.kind);
    let calls = 0;
    const hostConfig = { ...config, model: { async generate() { return { kind: 'unavailable' as const, detail: 'unused' }; } } };
    const host = await createAnswerHost(hostConfig, signal);
    if (host.kind !== 'created') throw new Error(host.kind);
    try {
      const hydrated = await host.scheduler.hydrator.hydrate(admitted.pointer, signal);
      if (hydrated.kind !== 'hydrated') throw new Error(hydrated.kind);
      const journal = new SessionJournal(engine, hydrated.enrollment, hostConfig, s => !s.aborted);
      // Trusted test fixture seeds canonical ownership. Production scheduler still refuses policy.
      const owner = { execution: hydrated.enrollment.execution, epoch: 1n } as OwnerFence;
      expect(await journal.locked(signal, false, (state, lock) => journal.append(state, lock,
        { kind: 'owner_acquired', epoch: '1' }, signal))).toBe(true);
      const state = await readHostState(engine, hydrated.enrollment);
      if (state.kind !== 'loaded') throw new Error(state.kind);
      const view = await workView(engine, state.state);
      if (view.kind !== 'question') throw new Error(view.kind);
      const delivery = await journal.appendDelivery(view.reply, owner, signal);
      if (delivery.kind !== 'delivered') throw new Error(delivery.kind);
      const provider = bindBudgetedProvider(journal, delivery.delivery, owner, async (input: string) => {
        const truth = await engine.sessionStore.load(prepared.sessionId);
        if (truth.isErr()) throw new Error(truth.error.code);
        expect(truth.value.events.filter(e => e.kind === 'answer_host_recorded' && e.data.kind === 'model_call_reserved')).toHaveLength(calls + 1);
        calls++; return input;
      });
      const firstCall = provider.invoke('one', signal);
      expect(await provider.invoke('concurrent', signal)).toEqual({ kind: 'refused', reason: 'busy' });
      expect(await firstCall).toMatchObject({ kind: 'completed', value: 'one', reservation: {ordinal:1} });
      const ambiguous = new SessionJournal(engine, hydrated.enrollment, { ...hostConfig,
        faultSeam: { async intercept(boundary) { return failure === 'reservation' && boundary === 'after_model_call_append'
          ? { kind: 'simulate_uncertain' as const, message: 'lost acknowledgement' } : { kind: 'proceed' as const }; } } }, s => !s.aborted);
      const uncertainProvider = bindBudgetedProvider(ambiguous, delivery.delivery, owner, async () => { calls++; throw new Error('provider response lost'); });
      expect(await uncertainProvider.invoke(undefined, signal)).toEqual({ kind: 'unconfirmed', reason: failure === 'reservation' ? 'commit_uncertain' : 'provider_outcome_unknown' });
      expect(await uncertainProvider.invoke(undefined, signal)).toEqual({ kind: 'refused', reason: 'reconciliation_required' });
      const reopened = await composeAnswerEngine(config);
      if (reopened.kind !== 'ready') throw new Error(reopened.kind);
      const coldJournal = new SessionJournal(reopened, hydrated.enrollment, hostConfig, s => !s.aborted);
      expect(await reserveModelCall(coldJournal, delivery.delivery, owner, signal)).toEqual({ kind: 'refused', reason: 'budget_exhausted' });
      expect(await provider.invoke('excess', signal)).toEqual({ kind: 'refused', reason: 'budget_exhausted' });
      expect(calls).toBe(failure === 'reservation' ? 1 : 2);
      const successorDelivery = await coldJournal.redeliver(delivery.delivery, view.reply, owner, signal);
      expect(successorDelivery).toEqual({kind:'refused',reason:'reconciliation_required'});
      expect(await coldJournal.recover(hydrated.enrollment,owner,signal)).toEqual({kind:'refused',reason:'reconciliation_required'});
      expect(await reserveModelCall(coldJournal, delivery.delivery, { ...owner, epoch: 2n }, signal)).toEqual({ kind: 'refused', reason: 'stale_owner' });
    } finally { await host.scheduler.close(signal); }
  } finally { await rm(root, { recursive: true, force: true }); }
});


it.skipIf(process.platform === 'win32').each(['answer', 'budget', 'unknown', 'stale', 'replaced', 'stall', 'stale_before', 'tools', 'credentials', 'missing_policy', 'abort'])('binds canonical delivery through the SDK and model loop: %s', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-model-'));
  const control = new AbortController();
  const signal = control.signal;
  try {
    const { engine, prepared, expected, config } = await setup(root);
    const decoded = decodeDaemonExecutionPolicy({ formatVersion: 1, profile: 'daemon_answers_v1',
      model: { provider: 'anthropic', modelId: 'original-model' }, systemPrompt: 'original',
      limits: { expiresAtMs: 100000, maxModelCalls: 1, maxOutputTokens: 100, stallTimeoutMs: scenario === 'stall' ? 2147483648 : 5000, callTimeoutMs: 5000 },
      workspace: { kind: 'existing', workspacePath: root }, delivery: { kind: 'none' },
      restart: { kind: 'requires_explicit_reconciliation' } });
    if (decoded.kind !== 'validated') throw new Error('invalid fixture');
    const request = scenario === 'missing_policy' ? expected.request : { ...expected.request, daemonPolicy: decoded.policy };
    const candidate = buildHostAdmissionCandidate(prepared, request, expected.operationId, engine, () => 1);
    if (candidate.kind !== 'candidate') throw new Error(candidate.kind);
    const admitted = await publishAndReconcileHostAdmission(engine, root, { ...expected, request }, candidate.bytes, signal);
    if (admitted.kind !== 'admitted') throw new Error(admitted.kind);
    let calls = 0;
    const hostConfig = { ...config, model: { async generate() { return { kind: 'unavailable' as const, detail: 'unused' }; } } };
    const host = await createAnswerHost(hostConfig, signal);
    if (host.kind !== 'created') throw new Error(host.kind);
    try {
      const hydrated = await host.scheduler.hydrator.hydrate(admitted.pointer, signal);
      if (hydrated.kind !== 'hydrated') throw new Error(hydrated.kind);
      const journal = new SessionJournal(engine, hydrated.enrollment, hostConfig, s => !s.aborted);
      // Trusted test fixture seeds canonical ownership. Production scheduler still refuses policy.
      const owner = { execution: hydrated.enrollment.execution, epoch: 1n } as OwnerFence;
      expect(await journal.locked(signal, false, (state, lock) => journal.append(state, lock,
        { kind: 'owner_acquired', epoch: '1' }, signal))).toBe(true);
      const state = await readHostState(engine, hydrated.enrollment);
      if (state.kind !== 'loaded') throw new Error(state.kind);
      const view = await workView(engine, state.state);
      if (view.kind !== 'question') throw new Error(view.kind);
      const delivery = await journal.appendDelivery(view.reply, owner, signal);
      if (delivery.kind !== 'delivered') throw new Error(delivery.kind);

      let toolRuns = 0;
      const reservationCounts: number[] = [];
      const model = await createDeliveryAnswerModel(journal, delivery.delivery, scenario === 'stale_before' ? { ...owner, epoch: 2n } : owner,
        scenario === 'credentials' ? { provider: 'amazon_bedrock', accessKeyId: 'fake', secretAccessKey: 'fake' } : { provider: 'anthropic', apiKey: 'fake-test-key' }, [{ name: scenario === 'tools' ? 'unsupported' : 'Read', label: 'Read', description: 'Read',
          inputSchema: { type: 'object', properties: {} }, async execute() { toolRuns++; return { content: [], details: null }; } }],
        async (_url, init) => {
          calls++;
          const truth = await engine.sessionStore.load(prepared.sessionId);
          if (truth.isErr()) throw new Error(truth.error.code);
          reservationCounts.push(truth.value.events.filter(e => e.kind === 'answer_host_recorded' && e.data.kind === 'model_call_reserved').length);
          const requestBody = JSON.parse(String(init?.body));
          expect(requestBody.model).toBe('original-model');
          expect(requestBody.system).toBe('original');
          if (scenario === 'abort') { control.abort(); throw new Error('aborted network response'); }
          if (scenario === 'unknown') throw new Error('lost network response');
          return new Response(JSON.stringify({ id: 'result', type: 'message', role: 'assistant', model: 'original-model',
            content: [{ type: 'tool_use', id: 'call', name: scenario === 'budget' ? 'Read' : 'answer_work',
              input: scenario === 'budget' ? {} : { answer: { notes: 'supported' } } }],
            stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
            { headers: { 'content-type': 'application/json' } });
        }, signal);
      const refusal = { stall: 'unsupported_stall_timeout', stale_before: 'stale_owner', tools: 'unsupported_workspace_tool', credentials: 'credential_mismatch', missing_policy: 'missing_policy' };
      if (scenario in refusal) {
        expect(model).toEqual({ kind: 'refused', reason: refusal[scenario as keyof typeof refusal] });
        expect(calls).toBe(0);
        return;
      }
      if (model.kind !== 'created') throw new Error(model.reason);
      if (scenario === 'replaced') expect((await journal.redeliver(delivery.delivery, view.reply, owner, signal)).kind).toBe('delivered');
      if (scenario === 'stale') {
        expect(await journal.locked(signal, false, (state, lock) => journal.append(state, lock,
          { kind: 'owner_acquired', epoch: '2' }, signal))).toBe(true);
      }
      const prompt = { instruction: 'First', issues: [], retainedSummaries: [] };
      const result = await model.model.generate(prompt, signal);
      expect(reservationCounts).toEqual(scenario === 'stale' || scenario === 'replaced' ? [] : [1]);
      if (scenario === 'answer') expect(result).toMatchObject({ kind: 'completed', response: { calls: [{ name: 'answer_work' }] } });
      else expect(result).toEqual({ kind: 'call_failed', failure: scenario === 'unknown' || scenario === 'abort'
        ? { kind: 'unconfirmed', reason: 'provider_outcome_unknown' }
        : { kind: 'refused', reason: scenario === 'stale' ? 'stale_owner' : scenario === 'replaced' ? 'invalid_delivery' : 'budget_exhausted' } });
      if (scenario === 'unknown') expect(await model.model.generate(prompt, signal))
        .toEqual({ kind: 'call_failed', failure: { kind: 'refused', reason: 'reconciliation_required' } });
      expect(calls).toBe(scenario === 'stale' || scenario === 'replaced' ? 0 : 1);
      expect(toolRuns).toBe(scenario === 'budget' ? 1 : 0);
    } finally { await host.scheduler.close(new AbortController().signal); }
  } finally { await rm(root, { recursive: true, force: true }); }
});


class AdmissionClock implements DeadlineClock {
  wall = 1000; mono = 0;
  timers = new Set<() => void>();
  read(): ReturnType<DeadlineClock['read']> { return { kind: 'reading', wallMs: this.wall, monotonicMs: this.mono }; }
  schedule(_delay: number, wake: () => void): ReturnType<DeadlineClock['schedule']> {
    this.timers.add(wake); return { kind: 'scheduled', cancel: () => { this.timers.delete(wake); } };
  }
}
async function freshFixture(root: string, stepCount = 1) {
  const fixture = await setup(root, stepCount);
  const parsed = decodeDaemonExecutionPolicy({ formatVersion: 1, profile: 'daemon_answers_v1',
    model: { provider: 'anthropic', modelId: 'original-model' }, systemPrompt: 'original prompt',
    limits: { expiresAtMs: 1100, maxModelCalls: 5, maxOutputTokens: 100, stallTimeoutMs: 100, callTimeoutMs: 50 },
    workspace: { kind: 'existing', workspacePath: root }, delivery: { kind: 'none' },
    restart: { kind: 'requires_explicit_reconciliation' } });
  if (parsed.kind !== 'validated') throw new Error('policy fixture');
  const expected = { ...fixture.expected, request: { ...fixture.expected.request, daemonPolicy: parsed.policy } };
  const candidate = buildHostAdmissionCandidate(fixture.prepared, expected.request, expected.operationId, fixture.engine, () => 1);
  if (candidate.kind !== 'candidate') throw new Error('candidate fixture');
  return { ...fixture, expected, candidate };
}

it.skipIf(process.platform === 'win32')('fresh handoff belongs to one authority, consumes once and retains elapsed time before consumption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fresh-handoff-'));
  const parent = new AbortController(), request = new AbortController();
  try {
    const { engine, expected, candidate } = await freshFixture(root), clock = new AdmissionClock();
    const authority = createFreshAdmissionAuthority(engine, clock, parent.signal);
    const foreign = createFreshAdmissionAuthority(engine, clock, parent.signal);
    const results = await Promise.all([1, 2].map(() => authority.admit(root, expected, candidate.bytes, request.signal)));
    expect(results.map(r => r.kind).sort()).toEqual(['existing', 'fresh']);
    const fresh = results.find(r => r.kind === 'fresh');
    if (!fresh || fresh.kind !== 'fresh') throw new Error('no handoff');
    expect(await foreign.claim(fresh.handoff, new AbortController().signal)).toEqual({ kind: 'refused', reason: 'invalid_handoff' });
    expect(await authority.claim({ ...fresh.handoff }, new AbortController().signal)).toEqual({ kind: 'refused', reason: 'invalid_handoff' });
    clock.mono = 40; clock.wall = 500;
    request.abort(); // A completed admission request does not own execution lifetime.
    const consumed = await authority.claim(fresh.handoff, new AbortController().signal);
    expect(consumed.kind).toBe('owned');
    if (consumed.kind !== 'owned') throw new Error('not consumed');
    expect(consumed.deadline.check()).toEqual({ kind: 'active', remainingMs: 60 });
    expect(await authority.claim(fresh.handoff, new AbortController().signal)).toEqual({ kind: 'refused', reason: 'invalid_handoff' });
    expect((await authority.admit(root, expected, candidate.bytes, new AbortController().signal)).kind).toBe('existing');
    expect(clock.timers.size).toBe(1);
    authority.close(); foreign.close();
    expect(consumed.deadline.signal.aborted).toBe(true);
    expect(clock.timers.size).toBe(0);
  } finally { parent.abort(); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32').each(['expiry', 'lost_ack', 'invalid_content'])('fresh admission closes its deadline on %s without granting a handoff', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'fresh-refusal-')), parent = new AbortController();
  try {
    const { engine, expected, candidate, prepared } = await freshFixture(root), clock = new AdmissionClock();
    let appends = 0;
    const controlled = { ...engine, sessionStore: {
      load: async (...args: Parameters<typeof engine.sessionStore.load>) => {
        const loaded = await engine.sessionStore.load(...args);
        if (scenario === 'expiry') clock.mono = 101;
        return loaded;
      },
      append: (...args: Parameters<typeof engine.sessionStore.append>) => {
        appends++;
        return engine.sessionStore.append(...args).andThen(value => scenario === 'lost_ack'
          ? errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'lost acknowledgement' })
          : okAsync(value));
      },
    } };
    if (scenario === 'invalid_content') {
      const path = engine.dataDir.pinnedWorkflowPath(prepared.workflowHash);
      const raw = JSON.parse(await readFile(path, 'utf8')); raw.description = 'changed'; await writeFile(path, JSON.stringify(raw));
    }
    const authority = createFreshAdmissionAuthority(controlled, clock, parent.signal);
    const result = await authority.admit(root, expected, candidate.bytes, new AbortController().signal);
    expect(result).toEqual(scenario === 'invalid_content' ? { kind: 'refused', reason: 'invalid_content' }
      : scenario === 'expiry' ? { kind: 'unconfirmed', reason: 'deadline_stopped', deadlineReason: 'expired' }
      : { kind: 'unconfirmed', reason: 'storage_unavailable' });
    expect(appends).toBe(scenario === 'lost_ack' ? 1 : 0);
    expect(clock.timers.size).toBe(0);
    expect((await authority.admit(root, expected, candidate.bytes, new AbortController().signal)).kind).toBe('existing');
    expect(clock.timers.size).toBe(0);
    authority.close();
  } finally { parent.abort(); await rm(root, { recursive: true, force: true }); }
});


it.skipIf(process.platform === 'win32')('closing an authority invalidates pending handoffs and refuses new admission without timers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fresh-close-')), parent = new AbortController();
  try {
    const { engine, expected, candidate } = await freshFixture(root), clock = new AdmissionClock();
    const authority = createFreshAdmissionAuthority(engine, clock, parent.signal);
    const result = await authority.admit(root, expected, candidate.bytes, new AbortController().signal);
    if (result.kind !== 'fresh') throw new Error('missing fresh handoff');
    authority.close();
    expect(await authority.claim(result.handoff, new AbortController().signal)).toEqual({ kind: 'refused', reason: 'invalid_handoff' });
    expect(await authority.admit(root, expected, candidate.bytes, new AbortController().signal))
      .toEqual({ kind: 'refused', reason: 'cancelled' });
    expect(clock.timers.size).toBe(0);
  } finally { parent.abort(); await rm(root, { recursive: true, force: true }); }
});


it.skipIf(process.platform === 'win32')('time consumed inside canonical admission is not restored at handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fresh-admission-time-')), parent = new AbortController();
  try {
    const { engine, expected, candidate, prepared } = await freshFixture(root), clock = new AdmissionClock();
    const delayed = { ...engine, sessionStore: { ...engine.sessionStore,
      load: async (...args: Parameters<typeof engine.sessionStore.load>) => {
        const result = await engine.sessionStore.load(...args); clock.mono = 40; return result;
      },
      append: engine.sessionStore.append.bind(engine.sessionStore),
    } };
    const authority = createFreshAdmissionAuthority(delayed, clock, parent.signal);
    const result = await authority.admit(root, expected, candidate.bytes, new AbortController().signal);
    if (result.kind !== 'fresh') throw new Error('missing handoff');
    const consumed = await authority.claim(result.handoff, new AbortController().signal);
    if (consumed.kind !== 'owned') throw new Error('not consumed');
    expect(consumed.deadline.check()).toEqual({ kind: 'active', remainingMs: 60 });
    const loaded = await engine.sessionStore.load(prepared.sessionId);
    if (loaded.isErr()) throw new Error('load failed');
    expect(loaded.value.events.filter(e => e.kind === 'answer_host_recorded').map(e => e.data.kind)).toEqual(['enrolled', 'owner_acquired']);
    consumed.deadline.close(); authority.close();
    expect(clock.timers.size).toBe(0);
  } finally { parent.abort(); await rm(root, { recursive: true, force: true }); }
});


it.skipIf(process.platform === 'win32')('new publication cannot grant fresh handoff for an already populated canonical journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fresh-existing-journal-')), parent = new AbortController();
  try {
    const { engine, expected, candidate, prepared } = await freshFixture(root), clock = new AdmissionClock();
    const signal = new AbortController().signal;
    expect((await publishAndReconcileHostAdmission(engine, root, expected, candidate.bytes, signal)).kind).toBe('admitted');
    const before = await engine.sessionStore.load(prepared.sessionId);
    const newExpected = { ...expected, operationId: randomUUID() };
    const raw = JSON.parse(Buffer.from(candidate.bytes).toString()); raw.operationId = newExpected.operationId;
    const authority = createFreshAdmissionAuthority(engine, clock, parent.signal);
    expect(await authority.admit(root, newExpected, Buffer.from(JSON.stringify(raw)), signal))
      .toEqual({ kind: 'refused', reason: 'journal_conflict' });
    expect(await engine.sessionStore.load(prepared.sessionId)).toEqual(before);
    expect(clock.timers.size).toBe(0); authority.close();
  } finally { parent.abort(); await rm(root, { recursive: true, force: true }); }
});


it.skipIf(process.platform === 'win32').each(['intervening_owner', 'lost_ack', 'expiry', 'request_cancel'])('fresh owner acquisition fails closed after %s and cannot reuse its handoff', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'fresh-owner-')), parent = new AbortController(), request = new AbortController();
  try {
    const { engine, expected, candidate, prepared } = await freshFixture(root), clock = new AdmissionClock();
    let claiming = false;
    const controlled = { ...engine, sessionStore: {
      load: async (...args: Parameters<typeof engine.sessionStore.load>) => {
        const loaded = await engine.sessionStore.load(...args);
        if (claiming && scenario === 'expiry') clock.mono = 101;
        if (claiming && scenario === 'request_cancel') request.abort();
        return loaded;
      },
      append: (...args: Parameters<typeof engine.sessionStore.append>) => engine.sessionStore.append(...args).andThen(value =>
        claiming && scenario === 'lost_ack' ? errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'owner acknowledgement lost' }) : okAsync(value)),
    } };
    const authority = createFreshAdmissionAuthority(controlled, clock, parent.signal);
    const admitted = await authority.admit(root, expected, candidate.bytes, request.signal);
    if (admitted.kind !== 'fresh') throw new Error('no fresh handoff');
    if (scenario === 'intervening_owner') {
      const decoded = decodeAdmissionReservation(candidate.bytes, expected);
      if (decoded.kind !== 'validated') throw new Error('fixture');
      const result = await engine.gate.withHealthySessionLock(prepared.sessionId, lock => engine.sessionStore.append(lock, {
        events: [{ v: 1, kind: 'answer_host_recorded', sessionId: prepared.sessionId, scope: { runId: prepared.runId },
          eventId: engine.idFactory.mintEventId(), eventIndex: decoded.reservation.plan.events.length, timestampMs: 1000,
          dedupeKey: `answer_host:${prepared.sessionId}:${decoded.reservation.plan.events.length}`, data: { kind: 'owner_acquired', epoch: '1' } }], snapshotPins: [],
      }));
      expect(result.isOk()).toBe(true);
    }
    const before = await engine.sessionStore.load(prepared.sessionId);
    claiming = true;
    const result = await authority.claim(admitted.handoff, request.signal);
    expect(result).toEqual(scenario === 'intervening_owner' ? { kind: 'refused', reason: 'journal_changed' }
      : scenario === 'expiry' ? { kind: 'unconfirmed', reason: 'deadline_stopped', deadlineReason: 'expired' }
      : { kind: 'unconfirmed', reason: 'storage_unavailable' });
    expect(await authority.claim(admitted.handoff, new AbortController().signal)).toEqual({ kind: 'refused', reason: 'invalid_handoff' });
    const after = await engine.sessionStore.load(prepared.sessionId);
    if (after.isErr()) throw new Error('load');
    expect(after.value.events.filter(e => e.kind === 'answer_host_recorded' && e.data.kind === 'owner_acquired'))
      .toHaveLength(scenario === 'lost_ack' || scenario === 'intervening_owner' ? 1 : 0);
    if (scenario !== 'lost_ack') expect(after).toEqual(before);
    expect(clock.timers.size).toBe(0); authority.close();
  } finally { parent.abort(); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('concurrent claims grant exactly one canonical first owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fresh-owner-race-')), parent = new AbortController();
  try {
    const { engine, expected, candidate, prepared } = await freshFixture(root), clock = new AdmissionClock();
    const authority = createFreshAdmissionAuthority(engine, clock, parent.signal), signal = new AbortController().signal;
    const admitted = await authority.admit(root, expected, candidate.bytes, signal);
    if (admitted.kind !== 'fresh') throw new Error('missing handoff');
    const results = await Promise.all([1, 2].map(() => authority.claim(admitted.handoff, signal)));
    expect(results.map(r => r.kind).sort()).toEqual(['owned', 'refused']);
    const owned = results.find(r => r.kind === 'owned');
    if (!owned || owned.kind !== 'owned') throw new Error('no owner');
    expect(owned.owner.epoch).toBe(1n);
    expect(owned.owner.execution).toBe(prepared.sessionId);
    const state = await readHostState(engine, owned.enrollment);
    expect(state.kind).toBe('loaded');
    if (state.kind === 'loaded') expect([state.state.epoch, state.state.owned]).toEqual([1n, true]);
    authority.close(); expect(owned.deadline.signal.aborted).toBe(true); expect(clock.timers.size).toBe(0);
  } finally { parent.abort(); await rm(root, { recursive: true, force: true }); }
});


it.skipIf(process.platform === 'win32')('expiry discovered before the owner lock retains its reason and writes no owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fresh-owner-expired-')), parent = new AbortController();
  try {
    const { engine, expected, candidate, prepared } = await freshFixture(root), clock = new AdmissionClock();
    const authority = createFreshAdmissionAuthority(engine, clock, parent.signal), signal = new AbortController().signal;
    const admitted = await authority.admit(root, expected, candidate.bytes, signal);
    if (admitted.kind !== 'fresh') throw new Error('missing handoff');
    const before = await engine.sessionStore.load(prepared.sessionId);
    clock.mono = 101;
    expect(await authority.claim(admitted.handoff, signal)).toEqual({ kind: 'unconfirmed', reason: 'deadline_stopped', deadlineReason: 'expired' });
    expect(await engine.sessionStore.load(prepared.sessionId)).toEqual(before);
    expect(clock.timers.size).toBe(0); authority.close();
  } finally { parent.abort(); await rm(root, { recursive: true, force: true }); }
});


it.skipIf(process.platform === 'win32').each(['two_turns', 'expired_idle', 'expired_model', 'expired_commit', 'shutdown'])('claimed deadline bounds the actual execution runner through %s', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'deadline-runner-')), parent = new AbortController();
  try {
    const { engine, expected, candidate, prepared, config } = await freshFixture(root, 2), clock = new AdmissionClock();
    const authority = createFreshAdmissionAuthority(engine, clock, parent.signal), signal = new AbortController().signal;
    const admitted = await authority.admit(root, expected, candidate.bytes, signal);
    if (admitted.kind !== 'fresh') throw new Error('no admission');
    const claimed = await authority.claim(admitted.handoff, signal);
    if (claimed.kind !== 'owned') throw new Error('no ownership');
    let generations = 0;
    let observedModelSignal: AbortSignal | undefined;
    const runnerConfig: AnswerHostConfig = { ...config,
      faultSeam: { async intercept(boundary) {
        if (scenario === 'expired_commit' && boundary === 'before_engine_transaction') clock.mono = 101;
        return { kind: 'proceed' };
      } },
      model: { async generate(_input, modelSignal) {
        generations++;
        if (scenario === 'expired_model') {
          clock.mono = 101;
          for (const wake of [...clock.timers]) { clock.timers.delete(wake); wake(); }
          observedModelSignal = modelSignal;
          return { kind: 'cancelled' };
        }
        return { kind: 'completed', response: { responseText: '', calls: [{ id: `answer-${generations}`, name: 'answer_work',
          argumentsJson: JSON.stringify({ answer: { notes: 'retained notes' } }) }] } };
      } },
    };
    const runner = createExecutionRunner(engine, runnerConfig, claimed.enrollment, claimed.owner, parent.signal, p => p,
      { kind: 'deadline', deadline: claimed.deadline });
    if (scenario === 'shutdown') parent.abort();
    const first = await runner.runTurn(signal);
    if (scenario === 'two_turns' || scenario === 'expired_idle') {
      expect(first.kind).toBe('advanced');
      clock.mono = scenario === 'two_turns' ? 40 : 101;
      clock.wall = 500; // Idle wall rollback must not reset monotonic execution budget.
      if (scenario === 'two_turns') expect(claimed.deadline.check()).toEqual({ kind: 'active', remainingMs: 60 });
      const second = await runner.runTurn(signal);
      expect(second.kind).toBe(scenario === 'two_turns' ? 'advanced' : 'cancelled');
      if (scenario === 'two_turns' && second.kind === 'advanced') expect(second.nextView.kind).toBe('finished');
      expect(generations).toBe(scenario === 'two_turns' ? 2 : 1);
    } else {
      expect(first.kind).not.toBe('advanced');
      expect(generations).toBe(scenario === 'shutdown' ? 0 : 1);
    }
    const loaded = await engine.sessionStore.load(prepared.sessionId);
    if (loaded.isErr()) throw new Error('load failed');
    const records = loaded.value.events.filter(e => e.kind === 'answer_host_recorded');
    expect(records.filter(e => e.data.kind === 'committed')).toHaveLength(scenario === 'two_turns' ? 2 : scenario === 'expired_idle' ? 1 : 0);
    if (scenario === 'expired_model') {
      expect(observedModelSignal?.aborted).toBe(true);
      expect(records.filter(e => e.data.kind === 'captured')).toHaveLength(0);
    }
    expect(claimed.deadline.signal.aborted).toBe(true);
    expect(clock.timers.size).toBe(0);
    authority.close();
  } finally { parent.abort(); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32').each(['normal', 'intent_ack', 'outcome_ack', 'cancelled'] as const)(
  'journals workspace effects without replay after %s', async failure => {
    const { reserveWorkspaceEffect, retainWorkspaceEffect } = await import('../../../src/answer-v1/workspace-effect-journal.js');
    const { foldWorkspaceEffects } = await import('../../../src/answer-v1/workspace-effect-state.js');
    const root = await mkdtemp(join(tmpdir(), 'workspace-effect-journal-'));
    const controller = new AbortController();
    const signal = controller.signal;
    try {
      const { engine, prepared, expected, candidate, config } = await setup(root);
      const admitted = await publishAndReconcileHostAdmission(engine, root, expected, candidate.bytes, signal);
      if (admitted.kind !== 'admitted') throw new Error(admitted.kind);
      const hostConfig: AnswerHostConfig = { ...config, model: { async generate() { return {kind:'unavailable',detail:'unused'}; } } };
      const host = await createAnswerHost(hostConfig, signal);
      if (host.kind !== 'created') throw new Error(host.kind);
      try {
        const hydrated = await host.scheduler.hydrator.hydrate(admitted.pointer, signal);
        if (hydrated.kind !== 'hydrated') throw new Error(hydrated.kind);
        const journal = new SessionJournal(engine, hydrated.enrollment, hostConfig, s => !s.aborted);
        const owner = {execution:hydrated.enrollment.execution,epoch:1n} as OwnerFence;
        expect(await journal.locked(signal, false, (state, lock) => journal.append(state,lock,{kind:'owner_acquired',epoch:'1'},signal))).toBe(true);
        const loaded = await readHostState(engine, hydrated.enrollment);
        if (loaded.kind !== 'loaded') throw new Error(loaded.kind);
        const view = await workView(engine,loaded.state);
        if (view.kind !== 'question') throw new Error(view.kind);
        const delivery = await journal.appendDelivery(view.reply,owner,signal);
        if (delivery.kind !== 'delivered') throw new Error(delivery.kind);
        // Seed a trusted provider reservation; this test exercises the effect journal only.
        expect(await journal.locked(signal,false,(state,lock)=>journal.append(state,lock,
          {kind:'model_call_reserved',delivery:delivery.delivery,call:'model1',epoch:'1',ordinal:1},signal))).toBe(true);
        const faulted = new SessionJournal(engine,hydrated.enrollment,{...hostConfig,faultSeam:{async intercept(boundary){
          return (failure === 'intent_ack' && boundary === 'after_effect_intent_append')
            || (failure === 'outcome_ack' && boundary === 'after_effect_outcome_append')
            ? {kind:'simulate_uncertain',message:'lost ack'} : {kind:'proceed'};
        }}},s=>!s.aborted);
        const input = {delivery:delivery.delivery,modelCall:'model1',toolCallId:'tool1',position:0,operation:'Write',inputDigest:'a'.repeat(64)};
        const before = await engine.sessionStore.load(prepared.sessionId);
        expect(await reserveWorkspaceEffect(journal,owner,{...input,operation:'unknown'},signal)).toMatchObject({kind:'refused',reason:'invalid_input'});
        expect(await engine.sessionStore.load(prepared.sessionId)).toEqual(before);
        if (failure === 'cancelled') controller.abort();
        const attempts = await Promise.all(Array.from({length: failure === 'normal' ? 2 : 1},
          () => reserveWorkspaceEffect(faulted,owner,input,signal)));
        if (failure === 'normal') expect(attempts.map(r=>r.kind).sort()).toEqual(['refused','reserved']);
        const admittedEffect = attempts.find(r=>r.kind === 'reserved') ?? attempts[0]!;
        let invoked = 0;
        if (admittedEffect.kind === 'reserved') {
          invoked++;
          const outcome = {kind:'workspace_effect_completed',effect:admittedEffect.effect,result:{content:'written',isError:false}};
          expect(await retainWorkspaceEffect(faulted,owner,outcome,signal)).toEqual(failure === 'outcome_ack'
            ? {kind:'unconfirmed',reason:'commit_uncertain'} : {kind:'retained'});
          expect(await retainWorkspaceEffect(journal,owner,outcome,signal)).toMatchObject({kind:'refused',reason:'invalid_transition'});
        } else expect(admittedEffect).toEqual(failure === 'cancelled'
          ? {kind:'refused',reason:'not_started'} : {kind:'unconfirmed',reason:'commit_uncertain'});
        expect(invoked).toBe(failure === 'intent_ack' || failure === 'cancelled' ? 0 : 1);
        const reopened = await composeAnswerEngine(config);
        if (reopened.kind !== 'ready') throw new Error(reopened.kind);
        const reloaded = await readHostState(reopened,hydrated.enrollment);
        if (reloaded.kind !== 'loaded') throw new Error(reloaded.kind);
        const projection = foldWorkspaceEffects(reloaded.state.records);
        expect(projection).toMatchObject({kind:'valid',effects:failure === 'cancelled' ? [] : [{kind:failure === 'intent_ack' ? 'pending':'completed'}]});
        if (failure !== 'cancelled') {
          const cold = new SessionJournal(reopened,hydrated.enrollment,hostConfig,s=>!s.aborted);
          if (failure === 'intent_ack') expect(await reserveModelCall(cold,delivery.delivery,owner,signal))
            .toEqual({kind:'refused',reason:'reconciliation_required'});
          expect(await reserveWorkspaceEffect(cold,owner,input,signal)).toMatchObject({kind:'refused',reason:'invalid_transition'});
          expect(await reserveWorkspaceEffect(cold,{...owner,epoch:2n},input,signal)).toMatchObject({kind:'refused',reason:'stale_owner'});
        }
      } finally { await host.scheduler.close(new AbortController().signal); }
    } finally { await rm(root,{recursive:true,force:true}); }
  });

it.skipIf(process.platform === 'win32').each(['success','duplicate','intent_ack','outcome_ack','throw','owner_change','cancel_after_effect','cancel_throw','cancel_after_reservation','typed_unknown','typed_refused'] as const)(
  'controls actual model tool batches through canonical effects: %s', async mode => {
    const { createWorkspaceEffectController } = await import('../../../src/daemon/runner/workspace-effect-controller.js');
    const { createDaemonAnswerModel } = await import('../../../src/daemon/runner/answer-model.js');
    const root = await mkdtemp(join(tmpdir(),'controlled-workspace-'));
    const signal = new AbortController().signal;
    const toolCancellation = new AbortController();
    try {
      const {engine,expected,candidate,config}=await setup(root);
      const admitted=await publishAndReconcileHostAdmission(engine,root,expected,candidate.bytes,signal);
      if(admitted.kind!=='admitted') throw new Error(admitted.kind);
      const hostConfig: AnswerHostConfig={...config,model:{async generate(){return {kind:'unavailable',detail:'unused'};}}};
      const host=await createAnswerHost(hostConfig,signal);
      if(host.kind!=='created') throw new Error(host.kind);
      try {
        const hydrated=await host.scheduler.hydrator.hydrate(admitted.pointer,signal);
        if(hydrated.kind!=='hydrated') throw new Error(hydrated.kind);
        const journal=new SessionJournal(engine,hydrated.enrollment,{...hostConfig,faultSeam:{async intercept(b){
          if(mode==='cancel_after_reservation'&&b==='after_effect_intent_append')toolCancellation.abort();
          return (mode==='intent_ack'&&b==='after_effect_intent_append')||(mode==='outcome_ack'&&b==='after_effect_outcome_append')
            ? {kind:'simulate_uncertain',message:'lost ack'}:{kind:'proceed'};
        }}},s=>!s.aborted);
        const owner={execution:hydrated.enrollment.execution,epoch:1n} as OwnerFence;
        await journal.locked(signal,false,(s,l)=>journal.append(s,l,{kind:'owner_acquired',epoch:'1'},signal));
        const state=await readHostState(engine,hydrated.enrollment);
        if(state.kind!=='loaded')throw new Error(state.kind);
        const view=await workView(engine,state.state);
        if(view.kind!=='question')throw new Error(view.kind);
        const delivery=await journal.appendDelivery(view.reply,owner,signal);
        if(delivery.kind!=='delivered')throw new Error(delivery.kind);
        await journal.locked(signal,false,(s,l)=>journal.append(s,l,{kind:'model_call_reserved',call:'m1',delivery:delivery.delivery,epoch:'1',ordinal:1},signal));
        const effects=createWorkspaceEffectController(journal,delivery.delivery,owner,
          mode==='typed_unknown'||mode==='typed_refused'?{async execute(){return mode==='typed_unknown'?{kind:'unknown'}:{kind:'refused',reason:'closed'};}}:undefined);
        let requests=0,invocations=0;
        const created=createDaemonAnswerModel({effects,provider:{async invoke(){
          requests++;
          const content=requests===1
            ? [{type:'tool_use' as const,id:'t1',name:'Write',input:{}},{type:'tool_use' as const,id:mode==='duplicate'?'t1':'t2',name:'Write',input:{}}]
            : [{type:'tool_use' as const,id:'answer',name:'answer_work',input:{answer:{notes:'done'}}}];
          return {kind:'completed',reservation:{call:'m1',ordinal:1},value:{id:'response',type:'message',role:'assistant',model:'fake',stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:1,output_tokens:1},content}};
        }},workspaceTools:[{name:'Write',label:'Write',description:'fake',inputSchema:{type:'object'},async execute(){
          invocations++;
          if(mode==='cancel_after_effect'||mode==='cancel_throw') {
            await writeFile(join(root,'effect-marker'),'written before cancellation');
            toolCancellation.abort();
            if(mode==='cancel_throw')throw new DOMException('cancelled','AbortError');
          }
          if(mode==='throw')throw new Error('uncertain write');
          if(mode==='owner_change') await journal.locked(signal,false,(s,l)=>journal.append(s,l,{kind:'owner_released',epoch:'1'},signal));
          return {content:[{type:'text',text:'written'}],details:null};
        }}],modelId:'fake',systemPrompt:'fake'});
        if(created.kind!=='created')throw new Error(created.kind);
        const result=await created.model.generate({instruction:'work',issues:[],retainedSummaries:[]},mode.startsWith('cancel_')?toolCancellation.signal:signal);
        if(mode.startsWith('cancel_')) {
          if(mode!=='cancel_after_reservation')
            expect(await readFile(join(root,'effect-marker'),'utf8')).toBe('written before cancellation');
          expect(result).toMatchObject({kind:'workspace_failed',failure:{reason:mode==='cancel_after_reservation'?'intent_unacknowledged':'execution_unknown'}});
          const retained=await readHostState(engine,hydrated.enrollment);
          if(retained.kind!=='loaded')throw new Error(retained.kind);
          const intents=retained.state.records.filter(r=>r.kind==='workspace_effect_intended');
          expect(intents).toHaveLength(1);
          // An unacknowledged reservation cannot grant the caller an effect identity.
          if(mode!=='cancel_after_reservation')expect(result).toMatchObject({failure:{effect:intents[0]!.effect}});
          expect(retained.state.records.some(r=>r.kind==='workspace_effect_completed')).toBe(false);
          // Aborted storage writes leave the intent pending in both return and throw paths.
          expect(retained.state.records.some(r=>r.kind==='workspace_effect_unconfirmed')).toBe(false);
        }
        expect(result.kind).toBe(mode==='success'?'completed':'workspace_failed');
        expect([requests,invocations]).toEqual(mode==='success'?[2,2]:mode==='duplicate'||mode==='intent_ack'||mode==='cancel_after_reservation'||mode==='typed_unknown'||mode==='typed_refused'?[1,0]:[1,1]);
        expect(await journal.recover(hydrated.enrollment,owner,signal)).toMatchObject({kind:'refused',reason:mode==='owner_change'?'stale_owner':'reconciliation_required'});
        if(mode==='success') {
          // Simulate a preexisting newer delivery with a captured answer. Older unfinished work must still block.
          await journal.locked(signal,false,(s,l)=>journal.append(s,l,{kind:'delivered',delivery:'newer',node:s.node,reply:view.reply,epoch:'1'},signal));
          await journal.locked(signal,false,(s,l)=>journal.append(s,l,{kind:'captured',delivery:'newer',response:'newer-answer',payload:{responseText:'done',calls:[]}},signal));
          expect(await journal.recover(hydrated.enrollment,owner,signal)).toMatchObject({kind:'refused',reason:'reconciliation_required'});
          expect(await journal.appendDelivery(view.reply,owner,signal)).toMatchObject({kind:'refused',reason:'reconciliation_required'});
          await journal.locked(signal,false,(s,l)=>journal.append(s,l,{kind:'stopped',reason:'cancelled',detail:'explicit stop'},signal));
          expect(await journal.recover(hydrated.enrollment,owner,signal)).toMatchObject({kind:'refused',reason:'stopped'});
        }
        if(mode!=='success') {
          // A fresh signal must not erase the delivery's prior failure, including cancellation.
          const again=await created.model.generate({instruction:'retry',issues:[],retainedSummaries:[]},signal);
          expect(again.kind).toBe('workspace_failed');
          expect(requests).toBe(1);
          expect(invocations).toBe(mode==='duplicate'||mode==='intent_ack'||mode==='cancel_after_reservation'||mode==='typed_unknown'||mode==='typed_refused'?0:1);
        }
      } finally {await host.scheduler.close(signal);}
    } finally {await rm(root,{recursive:true,force:true});}
  });

it.skipIf(process.platform === 'win32').each(['supervisor', 'enrollment'] as const)('validates %s records from canonical storage on cold read', async corruption => {
  const { foldSupervisor } = await import('../../../src/answer-v1/supervisor-state.js');
  const root = await mkdtemp(join(tmpdir(), 'supervisor-canonical-'));
  const signal = new AbortController().signal;
  try {
    const { engine, prepared, expected, candidate, config } = await setup(root);
    const admitted = await publishAndReconcileHostAdmission(engine,root,expected,candidate.bytes,signal);
    if (admitted.kind !== 'admitted') throw new Error(admitted.kind);
    const hostConfig = {...config,model:{async generate(){return {kind:'unavailable' as const,detail:'unused'};}}};
    const host = await createAnswerHost(hostConfig,signal);
    if(host.kind!=='created')throw new Error(host.kind);
    try {
      const hydrated = await host.scheduler.hydrator.hydrate(admitted.pointer,signal);
      if(hydrated.kind!=='hydrated')throw new Error(hydrated.kind);
      const journal = new SessionJournal(engine,hydrated.enrollment,hostConfig,s=>!s.aborted);
      // Trusted fixture uses the actual canonical append path; no supervisor adapter is registered.
      const append = (record: import('../../../src/v2/durable-core/schemas/session/answer-host.js').AnswerHostRecord) =>
        journal.locked(signal,false,(state,lock)=>journal.append(state,lock,record,signal));
      expect(await append({kind:'owner_acquired',epoch:'1'})).toBe(true);
      const intent = {kind:'supervisor_create_intended' as const,supervisor:'s',epoch:'1',configurationDigest:'a'.repeat(64)};
      expect(await append(intent)).toBe(true);
      const reopened=await composeAnswerEngine(config);
      if(reopened.kind!=='ready')throw new Error(reopened.kind);
      const pending=await readHostState(reopened,hydrated.enrollment);
      if(pending.kind!=='loaded')throw new Error(pending.kind);
      expect(foldSupervisor(pending.state.records)).toEqual({kind:'valid',state:{kind:'create_pending',intent}});
      const truth=await reopened.sessionStore.load(prepared.sessionId);
      if(truth.isErr())throw new Error(truth.error.code);
      expect(truth.value.events.filter(e=>e.kind==='answer_host_recorded'&&e.data.kind==='supervisor_create_intended')).toHaveLength(1);
      // Simulate semantically corrupt but schema-valid historical data, not a public writer.
      const corruptRecord = corruption === 'supervisor' ? {...intent,supervisor:'replacement'}
        : pending.state.records.find(record=>record.kind==='enrolled');
      if (!corruptRecord) throw new Error('Missing fixture enrollment');
      expect(await append(corruptRecord)).toBe(true);
      expect(await readHostState(reopened,hydrated.enrollment)).toMatchObject({kind:'unavailable',reason:'corrupt',
        detail:expect.stringContaining(corruption === 'supervisor' ? 'duplicate_intent' : 'Duplicate host enrollment')});
    } finally {await host.scheduler.close(signal);}
  } finally {await rm(root,{recursive:true,force:true});}
});

it.skipIf(process.platform === 'win32').each(['normal','intent_ack','transition_ack','start_ack','stop_ack','cancelled'] as const)(
  'fences canonical supervisor journal writes across %s and reopen', async failure => {
    const {reserveSupervisor,retainSupervisorTransition}=await import('../../../src/answer-v1/supervisor-journal.js');
    const {foldSupervisor}=await import('../../../src/answer-v1/supervisor-state.js');
    const root=await mkdtemp(join(tmpdir(),'supervisor-writes-'));
    const controller=new AbortController(),signal=controller.signal;
    try {
      const {engine,prepared,expected,candidate,config}=await setup(root);
      const admitted=await publishAndReconcileHostAdmission(engine,root,expected,candidate.bytes,signal);
      if(admitted.kind!=='admitted')throw new Error(admitted.kind);
      const hostConfig={...config,model:{async generate(){return {kind:'unavailable' as const,detail:'unused'};}}};
      const host=await createAnswerHost(hostConfig,signal);
      if(host.kind!=='created')throw new Error(host.kind);
      try {
        const hydrated=await host.scheduler.hydrator.hydrate(admitted.pointer,signal);
        if(hydrated.kind!=='hydrated')throw new Error(hydrated.kind);
        const journal=new SessionJournal(engine,hydrated.enrollment,hostConfig,s=>!s.aborted);
        const owner={execution:hydrated.enrollment.execution,epoch:1n} as OwnerFence;
        expect(await journal.locked(signal,false,(state,lock)=>journal.append(state,lock,{kind:'owner_acquired',epoch:'1'},signal))).toBe(true);
        let transitionAcknowledgments=0;
        const faulted=new SessionJournal(engine,hydrated.enrollment,{...hostConfig,faultSeam:{async intercept(boundary){
          if(boundary==='after_supervisor_transition_append')transitionAcknowledgments++;
          return (failure==='intent_ack'&&boundary==='after_supervisor_intent_append')
            ||(boundary==='after_supervisor_transition_append'&&((failure==='transition_ack'&&transitionAcknowledgments===1)
              ||(failure==='start_ack'&&transitionAcknowledgments===2)||(failure==='stop_ack'&&transitionAcknowledgments===4)))
            ? {kind:'simulate_uncertain',message:'lost ack'} : {kind:'proceed'};
        }}},s=>!s.aborted);
        const before=await engine.sessionStore.load(prepared.sessionId);
        expect(await reserveSupervisor(journal,owner,{configurationDigest:'bad'},signal)).toEqual({kind:'refused',reason:'invalid_input'});
        expect(await reserveSupervisor(journal,{...owner,epoch:2n},{configurationDigest:'a'.repeat(64)},signal)).toEqual({kind:'refused',reason:'stale_owner'});
        expect(await engine.sessionStore.load(prepared.sessionId)).toEqual(before);
        if(failure==='cancelled')controller.abort();
        const attempts=await Promise.all(Array.from({length:failure==='normal'?2:1},()=>reserveSupervisor(faulted,owner,{configurationDigest:'a'.repeat(64)},signal)));
        if(failure==='normal')expect(attempts.map(r=>r.kind).sort()).toEqual(['refused','reserved']);
        if(failure==='intent_ack')expect(attempts[0]).toEqual({kind:'unconfirmed',reason:'commit_uncertain'});
        if(failure==='cancelled')expect(attempts[0]).toEqual({kind:'refused',reason:'not_started'});
        const reserved=attempts.find(r=>r.kind==='reserved');
        if(reserved?.kind==='reserved') {
          const created={kind:'supervisor_created',supervisor:reserved.supervisor,binding:{daemon:'d',environment:'exact'}};
          expect(await retainSupervisorTransition(faulted,owner,created,signal)).toEqual(failure==='transition_ack'?{kind:'unconfirmed',reason:'commit_uncertain'}:{kind:'retained'});
          expect(await retainSupervisorTransition(journal,owner,created,signal)).toEqual({kind:'refused',reason:'invalid_transition'});
          if(failure==='start_ack'||failure==='stop_ack') {
            expect(await retainSupervisorTransition(faulted,owner,{...created,kind:'supervisor_start_intended'},signal)).toEqual(failure==='start_ack'?{kind:'unconfirmed',reason:'commit_uncertain'}:{kind:'retained'});
            if(failure==='stop_ack') {
              expect(await retainSupervisorTransition(faulted,owner,{...created,kind:'supervisor_started'},signal)).toEqual({kind:'retained'});
              expect(await retainSupervisorTransition(faulted,owner,{...created,kind:'supervisor_stop_intended'},signal)).toEqual({kind:'unconfirmed',reason:'commit_uncertain'});
            }
          }
          if(failure==='normal') {
            const start={...created,kind:'supervisor_start_intended'};
            expect(await retainSupervisorTransition(journal,owner,{...start,binding:{daemon:'d',environment:'replacement'}},signal)).toEqual({kind:'refused',reason:'invalid_transition'});
            expect(await retainSupervisorTransition(journal,{...owner,epoch:2n},start,signal)).toEqual({kind:'refused',reason:'stale_owner'});
            expect((await Promise.all([1,2].map(()=>retainSupervisorTransition(journal,owner,start,signal)))).map(r=>r.kind).sort()).toEqual(['refused','retained']);
            const {beginSupervisorCleanup}=await import('../../../src/answer-v1/supervisor-cleanup.js');
            let elapsed=0;
            const clock={read:()=>({kind:'reading' as const,wallMs:1000+elapsed,monotonicMs:elapsed}),
              schedule:()=>({kind:'scheduled' as const,cancel(){}})};
            const bounded=beginSupervisorCleanup(journal,owner,reserved.supervisor,created.binding,signal,clock);
            expect(bounded).toBeDefined();
            const beforeExpiry=await engine.sessionStore.load(prepared.sessionId);
            elapsed=30000;
            expect(await bounded!.retainStopIntent()).toEqual({kind:'unconfirmed',reason:'commit_uncertain'});
            expect(bounded!.signal.aborted).toBe(true);
            expect(await engine.sessionStore.load(prepared.sessionId)).toEqual(beforeExpiry);
            bounded!.close();
            const cancelled=new AbortController();cancelled.abort();
            expect(beginSupervisorCleanup(journal,owner,reserved.supervisor,created.binding,cancelled.signal,clock)).toBeUndefined();

          }
        }
        const reopened=await composeAnswerEngine(config);
        if(reopened.kind!=='ready')throw new Error(reopened.kind);
        const loaded=await readHostState(reopened,hydrated.enrollment);
        if(loaded.kind!=='loaded')throw new Error(loaded.kind);
        expect(foldSupervisor(loaded.state.records)).toMatchObject({kind:'valid',state:{kind:
          failure==='cancelled'?'absent':failure==='intent_ack'?'create_pending':failure==='normal'||failure==='start_ack'?'start_pending':failure==='stop_ack'?'stop_pending':'created'}});
        const coldSignal=new AbortController().signal;
        const cold=new SessionJournal(reopened,hydrated.enrollment,hostConfig,s=>!s.aborted);
        if(failure!=='cancelled')expect(await reserveSupervisor(cold,owner,{configurationDigest:'a'.repeat(64)},coldSignal)).toEqual({kind:'refused',reason:'invalid_transition'});
        if(reserved?.kind==='reserved') {
          const duplicateKind=failure==='transition_ack'?'supervisor_created':failure==='stop_ack'?'supervisor_stop_intended':'supervisor_start_intended';
          expect(await retainSupervisorTransition(cold,owner,{kind:duplicateKind,supervisor:reserved.supervisor,binding:{daemon:'d',environment:'exact'}},coldSignal)).toEqual({kind:'refused',reason:'invalid_transition'});
        }
      } finally {await host.scheduler.close(new AbortController().signal);}
    } finally {await rm(root,{recursive:true,force:true});}
  });

// Explicit local backend proof. Ordinary CI exercises the deterministic controller/channel
// suites without starting Docker or pulling an image. No provider credentials are involved.
it.skipIf(process.env.WORKRAIL_TEST_LINUX_SCRATCH !== '1').each([
  'success','cancel_after_effect','cancel_running','lost_reply','stale_owner','bootstrap_ack','create_reply_loss','deadline','expired_journal','symlink',
] as const)('composes canonical effects with an isolated Linux scratch backend: %s', async mode=>{
  const {DockerCli}=await import('../../../src/daemon/runner/linux-scratch/docker-cli.js');
  const {createLinuxScratchWorkspace}=await import('../../../src/daemon/runner/linux-scratch/workspace.js');
  const {createLinuxScratchAnswerModel}=await import('../../../src/daemon/runner/linux-scratch/answer-model.js');
  const {startExecutionDeadline,createSystemDeadlineClock}=await import('../../../src/answer-v1/execution-deadline.js');
  const root=await mkdtemp(join(tmpdir(),'linux-scratch-proof-'));
  const signal=new AbortController().signal,parent=new AbortController(),call=new AbortController();
  const docker=DockerCli.local(process.env.WORKRAIL_TEST_DOCKER_BINARY!,process.env.WORKRAIL_TEST_DOCKER_SOCKET!);
  if(!docker)throw new Error('Explicit absolute Docker binary/socket required');
  const createdIds:string[]=[];
  const observed={stream:docker.stream.bind(docker),async run(...args:Parameters<typeof docker.run>){
    const result=await docker.run(...args);
    if(args[0][0]==='create'&&result.kind==='completed'){
      createdIds.push(result.bytes.toString().trim());
      if(mode==='create_reply_loss')return {kind:'unknown' as const};
    }
    return result;
  }};
  const started=startExecutionDeadline({kind:'new_execution',expiresAtMs:Date.now()+60000},createSystemDeadlineClock(),parent.signal);
  if(started.kind!=='started')throw new Error(started.kind);
  try {
    const {engine,expected,candidate,config}=await setup(root);
    const admitted=await publishAndReconcileHostAdmission(engine,root,expected,candidate.bytes,signal);
    if(admitted.kind!=='admitted')throw new Error(admitted.kind);
    const hostConfig:AnswerHostConfig={...config,model:{async generate(){return {kind:'unavailable',detail:'fake only'};}}};
    const host=await createAnswerHost(hostConfig,signal);
    if(host.kind!=='created')throw new Error(host.kind);
    try {
      const hydrated=await host.scheduler.hydrator.hydrate(admitted.pointer,signal);
      if(hydrated.kind!=='hydrated')throw new Error(hydrated.kind);
      const journal=new SessionJournal(engine,hydrated.enrollment,{...hostConfig,faultSeam:{async intercept(b){
        return mode==='bootstrap_ack'&&b==='after_supervisor_intent_append'?{kind:'simulate_uncertain',message:'lost bootstrap ack'}:{kind:'proceed'};
      }}},s=>!s.aborted && (mode!=='expired_journal'||started.deadline.check().kind==='active'));
      const owner={execution:hydrated.enrollment.execution,epoch:1n} as OwnerFence;
      await journal.locked(signal,false,(s,l)=>journal.append(s,l,{kind:'owner_acquired',epoch:'1'},signal));
      const profile={kind:'linux_scratch',image:'python@sha256:eb5be8e5b4d0a159c237946bbdd06356dda5d19c30fc4f7843e8046d3a590333',platform:'linux/arm64',
        snapshot:{kind:'explicit_files',description:'Only this fixture text; no checkout files',files:[{path:'input.txt',text:'original'}]}};
      const created=await createLinuxScratchWorkspace({journal,owner,deadline:started.deadline,profile,docker:observed,artifactDirectory:join(root,'artifacts')});
      if(mode==='bootstrap_ack'||mode==='create_reply_loss'){
        expect(created).toMatchObject(mode==='bootstrap_ack'?{kind:'refused',reason:'intent_unacknowledged'}:{kind:'unknown',cleanup:'unconfirmed'});
        expect(createdIds).toHaveLength(mode==='bootstrap_ack'?0:1);
        const second=await createLinuxScratchWorkspace({journal,owner,deadline:started.deadline,profile,docker:observed,artifactDirectory:join(root,'artifacts')});
        expect(second.kind).toBe('refused');expect(createdIds).toHaveLength(mode==='bootstrap_ack'?0:1);return;
      }
      expect(created.kind).toBe('ready');if(created.kind!=='ready')throw new Error(JSON.stringify(created));
      const workspace=created.workspace;
      const state=await readHostState(engine,hydrated.enrollment);if(state.kind!=='loaded')throw new Error(state.kind);
      const view=await workView(engine,state.state);if(view.kind!=='question')throw new Error(view.kind);
      const delivery=await journal.appendDelivery(view.reply,owner,signal);if(delivery.kind!=='delivered')throw new Error(delivery.kind);
      let calls=0,toolCalls=0;
      const commands=mode==='success'?[
        {name:'Read',input:{path:'input.txt'}},{name:'Write',input:{path:'output.txt',content:'first'}},
        {name:'Edit',input:{path:'output.txt',old_string:'first',new_string:'final'}},
        {name:'Bash',input:{command:'test ! -w /proc/$PPID/fd/1 && id -u && cat output.txt'}},
        {name:'Glob',input:{pattern:'*.txt'}},{name:'Grep',input:{pattern:'final'}},{name:'Bash',input:{command:'exit 7'}},
      ]:mode==='symlink'?[{name:'Bash',input:{command:'mkdir links; ln -s /etc/passwd links/escape'}},{name:'Read',input:{path:'links/escape'}},{name:'Write',input:{path:'forbidden.txt',content:'must not happen'}}]:[mode==='cancel_running'?{name:'Bash',input:{command:'printf "effect happened" > marker.txt; sleep 30'}}:{name:'Write',input:{path:'marker.txt',content:'effect happened'}},{name:'Write',input:{path:'forbidden.txt',content:'must not happen'}}];
      const wrapped={...workspace,async execute(...args:Parameters<typeof workspace.execute>){
        toolCalls++;
        if(mode==='stale_owner')await journal.locked(signal,false,(s,l)=>journal.append(s,l,{kind:'owner_released',epoch:'1'},signal));
        if(mode==='deadline'||mode==='expired_journal')started.deadline.close();
        const pending=workspace.execute(...args);
        if(mode==='cancel_running'){
          const end=Date.now()+5000;let observed=false;
          while(Date.now()<end){
            const marker=await docker.run(['exec',createdIds[0]!,'cat','/workspace/marker.txt'],signal);
            if(marker.kind==='completed'&&marker.bytes.toString()==='effect happened'){observed=true;break;}
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          call.abort();expect(observed).toBe(true);
        }
        const result=await pending;
        if(mode==='cancel_after_effect')call.abort();
        // A fault at the real backend reply boundary after the actual side effect.
        return mode==='lost_reply'?{kind:'unknown' as const}:result;
      }};
      const model=createLinuxScratchAnswerModel(journal,delivery.delivery,owner,wrapped,{modelId:'fake',systemPrompt:'fixture',provider:{async invoke(params){
        if(calls===1&&mode==='success'){
          const last=params.messages.at(-1);
          expect(Array.isArray(last?.content)&&last.content.some(b=>b.type==='tool_result'&&b.is_error===true)).toBe(true);
        }
        calls++;
        await journal.locked(signal,false,(s,l)=>journal.append(s,l,{kind:'model_call_reserved',call:`model-${calls}`,delivery:delivery.delivery,epoch:'1',ordinal:calls},signal));
        return {kind:'completed',reservation:{call:`model-${calls}`,ordinal:calls},value:{id:`response-${calls}`,type:'message',role:'assistant',model:'fake',stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:1,output_tokens:1},
          content:calls===1?commands.map((c,i)=>({type:'tool_use' as const,id:`tool-${i}`,name:c.name,input:c.input})):[{type:'tool_use' as const,id:'answer',name:'answer_work',input:{answer:{notes:'scratch work done'}}}]}};
      }}});
      if(model.kind!=='created')throw new Error(model.kind);
      const result=await model.model.generate({instruction:'Exercise tools',issues:[],retainedSummaries:[]},call.signal);
      expect(result.kind).toBe(mode==='success'?'completed':'workspace_failed');
      expect(calls).toBe(mode==='success'?2:1);expect(toolCalls).toBe(mode==='success'?7:mode==='symlink'?2:1);
      if(mode!=='success'){
        expect((await model.model.generate({instruction:'retry',issues:[],retainedSummaries:[]},signal)).kind).toBe('workspace_failed');
        expect(calls).toBe(1);expect(toolCalls).toBe(mode==='symlink'?2:1);
      }
      const retained=await readHostState(engine,hydrated.enrollment);if(retained.kind!=='loaded')throw new Error(retained.kind);
      const effects=retained.state.records.filter(r=>r.kind==='workspace_effect_completed');
      expect(effects).toHaveLength(mode==='success'?7:mode==='symlink'?1:0);
      if(mode==='success')expect(effects.map(r=>r.result.content).join('\n')).toContain('65534\nfinal');
      if(mode==='cancel_after_effect'||mode==='cancel_running'||mode==='lost_reply'){
        const marker=await docker.run(['exec',createdIds[0]!,'cat','/workspace/marker.txt'],signal);
        expect(marker.kind==='completed'&&marker.bytes.toString()).toBe('effect happened');
      }
      if(mode==='expired_journal')expect(await journal.locked(signal,'unavailable',async()=> 'available')).toBe('unavailable');
      const final=await workspace.finish(signal);
      expect(final.cleanup).toBe(mode==='stale_owner'?'unconfirmed':'removed');
      if(mode==='success'){
        expect(final.inspection.kind).toBe('retained');
        if(final.inspection.kind==='retained'){
          const artifact=JSON.parse(await readFile(final.inspection.path,'utf8'));
          expect(artifact.format).toBe('workrail-scratch-observation-v1');
          expect(Buffer.from(artifact.files.find((f:{path:string})=>f.path==='output.txt').base64,'base64').toString()).toBe('final');
        }
      }
      expect(await workspace.execute('Read',{path:'input.txt'},signal)).toMatchObject({kind:'refused'});
    }finally{await host.scheduler.close(signal);}
  }finally{
    started.deadline.close();parent.abort();
    // Test operator cleanup is separate from runtime authority and only touches exact IDs
    // returned by this test's create calls. Never prune shared resources or use rm --force.
    for(const cid of createdIds){
      const present=await docker.run(['inspect',cid],signal);
      if(present.kind==='completed'){
        const metadata=JSON.parse(present.bytes.toString())[0];
        expect(metadata.Config.Labels['workrail.linux-scratch']).toBeTruthy();
        if(metadata.State.Running)expect((await docker.run(['stop','--time','1',cid],signal)).kind).toBe('completed');
        expect((await docker.run(['rm',cid],signal)).kind).toBe('completed');
      }
    }
    await rm(root,{recursive:true,force:true});
  }
},90000);

([
  'two_turns', 'correction', 'expired_idle', 'cancel', 'shutdown', 'credentials',
  'real_two_turns', 'real_expired_idle',
  'provider_unknown', 'call_timeout', 'workspace_unknown', 'capture_unknown', 'stale_owner', 'cleanup_unknown',
] as const).forEach(testCase => {
  const real = testCase.startsWith('real_');
  it.skipIf(process.platform === 'win32' || (real && process.env.WORKRAIL_TEST_LINUX_SCRATCH !== '1'))(
    `execution resource spans canonical deliveries and closes on ${testCase}`, async () => {
  const scenario = testCase === 'real_two_turns' ? 'two_turns' : testCase === 'real_expired_idle' ? 'expired_idle' : testCase;
  const { bindLinuxScratchExecution } = await import('../../../src/daemon/runner/linux-scratch/execution.js');
  const root = await mkdtemp(join(tmpdir(), 'execution-resource-'));
  const lifetime = new AbortController(), caller = new AbortController();
  // This matrix drives execution expiry through AdmissionClock. SDK/loop wall timers
  // are tested separately; do not let host load inject an unrelated 50ms call expiry.
  if (!real) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let operatorCleanup = async () => {};
  try {
    const { engine, expected, candidate, config } = await freshFixture(root, 2);
    const clock = new AdmissionClock(), authority = createFreshAdmissionAuthority(engine, clock, lifetime.signal);
    const signal = new AbortController().signal;
    const admitted = await authority.admit(root, expected, candidate.bytes, signal);
    if (admitted.kind !== 'fresh') throw new Error(admitted.kind);
    const claimed = await authority.claim(admitted.handoff, signal);
    if (claimed.kind !== 'owned') throw new Error(claimed.kind);
    let calls = 0, tools = 0, finishes = 0, correctionSent = false;
    let scratch = '';
    const active = new Set<Promise<unknown>>();
    const track = <T>(p: Promise<T>): Promise<T> => {
      active.add(p); void p.then(() => active.delete(p), () => active.delete(p)); return p;
    };
    let workspace: import('../../../src/daemon/runner/linux-scratch/workspace.js').LinuxScratchWorkspace = {
      supervisor: 'fake-resource',
      async execute(name: string, input: unknown) {
        tools++;
        if (scenario === 'workspace_unknown') return { kind: 'unknown' as const };
        if (name === 'Write') scratch = (input as { content: string }).content;
        else { expect(name).toBe('Read'); expect(scratch).toBe('survives next delivery'); }
        return { kind: 'completed' as const, text: scratch, isError: false };
      },
      async finish(cleanupSignal: AbortSignal) {
        finishes++;
        expect(cleanupSignal.aborted).toBe(false);
        return { inspection: { kind: 'unavailable' as const }, cleanup: scenario === 'cleanup_unknown' ? 'unconfirmed' as const : 'removed' as const };
      },
    };
    if (real) {
      const { DockerCli } = await import('../../../src/daemon/runner/linux-scratch/docker-cli.js');
      const { createLinuxScratchWorkspace } = await import('../../../src/daemon/runner/linux-scratch/workspace.js');
      const docker = DockerCli.local(process.env.WORKRAIL_TEST_DOCKER_BINARY!, process.env.WORKRAIL_TEST_DOCKER_SOCKET!);
      if (!docker) throw new Error('Explicit Docker binary and socket required');
      const ids: string[] = [];
      operatorCleanup = async () => {
        for (const id of ids) {
          if ((await docker.run(['inspect', id], signal)).kind === 'completed') {
            await docker.run(['stop', '--time', '1', id], signal);
            const inspected = await docker.run(['inspect', id], signal);
            if (inspected.kind === 'completed' && JSON.parse(inspected.bytes.toString())[0].State.Running === false)
              await docker.run(['rm', id], signal);
          }
        }
      };
      const journal = new SessionJournal(engine, claimed.enrollment, { ...config, model: { async generate() { return { kind: 'cancelled' }; } } },
        s => !s.aborted && claimed.deadline.check().kind === 'active');
      const created = await createLinuxScratchWorkspace({ journal, owner: claimed.owner, deadline: claimed.deadline,
        profile: { kind: 'linux_scratch', image: 'python@sha256:eb5be8e5b4d0a159c237946bbdd06356dda5d19c30fc4f7843e8046d3a590333',
          platform: 'linux/arm64', snapshot: { kind: 'explicit_files', description: 'Empty private lifecycle fixture', files: [] } },
        artifactDirectory: join(root, 'artifacts'), docker: { stream: docker.stream.bind(docker), async run(...args: Parameters<typeof docker.run>) {
          const result = await docker.run(...args);
          if (args[0][0] === 'create' && result.kind === 'completed') ids.push(result.bytes.toString().trim());
          return result;
        } } });
      if (created.kind !== 'ready') throw new Error(JSON.stringify(created));
      const ownedWorkspace = created.workspace;
      workspace = { ...ownedWorkspace, async execute(...args) { tools++; return ownedWorkspace.execute(...args); }, async finish(s) {
        finishes++; expect(s.aborted).toBe(false);
        const result = await ownedWorkspace.finish(s);
        expect(ids).toHaveLength(1);
        expect((await docker.run(['inspect', ids[0]!], signal)).kind).toBe('unknown');
        return result;
      } };
    }
    const fetch: NonNullable<import('@anthropic-ai/sdk/client').ClientOptions['fetch']> = async (_url, init) => {
        calls++;
        if (scenario === 'provider_unknown') throw new Error('lost provider response');
        const body = JSON.parse(String(init?.body));
        expect(JSON.stringify(body.messages)).toContain('Changes do not update the user checkout');
        expect(body.system).toBe('original prompt');
        const content = body.messages.at(-1)?.content;
        const toolResult = Array.isArray(content) ? content.find((b: { type: string }) => b.type === 'tool_result') : undefined;
        const responding = Boolean(toolResult);
        if (responding) expect(toolResult.is_error).not.toBe(true);
        if (responding && calls >= 4) expect(JSON.stringify(toolResult.content)).toContain('survives next delivery');
        const invalid = scenario === 'correction' && responding && !correctionSent;
        if (invalid) correctionSent = true;
        const name = responding || (scenario === 'correction' && correctionSent && calls === 3) ? 'answer_work' : calls === 1 ? 'Write' : 'Read';
        const input = name === 'answer_work' ? (invalid ? { answer: {} } : { answer: { notes: 'verified scratch' } })
          : name === 'Write' ? { path: 'state.txt', content: 'survives next delivery' } : { path: 'state.txt' };
        return new Response(JSON.stringify({ id: `response-${calls}`, type: 'message', role: 'assistant', model: 'original-model',
          content: [{ type: 'tool_use', id: `call-${calls}`, name, input }], stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
      };
    const runnerConfig: import('../../../src/answer-v1/contracts/host-composition.js').SharedAuthorityConfig & Pick<AnswerHostConfig, 'faultSeam'> = { ...config, faultSeam: { async intercept(boundary) {
      if (scenario === 'call_timeout' && boundary === 'after_model_call_append') await vi.advanceTimersByTimeAsync(50);
      return scenario === 'capture_unknown' && boundary === 'after_capture_append'
        ? { kind: 'simulate_uncertain', message: 'capture reply lost' } : { kind: 'proceed' };
    } } };
    const managed = bindLinuxScratchExecution({ engine, config: runnerConfig, enrollment: claimed.enrollment,
      owner: claimed.owner, deadline: claimed.deadline, workspace,
      credentials: { provider: 'anthropic', apiKey: scenario === 'credentials' ? '' : 'fixture' },
      fetch, lifetime: lifetime.signal, track });
    try {
      if (scenario === 'stale_owner') {
        const journal = new SessionJournal(engine, claimed.enrollment, { ...runnerConfig, model: { async generate() { return { kind: 'cancelled' }; } } }, s => !s.aborted);
        expect(await journal.locked(signal, false, (s, l) => journal.append(s, l, { kind: 'owner_acquired', epoch: '2' }, signal))).toBe(true);
      }
      if (scenario === 'cancel') caller.abort();
      if (scenario === 'shutdown') lifetime.abort();
      let first = await managed.runner.runTurn(caller.signal);
      if (scenario === 'correction') {
        expect(first.kind).toBe('rejected'); expect(finishes).toBe(0);
        first = await managed.runner.runTurn(signal);
      }
      if (['two_turns', 'correction', 'expired_idle', 'cleanup_unknown'].includes(scenario)) {
        expect(first.kind, JSON.stringify(first)).toBe('advanced'); expect(finishes).toBe(0);
        if (scenario === 'expired_idle') {
          clock.mono = 101;
          for (const wake of [...clock.timers]) { clock.timers.delete(wake); wake(); }
          // Expiry must initiate tracked cleanup without a subsequent turn or close call.
          await Promise.all([...active]); expect(finishes).toBe(1);
          expect((await managed.runner.runTurn(signal)).kind).toBe('cancelled');
          expect(calls).toBe(2);
        } else {
          clock.mono = 40;
          expect(claimed.deadline.check()).toEqual({ kind: 'active', remainingMs: 60 });
          const second = await managed.runner.runTurn(signal);
          expect(second).toMatchObject({ kind: 'advanced', nextView: { kind: 'finished' } });
          expect(tools).toBe(2); expect(calls).toBe(scenario === 'correction' ? 5 : 4);
        }
      } else expect(first.kind).not.toBe('advanced');
      if (scenario === 'call_timeout') {
        expect(first).toMatchObject({ kind: 'unconfirmed', uncertainty: { stage: 'model_call', failure: { reason: 'commit_uncertain' } } });
        expect(calls).toBe(0);
      }
      const { lifecycle: cleanup } = await managed.close();
      expect(cleanup.kind).toBe(scenario === 'cleanup_unknown' ? 'incomplete' : 'closed');
      expect(finishes).toBe(1);
      const previousCalls = calls;
      expect((await managed.runner.runTurn(signal)).kind).toBe('cancelled');
      expect(calls).toBe(previousCalls);
      const truth = await readHostState(engine, claimed.enrollment);
      if (truth.kind !== 'loaded') throw new Error(truth.kind);
      const reservations = truth.state.records.filter(r => r.kind === 'model_call_reserved');
      if (scenario === 'two_turns') {
        expect(reservations).toHaveLength(4);
        expect(new Set(reservations.map(r => r.delivery)).size).toBe(2);
        expect(truth.state.records.filter(r => r.kind === 'workspace_effect_completed')).toHaveLength(2);
      }
      expect(clock.timers.size).toBe(0);
    } finally { await managed.close(); authority.close(); }
  } finally { lifetime.abort(); if (!real) vi.useRealTimers(); await operatorCleanup(); await rm(root, { recursive: true, force: true }); }
});
});

(['preflight', 'throwing_preflight', 'unsupported', 'cancelled', 'cancel_after_claim', 'real_success', 'real_create_unknown', 'real_cancel_create'] as const).forEach(scenario => {
  const real = scenario.startsWith('real_');
  it.skipIf(process.platform === 'win32' || (real && process.env.WORKRAIL_TEST_LINUX_SCRATCH !== '1'))(
    `prepares only the retained scratch profile from fresh admission: ${scenario}`, async () => {
    const { prepareLinuxScratchExecution } = await import('../../../src/daemon/runner/linux-scratch/execution.js');
    const root = await mkdtemp(join(tmpdir(), 'scratch-preparation-'));
    const parent = new AbortController(), caller = new AbortController(), signal = new AbortController().signal;
    let operatorCleanup = async () => {};
    try {
      const fixture = await freshFixture(root);
      const profile = { kind: 'linux_scratch', image: 'python@sha256:eb5be8e5b4d0a159c237946bbdd06356dda5d19c30fc4f7843e8046d3a590333',
        platform: 'linux/arm64', snapshot: { kind: 'explicit_files', description: 'Only the named fixture content', files: [{ path: 'retained.txt', text: 'from admission' }] } };
      const parsed = decodeDaemonExecutionPolicy({ ...fixture.expected.request.daemonPolicy,
        workspace: scenario === 'unsupported' ? fixture.expected.request.daemonPolicy.workspace : profile });
      if (parsed.kind !== 'validated') throw new Error(parsed.kind);
      const expected = { ...fixture.expected, request: { ...fixture.expected.request, daemonPolicy: parsed.policy } };
      const candidate = buildHostAdmissionCandidate(fixture.prepared, expected.request, expected.operationId, fixture.engine, () => 1);
      if (candidate.kind !== 'candidate') throw new Error(candidate.kind);
      // Caller mutation cannot replace the decoded, retained snapshot.
      profile.snapshot.files[0]!.text = 'caller replacement';
      const authority = createFreshAdmissionAuthority(fixture.engine, new AdmissionClock(), parent.signal);
      const admitted = await authority.admit(root, expected, candidate.bytes, signal);
      if (admitted.kind !== 'fresh') throw new Error(admitted.kind);
      let dockerCalls = 0, providerCalls = 0;
      let docker: Pick<import('../../../src/daemon/runner/linux-scratch/docker-cli.js').DockerCli, 'run' | 'stream'> = {
        async run() { dockerCalls++; if (scenario === 'throwing_preflight') throw new Error('Unknown boundary result'); return { kind: 'unknown' }; }, stream() { throw new Error('No stream without successful preflight'); },
      };
      const ids: string[] = [];
      if (real) {
        const { DockerCli } = await import('../../../src/daemon/runner/linux-scratch/docker-cli.js');
        const backend = DockerCli.local(process.env.WORKRAIL_TEST_DOCKER_BINARY!, process.env.WORKRAIL_TEST_DOCKER_SOCKET!);
        if (!backend) throw new Error('Explicit Docker configuration required');
        docker = { stream: backend.stream.bind(backend), async run(...args) {
          dockerCalls++;
          const result = await backend.run(...args);
          if (args[0][0] === 'create' && result.kind === 'completed') {
            ids.push(result.bytes.toString().trim());
            if (scenario === 'real_cancel_create') caller.abort();
            if (scenario === 'real_create_unknown') return { kind: 'unknown' };
          }
          return result;
        } };
        operatorCleanup = async () => {
          for (const id of ids) {
            if ((await backend.run(['inspect', id], signal)).kind === 'completed') {
              await backend.run(['stop', '--time', '1', id], signal);
              const stopped = await backend.run(['inspect', id], signal);
              if (stopped.kind === 'completed' && JSON.parse(stopped.bytes.toString())[0].State.Running === false)
                await backend.run(['rm', id], signal);
            }
          }
        };
      }
      const options = { engine: fixture.engine, config: fixture.config, admission: { async claim(...args: Parameters<typeof authority.claim>) {
          const result = await authority.claim(...args);
          if (scenario === 'cancel_after_claim') caller.abort();
          return result;
        } }, handoff: admitted.handoff,
        docker, artifactDirectory: join(root, 'observations'), credentials: { provider: 'anthropic' as const, apiKey: 'fixture' },
        lifetime: parent.signal, track: <T>(p: Promise<T>) => p,
        fetch: (async (_url, init) => {
          providerCalls++;
          const body = JSON.parse(String(init?.body));
          if (providerCalls === 2) expect(JSON.stringify(body.messages.at(-1))).toContain('from admission');
          return new Response(JSON.stringify({ id: `response-${providerCalls}`, type: 'message', role: 'assistant', model: 'original-model',
            content: [{ type: 'tool_use', id: `call-${providerCalls}`, name: providerCalls === 1 ? 'Read' : 'answer_work',
              input: providerCalls === 1 ? { path: 'retained.txt' } : { answer: { notes: 'retained profile checked' } } }],
            stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
          { headers: { 'content-type': 'application/json' } });
        }) satisfies NonNullable<import('@anthropic-ai/sdk/client').ClientOptions['fetch']> };
      if (scenario === 'cancelled') caller.abort();
      const prepared = await prepareLinuxScratchExecution(options, caller.signal);
      if (scenario === 'real_success') {
        expect(prepared.kind).toBe('ready'); if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
        try {
          // The admission request's lifetime ends here, without cancelling the adopted execution.
          caller.abort();
          expect(await prepared.execution.runner.runTurn(signal)).toMatchObject({ kind: 'advanced', nextView: { kind: 'finished' } });
          expect(await prepared.execution.close()).toMatchObject({ lifecycle: { kind: 'closed' }, workspace: { cleanup: 'removed' } });
          expect(providerCalls).toBe(2); expect(ids).toHaveLength(1);
        } finally { await prepared.execution.close(); }
      } else {
        expect(prepared).toMatchObject(scenario === 'cancelled' ? { kind: 'admission_failed' }
          : { kind: 'not_prepared', outcome: scenario === 'unsupported' ? { kind: 'unsupported_profile' }
            : scenario === 'real_create_unknown' || scenario === 'real_cancel_create' ? { kind: 'unknown', cleanup: 'unconfirmed' }
            : scenario === 'throwing_preflight' ? { kind: 'boundary_unknown', cleanup: 'unconfirmed' }
            : { kind: 'refused', reason: scenario === 'cancel_after_claim' ? 'deadline_stopped' : 'preflight_failed' } });
        expect(providerCalls).toBe(0);
        if (scenario === 'unsupported' || scenario === 'cancelled' || scenario === 'cancel_after_claim') expect(dockerCalls).toBe(0);
        if (scenario === 'real_create_unknown' || scenario === 'real_cancel_create') expect(ids).toHaveLength(1);
      }
      const previous = dockerCalls;
      expect(await prepareLinuxScratchExecution(options, signal)).toMatchObject({ kind: 'admission_failed', result: { kind: 'refused', reason: 'invalid_handoff' } });
      expect(dockerCalls).toBe(previous);
      authority.close();
    } finally { parent.abort(); await operatorCleanup(); await rm(root, { recursive: true, force: true }); }
  });
});
