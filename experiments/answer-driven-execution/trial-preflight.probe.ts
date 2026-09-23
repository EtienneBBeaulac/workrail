// trial-preflight.probe.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { ValidatedStudyManifest } from './study-manifest.mjs';
import { createUnverifiedStudyFixture } from './study-manifest-file-fixture.js';
import type { Arm, AgentTransport, AgentEvent, TrialRequest } from './trial-executor-contract.js';
import type {
  BuildObservationRequest,
  LoadedWorkflowIdentity,
  ObservedBuildIdentity,
  ObservedControl,
  ExecutedPreflight,
  executePreflightedStudy,
  PreflightExecutionReceipt,
  PreflightExecutionRequest,
  PreflightHostEffects,
  PreflightedExecutionResult,
} from './trial-preflight-contract.js';

async function getExecute(): Promise<typeof executePreflightedStudy> {
  const p = path.resolve(process.cwd(), 'experiments/answer-driven-execution/trial-preflight.mts');
  if (!existsSync(p)) throw new Error('CANDIDATE_UNAVAILABLE: trial preflight absent');
  const mod = await import(/* @vite-ignore */ p) as { executePreflightedStudy?: typeof executePreflightedStudy };
  if (typeof mod.executePreflightedStudy !== 'function') throw new Error('CANDIDATE_UNAVAILABLE: export absent');
  return mod.executePreflightedStudy;
}

function createFakeTransport() {
  const calls: TrialRequest[] = [];
  const transport: AgentTransport = {
    async *startFresh(request: TrialRequest): AsyncIterable<AgentEvent> {
      calls.push(request);
      yield { type: 'started', conversationId: `conv-${request.runId}`, observedEnvironment: { kind: 'reported', model: 'fake', effort: 'high' } };
      yield { type: 'ended', outcome: 'completed', raw: '{}' };
    },
  };
  return { transport, calls };
}

function getStandardControls(kind: PreflightExecutionRequest['kind']): ObservedControl[] {
  if (kind === 'observation_checker') {
    return [
      { checkId: 'checker_intact', outcome: 'accepted', raw: 'ok' },
      { checkId: 'checker_removed', outcome: 'rejected', raw: 'ok' },
      { checkId: 'checker_duplicate', outcome: 'rejected', raw: 'ok' },
      { checkId: 'checker_artifact_mismatch', outcome: 'rejected', raw: 'ok' },
      { checkId: 'checker_wrong_run', outcome: 'rejected', raw: 'ok' },
      { checkId: 'checker_unmatched_fault', outcome: 'rejected', raw: 'ok' },
    ];
  }
  if (kind === 'timeout_enforcement') {
    return [
      { checkId: 'timeout_abort', outcome: 'completed', raw: 'ok' },
      { checkId: 'timeout_cleanup', outcome: 'completed', raw: 'ok' },
    ];
  }
  if (kind === 'fault_equivalence') {
    return [
      { checkId: 'fault_baseline', outcome: 'completed', raw: 'ok' },
      { checkId: 'fault_candidate', outcome: 'completed', raw: 'ok' },
    ];
  }
  return [
    { checkId: 'review_baseline', outcome: 'completed', raw: 'ok' },
    { checkId: 'review_candidate', outcome: 'completed', raw: 'ok' },
  ];
}

function getProofMap(manifest: ValidatedStudyManifest): Map<string, string> {
  const map = new Map<string, string>();
  map.set(manifest.preflights.observationCheckerProof.proofId, manifest.preflights.observationCheckerProof.sha256);
  map.set(manifest.preflights.timeoutEnforcementProof.proofId, manifest.preflights.timeoutEnforcementProof.sha256);
  for (const f of manifest.preflights.faultEquivalenceProofs) map.set(f.proofId, f.sha256);
  if (manifest.stage === 'B' && 'stageBReviewObligationsProof' in manifest.preflights) {
    map.set(manifest.preflights.stageBReviewObligationsProof.proofId, manifest.preflights.stageBReviewObligationsProof.sha256);
  }
  return map;
}

