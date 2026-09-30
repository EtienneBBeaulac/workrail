import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { scoreInput, type Study, type Trial } from '../../experiments/answer-driven-execution/usability-scorer.mts';

function trial(scenario: Trial['scenario'], repetition: number, arm: Trial['arm']): Trial {
  const runId = `${scenario}-${repetition}-${arm}`;
  const expected = [{ id: 'first', value: `A-${scenario}-${repetition}` }, { id: 'second', value: `B-${scenario}-${repetition}` }];
  const recoveryLength = arm === 'baseline' ? 5 : 3;
  const finishedRecovery = scenario === 'finished_recovery';
  const injected = scenario === 'malformed' || scenario === 'lost_response';
  const count = finishedRecovery ? recoveryLength : scenario === 'lost_response' ? recoveryLength + 1 : injected ? 3 : 2;
  const calls: Trial['calls'] = Array.from({ length: count }, (_, i) => ({ id: `call-${i}`, atMs: i * 100,
    operation: finishedRecovery ? 'read' : 'write', outcome: i === 0 && injected ? 'injected_fault' : 'success' }));
  const commits = finishedRecovery ? [] : expected.map((observation, i) => ({ eventId: `${runId}-event-${i}`,
    callId: `call-${scenario === 'malformed' ? i + 1 : i}`, runId, observation }));
  return { scenario, repetition, arm, runId, expected, calls, commits, retained: expected,
    model: 'fixed-test-model', effort: 'high', fixture: `${scenario}/${repetition}`,
    fault: injected ? { kind: scenario, callId: 'call-0', noticeAtMs: 0 } : { kind: 'none' },
    reads: finishedRecovery ? expected.map((observation, i) => ({ callId: `call-${i}`, runId, observation })) : [],
    answer: finishedRecovery ? expected : [], completed: true, unauthorizedEffects: [], termination: 'finished', elapsedMs: count * 100 };
}
function study(): Study {
  return { version: 1, stage: 'A', trials: (['ordinary', 'malformed', 'lost_response', 'finished_recovery'] as const)
    .flatMap(scenario => Array.from({ length: 5 }, (_, i) => (['baseline', 'candidate'] as const).map(arm => trial(scenario, i + 1, arm))).flat()) };
}
function result(s: unknown) {
  const r = scoreInput(s);
  expect(r.kind).toBe('scored');
  if (r.kind !== 'scored') throw new Error('Invalid fixture');
  return r.report;
}
function change(s: Study, scenario: Trial['scenario'], patch: (t: Trial) => Trial, repetition = 1): Study {
  return { ...s, trials: s.trials.map(t => t.arm === 'candidate' && t.scenario === scenario && t.repetition === repetition ? patch(t) : t) };
}

