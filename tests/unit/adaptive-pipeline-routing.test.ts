/**
 * Unit tests for runAdaptivePipeline() routing behavior.
 *
 * Verifies that the triggerProvider derivation in adaptive-pipeline.ts
 * correctly routes tasks based on opts.triggerProvider (authoritative),
 * NOT on opts.taskCandidate presence.
 *
 * Key invariant verified:
 * - taskCandidate set + no triggerProvider -> FULL (not REVIEW_ONLY)
 *   (this was broken: taskCandidate incorrectly implied 'github_prs_poll')
 * - triggerProvider: 'github_prs_poll' explicitly set -> REVIEW_ONLY
 * - goal with explicit PR #N -> REVIEW_ONLY
 *
 * All I/O is injected via faked AdaptiveCoordinatorDeps and ModeExecutors.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runAdaptivePipeline,
} from '../../src/coordinators/adaptive-pipeline.js';
import type {
  AdaptiveCoordinatorDeps,
  AdaptivePipelineOpts,
  ModeExecutors,
  PipelineOutcome,
} from '../../src/coordinators/adaptive-pipeline.js';
import { ok } from '../../src/runtime/result.js';

// ─── Fake builders ────────────────────────────────────────────────────────────

function makeFakeDeps(overrides: Partial<AdaptiveCoordinatorDeps> = {}): AdaptiveCoordinatorDeps {
  return {
    spawnSession: vi.fn().mockResolvedValue(ok('h1')),
    awaitSessions: vi.fn().mockResolvedValue({
      results: [{ handle: 'h1', outcome: 'success', status: 'completed', durationMs: 1000 }],
      allSucceeded: true,
    }),
    getAgentResult: vi.fn().mockResolvedValue({
      recapMarkdown: 'APPROVE -- LGTM.',
      artifacts: [],
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
    ...overrides,
  };
}

/**
 * Build a minimal ModeExecutors that records which mode was dispatched.
 * Returns a dry_run outcome with the mode name so tests can assert routing.
 */
function makeTrackingExecutors(): {
  executors: ModeExecutors;
  dispatchedMode: () => string | null;
} {
  let dispatchedMode: string | null = null;

  const dryRunOutcome = (mode: string): PipelineOutcome => {
    dispatchedMode = mode;
    return { kind: 'dry_run', mode };
  };

  const executors: ModeExecutors = {
    runQuickReview: vi.fn().mockImplementation(async () => dryRunOutcome('QUICK_REVIEW')),
    runReviewOnly: vi.fn().mockImplementation(async () => dryRunOutcome('REVIEW_ONLY')),
    runImplement: vi.fn().mockImplementation(async () => dryRunOutcome('IMPLEMENT')),
    runFull: vi.fn().mockImplementation(async () => dryRunOutcome('FULL')),
  };

  return {
    executors,
    dispatchedMode: () => dispatchedMode,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Routing tests: triggerProvider derivation
// ═══════════════════════════════════════════════════════════════════════════

describe('runAdaptivePipeline routing - triggerProvider derivation', () => {
  it('routes to FULL when taskCandidate is set and triggerProvider is not (queue poll task)', async () => {
    // This was the production bug: taskCandidate set -> incorrectly routed to REVIEW_ONLY.
    // After the fix: taskCandidate presence does NOT imply any triggerProvider.
    // No pitch.md, no PR reference in goal -> FULL.
    const deps = makeFakeDeps({ fileExists: () => false });
    const { executors, dispatchedMode } = makeTrackingExecutors();

    const opts: AdaptivePipelineOpts = {
      workspace: '/workspace',
      goal: 'test(daemon): add coverage for loadSessionNotes failure paths',
      taskCandidate: { issueNumber: 393, title: 'test(daemon): add coverage for loadSessionNotes failure paths' },
      // triggerProvider intentionally absent -- queue poller does not set it
    };

    const outcome = await runAdaptivePipeline(deps, opts, executors);
    expect(outcome.kind).toBe('dry_run');
    expect(dispatchedMode()).toBe('FULL');
  });

  it('routes to REVIEW_ONLY when triggerProvider is github_prs_poll (explicit PR poll trigger)', async () => {
    // The PR poll trigger passes triggerProvider directly. This must still route to REVIEW_ONLY.
    const deps = makeFakeDeps({ fileExists: () => false });
    const { executors, dispatchedMode } = makeTrackingExecutors();

    const opts: AdaptivePipelineOpts = {
      workspace: '/workspace',
      goal: 'Review open PRs',
      triggerProvider: 'github_prs_poll',
      // taskCandidate intentionally absent -- PR poller does not set it
    };

    const outcome = await runAdaptivePipeline(deps, opts, executors);
    expect(outcome.kind).toBe('dry_run');
    expect(dispatchedMode()).toBe('REVIEW_ONLY');
  });

  it('routes to REVIEW_ONLY when goal contains explicit PR number (regardless of taskCandidate)', async () => {
    const deps = makeFakeDeps({ fileExists: () => false });
    const { executors, dispatchedMode } = makeTrackingExecutors();

    const opts: AdaptivePipelineOpts = {
      workspace: '/workspace',
      goal: 'Review PR #42 before merge',
      // no triggerProvider, no taskCandidate -- PR reference in goal is sufficient
    };

    const outcome = await runAdaptivePipeline(deps, opts, executors);
    expect(outcome.kind).toBe('dry_run');
    expect(dispatchedMode()).toBe('REVIEW_ONLY');
  });

  it('routes to IMPLEMENT when taskCandidate is set and pitch.md exists', async () => {
    // taskCandidate + pitch.md present -> IMPLEMENT (Rule 3), not REVIEW_ONLY
    const deps = makeFakeDeps({ fileExists: () => true });
    const { executors, dispatchedMode } = makeTrackingExecutors();

    const opts: AdaptivePipelineOpts = {
      workspace: '/workspace',
      goal: 'Implement the queued auth task',
      taskCandidate: { issueNumber: 100 },
      // no triggerProvider -- queue poller does not set it
    };

    const outcome = await runAdaptivePipeline(deps, opts, executors);
    expect(outcome.kind).toBe('dry_run');
    expect(dispatchedMode()).toBe('IMPLEMENT');
  });
});
