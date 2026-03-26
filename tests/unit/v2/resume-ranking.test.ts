/**
 * Resume Ranking Projection Tests
 *
 * Tests the pure 7-tier ranking algorithm, text normalization,
 * tier assignment, sorting, and output bounding.
 */
import { describe, it, expect } from 'vitest';
import {
  rankResumeCandidates,
  assignTier,
  computeQueryRelevanceScore,
  normalizeToTokens,
  allQueryTokensMatch,
  queryTokenMatchRatio,
  fuzzyTokenMatch,
  fuzzyQueryTokenMatchRatio,
  asRecapSnippet,
  MAX_RESUME_CANDIDATES,
  type HealthySessionSummary,
  type IdentifiedWorkflow,
  type ResumeQuery,
  type TierAssignment,
} from '../../../src/v2/projections/resume-ranking.js';
import { asSessionId, asWorkflowId, asWorkflowHash, asSha256Digest } from '../../../src/v2/durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_WORKFLOW: IdentifiedWorkflow = {
  kind: 'identified',
  workflowId: asWorkflowId('test-workflow'),
  workflowHash: asWorkflowHash(asSha256Digest('sha256:' + 'a'.repeat(64))),
};

function mkSummary(overrides: Partial<HealthySessionSummary> & { sessionId: string; runId: string }): HealthySessionSummary {
  return {
    sessionId: asSessionId(overrides.sessionId),
    runId: overrides.runId,
    preferredTip: overrides.preferredTip ?? { nodeId: 'node_1', lastActivityEventIndex: 10 },
    recapSnippet: overrides.recapSnippet ?? null,
    observations: overrides.observations ?? { gitHeadSha: null, gitBranch: null, repoRootHash: null },
    workflow: overrides.workflow ?? DEFAULT_WORKFLOW,
    sessionTitle: overrides.sessionTitle ?? null,
    lastModifiedMs: overrides.lastModifiedMs ?? null,
    pendingStepId: overrides.pendingStepId ?? null,
    isComplete: overrides.isComplete ?? false,
  };
}

// ---------------------------------------------------------------------------
// Text Normalization
// ---------------------------------------------------------------------------

describe('normalizeToTokens', () => {
  it('extracts lowercase alpha-numeric tokens', () => {
    const tokens = normalizeToTokens('Hello World 123');
    expect(tokens).toEqual(new Set(['hello', 'world', '123']));
  });

  it('handles hyphens and underscores as part of tokens', () => {
    const tokens = normalizeToTokens('my-feature_branch');
    expect(tokens).toEqual(new Set(['my-feature_branch']));
  });

  it('applies NFKC normalization', () => {
    // ﬁ (U+FB01) should decompose to 'fi' under NFKC
    const tokens = normalizeToTokens('ﬁnd');
    expect(tokens.has('find')).toBe(true);
  });

  it('returns empty set for whitespace-only input', () => {
    const tokens = normalizeToTokens('   \n\t  ');
    expect(tokens.size).toBe(0);
  });

  it('returns empty set for empty string', () => {
    const tokens = normalizeToTokens('');
    expect(tokens.size).toBe(0);
  });
});

