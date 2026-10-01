import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer, type HttpServerHandle } from '../../../src/mcp/transports/http-entry.js';
import { resetContainer } from '../../../src/di/container.js';

let root: string;
let handle: HttpServerHandle;
let originalEnv: NodeJS.ProcessEnv;
let requestId = 0;
let url: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'modern-answer-http-'));
  originalEnv = { ...process.env };
  const workflows = join(root, 'workflows'); await mkdir(workflows);
  await writeFile(join(workflows, 'fixture.json'), JSON.stringify({ id: 'fixture', name: 'Fixture', description: 'Fixture', version: '1.0.0', steps: [{ id: 'one', title: 'One', prompt: 'First note' }, { id: 'two', title: 'Two', prompt: 'Second note' }] }));
  const authority = join(root, 'authority.json');
  await writeFile(authority, JSON.stringify({ formatVersion: 1, authority: { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') }, keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflows } }));
  process.env.WORKRAIL_AGENT_PROFILE = 'answers';
  process.env.WORKRAIL_ANSWER_AUTHORITY_FILE = authority;
  process.env.WORKRAIL_DATA_DIR = root;
  process.env.WORKRAIL_ENABLE_SESSION_TOOLS = 'false';
  handle = await startHttpServer(0);
  url = `http://localhost:${handle.port}/mcp`;
});
afterAll(async () => {
  if (handle) expect(await handle.close(AbortSignal.timeout(5000))).toBe('closed');
  process.env = originalEnv;
  resetContainer();
  await rm(root, { recursive: true, force: true });
});
function meta(version = '2026-07-28') {
  return { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': { name: 'modern-http-proof', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
}
async function request(method: string, name?: string, args?: Record<string, unknown>, headers: Record<string, string> = {}, version = '2026-07-28') {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}), ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params: { ...(name ? { name, arguments: args } : {}), _meta: meta(version) } }) });
}
async function call(name: string, args: Record<string, unknown>) {
  const response = await request('tools/call', name, args);
  expect(response.status).toBe(200);
  expect(response.headers.get('mcp-session-id')).toBeNull();
  const wire = await response.json();
  expect(wire.result.resultType).toBe('complete');
  expect(wire.result.isError).not.toBe(true);
  return JSON.parse(wire.result.content[0].text);
}
it('discovers and executes a modern answer workflow without an HTTP session', async () => {
  const discovery = await request('server/discover');
  expect(discovery.status).toBe(200);
  expect((await discovery.json()).result.resultType).toBe('complete');
  const work = await call('open_work', { workflowId: 'fixture', workspacePath: root, goal: 'modern HTTP' });
  const first = await call('answer_work', { reply: work.view.reply, answer: { notes: 'first' } });
  expect(first).toMatchObject({ kind: 'recorded', view: { kind: 'question' } });
  expect(await call('recover_work', { recovery: work.recovery })).toEqual(first.view);
  expect(await call('answer_work', { reply: first.view.reply, answer: { notes: 'last' } })).toMatchObject({ kind: 'recorded', view: { kind: 'finished' } });
});
it('refuses modern header mismatches and untrusted origin before workflow effects', async () => {
  const before = await readdir(join(root, 'sessions'));
  const args = { workflowId: 'fixture', workspacePath: root, goal: 'must not execute' };
  const mismatch = await request('tools/call', 'open_work', args, { 'Mcp-Name': 'answer_work' });
  expect(mismatch.status).toBe(400);
  expect((await mismatch.json()).error.code).toBe(-32020);
  const origin = await request('tools/call', 'open_work', args, { Origin: 'https://untrusted.example' });
  expect(origin.status).toBe(403);
  const unsupported = await request('tools/call', 'open_work', args, {}, '2099-01-01');
  expect((await unsupported.json()).error).toBeDefined();
  expect(await readdir(join(root, 'sessions'))).toEqual(before);
});
it('legacy session GET and DELETE preserve shared authority for modern requests', async () => {
  const initialized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-session-proof', version: '1' } } }) });
  expect(initialized.status).toBe(200);
  const session = initialized.headers.get('mcp-session-id');
  expect(session).toBeTruthy();
  await initialized.json();
  const stream = await fetch(url, { method: 'GET', headers: { accept: 'text/event-stream', 'mcp-session-id': session! } });
  expect(stream.status).toBe(200);
  await stream.body?.cancel();
  const deleted = await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': session! } });
  expect(deleted.status).toBe(200);
  const work = await call('open_work', { workflowId: 'fixture', workspacePath: root, goal: 'after legacy deletion' });
  expect(work).toMatchObject({ kind: 'opened', view: { kind: 'question' } });
});
