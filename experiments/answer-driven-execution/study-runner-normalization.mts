import type {
  HostRecord,
  StageAScoreReport,
} from './study-runner-contract.js';
import type {
  AgentEvent,
  LedgerRecord,
} from './trial-executor-contract.js';
import {
  type ValidatedStudyManifest,
  STAGE_A_SCENARIOS,
  STAGE_B_SCENARIOS,
  type StageAScenario,
  type StageBScenario,
} from './study-manifest.mjs';
import { score as scoreStageA, type Trial as StageATrial } from './usability-scorer.mjs';
import { score as scoreStageB } from './stage-b-scorer.mjs';
import type {
  StageBTrial,
  StageBScorerReport,
  StageBCall,
  StageBObservation,
  StageBFault,
  StageBCommit,
  StageBRead,
  StageBArm,
  StageBRepetition,
  StageBTermination,
} from './stage-b-scorer-contract.js';
import {
  ReviewVerdictArtifactV1Schema,
  type ReviewVerdictArtifactV1,
} from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';

export interface PlannedSlot<S extends 'A' | 'B' = 'A' | 'B'> {
  readonly pair: Extract<ValidatedStudyManifest, { stage: S }>['pairs'][number];
  readonly arm: 'baseline' | 'candidate';
  readonly runId: string;
}

export function buildPlannedSlots(
  manifest: ValidatedStudyManifest,
): readonly PlannedSlot[] {
  const slots: PlannedSlot[] = [];
  for (const pair of manifest.pairs) {
    for (const arm of pair.armOrder) {
      slots.push({ pair, arm, runId: pair[arm].runId });
    }
  }
  return slots;
}

export type SlotDisposition = { readonly runId: string } & (
  | { readonly status: 'normalized' }
  | {
      readonly status: 'unscorable';
      readonly reason:
        | 'missing_host_evidence'
        | 'unknown_model'
        | 'failed'
        | 'unknown_remote'
        | 'invalid_evidence';
    }
  | { readonly status: 'not_attempted' }
);

export function resolveFailureSlotDispositions(
  plannedSlots: readonly PlannedSlot[],
  attemptedCount: number,
  knownLedger: readonly LedgerRecord[],
  defaultReason: 'failed' | 'invalid_evidence',
): readonly SlotDisposition[] {
  const launchedRunIds = new Set(
    plannedSlots.slice(0, attemptedCount).map((slot) => slot.runId),
  );

  return plannedSlots.map((s) => {
    if (!launchedRunIds.has(s.runId)) {
      return { runId: s.runId, status: 'not_attempted' };
    }
    const outcomeRec = knownLedger.find(
      (r): r is Extract<LedgerRecord, { type: 'outcome' }> =>
        r.type === 'outcome' && r.runId === s.runId,
    );
    if (outcomeRec?.outcome === 'unknown_remote') {
      return { runId: s.runId, status: 'unscorable', reason: 'unknown_remote' };
    }
    if (outcomeRec?.outcome === 'conversation_reused') {
      return { runId: s.runId, status: 'unscorable', reason: 'invalid_evidence' };
    }
    return { runId: s.runId, status: 'unscorable', reason: defaultReason };
  });
}

import { z } from 'zod';
import {
  isLedgerRecord,
  isHostRecord,
  isStreamOrderEntry,
  parseLedgerRecords,
  parseHostRecords,
  parseStreamOrder,
  type HostStreamOrderEntry,
  type AgentStreamOrderEntry,
  type StreamOrderEntry,
  type JournalParseError,
  type JournalParseOutcome,
} from './study-journal-schema.mjs';

export {
  isLedgerRecord,
  isHostRecord,
  isStreamOrderEntry,
  parseLedgerRecords,
  parseHostRecords,
  parseStreamOrder,
  type HostStreamOrderEntry,
  type AgentStreamOrderEntry,
  type StreamOrderEntry,
  type JournalParseError,
  type JournalParseOutcome,
};

import {
  stageAFaultSchema,
  stageBFaultSchema,
} from './study-domain-schemas.mjs';

export {
  stageAFaultSchema,
  stageBFaultSchema,
};

export const stageATerminationSchema = z.enum(['finished', 'timeout', 'assisted']);
export const stageBTerminationSchema = z.enum(['finished', 'timeout', 'assisted', 'failed', 'unknown']);

