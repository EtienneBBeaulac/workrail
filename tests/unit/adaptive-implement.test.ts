/**
 * Unit tests for src/coordinators/modes/implement.ts
 *
 * Tests runImplementPipeline() with faked AdaptiveCoordinatorDeps.
 * All I/O is injected -- no HTTP calls, no exec calls, no filesystem access.
 *
 * Key invariants verified:
 * - Pitch archival called on success
 * - Pitch archival called when coding session spawn fails (finally block)
 * - UX gate dispatched when goal contains UI keywords
 * - Escalation returned on coding session failure
 * - Fix loop cap at exactly 2 iterations
 */

import { describe, it, expect, vi } from 'vitest';
import { ok as nok } from 'neverthrow';
import {
  runImplementPipeline,
  touchesUI,
} from '../../src/coordinators/modes/implement.js';
import { runAuditChain } from '../../src/coordinators/modes/implement-shared.js';
import { buildDepBumpGoal } from '../../src/coordinators/modes/quick-review.js';
import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts } from '../../src/coordinators/adaptive-pipeline.js';
import type { AwaitResult } from '../../src/cli/commands/worktrain-await.js';
import { ok, err } from '../../src/runtime/result.js';

// ═══════════════════════════════════════════════════════════════════════════
// Fake builders
// ═══════════════════════════════════════════════════════════════════════════

let sessionCounter = 0;
function nextHandle(): string {
  return `session-handle-${++sessionCounter}`;
}

function makeSuccessAwait(handle: string, durationMs = 5000): AwaitResult {
  return {
    results: [{ handle, outcome: 'success', status: 'completed', durationMs }],
    allSucceeded: true,
  };
}

function makeFailedAwait(handle: string): AwaitResult {
  return {
    results: [{ handle, outcome: 'failed', status: 'failed', durationMs: 1000 }],
    allSucceeded: false,
  };
}

function makeTimeoutAwait(handle: string): AwaitResult {
  return {
    results: [{ handle, outcome: 'timeout', status: null, durationMs: 65000 }],
    allSucceeded: false,
  };
}

/**
 * Build a getAgentResult mock that produces:
 * - Call 1 (coding): long notes (>50 chars) so quality gate passes, no artifact
 * - Calls 2+ (review/fix): the provided reviewBehavior
 */
function makePhaseAwareAgentResult(
  reviewBehavior: () => { recapMarkdown: string; artifacts: unknown[] },
): ReturnType<typeof vi.fn> {
  let callCount = 0;
  return vi.fn().mockImplementation(async () => {
    callCount++;
    if (callCount === 1) {
      // First call = coding phase -- must return long notes so quality gate passes
      return { recapMarkdown: 'Coding completed successfully. All implementation steps finished. Output is ready for review.', artifacts: [] };
    }
    return reviewBehavior();
  });
}

/**
 * Build a minimal fake AdaptiveCoordinatorDeps.
 * Override specific methods to test different scenarios.
 */
function makeFakeDeps(overrides: Partial<AdaptiveCoordinatorDeps> = {}): AdaptiveCoordinatorDeps {
  const deps: AdaptiveCoordinatorDeps = {
    spawnSession: vi.fn().mockResolvedValue(ok(nextHandle())),
    awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => {
      const handle = handles[0] ?? 'default-handle';
      return makeSuccessAwait(handle);
    }),
    // Default: coding phase returns partial output (long notes, no artifact);
    // review/fix phases return clean verdict via keyword scan.
    getAgentResult: makePhaseAwareAgentResult(() => ({
      recapMarkdown: 'APPROVE -- LGTM. No findings.',
      artifacts: [],
    })),
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
    generateId: () => 'test-id-' + Math.random().toString(36).slice(2),
    fileExists: vi.fn().mockReturnValue(false),
    archiveFile: vi.fn().mockResolvedValue(undefined),
    pollForPR: vi.fn().mockResolvedValue('https://github.com/org/repo/pull/42'),
    postToOutbox: vi.fn().mockResolvedValue(undefined),
    pollOutboxAck: vi.fn().mockResolvedValue('acked'),
    getChildSessionResult: vi.fn().mockResolvedValue({ kind: 'success', notes: 'LGTM.', artifacts: [] }),
    spawnAndAwait: vi.fn().mockResolvedValue({ kind: 'success', notes: 'LGTM.', artifacts: [] }),
    // Living work context
    generateRunId: vi.fn().mockReturnValue('test-run-id'),
    readActiveRunId: vi.fn().mockResolvedValue(nok(null)),
    readPipelineContext: vi.fn().mockResolvedValue(nok(null)),
    createPipelineContext: vi.fn().mockResolvedValue(nok(undefined)),
    markPipelineRunComplete: vi.fn().mockResolvedValue(nok(undefined)),
    writePhaseRecord: vi.fn().mockResolvedValue(nok(undefined)),
    ...overrides,
  };
  return deps;
}