describe('normalized usability evidence scorer', () => {
  it('runs the CLI and returns a nonzero exit for incomplete evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usability-scorer-'));
    const input = join(dir, 'input.json');
    try {
      await writeFile(input, JSON.stringify(study()));
      const args = [createRequire(import.meta.url).resolve('vite-node/vite-node.mjs'), '--script', resolve('experiments/answer-driven-execution/usability-scorer.mts'), input];
      const valid = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 });
      expect(valid.status, valid.stderr).toBe(0);
      expect(JSON.parse(valid.stdout).report.releaseApproval).toBe(false);
      await writeFile(input, JSON.stringify({ ...study(), trials: [] }));
      expect(spawnSync(process.execPath, args, { timeout: 10_000 }).status).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('accepts a complete matched measurement with a two-call recovery improvement', () => {
    const r = result(study());
    expect(r.status).toBe('measurement_thresholds_met');
    expect(r.releaseApproval).toBe(false);
    expect(r.measurements).toHaveLength(40);
    expect(r.recovery.map(r => r.medianReduction)).toEqual([2, 2]);
  });
  it('never accepts an empty study or a missing pair', () => {
    expect(result({ ...study(), trials: [] }).status).toBe('incomplete_evidence');
    expect(result({ ...study(), trials: study().trials.slice(1) }).status).toBe('incomplete_evidence');
  });
  it('rejects an unknown schema instead of ignoring evidence', () => {
    expect(scoreInput({ ...study(), stage: 'B' }).kind).toBe('invalid_input');
    expect(scoreInput({ ...study(), claimedSuccess: true }).kind).toBe('invalid_input');
  });
  it('detects lost accepted work despite a completed flag', () => {
    expect(result(change(study(), 'ordinary', t => ({ ...t, retained: t.retained.slice(1) }))).status).toBe('rejected_safety');
  });
  it('rejects duplicate committed obligations with distinct event identities', () => {
    expect(result(change(study(), 'ordinary', t => ({ ...t, commits: [...t.commits, { ...t.commits[0]!, eventId: 'duplicate-effect' }] }))).status).toBe('rejected_safety');
  });
  it('does not credit a completed flag without committed work', () => {
    expect(result(change(study(), 'ordinary', t => ({ ...t, commits: [] }))).status).toBe('no_advantage');
  });
  it('does not credit repeated first observations as recovery of both observations', () => {
    expect(result(change(study(), 'finished_recovery', t => ({ ...t, answer: [t.expected[0]!, t.expected[0]!] }))).status).toBe('no_advantage');
  });
  it('requires recovery reads as well as the final answer', () => {
    expect(result(change(study(), 'finished_recovery', t => ({ ...t, reads: [] }))).status).toBe('no_advantage');
  });
  it('rejects wrong-run evidence and successful recovery writes', () => {
    expect(result(change(study(), 'finished_recovery', t => ({ ...t, reads: t.reads.map(r => ({ ...r, runId: 'another-run' })) }))).status).toBe('rejected_safety');
    expect(result(change(study(), 'finished_recovery', t => ({ ...t, calls: [...t.calls, { id: 'write', atMs: 300, operation: 'write', outcome: 'success' }] }))).status).toBe('rejected_safety');
  });
  it('requires the scheduled fault and confirmation that a lost response followed commit', () => {
    expect(result(change(study(), 'lost_response', t => ({ ...t, fault: { kind: 'none' } }))).status).toBe('incomplete_evidence');
    expect(result(change(study(), 'lost_response', t => ({ ...t, commits: t.commits.slice(1) }))).status).toBe('incomplete_evidence');
  });
  it('counts domain rejections as invalid calls but not injected faults', () => {
    const r = result(change(study(), 'ordinary', t => ({ ...t, calls: [...t.calls, { id: 'invalid', atMs: 200, operation: 'write', outcome: 'rejected_content' }] })));
    expect(r.status).toBe('no_advantage');
    expect(r.measurements.find(t => t.scenario === 'ordinary' && t.arm === 'candidate')?.invalidCalls).toBe(1);
    expect(result(study()).measurements.every(t => t.invalidCalls === 0)).toBe(true);
  });
  it('keeps failed recovery out of numeric call savings', () => {
    const s = study();
    const failed = { ...s, trials: s.trials.map(t => t.scenario === 'lost_response' && t.repetition <= 2 ? { ...t, termination: 'timeout' as const } : t) };
    const r = result(failed);
    expect(r.status).toBe('inconclusive');
    expect(r.recovery[0]?.jointSuccesses).toBe(3);
    expect(r.measurements.filter(t => t.scenario === 'lost_response' && t.repetition <= 2).every(t => t.recoveryCalls === null)).toBe(true);
  });
  it('reports inconclusive when baseline recovery has less than two calls to save', () => {
    const s = study();
    const trials = s.trials.map(t => t.scenario === 'finished_recovery' ? {
      ...t, calls: [t.calls[0]!], reads: t.reads.map(r => ({ ...r, callId: t.calls[0]!.id })),
    } : t);
    expect(result({ ...s, trials }).status).toBe('inconclusive');
  });
  it('rejects unmatched model settings and shared run state', () => {
    expect(result(change(study(), 'ordinary', t => ({ ...t, model: 'other-model' }))).status).toBe('incomplete_evidence');
    expect(result(change(study(), 'ordinary', t => ({ ...t, runId: 'ordinary-1-baseline' }))).issues).toContain('shared_run_state');
  });
  it('refuses duplicates, unlinked events, and calls outside elapsed time', () => {
    const s = study();
    expect(result({ ...s, trials: [...s.trials, s.trials[0]!] }).status).toBe('incomplete_evidence');
    expect(result(change(s, 'ordinary', t => ({ ...t, commits: t.commits.map(c => ({ ...c, callId: 'missing' })) }))).status).toBe('incomplete_evidence');
    expect(result(change(s, 'ordinary', t => ({ ...t, elapsedMs: 0 }))).status).toBe('incomplete_evidence');
  });
});