export const stageAScenarioSchema = z.enum(STAGE_A_SCENARIOS);
export const stageBScenarioSchema = z.enum(STAGE_B_SCENARIOS);

export const stageRepetitionSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const stageArmSchema = z.enum(['baseline', 'candidate']);

const expectedReviewContainerSchema = z.object({
  expectedReview: ReviewVerdictArtifactV1Schema,
});

export function parseExpectedReview(content: string | Buffer): ReviewVerdictArtifactV1 | null {
  try {
    const str = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
    const parsed: unknown = JSON.parse(str);
    const res = expectedReviewContainerSchema.safeParse(parsed);
    if (res.success) {
      return res.data.expectedReview;
    }
    return null;
  } catch {
    return null;
  }
}

export interface BaseNormalizeStudyInput {
  readonly cachedArtifacts: ReadonlyMap<string, Buffer | string>;
  readonly agentLedger: readonly LedgerRecord[];
  readonly hostLedger: readonly HostRecord[];
  readonly streamLedger: readonly StreamOrderEntry[];
  readonly plannedSlots: readonly PlannedSlot[];
}

export interface StageANormalizeInput extends BaseNormalizeStudyInput {
  readonly manifest: Extract<ValidatedStudyManifest, { stage: 'A' }>;
}

export interface StageBNormalizeInput extends BaseNormalizeStudyInput {
  readonly manifest: Extract<ValidatedStudyManifest, { stage: 'B' }>;
}

export type NormalizeStudyInput = StageANormalizeInput | StageBNormalizeInput;

export type StageAReportStatus =
  | 'measurement_thresholds_met'
  | 'no_advantage'
  | 'inconclusive'
  | 'incomplete_evidence'
  | 'rejected_safety'
  | 'failed';

export function isStageAReportStatus(status: unknown): status is StageAReportStatus {
  return (
    status === 'measurement_thresholds_met' ||
    status === 'no_advantage' ||
    status === 'inconclusive' ||
    status === 'incomplete_evidence' ||
    status === 'rejected_safety' ||
    status === 'failed'
  );
}

export type StageBReportStatus =
  | 'complete_measurement'
  | 'incomplete_evidence'
  | 'rejected_safety'
  | 'failed';

export interface StageANormalizeOutput {
  readonly stage: 'A';
  readonly slots: readonly SlotDisposition[];
  readonly trials: readonly StageATrial[];
  readonly reportStatus: StageAReportStatus;
  readonly scoreReport: StageAScoreReport | null;
}

export interface StageBNormalizeOutput {
  readonly stage: 'B';
  readonly slots: readonly SlotDisposition[];
  readonly trials: readonly StageBTrial[];
  readonly reportStatus: StageBReportStatus;
  readonly scoreReport: StageBScorerReport | null;
}

export type NormalizeStudyOutput = StageANormalizeOutput | StageBNormalizeOutput;

