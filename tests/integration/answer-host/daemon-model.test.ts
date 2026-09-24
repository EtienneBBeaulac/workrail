import 'reflect-metadata';
import type Anthropic from '@anthropic-ai/sdk';
import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAnswerHost } from '../../../src/answer-v1/host.js';
import { createDaemonAnswerModel } from '../../../src/daemon/runner/answer-model.js';
import type { AgentTool, AgentClientInterface } from '../../../src/daemon/agent-loop.js';

const answer = (id: string, notes: string): Anthropic.ToolUseBlock => ({ type: 'tool_use', id, name: 'answer_work', input: { answer: { notes } } });
const message = (content: Anthropic.ContentBlock[]): Anthropic.Message => ({
  id: 'provider-response', type: 'message', role: 'assistant', model: 'fake', stop_sequence: null,
  stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const prompt = { instruction: 'First task', issues: [], retainedSummaries: [] };
const signal = () => AbortSignal.timeout(15000);
const options = (client: AgentClientInterface, workspaceTools: readonly AgentTool[] = []) => ({
  client, workspaceTools, modelId: 'fake', systemPrompt: 'Use workspace tools then answer_work.',
});
const tool = (name: string, execute: AgentTool['execute']): AgentTool => ({ name, execute,
  label: name, description: name, inputSchema: { type: 'object', properties: {} } });

it('hands the whole answer response to the host before executing any of its tools', async () => {
  let executions = 0, requests = 0;
  const created = createDaemonAnswerModel(options({ messages: { async create() {
    if (++requests > 1) return message([{ type: 'text', text: 'End' }]);
    return message([{ type: 'tool_use', id: 'read', name: 'Read', input: {} }, answer('one', 'first'), answer('two', 'second')]);
  } } }, [tool('Read', async () => { executions++; return { content: [], details: null }; })]));
  if (created.kind !== 'created') throw new Error(created.kind);
  expect(await created.model.generate(prompt, signal())).toMatchObject({ kind: 'completed', response: {
    providerResponseId: 'provider-response', calls: [{ id: 'read' }, { id: 'one' }, { id: 'two' }],
  } });
  expect(executions).toBe(0);
});

it('executes workspace-only responses before handing off an answer', async () => {
  let executions = 0, requests = 0;
  const created = createDaemonAnswerModel(options({ messages: { async create(params) {
    requests++;
    if (requests === 1) return message([{ type: 'tool_use', id: 'read', name: 'Read', input: {} }]);
    expect(JSON.stringify(params.messages)).toContain('workspace evidence');
    return message([answer('done', 'supported answer')]);
  } } }, [tool('Read', async () => { executions++; return { content: [{ type: 'text', text: 'workspace evidence' }], details: null }; })]));
  if (created.kind !== 'created') throw new Error(created.kind);
  expect(await created.model.generate(prompt, signal())).toMatchObject({ kind: 'completed' });
  expect([requests, executions]).toEqual([2, 1]);
});

it.each(['complete_step', 'continue_workflow', 'new_execution_tool'])('refuses %s at composition', name => {
  expect(createDaemonAnswerModel(options({ messages: { async create() { throw new Error('must not infer'); } } },
    [tool(name, async () => ({ content: [], details: null }))]))).toEqual({ kind: 'refused', reason: 'unsupported_workspace_tool' });
});

it('propagates cancellation and distinguishes a model ending without an answer', async () => {
  const created = createDaemonAnswerModel(options({ messages: { async create() { return message([{ type: 'text', text: 'No answer.' }]); } } }));
  if (created.kind !== 'created') throw new Error(created.kind);
  const aborted = new AbortController(); aborted.abort();
  expect(await created.model.generate(prompt, aborted.signal)).toEqual({ kind: 'cancelled' });
  expect(await created.model.generate(prompt, signal())).toMatchObject({ kind: 'unavailable' });
});

it('uses real host capture and recovery so a batch advances once and restart needs no inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-answer-host-'));
  let requests = 0;
  const seen: string[] = [];
  const model = createDaemonAnswerModel(options({ messages: { async create(params) {
    requests++; seen.push(JSON.stringify(params));
    return message([answer('first', 'evidence one'), answer('pre-generated-successor', 'must not consume second')]);
  } } }));
  if (model.kind !== 'created') throw new Error(model.kind);
  const authority = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
    keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'workflows') };
  try {
    await mkdir(authority.workflowStoragePath);
    await writeFile(join(authority.workflowStoragePath, 'daemon-answer.json'), JSON.stringify({
      id: 'daemon-answer', name: 'Daemon answer', description: 'Two tasks', version: '1.0.0',
      steps: [{ id: 'one', title: 'First', prompt: 'FIRST_ONLY' }, { id: 'two', title: 'Second', prompt: 'SUCCESSOR_ONLY' }],
    }));
    let suppressCaptureAck = true;
    const host = await createAnswerHost({ ...authority, model: model.model, faultSeam: { async intercept(boundary) {
      if (boundary === 'after_capture_append' && suppressCaptureAck) {
        suppressCaptureAck = false; return { kind: 'simulate_uncertain', message: 'Lost capture acknowledgment' };
      }
      return { kind: 'proceed' };
    } } }, signal());
    if (host.kind !== 'created') throw new Error(host.kind);
    const enrolled = await host.scheduler.enroll({ workflowId: 'daemon-answer', goal: 'test', workspacePath: root }, signal());
    if (enrolled.kind !== 'enrolled') throw new Error(JSON.stringify(enrolled));
    const pointer = host.scheduler.hydrator.dehydrate(enrolled.enrollment);
    expect(await enrolled.runner.runTurn(signal())).toMatchObject({ kind: 'unconfirmed', uncertainty: { stage: 'capture' } });
    await host.scheduler.close(signal());
    const reopened = await createAnswerHost({ ...authority, model: model.model }, signal());
    if (reopened.kind !== 'created') throw new Error(reopened.kind);
    const recovered = await reopened.scheduler.recover(pointer, signal());
    if (recovered.kind !== 'ready') throw new Error(JSON.stringify(recovered));
    expect(await recovered.runner.runTurn(signal())).toMatchObject({ kind: 'advanced', nextView: { kind: 'question', instruction: 'SUCCESSOR_ONLY' } });
    expect(requests).toBe(1);
    expect(seen[0]).not.toContain('SUCCESSOR_ONLY');
    expect(seen[0]).not.toContain('continueToken');
    expect(await recovered.runner.runTurn(signal())).toMatchObject({ kind: 'advanced', nextView: { kind: 'finished' } });
    expect(requests).toBe(2);
    expect(seen[1]).toContain('SUCCESSOR_ONLY');
    await reopened.scheduler.close(signal());
  } finally { await rm(root, { recursive: true, force: true }); }
});


