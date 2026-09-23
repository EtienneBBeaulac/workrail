import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeSha256 } from './study-manifest.mjs';
import { createStageBFixture, makeEffects } from './study-runner-fixture.js';
import type {
  ExtendedAgentTransport,
  RunStudyOptions,
  StudyReport,
  UnresolvedStudyReport,
} from './study-runner-contract.js';
import type { PreflightHostEffects } from './trial-preflight-contract.js';

interface TestHarness {
  readonly root: string;
  readonly calls: string[];
  readonly preflightCalls: number[];
  readonly transport: ExtendedAgentTransport;
  readonly effects: PreflightHostEffects;
  readonly runStudy: (options: RunStudyOptions) => Promise<StudyReport>;
}

async function withHarness(fn: (harness: TestHarness) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'manifest-failure-probe-'));
  try {
    const { manifest } = await createStageBFixture(root);
    const calls: string[] = [];
    const preflightCalls: number[] = [];
    const transport: ExtendedAgentTransport = {
      async *startFresh(req) {
        calls.push(req.runId);
      },
    };
    const baseEffects = makeEffects(manifest);
    const effects: PreflightHostEffects = {
      ...baseEffects,
      async executePreflight(req, signal) {
        preflightCalls.push(Date.now());
        return baseEffects.executePreflight(req, signal);
      },
    };
    const { runStudy } = await import(
      /* @vite-ignore */ resolve('experiments/answer-driven-execution/study-runner.mts')
    );
    await fn({ root, calls, preflightCalls, transport, effects, runStudy });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it('missing file yields unresolved stage, unreadable_manifest failureKind, null digest, no effects, and matching persisted report', async () => {
  await withHarness(async ({ root, calls, preflightCalls, transport, effects, runStudy }) => {
    const nonExistentPath = join(root, 'non-existent-manifest.json');
    const outputDir = join(root, 'out-missing');

    const report = await runStudy({
      manifestPath: nonExistentPath,
      expectedManifestSha256: 'a'.repeat(64),
      outputDir,
      transport,
      effects,
      signal: new AbortController().signal,
    });

    expect(report.stage).toBe('unresolved');
    expect(report.status).toBe('failed');
    expect(report.scoreReport).toBeNull();
    expect(report.trials).toHaveLength(0);
    expect(report.preflight).toBeNull();
    expect(report.preflightTraces).toHaveLength(0);
    expect(report.agentLedger).toHaveLength(0);
    expect(report.hostLedger).toHaveLength(0);
    expect(report.slots).toHaveLength(0);

    const unresolved = report as UnresolvedStudyReport;
    expect(unresolved.failureKind).toBe('unreadable_manifest');
    expect(unresolved.manifestSha256).toBeNull();

    expect(calls).toHaveLength(0);
    expect(preflightCalls).toHaveLength(0);

    const persistedRaw = await readFile(join(outputDir, 'study-report.json'), 'utf8');
    const persisted = JSON.parse(persistedRaw);
    expect(persisted).toEqual(JSON.parse(JSON.stringify(report)));
  });
});

it('malformed JSON with matching actualhash yields unresolved stage, rejected_bytes, actual digest, invalid_json reason, and no effects', async () => {
  await withHarness(async ({ root, calls, preflightCalls, transport, effects, runStudy }) => {
    const malformedPath = join(root, 'malformed-manifest.json');
    const malformedContent = '{ invalid JSON syntax: true, missing quotes';
    await writeFile(malformedPath, malformedContent, 'utf8');

    const actualHash = computeSha256(Buffer.from(malformedContent, 'utf8'));
    const outputDir = join(root, 'out-malformed');

    const report = await runStudy({
      manifestPath: malformedPath,
      expectedManifestSha256: actualHash,
      outputDir,
      transport,
      effects,
      signal: new AbortController().signal,
    });

    expect(report.stage).toBe('unresolved');
    expect(report.status).toBe('failed');
    expect(report.scoreReport).toBeNull();
    expect(report.trials).toHaveLength(0);
    expect(report.preflight).toBeNull();
    expect(report.preflightTraces).toHaveLength(0);
    expect(report.agentLedger).toHaveLength(0);
    expect(report.hostLedger).toHaveLength(0);
    expect(report.slots).toHaveLength(0);

    const unresolved = report as Extract<UnresolvedStudyReport, { readonly failureKind: 'rejected_bytes' }>;
    expect(unresolved.failureKind).toBe('rejected_bytes');
    expect(unresolved.manifestSha256).toBe(actualHash);
    expect(unresolved.reason).toBe('invalid_json');

    expect(calls).toHaveLength(0);
    expect(preflightCalls).toHaveLength(0);

    const persistedRaw = await readFile(join(outputDir, 'study-report.json'), 'utf8');
    const persisted = JSON.parse(persistedRaw);
    expect(persisted).toEqual(JSON.parse(JSON.stringify(report)));
  });
});

it('invalid declaration with matching actualhash yields unresolved stage, rejected_bytes, actual digest, invalid_declaration reason, identifiable slots, and no effects', async () => {
  await withHarness(async ({ root, calls, preflightCalls, transport, effects, runStudy }) => {
    const invalidDeclPath = join(root, 'invalid-declaration-manifest.json');
    const invalidDeclContent = JSON.stringify({
      version: 999,
      stage: 'UnknownStage',
      pairs: [
        {
          armOrder: ['control'],
          control: {
            runId: 'run-decl-fail-1',
          },
        },
      ],
    });
    await writeFile(invalidDeclPath, invalidDeclContent, 'utf8');

    const actualHash = computeSha256(Buffer.from(invalidDeclContent, 'utf8'));
    const outputDir = join(root, 'out-invalid-declaration');

    const report = await runStudy({
      manifestPath: invalidDeclPath,
      expectedManifestSha256: actualHash,
      outputDir,
      transport,
      effects,
      signal: new AbortController().signal,
    });

    expect(report.stage).toBe('unresolved');
    expect(report.status).toBe('failed');
    expect(report.scoreReport).toBeNull();
    expect(report.trials).toHaveLength(0);
    expect(report.preflight).toBeNull();
    expect(report.preflightTraces).toHaveLength(0);
    expect(report.agentLedger).toHaveLength(0);
    expect(report.hostLedger).toHaveLength(0);

    expect(report.slots).toEqual([
      { runId: 'run-decl-fail-1', status: 'not_attempted' },
    ]);

    const unresolved = report as Extract<UnresolvedStudyReport, { readonly failureKind: 'rejected_bytes' }>;
    expect(unresolved.failureKind).toBe('rejected_bytes');
    expect(unresolved.manifestSha256).toBe(actualHash);
    expect(unresolved.reason).toBe('invalid_declaration');

    expect(calls).toHaveLength(0);
    expect(preflightCalls).toHaveLength(0);

    const persistedRaw = await readFile(join(outputDir, 'study-report.json'), 'utf8');
    const persisted = JSON.parse(persistedRaw);
    expect(persisted).toEqual(JSON.parse(JSON.stringify(report)));
  });
});

it('hash mismatch yields unresolved stage, rejected_bytes, actual computed digest, hash_mismatch reason, identifiable slots, and no effects', async () => {
  await withHarness(async ({ root, calls, preflightCalls, transport, effects, runStudy }) => {
    const { manifestPath } = await createStageBFixture(root);
    const rawBytes = await readFile(manifestPath);
    const actualHash = computeSha256(rawBytes);
    const expectedHash = 'f'.repeat(64);
    const outputDir = join(root, 'out-hash-mismatch');

    const report = await runStudy({
      manifestPath,
      expectedManifestSha256: expectedHash,
      outputDir,
      transport,
      effects,
      signal: new AbortController().signal,
    });

    expect(report.stage).toBe('unresolved');
    expect(report.status).toBe('failed');
    expect(report.scoreReport).toBeNull();
    expect(report.trials).toHaveLength(0);
    expect(report.preflight).toBeNull();
    expect(report.preflightTraces).toHaveLength(0);
    expect(report.agentLedger).toHaveLength(0);
    expect(report.hostLedger).toHaveLength(0);

    expect(report.slots.length).toBeGreaterThan(0);
    expect(report.slots.every((s) => s.status === 'not_attempted')).toBe(true);

    const unresolved = report as Extract<UnresolvedStudyReport, { readonly failureKind: 'rejected_bytes' }>;
    expect(unresolved.failureKind).toBe('rejected_bytes');
    expect(unresolved.manifestSha256).toBe(actualHash);
    expect(unresolved.reason).toBe('hash_mismatch');

    expect(calls).toHaveLength(0);
    expect(preflightCalls).toHaveLength(0);

    const persistedRaw = await readFile(join(outputDir, 'study-report.json'), 'utf8');
    const persisted = JSON.parse(persistedRaw);
    expect(persisted).toEqual(JSON.parse(JSON.stringify(report)));
  });
});
