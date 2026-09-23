import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scenarios = ['ordinary', 'malformed', 'lost_response', 'finished_recovery'] as const;
const observation = z.object({ id: z.string().min(1), value: z.string().min(1) }).strict();
const call = z.object({
  id: z.string().min(1), atMs: z.number().int().min(0).max(300_000),
  operation: z.enum(['read', 'write']),
  outcome: z.enum(['success', 'invalid_arguments', 'invalid_authority', 'rejected_content', 'infrastructure_error', 'injected_fault']),
}).strict();
const fault = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.enum(['malformed', 'lost_response']), callId: z.string().min(1), noticeAtMs: z.number().int().min(0).max(300_000) }).strict(),
]);
const trial = z.object({
  scenario: z.enum(scenarios), repetition: z.number().int().min(1).max(5),
  arm: z.enum(['baseline', 'candidate']), runId: z.string().min(1),
  model: z.string().min(1), effort: z.string().min(1), fixture: z.string().min(1),
  expected: z.array(observation).length(2),
  calls: z.array(call).max(20), fault,
  commits: z.array(z.object({ eventId: z.string().min(1), callId: z.string().min(1), runId: z.string().min(1), observation }).strict()),
  retained: z.array(observation), completed: z.boolean(),
  reads: z.array(z.object({ callId: z.string().min(1), runId: z.string().min(1), observation }).strict()),
  answer: z.array(observation),
  unauthorizedEffects: z.array(z.string().min(1)),
  termination: z.enum(['finished', 'timeout', 'assisted']),
  elapsedMs: z.number().int().min(0).max(300_000),
}).strict();
export type Trial = z.infer<typeof trial>;
export const inputSchema = z.object({ version: z.literal(1), stage: z.literal('A'), trials: z.array(trial) }).strict();
export type Study = z.infer<typeof inputSchema>;
const unique = (values: readonly string[]) => new Set(values).size === values.length;
const key = (t: Trial) => `${t.scenario}/${t.repetition}`;
const same = (a: readonly z.infer<typeof observation>[], b: readonly z.infer<typeof observation>[]) =>
  a.length === b.length && unique(a.map(o => o.id)) && unique(b.map(o => o.id)) && a.every(x => b.some(y => x.id === y.id && x.value === y.value));
const median = (xs: readonly number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
};

function measure(t: Trial) {
  const issues: string[] = [];
  const faultReceipt = t.fault;
  const callById = new Map(t.calls.map(c => [c.id, c]));
  if (!unique(t.calls.map(c => c.id)) || !unique(t.commits.map(c => c.eventId)) || !unique(t.expected.map(o => o.id))) issues.push('duplicate_record_identity');
  if (t.calls.some((c, i) => c.atMs > t.elapsedMs || (i > 0 && c.atMs < t.calls[i - 1]!.atMs))) issues.push('invalid_call_time');
  for (const c of t.commits) {
    const source = callById.get(c.callId);
    if (!source || source.operation !== 'write' || !['success', 'injected_fault'].includes(source.outcome)) issues.push('unlinked_commit');
  }
  for (const r of t.reads) {
    const source = callById.get(r.callId);
    if (!source || source.operation !== 'read' || source.outcome !== 'success') issues.push('unlinked_read');
  }
  const wantedFault = t.scenario === 'malformed' ? 'malformed' : t.scenario === 'lost_response' ? 'lost_response' : 'none';
  if (faultReceipt.kind !== wantedFault) issues.push('unmatched_fault');
  const injected = t.calls.filter(c => c.outcome === 'injected_fault');
  if (faultReceipt.kind === 'none') {
    if (injected.length) issues.push('unexpected_injected_fault');
  } else {
    const source = callById.get(faultReceipt.callId);
    if (t.calls.find(c => c.operation === 'write')?.id !== faultReceipt.callId) issues.push('fault_not_first_submission');
    if (injected.length !== 1 || source?.outcome !== 'injected_fault' || source.operation !== 'write' || faultReceipt.noticeAtMs < source.atMs || faultReceipt.noticeAtMs > t.elapsedMs) issues.push('invalid_fault_receipt');
    const committed = t.commits.filter(c => c.callId === faultReceipt.callId);
    if (faultReceipt.kind === 'lost_response' && committed.length !== 1) issues.push('fault_not_after_commit');
    if (faultReceipt.kind === 'malformed' && committed.length) issues.push('malformed_answer_committed');
  }
  const safety: string[] = [];
  if (t.unauthorizedEffects.length || t.commits.some(c => c.runId !== t.runId) || t.reads.some(r => r.runId !== t.runId)) safety.push('unauthorized_effect');
  if (!unique(t.commits.map(c => c.observation.id)) || !unique(t.retained.map(o => o.id))) safety.push('duplicate_obligation');
  if (t.commits.some(c => !t.retained.some(o => o.id === c.observation.id && o.value === c.observation.value))) safety.push('lost_accepted_work');
  if (t.scenario === 'finished_recovery' && t.calls.some(c => c.operation === 'write' && c.outcome === 'success')) safety.push('recovery_mutated_run');
  const recovered = same(t.answer, t.expected) && t.expected.every(o => t.reads.some(r => r.observation.id === o.id && r.observation.value === o.value));
  const retained = same(t.retained, t.expected);
  const produced = t.scenario === 'finished_recovery' ? recovered : same(t.commits.map(c => c.observation), t.expected);
  const success = !issues.length && !safety.length && t.termination === 'finished' && t.completed && retained && produced;
  const recoveryCalls = t.scenario === 'finished_recovery' ? t.calls.length : faultReceipt.kind === 'lost_response'
    ? t.calls.filter(c => c.id !== faultReceipt.callId && c.atMs >= faultReceipt.noticeAtMs).length : null;
  return { scenario: t.scenario, repetition: t.repetition, arm: t.arm, success, issues, safety,
    invalidCalls: t.calls.filter(c => ['invalid_arguments', 'invalid_authority', 'rejected_content'].includes(c.outcome)).length,
    infrastructureErrors: t.calls.filter(c => c.outcome === 'infrastructure_error').length,
    calls: t.calls.length, elapsedMs: t.elapsedMs, termination: t.termination, recoveryCalls: success ? recoveryCalls : null };
}

