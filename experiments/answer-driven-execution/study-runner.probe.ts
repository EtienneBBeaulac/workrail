import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  computeSha256,
  validateStudyManifest,
  type ValidatedStudyManifest,
} from './study-manifest.mjs';
import { createUnverifiedStudyFixture } from './study-manifest-file-fixture.js';
import {
  scoreInput as scoreStageAInput,
  type Trial as StageATrial,
} from './usability-scorer.mjs';
import type { ReviewVerdictArtifactV1 } from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';
import type { PreflightHostEffects } from './trial-preflight-contract.js';
import type { TrialRequest } from './trial-executor-contract.js';
import type {
  ExtendedAgentTransport,
  ExtendedTransportEvent,
  RunStudyOptions,
  StudyReport,
  HostRecord,
} from './study-runner-contract.js';

import { sampleReview, createStageBFixture, makeEffects } from './study-runner-fixture.js';
import { makePositiveStream, buildExpectedStageATrials } from './study-runner-stream-fixture.js';
async function loadRunner(): Promise<(opts: RunStudyOptions) => Promise<StudyReport>> {
  const file = resolve(process.cwd(), 'experiments/answer-driven-execution/study-runner.mts');
  if (!existsSync(file)) throw new Error(`CANDIDATE_UNAVAILABLE: ${file}`);
  const mod = await import(/* @vite-ignore */ file) as {runStudy?: (opts: RunStudyOptions) => Promise<StudyReport>};
  if (typeof mod.runStudy !== 'function') throw new Error('CANDIDATE_UNAVAILABLE: export absent');
  return mod.runStudy;
}

