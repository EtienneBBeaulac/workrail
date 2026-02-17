import type { SessionId } from '../durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// Domain types — make illegal states unrepresentable
// ---------------------------------------------------------------------------

/**
 * Bounded, pre-truncated recap snippet.
 * Branded type ensures only properly truncated text enters ranking.
 */
export type RecapSnippet = string & { readonly __brand: 'RecapSnippet' };

/** Max bytes per snippet (locked §2.3). */
const MAX_SNIPPET_BYTES = 1024;

/** Canonical truncation marker (locked §2.3). */
const TRUNCATION_MARKER = '\n\n[TRUNCATED]';

/**
 * Construct a RecapSnippet from raw text.
 * Strips truncation markers and truncates to MAX_SNIPPET_BYTES.
 */
export function asRecapSnippet(raw: string): RecapSnippet {
  const stripped = raw.endsWith(TRUNCATION_MARKER)
    ? raw.slice(0, -TRUNCATION_MARKER.length)
    : raw;

  const encoder = new TextEncoder();
  const bytes = encoder.encode(stripped);
  if (bytes.length <= MAX_SNIPPET_BYTES) {
    return stripped as RecapSnippet;
  }

  // Truncate at byte boundary, then find last valid UTF-8 char boundary
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const truncated = decoder.decode(bytes.slice(0, MAX_SNIPPET_BYTES));
  return truncated as RecapSnippet;
}

/** Workspace observations extracted from session events. */
export interface SessionObservations {
  readonly gitHeadSha: string | null;
  readonly gitBranch: string | null;
  readonly repoRootHash: string | null;
}

/** Workflow identity from run_started events. */
export interface WorkflowIdentity {
  readonly workflowId: string | null;
  readonly workflowName: string | null;
}

/**
 * Healthy session summary — only constructable after health check + projection.
 * Ranking function accepts only this type, preventing unhealthy sessions from entering.
 */
export interface HealthySessionSummary {
  readonly sessionId: SessionId;
  readonly runId: string;
  readonly preferredTip: {
    readonly nodeId: string;
    readonly lastActivityEventIndex: number;
  };
  readonly recapSnippet: RecapSnippet | null;
  readonly observations: SessionObservations;
  readonly workflow: WorkflowIdentity;
}

// ---------------------------------------------------------------------------
// Tier assignment — discriminated union for exhaustive handling
// ---------------------------------------------------------------------------

/** Closed set: why a session matched (locked §2.3). */
export type WhyMatched =
  | 'matched_head_sha'
  | 'matched_branch'
  | 'matched_notes'
  | 'matched_workflow_id'
  | 'recency_fallback';

/** Tier assignment — discriminated union. Exhaustive, testable independently. */
export type TierAssignment =
  | { readonly tier: 1; readonly kind: 'matched_head_sha' }
  | { readonly tier: 2; readonly kind: 'matched_branch'; readonly matchType: 'exact' | 'prefix' }
  | { readonly tier: 3; readonly kind: 'matched_notes' }
  | { readonly tier: 4; readonly kind: 'matched_workflow_id' }
  | { readonly tier: 5; readonly kind: 'recency_fallback' };

// ---------------------------------------------------------------------------
// Text normalization (locked §2.3)
// ---------------------------------------------------------------------------

/** Token extraction regex (locked). */
const TOKEN_REGEX = /[a-z0-9_-]+/g;

/**
 * Normalize text to a deterministic token set (locked §2.3).
 *
 * 1. NFKC normalize (Unicode compatibility decomposition + composition)
 * 2. Lowercase (locale-independent)
 * 3. Extract tokens matching [a-z0-9_-]+
 * 4. Return as ReadonlySet for O(1) membership checks
 */
export function normalizeToTokens(text: string): ReadonlySet<string> {
  const normalized = text.normalize('NFKC').toLowerCase();
  const matches = normalized.match(TOKEN_REGEX);
  return new Set(matches ?? []);
}

/**
 * Check if all query tokens appear in the candidate token set.
 * Empty query matches nothing (returns false).
 */
