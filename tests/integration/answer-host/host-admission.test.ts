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
import { it, expect } from 'vitest';
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

it.skipIf(process.platform === 'win32').each(['success','duplicate','intent_ack','outcome_ack','throw','owner_change','cancel_after_effect','cancel_throw','cancel_after_reservation'] as const)(
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
        const effects=createWorkspaceEffectController(journal,delivery.delivery,owner);
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
        expect([requests,invocations]).toEqual(mode==='success'?[2,2]:mode==='duplicate'||mode==='intent_ack'||mode==='cancel_after_reservation'?[1,0]:[1,1]);
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
          expect(invocations).toBe(mode==='duplicate'||mode==='intent_ack'||mode==='cancel_after_reservation'?0:1);
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
