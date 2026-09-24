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

it('MCP exposes only answer tools and preserves host isolation through the transport',()=>fixture(async config=>{
  const oldProfile=process.env.WORKRAIL_AGENT_PROFILE;
  process.env.WORKRAIL_AGENT_PROFILE='answers';
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
  const {composeServer}=await import('../../../src/mcp/server.js');
  const {scheduler,enrolled,reply}=await enroll(config);
  const {model:_model,...answerAuthority}=config;
  const composed=await composeServer({answerAuthority});
  const client=new Client({name:'answer-boundary',version:'1'});
  try{
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport),composed.server.connect(serverTransport)]);
    expect((await client.listTools()).tools.map(t=>t.name).sort()).toEqual(['answer_work','inspect_work','open_work','recover_work']);
    const call=async(name:string,args:Record<string,unknown>)=>{
      const result=await client.callTool({name,arguments:args});
      expect(result.isError).not.toBe(true);
      const content=result.content as {type:string;text:string}[];
      return JSON.parse(content[0]!.text);
    };
    expect(await call('answer_work',{reply,answer:{notes:'foreign'}})).toEqual({kind:'not_retained',reason:'bound_session_required'});
    const opened=await call('open_work',{workflowId:'lifecycle',goal:'transport',workspacePath:config.workflowStoragePath});
    const first=await call('answer_work',{reply:opened.view.reply,answer:{notes:'first'}});
    expect(first).toMatchObject({kind:'recorded',view:{kind:'question'}});
    const viewed=await call('inspect_work',{read:first.view.read});
    expect(viewed).not.toHaveProperty('reply');
    expect(await call('answer_work',{reply:first.view.reply,answer:{notes:'last'}})).toMatchObject({kind:'recorded',view:{kind:'finished'}});
    let enter!:()=>void, release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;});
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    composed.handlers.inspect_work=async()=>{enter();await blocked;return {content:[{type:'text',text:'retained'}]};};
    const pending=client.callTool({name:'inspect_work',arguments:{read:first.view.read}});
    await entered;
    let drained=false;
    const closing=composed.closeRequests().then(()=>{drained=true;});
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(drained).toBe(false);
    expect((await client.callTool({name:'inspect_work',arguments:{read:first.view.read}})).isError).toBe(true);
    release();await pending;await closing;

  }finally{
    await client.close();await composed.server.close();await scheduler.close(signal());
    if(oldProfile===undefined)delete process.env.WORKRAIL_AGENT_PROFILE;else process.env.WORKRAIL_AGENT_PROFILE=oldProfile;
  }
}));

it.each(['missing','foreign','stale','released','stopped'] as const)('legacy engine advancement cannot bypass %s answer ownership',mode=>fixture(async config=>{
  const {scheduler,enrolled}=await enroll(config);
  if(mode==='released')await scheduler.releaseOwnership(enrolled.enrollment,enrolled.owner,signal());
  if(mode==='stopped')await scheduler.bindDiagnosticPorts(enrolled.enrollment).journal.commitStop(enrolled.owner,'cancelled','test stop',signal());
  const answerOwner=mode==='missing'?undefined:mode==='foreign'?{...enrolled.owner,execution:'sess_foreign' as typeof enrolled.owner.execution}:mode==='stale'?{...enrolled.owner,epoch:enrolled.owner.epoch+1n}:enrolled.owner;
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
