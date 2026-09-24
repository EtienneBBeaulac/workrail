import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';
import { createAnswerHost } from '../../../src/answer-v1/host.js';
import { createConsoleReadRuntime } from '../../../src/answer-v1/console.js';
import { composeAnswerReader } from '../../../src/answer-v1/engine-composition.js';
import type { SharedAuthorityConfig } from '../../../src/answer-v1/contracts/host-composition.js';

const signal = () => AbortSignal.timeout(15000);
async function fixture(run: (config: SharedAuthorityConfig, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'answer-console-'));
  const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
    keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'workflows') };
  try {
    await mkdir(config.workflowStoragePath);
    await writeFile(join(config.workflowStoragePath, 'notes.json'), JSON.stringify({ id: 'notes', name: 'Notes',
      description: 'Console fixture', version: '1.0.0', steps: [{ id: 'one', title: 'One', prompt: 'Observe' }, { id: 'two', title: 'Two', prompt: 'Finish' }] }));
    await run(config, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(path));
    else result[path] = (await readFile(path)).toString('base64');
  }
  return result;
}
it('console composition never creates missing keys or changes corrupt authority', () => fixture(async (config, root) => {
  const before = await snapshot(root);
  // Serialized host configuration is validated at composition, not allowed to throw.
  expect(await createConsoleReadRuntime({} as SharedAuthorityConfig, signal())).toMatchObject({ kind: 'refused', reason: 'missing_authority' });
  expect(await createConsoleReadRuntime(config, signal())).toMatchObject({ kind: 'refused', reason: 'storage_unavailable' });
  expect(await snapshot(root)).toEqual(before);
  await mkdir(join(root, 'keys'));
  await writeFile(config.keyringPath, '{broken');
  const corrupt = await snapshot(root);
  expect(await createConsoleReadRuntime(config, signal())).toMatchObject({ kind: 'refused' });
  expect(await snapshot(root)).toEqual(corrupt);
}));
it('scoped console follows canonical completion after owner release without writes or model authority', () => fixture(async (config, root) => {
  let calls = 0;
  const host = await createAnswerHost({ ...config, model: { async generate() {
    calls++;
    return { kind: 'completed', response: { responseText: '', calls: [{ id: 'answer', name: 'answer_work',
      argumentsJson: JSON.stringify({ answer: { notes: `Observation ${calls}` } }) }] } };
  } } }, signal());
  if (host.kind !== 'created') throw new Error(host.kind);
  const enrolled = await host.scheduler.enroll({ workflowId: 'notes', goal: 'Observe', workspacePath: root }, signal());
  if (enrolled.kind !== 'enrolled') throw new Error(enrolled.kind);
  const created = await createConsoleReadRuntime(config, signal());
  if (created.kind !== 'created') throw new Error(created.kind);
  expect(await created.runtime.unboundReader.getAnswer(asSessionId('sess_absent'))).toMatchObject({ kind: 'not_enrolled', reason: 'not_enrolled' });
  expect(await created.runtime.unboundReader.getAnswer(asSessionId('../invalid'))).toMatchObject({ kind: 'refused', reason: 'invalid_scope' });
  const binding = await created.runtime.bindHost(enrolled.enrollment, signal());
  if (binding.kind !== 'bound') throw new Error(binding.kind);
  const reader = binding.reader;
  const engine = await composeAnswerReader(config);
  expect(engine.kind).toBe('ready');
  if (engine.kind === 'ready') {
    expect(Object.keys(engine.engine.sessionStore)).toEqual(['load']);
    expect(engine.engine).not.toHaveProperty('gate');
    expect(engine.engine).not.toHaveProperty('idFactory');
  }
  try {
    const first = await enrolled.runner.runTurn(signal());
    if (first.kind !== 'advanced') throw new Error(first.kind);
    const before = await snapshot(root);
    const view = await reader.getAnswer();
    expect(view).toMatchObject({ kind: 'loaded', view: { kind: 'question' } });
    expect(JSON.stringify(view)).not.toMatch(/"(reply|recovery|owner|attempt)":/);
    expect(await created.runtime.unboundReader.getAnswer(reader.boundSessionId)).toMatchObject({ kind: 'refused', reason: 'bound_session_required' });
    expect(await reader.getReceipt(first.receipt)).toMatchObject({ kind: 'loaded', page: { chunk: JSON.stringify({ notes: 'Observation 1' }) } });
    expect(await snapshot(root)).toEqual(before);
    expect(calls).toBe(1);
    expect(await enrolled.runner.runTurn(signal())).toMatchObject({ kind: 'advanced', nextView: { kind: 'finished' } });
    expect(await host.scheduler.releaseOwnership(enrolled.enrollment, enrolled.owner, signal())).toEqual({ kind: 'released' });
    const done = await snapshot(root);
    expect(await reader.getAnswer()).toMatchObject({ kind: 'loaded', view: { kind: 'finished', execution: { kind: 'completed' } } });
    expect(await reader.getReceipt(first.receipt)).toMatchObject({ kind: 'loaded' });
    expect(await snapshot(root)).toEqual(done);
    await created.runtime.close(signal());
    expect(await reader.getAnswer()).toMatchObject({ kind: 'unavailable' });
    expect(calls).toBe(2);
  } finally { await created.runtime.close(signal()); await host.scheduler.close(signal()); }
}));
