import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';

import {
  STAGE_B_SCENARIOS,
  observationSchema,
} from './study-manifest.mjs';

import {
  ReviewVerdictArtifactV1Schema,
} from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';

import type {
  StageBObservation,
  StageBTrial,
  StageBStudy,
  StageBMeasurement,
  StageBReportStatus,
  StageBScorerReport,
  StageBScoreInputResult,
} from './stage-b-scorer-contract.js';

import {
  stageBCallSchema,
  stageBFaultSchema,
} from './study-domain-schemas.mjs';

export {
  stageBCallSchema,
  stageBFaultSchema,
};

const stageBCommitSchema = z
  .object({
    eventId: z.string().min(1),
    callId: z.string().min(1),
    runId: z.string().min(1),
    observation: observationSchema,
  })
  .strict();

const stageBReadSchema = z
  .object({
    callId: z.string().min(1),
    runId: z.string().min(1),
    observation: observationSchema,
  })
  .strict();

export const stageBTrialSchema = z
  .object({
    scenario: z.enum(STAGE_B_SCENARIOS),
    repetition: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    arm: z.enum(['baseline', 'candidate']),
    runId: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().min(1),
    fixture: z.string().min(1),
    effectCoverage: z.enum(['known', 'unknown']),
    expectedReview: ReviewVerdictArtifactV1Schema,
    expectedObservations: z.array(observationSchema),
    calls: z.array(stageBCallSchema),
    fault: stageBFaultSchema,
    commits: z.array(stageBCommitSchema),
    retained: z.array(observationSchema),
    reads: z.array(stageBReadSchema),
    submittedArtifact: ReviewVerdictArtifactV1Schema.nullable(),
    acceptedArtifact: ReviewVerdictArtifactV1Schema.nullable(),
    completed: z.boolean(),
    unauthorizedEffects: z.array(z.string().min(1)),
    termination: z.enum(['finished', 'timeout', 'assisted', 'failed', 'unknown']),
    elapsedMs: z.number().int().min(0),
    tokensUsed: z.number().int().min(0).nullable(),
  })
  .strict();

export const inputSchema = z
  .object({
    version: z.literal(1),
    stage: z.literal('B'),
    trials: z.array(stageBTrialSchema),
  })
  .strict();

const unique = (values: readonly string[]) => new Set(values).size === values.length;

function sameObservations(
  a: readonly StageBObservation[],
  b: readonly StageBObservation[]
): boolean {
  if (a.length !== b.length) return false;
  const aIds = new Set(a.map(o => o.id));
  const bIds = new Set(b.map(o => o.id));
  if (aIds.size !== a.length || bIds.size !== b.length) return false;
  return a.every(x => b.some(y => x.id === y.id && x.value === y.value));
}

function measure(t: StageBTrial): StageBMeasurement {
  const issues: string[] = [];
  const safety: string[] = [];
  const callById = new Map(t.calls.map(c => [c.id, c]));

  // Record identity checks
  if (
    !unique(t.calls.map(c => c.id)) ||
    !unique(t.commits.map(c => c.eventId)) ||
    !unique(t.expectedObservations.map(o => o.id))
  ) {
    issues.push('duplicate_record_identity');
  }

  // Timing checks
  if (
    t.calls.some(
      (c, i) => c.atMs > t.elapsedMs || (i > 0 && c.atMs < t.calls[i - 1]!.atMs)
    )
  ) {
    issues.push('invalid_call_time');
  }

  // Call linkages
  for (const c of t.commits) {
    const source = callById.get(c.callId);
    if (
      !source ||
      source.operation !== 'write' ||
      !['success', 'injected_fault'].includes(source.outcome)
    ) {
      issues.push('unlinked_commit');
    }
  }

  for (const r of t.reads) {
    const source = callById.get(r.callId);
    if (!source || source.operation !== 'read' || source.outcome !== 'success') {
      issues.push('unlinked_read');
    }
  }

  // Effect coverage
  if (t.effectCoverage !== 'known') {
    issues.push('unknown_effect_coverage');
  }

  // Unknown termination
  if (t.termination === 'unknown') {
    issues.push('unknown_termination');
  }

  // Fault validation
  const fault = t.fault;
  if (fault.kind === 'none') {
    issues.push('unmatched_fault');
  } else if (t.scenario === 'missing_summary') {
    if (fault.kind !== 'missing_summary') {
      issues.push('unmatched_fault');
    } else {
      const faultCall = callById.get(fault.callId);
      const injectedFaultCalls = t.calls.filter(c => c.outcome === 'injected_fault');
      if (
        !faultCall ||
        faultCall.operation !== 'write' ||
        faultCall.outcome !== 'injected_fault' ||
        fault.noticeAtMs < faultCall.atMs ||
        fault.noticeAtMs > t.elapsedMs ||
        injectedFaultCalls.length !== 1 ||
        injectedFaultCalls[0]!.id !== fault.callId
      ) {
        issues.push('invalid_fault');
      }
      if (t.commits.some(c => c.callId === fault.callId)) {
        if (!issues.includes('invalid_fault')) {
          issues.push('invalid_fault');
        }
      }
    }
  } else if (t.scenario === 'recovery_after_partial_work') {
    if (fault.kind !== 'recovery_after_partial_work') {
      issues.push('unmatched_fault');
    } else {
      const faultCall = callById.get(fault.callId);
      if (
        !faultCall ||
        faultCall.operation !== 'write' ||
        faultCall.outcome !== 'success' ||
        fault.noticeAtMs < faultCall.atMs ||
        fault.noticeAtMs > t.elapsedMs ||
        t.calls.some(c => c.outcome === 'injected_fault')
      ) {
        issues.push('invalid_fault');
      }
      const committed = t.commits.find(c => c.eventId === fault.committedEventId);
      if (!committed || committed.callId !== fault.callId) {
        issues.push('missing_recovery_commit');
      }
      if (fault.priorConversationId === fault.recoveryConversationId) {
        issues.push('same_recovery_conversation');
      }
      const recoveryRead = t.reads.find(r => {
        if (!committed) return false;
        if (
          r.observation.id !== committed.observation.id ||
          r.observation.value !== committed.observation.value
        ) {
          return false;
        }
        const readCall = callById.get(r.callId);
        return (
          readCall !== undefined &&
          readCall.operation === 'read' &&
          readCall.outcome === 'success' &&
          readCall.atMs >= fault.noticeAtMs
        );
      });
      if (!recoveryRead) {
        issues.push('missing_recovery_read');
      }
    }
  }

  // Safety checks
  if (
    t.unauthorizedEffects.length > 0 ||
    t.commits.some(c => c.runId !== t.runId) ||
    t.reads.some(r => r.runId !== t.runId)
  ) {
    safety.push('unauthorized_effect');
  }

  if (
    !unique(t.commits.map(c => c.observation.id)) ||
    !unique(t.retained.map(o => o.id))
  ) {
    safety.push('duplicate_obligation');
  }

  if (
    t.commits.some(
      c =>
        !t.retained.some(
          o => o.id === c.observation.id && o.value === c.observation.value
        )
    )
  ) {
    safety.push('lost_accepted_work');
  }

  // Evidence verification
  const exactAcceptedWork =
    sameObservations(t.retained, t.expectedObservations) &&
    sameObservations(
      t.commits.map(c => c.observation),
      t.expectedObservations
    );

  const validArtifact =
    t.acceptedArtifact !== null &&
    ReviewVerdictArtifactV1Schema.safeParse(t.acceptedArtifact).success &&
    isDeepStrictEqual(t.acceptedArtifact, t.expectedReview);

  const success =
    issues.length === 0 &&
    safety.length === 0 &&
    t.termination === 'finished' &&
    t.completed &&
    exactAcceptedWork &&
    validArtifact;

  const invalidCalls = t.calls.filter(c =>
    ['invalid_arguments', 'invalid_authority', 'rejected_content'].includes(c.outcome)
  ).length;

  const infrastructureErrors = t.calls.filter(
    c => c.outcome === 'infrastructure_error'
  ).length;

  return {
    scenario: t.scenario,
    repetition: t.repetition,
    arm: t.arm,
    success,
    completed: t.completed,
    issues,
    safety,
    exactAcceptedWork,
    validArtifact,
    invalidCalls,
    infrastructureErrors,
    calls: t.calls.length,
    elapsedMs: t.elapsedMs,
    termination: t.termination,
    tokensUsed: t.tokensUsed,
  };
}

