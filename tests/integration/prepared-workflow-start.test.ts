import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeAnswerEngine } from '../../src/answer-v1/engine-composition.js';
import { prepareStartWorkflow, commitPreparedWorkflowStart } from '../../src/v2/usecases/start-workflow.js';
import { createWorkflow } from '../../src/types/workflow.js';
import { createUserDirectorySource } from '../../src/types/workflow-source.js';

it('prepares without session writes and commits the same identity once without a workflow reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prepared-workflow-'));
  try {
    const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
      keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'workflows') };
    const engine = await composeAnswerEngine(config);
    if (engine.kind !== 'ready') throw new Error(engine.kind);
    const workflow = createWorkflow({ id: 'prepared', name: 'Prepared', description: 'Prepared identity', version: '1.0.0',
      steps: [{ id: 'one', title: 'First', prompt: 'Original instruction' }] }, createUserDirectorySource(config.workflowStoragePath));
    const prepared = await prepareStartWorkflow({ ...engine, fallbackWorkflowReader: { getWorkflowById: async () => workflow } },
      { workflowId: 'prepared', goal: 'one request', workspacePath: root, injectOnboarding: false });
    if (prepared.isErr()) throw new Error(prepared.error.kind);
    const before = await engine.sessionStore.load(prepared.value.sessionId);
    if (before.isErr()) throw new Error(before.error.code);
    expect(before.value).toEqual({ events: [], manifest: [] });
    // The commit capability has no workflow reader, so it cannot resolve changed source.
    const attempts = await Promise.all([
      commitPreparedWorkflowStart(engine, prepared.value),
      commitPreparedWorkflowStart(engine, prepared.value),
    ]);
    expect(attempts.filter(result => result.isOk())).toHaveLength(1);
    expect(attempts.filter(result => result.isErr())).toHaveLength(1);
    const committed = attempts.find(result => result.isOk());
    if (!committed) throw new Error('no committed start');
    if (committed.isErr()) throw new Error(committed.error.kind);
    expect(committed.value.sessionId).toBe(prepared.value.sessionId);
    expect(committed.value.runId).toBe(prepared.value.runId);
    expect(committed.value.nodeId).toBe(prepared.value.nodeId);
    expect(committed.value.meta).toEqual(prepared.value.meta);
    const original = await engine.sessionStore.load(prepared.value.sessionId);
    expect(original.isOk()).toBe(true);
    const repeat = await commitPreparedWorkflowStart(engine, prepared.value);
    expect(repeat.isErr()).toBe(true);
    if (repeat.isErr()) expect(repeat.error.kind).toBe('invariant_violation');
    expect(await engine.sessionStore.load(prepared.value.sessionId)).toEqual(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