describe('allQueryTokensMatch', () => {
  it('returns true when all query tokens present', () => {
    expect(allQueryTokensMatch(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(true);
  });

  it('returns false when a query token is missing', () => {
    expect(allQueryTokensMatch(new Set(['a', 'x']), new Set(['a', 'b', 'c']))).toBe(false);
  });

  it('returns false for empty query', () => {
    expect(allQueryTokensMatch(new Set(), new Set(['a', 'b']))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RecapSnippet
// ---------------------------------------------------------------------------

describe('asRecapSnippet', () => {
  it('passes through short text unchanged', () => {
    const snippet = asRecapSnippet('Hello world');
    expect(String(snippet)).toBe('Hello world');
  });

  it('strips truncation marker', () => {
    const snippet = asRecapSnippet('Some text\n\n[TRUNCATED]');
    expect(String(snippet)).toBe('Some text');
  });

  it('truncates text exceeding 1024 bytes', () => {
    const longText = 'a'.repeat(2000);
    const snippet = asRecapSnippet(longText);
    const bytes = new TextEncoder().encode(String(snippet));
    expect(bytes.length).toBeLessThanOrEqual(1024);
  });
});

// ---------------------------------------------------------------------------
// Tier Assignment
// ---------------------------------------------------------------------------

describe('assignTier', () => {
  it('returns tier 4 for exact git_head_sha match', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      observations: { gitHeadSha: 'abc123', gitBranch: null, repoRootHash: null },
    });
    const tier = assignTier(summary, { gitHeadSha: 'abc123' });
    expect(tier).toEqual({ tier: 4, kind: 'matched_head_sha' });
  });

  it('returns tier 5 exact for matching git_branch', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      observations: { gitHeadSha: null, gitBranch: 'feature/foo', repoRootHash: null },
    });
    const tier = assignTier(summary, { gitBranch: 'feature/foo' });
    expect(tier).toEqual({ tier: 5, kind: 'matched_branch', matchType: 'exact' });
  });

  it('returns tier 5 prefix for prefix-matching git_branch', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      observations: { gitHeadSha: null, gitBranch: 'feature/foo-bar', repoRootHash: null },
    });
    const tier = assignTier(summary, { gitBranch: 'feature/foo' });
    expect(tier).toEqual({ tier: 5, kind: 'matched_branch', matchType: 'prefix' });
  });

  it('returns tier 1 for text match on recap notes', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      recapSnippet: asRecapSnippet('Implemented the login feature with OAuth support'),
    });
    const tier = assignTier(summary, { freeTextQuery: 'login oauth' });
    expect(tier).toEqual({ tier: 1, kind: 'matched_notes' });
  });

  it('returns tier 3 for text match on workflow id', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      workflow: {
        kind: 'identified',
        workflowId: asWorkflowId('coding-task-agentic'),
        workflowHash: asWorkflowHash(asSha256Digest('sha256:' + 'b'.repeat(64))),
      },
    });
    const tier = assignTier(summary, { freeTextQuery: 'coding-task-agentic' });
    expect(tier).toEqual({ tier: 3, kind: 'matched_workflow_id' });
  });

  it('returns tier 6 for recency fallback', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
    });
    const tier = assignTier(summary, {});
    expect(tier).toEqual({ tier: 6, kind: 'recency_fallback' });
  });

  it('prefers explicit query match over passive git context when both match', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      observations: { gitHeadSha: 'abc123', gitBranch: 'main', repoRootHash: null },
      recapSnippet: asRecapSnippet('Working on MR ownership implementation'),
    });
    const tier = assignTier(summary, { gitHeadSha: 'abc123', gitBranch: 'main', freeTextQuery: 'mr ownership' });
    expect(tier.tier).toBe(1);
  });

  it('matches session title from persisted context before falling back to git context', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      sessionTitle: 'Task dev for MR ownership',
      observations: { gitHeadSha: 'abc123', gitBranch: 'main', repoRootHash: null },
    });
    const tier = assignTier(summary, { gitHeadSha: 'abc123', freeTextQuery: 'mr ownership' });
    expect(tier.kind).toBe('matched_notes');
    expect(tier.tier).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ranking Function
// ---------------------------------------------------------------------------

