import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { z } from 'zod';

// Uses the same built executable as the existing bin smoke tests. Build before testing.
const executable = resolve(__dirname, '../../../dist/mcp-server.js');
const question = z.object({ kind: z.literal('question'), reply: z.string() }).passthrough();
const opened = z.object({ kind: z.literal('opened'), recovery: z.string(), view: question }).passthrough();
const recorded = z.object({ kind: z.literal('recorded'), view: z.object({ kind: z.string() }).passthrough() }).passthrough();

it.each(['pin', 'auto'] as const)('serves modern SDK clients over actual stdio with %s negotiation and recovers after restart', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'answer-stdio-'));
  const clients: Client[] = [];
  const sent: unknown[] = [];
  try {
    const workflows = join(root, 'workflows'); await mkdir(workflows);
    await writeFile(join(workflows, 'fixture.json'), JSON.stringify({ id: 'fixture', name: 'Fixture', description: 'Fixture', version: '1.0.0',
      steps: [{ id: 'one', title: 'One', prompt: 'First note' }, { id: 'two', title: 'Two', prompt: 'Second note' }] }));
    const file = join(root, 'authority.json');
    await writeFile(file, JSON.stringify({ formatVersion: 1, authority: {
      storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
      keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflows,
    } }));
    const boot = async () => {
      const client = new Client({ name: 'answer-stdio-proof', version: '1' }, { versionNegotiation: { mode: mode === 'pin' ? { pin: '2026-07-28' } : 'auto' } }); clients.push(client);
      const transport = new StdioClientTransport({ command: process.execPath, args: [executable],
        env: { ...getDefaultEnvironment(), HOME: root, WORKRAIL_AGENT_PROFILE: 'answers', WORKRAIL_ANSWER_AUTHORITY_FILE: file,
          WORKRAIL_DATA_DIR: root, WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_TRANSPORT: 'stdio' }, stderr: 'pipe' });
      const send = transport.send.bind(transport);
      transport.send = async message => { sent.push(message); await send(message); };
      await client.connect(transport, { timeout: 5000 });
      if (mode === 'auto') expect(client.getDiscoverResult()).toBeDefined();
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['answer_work', 'inspect_work', 'open_work', 'recover_work']);
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      expect(result.isError).not.toBe(true);
      const envelope = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough()).min(1) }).passthrough().parse(result);
      return JSON.parse(envelope.content[0]!.text) as unknown;
    };
    const first = await boot();
    const work = opened.parse(await call(first, 'open_work', { workflowId: 'fixture', goal: 'Retain notes', workspacePath: root }));
    const answer = recorded.parse(await call(first, 'answer_work', { reply: work.view.reply, answer: { notes: 'First retained note' } }));
    const pending = question.parse(answer.view);
    await first.close(); clients.splice(clients.indexOf(first), 1);
    const cold = await boot();
    const recovered = question.parse(await call(cold, 'recover_work', { recovery: work.recovery }));
    expect(recovered.reply).toBe(pending.reply);
    expect(recorded.parse(await call(cold, 'answer_work', { reply: recovered.reply, answer: { notes: 'Second retained note' } })).view.kind).toBe('finished');
    const requests = z.array(z.object({ method: z.string(), params: z.object({ _meta: z.record(z.unknown()).optional() }).passthrough().optional() }).passthrough()).parse(sent.filter(message => typeof message === 'object' && message !== null && 'method' in message));
    const calls = requests.filter(request => request.method === 'tools/call');
    expect(calls).toHaveLength(4);
    for (const request of calls) {
      expect(request.params?._meta?.['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
    }
  } finally { for (const client of clients) await client.close(); await rm(root, { recursive: true, force: true }); }
});
