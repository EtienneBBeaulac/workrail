import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createUnverifiedStudyFixture } from './study-manifest-file-fixture.js';
import type * as contract from './trial-executor-contract.js';
import type { ValidatedStudyManifest } from './study-manifest.mjs';

const target = resolve('experiments/answer-driven-execution/trial-executor.mts');
async function loadCandidate(): Promise<typeof contract.executeTrialPlan> {
  if (!existsSync(target)) throw new Error('CANDIDATE_UNAVAILABLE: trial executor absent');
  const mod = (await import(/* @vite-ignore */ target)) as { executeTrialPlan?: typeof contract.executeTrialPlan };
  if (typeof mod.executeTrialPlan !== 'function') throw new Error('CANDIDATE_UNAVAILABLE: trial executor export absent');
  return mod.executeTrialPlan;
}

async function withFixture(run: (c: { exec: typeof contract.executeTrialPlan; manifest: ValidatedStudyManifest; outDir: string }) => Promise<void>, stage: 'A' | 'B' = 'A') {
  const exec = await loadCandidate();
  const root = await mkdtemp(join(tmpdir(), 'trial-executor-'));
  try {
    const { manifest } = await createUnverifiedStudyFixture(root, stage);
    const outDir = join(root, 'output');
    await mkdir(outDir, { recursive: true });
    await run({ exec, manifest, outDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fake(mode: 'normal' | 'reuse' | 'net_err' | 'truncated' | 'fail_second', outDir: string, calls: contract.TrialRequest[]): contract.AgentTransport {
  return {
    async *startFresh(request) {
      calls.push(structuredClone(request));
      const raw = await readFile(join(outDir, 'attempts.ndjson'), 'utf8');
      const ledger = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as contract.LedgerRecord);
      expect(ledger.at(-1)).toEqual({ type: 'launch', request });
      if (calls.length > 1) {
        expect(ledger.at(-2)).toMatchObject({ type: 'outcome', runId: calls[calls.length - 2].runId });
      }

      const n = calls.length;
      const convId = mode === 'reuse' && n === 2 ? 'conversation-1' : `conversation-${n}`;
      const started: contract.AgentEvent = { type: 'started', conversationId: convId, observedEnvironment: { kind: 'unknown' } };
      yield started;
      expect((await readLedger(outDir)).at(-1)).toEqual({ type: 'event', runId: request.runId, event: started });

      if ((mode === 'net_err' || mode === 'truncated') && n === 2) {
        yield { type: 'trace', raw: `trace-${request.runId}` };
        expect((await readLedger(outDir)).at(-1)).toEqual({ type: 'event', runId: request.runId, event: { type: 'trace', raw: `trace-${request.runId}` } });
        if (mode === 'truncated') return;
        throw new Error('network lost');
      }
      yield { type: 'trace', raw: `trace-${request.runId}` };
      expect((await readLedger(outDir)).at(-1)).toEqual({ type: 'event', runId: request.runId, event: { type: 'trace', raw: `trace-${request.runId}` } });

      if (mode === 'fail_second' && n === 2) {
        yield { type: 'ended', outcome: 'failed', raw: 'failed' };
        return;
      }
      yield { type: 'ended', outcome: 'completed', raw: 'completed' };
    }
  };
}

async function readLedger(outDir: string): Promise<contract.LedgerRecord[]> {
  const text = await readFile(join(outDir, 'attempts.ndjson'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as contract.LedgerRecord);
}

function expectedLedger(calls: readonly contract.TrialRequest[], failSecond = false): contract.LedgerRecord[] {
  return calls.flatMap((request, i): contract.LedgerRecord[] => {
    const outcome = failSecond && i === 1 ? 'failed' : 'completed';
    return [
      { type: 'launch', request },
      { type: 'event', runId: request.runId, event: { type: 'started', conversationId: `conversation-${i + 1}`, observedEnvironment: { kind: 'unknown' } } },
      { type: 'event', runId: request.runId, event: { type: 'trace', raw: `trace-${request.runId}` } },
      { type: 'event', runId: request.runId, event: { type: 'ended', outcome, raw: outcome } },
      { type: 'outcome', runId: request.runId, outcome },
    ];
  });
}

describe.each([{ stage: 'A', count: 40 }, { stage: 'B', count: 20 }] as const)('Stage $stage trial executor contract probe', ({ stage, count }) => {
  it('runs all planned slots in order and retains full trace', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const calls: contract.TrialRequest[] = [];
      const res = await exec(manifest, outDir, fake('normal', outDir, calls), new AbortController().signal);
      expect(res).toEqual({ scope: 'orchestration_only', trialAuthorization: false, attempted: count, status: 'finished' });
      expect(calls).toHaveLength(count);

      let i = 0;
      for (const pair of manifest.pairs) {
        for (const arm of pair.armOrder) {
          const c = calls[i++];
          expect(c).toMatchObject({
            arm, scenario: pair.scenario, fixture: pair.fixture,
            expectedObservations: pair.expectedObservations,
            requestedEnvironment: manifest.environment[arm], budgets: manifest.budgets
          });
          expect(c.runId).toBe(pair[arm].runId);
          expect(c.workspacePath).toBe(pair[arm].workspacePath);
          expect(c.repetition).toBe(pair.repetition);
        }
      }

      const records = await readLedger(outDir);
      expect(records.filter(r => r.type === 'launch')).toHaveLength(count);
      const outcomes = records.filter(r => r.type === 'outcome');
      expect(outcomes).toHaveLength(count);
      expect(outcomes.every(o => o.outcome === 'completed')).toBe(true);
      const ids = records.flatMap(r => r.type === 'event' && r.event.type === 'started' ? [r.event.conversationId] : []);
      expect(new Set(ids).size).toBe(count);
      expect(records).toEqual(expectedLedger(calls));
    }, stage);
  });

  it('halts with conversation_reused without discarding second started record', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const calls: contract.TrialRequest[] = [];
      const res = await exec(manifest, outDir, fake('reuse', outDir, calls), new AbortController().signal);
      expect(res).toEqual({ scope: 'orchestration_only', trialAuthorization: false, attempted: 2, status: 'halted', reason: 'conversation_reused' });
      expect(calls).toHaveLength(2);
      const records = await readLedger(outDir);
      const outcomes = records.filter(r => r.type === 'outcome');
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0].outcome).toBe('completed');
      expect(outcomes[1].outcome).toBe('conversation_reused');
      expect(outcomes[1].runId).toBe(calls[1].runId);
      expect(records.slice(0, 5)).toEqual(expectedLedger([calls[0]]));
      expect(records).toContainEqual({ type: 'event', runId: calls[1].runId, event: { type: 'started', conversationId: 'conversation-1', observedEnvironment: { kind: 'unknown' } } });
      expect(records.filter(r => r.type === 'event' && r.event.type === 'started')).toHaveLength(2);
      expect(records.some(r => r.type === 'event' && r.event.type === 'trace' && r.event.raw === `trace-${calls[0].runId}`)).toBe(true);
    }, stage);
  });

  it.each(['net_err', 'truncated'] as const)('halts with unknown_remote for %s preserving partial trace', async (mode) => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const calls: contract.TrialRequest[] = [];
      const res = await exec(manifest, outDir, fake(mode, outDir, calls), new AbortController().signal);
      expect(res).toEqual({ scope: 'orchestration_only', trialAuthorization: false, attempted: 2, status: 'halted', reason: 'unknown_remote' });
      expect(calls).toHaveLength(2);
      const records = await readLedger(outDir);
      const outcomes = records.filter(r => r.type === 'outcome');
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0].outcome).toBe('completed');
      expect(outcomes[1].outcome).toBe('unknown_remote');
      expect(outcomes[1].runId).toBe(calls[1].runId);
      expect(records.slice(0, 5)).toEqual(expectedLedger([calls[0]]));
      expect(records.some(r => r.type === 'event' && r.event.type === 'trace' && r.event.raw === `trace-${calls[1].runId}`)).toBe(true);
    }, stage);
  });

  it('continues to subsequent slots when an attempt ends with failed outcome', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const calls: contract.TrialRequest[] = [];
      const res = await exec(manifest, outDir, fake('fail_second', outDir, calls), new AbortController().signal);
      expect(res).toEqual({ scope: 'orchestration_only', trialAuthorization: false, attempted: count, status: 'finished' });
      expect(calls).toHaveLength(count);
      const outcomes = (await readLedger(outDir)).filter(r => r.type === 'outcome');
      expect(outcomes).toHaveLength(count);
      expect(outcomes[0].outcome).toBe('completed');
      expect(outcomes[1].outcome).toBe('failed');
      expect(outcomes[2].outcome).toBe('completed');
      expect(calls.map(c => c.runId)).toEqual(manifest.pairs.flatMap(p => p.armOrder.map(a => p[a].runId)));
      expect(await readLedger(outDir)).toEqual(expectedLedger(calls, true));
    }, stage);
  });
  it('refuses a nonempty output journal before dispatch without changing it', async () => {
    await withFixture(async ({ exec, manifest, outDir }) => {
      const path = join(outDir, 'attempts.ndjson');
      const sentinel = 'existing evidence must survive\n';
      await writeFile(path, sentinel);
      const calls: contract.TrialRequest[] = [];
      const result = await exec(manifest, outDir, fake('normal', outDir, calls), new AbortController().signal);
      expect(result).toEqual({ scope: 'orchestration_only', trialAuthorization: false, attempted: 0, status: 'halted', reason: 'storage_failed' });
      expect(calls).toHaveLength(0);
      expect(await readFile(path, 'utf8')).toBe(sentinel);
    }, stage);
  });

});

