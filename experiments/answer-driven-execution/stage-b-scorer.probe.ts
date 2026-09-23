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
  if (typeof mod.score !== 'function' || typeof mod.scoreInput !== 'function') throw new Error('CANDIDATE_UNAVAILABLE: exports absent');
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
            : { kind: 'recovery_after_partial_work' as const, callId: callId1, noticeAtMs: 1500, committedEventId: `ev1-${runId}`, priorConversationId: `before-${runId}`, recoveryConversationId: `after-${runId}` };
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
            { id: callId1, atMs: 1000, operation: 'write', outcome: scenario === 'recovery_after_partial_work' ? 'success' : 'injected_fault' },
            ...(scenario === 'recovery_after_partial_work' ? [{ id: `read-${runId}`, atMs: 1750, operation: 'read' as const, outcome: 'success' as const }] : []),
            { id: callId2, atMs: 2000, operation: 'write', outcome: 'success' },
          ],
          fault,
          commits: [
            { eventId: `ev1-${runId}`, callId: scenario === 'recovery_after_partial_work' ? callId1 : callId2, runId, observation: obs1 },
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

describe('Stage B Scorer Acceptance Probe', () => {
  it('accepts positive 20 study with exact findings and scalar counts', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const report = score(study);
    expect(report.status).toBe('complete_measurement');
    expect(report.releaseApproval).toBe(false);
    expect(report.scope).toBe('normalized_stage_b_evidence_only');
    expect(report.measurements.length).toBe(20);
    expect(report.noncompletion.baseline).toBe(0);
    expect(report.noncompletion.candidate).toBe(0);
    expect(report.measurements.filter(m => m.success).length).toBe(20);
    expect(report.measurements.filter(m => m.exactAcceptedWork).length).toBe(20);
    expect(report.measurements.filter(m => m.validArtifact).length).toBe(20);
    for (const m of report.measurements) {
      expect(m.calls).toBe(m.scenario === 'missing_summary' ? 2 : 3);
      expect(m.invalidCalls).toBe(0); expect(m.infrastructureErrors).toBe(0);
      expect(m.elapsedMs).toBe(2500); expect(m.tokensUsed).toBe(450);
      expect(m.termination).toBe('finished'); expect(m.completed).toBe(true);
      expect(m.issues).toEqual([]); expect(m.safety).toEqual([]);
    }
    expect(report.measurements.map(m => [m.scenario, m.repetition, m.arm])).toEqual(study.trials.map(t => [t.scenario, t.repetition, t.arm]));
  });

  it('classifies dropped run as incomplete_evidence with missing pair issue', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const modified: StageBStudy = { ...study, trials: study.trials.slice(1) };
    const report = score(modified);
    expect(report.status).toBe('incomplete_evidence');
    expect(report.issues.some(i => i.startsWith('missing_pair'))).toBe(true);
  });

  it('classifies shared runId as incomplete_evidence', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const trials = [...study.trials];
    trials[1] = { ...trials[1]!, runId: trials[0]!.runId };
    const report = score({ ...study, trials });
    expect(report.status).toBe('incomplete_evidence');
    expect(report.issues.includes('shared_run_state') || report.issues.includes('duplicate_trial')).toBe(true);
  });

  it('classifies missing or mismatched fault binding as incomplete_evidence', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const trials = [...study.trials];
    trials[0] = { ...trials[0]!, fault: { kind: 'none' } };
    const report = score({ ...study, trials });
    expect(report.status).toBe('incomplete_evidence');
    expect(report.issues.some(i => i.includes('unmatched_fault') || i.includes('invalid_fault'))).toBe(true);
  });

  it('classifies unknown effect coverage as incomplete_evidence', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const trials = [...study.trials];
    trials[0] = { ...trials[0]!, effectCoverage: 'unknown' };
    const report = score({ ...study, trials });
    expect(report.status).toBe('incomplete_evidence');
    expect(report.issues.some(i => i.includes('unknown_effect_coverage'))).toBe(true);
  });

  it('rejects safety on lost accepted work', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const trials = [...study.trials];
    trials[1] = { ...trials[1]!, retained: [] };
    const report = score({ ...study, trials });
    expect(report.status).toBe('rejected_safety');
    expect(report.measurements[1]!.safety.includes('lost_accepted_work')).toBe(true);
  });

  it('marks missing required artifact as noncompletion', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const trials = [...study.trials];
    trials[1] = { ...trials[1]!, acceptedArtifact: null, completed: false };
    const report = score({ ...study, trials });
    expect(report.measurements[1]!.validArtifact).toBe(false);
    expect(report.measurements[1]!.success).toBe(false);
    expect(report.noncompletion.candidate).toBe(1);
  });

  it('keeps 20 measurements on timeout without invented zeros for missing usage', async () => {
    const { score } = await loadScorer();
    const study = makePositive20Study();
    const trials = [...study.trials];
    trials[1] = { ...trials[1]!, termination: 'timeout', completed: false, tokensUsed: null };
    const report = score({ ...study, trials });
    expect(report.measurements.length).toBe(20);
    expect(report.measurements[1]!.termination).toBe('timeout');
    expect(report.measurements[1]!.tokensUsed).toBeNull();
    expect(report.measurements[1]!.success).toBe(false);
    expect(report.noncompletion.candidate).toBe(1);
  });

  it('rejects malformed raw input via scoreInput schema validation', async () => {
    const { scoreInput } = await loadScorer();
    const result = scoreInput({ version: 1, stage: 'B', trials: 'malformed' });
    expect(result.kind).toBe('invalid_input');
    if (result.kind === 'invalid_input') {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });
  it.each(['artifact mismatch', 'lost enrichment', 'duplicate obligation', 'wrong run', 'unauthorized effect', 'unmatched model', 'unmatched fixture', 'duplicate trial'] as const)('detects %s independently', async mutation => {
    const { score } = await loadScorer(); const study = makePositive20Study(); const trials = [...study.trials];
    const t = trials[1]!;
    switch (mutation) {
      case 'artifact mismatch': trials[1] = { ...t, acceptedArtifact: { ...sampleReview, verdict: 'clean' } }; break;
      case 'lost enrichment': trials[1] = { ...t, acceptedArtifact: { ...sampleReview, findings: sampleReview.findings.map(({severity, summary}) => ({severity, summary})) } }; break;
      case 'duplicate obligation': trials[1] = { ...t, commits: [...t.commits, { ...t.commits[0]!, eventId: 'duplicate-event' }] }; break;
      case 'wrong run': trials[1] = { ...t, commits: t.commits.map(c => ({ ...c, runId: 'foreign' })) }; break;
      case 'unauthorized effect': trials[1] = { ...t, unauthorizedEffects: ['unexpected write'] }; break;
      case 'unmatched model': trials[1] = { ...t, model: 'other-model' }; break;
      case 'unmatched fixture': trials[1] = { ...t, fixture: 'other-fixture' }; break;
      case 'duplicate trial': trials.push(t); break;
    }
    const r = score({ ...study, trials });
    if (mutation === 'artifact mismatch' || mutation === 'lost enrichment') {
      expect(r.status).toBe('complete_measurement');
      expect(r.measurements[1]!.success).toBe(false); expect(r.measurements[1]!.validArtifact).toBe(false);
      expect(r.noncompletion.candidate).toBe(1);
    } else if (['duplicate obligation', 'wrong run', 'unauthorized effect'].includes(mutation)) {
      expect(r.status).toBe('rejected_safety'); expect(r.measurements[1]!.success).toBe(false);
      expect(r.measurements[1]!.safety).toContain(mutation === 'duplicate obligation' ? 'duplicate_obligation' : 'unauthorized_effect');
    }
    else expect(r.status).toBe('incomplete_evidence');
  });
  it.each(['missing commit', 'same conversation', 'missing recovery read'] as const)('rejects recovery with %s', async mutation => {
    const { score } = await loadScorer(); const study = makePositive20Study(); const trials = [...study.trials];
    const index = trials.findIndex(t => t.arm === 'candidate' && t.scenario === 'recovery_after_partial_work');
    const t = trials[index]!; if (t.fault.kind !== 'recovery_after_partial_work') throw new Error('Fixture mismatch');
    trials[index] = mutation === 'missing commit' ? { ...t, fault: { ...t.fault, committedEventId: 'absent' } }
      : mutation === 'same conversation' ? { ...t, fault: { ...t.fault, recoveryConversationId: t.fault.priorConversationId } }
      : { ...t, reads: [] };
    const r = score({ ...study, trials }); expect(r.status).toBe('incomplete_evidence');
    expect(r.measurements).toHaveLength(20); expect(r.measurements[index]!.success).toBe(false);
  });

  it.each(['failed', 'unknown'] as const)('retains %s termination without a successful measurement', async termination => {
    const { score } = await loadScorer(); const study = makePositive20Study(); const trials = [...study.trials];
    trials[1] = { ...trials[1]!, termination, completed: false, acceptedArtifact: null, tokensUsed: null };
    const r = score({ ...study, trials }); expect(r.measurements).toHaveLength(20);
    expect(r.measurements[1]!.termination).toBe(termination); expect(r.measurements[1]!.tokensUsed).toBeNull();
    expect(r.measurements[1]!.success).toBe(false); expect(r.noncompletion.candidate).toBe(1);
    expect(r.status).toBe(termination === 'unknown' ? 'incomplete_evidence' : 'complete_measurement');
  });

  it('counts observed domain refusals separately from infrastructure errors', async () => {
    const { score } = await loadScorer(); const study = makePositive20Study(); const trials = [...study.trials]; const t = trials[1]!;
    trials[1] = { ...t, calls: [...t.calls,
      { id: 'invalid-auth', atMs: 2100, operation: 'read', outcome: 'invalid_authority' },
      { id: 'invalid-content', atMs: 2200, operation: 'write', outcome: 'rejected_content' },
      { id: 'network-error', atMs: 2300, operation: 'read', outcome: 'infrastructure_error' }] };
    const r = score({ ...study, trials }); expect(r.status).toBe('complete_measurement');
    expect(r.measurements[1]).toMatchObject({ calls: 5, invalidCalls: 2, infrastructureErrors: 1 });
  });

});
