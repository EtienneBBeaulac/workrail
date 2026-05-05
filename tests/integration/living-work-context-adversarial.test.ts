/**
 * Adversarial behavioral test for living work context (AC 21).
 *
 * WHAT THIS TESTS:
 * Unit tests for buildContextSummary() verify plumbing -- that field X is present
 * in the output string. They do not verify that the review agent actually receives
 * context that would let it catch a shaping constraint violation.
 *
 * This test verifies the FULL CHAIN:
 *   shaping declares constraint -> coordinator reads artifact -> buildContextSummary() ->
 *   review spawn receives assembledContextSummary -> constraint violation is detectable
 *
 * Scenario:
 * - Shaping declares: validationChecklist = ["do not modify the auth middleware"]
 * - Coding violates it: filesChanged = ["src/auth/middleware.ts"]
 * - Review agent's assembledContextSummary must contain BOTH pieces
 *   so a review agent reading it can detect the violation
 *
 * If any link in the chain breaks (artifact not read, wrong phase selection,
 * wrong field, trimmed away), this test fails where unit tests cannot.
 *
 * WHY "adversarial": it is designed to FAIL if the context mechanism is broken,
 * not just to pass if the plumbing exists. The scenario is constructed so that
 * a functioning context chain makes the violation detectable.
 */

import { describe, it, expect, vi } from 'vitest';
import { ok as nok } from 'neverthrow';
import { runReviewAndVerdictCycle } from '../../src/coordinators/modes/implement-shared.js';
import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts } from '../../src/coordinators/adaptive-pipeline.js';
import type { ShapingHandoffArtifactV1, CodingHandoffArtifactV1, PhaseHandoffArtifact } from '../../src/v2/durable-core/schemas/artifacts/index.js';
import { ok } from '../../src/runtime/result.js';

// ─── Scenario setup ──────────────────────────────────────────────────────────

const CONSTRAINT = 'do not modify the auth middleware';
const VIOLATED_FILE = 'src/auth/middleware.ts';

const shapingArtifact: ShapingHandoffArtifactV1 = {
  kind: 'wr.shaping_handoff',
  version: 1,
  pitchPath: '.workrail/current-pitch.md',
  selectedShape: 'Refactor the session store',
  appetite: 'Small batch (1-2 days)',
  keyConstraints: ['Session store must remain backward compatible'],
  rabbitHoles: ['Do not touch the auth layer'],
  outOfScope: ['Auth middleware changes'],
  validationChecklist: [CONSTRAINT, 'All existing session tests pass'],
};

const codingArtifact: CodingHandoffArtifactV1 = {
  kind: 'wr.coding_handoff',
  version: 1,
  branchName: 'feat/session-store-refactor',
  keyDecisions: ['Used Map instead of object for O(1) lookup'],
  knownLimitations: [],
  testsAdded: ['tests/unit/session-store.test.ts'],
  filesChanged: [VIOLATED_FILE, 'src/session/store.ts'],  // <-- violation
};

const priorArtifacts: readonly PhaseHandoffArtifact[] = [shapingArtifact, codingArtifact];

// ─── Fake deps ───────────────────────────────────────────────────────────────

function makeReviewDeps(): {
  deps: AdaptiveCoordinatorDeps;
  capturedReviewContexts: Readonly<Record<string, unknown>>[];
} {
  const capturedReviewContexts: Readonly<Record<string, unknown>>[] = [];
  let handleCounter = 0;

  const deps: AdaptiveCoordinatorDeps = {
    spawnSession: vi.fn().mockImplementation(async (workflowId: string, _goal: string, _ws: string, context?: Readonly<Record<string, unknown>>) => {
      if (workflowId === 'wr.mr-review') {
        capturedReviewContexts.push(context ?? {});
      }
      return ok(`handle-${++handleCounter}`);
    }),
    awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => ({
      results: [{ handle: handles[0]!, outcome: 'success', status: 'completed', durationMs: 1000 }],
      allSucceeded: true,
    })),
    getAgentResult: vi.fn().mockResolvedValue({
      recapMarkdown: 'Review complete. Clean verdict.',
      artifacts: [{
        kind: 'wr.review_verdict',
        verdict: 'clean',
        confidence: 'high',
        findings: [],
        summary: 'No issues found.',
      }],
    }),
    listOpenPRs: vi.fn().mockResolvedValue([]),
    mergePR: vi.fn().mockResolvedValue(ok(undefined)),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    appendFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stderr: vi.fn(),
    now: vi.fn().mockReturnValue(Date.now()),
    port: 3456,
    homedir: () => '/home/test',
    joinPath: (...parts: string[]) => parts.join('/'),
    nowIso: () => new Date().toISOString(),
    generateId: () => 'test-id',
    fileExists: vi.fn().mockReturnValue(false),
    archiveFile: vi.fn().mockResolvedValue(undefined),
    pollForPR: vi.fn().mockResolvedValue('https://github.com/org/repo/pull/42'),
    postToOutbox: vi.fn().mockResolvedValue(undefined),
    pollOutboxAck: vi.fn().mockResolvedValue('acked'),
    getChildSessionResult: vi.fn().mockResolvedValue({ kind: 'success', notes: 'LGTM.', artifacts: [] }),
    spawnAndAwait: vi.fn().mockResolvedValue({ kind: 'success', notes: 'LGTM.', artifacts: [] }),
    generateRunId: vi.fn().mockReturnValue('adversarial-test-run'),
    readActiveRunId: vi.fn().mockResolvedValue(nok(null)),
    readPipelineContext: vi.fn().mockResolvedValue(nok(null)),
    writePhaseRecord: vi.fn().mockResolvedValue(nok(undefined)),
  };

  return { deps, capturedReviewContexts };
}

