import { describe, it, expect } from 'vitest';
import type { ReviewVerdictArtifactV1 } from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';
import type {
  StageBStudy,
  StageBTrial,
  StageBScorerReport,
  StageBScoreInputResult,
} from './stage-b-scorer-contract.js';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { STAGE_B_SCENARIOS } from './study-manifest.mjs';

async function loadScorer(): Promise<{
  score: (study: StageBStudy) => StageBScorerReport;
  scoreInput: (input: unknown) => StageBScoreInputResult;
}> {
  const p = resolve(process.cwd(), 'experiments/answer-driven-execution/stage-b-scorer.mts');
  if (!existsSync(p)) throw new Error('CANDIDATE_UNAVAILABLE: Stage B scorer absent');
  const mod = await import(/* @vite-ignore */ p);
  if (typeof mod.score !== 'function' || typeof mod.scoreInput !== 'function') {
    throw new Error('CANDIDATE_UNAVAILABLE: exports absent');
  }
  return mod;
}

const sampleReview: ReviewVerdictArtifactV1 = {
  kind: 'wr.review_verdict',
  verdict: 'minor',
  confidence: 'high',
  summary: 'Deterministic review verdict',
  findings: [
    { severity: 'minor', summary: 'Missing category finding' },
    {
      severity: 'major',
      summary: 'Enriched second finding',
      findingCategory: 'correctness',
      file: 'src/engine.ts',
      startLine: 100,
      remediation: 'Add boundary check',
    },
  ],
};

function makePositive20Study(): StageBStudy {
  const trials: StageBTrial[] = [];
  for (const scenario of STAGE_B_SCENARIOS) {
    for (const rep of [1, 2, 3, 4, 5] as const) {
      for (const arm of ['baseline', 'candidate'] as const) {
        const runId = `run-${scenario}-${rep}-${arm}`;
        const callId1 = `c1-${runId}`;
        const callId2 = `c2-${runId}`;
        const obs1 = { id: `obs1-${scenario}-${rep}`, value: 'val1' };
        const obs2 = { id: `obs2-${scenario}-${rep}`, value: 'val2' };
        const fault =
          scenario === 'missing_summary'
            ? { kind: 'missing_summary' as const, callId: callId1, noticeAtMs: 1500 }
            : {
                kind: 'recovery_after_partial_work' as const,
                callId: callId1,
                noticeAtMs: 1500,
                committedEventId: `ev1-${runId}`,
                priorConversationId: `before-${runId}`,
                recoveryConversationId: `after-${runId}`,
              };
        trials.push({
          scenario,
          repetition: rep,
          arm,
          runId,
          model: 'gemini-3.8-flash-high',
          effort: 'high',
          fixture: `review-fix-${scenario}`,
          effectCoverage: 'known',
          expectedReview: sampleReview,
          expectedObservations: [obs1, obs2],
          calls: [
            {
              id: callId1,
              atMs: 1000,
              operation: 'write',
              outcome: scenario === 'recovery_after_partial_work' ? 'success' : 'injected_fault',
            },
            ...(scenario === 'recovery_after_partial_work'
              ? [{ id: `read-${runId}`, atMs: 1750, operation: 'read' as const, outcome: 'success' as const }]
              : []),
            { id: callId2, atMs: 2000, operation: 'write', outcome: 'success' },
          ],
          fault,
          commits: [
            {
              eventId: `ev1-${runId}`,
              callId: scenario === 'recovery_after_partial_work' ? callId1 : callId2,
              runId,
              observation: obs1,
            },
            { eventId: `ev2-${runId}`, callId: callId2, runId, observation: obs2 },
          ],
          retained: [obs1, obs2],
          reads: scenario === 'recovery_after_partial_work' ? [{ callId: `read-${runId}`, runId, observation: obs1 }] : [],
          submittedArtifact: sampleReview,
          acceptedArtifact: sampleReview,
          completed: true,
          unauthorizedEffects: [],
          termination: 'finished',
          elapsedMs: 2500,
          tokensUsed: 450,
        });
      }
    }
  }
  return { version: 1, stage: 'B', trials };
}

