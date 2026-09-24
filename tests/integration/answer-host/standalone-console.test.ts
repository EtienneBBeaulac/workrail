import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startStandaloneConsole } from '../../../src/console/standalone-console.js';
import { createAnswerWorker } from '../../../src/answer-v1/worker.js';

it('standalone HTTP console sees later-created answer authority and preserves exact receipts without granting replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'standalone-answers-'));
  const data = join(root, 'data');
  const lifetime = new AbortController();
  const console = await startStandaloneConsole({ port: 0, dataDir: data, lockFilePath: join(root, 'console.lock') });
  if (console.kind !== 'ok') throw new Error(console.kind);
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${console.port}${path}`);
    return { status: response.status, body: await response.json() };
  };
  try {
    const absent = await get('/api/v2/sessions/sess_absent/answer');
    expect(absent.status).toBe(503);
    expect(absent.body.outcome).toMatchObject({ kind: 'unavailable', reason: 'storage_unavailable' });
    expect(await readdir(join(data, 'keys')).catch(() => [])).toEqual([]);
    const workflowStoragePath = join(root, 'workflows');
    await mkdir(workflowStoragePath);
    await writeFile(join(workflowStoragePath, 'notes.json'), JSON.stringify({ id: 'notes', name: 'Notes', description: 'Test', version: '1.0.0',
      steps: [{ id: 'one', title: 'One', prompt: 'Write notes' }] }));
    const worker = await createAnswerWorker({ storage: { journalRootDir: join(data, 'sessions'), hostIndexRootDir: join(data, 'index') },
      keyringPath: join(data, 'keys', 'keyring.json'), workflowStoragePath }, lifetime.signal);
    if (worker.kind !== 'created') throw new Error(worker.kind);
    try {
      const opened = await worker.opener.open({ workflowId: 'notes', workspacePath: root, goal: 'Verify HTTP read' }, lifetime.signal);
      if (opened.kind !== 'opened' || opened.view.kind !== 'question') throw new Error(opened.kind);
      // The durable directory identity is independent of opaque read/reply capabilities.
      const [id] = await readdir(join(data, 'sessions'));
      expect(id).toBeDefined();
      const beforeKeys = await readFile(join(data, 'keys', 'keyring.json'), 'utf8');
      const pending = await get(`/api/v2/sessions/${id}/answer`);
      expect(pending.status).toBe(200);
      expect(JSON.stringify(pending.body)).not.toContain('"reply"');
      const answered = await worker.worker.answer(opened.view.reply, { kind: 'unvalidated_json', value: { notes: 'Exact HTTP evidence.' } }, lifetime.signal);
      if (answered.kind !== 'recorded') throw new Error(answered.kind);
      const finished = await get(`/api/v2/sessions/${id}/answer`);
      expect(finished.status).toBe(200);
      expect(finished.body.data.view.kind).toBe('finished');
      const receipt = await get(`/api/v2/sessions/${id}/answer/receipts/${encodeURIComponent(answered.receipt)}`);
      expect(receipt.status).toBe(200);
      expect(JSON.stringify(receipt.body)).toContain('Exact HTTP evidence.');
      expect(JSON.stringify(receipt.body)).not.toContain('"reply"');
      expect(await readFile(join(data, 'keys', 'keyring.json'), 'utf8')).toBe(beforeKeys);
    } finally { await worker.close(lifetime.signal); }
  } finally { await console.stop(); await rm(root, { recursive: true, force: true }); }
});