function makeOpts(goal = 'Implement auth feature'): AdaptivePipelineOpts {
  return {
    workspace: '/workspace',
    goal,
    dryRun: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// touchesUI -- pure helper
// ═══════════════════════════════════════════════════════════════════════════

describe('touchesUI', () => {
  it('returns true for "ui" keyword', () => {
    expect(touchesUI('Add a new UI component')).toBe(true);
  });

  it('returns true for "screen" keyword', () => {
    expect(touchesUI('Build the login screen')).toBe(true);
  });

  it('returns true for "component" keyword', () => {
    expect(touchesUI('Create a Button component')).toBe(true);
  });

  it('returns true for "design" keyword', () => {
    expect(touchesUI('Design the checkout flow')).toBe(true);
  });

  it('returns true for "ux" keyword', () => {
    expect(touchesUI('Improve ux for mobile')).toBe(true);
  });

  it('returns true for "frontend" keyword', () => {
    expect(touchesUI('Refactor the frontend state management')).toBe(true);
  });

  it('returns false for backend goal', () => {
    expect(touchesUI('Implement OAuth refresh token rotation')).toBe(false);
  });

  it('returns false for generic coding goal', () => {
    expect(touchesUI('Add database migration for users table')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(touchesUI('Add a UI modal')).toBe(true);
    expect(touchesUI('Add a ui modal')).toBe(true);
    expect(touchesUI('Add a UI modal'.toUpperCase())).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runImplementPipeline -- pitch archival
// ═══════════════════════════════════════════════════════════════════════════

describe('runImplementPipeline - pitch archival', () => {
  it('archives pitch.md on successful pipeline run', async () => {
    const deps = makeFakeDeps();
    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('merged');
    expect(deps.archiveFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.archiveFile).mock.calls[0]![0]).toBe('/workspace/.workrail/current-pitch.md');
    expect(vi.mocked(deps.archiveFile).mock.calls[0]![1]).toContain('used-pitches/pitch-');
  });

  it('archives pitch.md even when coding session spawn fails (finally block)', async () => {
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockResolvedValue(err('connection refused')),
    });

    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('escalated');
    // Pitch archival must still happen even though the coding session failed
    expect(deps.archiveFile).toHaveBeenCalledTimes(1);
  });

  it('archives pitch.md even when coding session times out', async () => {
    let spawnCount = 0;
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => {
        spawnCount++;
        return ok(`handle-${spawnCount}`);
      }),
      awaitSessions: vi.fn().mockResolvedValue(makeTimeoutAwait('handle-1')),
    });

    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('escalated');
    expect(deps.archiveFile).toHaveBeenCalledTimes(1);
  });

  it('logs a warning if archiveFile throws but does not change the outcome', async () => {
    const deps = makeFakeDeps({
      archiveFile: vi.fn().mockRejectedValue(new Error('disk full')),
    });

    // Pipeline should succeed even if archive fails
    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('merged');
    expect(deps.stderr).toHaveBeenCalledWith(
      expect.stringContaining('Failed to archive pitch.md'),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runImplementPipeline -- UX gate
// ═══════════════════════════════════════════════════════════════════════════

describe('runImplementPipeline - UX gate', () => {
  it('dispatches wr.ui-ux-design when goal contains UI keywords', async () => {
    const spawnGoals: string[] = [];
    const spawnWorkflows: string[] = [];

    let spawnCount = 0;
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string, goal: string) => {
        spawnWorkflows.push(workflowId);
        spawnGoals.push(goal);
        return ok(`handle-${++spawnCount}`);
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => {
        return makeSuccessAwait(handles[0]!);
      }),
    });

    await runImplementPipeline(deps, makeOpts('Build the login screen with proper UX'), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(spawnWorkflows).toContain('wr.ui-ux-design');
  });

  it('does NOT dispatch UX workflow for non-UI goal', async () => {
    const spawnWorkflows: string[] = [];
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string) => {
        spawnWorkflows.push(workflowId);
        return ok(`handle-${Math.random()}`);
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => {
        return makeSuccessAwait(handles[0]!);
      }),
    });

    await runImplementPipeline(deps, makeOpts('Implement OAuth token refresh'), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(spawnWorkflows).not.toContain('wr.ui-ux-design');
  });

  it('escalates if UX gate spawn fails', async () => {
    let spawnCount = 0;
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string) => {
        spawnCount++;
        if (workflowId === 'wr.ui-ux-design') {
          return err('ui workflow not found');
        }
        return ok(`handle-${spawnCount}`);
      }),
    });

    const outcome = await runImplementPipeline(deps, makeOpts('Build new UI screen'), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') {
      expect(outcome.escalationReason.phase).toBe('ux-gate');
    }
    // Still archives pitch even on UX gate failure
    expect(deps.archiveFile).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runImplementPipeline -- coding session escalation
// ═══════════════════════════════════════════════════════════════════════════

describe('runImplementPipeline - coding session', () => {
  it('escalates with phase=coding when coding session spawn fails', async () => {
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockResolvedValue(err('daemon not running')),
    });

    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') {
      expect(outcome.escalationReason.phase).toBe('coding');
    }
  });

  it('escalates with phase=coding when coding session times out', async () => {
    let spawnCount = 0;
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => ok(`h${++spawnCount}`)),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => {
        return makeTimeoutAwait(handles[0]!);
      }),
    });

    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') {
      expect(outcome.escalationReason.phase).toBe('coding');
      expect(outcome.escalationReason.reason).toContain('timeout');
    }
  });

  it('escalates when no PR is found after coding session', async () => {
    let spawnCount = 0;
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => ok(`h${++spawnCount}`)),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      pollForPR: vi.fn().mockResolvedValue(null), // no PR found
    });

    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') {
      expect(outcome.escalationReason.phase).toBe('pr-detection');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runImplementPipeline -- fix loop cap
