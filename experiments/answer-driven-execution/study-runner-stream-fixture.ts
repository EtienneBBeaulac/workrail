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

import { sampleReview } from './study-runner-fixture.js';
export async function* makePositiveStream(
  req: TrialRequest,
  options?: { readonly assertPersistedDir?: string }
): AsyncGenerator<ExtendedTransportEvent> {
  const { runId, scenario } = req;
  const isB = scenario === 'missing_summary' || scenario === 'recovery_after_partial_work';
  const obs = req.expectedObservations;
  let conversationId = scenario === 'recovery_after_partial_work' ? `prior-conv-${runId}` : `c-${runId}`;

  async function* yieldHost(record: HostRecord): AsyncGenerator<ExtendedTransportEvent> {
    yield { type: 'host', record };
    if (options?.assertPersistedDir) {
      const p = join(options.assertPersistedDir, 'host-observations.ndjson');
      const lines = (await readFile(p, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(lines).toContainEqual(record);
    }
  }

  yield* yieldHost({
    recordId: `rec-${runId}-cov1`,
    runId,
    atMs: 10,
    source: 'host',
    rawProvenance: 'simulated-host',
    kind: 'coverage',
    status: 'opened',
  });

  yield {
    type: 'agent',
    event: {
      type: 'started',
      conversationId,
      observedEnvironment: {
        kind: 'reported',
        model: req.requestedEnvironment.model,
        effort: req.requestedEnvironment.effort,
      },
    },
  };



  if (!isB) {
    if (scenario === 'finished_recovery') {
      yield* yieldHost({
        recordId: `rec-${runId}-c1`,
        runId,
        atMs: 30,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: 'c1', atMs: 30, operation: 'read', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-r1`,
        runId,
        atMs: 35,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'read',
        conversationId,
        callId: 'c1',
        observation: obs[0]!,
      });
      yield* yieldHost({
        recordId: `rec-${runId}-c2`,
        runId,
        atMs: 60,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: 'c2', atMs: 60, operation: 'read', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-r2`,
        runId,
        atMs: 65,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'read',
        conversationId,
        callId: 'c2',
        observation: obs[1]!,
      });
      yield* yieldHost({
        recordId: `rec-${runId}-flt`,
        runId,
        atMs: 150,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'fault',
        fault: { kind: 'none' },
      });
    } else if (scenario === 'malformed') {
      yield* yieldHost({
        recordId: `rec-${runId}-c0`,
        runId,
        atMs: 30,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: 'c0', atMs: 30, operation: 'write', outcome: 'injected_fault' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-flt`,
        runId,
        atMs: 40,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'fault',
        fault: { kind: 'malformed', callId: 'c0', noticeAtMs: 40 },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-c1`,
        runId,
        atMs: 60,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: 'c1', atMs: 60, operation: 'write', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-m1`,
        runId,
        atMs: 65,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'commit',
        conversationId,
        eventId: `e1-${runId}`,
        callId: 'c1',
        observation: obs[0]!,
      });
      yield* yieldHost({
        recordId: `rec-${runId}-c2`,
        runId,
        atMs: 90,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: 'c2', atMs: 90, operation: 'write', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-m2`,
        runId,
        atMs: 95,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'commit',
        conversationId,
        eventId: `e2-${runId}`,
        callId: 'c2',
        observation: obs[1]!,
      });
    } else if (scenario === 'lost_response') {
      yield* yieldHost({
        recordId: `rec-${runId}-c1`,
        runId,
        atMs: 30,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: 'c1', atMs: 30, operation: 'write', outcome: 'injected_fault' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-m1`,
        runId,
        atMs: 35,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'commit',
        conversationId,
        eventId: `e1-${runId}`,
        callId: 'c1',
        observation: obs[0]!
      });
      yield* yieldHost({
        recordId: `rec-${runId}-flt`,
        runId,
        atMs: 40,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'fault',
        fault: { kind: 'lost_response', callId: 'c1', noticeAtMs: 40 },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-c2`,
        runId,
        atMs: 70,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: 'c2', atMs: 70, operation: 'write', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-m2`,
        runId,
        atMs: 75,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'commit',
        conversationId,
        eventId: `e2-${runId}`,
        callId: 'c2',
        observation: obs[1]!,
      });
    } else {
      yield* yieldHost({
        recordId: `rec-${runId}-flt`,
        runId,
        atMs: 20,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'fault',
        fault: { kind: 'none' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-c1`,
        runId,
        atMs: 40,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: 'c1', atMs: 40, operation: 'write', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-m1`,
        runId,
        atMs: 45,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'commit',
        conversationId,
        eventId: `e1-${runId}`,
        callId: 'c1',
        observation: obs[0]!,
      });
      yield* yieldHost({
        recordId: `rec-${runId}-c2`,
        runId,
        atMs: 70,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: 'c2', atMs: 70, operation: 'write', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-m2`,
        runId,
        atMs: 75,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'commit',
        conversationId,
        eventId: `e2-${runId}`,
        callId: 'c2',
        observation: obs[1]!,
      });
    }
    yield* yieldHost({
      recordId: `rec-${runId}-ret1`,
      runId,
      atMs: 180,
      source: 'host',
      rawProvenance: 'simulated-host',
      kind: 'retained_snapshot',
      observation: obs[0]!,
    });
    yield* yieldHost({
      recordId: `rec-${runId}-ret2`,
      runId,
      atMs: 185,
      source: 'host',
      rawProvenance: 'simulated-host',
      kind: 'retained_snapshot',
      observation: obs[1]!,
    });
    yield* yieldHost({
      recordId: `rec-${runId}-ans1`,
      runId,
      atMs: 190,
      source: 'host',
      rawProvenance: 'simulated-host',
      kind: 'observed_answer',
      observation: obs[0]!,
    });
    yield* yieldHost({
      recordId: `rec-${runId}-ans2`,
      runId,
      atMs: 195,
      source: 'host',
      rawProvenance: 'simulated-host',
      kind: 'observed_answer',
      observation: obs[1]!,
    });
  } else {
    const callId1 = `c1-${runId}`;
    const callId2 = `c2-${runId}`;
    if (scenario === 'missing_summary') {
      yield* yieldHost({
        recordId: `rec-${runId}-c1`,
        runId,
        atMs: 30,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: callId1, atMs: 30, operation: 'write', outcome: 'injected_fault' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-flt`,
        runId,
        atMs: 40,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'fault',
        fault: { kind: 'missing_summary', callId: callId1, noticeAtMs: 40 },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-c2`,
        runId,
        atMs: 70,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: callId2, atMs: 70, operation: 'write', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-m1`,
        runId,
        atMs: 75,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'commit',
        conversationId,
        eventId: `ev1-${runId}`,
        callId: callId2,
        observation: obs[0]!,
      });
      yield* yieldHost({
        recordId: `rec-${runId}-m2`,
        runId,
        atMs: 80,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'commit',
        conversationId,
        eventId: `ev2-${runId}`,
        callId: callId2,
        observation: obs[1]!,
      });
    } else {
      yield* yieldHost({
        recordId: `rec-${runId}-c1`,
        runId,
        atMs: 30,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: callId1, atMs: 30, operation: 'write', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-m1`,
        runId,
        atMs: 35,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'commit',
        conversationId,
        eventId: `ev1-${runId}`,
        callId: callId1,
        observation: obs[0]!,
      });
      yield* yieldHost({
        recordId: `rec-${runId}-flt`,
        runId,
        atMs: 40,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'fault',
        fault: {
          kind: 'recovery_after_partial_work',
          callId: callId1,
          noticeAtMs: 40,
          committedEventId: `ev1-${runId}`,
          priorConversationId: `prior-conv-${runId}`,
          recoveryConversationId: `recovery-conv-${runId}`,
        },
      });
      yield* yieldHost({recordId:`rec-${runId}-engine`,runId,atMs:45,source:'host',rawProvenance:'simulated engine shutdown/recreation',kind:'engine_recreated',priorInstanceId:`engine-before-${runId}`,instanceId:`engine-after-${runId}`,priorConversationId:conversationId,recoveryConversationId:`recovery-conv-${runId}`});
      const priorConversationId = conversationId;
      conversationId = `recovery-conv-${runId}`;
      yield {type:'agent',event:{type:'conversation_restarted',priorConversationId,conversationId,observedEnvironment:{kind:'reported',model:req.requestedEnvironment.model,effort:req.requestedEnvironment.effort}}};
      yield* yieldHost({
        recordId: `rec-${runId}-read-call`,
        runId,
        atMs: 50,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: `read-${runId}`, atMs: 50, operation: 'read', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-read-rec`,
        runId,
        atMs: 55,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'read',
        conversationId,
        callId: `read-${runId}`,
        observation: obs[0]!,
      });
      yield* yieldHost({
        recordId: `rec-${runId}-c2`,
        runId,
        atMs: 70,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'tool_call',
        conversationId,
        call: { id: callId2, atMs: 70, operation: 'write', outcome: 'success' },
      });
      yield* yieldHost({
        recordId: `rec-${runId}-m2`,
        runId,
        atMs: 75,
        source: 'host',
        rawProvenance: 'simulated-host',
        kind: 'commit',
        conversationId,
        eventId: `ev2-${runId}`,
        callId: callId2,
        observation: obs[1]!,
      });
    }
    yield* yieldHost({
      recordId: `rec-${runId}-ret1`,
      runId,
      atMs: 85,
      source: 'host',
      rawProvenance: 'simulated-host',
      kind: 'retained_snapshot',
      observation: obs[0]!,
    });
    yield* yieldHost({
      recordId: `rec-${runId}-ret2`,
      runId,
      atMs: 90,
      source: 'host',
      rawProvenance: 'simulated-host',
      kind: 'retained_snapshot',
      observation: obs[1]!,
    });
    yield* yieldHost({
      recordId: `rec-${runId}-sub-rev`,
      runId,
      atMs: 95,
      source: 'host',
      rawProvenance: 'simulated-host',
      kind: 'submitted_review',
        conversationId,
      artifact: sampleReview,
    });
    yield* yieldHost({
      recordId: `rec-${runId}-acc-rev`,
      runId,
      atMs: 100,
      source: 'host',
      rawProvenance: 'simulated-host',
      kind: 'accepted_review',
        conversationId,
      artifact: sampleReview,
    });
  }

  yield* yieldHost({
    recordId: `rec-${runId}-cmp`,
    runId,
    atMs: 200,
    source: 'host',
    rawProvenance: 'simulated-host',
    kind: 'host_completion',
    completed: true,
  });
  yield* yieldHost({
    recordId: `rec-${runId}-trm`,
    runId,
    atMs: 205,
    source: 'host',
    rawProvenance: 'simulated-host',
    kind: 'host_termination',
    termination: 'finished',
  });
  yield* yieldHost({
    recordId: `rec-${runId}-tok`,
    runId,
    atMs: 210,
    source: 'host',
    rawProvenance: 'simulated-host',
    kind: 'token_usage',
    tokensUsed: 150,
  });
  yield* yieldHost({
    recordId: `rec-${runId}-cov2`,
    runId,
    atMs: 215,
    source: 'host',
    rawProvenance: 'simulated-host',
    kind: 'coverage',
    status: 'closed',
  });
  yield {
    type: 'agent',
    event: {
      type: 'ended',
      outcome: 'completed',
      raw: 'agent-done',
    },
  };
}

export function buildExpectedStageATrials(manifest: Extract<ValidatedStudyManifest, {stage: 'A'}>): StageATrial[] {
  const trials: StageATrial[] = [];
  for (const pair of manifest.pairs) {
    for (const arm of pair.armOrder) {
      const runId = pair[arm].runId;
      const obs = pair.expectedObservations;
      const scenario = pair.scenario;
      let calls: StageATrial['calls'];
      let fault: StageATrial['fault'];
      let commits: StageATrial['commits'];
      let reads: StageATrial['reads'];

      if (scenario === 'finished_recovery') {
        calls = [
          { id: 'c1', atMs: 30, operation: 'read', outcome: 'success' },
          { id: 'c2', atMs: 60, operation: 'read', outcome: 'success' },
        ];
        fault = { kind: 'none' };
        commits = [];
        reads = [
          { callId: 'c1', runId, observation: obs[0]! },
          { callId: 'c2', runId, observation: obs[1]! },
        ];
      } else if (scenario === 'malformed') {
        calls = [
          { id: 'c0', atMs: 30, operation: 'write', outcome: 'injected_fault' },
          { id: 'c1', atMs: 60, operation: 'write', outcome: 'success' },
          { id: 'c2', atMs: 90, operation: 'write', outcome: 'success' },
        ];
        fault = { kind: 'malformed', callId: 'c0', noticeAtMs: 40 };
        commits = [
          { eventId: `e1-${runId}`, callId: 'c1', runId, observation: obs[0]! },
          { eventId: `e2-${runId}`, callId: 'c2', runId, observation: obs[1]! },
        ];
        reads = [];
      } else if (scenario === 'lost_response') {
        calls = [
          { id: 'c1', atMs: 30, operation: 'write', outcome: 'injected_fault' },
          { id: 'c2', atMs: 70, operation: 'write', outcome: 'success' },
        ];
        fault = { kind: 'lost_response', callId: 'c1', noticeAtMs: 40 };
        commits = [
          { eventId: `e1-${runId}`, callId: 'c1', runId, observation: obs[0]! },
          { eventId: `e2-${runId}`, callId: 'c2', runId, observation: obs[1]! },
        ];
        reads = [];
      } else {
        calls = [
          { id: 'c1', atMs: 40, operation: 'write', outcome: 'success' },
          { id: 'c2', atMs: 70, operation: 'write', outcome: 'success' },
        ];
        fault = { kind: 'none' };
        commits = [
          { eventId: `e1-${runId}`, callId: 'c1', runId, observation: obs[0]! },
          { eventId: `e2-${runId}`, callId: 'c2', runId, observation: obs[1]! },
        ];
        reads = [];
      }

      trials.push({
        scenario,
        repetition: pair.repetition,
        arm,
        runId,
        model: manifest.environment[arm].model,
        effort: manifest.environment[arm].effort,
        fixture: pair.fixture.fixtureId,
        expected: [obs[0]!, obs[1]!],
        calls,
        fault,
        commits,
        retained: [obs[0]!, obs[1]!],
        completed: true,
        reads,
        answer: [obs[0]!, obs[1]!],
        unauthorizedEffects: [],
        termination: 'finished',
        elapsedMs: 215,
      });
    }
  }
  return trials;
}