function goodReceipt(req: PreflightExecutionRequest, manifest: ValidatedStudyManifest): ExecutedPreflight {
  const common = { status: 'executed' as const, invocationId: req.invocationId,
    proofId: req.proofId, artifactPath: req.targetArtifactPath,
    artifactSha256: getProofMap(manifest).get(req.proofId)!,
    controls: getStandardControls(req.kind), rawTrace: `trace-${req.proofId}` };
  const observations = { baseline: [{ id: 'obs-1', value: 'val-1' }], candidate: [{ id: 'obs-1', value: 'val-1' }] };
  if (req.kind === 'fault_equivalence') return { ...common, kind: req.kind, scenario: req.scenario, observations };
  if (req.kind === 'review_obligations') return { ...common, kind: req.kind, observations };
  return { ...common, kind: req.kind };
}
function createEffects(manifest: ValidatedStudyManifest, mutation = '') {
  const buildRequests: BuildObservationRequest[] = [];
  const preflightRequests: PreflightExecutionRequest[] = [];
  const effects: PreflightHostEffects = {
    resolveCanonicalPath: fs.realpath,
    observeLoadedBuild: async (req, signal) => {
      buildRequests.push(req);
      const rawTrace = `build-${req.arm}-trace`;
      if (mutation === 'missing build') return { kind: 'unknown', ...req, reason: 'missing', rawTrace };
      if (mutation === 'unknown workflow') {
        return {
          kind: 'observed',
          ...req,
          requestId: req.requestId,
          identity: {
            commit: manifest.git.commit,
            adapterVersion: manifest.executables[req.arm].adapterVersion,
            executableSha256: manifest.executables[req.arm].sha256,
          },
          workflow: { kind: 'unknown', reason: 'no loaded workflow observed' },
          rawTrace,
        };
      }
      const expectedWorkflow = manifest.workflows[req.arm];
      const observedWorkflow = mutation === 'wrong workflow ID'
        ? { workflowId: 'wrong-workflow-id', sha256: expectedWorkflow.sha256 }
        : mutation === 'wrong workflow sha'
        ? { workflowId: expectedWorkflow.workflowId, sha256: 'wrong-workflow-sha' }
        : { workflowId: expectedWorkflow.workflowId, sha256: expectedWorkflow.sha256 };
      return {
        kind: 'observed',
        ...req,
        requestId: mutation === 'wrong build request ID' ? 'wrong' : req.requestId,
        identity: {
          commit: mutation === 'wrong source commit' ? '0'.repeat(40) : manifest.git.commit,
          adapterVersion: mutation === 'wrong adapter version' ? 'wrong' : manifest.executables[req.arm].adapterVersion,
          executableSha256: mutation === 'mismatched sha' ? 'bad' : manifest.executables[req.arm].sha256,
        },
        workflow: { kind: 'observed', identity: observedWorkflow },
        rawTrace,
      };
    },
    executePreflight: async (req, signal) => {
      preflightRequests.push(req);
      const good = goodReceipt(req, manifest);
      switch (mutation) {
        case 'labels-only producer unavailable': throw new Error('producer offline');
        case 'failed producer': return { status: 'failed', invocationId: req.invocationId, proofId: req.proofId, failureReason: 'failed', rawTrace: good.rawTrace };
        case 'wrong invocation ID': return { ...good, invocationId: 'wrong' };
        case 'wrong proof ID': return { ...good, proofId: 'wrong' };
        case 'wrong artifact path': return { ...good, artifactPath: 'wrong' };
        case 'wrong artifact hash': return { ...good, artifactSha256: 'wrong' };
        case 'incomplete controls': return { ...good, controls: good.controls.slice(1) };
        case 'duplicate controls': return { ...good, controls: [...good.controls, good.controls[0]] };
        case 'wrong verdict': return { ...good, controls: good.controls.map(c => ({ ...c, outcome: c.outcome === 'rejected' ? 'accepted' : 'rejected' })) };
        case 'mismatched observations':
          if (good.kind === 'fault_equivalence' || good.kind === 'review_obligations') return { ...good, observations: { ...good.observations, candidate: [{ id: 'obs-1', value: 'drift' }] } };
      }
      return good;
    },
  };
  return { buildRequests, preflightRequests, effects };
}

