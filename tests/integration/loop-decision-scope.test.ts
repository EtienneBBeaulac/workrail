import 'reflect-metadata';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkRailEngine } from '../../src/engine/index.js';
import { DomainEventV1Schema } from '../../src/v2/durable-core/schemas/session/index.js';
import type { WorkRailEngine, StepResponseOk, StepResponseBlocked } from '../../src/engine/index.js';

const cases = (['adjacent', 'separated'] as const).flatMap(arrangement =>
  (['correct', 'omitted', 'misleading'] as const).flatMap(identity =>
    (['live', 'reopened'] as const).map(lifecycle => ({ arrangement, identity, lifecycle }))));

it.each(cases)('keeps loop decisions scoped: $arrangement / $identity / $lifecycle', async ({ arrangement, identity, lifecycle }) => {
  const root = await mkdtemp(join(tmpdir(), 'workrail-loop-preservation-'));
  const previousStorage = process.env.WORKFLOW_STORAGE_PATH;
  let engine: WorkRailEngine | undefined;
  try {
    const workflows = join(root, 'workflows');
    await mkdir(workflows);
    await writeFile(join(workflows, 'loop-preservation.json'), JSON.stringify({
      id: 'loop-preservation', name: 'Loop preservation', version: '1.0.0', description: 'Two independent artifact-controlled loops',
      steps: [
        { id: 'initialize', title: 'Initialize', prompt: 'Initialize both loops.' },
        ...['one', 'two'].flatMap(id => [{ id, type: 'loop', title: id,
          loop: { type: 'while', maxIterations: 3, conditionSource: { kind: 'artifact_contract', contractRef: 'wr.contracts.loop_control', loopId: id } },
          body: [
            { id: `${id}-work`, title: 'Work', prompt: `Work for ${id}` },
            { id: `${id}-decision`, title: 'Decision', prompt: `Decide for ${id}`, outputContract: { contractRef: 'wr.contracts.loop_control' } },
          ],
        }, ...(arrangement === 'separated' && id === 'one' ? [{ id: 'separator', title: 'Separate', prompt: 'Begin the next independent loop.' }] : [])]),
        { id: 'finish', title: 'Finish', prompt: 'Finish both loops.' },
      ],
    }));
    process.env.WORKFLOW_STORAGE_PATH = workflows;
    const created = await createWorkRailEngine({ dataDir: join(root, 'state') });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error('No fixture engine');
    engine = created.value;
    const unwrap = (result: Awaited<ReturnType<WorkRailEngine['continueWorkflow']>>) => {
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok || result.value.kind === 'gate_checkpoint') throw new Error('Unexpected loop outcome');
      return result.value;
    };
    const answer = async (state: StepResponseOk | StepResponseBlocked, output: { notesMarkdown?: string; artifacts?: readonly unknown[] }) =>
      unwrap(await engine!.continueWorkflow(state.stateToken, state.kind === 'blocked' ? state.retryAckToken : state.ackToken, output));
    const journals = async (directory = join(root, 'state')): Promise<Record<string, string>> => {
      const result: Record<string, string> = {};
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) Object.assign(result, await journals(path));
        else if (entry.name.endsWith('.jsonl')) result[path] = await readFile(path, 'utf8');
      }
      return result;
    };
    const loopArtifact = (loopId: string, decision: 'continue' | 'stop') => ({
      kind: 'wr.loop_control', decision,
      ...(identity === 'omitted' ? {} : { loopId: identity === 'correct' ? loopId : `unrelated-${loopId}` }),
    });
    let state = unwrap(await engine.startWorkflow('loop-preservation', 'Preserve loop semantics'));
    expect(state.pending?.stepId).toBe('initialize');
    state = await answer(state, { notesMarkdown: 'Begin both loops.' });
    for (const loopId of ['one', 'two']) {
      expect(state.pending?.stepId).toBe(`${loopId}-work`);
      state = await answer(state, { notesMarkdown: `First work for ${loopId}` });
      expect(state.pending?.stepId).toBe(`${loopId}-decision`);
      state = await answer(state, { artifacts: [loopArtifact(loopId, 'continue')] });
      expect(state.pending?.stepId).toBe(`${loopId}-work`);
      state = await answer(state, { notesMarkdown: `Second work for ${loopId}` });
      expect(state.pending?.stepId).toBe(`${loopId}-decision`);
      const decision = state;
      const stop = { artifacts: [loopArtifact(loopId, 'stop')] };
      if (lifecycle === 'reopened') {
        const beforeReopen = await journals();
        await engine.close();
        engine = undefined;
        const reopened = await createWorkRailEngine({ dataDir: join(root, 'state') });
        expect(reopened.ok, JSON.stringify(reopened)).toBe(true);
        if (!reopened.ok) throw new Error('Could not reopen fixture engine');
        engine = reopened.value;
        expect(await journals()).toEqual(beforeReopen);
      }
      state = await answer(decision, stop);
      expect(state.pending?.stepId).toBe(loopId === 'one' ? (arrangement === 'separated' ? 'separator' : 'two-work') : 'finish');
      if (lifecycle === 'reopened') {
        const beforeRestart = await journals();
        await engine.close();
        const restarted = await createWorkRailEngine({ dataDir: join(root, 'state') });
        expect(restarted.ok).toBe(true);
        if (!restarted.ok) throw new Error('Could not reopen after loop exit');
        engine = restarted.value;
        expect(await journals()).toEqual(beforeRestart);
      }
      const beforeReplay = await journals();
      const replay = await answer(decision, stop);
      expect(replay).toEqual(state);
      expect(await journals()).toEqual(beforeReplay);
      if (loopId === 'one' && arrangement === 'separated') state = await answer(state, { notesMarkdown: 'Begin the independent second loop.' });
    }
    state = await answer(state, { notesMarkdown: 'Both loops completed.' });
    expect(state.isComplete).toBe(true);
    const events = Object.entries(await journals(join(root, 'state', 'sessions'))).filter(([path]) => !path.includes('manifest'))
      .flatMap(([, content]) => content.split('\n').filter(Boolean).map(line => DomainEventV1Schema.parse(JSON.parse(line))));
    const bodyNotes = events.flatMap(event => event.kind === 'node_output_appended'
      && event.data.payload.payloadKind === 'notes'
      && /^(First|Second) work for (one|two)$/.test(event.data.payload.notesMarkdown)
      ? [event.data.payload.notesMarkdown] : []);
    expect(bodyNotes.sort()).toEqual(['First work for one', 'First work for two', 'Second work for one', 'Second work for two']);
  } finally {
    try { await engine?.close(); }
    finally {
      if (previousStorage === undefined) delete process.env.WORKFLOW_STORAGE_PATH;
      else process.env.WORKFLOW_STORAGE_PATH = previousStorage;
      await rm(root, { recursive: true, force: true });
    }
  }
});
