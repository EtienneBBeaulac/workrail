import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { composeServer } from '../../../src/mcp/server.js';
import { createDaemonDeliveryModelFactory } from '../../../src/daemon/runner/delivery-answer-model.js';
import { createDaemonAnswerModel } from '../../../src/daemon/runner/answer-model.js';
import { createAnswerWorker } from '../../../src/answer-v1/worker.js';
import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAnswerHost } from '../../../src/answer-v1/host.js';
import { createHostDiscovery } from '../../../src/answer-v1/discovery.js';
import type { AnswerHostConfig } from '../../../src/answer-v1/contracts/host-composition.js';
const signal = () => AbortSignal.timeout(15000);
const response = (notes: string) => ({ responseText: '', calls: [{ id: 'answer', name: 'answer_work', argumentsJson: JSON.stringify({ answer: { notes } }) }] });
async function fixture(run: (config: AnswerHostConfig) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'answer-host-lifecycle-'));
    const config: AnswerHostConfig = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') }, keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'workflows'), model: { async generate() { return { kind: 'completed', response: response('second') }; } } };
    try {
        await mkdir(config.workflowStoragePath);
        await writeFile(join(config.workflowStoragePath, 'lifecycle.json'), JSON.stringify({ id: 'lifecycle', name: 'Lifecycle', description: 'Two observations', version: '1.0.0', steps: [{ id: 'one', title: 'First', prompt: 'First notes' }, { id: 'two', title: 'Second', prompt: 'Second notes' }] }));
        await run(config);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}
async function enroll(config: AnswerHostConfig) {
    const created = await createAnswerHost(config, signal());
    if (created.kind !== 'created')
        throw new Error(JSON.stringify(created));
    const enrolled = await created.scheduler.enroll({ workflowId: 'lifecycle', goal: 'test', workspacePath: config.workflowStoragePath }, signal());
    if (enrolled.kind !== 'enrolled' || enrolled.initialView.kind !== 'question')
        throw new Error(JSON.stringify(enrolled));
    return { scheduler: created.scheduler, enrolled, reply: enrolled.initialView.reply };
}
it('replays the original receipt view after later work finishes, without later receipts', () => fixture(async (config) => {
    const { scheduler, enrolled, reply } = await enroll(config);
    const ports = scheduler.bindDiagnosticPorts(enrolled.enrollment);
    const delivery = await ports.journal.appendDelivery(reply, enrolled.owner, signal());
    if (delivery.kind !== 'delivered')
        throw new Error(delivery.kind);
    const captured = await ports.journal.captureResponse(delivery.delivery, response('first'), enrolled.owner, signal());
    if (captured.kind !== 'captured')
        throw new Error(captured.kind);
    const prepared = await ports.journal.prepare(captured.response, enrolled.owner, signal());
    if (prepared.kind !== 'prepared')
        throw new Error(prepared.kind);
    const first = await ports.dispatcher.dispatch(prepared.answer, enrolled.owner, signal());
    if (first.kind !== 'recorded' || first.view.kind !== 'question')
        throw new Error(first.kind);
    const { reply: _reply, ...original } = first.view;
    expect((await enrolled.runner.runTurn(signal())).kind).toBe('advanced');
    expect(await ports.dispatcher.dispatch(prepared.answer, enrolled.owner, signal())).toEqual({ kind: 'replay', receipt: first.receipt, original });
    expect(await scheduler.close(signal())).toEqual({ kind: 'closed' });
}));
it('close reports a held diagnostic operation until it settles and prevents its write', () => fixture(async (config) => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const { scheduler, enrolled, reply } = await enroll({ ...config, faultSeam: { async intercept(boundary) {
                if (boundary === 'before_delivery_append') {
                    enter();
                    await held;
                }
                return { kind: 'proceed' };
            } } });
    const pending = scheduler.bindDiagnosticPorts(enrolled.enrollment).journal.appendDelivery(reply, enrolled.owner, signal());
    await entered;
    expect(await scheduler.close(signal())).toMatchObject({ kind: 'incomplete', reason: 'work_in_flight' });
    release();
    expect(await pending).toEqual({ kind: 'refused', reason: 'storage_unavailable' });
    expect(await scheduler.close(signal())).toEqual({ kind: 'closed' });
}));
it('a thrown model error is not reported as a storage failure', () => fixture(async (config) => {
    const { scheduler, enrolled } = await enroll({ ...config, model: { async generate() { throw new Error('model transport failed'); } } });
    expect(await enrolled.runner.runTurn(signal())).toMatchObject({ kind: 'refused', reason: 'model_unavailable' });
    await scheduler.close(signal());
}));
it('discovery reads without creating missing authority and retries a missing root', () => fixture(async (config) => {
    const { model: _model, ...authority } = config;
    expect(await createHostDiscovery(authority, signal())).toMatchObject({ kind: 'refused', reason: 'missing_authority' });
    await expect(readFile(config.keyringPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const { scheduler, enrolled } = await enroll(config);
    const created = await createHostDiscovery(authority, signal());
    if (created.kind !== 'created')
        throw new Error(created.kind);
    const backup = config.storage.journalRootDir + '-saved';
    await rename(config.storage.journalRootDir, backup);
    expect(await created.scanner.scan(undefined, signal())).toMatchObject({ kind: 'unavailable', reason: 'missing' });
    await rename(backup, config.storage.journalRootDir);
    const scan = await created.scanner.scan(undefined, signal());
    expect(scan).toMatchObject({ kind: 'page', page: { kind: 'end', entries: [{ kind: 'host', pointer: scheduler.hydrator.dehydrate(enrolled.enrollment) }] } });
    await created.scanner.close(signal());
    await scheduler.close(signal());
}));
it('unbound workers refuse active and released host sessions, and recover their own notes', () => fixture(async (config) => {
    const { scheduler, enrolled, reply } = await enroll(config);
    const created = await createAnswerWorker(config, signal());
    if (created.kind !== 'created')
        throw new Error(created.kind);
    expect(await created.worker.answer(reply, { kind: 'notes', notes: 'foreign' }, signal())).toEqual({ kind: 'not_retained', reason: 'bound_session_required' });
    await scheduler.releaseOwnership(enrolled.enrollment, enrolled.owner, signal());
    expect(await created.worker.answer(reply, { kind: 'notes', notes: 'foreign' }, signal())).toEqual({ kind: 'not_retained', reason: 'bound_session_required' });
    const opened = await created.opener.open({ workflowId: 'lifecycle', goal: 'worker', workspacePath: config.workflowStoragePath }, signal());
    if (opened.kind !== 'opened' || opened.view.kind !== 'question')
        throw new Error(opened.kind);
    const first = await created.worker.answer(opened.view.reply, { kind: 'notes', notes: 'one' }, signal());
    if (first.kind !== 'recorded' || first.view.kind !== 'question')
        throw new Error(first.kind);
    expect(await created.inspector.inspectReceipt(opened.view.read.replace(/\.[^.]+$/,'.forged') as typeof opened.view.read,first.receipt,signal())).toEqual({kind:'refused',reason:'invalid_scope'});
    expect(await created.inspector.inspectReceipt(opened.recovery as unknown as typeof opened.view.read,first.receipt,signal())).toEqual({kind:'refused',reason:'invalid_scope'});
    const cancelled=new AbortController();cancelled.abort();
    expect(await created.inspector.inspect(opened.view.read,cancelled.signal)).toEqual({kind:'unavailable',reason:'cancelled'});
    await created.close(signal());
    const fresh = await createAnswerWorker(config, signal());
    if (fresh.kind !== 'created')
        throw new Error(fresh.kind);
    expect(await fresh.recovery.recover(opened.recovery, signal())).toEqual(first.view);
    expect(await fresh.worker.answer(opened.view.reply, { kind: 'notes', notes: 'one' }, signal())).toMatchObject({ kind: 'replay', receipt: first.receipt });
    expect(await fresh.worker.answer(opened.view.reply, { kind: 'notes', notes: 'changed' }, signal())).toMatchObject({ kind: 'conflict', original: first.receipt });
    expect(await fresh.worker.answer(first.view.reply, { kind: 'notes', notes: 'two' }, signal())).toMatchObject({ kind: 'recorded', view: { kind: 'finished' } });
    expect(await fresh.inspector.inspect(enrolled.initialView.read, signal())).toMatchObject({ kind: 'unavailable', reason: 'bound_session_required' });
    await fresh.close(signal());
    await scheduler.close(signal());
}));

type AnswerTransport = Readonly<{
  client: Client;
  composed: Awaited<ReturnType<typeof composeServer>>;
  call(name: string, args: Record<string, unknown>): Promise<any>;
}>;
async function withAnswerTransport(config: AnswerHostConfig, run: (transport: AnswerTransport) => Promise<void>) {
  const oldProfile = process.env.WORKRAIL_AGENT_PROFILE;
  process.env.WORKRAIL_AGENT_PROFILE = 'answers';
  const client = new Client({ name: 'answer-boundary', version: '1' });
  let composed: Awaited<ReturnType<typeof composeServer>> | undefined;
  try {
    const { model: _model, ...answerAuthority } = config;
    composed = await composeServer({ answerAuthority });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), composed.server.connect(serverTransport)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const content = result.content as { type: string; text: string }[];
      return JSON.parse(content[0]!.text);
    };
    await run({ client, composed, call });
  } finally {
    try { await client.close(); await composed?.server.close(); }
    finally { if (oldProfile === undefined) delete process.env.WORKRAIL_AGENT_PROFILE; else process.env.WORKRAIL_AGENT_PROFILE = oldProfile; }
  }
}

