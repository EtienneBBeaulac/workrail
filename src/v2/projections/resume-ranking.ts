import type { SessionId, WorkflowHash, WorkflowId } from '../durable-core/ids/index.js';
import { TRUNCATION_MARKER } from '../durable-core/constants.js';

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

/**
 * Workflow identity from run_started events.
 *
 * Why discriminated union: a session either has a known workflow (with all
 * required fields) or doesn't. Three nullable fields create 8 combinations,
 * most of which are nonsensical. This makes the two real states explicit
 * and forces exhaustive handling.
 */
export type WorkflowIdentity =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'identified'; readonly workflowId: WorkflowId; readonly workflowHash: WorkflowHash };

/** The identified variant of WorkflowIdentity, for use in types that guarantee workflow presence. */
export type IdentifiedWorkflow = Extract<WorkflowIdentity, { kind: 'identified' }>;

/**
 * Healthy session summary — only constructable after health check + projection.
 * Ranking function accepts only this type, preventing unhealthy sessions from entering.
 *
 * Why IdentifiedWorkflow (not WorkflowIdentity): a healthy session with a run always
 * has a run_started event, which always carries workflowHash. Enforcing this at the
 * type level eliminates null checks in all downstream code.
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
  readonly workflow: IdentifiedWorkflow;
  /** Filesystem modification time (epoch ms). Used for relative-time display. */
  readonly lastModifiedMs: number | null;
  /** Current pending step ID from execution snapshot, if the workflow is in progress. */
  readonly pendingStepId: string | null;
  /** Whether the workflow run has completed (engine state = 'complete'). */
  readonly isComplete: boolean;
}

// ---------------------------------------------------------------------------
// Tier assignment — discriminated union for exhaustive handling
// ---------------------------------------------------------------------------

/** Closed set: why a session matched (locked §2.3). */
export type WhyMatched =
  | 'matched_exact_id'
  | 'matched_head_sha'
  | 'matched_branch'
  | 'matched_notes'
  | 'matched_notes_partial'
  | 'matched_workflow_id'
  | 'recency_fallback';

/** Tier assignment — discriminated union. Exhaustive, testable independently. */
export type TierAssignment =
  | { readonly tier: 0; readonly kind: 'matched_exact_id'; readonly matchField: 'runId' | 'sessionId' }
  | { readonly tier: 1; readonly kind: 'matched_head_sha' }
  | { readonly tier: 2; readonly kind: 'matched_branch'; readonly matchType: 'exact' | 'prefix' }
  | { readonly tier: 3; readonly kind: 'matched_notes' }
  | { readonly tier: 4; readonly kind: 'matched_notes_partial'; readonly matchRatio: number }
  | { readonly tier: 5; readonly kind: 'matched_workflow_id' }
  | { readonly tier: 6; readonly kind: 'recency_fallback' };

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

/**
 * Compute the ratio of query tokens that appear in the candidate token set.
 * Returns 0 if either set is empty.
 */
export function queryTokenMatchRatio(
  queryTokens: ReadonlySet<string>,
  candidateTokens: ReadonlySet<string>,
): number {
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
  let matched = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) matched++;
  }
  return matched / queryTokens.size;
}

/**
 * Fuzzy token match: checks if a query token matches any candidate token via
 * substring containment (either direction).
 *
 * Examples: "owner" matches "ownership", "auth" matches "authentication",
 *           "authentication" matches "auth".
 *
 * Exact matches are handled by Set.has in callers — not duplicated here.
 * Tokens shorter than 3 chars are skipped to avoid false positives.
 */
export function fuzzyTokenMatch(queryToken: string, candidateTokens: ReadonlySet<string>): boolean {
  // Skip very short tokens (1-2 chars) to avoid false positives
  if (queryToken.length < 3) return false;
  for (const ct of candidateTokens) {
    if (ct.length < 3) continue;
    if (ct.includes(queryToken) || queryToken.includes(ct)) return true;
  }
  return false;
}

/**
 * Compute the ratio of query tokens that match candidate tokens using fuzzy matching.
 * Combines exact match + substring containment.
 * Returns 0 if either set is empty.
 */
export function fuzzyQueryTokenMatchRatio(
  queryTokens: ReadonlySet<string>,
  candidateTokens: ReadonlySet<string>,
): number {
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
  let matched = 0;
  for (const qt of queryTokens) {
    if (candidateTokens.has(qt) || fuzzyTokenMatch(qt, candidateTokens)) matched++;
  }
  return matched / queryTokens.size;
}

// ---------------------------------------------------------------------------
// Query type
// ---------------------------------------------------------------------------

export interface ResumeQuery {
  readonly gitHeadSha?: string;
  readonly gitBranch?: string;
  readonly freeTextQuery?: string;
  /** Exact run ID to find — bypasses all other ranking when matched. */
  readonly runId?: string;
  /** Exact session ID to find — bypasses all other ranking when matched. */
  readonly sessionId?: string;
}

// ---------------------------------------------------------------------------
// Tier assignment logic
// ---------------------------------------------------------------------------

