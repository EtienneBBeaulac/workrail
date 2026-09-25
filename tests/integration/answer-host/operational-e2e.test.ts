import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { startStandaloneConsole } from '../../../src/console/standalone-console.js';

const envelope = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough()).min(1) }).passthrough();
const question = z.object({ kind: z.literal('question'), reply: z.string(), instruction: z.string() }).passthrough();
const opened = z.object({ kind: z.literal('opened'), recovery: z.string(), view: question }).passthrough();
const recorded = z.object({ kind: z.literal('recorded'), receipt: z.string(), view: z.object({ kind: z.string() }).passthrough() }).passthrough();

// WorkRail is the MCP engine, not the agent's tool runner. This deterministic agent
// substitutes only model judgment; file/command effects, MCP and HTTP remain real.
it.each(['acknowledged_notes', 'lost_ack_review'] as const)('completes %s through tools, process death, replay and HTTP receipts', async scenario => {
  const review = scenario === 'lost_ack_review';
  const phase = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    console.info(`[operational:${scenario}] start ${label}`);
    try { return await action(); }
    finally { console.info(`[operational:${scenario}] end ${label} ${Math.round(performance.now() - start)}ms`); }
  };
  const root = await mkdtemp(join(tmpdir(), 'answer-operational-'));
  const data = join(root, 'data'), workspace = join(root, 'workspace'), workflows = join(root, 'workflows');
  const clients: Array<{ client: Client; transport: StdioClientTransport; closed: Promise<void> }> = [];
  let stopViewer: (() => Promise<void>) | undefined;
  try {
    await mkdir(workspace); await mkdir(workflows);
    await writeFile(join(workspace, 'input.txt'), 'retained result');
    await writeFile(join(workspace, 'produce.cjs'), "const fs=require('node:fs');fs.writeFileSync('result.txt',fs.readFileSync('input.txt','utf8').toUpperCase());process.stdout.write(fs.readFileSync('result.txt','utf8'));\n");
    await writeFile(join(workflows, 'fixture.json'), JSON.stringify({ id: 'fixture', name: 'Fixture', description: 'Operational proof', version: '1.0.0', steps: [
      { id: 'read', title: 'Read input', prompt: 'Read input.txt and report its exact content.',
        ...(review ? { outputContract: { contractRef: 'wr.contracts.review_verdict', required: true } } : {}) },
      { id: 'produce', title: 'Produce result', prompt: 'Run produce.cjs and report its exact output.' },
    ] }));
    const authority = join(root, 'authority.json');
    await writeFile(authority, JSON.stringify({ formatVersion: 1, authority: {
      storage: { journalRootDir: join(data, 'sessions'), hostIndexRootDir: join(data, 'index') },
      keyringPath: join(data, 'keys', 'keyring.json'), workflowStoragePath: workflows,
    } }));
    const viewer = await startStandaloneConsole({ port: 0, dataDir: data, lockFilePath: join(root, 'console.lock') });
    if (viewer.kind !== 'ok') throw new Error(viewer.kind);
    stopViewer = viewer.stop;
    const boot = async (dropAck = false) => {
      const client = new Client({ name: 'deterministic-operational-agent', version: '1' });
      const closed = new Promise<void>(resolve => { client.onclose = resolve; });
      const transport = new StdioClientTransport({ command: process.execPath, args: dropAck ? [resolve('tests/integration/answer-host/fixtures/drop-answer-ack.cjs'), resolve('dist/mcp-server.js'), join(root, 'lost-ack.json')] : [resolve('dist/mcp-server.js')],
        env: { ...getDefaultEnvironment(), WORKRAIL_AGENT_PROFILE: 'answers', WORKRAIL_ANSWER_AUTHORITY_FILE: authority,
          WORKRAIL_DATA_DIR: data, WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_TRANSPORT: 'stdio' }, stderr: 'pipe' });
      clients.push({ client, transport, closed });
      transport.stderr?.resume();
      await phase('connect', () => client.connect(transport, { timeout: 5000 }));
      transport.stderr?.resume();
      expect((await phase('listTools', () => client.listTools())).tools.map(t => t.name).sort()).toEqual(['answer_work', 'inspect_work', 'open_work', 'recover_work']);
      return { client, transport, closed };
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await phase(name, () => client.callTool({ name, arguments: args }, undefined, { timeout: 5000 }));
      expect(result.isError).not.toBe(true);
      return JSON.parse(envelope.parse(result).content[0]!.text) as unknown;
    };
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${viewer.port}${path}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain('"reply"');
      return body;
    };
    const first = await boot(review);
    const work = opened.parse(await call(first.client, 'open_work', { workflowId: 'fixture', goal: 'Produce a retained result', workspacePath: workspace }));
    expect(work.view.instruction).toContain('Read input.txt');
    const notes = await readFile(join(workspace, 'input.txt'), 'utf8');
    let reply = work.view.reply;
    if (review) {
      const partial = recorded.parse(await call(first.client, 'answer_work', { reply, answer: { notes } }));
      expect(partial).toMatchObject({ disposition: 'partial' });
      reply = question.parse(partial.view).reply;
      const invalid = recorded.parse(await call(first.client, 'answer_work', { reply, answer: { verdict: 'invalid' } }));
      expect(invalid).toMatchObject({ disposition: 'rejected' });
      reply = question.parse(invalid.view).reply;
      expect(question.parse(invalid.view).instruction).toContain('Read input.txt');
    }
    const answer = review ? { notes, verdict: 'clean', confidence: 'high', findings: [], summary: 'Fixture reviewed' } : { notes };
    let expectedReceipt: string;
    let nextReply: string | undefined;
    if (review) {
      // The bridge waits for the actual accepted server response, drops it, and
      // kills that server. Rejection here must be disconnection, not a deadline.
      await expect(call(first.client, 'answer_work', { reply, answer })).rejects.toThrow(/closed/i);
      const fault = JSON.parse(await readFile(join(root, 'lost-ack.json'), 'utf8'));
      expect(fault.dropped).toBe(true);
      expectedReceipt = z.string().parse(fault.receipt);
    } else {
      const accepted = recorded.parse(await call(first.client, 'answer_work', { reply, answer }));
      expectedReceipt = accepted.receipt;
      nextReply = question.parse(accepted.view).reply;
      const pid = first.transport.pid;
      if (!pid) throw new Error('Missing server PID');
      process.kill(pid, 'SIGKILL');
      await phase('killed process closed', () => first.closed);
    }
    const sessions = (await readdir(join(data, 'sessions'), { withFileTypes: true })).filter(entry => entry.isDirectory());
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!.name;
    expect((await get(`/api/v2/sessions/${session}/answer`)).data.view.kind).not.toBe('finished');

    const cold = await boot();
    const replay = z.object({ kind: z.literal('replay'), receipt: z.string() }).passthrough().parse(
      await call(cold.client, 'answer_work', { reply, answer }));
    expect(replay.receipt).toBe(expectedReceipt);
    expect(JSON.stringify(replay)).not.toContain('"reply"');
    const resumed = question.parse(await call(cold.client, 'recover_work', { recovery: work.recovery }));
    if (nextReply) expect(resumed.reply).toBe(nextReply);
    expect(resumed.instruction).toContain('Run produce.cjs');
    const output = await promisify(execFile)(process.execPath, ['produce.cjs'], { cwd: workspace, timeout: 5000 });
    expect(output.stdout).toBe('RETAINED RESULT');
    const competitor = await boot();
    const raced = await Promise.all([cold.client, competitor.client].map(client => call(client, 'answer_work', { reply: resumed.reply, answer: { notes: output.stdout } })));
    // Lock contention before delivery can refuse the answer; contention after
    // delivery/capture can leave its outcome unconfirmed. Neither is success.
    // Settlement must still produce one commit and the same replay for both clients.
    const results = raced.map(value => z.union([
      z.object({ kind: z.enum(['recorded', 'replay']), receipt: z.string() }).passthrough(),
      z.object({ kind: z.literal('not_retained'), reason: z.literal('unavailable_storage') }).strict(),
      z.object({ kind: z.literal('unconfirmed'), reason: z.literal('commit_uncertain') }).strict(),
    ]).parse(value));
    expect(results.filter(result => result.kind === 'recorded')).toHaveLength(1);
    const finished = recorded.parse(raced[results.findIndex(result => result.kind === 'recorded')]);
    for (const result of results) {
      if (result.kind === 'replay') expect(result.receipt).toBe(finished.receipt);
    }
    for (const client of [cold.client, competitor.client]) {
      expect(await call(client, 'answer_work', { reply: resumed.reply, answer: { notes: output.stdout } }))
        .toMatchObject({ kind: 'replay', receipt: finished.receipt });
    }
    expect(finished.view.kind).toBe('finished');
    expect(finished.receipt).not.toBe(expectedReceipt);
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('RETAINED RESULT');
    expect((await get(`/api/v2/sessions/${session}/answer`)).data.view.kind).toBe('finished');
    for (const [receipt, text] of [[expectedReceipt, notes], [finished.receipt, output.stdout]]) {
      expect(JSON.stringify(await get(`/api/v2/sessions/${session}/answer/receipts/${encodeURIComponent(receipt!)}`))).toContain(text);
    }
    if (review) {
      const files = await readdir(join(data, 'sessions', session), { recursive: true });
      const logs = await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(file => readFile(join(data, 'sessions', session, file), 'utf8')));
      const events = logs.flatMap(log => log.split('\n').filter(Boolean).map(line => JSON.parse(line)));
      const artifacts = events.filter(event => event.kind === 'node_output_appended' && event.data.payload.payloadKind === 'artifact_ref');
      expect(artifacts.map(event => event.data.payload.content)).toEqual([{ kind: 'wr.review_verdict', verdict: 'clean', confidence: 'high', findings: [], summary: 'Fixture reviewed' }]);
    }
  } finally {
    for (const { client, transport, closed } of clients) {
      const running = transport.pid !== null;
      await phase('client cleanup', () => client.close());
      if (running) await phase('closed notification', () => closed);
    }
    await phase('viewer cleanup', async () => { await stopViewer?.(); });
    await rm(root, { recursive: true, force: true });
  }
});