it('MCP exposes only answer tools and preserves host isolation through the transport', () => fixture(async config => {
  const { scheduler, reply } = await enroll(config);
  try { await withAnswerTransport(config, async ({ client, call }) => {
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['answer_work', 'inspect_work', 'open_work', 'recover_work']);
    expect(await call('answer_work', { reply, answer: { notes: 'foreign' } })).toEqual({ kind: 'not_retained', reason: 'bound_session_required' });
    const opened = await call('open_work', { workflowId: 'lifecycle', goal: 'transport', workspacePath: config.workflowStoragePath });
    const first = await call('answer_work', { reply: opened.view.reply, answer: { notes: 'first' } });
    expect(first).toMatchObject({ kind: 'recorded', view: { kind: 'question' } });
    expect(await call('inspect_work', { read: first.view.read })).not.toHaveProperty('reply');
    expect(await call('answer_work', { reply: first.view.reply, answer: { notes: 'last' } })).toMatchObject({ kind: 'recorded', view: { kind: 'finished' } });
  }); } finally { await scheduler.close(signal()); }
}));

it.each([{ notes: 42, unknownField: 'kept' }, { notes: 'attempt', approval: true }, JSON.parse('{"notes":42,"__proto__":{"retained":true}}'), null, ['unexpected']].map(value => ({ value })))(
  'MCP preserves invalid JSON and completes after correction: %j', ({ value: invalid }) => fixture(config => withAnswerTransport(config, async ({ call }) => {
    const work = await call('open_work', { workflowId: 'lifecycle', goal: 'rejection', workspacePath: config.workflowStoragePath });
    const rejected = await call('answer_work', { reply: work.view.reply, answer: invalid });
    expect(rejected).toMatchObject({ kind: 'recorded', disposition: 'rejected', view: { kind: 'question', instruction: work.view.instruction } });
    const receipt = await call('inspect_work', { read: rejected.view.read, receipt: rejected.receipt });
    expect(receipt).toMatchObject({ kind: 'complete', disposition: 'rejected', encoding: 'canonical_json' });
    expect(JSON.parse(receipt.chunk)).toEqual(invalid);
    const repaired = await call('answer_work', { reply: rejected.view.reply, answer: { notes: 'valid correction' } });
    expect(repaired).toMatchObject({ kind: 'recorded', disposition: 'accepted', view: { kind: 'question' } });
    expect(await call('answer_work', { reply: repaired.view.reply, answer: { notes: 'last' } })).toMatchObject({ kind: 'recorded', view: { kind: 'finished' } });
  })));