export function allQueryTokensMatch(
  queryTokens: ReadonlySet<string>,
  candidateTokens: ReadonlySet<string>,
): boolean {
  if (queryTokens.size === 0) return false;
  for (const token of queryTokens) {
    if (!candidateTokens.has(token)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Query type
// ---------------------------------------------------------------------------

export interface ResumeQuery {
  readonly gitHeadSha?: string;
  readonly gitBranch?: string;
  readonly freeTextQuery?: string;
}

// ---------------------------------------------------------------------------
// Tier assignment logic
// ---------------------------------------------------------------------------

/**
 * Assign a tier to a session summary based on the query.
 * Highest matching tier wins (tier 1 = best).
 */
export function assignTier(summary: HealthySessionSummary, query: ResumeQuery): TierAssignment {
  // Tier 1: exact match on git_head_sha
  if (query.gitHeadSha && summary.observations.gitHeadSha === query.gitHeadSha) {
    return { tier: 1, kind: 'matched_head_sha' };
  }

  // Tier 2: exact or prefix match on git_branch
  if (query.gitBranch && summary.observations.gitBranch) {
    if (summary.observations.gitBranch === query.gitBranch) {
      return { tier: 2, kind: 'matched_branch', matchType: 'exact' };
    }
    if (summary.observations.gitBranch.startsWith(query.gitBranch) ||
        query.gitBranch.startsWith(summary.observations.gitBranch)) {
      return { tier: 2, kind: 'matched_branch', matchType: 'prefix' };
    }
  }

  // Tier 3: token match on recap notes
  if (query.freeTextQuery && summary.recapSnippet) {
    const queryTokens = normalizeToTokens(query.freeTextQuery);
    const noteTokens = normalizeToTokens(summary.recapSnippet);
    if (allQueryTokensMatch(queryTokens, noteTokens)) {
      return { tier: 3, kind: 'matched_notes' };
    }
  }

  // Tier 4: token match on workflow id/name
  if (query.freeTextQuery) {
    const queryTokens = normalizeToTokens(query.freeTextQuery);
    const workflowText = [
      summary.workflow.workflowId ?? '',
      summary.workflow.workflowName ?? '',
    ].join(' ');
    const workflowTokens = normalizeToTokens(workflowText);
    if (allQueryTokensMatch(queryTokens, workflowTokens)) {
      return { tier: 4, kind: 'matched_workflow_id' };
    }
  }

  // Tier 5: recency fallback
  return { tier: 5, kind: 'recency_fallback' };
}

/**
 * Derive WhyMatched from TierAssignment (closed-set mapping).
 */
function tierToWhyMatched(tier: TierAssignment): WhyMatched {
  switch (tier.kind) {
    case 'matched_head_sha': return 'matched_head_sha';
    case 'matched_branch': return 'matched_branch';
    case 'matched_notes': return 'matched_notes';
    case 'matched_workflow_id': return 'matched_workflow_id';
    case 'recency_fallback': return 'recency_fallback';
  }
}

// ---------------------------------------------------------------------------
// Ranked candidate output
// ---------------------------------------------------------------------------

export interface RankedResumeCandidate {
  readonly sessionId: SessionId;
  readonly runId: string;
  readonly preferredTipNodeId: string;
  readonly snippet: string;
  readonly whyMatched: readonly WhyMatched[];
  readonly tierAssignment: TierAssignment;
  readonly lastActivityEventIndex: number;
}

/** Max candidates returned (locked §2.3). */
export const MAX_RESUME_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Pure ranking function
// ---------------------------------------------------------------------------

/**
 * Rank session summaries against a query using the locked 5-tier algorithm.
 *
 * Lock §2.3: Strict tiered matching, deterministic ordering.
 *
 * Within a tier, order by:
 * 1. lastActivityEventIndex desc (most recent first)
 * 2. sessionId lex (deterministic tie-breaker)
 *
 * Returns at most MAX_RESUME_CANDIDATES candidates.
 */
export function rankResumeCandidates(
  summaries: readonly HealthySessionSummary[],
  query: ResumeQuery,
): readonly RankedResumeCandidate[] {
  // Assign tier to each summary
  const withTier = summaries.map((summary) => ({
    summary,
    tier: assignTier(summary, query),
  }));

  // Sort: tier asc, lastActivityEventIndex desc, sessionId lex
  const sorted = [...withTier].sort((a, b) => {
    if (a.tier.tier !== b.tier.tier) return a.tier.tier - b.tier.tier;
    const actA = a.summary.preferredTip.lastActivityEventIndex;
    const actB = b.summary.preferredTip.lastActivityEventIndex;
    if (actA !== actB) return actB - actA; // desc
    return String(a.summary.sessionId).localeCompare(String(b.summary.sessionId));
  });

  // Take top N and map to output
  return sorted.slice(0, MAX_RESUME_CANDIDATES).map(({ summary, tier }) => ({
    sessionId: summary.sessionId,
    runId: summary.runId,
    preferredTipNodeId: summary.preferredTip.nodeId,
    snippet: summary.recapSnippet ?? '',
    whyMatched: [tierToWhyMatched(tier)],
    tierAssignment: tier,
    lastActivityEventIndex: summary.preferredTip.lastActivityEventIndex,
  }));
}
