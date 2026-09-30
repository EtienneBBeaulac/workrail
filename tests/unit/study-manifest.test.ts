import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  computeSha256,
  validateStudyManifest,
  verifyManifestArtifacts,
  verifyStudyManifest,
  STAGE_A_SCENARIOS,
  STAGE_B_SCENARIOS,
  type ArtifactReader,
  type StageAManifestInput,
  type StageBManifestInput,
  type StudyManifestInput,
  type StageAScenario,
} from '../../experiments/answer-driven-execution/study-manifest.mts';

function createSyntheticStore() {
  const fileStore = new Map<string, string | Uint8Array>();
  let readCount = 0;
  const register = (path: string, content: string | Uint8Array): string => {
    fileStore.set(path, content);
    return computeSha256(content);
  };
  const reader: ArtifactReader = (path: string, signal?: AbortSignal) => {
    readCount++;
    if (signal?.aborted) {
      const err = new Error('AbortError');
      err.name = 'AbortError';
      throw err;
    }
    const data = fileStore.get(path);
    if (data === undefined) throw new Error(`Synthetic file not found: ${path}`);
    return data;
  };
  return { fileStore, register, reader, getReadCount: () => readCount };
}

function buildStageAManifest(
  register: (path: string, content: string | Uint8Array) => string
): StageAManifestInput {
  const protocolSha = register('/proofs/protocol.md', '# Usability Protocol v1\nFrozen.');
  const baseBinSha = register('/bin/workrail-baseline', 'executable-bytes-baseline-v3.122.0');
  const candBinSha = register('/bin/workrail-candidate', 'executable-bytes-candidate-v3.122.0-ans');
  const baseWfSha = register('/workflows/stage-a-base.json', '{"workflow": "baseline-linear"}');
  const candWfSha = register('/workflows/stage-a-cand.json', '{"workflow": "candidate-linear"}');
  const obsCheckSha = register('/proofs/obs-checker.json', '{"proof": "observation-checker-passed"}');
  const timeoutSha = register('/proofs/timeout.json', '{"proof": "timeout-enforcement-passed"}');
  const feMalformedSha = register('/proofs/fe-malformed.json', '{"proof": "fault-equiv-malformed"}');
  const feLostRespSha = register('/proofs/fe-lost-response.json', '{"proof": "fault-equiv-lost-response"}');

  const pairs: StageAManifestInput['pairs'] = [];
  for (const scenario of STAGE_A_SCENARIOS) {
    for (let rep = 1; rep <= 5; rep++) {
      const fixPath = `/fixtures/stage-a-${scenario}-${rep}.json`;
      const fixSha = register(fixPath, `{"fixture": "${scenario}", "rep": ${rep}}`);
      pairs.push({
        scenario,
        repetition: rep,
        fixture: { fixtureId: `fix-a-${scenario}-${rep}`, path: fixPath, sha256: fixSha },
        expectedObservations: [
          { id: 'obs-1', value: `val-${scenario}-${rep}-alpha` },
          { id: 'obs-2', value: `val-${scenario}-${rep}-beta` },
        ],
        armOrder: rep % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'],
        baseline: { runId: `run-${scenario}-${rep}-base`, workspacePath: `/workspaces/stage-a/${scenario}/${rep}/base` },
        candidate: { runId: `run-${scenario}-${rep}-cand`, workspacePath: `/workspaces/stage-a/${scenario}/${rep}/cand` },
      });
    }
  }

  return {
    version: 1,
    stage: 'A',
    seed: 42109,
    protocol: { path: '/proofs/protocol.md', sha256: protocolSha },
    git: { commit: 'a38d0fd78198f3b2e59178ad309e42109abcdef0', dirty: false },
    executables: {
      baseline: { path: '/bin/workrail-baseline', sha256: baseBinSha, adapterVersion: '3.122.0' },
      candidate: { path: '/bin/workrail-candidate', sha256: candBinSha, adapterVersion: '3.122.0-candidate' },
    },
    workflows: {
      baseline: { path: '/workflows/stage-a-base.json', sha256: baseWfSha, workflowId: 'wr.baseline.linear' },
      candidate: { path: '/workflows/stage-a-cand.json', sha256: candWfSha, workflowId: 'wr.candidate.linear' },
    },
    environment: {
      agyVersion: '2.1.0',
      baseline: { model: 'gemini-3.8-flash-high', effort: 'high', temperature: 0.0, topP: 1.0, maxContextTokens: 1_000_000 },
      candidate: { model: 'gemini-3.8-flash-high', effort: 'high', temperature: 0.0, topP: 1.0, maxContextTokens: 1_000_000 },
    },
    budgets: {
      maxCallsPerConversation: 20,
      maxElapsedMsPerConversation: 300_000,
      maxCallTimeoutMs: 60_000,
      maxCumulativeMinutes: 200,
      allowedTools: ['workrail_start', 'workrail_step', 'workrail_read'],
    },
    faultDefinitions: [
      { scenario: 'ordinary', kind: 'none', injectionPoint: 'none', description: 'Linear baseline run' },
      { scenario: 'malformed', kind: 'malformed', injectionPoint: 'first_write_submission', description: 'Omit answer' },
      { scenario: 'lost_response', kind: 'lost_response', injectionPoint: 'first_committed_answer_response', description: 'Suppress response' },
      { scenario: 'finished_recovery', kind: 'none', injectionPoint: 'none', description: 'Read only completed run' },
    ],
    preflights: {
      observationCheckerProof: { proofId: 'proof-obs-checker-v1', path: '/proofs/obs-checker.json', sha256: obsCheckSha },
      timeoutEnforcementProof: { proofId: 'proof-timeout-v1', path: '/proofs/timeout.json', sha256: timeoutSha },
      faultEquivalenceProofs: [
        { scenario: 'malformed', proofId: 'proof-fe-malformed-v1', path: '/proofs/fe-malformed.json', sha256: feMalformedSha },
        { scenario: 'lost_response', proofId: 'proof-fe-lost-response-v1', path: '/proofs/fe-lost-response.json', sha256: feLostRespSha },
      ],
    },
    invalidationPolicy: {
      permittedReasons: ['provider_outage', 'shared_fault_proxy_malfunction'],
      maxReplacementsPerPair: 1,
      requireAllAttemptsReported: true,
      disallowedExclusions: ['candidate_failure', 'candidate_timeout', 'missing_candidate_evidence'],
    },
    pairs,
  };
}

