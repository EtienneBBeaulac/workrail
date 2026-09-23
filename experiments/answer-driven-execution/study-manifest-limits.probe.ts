/** Controls for the limits of R36, not an executable study admission gate. */
import { describe, it, expect } from 'vitest';
import { readFile, rm, symlink, mkdtemp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUnverifiedStudyFixture } from './study-manifest-file-fixture.js';
import { verifyStudyManifest } from './study-manifest.mjs';

describe('study manifest admission limits', () => {
  it.each([{ stage: 'A', count: 40 }, { stage: 'B', count: 20 }] as const)('Stage $stage static control verifies bytes without authorizing trials', async ({ stage, count }) => {
    const root = await mkdtemp(join(tmpdir(), 'workrail-study-enrollment-'));
    try {
      const f = await createUnverifiedStudyFixture(root, stage);
      const verified = await verifyStudyManifest(f.manifest, p => readFile(p));
      expect(verified.kind).toBe('manifest_verified');
      if (verified.kind !== 'manifest_verified') throw new Error(JSON.stringify(verified));
      expect(verified.trialAuthorization).toBe(false);
      expect(verified.totalPlannedTrials).toBe(count);
      expect(verified.stage).toBe(stage);
      const proof = JSON.parse(await readFile(f.manifest.preflights.observationCheckerProof.path, 'utf8'));
      expect(proof).toEqual({ proof: 'observation-checker-passed' });
      expect(verified.scope).toBe('declaration_and_artifact_bytes_only');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('matching artifact bytes do not establish physical workspace isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workrail-study-enrollment-'));
    try {
      const f = await createUnverifiedStudyFixture(root);
      const firstPair = f.manifest.pairs[0];
      await rm(firstPair.candidate.workspacePath, { recursive: true, force: true });
      await symlink(firstPair.baseline.workspacePath, firstPair.candidate.workspacePath, 'dir');

      const verified = await verifyStudyManifest(f.manifest, p => readFile(p, 'utf8'));
      expect(verified.kind).toBe('manifest_verified');
      if (verified.kind !== 'manifest_verified') throw new Error(JSON.stringify(verified));
      expect(verified.trialAuthorization).toBe(false);
      expect(verified.totalPlannedTrials).toBe(40);

      expect(await realpath(firstPair.candidate.workspacePath)).toBe(await realpath(firstPair.baseline.workspacePath));
      expect(verified.scope).toBe('declaration_and_artifact_bytes_only');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