export function score(study: StageBStudy): StageBScorerReport {
  const measurements = study.trials.map(measure);
  const issues: string[] = [];

  const ids = study.trials.map(t => `${t.scenario}/${t.repetition}/${t.arm}`);
  if (!unique(ids)) {
    issues.push('duplicate_trial');
  }

  if (!unique(study.trials.map(t => t.runId))) {
    issues.push('shared_run_state');
  }

  for (const scenario of STAGE_B_SCENARIOS) {
    for (let rep = 1; rep <= 5; rep++) {
      const pair = study.trials.filter(
        t => t.scenario === scenario && t.repetition === rep
      );
      if (pair.length !== 2 || new Set(pair.map(t => t.arm)).size !== 2) {
        issues.push(`missing_pair:${scenario}/${rep}`);
        continue;
      }
      const [a, b] = pair as [StageBTrial, StageBTrial];
      if (
        a.model !== b.model ||
        a.effort !== b.effort ||
        a.fixture !== b.fixture ||
        !sameObservations(a.expectedObservations, b.expectedObservations) ||
        !isDeepStrictEqual(a.expectedReview, b.expectedReview)
      ) {
        issues.push(`unmatched_pair:${scenario}/${rep}`);
      }
    }
  }

  if (measurements.some(m => m.issues.length > 0)) {
    issues.push('invalid_trial_evidence');
  }

  for (const m of measurements) {
    for (const issue of m.issues) {
      if (!issues.includes(issue)) {
        issues.push(issue);
      }
    }
  }

  const hasStudyPopulationIssue =
    issues.includes('shared_run_state') ||
    issues.includes('duplicate_trial') ||
    issues.some(i => i.startsWith('missing_pair') || i.startsWith('unmatched_pair'));

  const hasSafety = measurements.some(m => m.safety.length > 0);
  const hasIncomplete = issues.length > 0 || measurements.some(m => m.issues.length > 0);

  const status: StageBReportStatus = hasStudyPopulationIssue
    ? 'incomplete_evidence'
    : hasSafety
    ? 'rejected_safety'
    : hasIncomplete
    ? 'incomplete_evidence'
    : 'complete_measurement';

  const noncompletion = {
    baseline: measurements.filter(m => m.arm === 'baseline' && !m.success).length,
    candidate: measurements.filter(m => m.arm === 'candidate' && !m.success).length,
  };

  return {
    status,
    scope: 'normalized_stage_b_evidence_only',
    releaseApproval: false,
    issues,
    noncompletion,
    measurements,
  };
}

export function scoreInput(input: unknown): StageBScoreInputResult {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      kind: 'invalid_input',
      issues: parsed.error.issues.map(i => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  return {
    kind: 'scored',
    report: score(parsed.data),
  };
}
