import { it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, symlink, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareAdmissionDirectory, discoverAdmissionOperations } from '../../../src/answer-v1/admission-directory.js';

it.skipIf(process.platform === 'win32')('concurrent creation shares one canonical root and discovery retains every entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admission-directory-'));
  try {
    const journal = join(root, 'new', 'nested', 'sessions'), signal = new AbortController().signal;
    const results = await Promise.all([1, 2].map(() => prepareAdmissionDirectory(journal, signal)));
    expect(results[0]).toEqual({ kind: 'ready', root: join(await realpath(journal), '.answer-admissions') });
    expect(results[1]).toEqual(results[0]);
    const ready = results[0];
    if (!ready || ready.kind !== 'ready') throw new Error('not ready');
    const ids = [randomUUID(), randomUUID()].sort();
    // Corrupt candidates are discoverable, never considered validated by inventory.
    for (const id of ids) await writeFile(join(ready.root, `${id}.json`), '{corrupt');
    await writeFile(join(ready.root, '.abandoned.tmp'), 'retained');
    await writeFile(join(ready.root, 'future-format'), 'retained');
    expect(await discoverAdmissionOperations(journal, signal)).toEqual({ kind: 'discovered', root: ready.root,
      operationIds: ids, retainedOtherEntries: 2 });
    expect((await readdir(ready.root)).sort()).toEqual(['.abandoned.tmp', 'future-format', ...ids.map(id => `${id}.json`)].sort());
    expect(await readdir(journal)).toEqual(['.answer-admissions']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('refuses a substituted admission directory without writing into its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admission-directory-link-'));
  try {
    const journal = join(root, 'sessions'), target = join(root, 'foreign');
    await mkdir(journal); await mkdir(target);
    await symlink(target, join(journal, '.answer-admissions'));
    expect(await prepareAdmissionDirectory(journal, new AbortController().signal)).toEqual({ kind: 'refused', reason: 'invalid_directory' });
    expect(await readdir(target)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses relative roots before storage', async () => {
  expect(await prepareAdmissionDirectory('relative', new AbortController().signal)).toEqual({ kind: 'refused', reason: 'invalid_input' });
});

it.skipIf(process.platform === 'win32')('cancellation does not create a new directory chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admission-directory-cancel-'));
  try {
    const controller = new AbortController(); controller.abort();
    expect(await prepareAdmissionDirectory(join(root, 'new', 'sessions'), controller.signal))
      .toEqual({ kind: 'unconfirmed', reason: 'cancelled' });
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'win32')('refuses unsupported directory durability on Windows', async () => {
  expect(await prepareAdmissionDirectory(process.cwd(), new AbortController().signal))
    .toEqual({ kind: 'refused', reason: 'unsupported_platform' });
});