it('MCP shutdown drains accepted requests and refuses new requests', () => fixture(config => withAnswerTransport(config, async ({ client, composed }) => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  composed.handlers.inspect_work = async () => { enter(); await blocked; return { content: [{ type: 'text', text: 'retained' }] }; };
  const pending = client.callTool({ name: 'inspect_work', arguments: { read: 'retained-read' } });
  await entered;
  let drained = false;
  const closing = composed.closeRequests().then(() => { drained = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(drained).toBe(false);
    expect((await client.callTool({ name: 'inspect_work', arguments: { read: 'retained-read' } })).isError).toBe(true);
  } finally { release(); await pending; await closing; }
})));

it.each(['missing','foreign','stale','released','stopped','cleanup','cleanup_epoch'] as const)('legacy engine advancement cannot bypass %s answer ownership',mode=>fixture(async config=>{
  const {scheduler,enrolled}=await enroll(config);
  if(mode==='released')await scheduler.releaseOwnership(enrolled.enrollment,enrolled.owner,signal());
  if(mode==='stopped')await scheduler.bindDiagnosticPorts(enrolled.enrollment).journal.commitStop(enrolled.owner,'cancelled','test stop',signal());
  const answerOwner=mode==='missing'?undefined:mode==='foreign'?{...enrolled.owner,execution:'sess_foreign' as typeof enrolled.owner.execution}:(mode==='stale'||mode==='cleanup_epoch')?{...enrolled.owner,epoch:enrolled.owner.epoch+1n}:enrolled.owner;
  const {composeAnswerEngine}=await import('../../../src/answer-v1/engine-composition.js');
  const {readHostState}=await import('../../../src/answer-v1/host-state.js');
  const {executeAdvanceCore}=await import('../../../src/mcp/handlers/v2-advance-core/index.js');
  const {asSessionId,asRunId,asNodeId}=await import('../../../src/v2/durable-core/ids/index.js');
  const {asSortedEventLog}=await import('../../../src/v2/durable-core/sorted-event-log.js');
  const {buildSessionIndex}=await import('../../../src/v2/durable-core/session-index.js');
  const {getCachedWorkflow}=await import('../../../src/v2/usecases/workflow-object-cache.js');
  const {hasWorkflowDefinitionShape}=await import('../../../src/types/workflow-definition.js');
  const engine=await composeAnswerEngine(config);
  if(engine.kind!=='ready')throw new Error(engine.kind);
  if (mode === 'cleanup' || mode === 'cleanup_epoch') {
    const { SessionJournal } = await import('../../../src/answer-v1/journal.js');
    const { reserveSupervisor } = await import('../../../src/answer-v1/supervisor-journal.js');
    const { claimCleanupOwnership } = await import('../../../src/answer-v1/cleanup-ownership.js');
    const journal = new SessionJournal(engine, enrolled.enrollment, {}, s => !s.aborted);
    const reserved = await reserveSupervisor(journal, enrolled.owner, { configurationDigest: 'a'.repeat(64), daemon: 'fixture' }, signal());
    if (reserved.kind !== 'reserved') throw new Error(reserved.kind);
    expect((await claimCleanupOwnership(journal, enrolled.owner, reserved.supervisor, signal())).kind).toBe('claimed');
  }
  const loaded=await readHostState(engine,enrolled.enrollment);
  if(loaded.kind!=='loaded')throw new Error(loaded.kind);
  const state=loaded.state;
  const node=state.truth.events.find(e=>e.kind==='node_created'&&e.scope.nodeId===state.node);
  if(node?.kind!=='node_created')throw new Error('missing node');
  const snapshot=await engine.snapshotStore.getExecutionSnapshotV1(node.data.snapshotRef);
  const pinned=await engine.pinnedStore.get(state.run.data.workflowHash);
  const sorted=asSortedEventLog(state.truth.events);
  if(snapshot.isErr()||!snapshot.value||pinned.isErr()||pinned.value?.sourceKind!=='v1_pinned'||!hasWorkflowDefinitionShape(pinned.value.definition)||sorted.isErr())throw new Error('missing engine input');
  const snapshotValue=snapshot.value,workflow=getCachedWorkflow(state.run.data.workflowHash,pinned.value.definition),lockedIndex=buildSessionIndex(sorted.value);
  const result=await engine.gate.withHealthySessionLock(asSessionId(enrolled.enrollment.execution),lock=>executeAdvanceCore({
    answerOwner,mode:{kind:'fresh',sourceNodeId:asNodeId(state.node),snapshot:snapshotValue},truth:state.truth,sessionId:asSessionId(enrolled.enrollment.execution),runId:asRunId(state.run.scope.runId),attemptId:engine.idFactory.mintAttemptId(),workflowHash:state.run.data.workflowHash,dedupeKey:'legacy-bypass-test',inputContext:undefined,inputOutput:{notesMarkdown:'unauthorized legacy answer'},lock,pinnedWorkflow:workflow,ports:engine,lockedIndex,
  }));
  expect(result.isErr()).toBe(true);
  expect((await readHostState(engine,enrolled.enrollment))).toEqual(loaded);
  await scheduler.close(signal());
}));

it('discovery does not authorize takeover, including after the prior runtime closes', () => fixture(async config => {
  const { scheduler, enrolled } = await enroll(config);
  const replacement = await createAnswerHost(config, signal());
  const discovery = await createHostDiscovery(config, signal());
  if (replacement.kind !== 'created' || discovery.kind !== 'created') throw new Error('composition failed');
  try {
    const scan = await discovery.scanner.scan(undefined, signal());
    if (scan.kind !== 'page') throw new Error(scan.kind);
    const entry = scan.page.entries.find(e => e.kind === 'host');
    if (entry?.kind !== 'host') throw new Error('missing canonical host');
    expect(await replacement.scheduler.automaticRecovery.claimUnowned(entry.pointer, signal()))
      .toMatchObject({ kind: 'busy' });
    expect(await scheduler.close(signal())).toEqual({ kind: 'closed' });
    expect(await replacement.scheduler.automaticRecovery.claimUnowned(entry.pointer, signal()))
      .toMatchObject({ kind: 'busy' });
    // Only an explicit trusted replacement may supersede a retained owner.
    const recovered = await replacement.scheduler.recover(entry.pointer, signal());
    expect(recovered.kind).toBe('ready');
    if (recovered.kind !== 'ready') throw new Error(recovered.kind);
    expect(recovered.owner.epoch).toBeGreaterThan(enrolled.owner.epoch);
    expect(await replacement.scheduler.releaseOwnership(enrolled.enrollment, enrolled.owner, signal()))
      .toEqual({ kind: 'stale_owner' });
  } finally {
    await discovery.scanner.close(signal());
    await replacement.scheduler.close(signal());
    await scheduler.close(signal());
  }
}));