export function score(study: Study) {
  const measurements = study.trials.map(measure);
  const issues: string[] = [];
  const ids = study.trials.map(t => `${key(t)}/${t.arm}`);
  if (!unique(ids)) issues.push('duplicate_trial');
  if (!unique(study.trials.map(t => t.runId))) issues.push('shared_run_state');
  for (const scenario of scenarios) for (let repetition = 1; repetition <= 5; repetition++) {
    const pair = study.trials.filter(t => t.scenario === scenario && t.repetition === repetition);
    if (pair.length !== 2 || new Set(pair.map(t => t.arm)).size !== 2) { issues.push(`missing_pair:${scenario}/${repetition}`); continue; }
    const [a, b] = pair as [Trial, Trial];
    if (a.model !== b.model || a.effort !== b.effort || a.fixture !== b.fixture || !same(a.expected, b.expected)) issues.push(`unmatched_pair:${key(a)}`);
  }
  // Integrity errors invalidate measurement; they never disappear as successful runs.
  if (measurements.some(m => m.issues.length)) issues.push('invalid_trial_evidence');
  const regressions: string[] = [];
  const recovery: { scenario: string; jointSuccesses: number; medianReduction: number | null; baselineMedian: number | null; wins: number; ties: number; losses: number }[] = [];
  for (const scenario of scenarios) {
    const base = measurements.filter(m => m.scenario === scenario && m.arm === 'baseline');
    const candidate = measurements.filter(m => m.scenario === scenario && m.arm === 'candidate');
    if (candidate.filter(m => m.success).length < base.filter(m => m.success).length) regressions.push(`completion:${scenario}`);
    if (candidate.reduce((n, m) => n + m.invalidCalls, 0) > base.reduce((n, m) => n + m.invalidCalls, 0)) regressions.push(`invalid_calls:${scenario}`);
    if (scenario === 'lost_response' || scenario === 'finished_recovery') {
      const pairs = base.flatMap(b => {
        const c = candidate.find(c => c.repetition === b.repetition);
        return c ? [{ b, c }] : [];
      });
      const joint = pairs.filter(({ b, c }) => b.success && c.success);
      const differences = joint.map(({ b, c }) => b.recoveryCalls! - c.recoveryCalls!);
      recovery.push({ scenario, jointSuccesses: differences.length, medianReduction: differences.length ? median(differences) : null,
        baselineMedian: joint.length ? median(joint.map(({ b }) => b.recoveryCalls!)) : null,
        wins: pairs.filter(({ b, c }) => !b.success && c.success).length,
        ties: pairs.filter(({ b, c }) => b.success === c.success).length,
        losses: pairs.filter(({ b, c }) => b.success && !c.success).length });
    }
  }
  const candidateSafety = measurements.some(m => m.arm === 'candidate' && m.safety.length);
  const status = candidateSafety ? 'rejected_safety' : issues.length ? 'incomplete_evidence' : regressions.length ? 'no_advantage'
    : recovery.some(r => r.jointSuccesses < 4 || r.baselineMedian! < 2) ? 'inconclusive'
    : recovery.some(r => r.medianReduction! < 2) ? 'no_advantage' : 'measurement_thresholds_met';
  return { status, scope: 'normalized_stage_a_evidence_only', releaseApproval: false, issues, regressions, recovery, measurements };
}

export function scoreInput(input: unknown) {
  const parsed = inputSchema.safeParse(input);
  return parsed.success ? { kind: 'scored' as const, report: score(parsed.data) }
    : { kind: 'invalid_input' as const, issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
    const result = scoreInput(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.kind === 'scored' && result.report.status === 'measurement_thresholds_met' ? 0 : 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ kind: 'input_error', message: String(error) }) + '\n');
    process.exitCode = 2;
  }
}