it('completes all 20 stage B slots when conversation_restarted IDs are unique', async () => {
  await withFixture(async ({ exec, manifest, outDir }) => {
    const calls: contract.TrialRequest[] = [];
    const transport: contract.AgentTransport = {
      async *startFresh(request) {
        calls.push(structuredClone(request));
        yield { type: 'started', conversationId: `before-${request.runId}`, observedEnvironment: { kind: 'unknown' } };
        yield {
          type: 'conversation_restarted',
          priorConversationId: `before-${request.runId}`,
          conversationId: `after-${request.runId}`,
          observedEnvironment: { kind: 'unknown' },
        };
        yield { type: 'ended', outcome: 'completed', raw: 'completed' };
      },
    };

    const res = await exec(manifest, outDir, transport, new AbortController().signal);
    expect(res).toMatchObject({ status: 'finished', attempted: 20 });
    expect(calls).toHaveLength(20);

    const ledger = await readLedger(outDir);
    const restarts = ledger.filter(
      (r): r is contract.LedgerRecord & { type: 'event'; event: { type: 'conversation_restarted' } } =>
        r.type === 'event' && r.event.type === 'conversation_restarted',
    );
    expect(restarts).toHaveLength(20);
    restarts.forEach((record, i) => {
      expect(record.runId).toBe(calls[i].runId);
      expect(record.event).toMatchObject({
        type: 'conversation_restarted',
        priorConversationId: `before-${calls[i].runId}`,
        conversationId: `after-${calls[i].runId}`,
      });
    });
  }, 'B');
});

