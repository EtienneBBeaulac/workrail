import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAnswerHost } from '../../../src/answer-v1/host.js';

it.each(['legacy', 'team.review'])('enrolls declared ID %s independently of its filename', async id => {
  const root = await mkdtemp(join(tmpdir(), 'answer-workflow-resolution-'));
  const lifetime = new AbortController();
  try {
    const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
      keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'workflows'),
      model: { generate: async () => ({ kind: 'cancelled' as const }) } };
    await mkdir(join(config.workflowStoragePath, 'team'), { recursive: true });
    await writeFile(join(config.workflowStoragePath, 'team', 'review-definition.json'), JSON.stringify({ id,
      name: 'Review', description: 'Declared identity', version: '1.0.0', steps: [{ id: 'one', title: 'One', prompt: 'Answer' }] }));
    const host = await createAnswerHost(config, lifetime.signal);
    if (host.kind !== 'created') throw new Error(host.kind);
    const result = await host.scheduler.enroll({ workflowId: id, goal: 'test', workspacePath: root }, lifetime.signal);
    expect(result.kind).toBe('enrolled');
    expect(await host.scheduler.enroll({ workflowId: '../review-definition', goal: 'test', workspacePath: root }, lifetime.signal))
      .toMatchObject({ kind: 'refused', reason: 'unsupported_workflow' });
    expect(await host.scheduler.close(lifetime.signal)).toEqual({ kind: 'closed' });
  } finally { lifetime.abort(); await rm(root, { recursive: true, force: true }); }
});
