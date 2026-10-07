import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
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
const retention = z.union([
  recorded.extend({ disposition: z.literal('accepted'), view: z.object({ kind: z.literal('finished') }).passthrough() }),
  z.object({ kind: z.literal('replay'), receipt: z.string() }).passthrough(),
  z.object({ kind: z.literal('not_retained'), reason: z.literal('unavailable_storage') }).strict(),
  z.object({ kind: z.literal('unconfirmed'), reason: z.literal('commit_uncertain') }).strict(),
]);
type TransportMode = 'direct' | 'drop_accepted' | 'delay_finished';
type ClientRole = 'first' | 'cold' | 'competitor';
type AnswerAttempt = { readonly kind: 'answered'; readonly value: unknown } | { readonly kind: 'request_timed_out' };

const OPERATION_TIMEOUT_MS = 5000;
const SETTLEMENT_ATTEMPTS = 3;
// This scenario includes sixteen MCP operations, a script, four HTTP reads and
// three client shutdowns. Its budget composes those operations; it is not a
// ten-second latency assertion on an entire process-death/replay lifecycle.
const CASE_TIMEOUT_MS = (24 + SETTLEMENT_ATTEMPTS) * OPERATION_TIMEOUT_MS;

function unreachableMode(mode: never): never { throw new Error(`Unsupported transport mode: ${mode}`); }
function transportArgs(mode: TransportMode, role: ClientRole, root: string): string[] {
  switch (mode) {
    case 'direct': return [resolve('dist/mcp-server.js')];
    case 'drop_accepted': return [resolve('tests/integration/answer-host/fixtures/drop-answer-ack.cjs'), resolve('dist/mcp-server.js'), join(root, 'lost-ack.json')];
    case 'delay_finished': return [resolve('tests/integration/answer-host/fixtures/delay-finished-ack.cjs'), resolve('dist/mcp-server.js'), join(root, `late-${role}.json`)];
    default: return unreachableMode(mode);
  }
}

