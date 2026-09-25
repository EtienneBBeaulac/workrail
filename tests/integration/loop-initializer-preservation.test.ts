import 'reflect-metadata';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkRailEngine, type WorkRailEngine } from '../../src/engine/index.js';

// A repair must distinguish legitimate initializer evidence from an exited loop's
// decision. Clearing every first-iteration input would make these controls fail.
it.each((['while', 'until'] as const).flatMap(type =>
  (['continue', 'stop'] as const).map(decision => ({ type, decision }))))(
  'preserves initializer decisions: $type / $decision', async ({ type, decision }) => {
    const root = await mkdtemp(join(tmpdir(), 'workrail-loop-seed-'));
    const previous = process.env.WORKFLOW_STORAGE_PATH;
    let engine: WorkRailEngine | undefined;
    try {
      const workflows = join(root, 'workflows');
      await mkdir(workflows);
      await writeFile(join(workflows, 'seeded-loop.json'), JSON.stringify({
        id: 'seeded-loop', name: 'Seeded loop', version: '1.0.0', description: 'Initializer semantics',
        steps: [
          { id: 'initialize', title: 'Initialize', prompt: 'Decide whether work is needed.',
            outputContract: { contractRef: 'wr.contracts.loop_control' } },
          { id: 'loop', type: 'loop', title: 'Loop',
            loop: { type, maxIterations: 3, conditionSource: {
              kind: 'artifact_contract', contractRef: 'wr.contracts.loop_control', loopId: 'loop' } },
            body: [{ id: 'body', title: 'Work', prompt: 'Work and decide.',
              outputContract: { contractRef: 'wr.contracts.loop_control' } }] },
          { id: 'finish', title: 'Finish', prompt: 'Record completion.' },
        ],
      }));
      process.env.WORKFLOW_STORAGE_PATH = workflows;
      const created = await createWorkRailEngine({ dataDir: join(root, 'state') });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      engine = created.value;
      const started = await engine.startWorkflow('seeded-loop', 'Preserve initializer evidence');
      if (!started.ok || started.value.kind !== 'ok') throw new Error(JSON.stringify(started));
      expect(started.value.pending?.stepId).toBe('initialize');
      const seeded = await engine.continueWorkflow(started.value.stateToken, started.value.ackToken,
        { artifacts: [{ kind: 'wr.loop_control', decision }] });
      if (!seeded.ok || seeded.value.kind !== 'ok') throw new Error(JSON.stringify(seeded));
      expect(seeded.value.pending?.stepId).toBe(decision === 'stop' ? 'finish' : 'body');
      let current = seeded.value;
      if (decision === 'continue') {
        const stopped = await engine.continueWorkflow(current.stateToken, current.ackToken,
          { artifacts: [{ kind: 'wr.loop_control', decision: 'stop' }] });
        if (!stopped.ok || stopped.value.kind !== 'ok') throw new Error(JSON.stringify(stopped));
        expect(stopped.value.pending?.stepId).toBe('finish');
        current = stopped.value;
      }
      const finished = await engine.continueWorkflow(current.stateToken, current.ackToken,
        { notesMarkdown: 'Initializer and body decisions preserved.' });
      expect(finished.ok && finished.value.kind === 'ok' && finished.value.isComplete).toBe(true);
    } finally {
      try { await engine?.close(); }
      finally {
        if (previous === undefined) delete process.env.WORKFLOW_STORAGE_PATH;
        else process.env.WORKFLOW_STORAGE_PATH = previous;
        await rm(root, { recursive: true, force: true });
      }
    }
  });
