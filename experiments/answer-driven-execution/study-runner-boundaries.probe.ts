import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStageBFixture, makeEffects, sampleReview } from './study-runner-fixture.js';
import { makePositiveStream } from './study-runner-stream-fixture.js';
import { computeSha256 } from './study-manifest.mjs';
import type { ExtendedAgentTransport, RunStudyOptions, StudyReport } from './study-runner-contract.js';

async function fixture(test: (options: RunStudyOptions, calls: string[], run: (options: RunStudyOptions) => Promise<StudyReport>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'study-boundaries-'));
  try {
    const {manifest, manifestPath} = await createStageBFixture(root);
    const calls: string[] = [];
    const transport: ExtendedAgentTransport = {startFresh(req) { calls.push(req.runId); return makePositiveStream(req); }};
    const {runStudy} = await import(/* @vite-ignore */ resolve('experiments/answer-driven-execution/study-runner.mts'));
    await test({manifestPath, expectedManifestSha256: computeSha256(await readFile(manifestPath)), outputDir: join(root, 'out'), transport, effects: makeEffects(manifest), signal: new AbortController().signal}, calls, runStudy);
  } finally { await rm(root, {recursive:true, force:true}); }
}

it('boundary control completes the frozen B20 study', async () => {
  await fixture(async (options, calls, run) => { const result = await run(options); expect(result.status).toBe('complete_measurement'); expect(calls).toHaveLength(20); });
});

it.each(['host-observations.ndjson', 'study-report.json', 'attempts.ndjson'])('preserves occupied evidence file %s without launching trials', async filename => {
  await fixture(async (options, calls, run) => {
    await mkdir(options.outputDir, {recursive:true});
    const path = join(options.outputDir, filename); const original = 'existing evidence owned by another run\n';
    await writeFile(path, original);
    const result = await run(options);
    expect((await readFile(path, 'utf8')) === original, 'existing evidence must remain byte-identical').toBe(true);
    expect(result.status).toBe('failed'); expect(calls).toHaveLength(0);
  });
});

it('does not report complete measurement when its report cannot be persisted', async () => {
  await fixture(async (options, _calls, run) => {
    await mkdir(join(options.outputDir, 'study-report.json'), {recursive:true});
    const result = await run(options); expect(result.status).toBe('failed');
  });
});

it('refuses host observations naming a foreign run', async () => {
  await fixture(async (options, _calls, run) => {
    const transport: ExtendedAgentTransport = {async *startFresh(req) {
      for await (const item of makePositiveStream(req)) yield item.type === 'host' ? {...item, record:{...item.record, runId:'foreign-run'}} : item;
    }};
    const result = await run({...options, transport});
    expect(['incomplete_evidence', 'rejected_safety']).toContain(result.status);
    expect(result.trials).toHaveLength(0);
  });
});

it.each(['late_engine', 'duplicate_engine', 'foreign_review_conversation'] as const)('does not normalize invalid conversation/recovery evidence: %s', async variation => {
  await fixture(async (options, _calls, run) => {
    const transport: ExtendedAgentTransport = {async *startFresh(req) {
      const events = [];
      for await (const item of makePositiveStream(req)) events.push(item);
      const engine = events.find(item => item.type === 'host' && item.record.kind === 'engine_recreated');
      for (const item of events) {
        if (variation === 'late_engine' && item === engine) continue;
        if (variation === 'foreign_review_conversation' && req.scenario === 'missing_summary' && item.type === 'host' && (item.record.kind === 'submitted_review' || item.record.kind === 'accepted_review')) {
          yield {...item, record: {...item.record, conversationId:'foreign-conversation'}};
        } else { yield item; }
        if (variation === 'late_engine' && item.type === 'host' && item.record.kind === 'read' && engine) yield engine;
        if (variation === 'duplicate_engine' && item === engine && item.type === 'host') yield {...item, record:{...item.record, recordId:item.record.recordId+'-duplicate'}};
      }
    }};
    const result = await run({...options, transport});
    expect(result.status).toBe('incomplete_evidence');
    const invalidScenario = variation === 'foreign_review_conversation' ? 'missing_summary' : 'recovery_after_partial_work';
    expect(result.trials.filter(trial => trial.scenario === invalidScenario)).toHaveLength(0);
  });
});

it('allows at most one concurrent owner of the output evidence', async () => {
  await fixture(async (options, calls, run) => {
    const results = await Promise.all([run(options), run(options)]);
    const completed = results.filter(result => result.status === 'complete_measurement');
    expect(completed).toHaveLength(1);
    expect(results.filter(result => result.status === 'failed')).toHaveLength(1);
    expect(calls).toHaveLength(20);
    const persisted = JSON.parse(await readFile(join(options.outputDir, 'study-report.json'), 'utf8'));
    expect(persisted).toEqual(completed[0]);
  });
});


