/**
 * Resume Ranking Projection Tests
 *
 * Tests the pure 5-tier ranking algorithm, text normalization,
 * tier assignment, sorting, and output bounding.
 */
import { describe, it, expect } from 'vitest';
import {
  rankResumeCandidates,
  assignTier,
  normalizeToTokens,
  allQueryTokensMatch,
  asRecapSnippet,
  MAX_RESUME_CANDIDATES,
  type HealthySessionSummary,
  type ResumeQuery,
  type TierAssignment,
} from '../../../src/v2/projections/resume-ranking.js';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkSummary(overrides: Partial<HealthySessionSummary> & { sessionId: string; runId: string }): HealthySessionSummary {
  return {
    sessionId: asSessionId(overrides.sessionId),
    runId: overrides.runId,
    preferredTip: overrides.preferredTip ?? { nodeId: 'node_1', lastActivityEventIndex: 10 },
    recapSnippet: overrides.recapSnippet ?? null,
    observations: overrides.observations ?? { gitHeadSha: null, gitBranch: null, repoRootHash: null },
    workflow: overrides.workflow ?? { workflowId: null, workflowName: null },
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
  it('returns tier 1 for exact git_head_sha match', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      observations: { gitHeadSha: 'abc123', gitBranch: null, repoRootHash: null },
    });
    const tier = assignTier(summary, { gitHeadSha: 'abc123' });
    expect(tier).toEqual({ tier: 1, kind: 'matched_head_sha' });
  });

  it('returns tier 2 exact for matching git_branch', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      observations: { gitHeadSha: null, gitBranch: 'feature/foo', repoRootHash: null },
    });
    const tier = assignTier(summary, { gitBranch: 'feature/foo' });
    expect(tier).toEqual({ tier: 2, kind: 'matched_branch', matchType: 'exact' });
  });

  it('returns tier 2 prefix for prefix-matching git_branch', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      observations: { gitHeadSha: null, gitBranch: 'feature/foo-bar', repoRootHash: null },
    });
    const tier = assignTier(summary, { gitBranch: 'feature/foo' });
    expect(tier).toEqual({ tier: 2, kind: 'matched_branch', matchType: 'prefix' });
  });

  it('returns tier 3 for text match on recap notes', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      recapSnippet: asRecapSnippet('Implemented the login feature with OAuth support'),
    });
    const tier = assignTier(summary, { freeTextQuery: 'login oauth' });
    expect(tier).toEqual({ tier: 3, kind: 'matched_notes' });
  });

  it('returns tier 4 for text match on workflow id', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      workflow: { workflowId: 'coding-task-agentic', workflowName: null },
    });
    const tier = assignTier(summary, { freeTextQuery: 'coding-task-agentic' });
    expect(tier).toEqual({ tier: 4, kind: 'matched_workflow_id' });
  });

  it('returns tier 5 for recency fallback', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
    });
    const tier = assignTier(summary, {});
    expect(tier).toEqual({ tier: 5, kind: 'recency_fallback' });
  });

  it('prefers tier 1 over tier 2 when both match', () => {
    const summary = mkSummary({
      sessionId: 'sess_1',
      runId: 'run_1',
      observations: { gitHeadSha: 'abc123', gitBranch: 'main', repoRootHash: null },
    });
    const tier = assignTier(summary, { gitHeadSha: 'abc123', gitBranch: 'main' });
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

    // sess_b is tier 1 (sha match), others are tier 5
    expect(ranked[0]!.sessionId).toBe(asSessionId('sess_b'));
    // Among tier 5: sess_c (15) before sess_a (5)
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
    // Both tier 5 with same activity, sess_a < sess_z lex
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
    expect(ranked[0]!.tierAssignment.tier).toBe(1);
  });

  it('returns empty snippet when no recap exists', () => {
    const summaries = [mkSummary({ sessionId: 'sess_1', runId: 'run_1' })];
    const ranked = rankResumeCandidates(summaries, {});
    expect(ranked[0]!.snippet).toBe('');
  });
});
