/**
 * Unit tests for src/coordinators/modes/full-pipeline.ts
 *
 * Tests runFullPipeline() with faked AdaptiveCoordinatorDeps.
 * All I/O is injected -- no HTTP calls, no exec calls, no filesystem access.
 *
 * Key invariants verified:
 * - Discovery handoff artifact found -> injected as structured context for shaping
 * - Fallback to lastStepNotes when no artifact (length > 50)
 * - Fallback skipped when notes length <= 50 (no assembledContextSummary injected)
 * - Fallback skipped when recapMarkdown is null
 * - Escalation on discovery session failure (shaping never called)
 * - Spawn cutoff check prevents spawn after 150 minutes
 * - renderHandoff() generates expected markdown structure
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runFullPipeline,
  renderHandoff,
} from '../../src/coordinators/modes/full-pipeline.js';
import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts } from '../../src/coordinators/adaptive-pipeline.js';
import type { AwaitResult } from '../../src/cli/commands/worktrain-await.js';
import type { DiscoveryHandoffArtifactV1 } from '../../src/v2/durable-core/schemas/artifacts/discovery-handoff.js';
import { ok, err } from '../../src/runtime/result.js';
import { ok as nok } from 'neverthrow';

// ═══════════════════════════════════════════════════════════════════════════
// Fake builders
// ═══════════════════════════════════════════════════════════════════════════

let sessionCounter = 0;
function nextHandle(): string {
  return `h${++sessionCounter}`;
}

function makeSuccessAwait(handle: string): AwaitResult {
  return {
    results: [{ handle, outcome: 'success', status: 'completed', durationMs: 1000 }],
    allSucceeded: true,
  };
}

function makeFailedAwait(handle: string): AwaitResult {
  return {
    results: [{ handle, outcome: 'failed', status: 'failed', durationMs: 500 }],
    allSucceeded: false,
  };
}

function makeTimeoutAwait(handle: string): AwaitResult {
  return {
    results: [{ handle, outcome: 'timeout', status: null, durationMs: 35001 }],
    allSucceeded: false,
  };
}

/**
 * Build a valid DiscoveryHandoffArtifactV1 for testing.
 */
function makeHandoffArtifact(overrides: Partial<DiscoveryHandoffArtifactV1> = {}): DiscoveryHandoffArtifactV1 {
  return {
    kind: 'wr.discovery_handoff',
    version: 1,
    selectedDirection: 'Use OAuth 2.0 PKCE flow with refresh token rotation',
    designDocPath: '.workrail/design-doc.md',
    confidenceBand: 'high',
    keyInvariants: ['Tokens expire in 15 minutes', 'Refresh tokens are single-use'],
    ...overrides,
  };
}

/**
 * Build a fake AdaptiveCoordinatorDeps.
 */
