import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAnswerInvocationBinder } from '../../src/daemon/tools/answer-invocation.js';

it('atomically retains one binding across races, reconstruction, and changed payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'answer-binding-'));
  try {
    const bind = createAnswerInvocationBinder(root);
    const results = await Promise.all([bind('run', 'call', 'first', 'notes'), bind('run', 'call', 'second', 'notes')]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].kind).toBe('bound');
    expect(await createAnswerInvocationBinder(root)('run', 'call', 'third', 'notes')).toEqual(results[0]);
    expect(await bind('run', 'call', 'third', 'changed')).toEqual({ kind: 'refused', reason: 'conflicting_invocation' });
    expect(await bind('run', 'fresh', 'third', 'notes')).toEqual({ kind: 'bound', token: 'third' });
    expect(await bind('different-run', 'call', 'fourth', 'notes')).toEqual({ kind: 'bound', token: 'fourth' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses unreadable or corrupt retained bindings without replacing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'answer-binding-'));
  try {
    const bind = createAnswerInvocationBinder(root);
    await bind('run', 'call', 'first', 'notes');
    const directory = join(root, 'answer-invocations');
    const file = join(directory, (await readdir(directory))[0]!);
    await writeFile(file, 'corrupt');
    expect(await bind('run', 'call', 'second', 'notes')).toEqual({ kind: 'refused', reason: 'storage_unavailable' });
    expect(await readFile(file, 'utf8')).toBe('corrupt');
    const unavailable = join(root, 'not-directory');
    await writeFile(unavailable, 'file');
    expect(await createAnswerInvocationBinder(unavailable)('run', 'call', 'first', 'notes')).toEqual({ kind: 'refused', reason: 'storage_unavailable' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