function buildStageBManifest(
  register: (path: string, content: string | Uint8Array) => string
): StageBManifestInput {
  const protocolSha = register('/proofs/protocol-b.md', '# Usability Protocol Stage B\nFrozen.');
  const baseBinSha = register('/bin/workrail-baseline-b', 'executable-bytes-baseline-v3.122.0');
  const candBinSha = register('/bin/workrail-candidate-b', 'executable-bytes-candidate-v3.122.0-ans');
  const baseWfSha = register('/workflows/stage-b-base.json', '{"workflow": "baseline-review"}');
  const candWfSha = register('/workflows/stage-b-cand.json', '{"workflow": "candidate-review"}');
  const obsCheckSha = register('/proofs/obs-checker-b.json', '{"proof": "observation-checker-passed"}');
  const timeoutSha = register('/proofs/timeout-b.json', '{"proof": "timeout-enforcement-passed"}');
  const feMissingSummarySha = register('/proofs/fe-missing-summary.json', '{"proof": "fault-equiv-missing-summary"}');
  const fePartialSha = register('/proofs/fe-partial.json', '{"proof": "fault-equiv-partial-recovery"}');
  const stageBReviewSha = register('/proofs/stage-b-review-equiv.json', '{"proof": "review-obligations-equiv"}');

  const pairs: StageBManifestInput['pairs'] = [];
  for (const scenario of STAGE_B_SCENARIOS) {
    for (let rep = 1; rep <= 5; rep++) {
      const fixPath = `/fixtures/stage-b-${scenario}-${rep}.json`;
      const fixSha = register(fixPath, `{"fixture": "${scenario}", "rep": ${rep}}`);
      pairs.push({
        scenario,
        repetition: rep,
        fixture: { fixtureId: `fix-b-${scenario}-${rep}`, path: fixPath, sha256: fixSha },
        expectedObservations: [
          { id: 'obs-1', value: `val-b-${scenario}-${rep}-1` },
          { id: 'obs-2', value: `val-b-${scenario}-${rep}-2` },
        ],
        armOrder: rep % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'],
        baseline: { runId: `run-b-${scenario}-${rep}-base`, workspacePath: `/workspaces/stage-b/${scenario}/${rep}/base` },
        candidate: { runId: `run-b-${scenario}-${rep}-cand`, workspacePath: `/workspaces/stage-b/${scenario}/${rep}/cand` },
      });
    }
  }

  return {
    version: 1,
    stage: 'B',
    seed: 'seed-stage-b-review',
    protocol: { path: '/proofs/protocol-b.md', sha256: protocolSha },
    git: { commit: 'b38d0fd78198f3b2e59178ad309e42109abcdef0', dirty: false },
    executables: {
      baseline: { path: '/bin/workrail-baseline-b', sha256: baseBinSha, adapterVersion: '3.122.0' },
      candidate: { path: '/bin/workrail-candidate-b', sha256: candBinSha, adapterVersion: '3.122.0-candidate' },
    },
    workflows: {
      baseline: { path: '/workflows/stage-b-base.json', sha256: baseWfSha, workflowId: 'wr.baseline.review' },
      candidate: { path: '/workflows/stage-b-cand.json', sha256: candWfSha, workflowId: 'wr.candidate.review' },
    },
    environment: {
      agyVersion: '2.1.0',
      baseline: { model: 'gemini-3.8-flash-high', effort: 'high', temperature: 0.0 },
      candidate: { model: 'gemini-3.8-flash-high', effort: 'high', temperature: 0.0 },
    },
    budgets: {
      maxCallsPerConversation: 20,
      maxElapsedMsPerConversation: 300_000,
      maxCallTimeoutMs: 60_000,
      maxCumulativeMinutes: 100,
      allowedTools: ['workrail_start', 'workrail_step', 'workrail_read'],
    },
    faultDefinitions: [
      { scenario: 'missing_summary', kind: 'missing_summary', injectionPoint: 'first_complete_submission', description: 'Remove summary' },
      { scenario: 'recovery_after_partial_work', kind: 'recovery_after_partial_work', injectionPoint: 'after_partial_ack', description: 'Engine recreation' },
    ],
    preflights: {
      observationCheckerProof: { proofId: 'proof-obs-checker-b', path: '/proofs/obs-checker-b.json', sha256: obsCheckSha },
      timeoutEnforcementProof: { proofId: 'proof-timeout-b', path: '/proofs/timeout-b.json', sha256: timeoutSha },
      faultEquivalenceProofs: [
        { scenario: 'missing_summary', proofId: 'proof-fe-missing-summary-v1', path: '/proofs/fe-missing-summary.json', sha256: feMissingSummarySha },
        { scenario: 'recovery_after_partial_work', proofId: 'proof-fe-partial-v1', path: '/proofs/fe-partial.json', sha256: fePartialSha },
      ],
      stageBReviewObligationsProof: { proofId: 'proof-stage-b-review-equiv-v1', path: '/proofs/stage-b-review-equiv.json', sha256: stageBReviewSha },
    },
    invalidationPolicy: {
      permittedReasons: ['provider_outage', 'shared_fault_proxy_malfunction'],
      maxReplacementsPerPair: 1,
      requireAllAttemptsReported: true,
      disallowedExclusions: ['candidate_failure', 'candidate_timeout', 'missing_candidate_evidence'],
    },
    pairs,
  };
}