/** Minimum partial match ratio to qualify as a partial notes match. */
const MIN_PARTIAL_MATCH_RATIO = 0.4;

/**
 * Assign a tier to a session summary based on the query.
 * Highest matching tier wins (tier 0 = best, exact ID match).
 */
export function assignTier(summary: HealthySessionSummary, query: ResumeQuery): TierAssignment {
  // Tier 0: exact match on runId or sessionId
  if (query.runId && summary.runId === query.runId) {
    return { tier: 0, kind: 'matched_exact_id', matchField: 'runId' };
  }
  if (query.sessionId && String(summary.sessionId) === query.sessionId) {
    return { tier: 0, kind: 'matched_exact_id', matchField: 'sessionId' };
  }

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

  // Normalize query tokens once for text-based tiers (3, 4, 5)
  const queryTokens = query.freeTextQuery ? normalizeToTokens(query.freeTextQuery) : null;

  // Tier 3: ALL token match on recap notes (exact)
  if (queryTokens && queryTokens.size > 0 && summary.recapSnippet) {
    const noteTokens = normalizeToTokens(summary.recapSnippet);
    if (allQueryTokensMatch(queryTokens, noteTokens)) {
      return { tier: 3, kind: 'matched_notes' };
    }
    // Tier 4: partial/fuzzy token match on recap notes (at least MIN_PARTIAL_MATCH_RATIO)
    // Uses fuzzy matching so "owner" matches "ownership", "auth" matches "authentication"
    const ratio = fuzzyQueryTokenMatchRatio(queryTokens, noteTokens);
    if (ratio >= MIN_PARTIAL_MATCH_RATIO) {
      return { tier: 4, kind: 'matched_notes_partial', matchRatio: ratio };
    }
  }

  // Tier 5: exact token match on workflow id
  if (queryTokens && queryTokens.size > 0 && summary.workflow.kind === 'identified') {
    const workflowTokens = normalizeToTokens(String(summary.workflow.workflowId));
    if (allQueryTokensMatch(queryTokens, workflowTokens)) {
      return { tier: 5, kind: 'matched_workflow_id' };
    }
    // Tier 5 also: fuzzy/partial match on workflow id
    const ratio = fuzzyQueryTokenMatchRatio(queryTokens, workflowTokens);
    if (ratio >= MIN_PARTIAL_MATCH_RATIO) {
      return { tier: 5, kind: 'matched_workflow_id' };
    }
  }

  // Tier 6: recency fallback
  return { tier: 6, kind: 'recency_fallback' };
}

/**
 * Derive WhyMatched from TierAssignment (closed-set mapping).
 */
function tierToWhyMatched(tier: TierAssignment): WhyMatched {
  switch (tier.kind) {
    case 'matched_exact_id': return 'matched_exact_id';
    case 'matched_head_sha': return 'matched_head_sha';
    case 'matched_branch': return 'matched_branch';
    case 'matched_notes': return 'matched_notes';
    case 'matched_notes_partial': return 'matched_notes_partial';
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
  /** Non-nullable: HealthySessionSummary guarantees a known workflow with a pinned hash. */
  readonly workflowHash: WorkflowHash;
  /** Non-nullable: required to identify the workflow for session resumption. */
  readonly workflowId: WorkflowId;
  /** Current pending step ID (e.g. "phase-3-implement"), null if unknown or complete. */
  readonly pendingStepId: string | null;
  /** Whether the workflow run has completed. */
  readonly isComplete: boolean;
  /** Filesystem modification time (epoch ms), null if unavailable. */
  readonly lastModifiedMs: number | null;
}

/** Max candidates returned (locked §2.3). */
export const MAX_RESUME_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Pure ranking function
// ---------------------------------------------------------------------------

/**
 * Rank session summaries against a query using the 7-tier algorithm.
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

  // Sort: tier asc, then completed after in-progress within same tier,
  // matchRatio desc (for partial matches), lastActivityEventIndex desc, sessionId lex.
  // Note: tier takes priority over completion status so that a completed session
  // with an exact ID match (tier 0) still ranks above an in-progress recency fallback (tier 6).
  const sorted = [...withTier].sort((a, b) => {
    if (a.tier.tier !== b.tier.tier) return a.tier.tier - b.tier.tier;
    // Within the same tier, completed sessions sort after in-progress ones
    if (a.summary.isComplete !== b.summary.isComplete) {
      return a.summary.isComplete ? 1 : -1;
    }
    // Within partial notes tier, higher match ratio wins
    if (a.tier.kind === 'matched_notes_partial' && b.tier.kind === 'matched_notes_partial') {
      if (a.tier.matchRatio !== b.tier.matchRatio) return b.tier.matchRatio - a.tier.matchRatio;
    }
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
    workflowHash: summary.workflow.workflowHash,
    workflowId: summary.workflow.workflowId,
    pendingStepId: summary.pendingStepId,
    isComplete: summary.isComplete,
    lastModifiedMs: summary.lastModifiedMs,
  }));
}
