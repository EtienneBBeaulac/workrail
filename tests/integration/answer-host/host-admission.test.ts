import { SessionJournal } from '../../../src/answer-v1/journal.js';
import { readHostState, workView } from '../../../src/answer-v1/host-state.js';
import { bindBudgetedProvider, reserveModelCall } from '../../../src/answer-v1/model-call-budget.js';
import type { OwnerFence } from '../../../src/answer-v1/contracts/invocation-contract.js';
import { decodeDaemonExecutionPolicy } from '../../../src/answer-v1/daemon-policy.js';
import { errAsync } from 'neverthrow';
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

async function setup(root: string) {
  const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
    keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'workflow-source') };
  const engine = await composeAnswerEngine(config);
  if (engine.kind !== 'ready') throw new Error(engine.kind);
  const workflow = createWorkflow({ id: 'admission', name: 'Admission', description: 'Admission fixture', version: '1.0.0',
    steps: [{ id: 'first', title: 'First', prompt: 'Original' }] }, createUserDirectorySource(config.workflowStoragePath));
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
      expect(await firstCall).toEqual({ kind: 'completed', value: 'one' });
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
      if (successorDelivery.kind !== 'delivered') throw new Error(successorDelivery.kind);
      expect(await reserveModelCall(coldJournal, successorDelivery.delivery, owner, signal)).toEqual({ kind: 'refused', reason: 'budget_exhausted' });
      expect(await reserveModelCall(coldJournal, delivery.delivery, { ...owner, epoch: 2n }, signal)).toEqual({ kind: 'refused', reason: 'stale_owner' });
    } finally { await host.scheduler.close(signal); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