describe('study manifest and artifact verifier', () => {
  it('validates and verifies Stage A manifest with explicit declaration_and_artifact_bytes_only scope', async () => {
    const { register, reader } = createSyntheticStore();
    const manifest = buildStageAManifest(register);

    if (false) {
      // @ts-expect-error Raw declarations cannot bypass validation before trusted artifact I/O.
      await verifyManifestArtifacts(manifest, reader);
    }
    const declResult = validateStudyManifest(manifest);
    expect(declResult.kind).toBe('valid');
    if (declResult.kind !== 'valid') throw new Error('Expected valid fixture');

    const artifactResult = await verifyManifestArtifacts(declResult.manifest, reader);
    expect(artifactResult.kind).toBe('verified');

    const result = await verifyStudyManifest(manifest, reader);
    expect(result.kind).toBe('manifest_verified');
    if (result.kind === 'manifest_verified') {
      expect(result.scope).toBe('declaration_and_artifact_bytes_only');
      expect(result.trialAuthorization).toBe(false);
      expect(result.stage).toBe('A');
      expect(result.totalPlannedTrials).toBe(40);
      expect(result.verifiedArtifactCount).toBeGreaterThan(20);
    }
  });

  it('validates Stage B manifest and confirms deep readonly frozen manifest prevents mutation', async () => {
    const { register, reader } = createSyntheticStore();
    const manifest = buildStageBManifest(register);

    const result = await verifyStudyManifest(manifest, reader);
    expect(result.kind).toBe('manifest_verified');
    if (result.kind === 'manifest_verified') {
      expect(result.trialAuthorization).toBe(false);
      expect(result.stage).toBe('B');
      expect(result.totalPlannedTrials).toBe(20);
      expect(() => {
        (result.manifest.budgets as Record<string, unknown>).maxCallsPerConversation = 99;
      }).toThrow(TypeError);
    }
  });

  for (const stage of ['A', 'B'] as const) {
    it(`reads and checks every declared Stage ${stage} artifact`, async () => {
      const { fileStore, register, reader } = createSyntheticStore();
      const manifest = stage === 'A' ? buildStageAManifest(register) : buildStageBManifest(register);
      const clean = await verifyStudyManifest(manifest, reader);
      expect(clean.kind).toBe('manifest_verified');
      if (clean.kind !== 'manifest_verified') throw new Error('Expected valid fixture');
      expect(clean.verifiedArtifactCount).toBe(fileStore.size);

      // Enumerate producer inputs, independently of the verifier's artifact extractor.
      for (const [path, original] of fileStore) {
        fileStore.set(path, 'changed artifact bytes');
        const corrupt = await verifyStudyManifest(manifest, reader);
        fileStore.set(path, original);
        expect(corrupt.kind, path).toBe('rejected');
        if (corrupt.kind !== 'rejected') throw new Error(`Unchecked artifact: ${path}`);
        expect(corrupt.phase).toBe('artifacts');
        expect(corrupt.errors).toContainEqual(expect.objectContaining({ kind: 'hash_mismatch', path }));
      }
    });
  }

  it('hashes raw binary executable bytes without text conversion', async () => {
    const { fileStore, register, reader } = createSyntheticStore();
    const manifest = buildStageAManifest(register);
    const bytes = new Uint8Array([0, 255, 128, 195, 40, 10]);
    fileStore.set(manifest.executables.baseline.path, bytes);
    // The expected digest does not use the implementation helper under test.
    manifest.executables.baseline.sha256 = createHash('sha256').update(bytes).digest('hex');
    expect((await verifyStudyManifest(manifest, reader)).kind).toBe('manifest_verified');
    fileStore.set(manifest.executables.baseline.path, new Uint8Array([0, 255, 128, 195, 41, 10]));
    const changed = await verifyStudyManifest(manifest, reader);
    expect(changed.kind).toBe('rejected');
    if (changed.kind !== 'rejected') throw new Error('Expected binary mismatch');
    expect(changed.errors).toContainEqual(expect.objectContaining({
      kind: 'hash_mismatch', path: manifest.executables.baseline.path,
    }));
  });

  it('proves post-verification mutation of input does not alter the verified frozen manifest', async () => {
    const { register, reader } = createSyntheticStore();
    const manifest = buildStageAManifest(register);

    const result = await verifyStudyManifest(manifest, reader);
    expect(result.kind).toBe('manifest_verified');
    if (result.kind === 'manifest_verified') {
      manifest.budgets.maxCallsPerConversation = 5;
      expect(result.manifest.budgets.maxCallsPerConversation).toBe(20);
    }
  });

  it('runs CLI and reports exit 0 for consistency, exit 1 for rejected, exit 2 for input error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'study-manifest-cli-'));
    try {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);

      const writeHelper = async (relPath: string, content: string) => {
        const full = join(dir, relPath);
        await writeFile(full, content);
        return full;
      };

      manifest.protocol.path = await writeHelper('protocol.md', 'protocol content');
      manifest.protocol.sha256 = computeSha256('protocol content');
      manifest.executables.baseline.path = await writeHelper('baseline.bin', 'base bin');
      manifest.executables.baseline.sha256 = computeSha256('base bin');
      manifest.executables.candidate.path = await writeHelper('candidate.bin', 'cand bin');
      manifest.executables.candidate.sha256 = computeSha256('cand bin');
      manifest.workflows.baseline.path = await writeHelper('base-wf.json', 'base wf');
      manifest.workflows.baseline.sha256 = computeSha256('base wf');
      manifest.workflows.candidate.path = await writeHelper('cand-wf.json', 'cand wf');
      manifest.workflows.candidate.sha256 = computeSha256('cand wf');
      manifest.preflights.observationCheckerProof.path = await writeHelper('obs.json', 'obs content');
      manifest.preflights.observationCheckerProof.sha256 = computeSha256('obs content');
      manifest.preflights.timeoutEnforcementProof.path = await writeHelper('timeout.json', 'timeout content');
      manifest.preflights.timeoutEnforcementProof.sha256 = computeSha256('timeout content');

      for (const fep of manifest.preflights.faultEquivalenceProofs) {
        fep.path = await writeHelper(`fe-${fep.scenario}.json`, `fe ${fep.scenario}`);
        fep.sha256 = computeSha256(`fe ${fep.scenario}`);
      }
      for (const pair of manifest.pairs) {
        pair.fixture.path = await writeHelper(`fix-${pair.scenario}-${pair.repetition}.json`, `fix ${pair.scenario}`);
        pair.fixture.sha256 = computeSha256(`fix ${pair.scenario}`);
      }

      const manifestFile = join(dir, 'manifest.json');
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2));

      const cliScript = resolve('experiments/answer-driven-execution/study-manifest.mts');
      const valid = spawnSync(process.execPath, [cliScript, manifestFile], { encoding: 'utf8', timeout: 10_000 });
      expect(valid.status, valid.stderr).toBe(0);
      const validOut = JSON.parse(valid.stdout);
      expect(validOut.kind).toBe('manifest_verified');
      expect(validOut.trialAuthorization).toBe(false);

      // Corrupt a byte to verify exit 1 and discriminated union phase: artifacts
      await writeFile(manifest.protocol.path, 'corrupted');
      const fail = spawnSync(process.execPath, [cliScript, manifestFile], { encoding: 'utf8', timeout: 10_000 });
      expect(fail.status).toBe(1);
      const failOut = JSON.parse(fail.stdout);
      expect(failOut.kind).toBe('rejected');
      expect(failOut.phase).toBe('artifacts');
      expect(failOut.errors).toBeDefined();

      // Missing argument triggers exit 2
      expect(spawnSync(process.execPath, [cliScript], { timeout: 10_000 }).status).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('artifact paths: absolute path check and normalized alias conflicting hash refusal', () => {
    it('rejects relative artifact paths', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.protocol.path = 'relative/path/protocol.md';

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'invalid_artifact_path')).toBe(true);
      }
    });

    it('rejects same normalized path alias declared with conflicting expected hashes', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      // Candidate workflow points to normalized alias of baseline workflow with differing hash
      manifest.workflows.candidate.path = `${manifest.workflows.baseline.path}/.././stage-a-base.json`;
      manifest.workflows.candidate.sha256 = '0000000000000000000000000000000000000000000000000000000000000000';

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'conflicting_artifact_hash')).toBe(true);
      }
    });
  });

  describe('discriminated union on stage and preflight boundaries', () => {
    it('rejects Stage A containing stageBReviewObligationsProof', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      const invalid = {
        ...manifest,
        preflights: {
          ...manifest.preflights,
          stageBReviewObligationsProof: {
            proofId: 'proof-extra',
            path: '/proofs/extra.json',
            sha256: '1111111111111111111111111111111111111111111111111111111111111111',
          },
        },
      };

      const res = validateStudyManifest(invalid);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'schema_error')).toBe(true);
      }
    });

    it('rejects Stage A containing ordinary scenario extra fault equivalence proof', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      const invalid = {
        ...manifest,
        preflights: {
          ...manifest.preflights,
          faultEquivalenceProofs: [
            ...manifest.preflights.faultEquivalenceProofs,
            {
              scenario: 'ordinary',
              proofId: 'proof-fe-ordinary',
              path: '/proofs/ordinary.json',
              sha256: '2222222222222222222222222222222222222222222222222222222222222222',
            },
          ],
        },
      };

      const res = validateStudyManifest(invalid);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'schema_error')).toBe(true);
      }
    });

    it('rejects Stage A containing Stage B fault equivalence proof', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      const invalid = {
        ...manifest,
        preflights: {
          ...manifest.preflights,
          faultEquivalenceProofs: [
            ...manifest.preflights.faultEquivalenceProofs,
            {
              scenario: 'missing_summary',
              proofId: 'proof-fe-missing',
              path: '/proofs/missing.json',
              sha256: '3333333333333333333333333333333333333333333333333333333333333333',
            },
          ],
        },
      };

      const res = validateStudyManifest(invalid);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'schema_error')).toBe(true);
      }
    });

    it('rejects Stage B without stageBReviewObligationsProof', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageBManifest(register);
      const invalid = {
        ...manifest,
        preflights: {
          observationCheckerProof: manifest.preflights.observationCheckerProof,
          timeoutEnforcementProof: manifest.preflights.timeoutEnforcementProof,
          faultEquivalenceProofs: manifest.preflights.faultEquivalenceProofs,
        },
      };

      const res = validateStudyManifest(invalid);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'schema_error')).toBe(true);
      }
    });
  });

  describe('first-class AbortSignal cancellation', () => {
    it('aborts before any read when signal is pre-cancelled', async () => {
      const { register, reader, getReadCount } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      const controller = new AbortController();
      controller.abort('pre-aborted-reason');

      const res = await verifyStudyManifest(manifest, reader, controller.signal);
      expect(res.kind).toBe('cancelled');
      if (res.kind === 'cancelled') {
        expect(res.message).toContain('pre-aborted-reason');
      }
      expect(getReadCount()).toBe(0);
    });

    it('stops between reads when signal is aborted mid-flight', async () => {
      const { fileStore, register } = createSyntheticStore();
      let callCount = 0;
      const controller = new AbortController();
      const manifest = buildStageAManifest(register);

      const abortingReader: ArtifactReader = (path: string) => {
        callCount++;
        if (callCount === 2) {
          controller.abort('aborted-after-2-reads');
        }
        return fileStore.get(path) ?? 'bytes';
      };

      const res = await verifyStudyManifest(manifest, abortingReader, controller.signal);
      expect(res.kind).toBe('cancelled');
      expect(callCount).toBeLessThan(manifest.pairs.length);
    });

    it('catches AbortError thrown by reader without rethrowing as exception', async () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);

      const throwingReader: ArtifactReader = () => {
        const err = new Error('Operation aborted');
        err.name = 'AbortError';
        throw err;
      };

      const res = await verifyStudyManifest(manifest, throwingReader);
      expect(res.kind).toBe('cancelled');
      if (res.kind === 'cancelled') {
        expect(res.message).toContain('Operation aborted');
      }
    });
  });

  describe('injected I/O return type validation', () => {
    it('classifies invalid non-string non-Uint8Array content as verification failure', async () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);

      const badTypeReader: ArtifactReader = () => {
        return 12345 as unknown as string;
      };

      const res = await verifyStudyManifest(manifest, badTypeReader);
      expect(res.kind).toBe('rejected');
      if (res.kind === 'rejected') {
        expect(res.phase).toBe('artifacts');
        expect(res.errors.some(e => e.kind === 'invalid_content_type')).toBe(true);
      }
    });
  });

  describe('physical read deduplication and complete role retention', () => {
    it('deduplicates physical reads for shared files while retaining all manifest roles', async () => {
      const { fileStore, register, reader, getReadCount } = createSyntheticStore();
      const manifest = buildStageAManifest(register);

      // Point candidate workflow to exact same path and hash as baseline workflow
      manifest.workflows.candidate.path = manifest.workflows.baseline.path;
      manifest.workflows.candidate.sha256 = manifest.workflows.baseline.sha256;

      const declResult = validateStudyManifest(manifest);
      expect(declResult.kind).toBe('valid');
      if (declResult.kind !== 'valid') throw new Error('Expected valid fixture');

      const artifactResult = await verifyManifestArtifacts(declResult.manifest, reader);
      expect(artifactResult.kind).toBe('verified');
      if (artifactResult.kind === 'verified') {
        const sharedArtifact = artifactResult.artifacts.find(a => a.path === manifest.workflows.baseline.path);
        expect(sharedArtifact).toBeDefined();
        expect(sharedArtifact?.roles).toContain('workflow_baseline');
        expect(sharedArtifact?.roles).toContain('workflow_candidate');
      }
    });
  });

  describe('lexical directory isolation and path aliasing', () => {
    it('rejects relative workspace paths', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.pairs[0]!.baseline.workspacePath = 'relative/path/not/absolute';

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'invalid_workspace_path')).toBe(true);
      }
    });

    it('rejects duplicate normalized workspace paths caused by dot segments', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.pairs[1]!.candidate.workspacePath = `${manifest.pairs[0]!.baseline.workspacePath}/../base`;

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'duplicate_workspace_path')).toBe(true);
      }
    });

    it('rejects duplicate normalized workspace paths caused by trailing slashes', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.pairs[1]!.candidate.workspacePath = `${manifest.pairs[0]!.baseline.workspacePath}/`;

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'duplicate_workspace_path')).toBe(true);
      }
    });

    it('rejects ancestor/descendant nested workspace directories', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.pairs[0]!.candidate.workspacePath = `${manifest.pairs[0]!.baseline.workspacePath}/nested-subdir`;

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'overlapping_workspace_path')).toBe(true);
      }
    });
  });

  describe('fault definitions and equivalence proof validation', () => {
    it('rejects duplicate fault definitions for the same scenario', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.faultDefinitions.push({
        scenario: 'ordinary',
        kind: 'none',
        injectionPoint: 'none',
        description: 'Duplicate ordinary definition',
      });

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'duplicate_fault_definition' && e.scenario === 'ordinary')).toBe(true);
      }
    });

    it('rejects out-of-stage fault definitions', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      const invalid = {
        ...manifest,
        faultDefinitions: [
          ...manifest.faultDefinitions,
          {
            scenario: 'missing_summary',
            kind: 'missing_summary',
            injectionPoint: 'first_submission',
            description: 'Stage B fault in Stage A',
          },
        ],
      };

      const res = validateStudyManifest(invalid);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'schema_error')).toBe(true);
      }
    });

    it('rejects duplicate fault equivalence proofs for the same scenario', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.preflights.faultEquivalenceProofs.push({
        scenario: 'malformed',
        proofId: 'proof-fe-malformed-dup',
        path: '/proofs/fe-malformed.json',
        sha256: manifest.preflights.faultEquivalenceProofs[0]!.sha256,
      });

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'duplicate_preflight_proof' && e.scenario === 'malformed')).toBe(true);
      }
    });
  });

  describe('mutation-sensitive artifact verification negatives', () => {
    it.each(['A', 'B'] as const)('verifies every declared Stage %s artifact against its bytes and readability', async stage => {
      const { fileStore, register, reader } = createSyntheticStore();
      const manifest = stage === 'A' ? buildStageAManifest(register) : buildStageBManifest(register);
      expect((await verifyStudyManifest(manifest, reader)).kind).toBe('manifest_verified');
      const original = [...fileStore.entries()];
      expect(original.length).toBeGreaterThan(0);
      for (const [path, bytes] of original) {
        fileStore.set(path, bytes + '\nchanged');
        const changed = await verifyStudyManifest(manifest, reader);
        expect(changed.kind, path).toBe('rejected');
        if (changed.kind !== 'rejected') throw new Error('Artifact mutation was accepted: ' + path);
        expect(changed.phase).toBe('artifacts');
        expect(changed.errors).toContainEqual(expect.objectContaining({ kind: 'hash_mismatch', path }));
        fileStore.delete(path);
        const missing = await verifyStudyManifest(manifest, reader);
        expect(missing.kind, path).toBe('rejected');
        if (missing.kind !== 'rejected') throw new Error('Missing artifact was accepted: ' + path);
        expect(missing.phase).toBe('artifacts');
        expect(missing.errors).toContainEqual(expect.objectContaining({ kind: 'read_error', path }));
        fileStore.set(path, bytes);
      }
      const restored = await verifyStudyManifest(manifest, reader);
      expect(restored).toMatchObject({ kind: 'manifest_verified', trialAuthorization: false, scope: 'declaration_and_artifact_bytes_only' });
    });

    it('detects corrupted executable bytes and returns rejected artifacts phase', async () => {
      const { fileStore, register, reader } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      fileStore.set(manifest.executables.baseline.path, 'corrupted-baseline');

      const res = await verifyStudyManifest(manifest, reader);
      expect(res.kind).toBe('rejected');
      if (res.kind === 'rejected') {
        expect(res.phase).toBe('artifacts');
        expect(res.errors.some(e => e.kind === 'hash_mismatch' && e.path === manifest.executables.baseline.path)).toBe(true);
      }
    });

    it('detects corrupted fixture bytes', async () => {
      const { fileStore, register, reader } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      const fixPath = manifest.pairs[0]!.fixture.path;
      fileStore.set(fixPath, 'corrupted-fixture-bytes');

      const res = await verifyStudyManifest(manifest, reader);
      expect(res.kind).toBe('rejected');
      if (res.kind === 'rejected') {
        expect(res.phase).toBe('artifacts');
        expect(res.errors.some(e => e.kind === 'hash_mismatch' && e.path === fixPath)).toBe(true);
      }
    });

    it('reports read_error when a file is unreadable', async () => {
      const { fileStore, register, reader } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      fileStore.delete(manifest.protocol.path);

      const res = await verifyStudyManifest(manifest, reader);
      expect(res.kind).toBe('rejected');
      if (res.kind === 'rejected') {
        expect(res.phase).toBe('artifacts');
        expect(res.errors.some(e => e.kind === 'read_error' && e.path === manifest.protocol.path)).toBe(true);
      }
    });

    it('rejects self-asserted certification and rogue schema properties', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      const rogueInput = { ...manifest, buildVerified: true };
      const res = validateStudyManifest(rogueInput);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'schema_error')).toBe(true);
      }
    });
  });

  describe('environmental equivalence and budgets', () => {
    it('rejects model and effort mismatch', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.environment.candidate.model = 'gemini-1.5-pro';
      manifest.environment.candidate.effort = 'low';

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'unmatched_environment' && e.field === 'model')).toBe(true);
        expect(res.errors.some(e => e.kind === 'unmatched_environment' && e.field === 'effort')).toBe(true);
      }
    });

    it('rejects temperature mismatch', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.environment.candidate.temperature = 0.5;

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'unmatched_environment' && e.field === 'temperature')).toBe(true);
      }
    });

    it('rejects budget limit overages', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.budgets.maxCumulativeMinutes = 300;

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'budget_exceeded' && e.budget === 'maxCumulativeMinutes')).toBe(true);
      }
    });
  });

  describe('scenarios, freshness, and invalidation policy', () => {
    it('rejects missing scenario and duplicate runId', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      manifest.pairs = manifest.pairs.filter(p => p.scenario !== 'finished_recovery');
      manifest.pairs[0]!.candidate.runId = manifest.pairs[0]!.baseline.runId;

      const res = validateStudyManifest(manifest);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'missing_scenario_pair')).toBe(true);
        expect(res.errors.some(e => e.kind === 'duplicate_run_id')).toBe(true);
      }
    });

    it('rejects unpermitted invalidation reason and omitted disallowed exclusions', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      const invalid = {
        ...manifest,
        invalidationPolicy: {
          ...manifest.invalidationPolicy,
          permittedReasons: ['provider_outage', 'candidate_timeout' as unknown as 'provider_outage'],
        },
      };

      const res = validateStudyManifest(invalid);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'schema_error')).toBe(true);
      }
    });

    it('rejects dirty git state and malformed commit hash', () => {
      const { register } = createSyntheticStore();
      const manifest = buildStageAManifest(register);
      const dirty = { ...manifest, git: { commit: 'not-a-40-char-hex', dirty: true } };

      const res = validateStudyManifest(dirty);
      expect(res.kind).toBe('invalid');
      if (res.kind === 'invalid') {
        expect(res.errors.some(e => e.kind === 'schema_error' && e.path.includes('dirty'))).toBe(true);
        expect(res.errors.some(e => e.kind === 'schema_error' && e.path.includes('commit'))).toBe(true);
      }
    });
  });
});