describe('rankResumeCandidates', () => {
  it('sorts by tier then by lastActivityEventIndex desc', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_a',
        runId: 'run_a',
        preferredTip: { nodeId: 'n1', lastActivityEventIndex: 5 },
      }),
      mkSummary({
        sessionId: 'sess_b',
        runId: 'run_b',
        preferredTip: { nodeId: 'n2', lastActivityEventIndex: 20 },
        observations: { gitHeadSha: 'sha1', gitBranch: null, repoRootHash: null },
      }),
      mkSummary({
        sessionId: 'sess_c',
        runId: 'run_c',
        preferredTip: { nodeId: 'n3', lastActivityEventIndex: 15 },
      }),
    ];

    const ranked = rankResumeCandidates(summaries, { gitHeadSha: 'sha1' });

    // sess_b is tier 4 (sha match), others are tier 6 (recency fallback)
    expect(ranked[0]!.sessionId).toBe(asSessionId('sess_b'));
    // Among tier 6: sess_c (15) before sess_a (5)
    expect(ranked[1]!.sessionId).toBe(asSessionId('sess_c'));
    expect(ranked[2]!.sessionId).toBe(asSessionId('sess_a'));
  });

  it('uses sessionId as tie-breaker within same tier and activity', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_z',
        runId: 'run_z',
        preferredTip: { nodeId: 'n1', lastActivityEventIndex: 10 },
      }),
      mkSummary({
        sessionId: 'sess_a',
        runId: 'run_a',
        preferredTip: { nodeId: 'n2', lastActivityEventIndex: 10 },
      }),
    ];

    const ranked = rankResumeCandidates(summaries, {});
    // Both tier 6 with same activity, sess_a < sess_z lex
    expect(ranked[0]!.sessionId).toBe(asSessionId('sess_a'));
    expect(ranked[1]!.sessionId).toBe(asSessionId('sess_z'));
  });

  it('caps at MAX_RESUME_CANDIDATES', () => {
    const summaries = Array.from({ length: 10 }, (_, i) =>
      mkSummary({
        sessionId: `sess_${String(i).padStart(3, '0')}`,
        runId: `run_${i}`,
        preferredTip: { nodeId: `n${i}`, lastActivityEventIndex: i },
      }),
    );

    const ranked = rankResumeCandidates(summaries, {});
    expect(ranked.length).toBe(MAX_RESUME_CANDIDATES);
  });

  it('returns empty array for empty input', () => {
    const ranked = rankResumeCandidates([], {});
    expect(ranked).toEqual([]);
  });

  it('includes correct whyMatched and snippet', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_1',
        runId: 'run_1',
        recapSnippet: asRecapSnippet('Working on authentication flow'),
        observations: { gitHeadSha: 'sha_match', gitBranch: null, repoRootHash: null },
      }),
    ];

    const ranked = rankResumeCandidates(summaries, { gitHeadSha: 'sha_match' });
    expect(ranked[0]!.whyMatched).toEqual(['matched_head_sha']);
    expect(ranked[0]!.snippet).toBe('Working on authentication flow');
    expect(ranked[0]!.tierAssignment.tier).toBe(4);
  });

  it('includes supplemental repo match reason when workspace repo matches', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_1',
        runId: 'run_1',
        recapSnippet: asRecapSnippet('Working on authentication flow'),
        observations: {
          gitHeadSha: 'sha_match',
          gitBranch: 'feature/auth',
          repoRootHash: 'sha256:' + '1'.repeat(64),
        },
      }),
    ];

    const ranked = rankResumeCandidates(summaries, {
      gitHeadSha: 'sha_match',
      repoRootHash: 'sha256:' + '1'.repeat(64),
    });
    expect(ranked[0]!.whyMatched).toEqual(['matched_head_sha', 'matched_repo_root']);
  });

  it('returns empty snippet when no recap exists', () => {
    const summaries = [mkSummary({ sessionId: 'sess_1', runId: 'run_1' })];
    const ranked = rankResumeCandidates(summaries, {});
    expect(ranked[0]!.snippet).toBe('');
  });
});

// ---------------------------------------------------------------------------
// queryTokenMatchRatio
// ---------------------------------------------------------------------------