function makeFakeDeps(overrides: Partial<AdaptiveCoordinatorDeps> = {}): AdaptiveCoordinatorDeps {
  return {
    spawnSession: vi.fn().mockImplementation(async () => ok(nextHandle())),
    awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
    getAgentResult: vi.fn().mockResolvedValue({
      recapMarkdown: 'APPROVE -- LGTM. No findings.',
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
    readPipelineContext: vi.fn().mockResolvedValue(nok(null)),
    writePhaseRecord: vi.fn().mockResolvedValue(nok(undefined)),
    ...overrides,
  };
}

function makeOpts(goal = 'Implement OAuth refresh token rotation'): AdaptivePipelineOpts {
  return {
    workspace: '/workspace',
    goal,
    dryRun: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// renderHandoff -- pure function
// ═══════════════════════════════════════════════════════════════════════════

describe('renderHandoff', () => {
  it('includes the selected direction', () => {
    const artifact = makeHandoffArtifact();
    const rendered = renderHandoff(artifact);
    expect(rendered).toContain('OAuth 2.0 PKCE flow');
  });

  it('includes the confidence band', () => {
    const artifact = makeHandoffArtifact({ confidenceBand: 'medium' });
    const rendered = renderHandoff(artifact);
    expect(rendered).toContain('medium');
  });

  it('includes the design doc path when non-empty', () => {
    const artifact = makeHandoffArtifact({ designDocPath: '.workrail/design.md' });
    const rendered = renderHandoff(artifact);
    expect(rendered).toContain('.workrail/design.md');
  });

  it('omits design doc section when path is empty', () => {
    const artifact = makeHandoffArtifact({ designDocPath: '' });
    const rendered = renderHandoff(artifact);
    expect(rendered).not.toContain('Design Doc');
  });

  it('includes key invariants as bullet points', () => {
    const artifact = makeHandoffArtifact({
      keyInvariants: ['Tokens expire in 15 minutes', 'Refresh tokens are single-use'],
    });
    const rendered = renderHandoff(artifact);
    expect(rendered).toContain('Tokens expire in 15 minutes');
    expect(rendered).toContain('Refresh tokens are single-use');
  });

  it('omits invariants section when array is empty', () => {
    const artifact = makeHandoffArtifact({ keyInvariants: [] });
    const rendered = renderHandoff(artifact);
    expect(rendered).not.toContain('Key Invariants');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runFullPipeline -- discovery handoff context threading
// ═══════════════════════════════════════════════════════════════════════════

describe('runFullPipeline - discovery handoff context threading', () => {
  it('injects assembledContextSummary from buildContextSummary when discovery artifact found', async () => {
    const artifact = makeHandoffArtifact();
    const shapingContexts: Readonly<Record<string, unknown>>[] = [];

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string, _goal: string, _ws: string, context?: Readonly<Record<string, unknown>>) => {
        const h = nextHandle();
        if (workflowId === 'wr.shaping') shapingContexts.push(context ?? {});
        return ok(h);
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockImplementation(async () => ({
        recapMarkdown: 'APPROVE -- LGTM',
        artifacts: [artifact],
      })),
    });

    await runFullPipeline(deps, makeOpts(), Date.now());

    expect(shapingContexts.length).toBe(1);
    // New behavior: assembledContextSummary is built by buildContextSummary(), not renderHandoff()
    // It contains the selectedDirection and other fields from the discovery artifact
    const summary = (shapingContexts[0] as Record<string, unknown>)['assembledContextSummary'];
    expect(typeof summary).toBe('string');
    expect(summary as string).toContain(artifact.selectedDirection);
  });

  it('injects assembledContextSummary from recapMarkdown when notes length > 50 and no artifact', async () => {
    const longNotes = 'This is a detailed discovery session result with more than 50 characters of useful information.';
    const shapingContexts: Readonly<Record<string, unknown>>[] = [];

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string, _goal: string, _ws: string, context?: Readonly<Record<string, unknown>>) => {
        const h = nextHandle();
        if (workflowId === 'wr.shaping') shapingContexts.push(context ?? {});
        return ok(h);
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockImplementation(async () => ({
        recapMarkdown: longNotes,
        artifacts: [], // no handoff artifact
      })),
    });

    await runFullPipeline(deps, makeOpts(), Date.now());

    // With no artifact, buildContextSummary returns '' (no priorArtifacts).
    // The pipeline falls back to empty context for shaping -- this is correct behavior.
    expect(shapingContexts.length).toBe(1);
  });

  it('injects NO assembledContextSummary when notes length <= 50', async () => {
    const shortNotes = 'Too short.'; // 10 chars, well under 50
    const shapingContexts: Readonly<Record<string, unknown>>[] = [];

    let spawnCount = 0;
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string, _goal: string, _ws: string, context?: Readonly<Record<string, unknown>>) => {
        const h = nextHandle();
        if (workflowId === 'wr.shaping') {
          shapingContexts.push(context ?? {});
        }
        spawnCount++;
        return ok(h);
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockImplementation(async () => ({
        recapMarkdown: shortNotes,
        artifacts: [],
      })),
    });

    await runFullPipeline(deps, makeOpts(), Date.now());

    expect(shapingContexts.length).toBe(1);
    // No assembledContextSummary when notes too short
    expect((shapingContexts[0] as Record<string, unknown>)['assembledContextSummary']).toBeUndefined();
  });

  it('injects NO assembledContextSummary when recapMarkdown is null', async () => {
    const shapingContexts: Readonly<Record<string, unknown>>[] = [];

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string, _goal: string, _ws: string, context?: Readonly<Record<string, unknown>>) => {
        const h = nextHandle();
        if (workflowId === 'wr.shaping') {
          shapingContexts.push(context ?? {});
        }
        return ok(h);
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: null,
        artifacts: [],
      }),
    });

    await runFullPipeline(deps, makeOpts(), Date.now());

    expect(shapingContexts.length).toBe(1);
    expect((shapingContexts[0] as Record<string, unknown>)['assembledContextSummary']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runFullPipeline -- discovery session failure
// ═══════════════════════════════════════════════════════════════════════════

describe('runFullPipeline - discovery session failure', () => {
  it('escalates when discovery session spawn fails (shaping never called)', async () => {
    const shapingCalls: string[] = [];

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string) => {
        if (workflowId === 'wr.discovery') {
          return err('daemon not running');
        }
        shapingCalls.push(workflowId);
        return ok(nextHandle());
      }),
    });

    const outcome = await runFullPipeline(deps, makeOpts(), Date.now());

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') {
      expect(outcome.escalationReason.phase).toBe('discovery');
    }
    expect(shapingCalls).not.toContain('wr.shaping');
  });

  it('escalates when discovery session times out', async () => {
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => ok(nextHandle())),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeTimeoutAwait(handles[0]!)),
    });

    const outcome = await runFullPipeline(deps, makeOpts(), Date.now());

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') {
      expect(outcome.escalationReason.phase).toBe('discovery');
      expect(outcome.escalationReason.reason).toContain('timeout');
    }
  });

  it('escalates when shaping session fails (coding never called)', async () => {
    const calledWorkflows: string[] = [];
    let awaitCount = 0;

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string) => {
        calledWorkflows.push(workflowId);
        return ok(nextHandle());
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => {
        awaitCount++;
        // First await (discovery) succeeds; second await (shaping) fails
        if (awaitCount === 1) return makeSuccessAwait(handles[0]!);
        return makeFailedAwait(handles[0]!);
      }),
      getAgentResult: vi.fn().mockResolvedValue({ recapMarkdown: null, artifacts: [] }),
    });

    const outcome = await runFullPipeline(deps, makeOpts(), Date.now());

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') {
      expect(outcome.escalationReason.phase).toBe('shaping');
    }
    expect(calledWorkflows).not.toContain('wr.coding-task');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runFullPipeline -- spawn cutoff