export function normalizeStudy(input: StageANormalizeInput): StageANormalizeOutput;
export function normalizeStudy(input: StageBNormalizeInput): StageBNormalizeOutput;
export function normalizeStudy(input: NormalizeStudyInput): NormalizeStudyOutput;
export function normalizeStudy(input: NormalizeStudyInput): NormalizeStudyOutput {
  const { manifest, cachedArtifacts, agentLedger, hostLedger, streamLedger, plannedSlots } = input;

  // Group host records strictly by h.runId matching planned slot runIds
  const hostRecordsBySlot = new Map<string, HostRecord[]>();
  for (const s of plannedSlots) {
    hostRecordsBySlot.set(s.runId, []);
  }
  for (const h of hostLedger) {
    const slotList = hostRecordsBySlot.get(h.runId);
    if (slotList !== undefined) {
      slotList.push(h);
    }
  }

  // Detect duplicate recordIds in host ledger
  const seenHostRecordIds = new Set<string>();
  let hasDuplicateHostRecordId = false;
  for (const h of hostLedger) {
    if (seenHostRecordIds.has(h.recordId)) {
      hasDuplicateHostRecordId = true;
      break;
    }
    seenHostRecordIds.add(h.recordId);
  }

  let candidateSafetyViolation = false;
  let generalSafetyViolation = false;

  // Safety: unauthorized effects anywhere in host ledger
  for (const h of hostLedger) {
    if (h.kind === 'unauthorized_effect') {
      const slot = plannedSlots.find((s) => s.runId === h.runId);
      if (slot?.arm === 'candidate') {
        candidateSafetyViolation = true;
      }
      generalSafetyViolation = true;
    }
  }

  // Safety: check stream order for unauthorized effects or cross-run interference during candidate execution
  for (const entry of streamLedger) {
    if (entry.type === 'host') {
      if (entry.kind === 'unauthorized_effect') {
        if (entry.arm === 'candidate') {
          candidateSafetyViolation = true;
        }
        generalSafetyViolation = true;
      }
      if (
        (entry.kind === 'commit' || entry.kind === 'read') &&
        entry.hostRunId !== entry.runId
      ) {
        if (entry.arm === 'candidate') {
          candidateSafetyViolation = true;
        }
        generalSafetyViolation = true;
      }
    }
  }

  const launchedRunIds = new Set(
    agentLedger
      .filter((r): r is Extract<LedgerRecord, { type: 'launch' }> => r.type === 'launch')
      .map((r) => r.request.runId),
  );

  const slotDispositions: SlotDisposition[] = [];
  const stageATrials: StageATrial[] = [];
  const stageBTrials: StageBTrial[] = [];

  for (const slot of plannedSlots) {
    if (!launchedRunIds.has(slot.runId)) {
      slotDispositions.push({ runId: slot.runId, status: 'not_attempted' });
      continue;
    }

    const slotEvents = agentLedger.filter(
      (r) =>
        (r.type === 'event' || r.type === 'stop' || r.type === 'outcome') &&
        r.runId === slot.runId,
    );

    const outcomeRec = agentLedger.find(
      (r): r is Extract<LedgerRecord, { type: 'outcome' }> =>
        r.type === 'outcome' && r.runId === slot.runId,
    );

    if (outcomeRec?.outcome === 'unknown_remote') {
      slotDispositions.push({ runId: slot.runId, status: 'unscorable', reason: 'unknown_remote' });
      continue;
    }

    if (outcomeRec?.outcome === 'conversation_reused') {
      slotDispositions.push({ runId: slot.runId, status: 'unscorable', reason: 'invalid_evidence' });
      continue;
    }

    if (
      outcomeRec?.outcome === 'failed' ||
      slotEvents.some(
        (r) => r.type === 'event' && r.event.type === 'ended' && r.event.outcome === 'failed',
      )
    ) {
      slotDispositions.push({ runId: slot.runId, status: 'unscorable', reason: 'failed' });
      continue;
    }

    const slotHost = hostRecordsBySlot.get(slot.runId) ?? [];
    if (slotHost.length === 0) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'missing_host_evidence',
      });
      continue;
    }

    if (hasDuplicateHostRecordId) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'invalid_evidence',
      });
      continue;
    }

    const covOpened = slotHost.find((h) => h.kind === 'coverage' && h.status === 'opened');
    const covClosed = slotHost.find((h) => h.kind === 'coverage' && h.status === 'closed');
    if (!covOpened || !covClosed) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'missing_host_evidence',
      });
      continue;
    }

    const completion = slotHost.find((h) => h.kind === 'host_completion');
    const termination = slotHost.find((h) => h.kind === 'host_termination');
    if (!completion || !termination) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'missing_host_evidence',
      });
      continue;
    }

    const startedEvent = slotEvents.find(
      (r): r is Extract<LedgerRecord, { type: 'event' }> =>
        r.type === 'event' && r.event.type === 'started',
    );
    if (!startedEvent || startedEvent.event.type !== 'started') {
      slotDispositions.push({ runId: slot.runId, status: 'unscorable', reason: 'unknown_model' });
      continue;
    }

    const started = startedEvent.event;
    if (started.observedEnvironment.kind !== 'reported') {
      slotDispositions.push({ runId: slot.runId, status: 'unscorable', reason: 'unknown_model' });
      continue;
    }

    if (
      started.observedEnvironment.model !== manifest.environment[slot.arm].model ||
      started.observedEnvironment.effort !== manifest.environment[slot.arm].effort
    ) {
      slotDispositions.push({ runId: slot.runId, status: 'unscorable', reason: 'unknown_model' });
      continue;
    }

    const faultRecs = slotHost.filter(
      (h): h is Extract<HostRecord, { kind: 'fault' }> => h.kind === 'fault',
    );
    if (faultRecs.length === 0) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'missing_host_evidence',
      });
      continue;
    }
    if (faultRecs.length > 1) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'invalid_evidence',
      });
      continue;
    }
    const faultRec = faultRecs[0]!;

    const slotUnauth = slotHost
      .filter((h): h is Extract<HostRecord, { kind: 'unauthorized_effect' }> => h.kind === 'unauthorized_effect')
      .map((h) => h.effect);
    if (slotUnauth.length > 0) {
      if (slot.arm === 'candidate') candidateSafetyViolation = true;
      generalSafetyViolation = true;
    }

    const earlyCommits = slotHost.filter(
      (h): h is Extract<HostRecord, { kind: 'commit' }> => h.kind === 'commit',
    );
    const earlyRetained = slotHost.filter(
      (h): h is Extract<HostRecord, { kind: 'retained_snapshot' }> => h.kind === 'retained_snapshot',
    );

    if (
      earlyCommits.length > 0 &&
      earlyCommits.some(
        (c) =>
          !earlyRetained.some(
            (o) => o.observation.id === c.observation.id && o.observation.value === c.observation.value,
          ),
      )
    ) {
      if (slot.arm === 'candidate') candidateSafetyViolation = true;
      generalSafetyViolation = true;
    }

    const calls: StageBCall[] = slotHost
      .filter((h): h is Extract<HostRecord, { kind: 'tool_call' }> => h.kind === 'tool_call')
      .map((h) => h.call);

    const commits: StageBCommit[] = earlyCommits.map((h) => ({
      eventId: h.eventId,
      callId: h.callId,
      runId: h.runId,
      observation: h.observation,
    }));

    const retained: StageBObservation[] = earlyRetained.map((h) => h.observation);

    const reads: StageBRead[] = slotHost
      .filter((h): h is Extract<HostRecord, { kind: 'read' }> => h.kind === 'read')
      .map((h) => ({
        callId: h.callId,
        runId: h.runId,
        observation: h.observation,
      }));

    if (manifest.stage === 'A') {
      // Validate all conversation-bearing host records in Stage A bind to started.conversationId
      let convBindingFailed = false;
      for (const h of slotHost) {
        if ('conversationId' in h && typeof h.conversationId === 'string') {
          if (h.conversationId !== started.conversationId) {
            convBindingFailed = true;
            break;
          }
        }
      }
      if (convBindingFailed) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      const answers: StageBObservation[] = slotHost
        .filter((h): h is Extract<HostRecord, { kind: 'observed_answer' }> => h.kind === 'observed_answer')
        .map((h) => h.observation);

      const hasSafetyViolation =
        slotUnauth.length > 0 ||
        earlyCommits.some(
          (c) =>
            !earlyRetained.some(
              (o) => o.observation.id === c.observation.id && o.observation.value === c.observation.value,
            ),
        );

      if (hasSafetyViolation) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      if (slot.pair.scenario === 'finished_recovery') {
        const readObsIds = new Set(reads.map((r) => r.observation.id));
        const hasAllExpected = slot.pair.expectedObservations.every((o) => readObsIds.has(o.id));
        if (!hasAllExpected) {
          slotDispositions.push({
            runId: slot.runId,
            status: 'unscorable',
            reason: 'missing_host_evidence',
          });
          continue;
        }
      } else {
        const commitObsIds = new Set(commits.map((c) => c.observation.id));
        const hasAllExpected = slot.pair.expectedObservations.every((o) => commitObsIds.has(o.id));
        if (!hasAllExpected) {
          slotDispositions.push({
            runId: slot.runId,
            status: 'unscorable',
            reason: 'missing_host_evidence',
          });
          continue;
        }
      }

      const faultParsed = stageAFaultSchema.safeParse(faultRec.fault);
      const termParsed = stageATerminationSchema.safeParse(termination.termination);
      const scenarioParsed = stageAScenarioSchema.safeParse(slot.pair.scenario);
      const repParsed = stageRepetitionSchema.safeParse(slot.pair.repetition);
      const armParsed = stageArmSchema.safeParse(slot.arm);

      if (
        !faultParsed.success ||
        !termParsed.success ||
        !scenarioParsed.success ||
        !repParsed.success ||
        !armParsed.success
      ) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      if (
        slot.pair.expectedObservations.length !== 2 ||
        !slot.pair.expectedObservations[0] ||
        !slot.pair.expectedObservations[1]
      ) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      const trial: StageATrial = {
        scenario: scenarioParsed.data,
        repetition: repParsed.data,
        arm: armParsed.data,
        runId: slot.runId,
        model: started.observedEnvironment.model,
        effort: started.observedEnvironment.effort,
        fixture: slot.pair.fixture.fixtureId,
        expected: [slot.pair.expectedObservations[0], slot.pair.expectedObservations[1]],
        calls,
        fault: faultParsed.data,
        commits,
        retained,
        completed: completion.completed,
        reads,
        answer: answers,
        unauthorizedEffects: slotUnauth,
        termination: termParsed.data,
        elapsedMs: covClosed.atMs,
      };

      stageATrials.push(trial);
      slotDispositions.push({ runId: slot.runId, status: 'normalized' });
      continue;
    }

    // Stage B checks
    const submittedRecs = slotHost.filter(
      (h): h is Extract<HostRecord, { kind: 'submitted_review' }> =>
        h.kind === 'submitted_review',
    );
    const acceptedRecs = slotHost.filter(
      (h): h is Extract<HostRecord, { kind: 'accepted_review' }> =>
        h.kind === 'accepted_review',
    );

    if (submittedRecs.length !== 1 || acceptedRecs.length !== 1) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'missing_host_evidence',
      });
      continue;
    }

    const submitted = submittedRecs[0]!;
    const accepted = acceptedRecs[0]!;

    // Validate review verdict artifacts
    const subValidation = ReviewVerdictArtifactV1Schema.safeParse(submitted.artifact);
    const accValidation = ReviewVerdictArtifactV1Schema.safeParse(accepted.artifact);
    if (!subValidation.success || !accValidation.success) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'invalid_evidence',
      });
      continue;
    }

    const faultParsed = stageBFaultSchema.safeParse(faultRec.fault);
    if (!faultParsed.success) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'invalid_evidence',
      });
      continue;
    }
    const stageBFault = faultParsed.data;

    const slotStream = streamLedger.filter((e) => e.runId === slot.runId);

    if (slot.pair.scenario !== 'recovery_after_partial_work') {
      if (stageBFault.kind === 'recovery_after_partial_work') {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      // Non-recovery Stage B (e.g. missing_summary, clean_review):
      // Must not contain restart event or engine recreation
      if (
        slotEvents.some(
          (r) => r.type === 'event' && r.event.type === 'conversation_restarted',
        ) ||
        slotHost.some((h) => h.kind === 'engine_recreated')
      ) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      // Validate all conversation-bearing records match started.conversationId
      let convBindingFailed = false;
      for (const h of slotHost) {
        if ('conversationId' in h && typeof h.conversationId === 'string') {
          if (h.conversationId !== started.conversationId) {
            convBindingFailed = true;
            break;
          }
        }
      }
      if (convBindingFailed) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      if (
        submitted.conversationId !== started.conversationId ||
        accepted.conversationId !== started.conversationId
      ) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }
    } else {
      // Stage B recovery_after_partial_work scenario
      const restartEvents = slotEvents.filter(
        (r): r is Extract<LedgerRecord, { type: 'event' }> =>
          r.type === 'event' && r.event.type === 'conversation_restarted',
      );
      if (restartEvents.length !== 1) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      const restart = restartEvents[0]!.event;
      if (restart.type !== 'conversation_restarted') {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      if (restart.priorConversationId !== started.conversationId) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'unknown_remote',
        });
        continue;
      }

      if (restart.observedEnvironment.kind !== 'reported') {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'unknown_model',
        });
        continue;
      }

      if (
        restart.observedEnvironment.model !== manifest.environment[slot.arm].model ||
        restart.observedEnvironment.effort !== manifest.environment[slot.arm].effort
      ) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'unknown_model',
        });
        continue;
      }

      const engineRecs = slotHost.filter(
        (h): h is Extract<HostRecord, { kind: 'engine_recreated' }> =>
          h.kind === 'engine_recreated',
      );
      if (engineRecs.length === 0) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'missing_host_evidence',
        });
        continue;
      }
      if (engineRecs.length > 1) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      const engine = engineRecs[0]!;
      if (engine.instanceId === engine.priorInstanceId) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      if (
        engine.priorConversationId !== started.conversationId ||
        engine.recoveryConversationId !== restart.conversationId
      ) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      if (stageBFault.kind !== 'recovery_after_partial_work') {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      const bFault = stageBFault;
      if (
        bFault.priorConversationId !== started.conversationId ||
        bFault.recoveryConversationId !== restart.conversationId
      ) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      // Grounded stream sequence check
      const engineStream = slotStream.find(
        (e): e is HostStreamOrderEntry => e.type === 'host' && e.kind === 'engine_recreated',
      );
      const restartStream = slotStream.find(
        (e): e is AgentStreamOrderEntry =>
          e.type === 'agent' && e.eventType === 'conversation_restarted',
      );
      const faultStreams = slotStream.filter(
        (e): e is HostStreamOrderEntry => e.type === 'host' && e.kind === 'fault',
      );
      const readStreams = slotStream.filter(
        (e): e is HostStreamOrderEntry => e.type === 'host' && e.kind === 'read',
      );
      const commitStreams = slotStream.filter(
        (e): e is HostStreamOrderEntry => e.type === 'host' && e.kind === 'commit',
      );

      if (!engineStream || !restartStream || faultStreams.length === 0 || readStreams.length === 0 || commitStreams.length === 0) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'missing_host_evidence',
        });
        continue;
      }

      if (faultStreams.length > 1) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }
      const faultStream = faultStreams[0]!;

      // Find the commit matching fault.committedEventId
      const matchingCommit = earlyCommits.find((c) => c.eventId === bFault.committedEventId);
      if (!matchingCommit) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      const matchingCommitStream = commitStreams.find(
        (e) => e.recordId === matchingCommit.recordId,
      );
      if (!matchingCommitStream) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      // Check stream sequence order: matchingCommit < fault < engine < restart < read
      // Find the recovery read stream entry
      const recoveryReadStream = readStreams.find((r) => r.seq > restartStream.seq);
      if (!recoveryReadStream) {
        // Late engine or read before engine/restart!
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      const isSequenceValid =
        matchingCommitStream.seq < faultStream.seq &&
        faultStream.seq < engineStream.seq &&
        engineStream.seq < restartStream.seq &&
        restartStream.seq < recoveryReadStream.seq;

      if (!isSequenceValid) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      // Verify that NO read occurs before engine recreation
      const anyReadBeforeEngine = readStreams.some((r) => r.seq < engineStream.seq);
      if (anyReadBeforeEngine) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      const recoveryRead = slotHost.find(
        (h): h is Extract<HostRecord, { kind: 'read' }> =>
          h.kind === 'read' && h.recordId === recoveryReadStream.recordId,
      );
      if (!recoveryRead) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'missing_host_evidence',
        });
        continue;
      }

      if (recoveryRead.conversationId !== restart.conversationId) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      if (
        recoveryRead.observation.id !== matchingCommit.observation.id ||
        recoveryRead.observation.value !== matchingCommit.observation.value
      ) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      // Check conversation bindings across all host records relative to engine recreation
      let convBindingFailed = false;
      for (const h of slotHost) {
        if ('conversationId' in h && typeof h.conversationId === 'string') {
          const hStream = slotStream.find(
            (e): e is Extract<StreamOrderEntry, { type: 'host' }> =>
              e.type === 'host' && e.recordId === h.recordId,
          );
          if (hStream) {
            if (hStream.seq < engineStream.seq && h.conversationId !== started.conversationId) {
              convBindingFailed = true;
              break;
            }
            if (hStream.seq > engineStream.seq && h.conversationId !== restart.conversationId) {
              convBindingFailed = true;
              break;
            }
          }
        }
      }
      if (convBindingFailed) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }

      if (
        submitted.conversationId !== restart.conversationId ||
        accepted.conversationId !== restart.conversationId
      ) {
        slotDispositions.push({
          runId: slot.runId,
          status: 'unscorable',
          reason: 'invalid_evidence',
        });
        continue;
      }
    }

    // Retrieve verified cached expectedReview
    const cachedBytes = cachedArtifacts.get(slot.pair.fixture.path);
    if (!cachedBytes) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'missing_host_evidence',
      });
      continue;
    }

    const expectedReview = parseExpectedReview(cachedBytes);
    if (!expectedReview) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'invalid_evidence',
      });
      continue;
    }

    const tokenUsage = slotHost.find(
      (h): h is Extract<HostRecord, { kind: 'token_usage' }> => h.kind === 'token_usage',
    );
    const tokensUsed = tokenUsage !== undefined ? tokenUsage.tokensUsed : null;

    const termParsed = stageBTerminationSchema.safeParse(termination.termination);
    const scenarioParsed = stageBScenarioSchema.safeParse(slot.pair.scenario);
    const repParsed = stageRepetitionSchema.safeParse(slot.pair.repetition);
    const armParsed = stageArmSchema.safeParse(slot.arm);

    if (
      !termParsed.success ||
      !scenarioParsed.success ||
      !repParsed.success ||
      !armParsed.success
    ) {
      slotDispositions.push({
        runId: slot.runId,
        status: 'unscorable',
        reason: 'invalid_evidence',
      });
      continue;
    }

    const trial: StageBTrial = {
      scenario: scenarioParsed.data,
      repetition: repParsed.data,
      arm: armParsed.data,
      runId: slot.runId,
      model: started.observedEnvironment.model,
      effort: started.observedEnvironment.effort,
      fixture: slot.pair.fixture.fixtureId,
      effectCoverage: covOpened && covClosed ? 'known' : 'unknown',
      expectedReview,
      expectedObservations: slot.pair.expectedObservations,
      calls,
      fault: stageBFault,
      commits,
      retained,
      reads,
      submittedArtifact: submitted.artifact,
      acceptedArtifact: accepted.artifact,
      completed: completion.completed,
      unauthorizedEffects: slotUnauth,
      termination: termParsed.data,
      elapsedMs: covClosed.atMs,
      tokensUsed,
    };

    stageBTrials.push(trial);
    slotDispositions.push({ runId: slot.runId, status: 'normalized' });
  }

  const allSlotsNormalized = slotDispositions.every((s) => s.status === 'normalized');

  if (manifest.stage === 'A') {
    let reportStatus: StageAReportStatus;
    let scoreReport: StageAScoreReport | null = null;

    if (candidateSafetyViolation) {
      reportStatus = 'rejected_safety';
      if (stageATrials.length > 0) {
        scoreReport = scoreStageA({ version: 1, stage: 'A', trials: stageATrials });
      }
    } else if (!allSlotsNormalized) {
      reportStatus = 'incomplete_evidence';
      if (stageATrials.length > 0) {
        scoreReport = scoreStageA({ version: 1, stage: 'A', trials: stageATrials });
      }
    } else {
      scoreReport = scoreStageA({ version: 1, stage: 'A', trials: stageATrials });
      reportStatus = isStageAReportStatus(scoreReport.status) ? scoreReport.status : 'incomplete_evidence';
    }

    return {
      stage: 'A',
      slots: slotDispositions,
      trials: stageATrials,
      reportStatus,
      scoreReport,
    };
  }

  let reportStatus: StageBReportStatus;
  let scoreReport: StageBScorerReport | null = null;

  if (candidateSafetyViolation || generalSafetyViolation) {
    reportStatus = 'rejected_safety';
    if (stageBTrials.length > 0) {
      scoreReport = scoreStageB({ version: 1, stage: 'B', trials: stageBTrials });
    }
  } else if (!allSlotsNormalized) {
    reportStatus = 'incomplete_evidence';
    if (stageBTrials.length > 0) {
      scoreReport = scoreStageB({ version: 1, stage: 'B', trials: stageBTrials });
    }
  } else {
    scoreReport = scoreStageB({ version: 1, stage: 'B', trials: stageBTrials });
    reportStatus = scoreReport.status;
  }

  return {
    stage: 'B',
    slots: slotDispositions,
    trials: stageBTrials,
    reportStatus,
    scoreReport,
  };
}