describe('queryTokenMatchRatio', () => {
  it('returns 1.0 when all query tokens match', () => {
    expect(queryTokenMatchRatio(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(1.0);
  });

  it('returns 0.5 when half of query tokens match', () => {
    expect(queryTokenMatchRatio(new Set(['a', 'x']), new Set(['a', 'b', 'c']))).toBe(0.5);
  });

  it('returns 0 for empty query', () => {
    expect(queryTokenMatchRatio(new Set(), new Set(['a']))).toBe(0);
  });

  it('returns 0 for empty candidate', () => {
    expect(queryTokenMatchRatio(new Set(['a']), new Set())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exact ID matching (Tier 0)
// ---------------------------------------------------------------------------

describe('assignTier - exact ID matching', () => {
  it('returns tier 0 for exact runId match', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_abc123',
    });
    const tier = assignTier(summary, { runId: 'run_abc123' });
    expect(tier).toEqual({ tier: 0, kind: 'matched_exact_id', matchField: 'runId' });
  });

  it('returns tier 0 for exact sessionId match', () => {
    const summary = mkSummary({
      sessionId: 'sess_abc123',
      runId: 'run_1',
    });
    const tier = assignTier(summary, { sessionId: 'sess_abc123' });
    expect(tier).toEqual({ tier: 0, kind: 'matched_exact_id', matchField: 'sessionId' });
  });

  it('prefers tier 0 over tier 1', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_target',
      observations: { gitHeadSha: 'abc123', gitBranch: null, repoRootHash: null },
    });
    const tier = assignTier(summary, { runId: 'run_target', gitHeadSha: 'abc123' });
    expect(tier.tier).toBe(0);
  });

  it('ranks exact ID match first in rankResumeCandidates', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_other',
        runId: 'run_other',
        observations: { gitHeadSha: 'sha1', gitBranch: null, repoRootHash: null },
      }),
      mkSummary({
        sessionId: 'sess_target',
        runId: 'run_target',
      }),
    ];

    const ranked = rankResumeCandidates(summaries, { runId: 'run_target', gitHeadSha: 'sha1' });
    expect(ranked[0]!.sessionId).toBe(asSessionId('sess_target'));
    expect(ranked[0]!.whyMatched).toEqual(['matched_exact_id']);
  });
});

// ---------------------------------------------------------------------------
// Partial notes matching (Tier 2)
// ---------------------------------------------------------------------------

describe('assignTier - partial notes matching', () => {
  it('returns tier 2 (partial notes) when some but not all query tokens match notes', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      recapSnippet: asRecapSnippet('Working on MR ownership feature for the team'),
    });
    // "mr ownership task dev" - "mr" and "ownership" match, "task" and "dev" don't
    const tier = assignTier(summary, { freeTextQuery: 'mr ownership task dev' });
    expect(tier.kind).toBe('matched_notes_partial');
    expect(tier.tier).toBe(2);
  });

  it('does not return partial match when ratio is below threshold', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      recapSnippet: asRecapSnippet('Completely unrelated content about databases'),
    });
    // Only 1 of 5 tokens might match by coincidence
    const tier = assignTier(summary, { freeTextQuery: 'mr ownership task dev feature' });
    expect(tier.kind).not.toBe('matched_notes_partial');
  });

  it('returns partial match at weighted boundary when the matched tokens are distinctive', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      recapSnippet: asRecapSnippet('Working on ownership and classifier migration'),
    });
    const tier = assignTier(summary, { freeTextQuery: 'ownership classifier adapter sync bridge' });
    expect(tier.kind).toBe('matched_notes_partial');
    expect(tier.tier).toBe(2);
  });

  it('falls through to recency when runId does not match', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
    });
    const tier = assignTier(summary, { runId: 'run_nonexistent' });
    expect(tier.kind).toBe('recency_fallback');
    expect(tier.tier).toBe(6);
  });

  it('falls through to recency when sessionId does not match', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
    });
    const tier = assignTier(summary, { sessionId: 'sess_nonexistent' });
    expect(tier.kind).toBe('recency_fallback');
  });
});

// ---------------------------------------------------------------------------
// Partial match ratio sorting within tier 4
// ---------------------------------------------------------------------------

