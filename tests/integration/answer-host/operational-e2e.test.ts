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
it('runs tools, survives process death and replay, and exposes completed receipts over HTTP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'answer-operational-'));
  const data = join(root, 'data'), workspace = join(root, 'workspace'), workflows = join(root, 'workflows');
  const clients: Client[] = [];
  let stopViewer: (() => Promise<void>) | undefined;
  try {
    await mkdir(workspace); await mkdir(workflows);
    await writeFile(join(workspace, 'input.txt'), 'retained result');
    await writeFile(join(workspace, 'produce.cjs'), "const fs=require('node:fs');fs.writeFileSync('result.txt',fs.readFileSync('input.txt','utf8').toUpperCase());process.stdout.write(fs.readFileSync('result.txt','utf8'));\n");
    await writeFile(join(workflows, 'fixture.json'), JSON.stringify({ id: 'fixture', name: 'Fixture', description: 'Operational proof', version: '1.0.0', steps: [
      { id: 'read', title: 'Read input', prompt: 'Read input.txt and report its exact content.' },
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
    const boot = async () => {
      const client = new Client({ name: 'deterministic-operational-agent', version: '1' }); clients.push(client);
      const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp-server.js')],
        env: { ...getDefaultEnvironment(), WORKRAIL_AGENT_PROFILE: 'answers', WORKRAIL_ANSWER_AUTHORITY_FILE: authority,
          WORKRAIL_DATA_DIR: data, WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_TRANSPORT: 'stdio' }, stderr: 'pipe' });
      await client.connect(transport, { timeout: 5000 });
      expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['answer_work', 'inspect_work', 'open_work', 'recover_work']);
      return { client, transport };
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
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
    const first = await boot();
    const work = opened.parse(await call(first.client, 'open_work', { workflowId: 'fixture', goal: 'Produce a retained result', workspacePath: workspace }));
    expect(work.view.instruction).toContain('Read input.txt');
    const notes = await readFile(join(workspace, 'input.txt'), 'utf8');
    const accepted = recorded.parse(await call(first.client, 'answer_work', { reply: work.view.reply, answer: { notes } }));
    const next = question.parse(accepted.view);
    const sessions = (await readdir(join(data, 'sessions'), { withFileTypes: true })).filter(entry => entry.isDirectory());
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!.name;
    expect((await get(`/api/v2/sessions/${session}/answer`)).data.view.kind).not.toBe('finished');

    // Abruptly terminate the actual built server after the acknowledged commit.
    const pid = first.transport.pid;
    if (!pid) throw new Error('Missing server PID');
    const disconnected = new Promise<void>(resolve => { first.client.onclose = resolve; });
    process.kill(pid, 'SIGKILL');
    await disconnected;
    const cold = await boot();
    const replay = z.object({ kind: z.literal('replay'), receipt: z.string() }).passthrough().parse(
      await call(cold.client, 'answer_work', { reply: work.view.reply, answer: { notes } }));
    expect(replay.receipt).toBe(accepted.receipt);
    expect(JSON.stringify(replay)).not.toContain('"reply"');
    const resumed = question.parse(await call(cold.client, 'recover_work', { recovery: work.recovery }));
    expect(resumed.reply).toBe(next.reply);
    expect(resumed.instruction).toContain('Run produce.cjs');
    const output = await promisify(execFile)(process.execPath, ['produce.cjs'], { cwd: workspace, timeout: 5000 });
    expect(output.stdout).toBe('RETAINED RESULT');
    const finished = recorded.parse(await call(cold.client, 'answer_work', { reply: resumed.reply, answer: { notes: output.stdout } }));
    expect(finished.view.kind).toBe('finished');
    expect(finished.receipt).not.toBe(accepted.receipt);
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('RETAINED RESULT');
    expect((await get(`/api/v2/sessions/${session}/answer`)).data.view.kind).toBe('finished');
    for (const [receipt, text] of [[accepted.receipt, notes], [finished.receipt, output.stdout]]) {
      expect(JSON.stringify(await get(`/api/v2/sessions/${session}/answer/receipts/${encodeURIComponent(receipt!)}`))).toContain(text);
    }
  } finally {
    for (const client of clients) await client.close();
    await stopViewer?.();
    await rm(root, { recursive: true, force: true });
  }
});