it('halts on second slot when conversation_restarted reuses first slot after ID', async () => {
  await withFixture(async ({ exec, manifest, outDir }) => {
    const calls: contract.TrialRequest[] = [];
    const transport: contract.AgentTransport = {
      async *startFresh(request) {
        calls.push(structuredClone(request));
        const n = calls.length;
        yield { type: 'started', conversationId: `before-${request.runId}`, observedEnvironment: { kind: 'unknown' } };
        yield {
          type: 'conversation_restarted',
          priorConversationId: `before-${request.runId}`,
          conversationId: n === 2 ? `after-${calls[0].runId}` : `after-${request.runId}`,
          observedEnvironment: { kind: 'unknown' },
        };
        yield { type: 'ended', outcome: 'completed', raw: 'completed' };
      },
    };

    const res = await exec(manifest, outDir, transport, new AbortController().signal);
    expect(res).toMatchObject({ status: 'halted', reason: 'conversation_reused', attempted: 2 });
    expect(calls).toHaveLength(2);

    const ledger = await readLedger(outDir);
    const secondRunId = calls[1].runId;
    const reusedEvent = ledger.find(
      r => r.type === 'event' && r.runId === secondRunId && r.event.type === 'conversation_restarted',
    );
    expect(reusedEvent).toMatchObject({
      type: 'event',
      runId: secondRunId,
      event: { type: 'conversation_restarted', conversationId: `after-${calls[0].runId}` },
    });

    const outcomeRecord = ledger.find(r => r.type === 'outcome' && r.runId === secondRunId);
    expect(outcomeRecord).toMatchObject({
      type: 'outcome',
      runId: secondRunId,
      outcome: 'conversation_reused',
    });
  }, 'B');
});