describe('rankResumeCandidates - partial match ratio sorting', () => {
  it('sorts higher weighted match ratio before lower within partial tier', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_low_ratio',
        runId: 'run_low',
        recapSnippet: asRecapSnippet('Working on ownership adapter changes'),
      }),
      mkSummary({
        sessionId: 'sess_high_ratio',
        runId: 'run_high',
        recapSnippet: asRecapSnippet('Working on ownership classifier adapter bridge changes'),
      }),
      mkSummary({
        sessionId: 'sess_med_ratio',
        runId: 'run_med',
        recapSnippet: asRecapSnippet('Working on ownership classifier adapter updates'),
      }),
    ];

    const ranked = rankResumeCandidates(summaries, { freeTextQuery: 'ownership classifier adapter bridge sync' });

    // Filter to only tier 4 (partial) matches
    const partialMatches = ranked.filter(r => r.tierAssignment.kind === 'matched_notes_partial');
    // high (4/5) before med (3/5); low (2/5) falls below the weighted threshold
    expect(partialMatches.length).toBeGreaterThanOrEqual(2);
    expect(partialMatches[0]!.sessionId).toBe(asSessionId('sess_high_ratio'));
    expect(partialMatches[1]!.sessionId).toBe(asSessionId('sess_med_ratio'));
  });
});

describe('computeQueryRelevanceScore', () => {
  it('prefers session title text over workflow id and branch', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      sessionTitle: 'Task dev for MR ownership',
      observations: { gitHeadSha: null, gitBranch: 'feature/mr-ownership', repoRootHash: null },
    });

    const score = computeQueryRelevanceScore(summary, { freeTextQuery: 'mr ownership task dev' });
    expect(score).toBeGreaterThanOrEqual(0.75);
  });

  it('boosts same-repo sessions when repoRootHash matches the current workspace', () => {
    const sameRepo = mkSummary({
      sessionId: 'sess_same_repo',
      runId: 'run_same_repo',
      sessionTitle: 'Task dev for MR ownership',
      observations: { gitHeadSha: null, gitBranch: 'feature/mr-ownership', repoRootHash: 'sha256:' + '1'.repeat(64) },
    });

    const otherRepo = mkSummary({
      sessionId: 'sess_other_repo',
      runId: 'run_other_repo',
      sessionTitle: 'Task dev for MR ownership',
      observations: { gitHeadSha: null, gitBranch: 'feature/mr-ownership', repoRootHash: 'sha256:' + '2'.repeat(64) },
    });

    const query = { freeTextQuery: 'mr ownership task dev', repoRootHash: 'sha256:' + '1'.repeat(64) };
    expect(computeQueryRelevanceScore(sameRepo, query)).toBeGreaterThan(computeQueryRelevanceScore(otherRepo, query));
  });
});

describe('rankResumeCandidates - sameWorkspaceOnly', () => {
  it('filters out cross-repo sessions when sameWorkspaceOnly is enabled', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_same_repo',
        runId: 'run_same_repo',
        observations: { gitHeadSha: null, gitBranch: 'feature/x', repoRootHash: 'sha256:' + '1'.repeat(64) },
      }),
      mkSummary({
        sessionId: 'sess_other_repo',
        runId: 'run_other_repo',
        observations: { gitHeadSha: null, gitBranch: 'feature/x', repoRootHash: 'sha256:' + '2'.repeat(64) },
      }),
    ];

    const ranked = rankResumeCandidates(summaries, {
      repoRootHash: 'sha256:' + '1'.repeat(64),
      sameWorkspaceOnly: true,
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.sessionId).toBe(asSessionId('sess_same_repo'));
  });
});

// ---------------------------------------------------------------------------
// Fuzzy token matching
// ---------------------------------------------------------------------------