it('retains the original request in the canonical enrollment across caller and workflow changes', () => fixture(async config => {
  const created = await createAnswerHost(config, signal());
  if (created.kind !== 'created') throw new Error(created.kind);
  const request = { workflowId: 'lifecycle', goal: 'original goal', workspacePath: config.workflowStoragePath };
  const original = { ...request };
  const result = await created.scheduler.enroll(request, signal());
  if (result.kind !== 'enrolled') throw new Error(result.kind);
  const pointer = created.scheduler.hydrator.dehydrate(result.enrollment);
  request.goal = 'later caller mutation';
  await writeFile(join(config.workflowStoragePath, 'lifecycle.json'), 'not the enrolled workflow');
  await created.scheduler.close(signal());
  const replacement = await createAnswerHost(config, signal());
  if (replacement.kind !== 'created') throw new Error(replacement.kind);
  try {
    const hydrated = await replacement.scheduler.hydrator.hydrate(pointer, signal());
    if (hydrated.kind !== 'hydrated') throw new Error(hydrated.kind);
    const { composeAnswerEngine } = await import('../../../src/answer-v1/engine-composition.js');
    const { readHostState, workView } = await import('../../../src/answer-v1/host-state.js');
    const engine = await composeAnswerEngine(config);
    if (engine.kind !== 'ready') throw new Error(engine.kind);
    const loaded = await readHostState(engine, hydrated.enrollment);
    if (loaded.kind !== 'loaded') throw new Error(loaded.kind);
    const record = loaded.state.records.find(r => r.kind === 'enrolled');
    expect(record).toMatchObject({ request: original });
    if (record?.kind !== 'enrolled') throw new Error('missing enrollment');
    expect(Object.isFrozen(record.request)).toBe(true);
    expect((await workView(engine, loaded.state)).kind).toBe('question');
    expect(loaded.state.run.data.workflowId).toBe(original.workflowId);
    const { AnswerHostRecordSchema } = await import('../../../src/v2/durable-core/schemas/session/answer-host.js');
    if (record?.kind !== 'enrolled') throw new Error('missing enrollment');
    const { request: ignored, ...legacy } = record;
    expect(AnswerHostRecordSchema.parse(legacy)).not.toHaveProperty('request');
    expect(AnswerHostRecordSchema.safeParse({ ...record, request: { ...original, owner: 'forged' } }).success).toBe(false);
  } finally { await replacement.scheduler.close(signal()); }
}));


it.each([
  { kind: 'refused', reason: 'budget_exhausted' },
  { kind: 'unconfirmed', reason: 'commit_uncertain' },
  { kind: 'unconfirmed', reason: 'provider_outcome_unknown' },
] as const)('retains model call failure $reason as a host outcome', failure => fixture(async config => {
  let captureAttempts = 0;
  const adapter = createDaemonAnswerModel({ modelId: 'fake', systemPrompt: 'Answer', workspaceTools: [],
    provider: { async invoke() { return failure; } },
  });
  if (adapter.kind !== 'created') throw new Error(adapter.kind);
  const { scheduler, enrolled } = await enroll({ ...config,
    model: adapter.model,
    faultSeam: { async intercept(boundary) {
      if (boundary === 'before_capture_append') captureAttempts++;
      return { kind: 'proceed' };
    } },
  });
  try {
    const result = await enrolled.runner.runTurn(signal());
    expect(result).toMatchObject(failure.kind === 'refused'
      ? { kind: 'refused', reason: 'model_call_refused', failure }
      : { kind: 'unconfirmed', uncertainty: { stage: 'model_call', failure } });
    expect(captureAttempts).toBe(0);
  } finally { await scheduler.close(signal()); }
}));

it('binds acknowledged deliveries and skips the factory when replaying a retained response', () => fixture(async config => {
  const { model: _model, ...authority } = config;
  const deliveries: string[] = [];
  let generated = 0, loseAck = true;
  const boundConfig: AnswerHostConfig = { ...authority,
    modelFactory: { async create({ journal, delivery, owner }) {
      const canonical = await journal.locked(signal(), undefined, async state => state.records.at(-1));
      expect(canonical).toMatchObject({ kind: 'delivered', delivery, epoch: owner.epoch.toString() });
      deliveries.push(delivery);
      return { kind: 'created', model: { async generate(input) {
        expect(Object.keys(input).sort()).toEqual(['instruction', 'issues', 'retainedSummaries']);
        generated++;
        return { kind: 'completed', response: response('retained answer') };
      } } };
    } },
    faultSeam: { async intercept(boundary) {
      if (boundary === 'after_capture_append' && loseAck) { loseAck = false; return { kind: 'simulate_uncertain', message: 'lost ack' }; }
      return { kind: 'proceed' };
    } },
  };
  const { scheduler, enrolled } = await enroll(boundConfig);
  const pointer = scheduler.hydrator.dehydrate(enrolled.enrollment);
  expect(await enrolled.runner.runTurn(signal())).toMatchObject({ kind: 'unconfirmed', uncertainty: { stage: 'capture' } });
  await scheduler.close(signal());
  const restarted = await createAnswerHost(boundConfig, signal());
  if (restarted.kind !== 'created') throw new Error(restarted.kind);
  try {
    const recovered = await restarted.scheduler.recover(pointer, signal());
    if (recovered.kind !== 'ready') throw new Error(recovered.kind);
    expect(await recovered.runner.runTurn(signal())).toMatchObject({ kind: 'advanced', nextView: { kind: 'question' } });
    expect([deliveries.length, generated]).toEqual([1, 1]);
    expect(await recovered.runner.runTurn(signal())).toMatchObject({ kind: 'advanced', nextView: { kind: 'finished' } });
    expect([deliveries.length, generated, new Set(deliveries).size]).toEqual([2, 2, 2]);
  } finally { await restarted.scheduler.close(signal()); }
}));