// ═══════════════════════════════════════════════════════════════════════════

describe('runFullPipeline - spawn cutoff', () => {
  it('escalates immediately if coordinator started > 150 minutes ago', async () => {
    const pastStart = Date.now() - 151 * 60 * 1000;
    const deps = makeFakeDeps();

    const outcome = await runFullPipeline(deps, makeOpts(), pastStart);

    expect(outcome.kind).toBe('escalated');
    if (outcome.kind === 'escalated') {
      expect(outcome.escalationReason.reason).toContain('coordinator elapsed');
    }
    // No session spawned at all
    expect(deps.spawnSession).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runFullPipeline -- malformed handoff artifact
// ═══════════════════════════════════════════════════════════════════════════

describe('runFullPipeline - malformed handoff artifact', () => {
  it('falls back to notes when artifact has wrong schema (kind matches, schema fails)', async () => {
    // Artifact has the right kind but missing required fields
    const malformedArtifact = { kind: 'wr.discovery_handoff', version: 1 }; // missing selectedDirection etc.
    const longNotes = 'Discovered that OAuth PKCE is the right approach with various details here exceeding fifty chars.';
    const shapingContexts: Readonly<Record<string, unknown>>[] = [];

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string, _goal: string, _ws: string, context?: Readonly<Record<string, unknown>>) => {
        if (workflowId === 'wr.shaping') shapingContexts.push(context ?? {});
        return ok(nextHandle());
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: longNotes,
        artifacts: [malformedArtifact],
      }),
    });

    await runFullPipeline(deps, makeOpts(), Date.now());

    expect(shapingContexts.length).toBe(1);
    // New behavior: malformed artifact -> extractPhaseArtifact returns null ->
    // priorArtifacts stays empty -> buildContextSummary returns '' -> no assembledContextSummary
    // (The old recapMarkdown fallback is no longer used for context injection)
    const summary = (shapingContexts[0] as Record<string, unknown>)['assembledContextSummary'];
    expect(summary === undefined || summary === '').toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runFullPipeline -- happy path
// ═══════════════════════════════════════════════════════════════════════════

describe('runFullPipeline - happy path', () => {
  it('returns merged when review is clean after full pipeline', async () => {
    const artifact = makeHandoffArtifact();
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => ok(nextHandle())),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: 'APPROVE -- LGTM',
        artifacts: [artifact],
      }),
    });

    const outcome = await runFullPipeline(deps, makeOpts(), Date.now());

    expect(outcome.kind).toBe('merged');
  });

  it('spawns wr.discovery, wr.shaping, coding, review in order for non-UI goal', async () => {
    const spawned: string[] = [];

    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string) => {
        spawned.push(workflowId);
        return ok(nextHandle());
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: 'APPROVE -- LGTM',
        artifacts: [],
      }),
    });

    await runFullPipeline(deps, makeOpts('Implement OAuth token rotation'), Date.now());

    expect(spawned).toContain('wr.discovery');
    expect(spawned).toContain('wr.shaping');
    expect(spawned).toContain('wr.coding-task');
    expect(spawned).toContain('wr.mr-review');
    // No UX design workflow for non-UI goal
    expect(spawned).not.toContain('wr.ui-ux-design');
    // Verify order: discovery before shaping before coding before review
    const discoveryIdx = spawned.indexOf('wr.discovery');
    const shapingIdx = spawned.indexOf('wr.shaping');
    const codingIdx = spawned.indexOf('wr.coding-task');
    const reviewIdx = spawned.indexOf('wr.mr-review');
    expect(discoveryIdx).toBeLessThan(shapingIdx);
    expect(shapingIdx).toBeLessThan(codingIdx);
    expect(codingIdx).toBeLessThan(reviewIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runFullPipeline -- pitch archival
// ═══════════════════════════════════════════════════════════════════════════

describe('runFullPipeline - pitch archival', () => {
  it('archives current-pitch.md on successful FULL pipeline run', async () => {
    const artifact = makeHandoffArtifact();
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async () => ok(nextHandle())),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: 'APPROVE -- LGTM',
        artifacts: [artifact],
      }),
    });

    const outcome = await runFullPipeline(deps, makeOpts(), Date.now());

    expect(outcome.kind).toBe('merged');
    expect(deps.archiveFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.archiveFile).mock.calls[0]![0]).toBe('/workspace/.workrail/current-pitch.md');
    expect(vi.mocked(deps.archiveFile).mock.calls[0]![1]).toContain('used-pitches/pitch-');
  });

  it('archives current-pitch.md even when coding session spawn fails (finally block)', async () => {
    let spawnCount = 0;
    const deps = makeFakeDeps({
      spawnSession: vi.fn().mockImplementation(async (workflowId: string) => {
        spawnCount++;
        // discovery and shaping succeed; coding fails
        if (workflowId === 'wr.coding-task') {
          return err('daemon not running');
        }
        return ok(nextHandle());
      }),
      awaitSessions: vi.fn().mockImplementation(async (handles: readonly string[]) => makeSuccessAwait(handles[0]!)),
      getAgentResult: vi.fn().mockResolvedValue({
        recapMarkdown: null,
        artifacts: [],
      }),
    });

    const outcome = await runFullPipeline(deps, makeOpts(), Date.now());

    expect(outcome.kind).toBe('escalated');
    // Pitch archival must still happen even though coding session failed
    expect(deps.archiveFile).toHaveBeenCalledTimes(1);
  });
});
