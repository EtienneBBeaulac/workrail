/** Synthetic controls only. These fixtures do not authorize a real study. */
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { computeSha256, validateStudyManifest, type ValidatedStudyManifest } from './study-manifest.mjs';
import { createUnverifiedStudyFixture } from './study-manifest-file-fixture.js';
import type { PreflightHostEffects } from './trial-preflight-contract.js';
import type { ReviewVerdictArtifactV1 } from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';
export const sampleReview: ReviewVerdictArtifactV1 = {
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

export async function createStageBFixture(root: string) {
 const {manifest, manifestPath} = await createUnverifiedStudyFixture(root, 'B');
 const pairs = await Promise.all(manifest.pairs.map(async pair => {
  const content = JSON.stringify({fixture:pair.scenario, rep:pair.repetition, expectedReview:sampleReview});
  await writeFile(pair.fixture.path, content);
  return {...pair, fixture:{...pair.fixture, sha256:computeSha256(content)}};
 }));
 const validated = validateStudyManifest({...manifest, pairs});
 if (validated.kind !== 'valid') throw new Error(JSON.stringify(validated.errors));
 await writeFile(manifestPath, JSON.stringify(validated.manifest));
 return {manifest:validated.manifest, manifestPath};
}
export function makeEffects(manifest: ValidatedStudyManifest): PreflightHostEffects {
  return {
    resolveCanonicalPath: realpath,
    observeLoadedBuild: async (req) => ({
      kind: 'observed',
      requestId: req.requestId,
      arm: req.arm,
      identity: { commit: manifest.git.commit, executableSha256: manifest.executables[req.arm].sha256, adapterVersion: manifest.executables[req.arm].adapterVersion },
      workflow: { kind: 'observed', identity: { workflowId: manifest.workflows[req.arm].workflowId, sha256: manifest.workflows[req.arm].sha256 } },
      rawTrace: 'build-ok',
    }),
    executePreflight: async (req) => {
      const base = { status: 'executed' as const, invocationId: req.invocationId, proofId: req.proofId, artifactPath: req.targetArtifactPath, artifactSha256: computeSha256(await readFile(req.targetArtifactPath)), rawTrace: 'ok' };
      if (req.kind === 'observation_checker') {
        return { ...base, kind: req.kind, controls: [
          { checkId: 'checker_intact' as const, outcome: 'accepted' as const, raw: 'ok' },
          { checkId: 'checker_removed' as const, outcome: 'rejected' as const, raw: 'ok' },
          { checkId: 'checker_duplicate' as const, outcome: 'rejected' as const, raw: 'ok' },
          { checkId: 'checker_artifact_mismatch' as const, outcome: 'rejected' as const, raw: 'ok' },
          { checkId: 'checker_wrong_run' as const, outcome: 'rejected' as const, raw: 'ok' },
          { checkId: 'checker_unmatched_fault' as const, outcome: 'rejected' as const, raw: 'ok' },
        ] };
      }
      if (req.kind === 'timeout_enforcement') {
        return { ...base, kind: req.kind, controls: [
          { checkId: 'timeout_abort' as const, outcome: 'completed' as const, raw: 'ok' },
          { checkId: 'timeout_cleanup' as const, outcome: 'completed' as const, raw: 'ok' },
        ] };
      }
      if (req.kind === 'fault_equivalence') {
        return { ...base, kind: req.kind, scenario: req.scenario, controls: [
          { checkId: 'fault_baseline' as const, outcome: 'completed' as const, raw: 'ok' },
          { checkId: 'fault_candidate' as const, outcome: 'completed' as const, raw: 'ok' },
        ], observations: { baseline: [{ id: 'obs-1', value: 'val-1' }], candidate: [{ id: 'obs-1', value: 'val-1' }] } };
      }
      return { ...base, kind: 'review_obligations' as const, controls: [
        { checkId: 'review_baseline' as const, outcome: 'completed' as const, raw: 'ok' },
        { checkId: 'review_candidate' as const, outcome: 'completed' as const, raw: 'ok' },
      ], observations: { baseline: [{ id: 'obs-1', value: 'val-1' }], candidate: [{ id: 'obs-1', value: 'val-1' }] } };
    },
  };
}
