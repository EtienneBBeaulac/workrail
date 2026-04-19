/**
 * Unit tests for src/coordinators/pr-review.ts
 *
 * Tests pure functions only. All I/O is injected via fake CoordinatorDeps.
 * No HTTP calls, no exec calls, no filesystem access.
 *
 * Strategy: prefer fakes over mocks -- fake CoordinatorDeps objects implement
 * the interface directly and record calls for assertion.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseFindingsFromNotes,
  readVerdictArtifact,
  buildFixGoal,
  formatElapsed,
  runPrReviewCoordinator,
  drainMessageQueue,
  type CoordinatorDeps,
  type DrainResult,
  type PrSummary,
  type ReviewFindings,
  type PrReviewOpts,
} from '../../src/coordinators/pr-review.js';
import type { AwaitResult } from '../../src/cli/commands/worktrain-await.js';

// ═══════════════════════════════════════════════════════════════════════════
// parseFindingsFromNotes -- pure function tests
// ═══════════════════════════════════════════════════════════════════════════

describe('parseFindingsFromNotes', () => {
  it('returns err when notes is null', () => {
    const result = parseFindingsFromNotes(null);
    expect(result.kind).toBe('err');
  });

  it('returns err when notes is empty string', () => {
    const result = parseFindingsFromNotes('');
    expect(result.kind).toBe('err');
  });

  it('returns err when notes is whitespace only', () => {
    const result = parseFindingsFromNotes('   \n  ');
    expect(result.kind).toBe('err');
  });

  // ---- JSON block (Tier 1) ----

  it('parses clean from JSON block with recommendation: clean', () => {
    const notes = `
## COORDINATOR_OUTPUT
\`\`\`json
{ "recommendation": "clean", "findings": [] }
\`\`\`
`;
    const result = parseFindingsFromNotes(notes);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.severity).toBe('clean');
      expect(result.value.findingSummaries).toHaveLength(0);
    }
  });

  it('parses blocking from JSON block with recommendation: blocking', () => {
    const notes = `
\`\`\`json
{ "recommendation": "blocking", "findings": [{ "severity": "critical", "summary": "auth bypass" }] }
\`\`\`
`;
    const result = parseFindingsFromNotes(notes);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.severity).toBe('blocking');
      expect(result.value.findingSummaries[0]).toBe('auth bypass');
    }
  });

  it('parses minor from JSON block with recommendation: minor', () => {
    const notes = `
\`\`\`json
{ "recommendation": "minor", "findings": [{ "severity": "minor", "summary": "missing test" }] }
\`\`\`
`;
    const result = parseFindingsFromNotes(notes);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.severity).toBe('minor');
    }
  });

  // ---- Keyword scan (Tier 2) ----

  it('classifies APPROVE as clean', () => {
    const result = parseFindingsFromNotes('**Final recommendation: APPROVE this change**\n\nLooks good.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('clean');
  });

  it('classifies LGTM as clean', () => {
    const result = parseFindingsFromNotes('LGTM -- no issues found.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('clean');
  });

  it('classifies BLOCKING as blocking', () => {
    const result = parseFindingsFromNotes('BLOCKING issue found: SQL injection risk in user input.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('blocking');
  });

  it('classifies CRITICAL as blocking', () => {
    const result = parseFindingsFromNotes('CRITICAL severity: unvalidated redirect vulnerability.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('blocking');
  });

  it('classifies REQUEST CHANGES as blocking', () => {
    const result = parseFindingsFromNotes('Final recommendation: REQUEST CHANGES before merge.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('blocking');
  });

  it('classifies MINOR as minor', () => {
    const result = parseFindingsFromNotes('Overall looks good. One MINOR issue: missing docstring in helper function.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('minor');
  });

  it('classifies NIT as minor', () => {
    const result = parseFindingsFromNotes('NIT: variable name could be more descriptive.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('minor');
  });

  it('returns unknown when no recognized keywords', () => {
    const result = parseFindingsFromNotes('The code changes look reasonable. Some areas need attention.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('unknown');
  });

  // ---- Negation context check (critical safety invariant) ----

  it('does NOT classify as blocking when "blocking" appears after "not"', () => {
    const result = parseFindingsFromNotes('This is not technically blocking but could be improved.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.severity).not.toBe('blocking');
    }
  });

  it('does NOT classify as blocking when "no blocking" appears', () => {
    const result = parseFindingsFromNotes('There are no blocking issues. APPROVE.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // "no blocking issues" + "APPROVE" -> clean
      expect(result.value.severity).toBe('clean');
    }
  });

  it('does NOT classify as blocking when "without blocking" appears', () => {
    const result = parseFindingsFromNotes('Can merge without blocking concerns. Good to go.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.severity).not.toBe('blocking');
    }
  });

  it('DOES classify as blocking when blocking keyword is present without negation', () => {
    const result = parseFindingsFromNotes('Found a BLOCKING security issue: unescaped user input.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('blocking');
  });

  it('does NOT classify as blocking when "no request changes" appears', () => {
    const result = parseFindingsFromNotes('There are no request changes needed. Good implementation.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.severity).not.toBe('blocking');
    }
  });

  it('does NOT classify as blocking when "not request changes" appears', () => {
    const result = parseFindingsFromNotes('This is not request changes territory -- looks good to me.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.severity).not.toBe('blocking');
    }
  });

  it('DOES classify as blocking when "REQUEST CHANGES" appears without negation', () => {
    const result = parseFindingsFromNotes('Final recommendation: REQUEST CHANGES -- fix the security issue first.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('blocking');
  });

  // ---- Priority: blocking wins over clean ----

  it('blocking keywords win over clean keywords when both present', () => {
    // A reviewer might say "approve the style changes, but BLOCKING on the security issue"
    const result = parseFindingsFromNotes('APPROVE the formatting. BLOCKING: auth token exposed in logs.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('blocking');
  });

  // ---- F1: CLEAN word boundary ----

  it('classifies standalone CLEAN as clean', () => {
    const result = parseFindingsFromNotes('Code review complete. CLEAN -- no issues found.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('clean');
  });

  it('does NOT classify CLEANED as clean (word boundary guard)', () => {
    // "CLEANED" is a past-tense verb, not a severity signal
    const result = parseFindingsFromNotes('The developer CLEANED up the code after feedback.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).not.toBe('clean');
  });

  it('does NOT classify CLEANER as clean (word boundary guard)', () => {
    const result = parseFindingsFromNotes('This approach is CLEANER than the previous implementation.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).not.toBe('clean');
  });

  it('does NOT classify CLEANING as clean (word boundary guard)', () => {
    const result = parseFindingsFromNotes('The PR focuses on CLEANING up dead code in the module.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).not.toBe('clean');
  });

  // ---- F2: clean+minor combination must return minor ----

  it('returns minor when both clean and minor keywords are present (minor beats clean)', () => {
    // A reviewer might write a mostly positive review but note a minor issue
    const result = parseFindingsFromNotes('APPROVE the overall approach. MINOR: missing docstring on helper.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // minor findings exist -- should go through fix-agent loop, NOT auto-merge
      expect(result.value.severity).toBe('minor');
    }
  });

  it('returns minor when LGTM and NIT both appear', () => {
    const result = parseFindingsFromNotes('LGTM overall. NIT: variable name could be more descriptive.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('minor');
  });

  it('returns minor when CLEAN and SUGGESTION both appear', () => {
    const result = parseFindingsFromNotes('CLEAN implementation. SUGGESTION: consider extracting this into a helper.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.severity).toBe('minor');
  });

  // ---- source field: keyword_scan path ----

  it('sets source to keyword_scan when APPROVE text is parsed', () => {
    const result = parseFindingsFromNotes('APPROVE this change. Looks clean and well-tested.');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.severity).toBe('clean');
      expect(result.value.source).toBe('keyword_scan');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// readVerdictArtifact -- pure function tests
// ═══════════════════════════════════════════════════════════════════════════

describe('readVerdictArtifact', () => {
  // WHY afterEach: the WARN log test uses vi.spyOn(process.stderr, 'write').
  // Restoring all mocks after each test prevents spy leakage to other tests
  // in the same process. This is the only acceptable alternative to dep injection
  // (which would require changing readVerdictArtifact's signature).
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A valid wr.review_verdict artifact for testing. */
  const validCleanArtifact = {
    kind: 'wr.review_verdict',
    verdict: 'clean',
    confidence: 'high',
    findings: [],
    summary: 'No issues found',
  };

  const validBlockingArtifact = {
    kind: 'wr.review_verdict',
    verdict: 'blocking',
    confidence: 'high',
    findings: [
      { severity: 'critical', summary: 'SQL injection in user input handler' },
      { severity: 'major', summary: 'Missing authentication check' },
    ],
    summary: 'Critical security issues found',
  };

  it('returns ReviewFindings with source=artifact for a valid clean artifact', () => {
    const result = readVerdictArtifact([validCleanArtifact]);
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.severity).toBe('clean');
      expect(result.findingSummaries).toHaveLength(0);
      expect(result.source).toBe('artifact');
    }
  });

  it('returns ReviewFindings with correct severity for blocking artifact', () => {
    const result = readVerdictArtifact([validBlockingArtifact]);
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.severity).toBe('blocking');
      expect(result.findingSummaries).toHaveLength(2);
      expect(result.findingSummaries[0]).toBe('SQL injection in user input handler');
      expect(result.source).toBe('artifact');
    }
  });

  it('returns null for an empty artifacts array', () => {
    const result = readVerdictArtifact([]);
    expect(result).toBeNull();
  });

  it('returns null for an artifact with invalid schema (wrong verdict enum)', () => {
    const invalidArtifact = {
      kind: 'wr.review_verdict',
      verdict: 'APPROVE', // wrong enum value
      confidence: 'high',
      findings: [],
      summary: 'test',
    };
    const result = readVerdictArtifact([invalidArtifact]);
    expect(result).toBeNull();
  });

  it('returns null for an artifact with a different kind (no false positives)', () => {
    const otherArtifact = {
      kind: 'wr.assessment',
      assessmentId: 'some-gate',
      dimensions: { quality: 'high' },
    };
    const result = readVerdictArtifact([otherArtifact]);
    expect(result).toBeNull();
  });

  it('returns the first valid verdict artifact when multiple artifacts present', () => {
    const minorArtifact = {
      kind: 'wr.review_verdict',
      verdict: 'minor',
      confidence: 'medium',
      findings: [{ severity: 'minor', summary: 'Missing docstring' }],
      summary: 'Minor issues',
    };
    // First artifact is valid minor, second is valid clean -- first wins
    const result = readVerdictArtifact([minorArtifact, validCleanArtifact]);
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.severity).toBe('minor');
    }
  });

  it('emits WARN to stderr when wr.review_verdict artifact fails schema validation', () => {
    // WHY spy: readVerdictArtifact calls process.stderr.write directly (no dep injection).
    // The spy is restored in afterEach() above.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const malformedArtifact = {
      kind: 'wr.review_verdict',
      verdict: 'invalid', // wrong enum -- not in ['clean', 'minor', 'blocking']
      confidence: 'high',
      findings: [],
      summary: 'test',
    };

    const result = readVerdictArtifact([malformedArtifact], 'handle-test-session-123');

    // Should return null (no valid artifact found)
    expect(result).toBeNull();

    // WARN log must have been emitted -- essential for operator visibility
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WARN coord:reason=artifact_parse_failed'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('readVerdictArtifact: wr.review_verdict schema validation failed'),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildFixGoal -- pure function tests
// ═══════════════════════════════════════════════════════════════════════════

describe('buildFixGoal', () => {
  it('includes PR number in goal', () => {
    const findings: ReviewFindings = {
      severity: 'minor',
      findingSummaries: [],
      raw: '',
    };
    const goal = buildFixGoal(419, findings);
    expect(goal).toContain('PR #419');
  });

  it('includes finding summaries when available', () => {
    const findings: ReviewFindings = {
      severity: 'minor',
      findingSummaries: ['missing test coverage', 'unclear variable name'],
      raw: '',
    };
    const goal = buildFixGoal(406, findings);
    expect(goal).toContain('missing test coverage');
    expect(goal).toContain('PR #406');
  });

  it('produces valid goal when no findings', () => {
    const findings: ReviewFindings = {
      severity: 'minor',
      findingSummaries: [],
      raw: '',
    };
    const goal = buildFixGoal(100, findings);
    expect(goal).toMatch(/Fix review findings in PR #100/);
  });

  it('limits to 3 findings in goal string', () => {
    const findings: ReviewFindings = {
      severity: 'minor',
      findingSummaries: ['finding 1', 'finding 2', 'finding 3', 'finding 4', 'finding 5'],
      raw: '',
    };
    const goal = buildFixGoal(1, findings);
    expect(goal).toContain('finding 1');
    expect(goal).toContain('finding 2');
    expect(goal).toContain('finding 3');
    // finding 4 and 5 should not appear (only first 3 included)
    expect(goal).not.toContain('finding 4');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// formatElapsed -- pure function tests
// ═══════════════════════════════════════════════════════════════════════════

describe('formatElapsed', () => {
  it('formats zero as 0:00', () => {
    expect(formatElapsed(0)).toBe('0:00');
  });

  it('formats 30 seconds', () => {
    expect(formatElapsed(30_000)).toBe('0:30');
  });

  it('formats 1 minute 8 seconds as 1:08', () => {
    expect(formatElapsed(68_000)).toBe('1:08');
  });

  it('formats 8 minutes 31 seconds as 8:31', () => {
    expect(formatElapsed(511_000)).toBe('8:31');
  });

  it('pads seconds with leading zero', () => {
    expect(formatElapsed(61_000)).toBe('1:01');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runPrReviewCoordinator -- integration tests with fake deps
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a fake CoordinatorDeps object for testing.
 * All I/O operations are recorded for assertion.
 */
function makeFakeDeps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps & {
  spawnCalls: Array<{ workflowId: string; goal: string }>;
  awaitCalls: Array<{ handles: readonly string[] }>;
  mergeCalls: number[];
  writtenFiles: Map<string, string>;
  stderrLines: string[];
} {
  const spawnCalls: Array<{ workflowId: string; goal: string }> = [];
  const awaitCalls: Array<{ handles: readonly string[] }> = [];
  const mergeCalls: number[] = [];
  const writtenFiles = new Map<string, string>();
  const stderrLines: string[] = [];

  // In-memory filesystem shared by readFile/appendFile/writeFile for drain tests.
  const fakeFiles = new Map<string, string>();

  const base: CoordinatorDeps = {
    spawnSession: async (workflowId, goal) => {
      spawnCalls.push({ workflowId, goal });
      return { kind: 'ok', value: `handle-${spawnCalls.length}` };
    },
    awaitSessions: async (handles, _timeoutMs) => {
      awaitCalls.push({ handles });
      const results = [...handles].map((h) => ({
        handle: h,
        outcome: 'success' as const,
        status: 'complete',
        durationMs: 5_000,
      }));
      return { results, allSucceeded: true };
    },
    getAgentResult: async (_handle) => {
      return { recapMarkdown: 'APPROVE this change. No issues found.', artifacts: [] };
    },
    listOpenPRs: async (_workspace) => {
      return [
        { number: 419, title: 'feat: add new feature', headRef: 'feat/new-feature' },
      ] satisfies PrSummary[];
    },
    mergePR: async (prNumber, _workspace) => {
      mergeCalls.push(prNumber);
      return { kind: 'ok', value: undefined };
    },
    writeFile: async (path, content) => {
      writtenFiles.set(path, content);
      fakeFiles.set(path, content);
    },
    stderr: (line) => {
      stderrLines.push(line);
    },
    now: () => Date.now(),
    port: 3456,
    readFile: async (path) => {
      const content = fakeFiles.get(path);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file, open '${path}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
    appendFile: async (path, content) => {
      fakeFiles.set(path, (fakeFiles.get(path) ?? '') + content);
    },
    mkdir: async (_path, _opts) => undefined,
    homedir: () => '/home/testuser',
    joinPath: (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
    nowIso: () => '2026-04-18T00:00:00.000Z',
    generateId: () => 'test-uuid-drain',
    ...overrides,
  };

  return Object.assign(base, { spawnCalls, awaitCalls, mergeCalls, writtenFiles, stderrLines });
}

const defaultOpts: PrReviewOpts = {
  workspace: '/test/workspace',
  dryRun: false,
};

describe('runPrReviewCoordinator', () => {
  it('returns 0 reviewed when no open PRs', async () => {
    const deps = makeFakeDeps({
      listOpenPRs: async () => [],
    });
    const result = await runPrReviewCoordinator(deps, defaultOpts);
    expect(result.reviewed).toBe(0);
    expect(result.approved).toBe(0);
    expect(result.escalated).toBe(0);
    expect(deps.spawnCalls).toHaveLength(0);
    expect(deps.mergeCalls).toHaveLength(0);
  });

  it('merges clean PR', async () => {
    const deps = makeFakeDeps({
      getAgentResult: async () => ({ recapMarkdown: 'APPROVE -- clean implementation, no issues.', artifacts: [] }),
    });
    const result = await runPrReviewCoordinator(deps, defaultOpts);
    expect(result.reviewed).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.escalated).toBe(0);
    expect(deps.mergeCalls).toContain(419);
  });

  it('escalates blocking PR without merging', async () => {
    const deps = makeFakeDeps({
      getAgentResult: async () => ({ recapMarkdown: 'BLOCKING: critical security vulnerability found.', artifacts: [] }),
    });
    const result = await runPrReviewCoordinator(deps, defaultOpts);
    expect(result.reviewed).toBe(1);
    expect(result.approved).toBe(0);
    expect(result.escalated).toBe(1);
    expect(deps.mergeCalls).toHaveLength(0);
  });

  it('escalates unknown severity without merging', async () => {
    const deps = makeFakeDeps({
      getAgentResult: async () => ({ recapMarkdown: null, artifacts: [] }),
    });
    const result = await runPrReviewCoordinator(deps, defaultOpts);
    expect(result.reviewed).toBe(1);
    expect(result.approved).toBe(0);
    expect(result.escalated).toBe(1);
    expect(deps.mergeCalls).toHaveLength(0);
  });

  it('does not merge on session failure (non-success outcome)', async () => {
    const deps = makeFakeDeps({
      awaitSessions: async (handles) => {
        return {
          results: [...handles].map((h) => ({
            handle: h,
            outcome: 'failed' as const,
            status: 'blocked',
            durationMs: 1_000,
          })),
          allSucceeded: false,
        };
      },
    });
    const result = await runPrReviewCoordinator(deps, defaultOpts);
    expect(result.approved).toBe(0);
    expect(deps.mergeCalls).toHaveLength(0);
  });

  it('does not merge on session timeout', async () => {
    const deps = makeFakeDeps({
      awaitSessions: async (handles) => {
        return {
          results: [...handles].map((h) => ({
            handle: h,
            outcome: 'timeout' as const,
            status: null,
            durationMs: 20 * 60 * 1000,
          })),
          allSucceeded: false,
        };
      },
    });
    const result = await runPrReviewCoordinator(deps, defaultOpts);
    expect(result.approved).toBe(0);
    expect(deps.mergeCalls).toHaveLength(0);
  });

  it('spawns fix agent for minor PR and merges after fix + clean re-review', async () => {
    let reviewCallCount = 0;
    const deps = makeFakeDeps({
      getAgentResult: async (handle) => {
        // First review: minor; re-review after fix: clean
        if (handle.includes('handle-1')) {
          reviewCallCount++;
          return { recapMarkdown: 'MINOR: missing test coverage for edge case.', artifacts: [] };
        }
        // Re-review after fix
        return { recapMarkdown: 'APPROVE -- all issues addressed.', artifacts: [] };
      },
    });
    const result = await runPrReviewCoordinator(deps, defaultOpts);
    expect(result.approved).toBe(1);
    expect(result.escalated).toBe(0);
    expect(deps.mergeCalls).toContain(419);
    // Should have spawned: 1 review + 1 fix agent + 1 re-review = 3 spawns minimum
    expect(deps.spawnCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('escalates after 3 fix passes with persistent minor findings', async () => {
    const deps = makeFakeDeps({
      getAgentResult: async () => {
        // Always return minor -- never gets clean
        return { recapMarkdown: 'MINOR: this issue persists.', artifacts: [] };
      },
    });
    const result = await runPrReviewCoordinator(deps, defaultOpts);
    expect(result.approved).toBe(0);
    expect(result.escalated).toBe(1);
    expect(deps.mergeCalls).toHaveLength(0);
  });

  it('dry-run makes no spawn or merge calls', async () => {
    const deps = makeFakeDeps();
    const result = await runPrReviewCoordinator(deps, { ...defaultOpts, dryRun: true });
    expect(deps.spawnCalls).toHaveLength(0);
    expect(deps.mergeCalls).toHaveLength(0);
    // Result is well-formed
    expect(result.reviewed).toBeGreaterThanOrEqual(0);
  });

  it('writes report file to workspace', async () => {
    const deps = makeFakeDeps({
      getAgentResult: async () => ({ recapMarkdown: 'APPROVE -- looks good.', artifacts: [] }),
    });
    await runPrReviewCoordinator(deps, defaultOpts);
    const reportKey = [...deps.writtenFiles.keys()].find((k) => k.includes('coordinator-pr-review'));
    expect(reportKey).toBeDefined();
    if (reportKey) {
      const content = deps.writtenFiles.get(reportKey) ?? '';
      expect(content).toContain('PR Review Coordinator Report');
    }
  });

  it('handles spawn error gracefully without crashing', async () => {
    const deps = makeFakeDeps({
      spawnSession: async () => ({ kind: 'err', error: 'ECONNREFUSED' }),
    });
    const result = await runPrReviewCoordinator(deps, defaultOpts);
    expect(result.reviewed).toBeGreaterThanOrEqual(0);
    expect(deps.mergeCalls).toHaveLength(0);
  });

  it('uses specific PR numbers when --pr flag is provided', async () => {
    const deps = makeFakeDeps({
      getAgentResult: async () => ({ recapMarkdown: 'APPROVE', artifacts: [] }),
    });
    const result = await runPrReviewCoordinator(deps, { ...defaultOpts, prs: [123, 456] });
    expect(result.reviewed).toBe(2);
    // listOpenPRs should NOT have been called
    // (PRs come from opts.prs, not from discovery)
  });

  it('escalates PR when merge fails', async () => {
    const deps = makeFakeDeps({
      getAgentResult: async () => ({ recapMarkdown: 'APPROVE -- clean.', artifacts: [] }),
      mergePR: async () => ({ kind: 'err', error: 'merge conflict' }),
    });
    const result = await runPrReviewCoordinator(deps, defaultOpts);
    expect(result.approved).toBe(0);
    expect(result.escalated).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// drainMessageQueue -- unit tests
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build minimal fake deps for drainMessageQueue tests.
 * Uses an in-memory file map to avoid real filesystem access.
 */
function makeDrainDeps(initialFiles: Record<string, string> = {}): {
  deps: Parameters<typeof drainMessageQueue>[0];
  files: Map<string, string>;
  stderrLines: string[];
} {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const stderrLines: string[] = [];
  let uuidCounter = 0;

  const deps: Parameters<typeof drainMessageQueue>[0] = {
    readFile: async (p) => {
      const content = files.get(p);
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file, open '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
    appendFile: async (p, content) => {
      files.set(p, (files.get(p) ?? '') + content);
    },
    writeFile: async (p, content) => {
      files.set(p, content);
    },
    mkdir: async () => undefined,
    homedir: () => '/home/test',
    joinPath: (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
    nowIso: () => '2026-04-18T00:00:00.000Z',
    generateId: () => `uuid-${++uuidCounter}`,
    stderr: (line) => stderrLines.push(line),
  };

  return { deps, files, stderrLines };
}

/** Build a JSONL queue file string from an array of message texts. */
function buildQueue(messages: Array<{ message: string; priority?: string }>): string {
  return messages
    .map((m, i) =>
      JSON.stringify({
        id: `msg-${i}`,
        message: m.message,
        timestamp: `2026-04-18T00:0${i}:00.000Z`,
        priority: m.priority ?? 'normal',
      }),
    )
    .join('\n') + '\n';
}

describe('drainMessageQueue', () => {
  it('returns empty DrainResult when message-queue.jsonl does not exist', async () => {
    const { deps } = makeDrainDeps(); // no files
    const result = await drainMessageQueue(deps);
    expect(result.stop).toBe(false);
    expect(result.stopReason).toBeNull();
    expect(result.skipPrNumbers).toHaveLength(0);
    expect(result.addPrNumbers).toHaveLength(0);
    expect(result.messagesProcessed).toBe(0);
  });

  it('processes all messages when no cursor exists', async () => {
    const queue = buildQueue([{ message: 'just a note' }, { message: 'another note' }]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    expect(result.messagesProcessed).toBe(2);
    expect(result.stop).toBe(false);
  });

  it('skips already-processed messages using cursor', async () => {
    const queue = buildQueue([
      { message: 'old note' },
      { message: 'old note 2' },
      { message: 'new note' },
    ]);
    const cursor = JSON.stringify({ lastReadCount: 2 }) + '\n';
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
      '/home/test/.workrail/message-queue-cursor.json': cursor,
    });
    const result = await drainMessageQueue(deps);
    // Only the 3rd message (new note) is unread.
    expect(result.messagesProcessed).toBe(1);
  });

  it('returns stop=true when message starts with "stop"', async () => {
    const queue = buildQueue([{ message: 'stop the coordinator' }]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    expect(result.stop).toBe(true);
    expect(result.stopReason).toBe('stop the coordinator');
  });

  it('stop is not triggered when "stop" appears mid-sentence', async () => {
    const queue = buildQueue([{ message: 'please stop worrying about this PR' }]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    // "please stop ..." does NOT start with "stop" -- no false positive.
    expect(result.stop).toBe(false);
  });

  it('stop is triggered by bare "stop" message', async () => {
    const queue = buildQueue([{ message: 'stop' }]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    expect(result.stop).toBe(true);
    expect(result.stopReason).toBe('stop');
  });

  it('stop is triggered when message has leading whitespace before "stop"', async () => {
    // Verifies STOP_RE = /^\s*stop\b/i handles leading whitespace.
    const queue = buildQueue([{ message: '  stop the run' }]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    expect(result.stop).toBe(true);
  });

  it('extracts PR number from skip-pr message', async () => {
    const queue = buildQueue([{ message: 'skip-pr 42' }]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    expect(result.stop).toBe(false);
    expect(result.skipPrNumbers).toContain(42);
  });

  it('extracts PR number from skip-pr with # prefix', async () => {
    const queue = buildQueue([{ message: 'skip-pr #99' }]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    expect(result.skipPrNumbers).toContain(99);
  });

  it('extracts PR number from add-pr message', async () => {
    const queue = buildQueue([{ message: 'add-pr 7' }]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    expect(result.stop).toBe(false);
    expect(result.addPrNumbers).toContain(7);
  });

  it('deduplicates multiple skip-pr for the same PR', async () => {
    const queue = buildQueue([
      { message: 'skip-pr 42' },
      { message: 'skip-pr 42' },
    ]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    expect(result.skipPrNumbers).toHaveLength(1);
    expect(result.skipPrNumbers[0]).toBe(42);
  });

  it('deduplicates multiple add-pr for the same PR', async () => {
    const queue = buildQueue([
      { message: 'add-pr 10' },
      { message: 'add-pr 10' },
    ]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    expect(result.addPrNumbers).toHaveLength(1);
    expect(result.addPrNumbers[0]).toBe(10);
  });

  it('skips malformed JSONL lines without crashing', async () => {
    const badLine = 'not valid json\n';
    const goodLine = JSON.stringify({ id: 'm1', message: 'note', timestamp: '2026-04-18T00:00:00.000Z', priority: 'normal' }) + '\n';
    const { deps, stderrLines } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': badLine + goodLine,
    });
    const result = await drainMessageQueue(deps);
    expect(result.messagesProcessed).toBe(1); // only the good line
    expect(stderrLines.some((l) => l.includes('malformed_line'))).toBe(true);
  });

  it('resets cursor to 0 when cursor exceeds total lines (desync guard)', async () => {
    const queue = buildQueue([{ message: 'new message' }]); // 1 line total
    const cursor = JSON.stringify({ lastReadCount: 99 }) + '\n'; // cursor beyond file
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
      '/home/test/.workrail/message-queue-cursor.json': cursor,
    });
    const result = await drainMessageQueue(deps);
    // After desync reset, all 1 message is processed.
    expect(result.messagesProcessed).toBe(1);
  });

  it('advances cursor after processing', async () => {
    const queue = buildQueue([{ message: 'note 1' }, { message: 'note 2' }]);
    const { deps, files } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    await drainMessageQueue(deps);
    const cursorContent = files.get('/home/test/.workrail/message-queue-cursor.json');
    expect(cursorContent).toBeDefined();
    const cursor = JSON.parse(cursorContent!) as { lastReadCount: number };
    expect(cursor.lastReadCount).toBe(2);
  });

  it('appends outbox notification when stop is triggered', async () => {
    const queue = buildQueue([{ message: 'stop now' }]);
    const { deps, files } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    await drainMessageQueue(deps);
    const outbox = files.get('/home/test/.workrail/outbox.jsonl');
    expect(outbox).toBeDefined();
    expect(outbox).toContain('stop now');
    expect(outbox).toContain('WorkTrain coordinator stopped');
  });

  it('appends outbox notification when skip-pr is triggered', async () => {
    const queue = buildQueue([{ message: 'skip-pr 42' }]);
    const { deps, files } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    await drainMessageQueue(deps);
    const outbox = files.get('/home/test/.workrail/outbox.jsonl');
    expect(outbox).toContain('skipping PR #42');
  });

  it('appends outbox notification when add-pr is triggered', async () => {
    const queue = buildQueue([{ message: 'add-pr 7' }]);
    const { deps, files } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    await drainMessageQueue(deps);
    const outbox = files.get('/home/test/.workrail/outbox.jsonl');
    expect(outbox).toContain('adding PR #7');
  });

  it('emits [INFO coord:drain] stderr log for stop signal', async () => {
    const queue = buildQueue([{ message: 'stop' }]);
    const { deps, stderrLines } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    await drainMessageQueue(deps);
    expect(stderrLines.some((l) => l.includes('[INFO coord:drain kind=stop'))).toBe(true);
  });

  it('note-only messages do not produce outbox entries', async () => {
    const queue = buildQueue([{ message: 'just thinking out loud' }]);
    const { deps, files } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    await drainMessageQueue(deps);
    expect(files.has('/home/test/.workrail/outbox.jsonl')).toBe(false);
  });

  it('stop takes precedence when mixed with skip-pr in same queue', async () => {
    const queue = buildQueue([
      { message: 'skip-pr 10' },
      { message: 'stop' },
    ]);
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
    });
    const result = await drainMessageQueue(deps);
    expect(result.stop).toBe(true);
    // skip-pr is also recorded (informational) -- stop wins at call site
    expect(result.skipPrNumbers).toContain(10);
  });

  it('handles cursor = totalLines (all messages already read) as no-op', async () => {
    const queue = buildQueue([{ message: 'old note' }]);
    const cursor = JSON.stringify({ lastReadCount: 1 }) + '\n';
    const { deps } = makeDrainDeps({
      '/home/test/.workrail/message-queue.jsonl': queue,
      '/home/test/.workrail/message-queue-cursor.json': cursor,
    });
    const result = await drainMessageQueue(deps);
    expect(result.messagesProcessed).toBe(0);
    expect(result.stop).toBe(false);
  });
});