describe('Stage B Scorer Timing & Extraneous Fault Regression Probes', () => {
  it('rejects pre-notice read as recovery evidence (pre-notice control)', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const idx = study.trials.findIndex(
      t => t.scenario === 'recovery_after_partial_work' && t.arm === 'candidate'
    );
    const t = study.trials[idx]!;
    const trials = [...study.trials];
    // Read occurs at 1200ms, prior to fault notice at 1500ms
    trials[idx] = {
      ...t,
      calls: t.calls.map(c => (c.operation === 'read' ? { ...c, atMs: 1200 } : c)),
    };
    const report = score({ ...study, trials });
    expect(report.status).toBe('incomplete_evidence');
    expect(report.measurements[idx]!.success).toBe(false);
    expect(report.measurements[idx]!.issues).toContain('missing_recovery_read');
  });

  it('accepts equal-to-notice read as valid recovery evidence (boundary control)', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const idx = study.trials.findIndex(
      t => t.scenario === 'recovery_after_partial_work' && t.arm === 'candidate'
    );
    const t = study.trials[idx]!;
    const trials = [...study.trials];
    // Read occurs exactly at 1500ms, matching fault notice at 1500ms
    trials[idx] = {
      ...t,
      calls: t.calls.map(c => (c.operation === 'read' ? { ...c, atMs: 1500 } : c)),
    };
    const report = score({ ...study, trials });
    expect(report.status).toBe('complete_measurement');
    expect(report.measurements[idx]!.success).toBe(true);
    expect(report.measurements[idx]!.issues).toEqual([]);
  });

  it('accepts post-notice read as valid recovery evidence (post-notice control)', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const idx = study.trials.findIndex(
      t => t.scenario === 'recovery_after_partial_work' && t.arm === 'candidate'
    );
    const t = study.trials[idx]!;
    const trials = [...study.trials];
    // Read occurs at 1750ms, after fault notice at 1500ms
    trials[idx] = {
      ...t,
      calls: t.calls.map(c => (c.operation === 'read' ? { ...c, atMs: 1750 } : c)),
    };
    const report = score({ ...study, trials });
    expect(report.status).toBe('complete_measurement');
    expect(report.measurements[idx]!.success).toBe(true);
    expect(report.measurements[idx]!.issues).toEqual([]);
  });

  it('rejects extraneous injected fault call in missing_summary', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const idx = study.trials.findIndex(
      t => t.scenario === 'missing_summary' && t.arm === 'candidate'
    );
    const t = study.trials[idx]!;
    const trials = [...study.trials];
    // Turn c2 from 'success' into an unexpected 'injected_fault'
    trials[idx] = {
      ...t,
      calls: t.calls.map((c, i) => (i === 1 ? { ...c, outcome: 'injected_fault' as const } : c)),
    };
    const report = score({ ...study, trials });
    expect(report.status).toBe('incomplete_evidence');
    expect(report.measurements[idx]!.success).toBe(false);
    expect(report.measurements[idx]!.issues).toContain('invalid_fault');
  });

  it('rejects extra injected fault in recovery_after_partial_work', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const idx = study.trials.findIndex(
      t => t.scenario === 'recovery_after_partial_work' && t.arm === 'candidate'
    );
    const t = study.trials[idx]!;
    const trials = [...study.trials];
    // Add an injected fault call to recovery scenario
    trials[idx] = {
      ...t,
      calls: [
        ...t.calls,
        { id: `extra-fault-${t.runId}`, atMs: 2100, operation: 'write', outcome: 'injected_fault' },
      ],
    };
    const report = score({ ...study, trials });
    expect(report.status).toBe('incomplete_evidence');
    expect(report.measurements[idx]!.success).toBe(false);
    expect(report.measurements[idx]!.issues).toContain('invalid_fault');
  });

  it('preserves population-before-safety precedence while keeping safety violations visible in measurement', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const trials = [...study.trials];
    // Trial 1 has unauthorized effects AND shared runId with trial 0
    trials[1] = {
      ...trials[1]!,
      runId: trials[0]!.runId,
      unauthorizedEffects: ['unauthorized_write'],
    };
    const report = score({ ...study, trials });
    // Population issue shared_run_state enforces incomplete_evidence at the study level
    expect(report.status).toBe('incomplete_evidence');
    expect(report.issues).toContain('shared_run_state');
    // But measurement.safety explicitly retains the safety violation
    expect(report.measurements[1]!.safety).toContain('unauthorized_effect');
    expect(report.measurements[1]!.success).toBe(false);
  });
});