describe('fuzzyTokenMatch', () => {
  it('matches when query token is a substring of candidate token', () => {
    expect(fuzzyTokenMatch('owner', new Set(['ownership', 'feature']))).toBe(true);
  });

  it('matches when candidate token is a substring of query token', () => {
    expect(fuzzyTokenMatch('authentication', new Set(['auth', 'feature']))).toBe(true);
  });

  it('does not match unrelated tokens', () => {
    expect(fuzzyTokenMatch('owner', new Set(['feature', 'login']))).toBe(false);
  });

  it('skips very short tokens to avoid false positives', () => {
    expect(fuzzyTokenMatch('mr', new Set(['mr-ownership']))).toBe(false);
    expect(fuzzyTokenMatch('abc', new Set(['ab']))).toBe(false);
  });

  it('matches 3+ char tokens', () => {
    expect(fuzzyTokenMatch('auth', new Set(['authentication']))).toBe(true);
  });
});

describe('fuzzyQueryTokenMatchRatio', () => {
  it('counts both exact and fuzzy matches', () => {
    // "owner" fuzzy-matches "ownership", "feature" exact-matches "feature"
    const ratio = fuzzyQueryTokenMatchRatio(
      new Set(['owner', 'feature', 'xyz']),
      new Set(['ownership', 'feature', 'other']),
    );
    expect(ratio).toBeCloseTo(2 / 3);
  });

  it('returns 0 for no matches', () => {
    expect(fuzzyQueryTokenMatchRatio(new Set(['abc']), new Set(['xyz']))).toBe(0);
  });
});

describe('assignTier - fuzzy matching integration', () => {
  it('matches notes via fuzzy substring (owner -> ownership)', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      recapSnippet: asRecapSnippet('Working on MR ownership feature for the team'),
    });
    // "owner" should fuzzy-match "ownership", giving at least partial match
    const tier = assignTier(summary, { freeTextQuery: 'owner feature' });
    expect(tier.kind === 'matched_notes' || tier.kind === 'matched_notes_partial').toBe(true);
  });

  it('matches workflow ID via fuzzy partial (coding task -> coding-task-workflow-agentic)', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      workflow: {
        kind: 'identified',
        workflowId: asWorkflowId('coding-task-workflow-agentic'),
        workflowHash: asWorkflowHash(asSha256Digest('sha256:' + 'b'.repeat(64))),
      },
    });
    const tier = assignTier(summary, { freeTextQuery: 'coding task' });
    expect(tier.kind).toBe('matched_workflow_id');
  });
});

// ---------------------------------------------------------------------------
// Completed session deprioritization
// ---------------------------------------------------------------------------

describe('rankResumeCandidates - completed session deprioritization', () => {
  it('sorts completed sessions after in-progress ones at the same tier', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_complete',
        runId: 'run_complete',
        isComplete: true,
        preferredTip: { nodeId: 'n1', lastActivityEventIndex: 20 },
      }),
      mkSummary({
        sessionId: 'sess_active',
        runId: 'run_active',
        isComplete: false,
        preferredTip: { nodeId: 'n2', lastActivityEventIndex: 5 },
      }),
    ];

    const ranked = rankResumeCandidates(summaries, {});
    // Both are tier 6 (recency fallback), but completed should sort after in-progress
    expect(ranked[0]!.sessionId).toBe(asSessionId('sess_active'));
    expect(ranked[1]!.sessionId).toBe(asSessionId('sess_complete'));
    expect(ranked[1]!.isComplete).toBe(true);
  });

  it('preserves tier priority over completion status (completed tier 1 beats in-progress tier 6)', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_active',
        runId: 'run_active',
        isComplete: false,
        // No match signals -> tier 6
      }),
      mkSummary({
        sessionId: 'sess_complete_but_matched',
        runId: 'run_complete_matched',
        isComplete: true,
        observations: { gitHeadSha: 'abc123', gitBranch: null, repoRootHash: null },
        // SHA match -> tier 4
      }),
    ];

    const ranked = rankResumeCandidates(summaries, { gitHeadSha: 'abc123' });
    // Completed with tier 4 should still beat in-progress with tier 6
    expect(ranked[0]!.sessionId).toBe(asSessionId('sess_complete_but_matched'));
    expect(ranked[0]!.isComplete).toBe(true);
    expect(ranked[1]!.sessionId).toBe(asSessionId('sess_active'));
  });
});

