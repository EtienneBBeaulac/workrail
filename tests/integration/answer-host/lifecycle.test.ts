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
  }finally{
    await client.close();await composed.server.close();await scheduler.close(signal());
    if(oldProfile===undefined)delete process.env.WORKRAIL_AGENT_PROFILE;else process.env.WORKRAIL_AGENT_PROFILE=oldProfile;
  }
}));
