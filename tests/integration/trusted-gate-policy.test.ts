import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { createV2ToolContext, mkV2TestDataDir, resolveSessionIdFromToken } from '../../tests/helpers/v2-test-helpers.js';
import { startWorkflowForTest } from '../../tests/helpers/v2-start-workflow-helper.js';
import { unwrapResponse } from '../../tests/helpers/unwrap-response.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { createWorkflow } from '../../src/types/workflow.js';
import { createBundledSource } from '../../src/types/workflow-source.js';
import { EnvironmentFeatureFlagProvider } from '../../src/config/feature-flags.js';
import { handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import { asSessionId } from '../../src/v2/durable-core/ids/index.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

// Intended behavior on the existing engine boundary. Baseline failures are
// requirements, not passing characterizations or a proposed replacement API.
async function submit(mode: 'direct' | 'corrected' | 'worker-context' | 'ordinary') {
  const data = await mkV2TestDataDir('workrail-gate-acceptance-');
  try {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: data.root });
    const base = await createV2ToolContext(dataDir);
    if (!base.v2) throw new Error('Missing fixture engine');
    const workflow = createWorkflow({
      id: 'gate-acceptance', name: 'Gate acceptance', description: 'Host gate policy', version: '1.0.0',
      steps: [
        { id: 'work', title: 'Work', prompt: 'Complete the task.', ...(mode === 'ordinary' ? {} : { requireConfirmation: true }) },
        { id: 'next', title: 'Next', prompt: 'Proceed after permission.' },
      ],
    }, createBundledSource());
    const ctx: V2ToolContext = { ...base, v2: base.v2, featureFlags: new EnvironmentFeatureFlagProvider(),
      workflowService: { ...base.workflowService, getWorkflowById: async () => workflow } };
    const start = await startWorkflowForTest({ workflowId: workflow.definition.id,
      workspacePath: data.root, goal: 'Verify gate obligations' }, ctx, { is_autonomous: 'true' });
    if (start.type !== 'success') throw new Error(`Fixture start: ${start.error}`);
    const initial = unwrapResponse(start.data);
    let continueToken = initial.continueToken;
    if (mode === 'corrected') {
      const invalid = await handleV2ContinueWorkflow({ continueToken, output: { notesMarkdown: '' } }, ctx);
      if (invalid.type !== 'success') throw new Error('Invalid answer did not reach validation');
      const blocked = unwrapResponse(invalid.data);
      expect(blocked.kind).toBe('blocked');
      continueToken = blocked.continueToken!;
    }
    const notes = `Exact evaluated work for ${mode}: observed result, not an approval.`;
    const result = await handleV2ContinueWorkflow({ continueToken, output: { notesMarkdown: notes },
      ...(mode === 'worker-context' ? { context: { is_autonomous: 'false' } } : {}),
    }, ctx);
    if (result.type !== 'success') throw new Error('Submission failed before gate policy');
    const response = unwrapResponse(result.data);
    const sessionId = asSessionId(resolveSessionIdFromToken(initial.continueToken, ctx.v2.tokenAliasStore!));
    // Recreate the storage adapters; no in-memory event object is the retention oracle.
    const recovered = await createV2ToolContext(dataDir);
    if (!recovered.v2) throw new Error('Missing recovered engine');
    const events = (await recovered.v2.sessionStore.load(sessionId))._unsafeUnwrap().events;
    const retainedNotes = events.flatMap(event => event.kind === 'node_output_appended' && event.data.payload.payloadKind === 'notes'
      ? [event.data.payload.notesMarkdown] : []);
    return { response, notes, retainedNotes };
  } finally { await data.cleanup(); }
}

describe('host-owned gate admission', () => {
  it('permits ordinary work to reach the next task', async () => {
    const { response } = await submit('ordinary');
    expect(response.kind).toBe('ok');
    expect(response.pending?.stepId).toBe('next');
  });
  it.each(['direct', 'corrected', 'worker-context'] as const)('keeps %s work gated', async mode => {
    const { response } = await submit(mode);
    expect(response.kind).toBe('gate_checkpoint');
    expect(response.stepId).toBe('work');
  });
});

describe('retained work at a gate', () => {
  it.each(['ordinary', 'direct'] as const)('recovers exact notes for %s work', async mode => {
    const { response, notes, retainedNotes } = await submit(mode);
    expect(response.kind).toBe(mode === 'ordinary' ? 'ok' : 'gate_checkpoint');
    expect(retainedNotes).toEqual([notes]);
  });
});
