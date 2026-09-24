import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAnswerAuthority } from '../../src/mcp/answer-authority-config.js';

it('requires one explicit authority source and never invents defaults', async () => {
  expect(await resolveAnswerAuthority(undefined, undefined)).toEqual({ kind: 'refused', reason: 'missing_authority' });
  expect(await resolveAnswerAuthority(undefined, 'relative.json')).toEqual({ kind: 'refused', reason: 'invalid_configuration' });
  const options = { answerAuthority: { storage: { journalRootDir: tmpdir(), hostIndexRootDir: tmpdir() }, keyringPath: tmpdir(), workflowStoragePath: tmpdir() } };
  expect(await resolveAnswerAuthority(options, join(tmpdir(), 'not-read.json'))).toEqual({ kind: 'refused', reason: 'ambiguous_authority' });
  expect(await resolveAnswerAuthority(options, undefined)).toEqual({ kind: 'configured', options });
});
it('loads a strict bounded authority document and rejects malformed or unsupported configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'answer-config-'));
  try {
    const file = join(root, 'authority.json');
    const authority = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
      keyringPath: join(root, 'keys.json'), workflowStoragePath: join(root, 'workflows') };
    for (const input of [JSON.stringify({ formatVersion: 2, authority }), JSON.stringify({ formatVersion: 1, authority, extra: true }),
      JSON.stringify({ formatVersion: 1, authority: { ...authority, keyringPath: 'relative' } }), '{', ' '.repeat(65537)]) {
      await writeFile(file, input);
      expect(await resolveAnswerAuthority(undefined, file)).toEqual({ kind: 'refused', reason: 'invalid_configuration' });
    }
    await writeFile(file, Buffer.concat([Buffer.from('{"formatVersion":1,"authority":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
    expect(await resolveAnswerAuthority(undefined, file)).toEqual({ kind: 'refused', reason: 'invalid_configuration' });
    await writeFile(file, JSON.stringify({ formatVersion: 1, authority }));
    expect(await resolveAnswerAuthority(undefined, file)).toEqual({ kind: 'configured', options: { answerAuthority: authority } });
    expect(await resolveAnswerAuthority(undefined, root)).toEqual({ kind: 'refused', reason: 'invalid_configuration' });
    expect(await resolveAnswerAuthority(undefined, join(root, 'missing'))).toEqual({ kind: 'refused', reason: 'unreadable_configuration' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