it('does not construct a model without confirmed delivery persistence', () => fixture(async config => {
  const { model: _model, ...authority } = config;
  let constructed = 0;
  const { scheduler, enrolled } = await enroll({ ...authority,
    modelFactory: { async create() { constructed++; return { kind: 'refused', reason: 'missing_policy' }; } },
    faultSeam: { async intercept(boundary) { return boundary === 'after_delivery_append'
      ? { kind: 'simulate_uncertain', message: 'lost delivery ack' } : { kind: 'proceed' }; } },
  });
  try {
    expect(await enrolled.runner.runTurn(signal())).toMatchObject({ kind: 'unconfirmed', uncertainty: { stage: 'delivery' } });
    expect(constructed).toBe(0);
  } finally { await scheduler.close(signal()); }
}));

it.each(['refusal', 'throw', 'cancel', 'stale', 'storage'] as const)('handles factory %s before generation or capture', kind => fixture(async config => {
  const { model: _model, ...authority } = config;
  const control = new AbortController();
  let generated = 0, captures = 0;
  const { scheduler, enrolled } = await enroll({ ...authority,
    modelFactory: { async create() {
      if (kind === 'stale') return { kind: 'refused', reason: 'stale_owner' };
      if (kind === 'storage') return { kind: 'refused', reason: 'storage_unavailable' };
      if (kind === 'refusal') return { kind: 'refused', reason: 'missing_policy' };
      if (kind === 'throw') throw new Error('factory unavailable');
      control.abort();
      return { kind: 'created', model: { async generate() { generated++; return { kind: 'completed', response: response('must not run') }; } } };
    } },
    faultSeam: { async intercept(boundary) { if (boundary === 'before_capture_append') captures++; return { kind: 'proceed' }; } },
  });
  try {
    const result = await enrolled.runner.runTurn(control.signal);
    expect([generated, captures]).toEqual([0, 0]);
    expect(result).toMatchObject(kind === 'cancel' ? { kind: 'cancelled' }
      : kind === 'stale' ? { kind: 'stale_owner' }
      : kind === 'storage' ? { kind: 'refused', reason: 'storage_unavailable' }
      : kind === 'refusal' ? { kind: 'refused', reason: 'model_binding_refused', failure: 'missing_policy' }
      : { kind: 'refused', reason: 'model_unavailable', detail: 'Error: factory unavailable' });
  } finally { await scheduler.close(signal()); }
}));


it('uses the daemon factory through the host while refusing absent retained policy', () => fixture(async config => {
  const { model: _model, ...authority } = config;
  let sends = 0;
  const { scheduler, enrolled } = await enroll({ ...authority,
    modelFactory: createDaemonDeliveryModelFactory({ provider: 'anthropic', apiKey: 'fake' }, [], async () => {
      sends++; throw new Error('must not fetch');
    }),
  });
  try {
    expect(await enrolled.runner.runTurn(signal())).toMatchObject({ kind: 'refused', reason: 'model_binding_refused', failure: 'missing_policy' });
    expect(sends).toBe(0);
  } finally { await scheduler.close(signal()); }
}));

it('preserves workspace uncertainty without attempting answer capture', () => fixture(async config => {
  let captures=0;
  const failure={reason:'outcome_unacknowledged' as const,effect:'effect1'};
  const {scheduler,enrolled}=await enroll({...config,model:{async generate(){return {kind:'workspace_failed',failure};}},
    faultSeam:{async intercept(boundary){if(boundary==='before_capture_append')captures++;return {kind:'proceed'};}}});
  try {
    expect(await enrolled.runner.runTurn(signal())).toMatchObject({kind:'unconfirmed',uncertainty:{stage:'workspace_effect',failure}});
    expect(captures).toBe(0);
  } finally {await scheduler.close(signal());}
}));

it('refuses rebuilding a model for uncaptured work after workspace uncertainty', () => fixture(async config => {
  const {model:_model,...authority}=config;
  let bindings=0;
  const {scheduler,enrolled}=await enroll({...authority,modelFactory:{async create({journal,delivery,owner},s){
    bindings++;
    await journal.locked(s,false,(state,lock)=>journal.append(state,lock,
      {kind:'model_call_reserved',delivery,call:'fixture-model',epoch:owner.epoch.toString(),ordinal:1},s));
    return {kind:'created',model:{async generate(){return {kind:'workspace_failed',failure:{reason:'outcome_unacknowledged',effect:'fixture-effect'}};}}};
  }}});
  try {
    expect(await enrolled.runner.runTurn(signal())).toMatchObject({kind:'unconfirmed',uncertainty:{stage:'workspace_effect'}});
    expect(await enrolled.runner.runTurn(signal())).toMatchObject({kind:'refused',reason:'reconciliation_required'});
    expect(bindings).toBe(1);
  } finally {await scheduler.close(signal());}
}));

