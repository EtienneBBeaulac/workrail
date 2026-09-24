import { it, expect } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenPersister } from '../../src/daemon/tools/_shared.js';

it('binds all sidecar writes to one session directory and keeps other runner directories independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-persister-'));
  try {
    const left = createTokenPersister(join(root, 'left'), { worktreePath: '/isolated/tree',
      recoveryContext: { workflowId: 'review', goal: 'Review', workspacePath: '/source', branchStrategy: 'read-only' } });
    const right = createTokenPersister(join(root, 'right'));
    expect(await left('same-id', 'left-token', null)).toEqual({ kind: 'ok', value: undefined });
    expect(await right('same-id', 'right-token', null)).toEqual({ kind: 'ok', value: undefined });
    expect(JSON.parse(await readFile(join(root, 'left', 'same-id.json'), 'utf8')).continueToken).toBe('left-token');
    expect(JSON.parse(await readFile(join(root, 'right', 'same-id.json'), 'utf8')).continueToken).toBe('right-token');
    expect(await left('same-id', 'next-token', null)).toEqual({ kind: 'ok', value: undefined });
    expect(JSON.parse(await readFile(join(root, 'left', 'same-id.json'), 'utf8'))).toMatchObject({
      continueToken: 'next-token', worktreePath: '/isolated/tree', workflowId: 'review', goal: 'Review', workspacePath: '/source', branchStrategy: 'read-only',
    });
    expect(await readdir(join(root, 'left'))).toEqual(['same-id.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
