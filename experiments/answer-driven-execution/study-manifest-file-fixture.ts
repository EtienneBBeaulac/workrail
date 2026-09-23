/** Synthetic artifact bytes deliberately lack executed preflight evidence.
 * The manifest builders are copied from the existing unit control; it is not a
 * successful runtime fixture. Real files let admission inspect physical paths.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { computeSha256, STAGE_A_SCENARIOS, STAGE_B_SCENARIOS, validateStudyManifest, type StageAManifestInput, type StageBManifestInput } from './study-manifest.mjs';
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

export async function createUnverifiedStudyFixture(root: string, stage: 'A' | 'B' = 'A') {
  const files = new Map<string, string | Uint8Array>();
  const build = stage === 'A' ? buildStageAManifest : buildStageBManifest;
  const manifest = build((path, content) => {
    files.set(path, content);
    return computeSha256(content);
  });
  const underRoot = (path: string) => join(root, path.slice(1));
  const relocate = (value: unknown): unknown => {
    if (typeof value === 'string' && isAbsolute(value)) return underRoot(value);
    if (Array.isArray(value)) return value.map(relocate);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)]));
    }
    return value;
  };
  const result = validateStudyManifest(relocate(manifest));
  if (result.kind !== 'valid') throw new Error(JSON.stringify(result.errors));
  for (const [path, content] of files) {
    await mkdir(dirname(underRoot(path)), { recursive: true });
    await writeFile(underRoot(path), content);
  }
  for (const pair of result.manifest.pairs) {
    await mkdir(pair.baseline.workspacePath, { recursive: true });
    await mkdir(pair.candidate.workspacePath, { recursive: true });
  }
  const manifestPath = join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(result.manifest));
  return { manifest: result.manifest, manifestPath };
}