// ═══════════════════════════════════════════════════════════════════════════

describe('runImplementPipeline - fix loop cap', () => {
  it('escalates after exactly 2 fix iterations with minor verdict', async () => {
    // Review always returns 'minor' verdict
    const minorNotes = 'Some MINOR findings found. NIT: missing test.';
    let spawnCount = 0;

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => ok(`h${++spawnCount}`)),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: makePhaseAwareAgentResult(() => ({ recapMarkdown: minorNotes, artifacts: [] })),
    });

    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') {
      expect(outcome.escalationReason.phase).toBe('fix-loop');
      expect(outcome.escalationReason.reason).toContain('2 fix iterations exhausted');
    }

    // postToOutbox called when fix loop exhausted
    expect(deps.postToOutbox).toHaveBeenCalledWith(
      expect.stringContaining('fix loop exhausted'),
      expect.any(Object),
    );
  });

  it('merges on clean verdict after first fix iteration', async () => {
    let reviewCount = 0;
    let spawnCount = 0;

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => ok(`h${++spawnCount}`)),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: makePhaseAwareAgentResult(() => {
        reviewCount++;
        if (reviewCount === 1) return { recapMarkdown: 'MINOR findings: missing test', artifacts: [] };
        return { recapMarkdown: 'APPROVE -- LGTM, all findings addressed', artifacts: [] };
      }),
    });

    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('merged');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runImplementPipeline -- spawn cutoff
// ═══════════════════════════════════════════════════════════════════════════