describe('study-runner composition probe', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'study-runner-'));
  });
  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('positive A40 study executes, matches real scoreInput oracle, and persists report', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const outputDir = join(tempDir, 'out-a');
    const transport: ExtendedAgentTransport = {
      startFresh: (req) => makePositiveStream(req),
    };
    const report = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir,
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(report.scope).toBe('orchestration_only');
    expect(report.trialAuthorization).toBe(false);
    expect(report.stage).toBe('A');
    expect(report.trials).toHaveLength(40);

    if (manifest.stage !== 'A') throw new Error('wrong fixture stage');
    const expectedTrials = buildExpectedStageATrials(manifest);
    expect(report.trials).toEqual(expectedTrials);

    const oracle = scoreStageAInput({ version: 1, stage: 'A', trials: expectedTrials });
    expect(oracle.kind).toBe('scored');
    if (oracle.kind === 'scored') {
      expect(report.status).toBe(oracle.report.status);
      expect(report.scoreReport).toEqual(oracle.report);
    }

    const persisted = JSON.parse(await readFile(join(outputDir, 'study-report.json'), 'utf8'));
    expect(persisted).toEqual(report);
  });

  it('positive B20 study executes exact count, complete_measurement, and review obligations', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createStageBFixture(tempDir);
    const hash = computeSha256(await readFile(manifestPath));
    const outputDir = join(tempDir, 'out-b');
    const transport: ExtendedAgentTransport = {
      startFresh: (req) => makePositiveStream(req),
    };
    const report = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir,
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(report.scope).toBe('orchestration_only');
    expect(report.trialAuthorization).toBe(false);
    expect(report.stage).toBe('B');
    if (report.stage !== 'B') throw new Error('wrong report stage');
    expect(report.trials).toHaveLength(20);
    expect(report.status).toBe('complete_measurement');
    expect(report.scoreReport).not.toBeNull();
    if (report.scoreReport) {
      expect(report.scoreReport.status).toBe('complete_measurement');
      expect(report.scoreReport.measurements.filter((m) => m.success)).toHaveLength(20);
    }
    for (const trial of report.trials) {
      expect(trial.expectedReview).toEqual(sampleReview);
      expect(trial.submittedArtifact).toEqual(sampleReview);
      expect(trial.acceptedArtifact).toEqual(sampleReview);
      expect(trial.unauthorizedEffects).toEqual([]);
    }
    const persisted = JSON.parse(await readFile(join(outputDir, 'study-report.json'), 'utf8'));
    expect(persisted).toEqual(report);
  });

  it('persists every host event before next pull during execution', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const outputDir = join(tempDir, 'out-persisted');
    const transport: ExtendedAgentTransport = {
      startFresh: (req) => makePositiveStream(req, { assertPersistedDir: outputDir }),
    };
    const report = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir,
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(report.status).toBe('inconclusive');
    expect(existsSync(join(outputDir, 'host-observations.ndjson'))).toBe(true);
  });

  it('bad manifest hash rejects with zero trial calls', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    let calls = 0;
    const transport: ExtendedAgentTransport = {
      startFresh: async function* () {
        calls++;
      },
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      outputDir: join(tempDir, 'out-bad-hash'),
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(res.trialAuthorization).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.preflight).toBeNull();
    expect(res.trials).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it('preflight denial makes zero trial calls', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    let calls = 0;
    const transport: ExtendedAgentTransport = {
      startFresh: async function* () {
        calls++;
      },
    };
    const deniedEffects: PreflightHostEffects = {
      ...makeEffects(manifest),
      observeLoadedBuild: async (req) => ({
        kind: 'unknown',
        requestId: req.requestId,
        arm: req.arm,
        reason: 'denied by host observation policy',
        rawTrace: 'bad',
      }),
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-denial'),
      transport,
      effects: deniedEffects,
      signal: new AbortController().signal,
    });
    expect(calls).toBe(0);
    expect(res.trialAuthorization).toBe(false);
    expect(res.preflight).toBeNull();
    expect(res.status).toBe('failed');
    expect(res.trials).toHaveLength(0);
  });

  it('host missing with agent trace claiming completion yields incomplete', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const transport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        yield {
          type: 'agent',
          event: {
            type: 'started',
            conversationId: `c-${req.runId}`,
            observedEnvironment: {
              kind: 'reported',
              model: req.requestedEnvironment.model,
              effort: req.requestedEnvironment.effort,
            },
          },
        };
        yield {
          type: 'agent',
          event: {
            type: 'ended',
            outcome: 'completed',
            raw: 'claimed completion without host facts',
          },
        };
      },
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-host-missing'),
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(res.status).toBe('incomplete_evidence');
    expect(res.trialAuthorization).toBe(false);
  });

  it('candidate safety violation triggers rejected_safety with zero fabricated clean', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const transport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        for await (const ev of makePositiveStream(req)) {
          if (req.arm === 'candidate' && ev.type === 'host' && ev.record.kind === 'commit') {
            yield {
              type: 'host',
              record: { ...ev.record, runId: 'foreign-run-id' },
            };
          } else {
            yield ev;
          }
        }
      },
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-foreign-run'),
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(res.status).toBe('rejected_safety');
    expect(res.trialAuthorization).toBe(false);
  });

  it('preserves failed attempt distinct from unknown remote halt', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));

    const failedTransport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        yield {
          type: 'agent',
          event: {
            type: 'started',
            conversationId: `c-${req.runId}`,
            observedEnvironment: {
              kind: 'reported',
              model: req.requestedEnvironment.model,
              effort: req.requestedEnvironment.effort,
            },
          },
        };
        yield {
          type: 'agent',
          event: { type: 'ended', outcome: 'failed', raw: 'agent crash' },
        };
      },
    };
    const failedReport = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-failed'),
      transport: failedTransport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(failedReport.status).toBe('incomplete_evidence');
    expect(failedReport.agentLedger.filter(l => l.type === 'launch')).toHaveLength(40);
    expect(failedReport.slots).toHaveLength(40);
    expect(failedReport.slots.every(s => s.status === 'unscorable')).toBe(true);
    expect(
      failedReport.agentLedger.some(
        (l) => l.type === 'event' && l.event.type === 'ended' && l.event.outcome === 'failed'
      )
    ).toBe(true);

    const haltTransport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        yield {
          type: 'agent',
          event: {
            type: 'started',
            conversationId: `c-${req.runId}`,
            observedEnvironment: {
              kind: 'reported',
              model: req.requestedEnvironment.model,
              effort: req.requestedEnvironment.effort,
            },
          },
        };
      },
    };
    const haltReport = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-halt'),
      transport: haltTransport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(haltReport.status).toBe('incomplete_evidence');
    expect(haltReport.agentLedger.filter(l => l.type === 'launch')).toHaveLength(1);
    expect(haltReport.slots).toHaveLength(40);
    expect(haltReport.slots.filter(s => s.status === 'not_attempted')).toHaveLength(39);
    expect(haltReport.agentLedger.filter(l => l.type === 'outcome')).toEqual([{type:'outcome',runId:manifest.pairs[0]![manifest.pairs[0]!.armOrder[0]!].runId,outcome:'unknown_remote'}]);
    expect(
      haltReport.agentLedger.some((l) => l.type === 'event' && l.event.type === 'ended')
    ).toBe(false);
  });

  it('missing expected observation leaves evidence incomplete', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const transport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        for await (const ev of makePositiveStream(req)) {
          if (
            ev.type === 'host' &&
            (ev.record.recordId.includes('m2') ||
              ev.record.recordId.includes('ret2') ||
              ev.record.recordId.includes('r2'))
          ) {
            continue;
          }
          yield ev;
        }
      },
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-missing-obs'),
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(res.status).toBe('incomplete_evidence');
    expect(res.trialAuthorization).toBe(false);
  });

  it('preserves null token usage without fabricating zero', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const transport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        for await (const ev of makePositiveStream(req)) {
          if (ev.type === 'host' && ev.record.kind === 'token_usage') {
            yield {
              type: 'host',
              record: { ...ev.record, tokensUsed: null },
            };
          } else {
            yield ev;
          }
        }
      },
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-tokens'),
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(res.hostLedger.length).toBeGreaterThan(0);
    const tokenRecords = res.hostLedger.filter((h) => h.kind === 'token_usage');
    expect(tokenRecords.length).toBeGreaterThan(0);
    for (const tok of tokenRecords) {
      expect(tok.tokensUsed).toBeNull();
      expect(tok.tokensUsed).not.toBe(0);
    }
  });

  it('rejects or marks incomplete when host emits duplicate recordId', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const transport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        for await (const ev of makePositiveStream(req)) {
          yield ev;
          if (ev.type === 'host' && ev.record.kind === 'tool_call') {
            yield ev;
          }
        }
      },
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-dup'),
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(res.status).toBe('incomplete_evidence');
  });

  it('marks incomplete when coverage is missing', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const transport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        for await (const ev of makePositiveStream(req)) {
          if (ev.type === 'host' && ev.record.kind === 'coverage') {
            continue;
          }
          yield ev;
        }
      },
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-cov'),
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(res.status).toBe('incomplete_evidence');
  });

  it('marks incomplete when agent reports unknown model', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const transport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        for await (const ev of makePositiveStream(req)) {
          if (ev.type === 'agent' && ev.event.type === 'started') {
            yield {
              type: 'agent',
              event: {
                ...ev.event,
                observedEnvironment: {
                  kind: 'reported',
                  model: 'unauthorized-model-id',
                  effort: req.requestedEnvironment.effort,
                },
              },
            };
          } else {
            yield ev;
          }
        }
      },
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-model'),
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(res.status).toBe('incomplete_evidence');
  });

  it('rejects safety when committed work is lost from retained snapshots', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const transport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        for await (const ev of makePositiveStream(req)) {
          if (ev.type === 'host' && ev.record.kind === 'retained_snapshot') {
            continue;
          }
          yield ev;
        }
      },
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-lost-ret'),
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(res.status).toBe('rejected_safety');
  });

  it('rejects safety when host emits unauthorized effect', async () => {
    const runStudy = await loadRunner();
    const { manifest, manifestPath } = await createUnverifiedStudyFixture(tempDir, 'A');
    const hash = computeSha256(await readFile(manifestPath));
    const transport: ExtendedAgentTransport = {
      startFresh: async function* (req) {
        for await (const ev of makePositiveStream(req)) {
          if (req.arm === 'candidate' && ev.type === 'host' && ev.record.kind === 'tool_call') {
            yield ev;
            yield {
              type: 'host',
              record: {
                recordId: `rec-${req.runId}-unauth`,
                runId: req.runId,
                atMs: ev.record.atMs + 1,
                source: 'host',
                rawProvenance: 'simulated-host',
                kind: 'unauthorized_effect',
                effect: 'unexpected write to host filesystem',
              },
            };
          } else {
            yield ev;
          }
        }
      },
    };
    const res = await runStudy({
      manifestPath,
      expectedManifestSha256: hash,
      outputDir: join(tempDir, 'out-unauth'),
      transport,
      effects: makeEffects(manifest),
      signal: new AbortController().signal,
    });
    expect(res.status).toBe('rejected_safety');
    expect(res.trialAuthorization).toBe(false);
  });
  it.each(['missing_restart','wrong_prior','unknown_restart_model','missing_recreation','same_engine','wrong_effect_conversation','wrong_fault_conversation'] as const)('refuses incomplete recovery evidence: %s', async mutation => {
    const runStudy = await loadRunner();
    const {manifest,manifestPath} = await createStageBFixture(tempDir);
    let mutated = 0;
    const transport: ExtendedAgentTransport = {async *startFresh(req) {
      for await (const event of makePositiveStream(req)) {
        if (req.arm !== 'candidate' || req.scenario !== 'recovery_after_partial_work') {yield event;continue;}
        if (event.type === 'agent' && event.event.type === 'conversation_restarted') {
          if (mutation === 'missing_restart') {mutated++;continue;}
          if (mutation === 'wrong_prior') {mutated++;yield {...event,event:{...event.event,priorConversationId:'wrong'}};continue;}
          if (mutation === 'unknown_restart_model') {mutated++;yield {...event,event:{...event.event,observedEnvironment:{kind:'unknown'}}};continue;}
        }
        if (event.type === 'host' && event.record.kind === 'engine_recreated') {
          if (mutation === 'missing_recreation') {mutated++;continue;}
          if (mutation === 'same_engine') {mutated++;yield {...event,record:{...event.record,instanceId:event.record.priorInstanceId}};continue;}
        }
        if (event.type === 'host' && event.record.kind === 'read' && mutation === 'wrong_effect_conversation') {mutated++;yield {...event,record:{...event.record,conversationId:'wrong'}};continue;}
        if (event.type === 'host' && event.record.kind === 'fault' && event.record.fault.kind === 'recovery_after_partial_work' && mutation === 'wrong_fault_conversation') {mutated++;yield {...event,record:{...event.record,fault:{...event.record.fault,recoveryConversationId:'wrong'}}};continue;}
        yield event;
      }
    }};
    const report = await runStudy({manifestPath,expectedManifestSha256:computeSha256(await readFile(manifestPath)),outputDir:join(tempDir,'bad-recovery'),transport,effects:makeEffects(manifest),signal:new AbortController().signal});
    expect(mutated).toBeGreaterThan(0);
    expect(report.status).toBe('incomplete_evidence');
    expect(report.slots.some(s => s.status === 'unscorable')).toBe(true);
  });

  it('rejects changed referenced fixture bytes before any preflight or trial effect', async () => {
    const runStudy = await loadRunner();
    const {manifest,manifestPath} = await createStageBFixture(tempDir);
    const frozenHash = computeSha256(await readFile(manifestPath));
    await writeFile(manifest.pairs[0]!.fixture.path, '{"expectedReview":"tampered"}');
    let calls = 0; let preflights = 0;
    const base = makeEffects(manifest);
    const effects: PreflightHostEffects = {...base,async executePreflight(req,signal) {preflights++;return base.executePreflight(req,signal);}};
    const transport: ExtendedAgentTransport = {async *startFresh(req) {calls++;yield* makePositiveStream(req);}};
    const report = await runStudy({manifestPath,expectedManifestSha256:frozenHash,outputDir:join(tempDir,'tampered'),transport,effects,signal:new AbortController().signal});
    expect(report.status).toBe('failed'); expect(report.preflight).toBeNull();
    expect(calls).toBe(0); expect(preflights).toBe(0);
  });

});