// WorkRail is the MCP engine, not the agent's tool runner. This deterministic agent
// substitutes only model judgment; file/command effects, MCP and HTTP remain real.
it.each(['acknowledged_notes', 'lost_ack_review', 'late_final_ack'] as const)('completes %s through tools, process death, replay and HTTP receipts', { timeout: CASE_TIMEOUT_MS, retry: 0 }, async scenario => {
  const review = scenario === 'lost_ack_review';
  const lateFinal = scenario === 'late_final_ack';
  const phase = async <T>(label: string, action: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    console.info(`[operational:${scenario}] start ${label}`);
    try { return await action(); }
    finally { console.info(`[operational:${scenario}] end ${label} ${Math.round(performance.now() - start)}ms`); }
  };
  const root = await mkdtemp(join(tmpdir(), 'answer-operational-'));
  const data = join(root, 'data'), workspace = join(root, 'workspace'), workflows = join(root, 'workflows');
  const clients: Array<{ role: ClientRole; client: Client; transport: StdioClientTransport; closed: Promise<void>; stderrTail: string[] }> = [];
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
    const boot = async (role: ClientRole, mode: TransportMode = 'direct') => {
      const client = new Client({ name: 'deterministic-operational-agent', version: '1' });
      const closed = new Promise<void>(resolve => { client.onclose = resolve; });
      const args = transportArgs(mode, role, root);
      const transport = new StdioClientTransport({ command: process.execPath, args,
        env: { ...getDefaultEnvironment(), WORKRAIL_AGENT_PROFILE: 'answers', WORKRAIL_ANSWER_AUTHORITY_FILE: authority,
          WORKRAIL_DATA_DIR: data, WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_TRANSPORT: 'stdio' }, stderr: 'pipe' });
      const stderrTail: string[] = [];
      clients.push({ role, client, transport, closed, stderrTail });
      const connected = phase(`${role}/connect`, () => client.connect(transport, { timeout: OPERATION_TIMEOUT_MS }));
      transport.stderr?.on('data', chunk => {
        stderrTail.push(String(chunk).slice(-512));
        if (stderrTail.length > 16) stderrTail.shift();
      });
      await connected;
      expect((await phase(`${role}/listTools`, () => client.listTools(undefined, { timeout: OPERATION_TIMEOUT_MS }))).tools.map(t => t.name).sort()).toEqual(['answer_work', 'inspect_work', 'open_work', 'recover_work']);
      return { client, transport, closed };
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const role = clients.find(entry => entry.client === client)!.role;
      const result = await phase(`${role}/${name}`, () => client.callTool({ name, arguments: args }, undefined, { timeout: OPERATION_TIMEOUT_MS }));
      expect(result.isError).not.toBe(true);
      return JSON.parse(envelope.parse(result).content[0]!.text) as unknown;
    };
    const answerAttempt = async (client: Client, args: Record<string, unknown>): Promise<AnswerAttempt> => {
      try { return { kind: 'answered', value: await call(client, 'answer_work', args) }; }
      catch (error) {
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return { kind: 'request_timed_out' };
        throw error;
      }
    };
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${viewer.port}${path}`, { signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS) });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain('"reply"');
      return body;
    };
    const first = await boot('first', review ? 'drop_accepted' : 'direct');
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

    const cold = await boot('cold', lateFinal ? 'delay_finished' : 'direct');
    const replay = z.object({ kind: z.literal('replay'), receipt: z.string() }).passthrough().parse(
      await call(cold.client, 'answer_work', { reply, answer }));
    expect(replay.receipt).toBe(expectedReceipt);
    expect(JSON.stringify(replay)).not.toContain('"reply"');
    const resumed = question.parse(await call(cold.client, 'recover_work', { recovery: work.recovery }));
    if (nextReply) expect(resumed.reply).toBe(nextReply);
    expect(resumed.instruction).toContain('Run produce.cjs');
    const output = await promisify(execFile)(process.execPath, ['produce.cjs'], { cwd: workspace, timeout: OPERATION_TIMEOUT_MS });
    expect(output.stdout).toBe('RETAINED RESULT');
    const competitor = await boot('competitor', lateFinal ? 'delay_finished' : 'direct');
    const finalAnswer = { reply: resumed.reply, answer: { notes: output.stdout } };
    const raced = await Promise.all([cold.client, competitor.client].map(client => answerAttempt(client, finalAnswer)));
    // Lock contention before delivery can refuse the answer; contention after
    // delivery/capture can leave its outcome unconfirmed. Neither is success.
    // Settlement must still produce one commit and the same replay for both clients.
    const results = raced.flatMap(attempt => attempt.kind === 'answered' ? [retention.parse(attempt.value)] : []);
    expect(results.filter(result => result.kind === 'recorded').length).toBeLessThanOrEqual(1);
    if (lateFinal) expect(raced.some(attempt => attempt.kind === 'request_timed_out')).toBe(true);
    // A missing response proves nothing about commit. Same-capability settlement
    // must produce a real retained receipt; it is not a test-framework retry.
    const settle = async () => {
      for (let attempt = 0; attempt < SETTLEMENT_ATTEMPTS; attempt++) {
        const observed = await answerAttempt(cold.client, finalAnswer);
        if (observed.kind === 'request_timed_out') continue;
        const result = retention.parse(observed.value);
        if (result.kind === 'recorded' || result.kind === 'replay') return result;
      }
      return undefined;
    };
    const finished = await settle();
    expect(finished).toBeDefined();
    if (!finished) throw new Error('No retained receipt after bounded settlement');
    for (const result of results) {
      if (result.kind === 'replay' || result.kind === 'recorded') expect(result.receipt).toBe(finished.receipt);
    }
    for (const client of [cold.client, competitor.client]) {
      expect(await call(client, 'answer_work', { reply: resumed.reply, answer: { notes: output.stdout } }))
        .toMatchObject({ kind: 'replay', receipt: finished.receipt });
    }
    expect(finished.receipt).not.toBe(expectedReceipt);
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('RETAINED RESULT');
    expect((await get(`/api/v2/sessions/${session}/answer`)).data.view.kind).toBe('finished');
    for (const [receipt, text] of [[expectedReceipt, notes], [finished.receipt, output.stdout]]) {
      expect(JSON.stringify(await get(`/api/v2/sessions/${session}/answer/receipts/${encodeURIComponent(receipt!)}`))).toContain(text);
    }
    const files = await readdir(join(data, 'sessions', session), { recursive: true });
    const logs = await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(file => readFile(join(data, 'sessions', session, file), 'utf8')));
    const events = logs.flatMap(log => log.split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const commits = events.filter(event => event.kind === 'answer_host_recorded' && ['committed', 'review_committed'].includes(event.data.kind));
    expect(commits.map(event => event.data.receipt).sort()).toEqual([expectedReceipt, finished.receipt].sort());
    if (lateFinal) {
      const delayed = await Promise.all(['cold', 'competitor'].map(async role => {
        try { return JSON.parse(await readFile(join(root, `late-${role}.json`), 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      }));
      expect(delayed.some(fault => fault?.delayed && fault.receipt === finished.receipt)).toBe(true);
    }
    if (review) {
      const artifacts = events.filter(event => event.kind === 'node_output_appended' && event.data.payload.payloadKind === 'artifact_ref');
      expect(artifacts.map(event => event.data.payload.content)).toEqual([{ kind: 'wr.review_verdict', verdict: 'clean', confidence: 'high', findings: [], summary: 'Fixture reviewed' }]);
    }
  } catch (error) {
    console.error(`[operational:${scenario}] failure evidence`, JSON.stringify(clients.map(({ role, transport, stderrTail }) => ({ role, pid: transport.pid, stderrTail }))));
    throw error;
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