const opts: AdaptivePipelineOpts = {
  workspace: '/workspace',
  goal: 'Refactor session store',
  dryRun: false,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Living work context -- adversarial chain test (AC 21)', () => {
  it('review agent receives shaping validationChecklist in assembledContextSummary', async () => {
    const { deps, capturedReviewContexts } = makeReviewDeps();

    await runReviewAndVerdictCycle(
      deps,
      opts,
      'https://github.com/org/repo/pull/42',
      Date.now(),
      0,
      'adversarial-test-run',
      priorArtifacts,
    );

    expect(capturedReviewContexts.length).toBe(1);
    const summary = capturedReviewContexts[0]?.['assembledContextSummary'] as string | undefined;
    expect(summary).toBeDefined();
    expect(typeof summary).toBe('string');

    // The constraint must be present in the review context
    expect(summary).toContain(CONSTRAINT);
  });

  it('review agent receives coding filesChanged in assembledContextSummary', async () => {
    const { deps, capturedReviewContexts } = makeReviewDeps();

    await runReviewAndVerdictCycle(
      deps,
      opts,
      'https://github.com/org/repo/pull/42',
      Date.now(),
      0,
      'adversarial-test-run',
      priorArtifacts,
    );

    expect(capturedReviewContexts.length).toBe(1);
    const summary = capturedReviewContexts[0]?.['assembledContextSummary'] as string | undefined;
    expect(summary).toBeDefined();

    // The violated file must be present so the review agent can cross-reference
    expect(summary).toContain(VIOLATED_FILE);
  });

  it('constraint and violated file are co-present in the same context string', async () => {
    // This is the core adversarial assertion:
    // BOTH the constraint (from shaping) AND the violation (from coding) must be present
    // in the same assembledContextSummary. A review agent reading this string has
    // everything needed to detect: "shaping said don't touch X, coding touched X."
    const { deps, capturedReviewContexts } = makeReviewDeps();

    await runReviewAndVerdictCycle(
      deps,
      opts,
      'https://github.com/org/repo/pull/42',
      Date.now(),
      0,
      'adversarial-test-run',
      priorArtifacts,
    );

    const summary = capturedReviewContexts[0]?.['assembledContextSummary'] as string;
    expect(summary).toBeDefined();

    const hasConstraint = summary.includes(CONSTRAINT);
    const hasViolation = summary.includes(VIOLATED_FILE);

    expect(hasConstraint).toBe(true);
    expect(hasViolation).toBe(true);

    // If either is missing, explain why the test fails
    if (!hasConstraint || !hasViolation) {
      throw new Error(
        `Adversarial test failed: the review agent cannot detect the violation.\n` +
        `  Constraint present: ${hasConstraint} (shaping validationChecklist)\n` +
        `  Violation present: ${hasViolation} (coding filesChanged)\n` +
        `  Context received:\n${summary}`,
      );
    }
  });

  it('fix agent also receives constraint and violated file when re-running after review', async () => {
    // Fix agent needs even more context: it must know WHAT to fix (filesChanged)
    // AND what rule it violated (validationChecklist / keyConstraints)
    const capturedFixContexts: Readonly<Record<string, unknown>>[] = [];
    let handleCounter = 0;

    const deps: AdaptiveCoordinatorDeps = {
      ...makeReviewDeps().deps,
      spawnSession: vi.fn().mockImplementation(async (workflowId: string, _goal: string, _ws: string, context?: Readonly<Record<string, unknown>>) => {
        if (workflowId === 'wr.coding-task') {
          capturedFixContexts.push(context ?? {});
        }
        return ok(`handle-${++handleCounter}`);
      }),
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: 'Review found minor issues.',
        artifacts: [{
          kind: 'wr.review_verdict',
          verdict: 'minor',
          confidence: 'high',
          findings: [{ severity: 'minor', summary: 'Auth middleware was modified against shaping constraints' }],
          summary: 'Minor findings require fix.',
        }],
      }),
    };

    await runReviewAndVerdictCycle(
      deps,
      opts,
      'https://github.com/org/repo/pull/42',
      Date.now(),
      0,
      'adversarial-test-run',
      priorArtifacts,
    );

    // Fix agent was spawned
    expect(capturedFixContexts.length).toBeGreaterThan(0);
    const fixSummary = capturedFixContexts[0]?.['assembledContextSummary'] as string | undefined;
    expect(fixSummary).toBeDefined();

    // Fix agent must know what file to fix
    expect(fixSummary).toContain(VIOLATED_FILE);
    // Fix agent must know what constraint to respect
    expect(fixSummary).toContain(CONSTRAINT);
  });
});