it.each(['normal', 'lost_ack'] as const)('cleanup claim survives %s and reopening without enabling execution', scenario => fixture(async config => {
  const { scheduler, enrolled, reply } = await enroll(config);
  const { composeAnswerEngine } = await import('../../../src/answer-v1/engine-composition.js');
  const { SessionJournal } = await import('../../../src/answer-v1/journal.js');
  const { reserveSupervisor, retainSupervisorTransition } = await import('../../../src/answer-v1/supervisor-journal.js');
  const { claimCleanupOwnership } = await import('../../../src/answer-v1/cleanup-ownership.js');
  const { readHostState } = await import('../../../src/answer-v1/host-state.js');
  const engine = await composeAnswerEngine(config);
  if (engine.kind !== 'ready') throw new Error(engine.kind);
  const journal = new SessionJournal(engine, enrolled.enrollment, {}, s => !s.aborted);
  expect(await claimCleanupOwnership(journal, enrolled.owner, 'missing', signal()))
    .toEqual({ kind: 'refused', reason: 'missing_identity' });
  const reserved = await reserveSupervisor(journal, enrolled.owner, { configurationDigest: 'a'.repeat(64), daemon: 'fixture' }, signal());
  if (reserved.kind !== 'reserved') throw new Error(reserved.kind);
  const ports = scheduler.bindDiagnosticPorts(enrolled.enrollment);
  const delivered = await ports.journal.appendDelivery(reply, enrolled.owner, signal());
  if (delivered.kind !== 'delivered') throw new Error(delivered.kind);
  const captured = await ports.journal.captureResponse(delivered.delivery, response('retained before fencing'), enrolled.owner, signal());
  if (captured.kind !== 'captured') throw new Error(captured.kind);
  const prepared = await ports.journal.prepare(captured.response, enrolled.owner, signal());
  if (prepared.kind !== 'prepared') throw new Error(prepared.kind);
  const before = await readHostState(engine, enrolled.enrollment);
  expect(await claimCleanupOwnership(journal, enrolled.owner, 'wrong', signal())).toEqual({ kind: 'refused', reason: 'invalid_scope' });
  expect(await readHostState(engine, enrolled.enrollment)).toEqual(before);
  const claimJournal = scenario === 'normal' ? journal : new class extends SessionJournal {
    override async append(...args: Parameters<SessionJournal['append']>) {
      const saved = await super.append(...args);
      return args[2].kind === 'cleanup_claimed' ? false : saved;
    }
  }(engine, enrolled.enrollment, {}, s => !s.aborted);
  const attempt = await claimCleanupOwnership(claimJournal, enrolled.owner, reserved.supervisor, signal());
  if (scenario === 'lost_ack') expect(attempt).toEqual({ kind: 'unconfirmed', reason: 'commit_uncertain' });
  const claim = await claimCleanupOwnership(journal, enrolled.owner, reserved.supervisor, signal());
  expect(claim).toMatchObject({ kind: 'claimed', fence: { epoch: 2n, previousEpoch: 1n, supervisor: reserved.supervisor } });
  const retained = await readHostState(engine, enrolled.enrollment);
  expect(retained).toMatchObject({ kind: 'loaded', state: { ownership: { kind: 'cleanup', epoch: 2n } } });
  expect(await ports.journal.appendDelivery(reply, enrolled.owner, signal())).toEqual({ kind: 'stale_owner' });
  expect(await ports.journal.appendDelivery(reply, { ...enrolled.owner, epoch: 2n }, signal())).toEqual({ kind: 'stale_owner' });
  expect(await ports.journal.captureResponse(delivered.delivery, response('late'), enrolled.owner, signal())).toEqual({ kind: 'stale_owner' });
  expect(await ports.dispatcher.dispatch(prepared.answer, enrolled.owner, signal())).toEqual({ kind: 'stale_owner' });
  expect(await scheduler.releaseOwnership(enrolled.enrollment, enrolled.owner, signal())).toEqual({ kind: 'stale_owner' });
  expect(await retainSupervisorTransition(journal, enrolled.owner, { kind: 'supervisor_created', supervisor: reserved.supervisor,
    binding: { daemon: 'fixture', environment: 'a'.repeat(64) } }, signal())).toEqual({ kind: 'refused', reason: 'stale_owner' });
  const reopened = await composeAnswerEngine(config);
  if (reopened.kind !== 'ready') throw new Error(reopened.kind);
  const cold = new SessionJournal(reopened, enrolled.enrollment, {}, s => !s.aborted);
  expect(await claimCleanupOwnership(cold, enrolled.owner, reserved.supervisor, signal())).toEqual(claim);
  expect(await claimCleanupOwnership(cold, { ...enrolled.owner, epoch: 2n }, reserved.supervisor, signal()))
    .toEqual({ kind: 'refused', reason: 'ownership_changed' });
  const pointer = scheduler.hydrator.dehydrate(enrolled.enrollment);
  for (const result of [await scheduler.recover(pointer, signal()),
    await scheduler.automaticRecovery.claimUnowned(pointer, signal()),
    await scheduler.conditionalRecovery.replaceIfCurrent(pointer, enrolled.owner, signal())])
    expect(result).toMatchObject({ kind: 'refused', reason: 'ownership_changed' });
  expect(await readHostState(reopened, enrolled.enrollment)).toEqual(retained);
  await scheduler.close(signal());
}));


it.each(['normal', 'lost_ack'] as const)('cleanup resource ledger retains %s across cold retries without releasing execution', scenario => fixture(async config => {
  const { scheduler, enrolled } = await enroll(config);
  const { composeAnswerEngine } = await import('../../../src/answer-v1/engine-composition.js');
  const { SessionJournal } = await import('../../../src/answer-v1/journal.js');
  const { reserveSupervisor } = await import('../../../src/answer-v1/supervisor-journal.js');
  const { claimCleanupOwnership } = await import('../../../src/answer-v1/cleanup-ownership.js');
  const { recordCleanupResource } = await import('../../../src/answer-v1/cleanup-journal.js');
  const { readHostState } = await import('../../../src/answer-v1/host-state.js');
  const engine = await composeAnswerEngine(config);
  if (engine.kind !== 'ready') throw new Error(engine.kind);
  const journal = new SessionJournal(engine, enrolled.enrollment, {}, s => !s.aborted);
  const reserved = await reserveSupervisor(journal, enrolled.owner, { configurationDigest: 'a'.repeat(64), daemon: 'fixture' }, signal());
  if (reserved.kind !== 'reserved') throw new Error(reserved.kind);
  const claim = await claimCleanupOwnership(journal, enrolled.owner, reserved.supervisor, signal());
  if (claim.kind !== 'claimed') throw new Error(claim.kind);
  const scope = { epoch: claim.fence.epoch.toString(), supervisor: reserved.supervisor, daemon: 'fixture', container: 'a'.repeat(64) };
  const records = [
    { kind: 'cleanup_resource_bound', ...scope }, { kind: 'cleanup_stop_intended', ...scope },
    { kind: 'cleanup_stopped', ...scope }, { kind: 'cleanup_remove_intended', ...scope },
    // A late start raced the first removal. A retained new stop targets the same ID.
    { kind: 'cleanup_stop_intended', ...scope }, { kind: 'cleanup_stopped', ...scope },
    { kind: 'cleanup_remove_intended', ...scope },
    { kind: 'cleanup_removed', ...scope, evidence: 'absent_after_remove_intent' },
  ] as const;
  const losing = new class extends SessionJournal {
    override async append(...args: Parameters<SessionJournal['append']>) {
      const saved = await super.append(...args);
      return args[2].kind.startsWith('cleanup_') ? false : saved;
    }
  }(engine, enrolled.enrollment, {}, s => !s.aborted);
  for (const record of records) {
    const attempt = await recordCleanupResource(scenario === 'lost_ack' ? losing : journal, claim.fence, record, signal());
    expect(attempt.kind).toBe(scenario === 'lost_ack' ? 'unconfirmed' : 'retained');
    const reopened = await composeAnswerEngine(config);
    if (reopened.kind !== 'ready') throw new Error(reopened.kind);
    const cold = new SessionJournal(reopened, enrolled.enrollment, {}, s => !s.aborted);
    const before = await readHostState(reopened, enrolled.enrollment);
    expect((await recordCleanupResource(cold, claim.fence, record, signal())).kind).toBe('retained');
    expect(await readHostState(reopened, enrolled.enrollment)).toEqual(before);
    expect(await recordCleanupResource(cold, { ...claim.fence, epoch: 3n }, record, signal()))
      .toEqual({ kind: 'refused', reason: 'ownership_changed' });
    expect(await recordCleanupResource(cold, claim.fence, { ...record, container: 'c'.repeat(64) }, signal()))
      .toEqual({ kind: 'refused', reason: 'invalid_transition' });
    expect(await readHostState(reopened, enrolled.enrollment)).toEqual(before);
  }
  const final = await readHostState(engine, enrolled.enrollment);
  expect(final).toMatchObject({ kind: 'loaded', state: { ownership: { kind: 'cleanup', epoch: 2n } } });
  expect(await scheduler.releaseOwnership(enrolled.enrollment, enrolled.owner, signal())).toEqual({ kind: 'stale_owner' });
  await scheduler.close(signal());
}));