describe('trial-preflight probe boundary', () => {
  it.each([
    { stage: 'A' as const, expectedTrials: 40 },
    { stage: 'B' as const, expectedTrials: 20 },
  ])('positive stage $stage executes preflights and builds before dispatching $expectedTrials trials', async ({ stage, expectedTrials }) => {
    const execute = await getExecute();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `preflight-${stage}-`));
    try {
      const { manifest } = await createUnverifiedStudyFixture(tmpDir, stage);
      const { transport, calls } = createFakeTransport();
      const tracker = createEffects(manifest);

      let firstDispatchBuildCount = 0;
      let firstDispatchPreflightCount = 0;
      const originalStart = transport.startFresh;
      transport.startFresh = async function* (req, signal) {
        if (calls.length === 0) {
          firstDispatchBuildCount = tracker.buildRequests.length;
          firstDispatchPreflightCount = tracker.preflightRequests.length;
        }
        yield* originalStart(req, signal);
      };

      const expectedProofIds = [
        manifest.preflights.observationCheckerProof.proofId,
        manifest.preflights.timeoutEnforcementProof.proofId,
        ...manifest.preflights.faultEquivalenceProofs.map((f) => f.proofId),
        ...(stage === 'B' && 'stageBReviewObligationsProof' in manifest.preflights
          ? [manifest.preflights.stageBReviewObligationsProof.proofId]
          : []),
      ];

      const res = await execute(manifest, path.join(tmpDir, 'out'), transport, tracker.effects, new AbortController().signal);
      expect(res.status).toBe('admitted');
      expect(res.trialAuthorization).toBe(false);
      expect(res.scope).toBe('orchestration_only');

      expect(firstDispatchBuildCount).toBe(2);
      expect(firstDispatchPreflightCount).toBe(expectedProofIds.length);
      expect(tracker.buildRequests.map((b) => b.arm).sort()).toEqual(['baseline', 'candidate']);
      expect(tracker.preflightRequests.map(p => ({ kind: p.kind, proofId: p.proofId, path: p.targetArtifactPath, scenario: p.kind === 'fault_equivalence' ? p.scenario : undefined }))).toEqual([
        { kind: 'observation_checker', proofId: manifest.preflights.observationCheckerProof.proofId, path: manifest.preflights.observationCheckerProof.path },
        { kind: 'timeout_enforcement', proofId: manifest.preflights.timeoutEnforcementProof.proofId, path: manifest.preflights.timeoutEnforcementProof.path },
        ...manifest.preflights.faultEquivalenceProofs.map(f => ({ kind: 'fault_equivalence', proofId: f.proofId, path: f.path, scenario: f.scenario })),
        ...(manifest.stage === 'B' ? [{ kind: 'review_obligations', proofId: manifest.preflights.stageBReviewObligationsProof.proofId, path: manifest.preflights.stageBReviewObligationsProof.path }] : []),
      ]);
      const ids = [...tracker.buildRequests.map(r => r.requestId), ...tracker.preflightRequests.map(r => r.invocationId)];
      expect(ids.every(id => id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);

      const expectedRunIds = manifest.pairs.flatMap(p => p.armOrder.map(arm => p[arm].runId));
      expect(calls.map((c) => c.runId)).toEqual(expectedRunIds);
      if (res.status === 'admitted') {
        expect(res.trialExecution.status).toBe('finished');
        expect(res.admissionReceipt.baselineWorkflow).toEqual({ workflowId: manifest.workflows.baseline.workflowId, sha256: manifest.workflows.baseline.sha256 });
        expect(res.admissionReceipt.candidateWorkflow).toEqual({ workflowId: manifest.workflows.candidate.workflowId, sha256: manifest.workflows.candidate.sha256 });
        expect(res.trialExecution.attempted).toBe(expectedTrials);
        const raw = res.retainedTraces.map(t => t.raw);
        expect(raw).toEqual(expect.arrayContaining(['build-baseline-trace', 'build-candidate-trace', ...expectedProofIds.map(id => `trace-${id}`)]));
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects workspace symlink alias across arms with real symlink', async () => {
    const execute = await getExecute();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-symlink-'));
    try {
      const { manifest } = await createUnverifiedStudyFixture(tmpDir, 'A');
      const pair = manifest.pairs[0];
      await fs.rm(pair.candidate.workspacePath, { recursive: true, force: true });
      await fs.symlink(pair.baseline.workspacePath, pair.candidate.workspacePath);

      const { transport, calls } = createFakeTransport();
      const tracker = createEffects(manifest);
      const res = await execute(manifest, path.join(tmpDir, 'out'), transport, tracker.effects, new AbortController().signal);

      expect(res.status).toBe('rejected');
      expect(res.status === 'rejected' ? res.attempted : undefined).toBe(0);
      expect(calls.length).toBe(0);
      if (res.status === 'rejected') expect(res.error.kind).toBe('workspace_symlink_alias');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('waits for actual producer completion before any trial dispatch', async () => {
    const execute = await getExecute();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-wait-'));
    try {
      const { manifest } = await createUnverifiedStudyFixture(root);
      const { transport, calls } = createFakeTransport();
      const tracker = createEffects(manifest);
      let entered!: () => void; let release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const effects: PreflightHostEffects = { ...tracker.effects, executePreflight: async req => {
        entered(); await held;
        return { status: 'failed', invocationId: req.invocationId, proofId: req.proofId, failureReason: 'controlled failure', rawTrace: 'held-producer-failed' };
      }};
      const running = execute(manifest, path.join(root, 'out'), transport, effects, new AbortController().signal);
      await waiting;
      try { expect(calls).toEqual([]); } finally { release(); }
      const res = await running;
      expect(res.status).toBe('rejected'); expect(calls).toEqual([]);
      expect(res.retainedTraces.map(t => t.raw)).toContain('held-producer-failed');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('preaborted signal produces zero effects and returns cancelled result before trial dispatch', async () => {
    const execute = await getExecute();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-preaborted-'));
    try {
      const { manifest } = await createUnverifiedStudyFixture(root);
      const { transport, calls } = createFakeTransport();
      const tracker = createEffects(manifest);
      let canonicalPathsResolved = 0;
      const wrappedEffects: PreflightHostEffects = {
        ...tracker.effects,
        resolveCanonicalPath: async (p) => {
          canonicalPathsResolved++;
          return fs.realpath(p);
        },
      };

      const controller = new AbortController();
      controller.abort();

      const res = await execute(manifest, path.join(root, 'out'), transport, wrappedEffects, controller.signal);

      expect(res.status).toBe('cancelled');
      expect(res.trialAuthorization).toBe(false);
      expect(res.scope).toBe('orchestration_only');
      if (res.status === 'cancelled') {
        expect(res.attempted).toBe(0);
        expect(res.phase).toBe('preaborted');
        expect(res.activity).toBe('not_started');
      }
      expect(canonicalPathsResolved).toBe(0);
      expect(tracker.buildRequests.length).toBe(0);
      expect(tracker.preflightRequests.length).toBe(0);
      expect(calls.length).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('cancellation halts held never-settling build observation, passes signal, does not hang, and records unknown activity', async () => {
    const execute = await getExecute();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-held-build-'));
    try {
      const { manifest } = await createUnverifiedStudyFixture(root);
      const { transport, calls } = createFakeTransport();
      const tracker = createEffects(manifest);

      const controller = new AbortController();
      let enteredBuild!: () => void;
      const buildStarted = new Promise<void>((resolve) => { enteredBuild = resolve; });
      let observedSignal: AbortSignal | undefined;

      const effects: PreflightHostEffects = {
        ...tracker.effects,
        observeLoadedBuild: async (req, signal) => {
          tracker.buildRequests.push(req);
          observedSignal = signal;
          enteredBuild();
          return new Promise<ObservedBuildIdentity>(() => {});
        },
      };

      const running = execute(manifest, path.join(root, 'out'), transport, effects, controller.signal);
      await buildStarted;
      expect(calls.length).toBe(0);

      controller.abort();

      const res = await running;
      expect(observedSignal).toBeDefined();
      expect(observedSignal?.aborted).toBe(true);
      expect(res.status).toBe('cancelled');
      expect(res.trialAuthorization).toBe(false);
      expect(calls.length).toBe(0);
      if (res.status === 'cancelled') {
        expect(res.attempted).toBe(0);
        expect(res.phase).toBe('build_observation');
        const raw = res.retainedTraces.map((t) => t.raw);
        expect(res.activity).toBe('unknown');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('cancellation halts held never-settling preflight producer, retains prior build observations, does not hang, and records unknown activity', async () => {
    const execute = await getExecute();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-held-producer-'));
    try {
      const { manifest } = await createUnverifiedStudyFixture(root);
      const { transport, calls } = createFakeTransport();
      const tracker = createEffects(manifest);

      const controller = new AbortController();
      let enteredProducer!: () => void;
      const producerStarted = new Promise<void>((resolve) => { enteredProducer = resolve; });
      let observedSignal: AbortSignal | undefined;

      const effects: PreflightHostEffects = {
        ...tracker.effects,
        executePreflight: async (req, signal) => {
          tracker.preflightRequests.push(req);
          observedSignal = signal;
          enteredProducer();
          return new Promise<PreflightExecutionReceipt>(() => {});
        },
      };

      const running = execute(manifest, path.join(root, 'out'), transport, effects, controller.signal);
      await producerStarted;
      expect(calls.length).toBe(0);

      controller.abort();

      const res = await running;
      expect(observedSignal).toBeDefined();
      expect(observedSignal?.aborted).toBe(true);
      expect(res.status).toBe('cancelled');
      expect(res.trialAuthorization).toBe(false);
      expect(calls.length).toBe(0);
      if (res.status === 'cancelled') {
        expect(res.attempted).toBe(0);
        expect(res.phase).toBe('preflight_execution');
        const raw = res.retainedTraces.map((t) => t.raw);
        expect(raw).toContain('build-baseline-trace');
        expect(raw).toContain('build-candidate-trace');
        expect(res.activity).toBe('unknown');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  const negativeCases = [
    ['missing build', 'loaded_identity_missing'], ['mismatched sha', 'loaded_identity_mismatch'],
    ['wrong source commit', 'loaded_identity_mismatch'], ['wrong adapter version', 'loaded_identity_mismatch'],
    ['unknown workflow', 'loaded_workflow_missing'], ['wrong workflow ID', 'loaded_workflow_mismatch'],
    ['wrong workflow sha', 'loaded_workflow_mismatch'],
    ['wrong build request ID', 'build_correlation_mismatch'], ['failed producer', 'preflight_execution_failed'],
    ['wrong invocation ID', 'preflight_correlation_mismatch'], ['wrong proof ID', 'preflight_correlation_mismatch'],
    ['wrong artifact path', 'preflight_correlation_mismatch'], ['wrong artifact hash', 'preflight_hash_mismatch'],
    ['incomplete controls', 'preflight_control_set_incomplete'], ['duplicate controls', 'preflight_control_set_incomplete'],
    ['wrong verdict', 'preflight_control_outcome_mismatch'], ['mismatched observations', 'preflight_observation_mismatch'],
    ['labels-only producer unavailable', 'preflight_not_executed'],
  ] as const;
  it.each(negativeCases)('rejects %s before trial dispatch', async (mutation, expectedKind) => {
    const execute = await getExecute();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'preflight-neg-'));
    try {
      const { manifest } = await createUnverifiedStudyFixture(root);
      const { transport, calls } = createFakeTransport();
      const tracker = createEffects(manifest, mutation);
      const res = await execute(manifest, path.join(root, 'out'), transport, tracker.effects, new AbortController().signal);
      expect(res.status).toBe('rejected'); expect(res.status === 'rejected' ? res.attempted : undefined).toBe(0);
      expect(res.trialAuthorization).toBe(false); expect(calls).toEqual([]);
      if (res.status === 'rejected') expect(res.error.kind).toBe(expectedKind);
      const raw = res.retainedTraces.map(t => t.raw);
      expect(raw).toContain(`build-${tracker.buildRequests[0].arm}-trace`);
      if (tracker.preflightRequests.length && mutation !== 'labels-only producer unavailable') {
        expect(raw).toContain(`trace-${tracker.preflightRequests.at(-1)!.proofId}`);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