// ---------------------------------------------------------------------------
// New output fields
// ---------------------------------------------------------------------------

describe('rankResumeCandidates - new output fields', () => {
  it('includes sessionTitle, gitBranch, pendingStepId, isComplete, lastModifiedMs, confidence, and explanation in output', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_1',
        runId: 'run_1',
        sessionTitle: 'Task dev for MR ownership',
        observations: { gitHeadSha: null, gitBranch: 'feature/mr-ownership', repoRootHash: null },
        pendingStepId: 'phase-3-implement',
        isComplete: false,
        lastModifiedMs: 1700000000000,
      }),
    ];

    const ranked = rankResumeCandidates(summaries, {});
    expect(ranked[0]!.sessionTitle).toBe('Task dev for MR ownership');
    expect(ranked[0]!.gitBranch).toBe('feature/mr-ownership');
    expect(ranked[0]!.pendingStepId).toBe('phase-3-implement');
    expect(ranked[0]!.isComplete).toBe(false);
    expect(ranked[0]!.lastModifiedMs).toBe(1700000000000);
    expect(ranked[0]!.confidence).toBe('weak');
    expect(ranked[0]!.matchExplanation).toContain('Recent session');
  });

  it('includes null pendingStepId for completed sessions', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_1',
        runId: 'run_1',
        isComplete: true,
        pendingStepId: null,
        lastModifiedMs: 1700000000000,
      }),
    ];

    const ranked = rankResumeCandidates(summaries, {});
    expect(ranked[0]!.pendingStepId).toBeNull();
    expect(ranked[0]!.isComplete).toBe(true);
  });

  it('uses query-centered snippet when a later match is more relevant than the start of the recap', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_1',
        runId: 'run_1',
        recapSnippet: asRecapSnippet(
          'Initial setup and generic implementation work. ' +
          'Later we added MR ownership routing and ownership-aware matching for resume search.'
        ),
      }),
    ];

    const ranked = rankResumeCandidates(summaries, { freeTextQuery: 'ownership' });
    expect(ranked[0]!.snippet.toLowerCase()).toContain('ownership');
  });

  it('assigns strong confidence to exact ID matches', () => {
    const summaries = [mkSummary({ sessionId: 'sess_1', runId: 'run_1' })];
    const ranked = rankResumeCandidates(summaries, { runId: 'run_1' });
    expect(ranked[0]!.confidence).toBe('strong');
    expect(ranked[0]!.matchExplanation).toContain('Exact runId match');
  });
});