it.each(['normal', 'lost_remove_reply', 'late_start', 'late_create', 'foreign_daemon', 'cancelled', 'binding_commit_failure', 'stop_intent_failure', 'remove_intent_failure', 'delayed_remove_during_restop'] as const)(
  'reconciles scratch cleanup with %s while preserving unresolved execution', scenario => fixture(async config => {
  const { scheduler, enrolled } = await enroll(config);
  const { composeAnswerEngine } = await import('../../../src/answer-v1/engine-composition.js');
  const { SessionJournal } = await import('../../../src/answer-v1/journal.js');
  const { reserveSupervisor } = await import('../../../src/answer-v1/supervisor-journal.js');
  const { claimCleanupOwnership } = await import('../../../src/answer-v1/cleanup-ownership.js');
  const { reconcileScratchCleanup } = await import('../../../src/daemon/runner/linux-scratch/reconciliation.js');
  const { scratchContainerName } = await import('../../../src/daemon/runner/linux-scratch/identity.js');
  const { readHostState } = await import('../../../src/answer-v1/host-state.js');
  const engine = await composeAnswerEngine(config);
  if (engine.kind !== 'ready') throw new Error(engine.kind);
  const journal = new SessionJournal(engine, enrolled.enrollment, {}, s => !s.aborted);
  const reserved = await reserveSupervisor(journal, enrolled.owner, { configurationDigest: 'a'.repeat(64), daemon: 'fixture' }, signal());
  if (reserved.kind !== 'reserved') throw new Error(reserved.kind);
  const claim = await claimCleanupOwnership(journal, enrolled.owner, reserved.supervisor, signal());
  if (claim.kind !== 'claimed') throw new Error(claim.kind);
  const id = 'a'.repeat(64);
  let present = scenario !== 'late_create', running = true, removals = 0;
  const calls: string[][] = [];
  const docker = { async run(args: readonly string[]) {
    calls.push([...args]);
    const completed = (value: unknown) => ({ kind: 'completed' as const, bytes: Buffer.from(JSON.stringify(value)) });
    switch (args[0]) {
      case 'info': return completed({ ID: scenario === 'foreign_daemon' ? 'wrong' : 'fixture', OSType: 'linux' });
      case 'ps': return present ? completed(id) : { kind: 'completed' as const, bytes: Buffer.alloc(0) };
      case 'inspect': return completed([{ Id: id, Name: '/' + scratchContainerName(reserved.supervisor),
        State: { Running: running }, Config: { Labels: { 'workrail.linux-scratch': reserved.supervisor } } }]);
      case 'stop':
        running = false;
        if (scenario === 'delayed_remove_during_restop' && removals === 1) { present = false; return { kind: 'unknown' as const }; }
        return completed(id);
      case 'rm':
        removals++;
        if ((scenario === 'late_start' || scenario === 'delayed_remove_during_restop') && removals === 1) { running = true; return { kind: 'unknown' as const }; }
        if (running) return { kind: 'unknown' as const };
        present = false;
        return scenario === 'lost_remove_reply' ? { kind: 'unknown' as const } : completed(id);
      default: throw new Error('Unexpected cleanup command: ' + args.join(' '));
    }
  } };
  const cancelled = new AbortController(); cancelled.abort();
  const refusingJournal = new class extends SessionJournal {
    override async append(...args: Parameters<SessionJournal['append']>) {
      const refused = { binding_commit_failure: 'cleanup_resource_bound', stop_intent_failure: 'cleanup_stop_intended', remove_intent_failure: 'cleanup_remove_intended' };
      return scenario in refused && args[2].kind === refused[scenario as keyof typeof refused] ? false : super.append(...args);
    }
  }(engine, enrolled.enrollment, {}, s => !s.aborted);
  const first = await reconcileScratchCleanup(['binding_commit_failure', 'stop_intent_failure', 'remove_intent_failure'].includes(scenario) ? refusingJournal : journal, claim.fence, docker, scenario === 'cancelled' ? cancelled.signal : signal());
  if (scenario === 'binding_commit_failure' || scenario === 'stop_intent_failure') expect(calls.some(c => c[0] === 'stop' || c[0] === 'rm')).toBe(false);
  if (scenario === 'remove_intent_failure') expect(calls.some(c => c[0] === 'rm')).toBe(false);
  if (scenario === 'normal') expect(first).toEqual({ kind: 'resource_removed', executionSettlement: 'unresolved' });
  else if (scenario === 'foreign_daemon') {
    expect(first).toEqual({ kind: 'refused', reason: 'identity_mismatch' });
    expect(calls.map(c => c[0])).toEqual(['info']);
  } else if (scenario === 'late_create') {
    expect(first).toEqual({ kind: 'unresolved', reason: 'resource_absent_without_removal_intent' });
    expect(calls.some(c => c[0] === 'rm' || c[0] === 'stop')).toBe(false);
    present = true;
  } else expect(first).toEqual({ kind: 'unconfirmed' });
  if (scenario === 'cancelled') expect(calls).toEqual([]);
  if (scenario !== 'foreign_daemon') {
    const reopened = await composeAnswerEngine(config);
    if (reopened.kind !== 'ready') throw new Error(reopened.kind);
    const cold = new SessionJournal(reopened, enrolled.enrollment, {}, s => !s.aborted);
    if (scenario === 'delayed_remove_during_restop')
      expect(await reconcileScratchCleanup(cold, claim.fence, docker, signal())).toEqual({ kind: 'unconfirmed' });
    expect(await reconcileScratchCleanup(cold, claim.fence, docker, signal()))
      .toEqual({ kind: 'resource_removed', executionSettlement: 'unresolved' });
    expect(present).toBe(false);
  }
  expect(calls.filter(c => c[0] === 'rm').every(c => c.length === 2 && c[1] === id)).toBe(true);
  expect(calls.filter(c => c[0] === 'stop').every(c => c.join(' ') === 'stop --time 1 ' + id)).toBe(true);
  expect(await readHostState(engine, enrolled.enrollment))
    .toMatchObject({ kind: 'loaded', state: { ownership: { kind: 'cleanup', epoch: 2n } } });
  await scheduler.close(signal());
}));