it('cancels an in-flight provider request without accepting its late answer', async () => {
  const control = new AbortController();
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let providerSignal: AbortSignal | undefined;
  const created = createDaemonAnswerModel(options({ messages: { async create(_params, transport) {
    providerSignal = transport?.signal;
    entered();
    await new Promise<void>(resolve => transport?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return message([answer('late', 'late answer')]);
  } } }));
  if (created.kind !== 'created') throw new Error(created.kind);
  const result = created.model.generate(prompt, control.signal);
  await waiting;
  control.abort();
  expect(await result).toEqual({ kind: 'cancelled' });
  expect(providerSignal?.aborted).toBe(true);
});

it('returns provider failure as data and refuses duplicate workspace names', async () => {
  const client: AgentClientInterface = { messages: { async create() { throw new Error('provider unavailable'); } } };
  const created = createDaemonAnswerModel(options(client));
  if (created.kind !== 'created') throw new Error(created.kind);
  expect(await created.model.generate(prompt, signal())).toMatchObject({ kind: 'unavailable', detail: 'provider unavailable' });
  const read = tool('Read', async () => ({ content: [], details: null }));
  expect(createDaemonAnswerModel(options(client, [read, read]))).toEqual({ kind: 'refused', reason: 'duplicate_tool_name' });
});


it('routes every workspace round through controlled inference', async () => {
  let requests = 0, executions = 0;
  const created = createDaemonAnswerModel({ modelId: 'fake', systemPrompt: 'Answer',
    workspaceTools: [tool('Read', async () => { executions++; return { content: [{ type: 'text', text: 'controlled evidence' }], details: null }; })],
    provider: { async invoke(params) {
      requests++;
      if (requests === 1) return { kind: 'completed', reservation: {call:'fake-call',ordinal:1}, value: message([{ type: 'tool_use', id: 'read', name: 'Read', input: {} }]) };
      expect(JSON.stringify(params.messages)).toContain('controlled evidence');
      return { kind: 'completed', reservation: {call:'fake-call',ordinal:1}, value: message([answer('done', 'verified')]) };
    } },
  });
  if (created.kind !== 'created') throw new Error(created.kind);
  expect(await created.model.generate(prompt, signal())).toMatchObject({ kind: 'completed', response: { calls: [{ id: 'done' }] } });
  expect([requests, executions]).toEqual([2, 1]);
});

it.each([
  { kind: 'refused', reason: 'budget_exhausted' },
  { kind: 'unconfirmed', reason: 'commit_uncertain' },
  { kind: 'unconfirmed', reason: 'provider_outcome_unknown' },
] as const)('preserves controlled failure $reason without executing tools', async failure => {
  let requests = 0, executions = 0;
  const created = createDaemonAnswerModel({ modelId: 'fake', systemPrompt: 'Answer',
    workspaceTools: [tool('Read', async () => { executions++; return { content: [], details: null }; })],
    provider: { async invoke() { requests++; return failure; } },
  });
  if (created.kind !== 'created') throw new Error(created.kind);
  expect(await created.model.generate(prompt, signal())).toEqual({ kind: 'call_failed', failure });
  expect([requests, executions]).toEqual([1, 0]);
});

it('preserves unknown provider outcome when cancellation races with its return', async () => {
  const control = new AbortController();
  const failure = { kind: 'unconfirmed', reason: 'provider_outcome_unknown' } as const;
  const created = createDaemonAnswerModel({ modelId: 'fake', systemPrompt: 'Answer', workspaceTools: [],
    provider: { async invoke() { control.abort(); return failure; } },
  });
  if (created.kind !== 'created') throw new Error(created.kind);
  expect(await created.model.generate(prompt, control.signal)).toEqual({ kind: 'call_failed', failure });
});


it.each([
  { kind: 'refused', reason: 'budget_exhausted' },
  { kind: 'unconfirmed', reason: 'provider_outcome_unknown' },
] as const)('halts after a workspace round when the next call returns $reason', async failure => {
  let requests = 0, executions = 0;
  const created = createDaemonAnswerModel({ modelId: 'fake', systemPrompt: 'Answer',
    workspaceTools: [tool('Read', async () => { executions++; return { content: [], details: null }; })],
    provider: { async invoke() {
      if (++requests === 1) return { kind: 'completed', reservation: {call:'fake-call',ordinal:1}, value: message([{ type: 'tool_use', id: 'read', name: 'Read', input: {} }]) };
      return failure;
    } },
  });
  if (created.kind !== 'created') throw new Error(created.kind);
  expect(await created.model.generate(prompt, signal())).toEqual({ kind: 'call_failed', failure });
  expect([requests, executions]).toEqual([2, 1]);
});

it('treats an unexpectedly rejected controlled provider as an unknown outcome', async () => {
  const created = createDaemonAnswerModel({ modelId: 'fake', systemPrompt: 'Answer', workspaceTools: [],
    provider: { async invoke() { throw new Error('lost provider response'); } },
  });
  if (created.kind !== 'created') throw new Error(created.kind);
  expect(await created.model.generate(prompt, signal())).toEqual({ kind: 'call_failed',
    failure: { kind: 'unconfirmed', reason: 'provider_outcome_unknown' } });
});

it('offers partial review fields to the model and resumes the missing field through host recovery', async () => {
  const { default: Ajv } = await import('ajv');
  const root = await mkdtemp(join(tmpdir(), 'daemon-review-'));
  const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
    keyringPath: join(root, 'keys.json'), workflowStoragePath: join(root, 'workflows') };
  let calls = 0;
  const model = createDaemonAnswerModel(options({ messages: { async create(params) {
    const fields = calls++ === 0 ? { notes: 'Reviewed.', verdict: 'clean', confidence: 'high', findings: [] } : { summary: 'No findings.' };
    const advertised = params.tools?.find(t => 'name' in t && t.name === 'answer_work');
    if (!advertised || !('input_schema' in advertised)) throw new Error('No answer schema');
    const validate = new Ajv({ strict: false }).compile(advertised.input_schema);
    expect(validate({ answer: fields }), JSON.stringify(validate.errors)).toBe(true);
    if (calls === 2) expect(JSON.stringify(params.messages)).toContain('Provide summary.');
    return message([{ type: 'tool_use', id: 'review-answer', name: 'answer_work', input: { answer: fields } }]);
  } } }));
  if (model.kind !== 'created') throw new Error(model.kind);
  try {
    await mkdir(config.workflowStoragePath);
    await writeFile(join(config.workflowStoragePath, 'review.json'), JSON.stringify({ id: 'review', name: 'Review', description: 'Daemon review', version: '1.0.0',
      steps: [{ id: 'one', title: 'Review', prompt: 'Review code', outputContract: { contractRef: 'wr.contracts.review_verdict', required: true } }] }));
    const host = await createAnswerHost({ ...config, model: model.model }, signal());
    if (host.kind !== 'created') throw new Error(host.kind);
    const enrolled = await host.scheduler.enroll({ workflowId: 'review', goal: 'Review', workspacePath: root }, signal());
    if (enrolled.kind !== 'enrolled') throw new Error(enrolled.kind);
    const partial = await enrolled.runner.runTurn(signal());
    expect(partial).toMatchObject({ kind: 'partial', nextView: { issues: [{ field: 'summary' }] } });
    const pointer = host.scheduler.hydrator.dehydrate(enrolled.enrollment);
    await host.scheduler.close(signal());
    const restarted = await createAnswerHost({ ...config, model: model.model }, signal());
    if (restarted.kind !== 'created') throw new Error(restarted.kind);
    try {
      const recovered = await restarted.scheduler.recover(pointer, signal());
      if (recovered.kind !== 'ready') throw new Error(recovered.kind);
      expect(await recovered.runner.runTurn(signal())).toMatchObject({ kind: 'advanced', nextView: { kind: 'finished' } });
      expect(calls).toBe(2);
    } finally { await restarted.scheduler.close(signal()); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
