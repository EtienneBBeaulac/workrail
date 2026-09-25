import 'reflect-metadata';
import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createWorkRailEngine } from '../../src/engine/index.js';
import type { StepResponseOk, StepResponseBlocked } from '../../src/engine/index.js';

// Invoked by cross-version.py in separate source trees and processes. Neither
// phase uses the other revision's engine modules or any existing user session.
it('transfers pending and blocked sessions between actual source revisions', async () => {
  const root = process.env.WORKRAIL_COMPAT_ROOT;
  const phase = process.env.WORKRAIL_COMPAT_PHASE;
  if (!root || !['write', 'read'].includes(phase ?? '')) throw new Error('Use cross-version.py');
  const workflows = join(root, phase === 'write' ? 'writer-workflows' : 'empty-reader-workflows');
  await mkdir(workflows, { recursive: true });
  process.env.WORKFLOW_STORAGE_PATH = workflows;
  const artifact = { kind: 'wr.review_verdict', verdict: 'clean', confidence: 'high', findings: [], summary: 'Retained old writer finding assessment.' };
  if (phase === 'write') await writeFile(join(workflows, 'compat-transfer.json'), JSON.stringify({
    id: 'compat-transfer', name: 'Compatibility transfer', version: '1.0.0', description: 'Frozen compatibility workflow',
    steps: ['first', 'second'].map(id => ({ id, title: id, prompt: `Pinned ${id} prompt.`, ...(id === 'first' ? { outputContract: { contractRef: 'wr.contracts.review_verdict' } } : {}) })),
  }));
  const created = await createWorkRailEngine({ dataDir: join(root, 'state') });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  if (!created.ok) throw new Error('Engine creation failed');
  const engine = created.value;
  const unwrap = (result: Awaited<ReturnType<typeof engine.continueWorkflow>>) => {
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok || result.value.kind === 'gate_checkpoint') throw new Error('Unexpected transfer result');
    return result.value;
  };
  const journals = async (directory = join(root, 'state')): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) Object.assign(result, await journals(file));
      else if (entry.name.endsWith('.jsonl')) result[relative(root, file)] = await readFile(file, 'utf8');
    }
    return result;
  };
  try {
    if (phase === 'write') {
      const transfers: (StepResponseOk | StepResponseBlocked)[] = [];
      for (const blocked of [false, true]) {
        const first = unwrap(await engine.startWorkflow('compat-transfer', 'Cross-version fixture'));
        const second = unwrap(await engine.continueWorkflow(first.stateToken, first.ackToken, { notesMarkdown: 'Old writer retained notes.', artifacts: [artifact] }));
        expect(second.pending?.stepId).toBe('second');
        const pending = blocked ? unwrap(await engine.continueWorkflow(second.stateToken, second.ackToken, {})) : second;
        expect(pending.kind).toBe(blocked ? 'blocked' : 'ok');
        transfers.push(pending);
      }
      const persisted = await journals();
      expect(Object.keys(persisted).length).toBeGreaterThan(0);
      expect(Object.values(persisted).join('\n')).toContain('Old writer retained notes.');
      await writeFile(join(root, 'transfer.json'), JSON.stringify({ transfers, journals: persisted }));
    } else {
      const transfer = JSON.parse(await readFile(join(root, 'transfer.json'), 'utf8')) as { transfers: (StepResponseOk | StepResponseBlocked)[]; journals: Record<string, string> };
      expect(transfer.transfers.map(item => item.kind)).toEqual(['ok', 'blocked']);
      for (const saved of transfer.transfers) {
        const resumed = unwrap(await engine.continueWorkflow(saved.stateToken, null));
        if (process.env.WORKRAIL_COMPAT_REQUIRE_BLOCKED === '1') expect(resumed.kind).toBe(saved.kind);
        expect(resumed.pending?.stepId).toBe('second');
        expect(resumed.pending?.prompt).toContain('Pinned second prompt.');
        expect(resumed.isComplete).toBe(false);
        const complete = unwrap(await engine.continueWorkflow(resumed.stateToken,
          resumed.kind === 'blocked' ? resumed.retryAckToken : resumed.ackToken,
          { notesMarkdown: 'New reader completed notes.', artifacts: [artifact] }));
        expect(complete.isComplete).toBe(true);
      }
      // Old journal bytes must remain intact even when the reader appends work.
      for (const [file, prefix] of Object.entries(transfer.journals)) expect((await readFile(join(root, file), 'utf8')).startsWith(prefix)).toBe(true);
      const persisted = Object.values(await journals()).join('\n');
      expect(persisted).toContain('Old writer retained notes.');
      expect(persisted).toContain('New reader completed notes.');
    }
  } finally { await engine.close(); }
}, 30000);