it.skipIf(process.env.WORKRAIL_TEST_LINUX_SCRATCH !== '1').each(['stopped', 'running_lost_remove'] as const)(
  'reconciles an actual isolated Docker fixture after %s across reopen', scenario => fixture(async config => {
  const { scheduler, enrolled } = await enroll(config);
  const { composeAnswerEngine } = await import('../../../src/answer-v1/engine-composition.js');
  const { SessionJournal } = await import('../../../src/answer-v1/journal.js');
  const { reserveSupervisor } = await import('../../../src/answer-v1/supervisor-journal.js');
  const { claimCleanupOwnership } = await import('../../../src/answer-v1/cleanup-ownership.js');
  const { reconcileScratchCleanup } = await import('../../../src/daemon/runner/linux-scratch/reconciliation.js');
  const { scratchContainerName } = await import('../../../src/daemon/runner/linux-scratch/identity.js');
  const { DockerCli } = await import('../../../src/daemon/runner/linux-scratch/docker-cli.js');
  const docker = DockerCli.local(process.env.WORKRAIL_TEST_DOCKER_BINARY ?? '', process.env.WORKRAIL_TEST_DOCKER_SOCKET ?? '');
  if (!docker) throw new Error('Explicit local Docker fixture endpoint required');
  const info = await docker.run(['info', '--format', '{{json .}}'], signal());
  if (info.kind !== 'completed') throw new Error('Fixture Docker unavailable');
  const daemon = JSON.parse(info.bytes.toString()) as { ID: string; OSType: string };
  expect(daemon.OSType).toBe('linux');
  const engine = await composeAnswerEngine(config);
  if (engine.kind !== 'ready') throw new Error(engine.kind);
  const journal = new SessionJournal(engine, enrolled.enrollment, {}, s => !s.aborted);
  const reserved = await reserveSupervisor(journal, enrolled.owner, { configurationDigest: 'a'.repeat(64), daemon: daemon.ID }, signal());
  if (reserved.kind !== 'reserved') throw new Error(reserved.kind);
  let container: string | undefined;
  try {
    const created = await docker.run(['create', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--name', scratchContainerName(reserved.supervisor),
      '--label', 'workrail.linux-scratch=' + reserved.supervisor,
      'python@sha256:eb5be8e5b4d0a159c237946bbdd06356dda5d19c30fc4f7843e8046d3a590333',
      'python', '-c', 'import time; time.sleep(30)'], signal());
    if (created.kind !== 'completed') throw new Error('Fixture creation failed');
    container = created.bytes.toString().trim();
    expect(container).toMatch(/^[a-f0-9]{64}$/);
    if (scenario === 'running_lost_remove') expect((await docker.run(['start', container], signal())).kind).toBe('completed');
    // Deliberately retain only create intent, as if its original acknowledgment was lost.
    const claim = await claimCleanupOwnership(journal, enrolled.owner, reserved.supervisor, signal());
    if (claim.kind !== 'claimed') throw new Error(claim.kind);
    const losingReply = { async run(...args: Parameters<typeof docker.run>) {
      const reply = await docker.run(...args);
      return args[0][0] === 'rm' ? { kind: 'unknown' as const } : reply;
    } };
    expect(await reconcileScratchCleanup(journal, claim.fence, scenario === 'running_lost_remove' ? losingReply : docker, signal()))
      .toEqual(scenario === 'running_lost_remove' ? { kind: 'unconfirmed' } : { kind: 'resource_removed', executionSettlement: 'unresolved' });
    const reopened = await composeAnswerEngine(config);
    if (reopened.kind !== 'ready') throw new Error(reopened.kind);
    const cold = new SessionJournal(reopened, enrolled.enrollment, {}, s => !s.aborted);
    expect(await reconcileScratchCleanup(cold, claim.fence, docker, signal()))
      .toEqual({ kind: 'resource_removed', executionSettlement: 'unresolved' });
    const absent = await docker.run(['ps', '--all', '--no-trunc', '--filter', 'id=' + container, '--format', '{{.ID}}'], signal());
    expect(absent.kind === 'completed' && absent.bytes.toString().trim()).toBe('');
  } finally {
    if (container && /^[a-f0-9]{64}$/.test(container)) {
      await docker.run(['stop', '--time', '1', container], signal());
      await docker.run(['rm', container], signal());
    }
    await scheduler.close(signal());
  }
}));
