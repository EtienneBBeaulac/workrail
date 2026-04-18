/**
 * Unit tests for src/coordinators/pr-review.ts
 *
 * Tests pure functions only. All I/O is injected via fake CoordinatorDeps.
 * No HTTP calls, no exec calls, no filesystem access.
 *
 * Strategy: prefer fakes over mocks -- fake CoordinatorDeps objects implement
 * the interface directly and record calls for assertion.
 */

import { describe, it, expect } from 'vitest';
import {
  parseFindingsFromNotes,
  readVerdictArtifact,
  buildFixGoal,
  formatElapsed,
  runPrReviewCoordinator,
  type CoordinatorDeps,
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
});

// ═══════════════════════════════════════════════════════════════════════════
// readVerdictArtifact -- pure function tests
// ═══════════════════════════════════════════════════════════════════════════

describe('readVerdictArtifact', () => {
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
    },
    stderr: (line) => {
      stderrLines.push(line);
    },
    now: () => Date.now(),
    port: 3456,
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