describe('runImplementPipeline - spawn cutoff', () => {
  it('escalates on coding spawn if coordinator elapsed > 150 minutes', async () => {
    const pastStart = Date.now() - 151 * 60 * 1000; // 151 minutes ago
    const deps = makeFakeDeps();

    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', pastStart);

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') {
      expect(outcome.escalationReason.reason).toContain('coordinator elapsed');
    }
    // No spawn should have been attempted
    expect(deps.spawnSession).not.toHaveBeenCalledWith('wr.coding-task', expect.any(String), expect.any(String), expect.any(Object));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runImplementPipeline -- happy path
// ═══════════════════════════════════════════════════════════════════════════

describe('runImplementPipeline - happy path', () => {
  it('returns merged outcome when review is clean', async () => {
    let spawnCount = 0;
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => ok(`h${++spawnCount}`)),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: makePhaseAwareAgentResult(() => ({ recapMarkdown: 'APPROVE -- LGTM. No findings.', artifacts: [] })),
    });

    const outcome = await runImplementPipeline(deps, makeOpts(), '/workspace/.workrail/current-pitch.md', Date.now());

    expect(outcome.kind).toBe('merged');
    if (outcome.kind === 'merged') {
      expect(outcome.prUrl).toBeTruthy();
    }
    // wr.coding-task was spawned with pitchPath in context
    expect(deps.spawnSession).toHaveBeenCalledWith(
      'wr.coding-task',
      expect.any(String),
      '/workspace',
      expect.objectContaining({ pitchPath: '/workspace/.workrail/current-pitch.md' }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runAuditChain -- escalating audit chain for blocking/critical findings
// ═══════════════════════════════════════════════════════════════════════════

describe('runAuditChain', () => {
  it('dispatches wr.production-readiness-audit when review returns blocking', async () => {
    const spawnedWorkflows: string[] = [];
    let spawnCount = 0;

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string) => {
        spawnedWorkflows.push(workflowId);
        return ok(`h${++spawnCount}`);
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      // Re-review after audit returns clean so we can verify the audit was dispatched
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: 'APPROVE -- LGTM. All findings addressed.',
        artifacts: [],
      }),
    });

    const opts: AdaptivePipelineOpts = { workspace: '/workspace', goal: 'Fix auth bug', dryRun: false };
    await runAuditChain(deps, opts, 'https://github.com/org/repo/pull/42', Date.now(), 'blocking');

    // Must dispatch wr.production-readiness-audit as the audit workflow
    expect(spawnedWorkflows).toContain('wr.production-readiness-audit');
    expect(deps.spawnSession).toHaveBeenCalledWith(
      'wr.production-readiness-audit',
      expect.any(String),
      '/workspace',
      expect.objectContaining({ prUrl: 'https://github.com/org/repo/pull/42', severity: 'blocking' }),
    );
  });

  it('merges PR when post-audit re-review returns clean verdict', async () => {
    let spawnCount = 0;

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => ok(`h${++spawnCount}`)),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockResolvedValue({
        // No blocking keywords -- 'APPROVE' and 'LGTM' are clean signals
        recapMarkdown: 'APPROVE -- LGTM. All findings addressed and verified.',
        artifacts: [],
      }),
    });

    const opts: AdaptivePipelineOpts = { workspace: '/workspace', goal: 'Fix auth bug', dryRun: false };
    const outcome = await runAuditChain(deps, opts, 'https://github.com/org/repo/pull/42', Date.now(), 'blocking');

    expect(outcome.kind).toBe('merged');
    if (outcome.kind === 'merged') {
      expect(outcome.prUrl).toBe('https://github.com/org/repo/pull/42');
    }
    // Must NOT post the do-not-merge escalation when verdict is clean
    expect(deps.postToOutbox).not.toHaveBeenCalledWith(
      expect.stringContaining('Do NOT auto-merge'),
      expect.any(Object),
    );
  });

  it('escalates to Human Outbox and does NOT merge when post-audit re-review is still blocking', async () => {
    let spawnCount = 0;

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => ok(`h${++spawnCount}`)),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      // Post-audit re-review still returns blocking
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: 'CRITICAL findings remain: SQL injection vulnerability not resolved.',
        artifacts: [],
      }),
    });

    const opts: AdaptivePipelineOpts = { workspace: '/workspace', goal: 'Fix auth bug', dryRun: false };
    const outcome = await runAuditChain(deps, opts, 'https://github.com/org/repo/pull/42', Date.now(), 'blocking');

    // Must NOT merge
    expect(outcome.kind).toBe('escalated');
    // Must post to Human Outbox: message indicates human review required, metadata has do-not-merge note
    expect(deps.postToOutbox).toHaveBeenCalledWith(
      expect.stringContaining('human review'),
      expect.objectContaining({
        prUrl: 'https://github.com/org/repo/pull/42',
        note: 'Do NOT auto-merge. Human review required.',
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runAuditChain -- findingCategory routing
// ═══════════════════════════════════════════════════════════════════════════

describe('runAuditChain - findingCategory routing', () => {
  it('routes to wr.architecture-scalability-audit when any finding has findingCategory=architecture', async () => {
    const spawnedWorkflows: string[] = [];
    let spawnCount = 0;

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string) => {
        spawnedWorkflows.push(workflowId);
        return ok(`h${++spawnCount}`);
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: 'APPROVE -- LGTM. Architecture fixed.',
        artifacts: [],
      }),
    });

    const opts: AdaptivePipelineOpts = { workspace: '/workspace', goal: 'Fix arch issue', dryRun: false };
    const findings = [{ severity: 'critical' as const, summary: 'Tight coupling in auth module', findingCategory: 'architecture' as const }];
    await runAuditChain(deps, opts, 'https://github.com/org/repo/pull/42', Date.now(), 'blocking', findings);

    expect(spawnedWorkflows).toContain('wr.architecture-scalability-audit');
    expect(spawnedWorkflows).not.toContain('wr.production-readiness-audit');
  });

  it('routes to wr.production-readiness-audit when findingCategory is security', async () => {
    const spawnedWorkflows: string[] = [];
    let spawnCount = 0;

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string) => {
        spawnedWorkflows.push(workflowId);
        return ok(`h${++spawnCount}`);
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: 'APPROVE -- LGTM. Security issue fixed.',
        artifacts: [],
      }),
    });

    const opts: AdaptivePipelineOpts = { workspace: '/workspace', goal: 'Fix security issue', dryRun: false };
    const findings = [{ severity: 'critical' as const, summary: 'SQL injection risk', findingCategory: 'security' as const }];
    await runAuditChain(deps, opts, 'https://github.com/org/repo/pull/42', Date.now(), 'blocking', findings);

    expect(spawnedWorkflows).toContain('wr.production-readiness-audit');
    expect(spawnedWorkflows).not.toContain('wr.architecture-scalability-audit');
  });

  it('routes to wr.production-readiness-audit (safe default) when findingCategory is missing', async () => {
    const spawnedWorkflows: string[] = [];
    let spawnCount = 0;

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string) => {
        spawnedWorkflows.push(workflowId);
        return ok(`h${++spawnCount}`);
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: 'APPROVE -- LGTM. Issues fixed.',
        artifacts: [],
      }),
    });

    const opts: AdaptivePipelineOpts = { workspace: '/workspace', goal: 'Fix issue', dryRun: false };
    // findings items have no findingCategory (optional field omitted)
    const findings = [{ severity: 'critical' as const, summary: 'Some critical finding' }];
    await runAuditChain(deps, opts, 'https://github.com/org/repo/pull/42', Date.now(), 'blocking', findings);

    expect(spawnedWorkflows).toContain('wr.production-readiness-audit');
    expect(spawnedWorkflows).not.toContain('wr.architecture-scalability-audit');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildDepBumpGoal -- pure helper from quick-review.ts
// ═══════════════════════════════════════════════════════════════════════════

describe('buildDepBumpGoal', () => {
  it('includes [DEP BUMP] prefix', () => {
    const goal = buildDepBumpGoal([123], 'bump lodash from 4.17.20 to 4.17.21');
    expect(goal).toMatch(/^\[DEP BUMP\]/);
  });

  it('includes PR number', () => {
    const goal = buildDepBumpGoal([99], 'bump react to 18.2.0');
    expect(goal).toContain('PR #99');
  });

  it('includes skip architecture audit instruction', () => {
    const goal = buildDepBumpGoal([1], 'bump dep');
    expect(goal).toContain('skip architecture audit');
    expect(goal).toContain('version compatibility');
  });
});