it('never substitutes fixture bytes changed after verification into expected reviews', async () => {
  await fixture(async (options, _calls, run) => {
    const transport: ExtendedAgentTransport = {async *startFresh(req) {
      await writeFile(req.fixture.path, JSON.stringify({expectedReview:{...sampleReview, summary:'substituted after verification'}}));
      yield* makePositiveStream(req);
    }};
    const result = await run({...options, transport});
    if (result.stage !== 'B') throw new Error('wrong stage');
    for (const trial of result.trials) expect(trial.expectedReview).toEqual(sampleReview);
  });
});

it('does not persist a host event returned by a pull that synchronously cancels', async () => {
  await fixture(async (options, _calls, run) => {
    const controller = new AbortController();
    let pulls = 0;
    const transport: ExtendedAgentTransport = {startFresh(req) {
      return {[Symbol.asyncIterator]() {return {
        async next() {
          pulls++;
          if (pulls === 1) return {done:false as const, value:{type:'agent' as const, event:{type:'started' as const, conversationId:'cancelled-conversation', observedEnvironment:{kind:'reported' as const, ...req.requestedEnvironment}}}};
          controller.abort();
          return {done:false as const, value:{type:'host' as const, record:{recordId:'after-cancel', runId:req.runId, atMs:1, source:'host', rawProvenance:'cancelled pull', kind:'unauthorized_effect' as const, effect:'must not be persisted'}}};
        },
        async return() { return {done:true as const, value:undefined}; }
      };}};
    }};
    const result = await run({...options, transport, signal:controller.signal});
    expect(result.hostLedger.some(record => record.recordId === 'after-cancel')).toBe(false);
    expect(result.status).not.toBe('complete_measurement');
    expect(pulls).toBe(2);
  });
});


it.each(['attempts.ndjson', 'host-observations.ndjson', 'stream-order.ndjson'])('refuses to score a corrupted persisted journal: %s', async filename => {
  await fixture(async (options, _calls, run) => {
    let corrupted = false;
    const transport: ExtendedAgentTransport = {async *startFresh(req) {
      for await (const item of makePositiveStream(req)) {
        if (!corrupted && item.type === 'agent' && item.event.type === 'ended') {
          await appendFile(join(options.outputDir, filename), '{invalid journal record}\n');
          corrupted = true;
        }
        yield item;
      }
    }};
    const result = await run({...options, transport});
    expect(['failed', 'incomplete_evidence']).toContain(result.status);
    expect(result.trials).toHaveLength(0);
    expect(result.slots).toHaveLength(20);
    expect(result.slots.every(slot => slot.status === 'unscorable')).toBe(true);
  });
});

it.each([
  ['isHostRecord', {recordId:'x',runId:'r',atMs:1,source:'host',rawProvenance:'raw',kind:'tool_call'}],
  ['isLedgerRecord', {type:'event',runId:'r',event:{type:'started'}}],
  ['isStreamOrderEntry', {seq:1,runId:'r',arm:'candidate',type:'host'}],
] as const)('rejects incomplete discriminated payloads at the %s boundary', async (guard, record) => {
  const module = await import(/* @vite-ignore */ resolve('experiments/answer-driven-execution/study-runner-normalization.mts'));
  expect(module[guard](record)).toBe(false);
});


it('rejects repeated fault boundaries during recovery', async () => {
  await fixture(async (options, _calls, run) => {
    const transport: ExtendedAgentTransport = {async *startFresh(req) {
      for await (const item of makePositiveStream(req)) {
        yield item;
        if (req.scenario === 'recovery_after_partial_work' && item.type === 'host' && item.record.kind === 'fault') {
          yield {...item, record:{...item.record, recordId:item.record.recordId+'-duplicate'}};
        }
      }
    }};
    const result = await run({...options, transport});
    expect(result.status).toBe('incomplete_evidence');
    expect(result.trials.filter(trial => trial.scenario === 'recovery_after_partial_work')).toHaveLength(0);
  });
});

it('manifest rejection does not add a report to another run evidence directory', async () => {
  await fixture(async (options, calls, run) => {
    await mkdir(options.outputDir, {recursive:true});
    await writeFile(join(options.outputDir, 'host-observations.ndjson'), 'foreign evidence');
    const result = await run({...options, expectedManifestSha256:'0'.repeat(64)});
    expect(result.status).toBe('failed'); expect(calls).toHaveLength(0);
    expect(await readdir(options.outputDir)).toEqual(['host-observations.ndjson']);
  });
});


it('does not normalize a Stage A fault as Stage B evidence', async () => {
  await fixture(async (options, _calls, run) => {
    const transport: ExtendedAgentTransport = {async *startFresh(req) {
      for await (const item of makePositiveStream(req)) {
        if (item.type === 'host' && item.record.kind === 'fault') {
          yield {...item, record:{...item.record, fault:{kind:'malformed' as const, callId:'foreign-stage-fault', noticeAtMs:50}}};
        } else yield item;
      }
    }};
    const result = await run({...options, transport});
    expect(['incomplete_evidence', 'failed']).toContain(result.status);
    expect(result.trials).toHaveLength(0);
  });
});