describe('rankResumeCandidates - transcript-like scenarios', () => {
  it('breaks git SHA ties using explicit query relevance from session title', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_mr_ownership',
        runId: 'run_mr_ownership',
        sessionTitle: 'Task dev for MR ownership',
        recapSnippet: asRecapSnippet('Design review for MR ownership classification and compatibility'),
        observations: { gitHeadSha: 'sha_shared', gitBranch: 'feature/mr-ownership', repoRootHash: null },
        preferredTip: { nodeId: 'n1', lastActivityEventIndex: 5 },
      }),
      mkSummary({
        sessionId: 'sess_unrelated_but_recent',
        runId: 'run_unrelated',
        sessionTitle: 'People search-first picker UI integration',
        recapSnippet: asRecapSnippet('Implemented search-first picker UI integration'),
        observations: { gitHeadSha: 'sha_shared', gitBranch: 'feature/people-picker', repoRootHash: null },
        preferredTip: { nodeId: 'n2', lastActivityEventIndex: 50 },
      }),
    ];

    const ranked = rankResumeCandidates(summaries, {
      gitHeadSha: 'sha_shared',
      freeTextQuery: 'task dev mr ownership',
    });

    expect(ranked[0]!.sessionId).toBe(asSessionId('sess_mr_ownership'));
    expect(ranked[0]!.sessionTitle).toBe('Task dev for MR ownership');
    expect(ranked[0]!.whyMatched).toEqual(['matched_notes', 'matched_head_sha']);
  });

  it('prefers the same repo and distinctive ownership token over generic task/dev matches', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_opex_mr_ownership',
        runId: 'run_opex_mr_ownership',
        sessionTitle: 'Task dev for MR ownership',
        recapSnippet: asRecapSnippet('Add MR ownership data handling and ownership-specific task-dev notes'),
        observations: {
          gitHeadSha: 'shared_sha',
          gitBranch: 'feature/mr-ownership',
          repoRootHash: 'sha256:' + '1'.repeat(64),
        },
        preferredTip: { nodeId: 'n1', lastActivityEventIndex: 5 },
      }),
      mkSummary({
        sessionId: 'sess_other_repo_generic',
        runId: 'run_other_repo_generic',
        sessionTitle: 'Task dev for bare integration harness',
        recapSnippet: asRecapSnippet('Task dev workflow for integration harness cleanup and generic implementation work'),
        observations: {
          gitHeadSha: 'shared_sha',
          gitBranch: 'zim/etienneb/acei-852_zim-bare-integration-tests',
          repoRootHash: 'sha256:' + '2'.repeat(64),
        },
        preferredTip: { nodeId: 'n2', lastActivityEventIndex: 50 },
      }),
      mkSummary({
        sessionId: 'sess_other_repo_ownershipless',
        runId: 'run_other_repo_ownershipless',
        sessionTitle: 'Task dev for merge request dashboard',
        recapSnippet: asRecapSnippet('Refine merge request dashboard task-dev flow without ownership support'),
        observations: {
          gitHeadSha: 'shared_sha',
          gitBranch: 'main',
          repoRootHash: 'sha256:' + '3'.repeat(64),
        },
        preferredTip: { nodeId: 'n3', lastActivityEventIndex: 60 },
      }),
    ];

    const ranked = rankResumeCandidates(summaries, {
      gitHeadSha: 'shared_sha',
      freeTextQuery: 'task dev for mr ownership',
      repoRootHash: 'sha256:' + '1'.repeat(64),
    });

    expect(ranked[0]!.sessionId).toBe(asSessionId('sess_opex_mr_ownership'));
    expect(ranked[0]!.sessionTitle).toBe('Task dev for MR ownership');
    expect(ranked[0]!.gitBranch).toBe('feature/mr-ownership');
    expect(ranked[0]!.whyMatched).toContain('matched_repo_root');
  });

  it('prefers the current workspace repo when branch and sha are otherwise identical', () => {
    const summaries = [
      mkSummary({
        sessionId: 'sess_current_repo',
        runId: 'run_current_repo',
        observations: {
          gitHeadSha: 'shared_sha',
          gitBranch: 'main',
          repoRootHash: 'sha256:' + '1'.repeat(64),
        },
        preferredTip: { nodeId: 'n1', lastActivityEventIndex: 5 },
      }),
      mkSummary({
        sessionId: 'sess_other_repo',
        runId: 'run_other_repo',
        observations: {
          gitHeadSha: 'shared_sha',
          gitBranch: 'main',
          repoRootHash: 'sha256:' + '2'.repeat(64),
        },
        preferredTip: { nodeId: 'n2', lastActivityEventIndex: 50 },
      }),
    ];

    const ranked = rankResumeCandidates(summaries, {
      gitHeadSha: 'shared_sha',
      gitBranch: 'main',
      repoRootHash: 'sha256:' + '1'.repeat(64),
    });

    expect(ranked[0]!.sessionId).toBe(asSessionId('sess_current_repo'));
    expect(ranked[0]!.whyMatched).toContain('matched_repo_root');
  });
});
