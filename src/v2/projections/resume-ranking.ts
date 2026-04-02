import type { SessionId, WorkflowHash, WorkflowId } from '../durable-core/ids/index.js';
import { MAX_RESUME_PREVIEW_BYTES, TRUNCATION_MARKER } from '../durable-core/constants.js';
import {
  createRecapPreviewSegment,
  createSessionTitlePreviewSegment,
  renderBudgetedResumePreview,
} from '../durable-core/domain/retrieval-contract.js';
export { MAX_RESUME_PREVIEW_BYTES } from '../durable-core/constants.js';

// ---------------------------------------------------------------------------
// Domain types — make illegal states unrepresentable
// ---------------------------------------------------------------------------

/**
 * Bounded, pre-truncated recap snippet.
 * Branded type ensures only properly truncated text enters ranking.
 */
export type RecapSnippet = string & { readonly __brand: 'RecapSnippet' };

/** Max bytes per snippet (locked §2.3). */
const MAX_SNIPPET_BYTES = MAX_RESUME_PREVIEW_BYTES;

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
  readonly repoRoot: string | null;
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
  /** Human-readable title derived from persisted run context or early recap text. */
  readonly sessionTitle: string | null;
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
  | 'matched_repo_root'
  | 'matched_branch'
  | 'matched_notes'
  | 'matched_notes_partial'
  | 'matched_workflow_id'
  | 'recency_fallback';

/** Tier assignment — discriminated union. Exhaustive, testable independently. */
export type TierAssignment =
  | { readonly tier: 0; readonly kind: 'matched_exact_id'; readonly matchField: 'runId' | 'sessionId' }
  | { readonly tier: 1; readonly kind: 'matched_notes' }
  | { readonly tier: 2; readonly kind: 'matched_notes_partial'; readonly matchRatio: number }
  | { readonly tier: 3; readonly kind: 'matched_workflow_id' }
  | { readonly tier: 4; readonly kind: 'matched_head_sha' }
  | { readonly tier: 5; readonly kind: 'matched_branch'; readonly matchType: 'exact' | 'prefix' }
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
  readonly repoRootHash?: string;
  readonly sameWorkspaceOnly?: boolean;
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
 * Low-signal query words that appear in many coding-task sessions.
 * These still count, but they should not drown out distinctive words like "ownership".
 */
const LOW_SIGNAL_QUERY_TOKENS = new Set([
  'task',
  'dev',
  'work',
  'workflow',
  'coding',
  'feature',
  'phase',
  'implement',
  'implementation',
  'review',
  'fix',
  'bug',
]);

function tokenSpecificityWeight(token: string): number {
  if (token.length <= 2) return 0.2;
  if (LOW_SIGNAL_QUERY_TOKENS.has(token)) return 0.35;
  return Math.min(2.5, 1 + Math.max(0, token.length - 4) * 0.18);
}

function weightedFuzzyQueryTokenMatchRatio(
  queryTokens: ReadonlySet<string>,
  candidateTokens: ReadonlySet<string>,
): number {
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  let matchedWeight = 0;
  let totalWeight = 0;

  for (const qt of queryTokens) {
    const weight = tokenSpecificityWeight(qt);
    totalWeight += weight;
    if (candidateTokens.has(qt) || fuzzyTokenMatch(qt, candidateTokens)) {
      matchedWeight += weight;
    }
  }

  return totalWeight === 0 ? 0 : matchedWeight / totalWeight;
}

function repoScopeMatches(summary: HealthySessionSummary, query: ResumeQuery): boolean {
  return Boolean(
    query.repoRootHash &&
    summary.observations.repoRootHash &&
    query.repoRootHash === summary.observations.repoRootHash,
  );
}

function shouldKeepSummary(summary: HealthySessionSummary, query: ResumeQuery): boolean {
  if (!query.sameWorkspaceOnly) return true;
  if (!query.repoRootHash) return true;
  return repoScopeMatches(summary, query);
}

/** Build the main searchable session text surface from identity-bearing session fields. */
function buildSearchableSessionText(summary: HealthySessionSummary): string {
  return [summary.sessionTitle, summary.recapSnippet]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join('\n\n');
}

function collectMatchReasons(summary: HealthySessionSummary, query: ResumeQuery, tier: TierAssignment): readonly WhyMatched[] {
  const reasons: WhyMatched[] = [tierToWhyMatched(tier)];

  if (repoScopeMatches(summary, query) && !reasons.includes('matched_repo_root')) {
    reasons.push('matched_repo_root');
  }

  if (
    query.gitHeadSha &&
    summary.observations.gitHeadSha === query.gitHeadSha &&
    !reasons.includes('matched_head_sha')
  ) {
    reasons.push('matched_head_sha');
  }

  if (
    query.gitBranch &&
    summary.observations.gitBranch &&
    (
      summary.observations.gitBranch === query.gitBranch ||
      summary.observations.gitBranch.startsWith(query.gitBranch) ||
      query.gitBranch.startsWith(summary.observations.gitBranch)
    ) &&
    !reasons.includes('matched_branch')
  ) {
    reasons.push('matched_branch');
  }

  return reasons;
}

function buildPreviewSnippet(summary: HealthySessionSummary, query: ResumeQuery): string {
  const segments = [
    summary.sessionTitle ? createSessionTitlePreviewSegment(summary.sessionTitle) : null,
    summary.recapSnippet ? createRecapPreviewSegment(summary.recapSnippet) : null,
  ].filter((segment): segment is NonNullable<typeof segment> => segment !== null);

  if (segments.length === 0) return '';

  const focusTerms = query.freeTextQuery ? [...normalizeToTokens(query.freeTextQuery)] : [];
  return renderBudgetedResumePreview({ segments, focusTerms }).text;
}

function deriveConfidence(tier: TierAssignment, reasons: readonly WhyMatched[]): 'strong' | 'medium' | 'weak' {
  if (tier.kind === 'matched_exact_id' || tier.kind === 'matched_notes') return 'strong';
  if (tier.kind === 'matched_notes_partial' || tier.kind === 'matched_workflow_id') return 'medium';
  if (reasons.includes('matched_repo_root') || reasons.includes('matched_head_sha') || reasons.includes('matched_branch')) {
    return 'medium';
  }
  return 'weak';
}

function buildMatchExplanation(
  tier: TierAssignment,
  reasons: readonly WhyMatched[],
  summary: HealthySessionSummary,
): string {
  const parts: string[] = [];

  switch (tier.kind) {
    case 'matched_exact_id':
      parts.push(`Exact ${tier.matchField} match`);
      break;
    case 'matched_notes':
      parts.push('Strong text match against session title/notes');
      break;
    case 'matched_notes_partial':
      parts.push(`Partial text match (${Math.round(tier.matchRatio * 100)}%) against session title/notes`);
      break;
    case 'matched_workflow_id':
      parts.push('Matched workflow type');
      break;
    case 'matched_head_sha':
      parts.push('Matched current git commit');
      break;
    case 'matched_branch':
      parts.push(tier.matchType === 'exact' ? 'Matched current git branch' : 'Partially matched current git branch');
      break;
    case 'recency_fallback':
      parts.push('Recent session with no stronger explicit match');
      break;
  }

  if (reasons.includes('matched_repo_root')) parts.push('same workspace');
  if (summary.isComplete) parts.push('completed');

  return parts.join('; ');
}

/** Compute a fuzzy query relevance score across session text, workflow id, and branch. */
export function computeQueryRelevanceScore(summary: HealthySessionSummary, query: ResumeQuery): number {
  const queryTokens = query.freeTextQuery ? normalizeToTokens(query.freeTextQuery) : null;
  const repoBonus = repoScopeMatches(summary, query) ? 0.2 : 0;
  if (!queryTokens || queryTokens.size === 0) return repoBonus;

  const sessionText = buildSearchableSessionText(summary);
  const sessionTextRatio = sessionText
    ? weightedFuzzyQueryTokenMatchRatio(queryTokens, normalizeToTokens(sessionText))
    : 0;

  const workflowRatio = weightedFuzzyQueryTokenMatchRatio(
    queryTokens,
    normalizeToTokens(String(summary.workflow.workflowId)),
  );

  const branchRatio = summary.observations.gitBranch
    ? weightedFuzzyQueryTokenMatchRatio(queryTokens, normalizeToTokens(summary.observations.gitBranch))
    : 0;

  // Session text is the highest-signal surface. Workflow ID and branch act as weaker tie-breakers.
  return Math.max(sessionTextRatio + repoBonus, workflowRatio * 0.75 + repoBonus, branchRatio * 0.5 + repoBonus);
}

/**
 * Assign a tier to a session summary based on the query.
 * Highest matching tier wins (tier 0 = best, exact ID match).
 *
 * Design choice: if the user supplied an explicit free-text query, match their
 * words against persisted session text BEFORE passive git-context signals. This
 * prevents "same current HEAD" from drowning out "resume the MR ownership task".
 */
export function assignTier(summary: HealthySessionSummary, query: ResumeQuery): TierAssignment {
  // Tier 0: exact match on runId or sessionId
  if (query.runId && summary.runId === query.runId) {
    return { tier: 0, kind: 'matched_exact_id', matchField: 'runId' };
  }
  if (query.sessionId && String(summary.sessionId) === query.sessionId) {
    return { tier: 0, kind: 'matched_exact_id', matchField: 'sessionId' };
  }

  // Normalize query tokens once for text-based tiers (1, 2, 3)
  const queryTokens = query.freeTextQuery ? normalizeToTokens(query.freeTextQuery) : null;

  // Tier 1/2: query match on searchable session text (context-derived title + recap).
  if (queryTokens && queryTokens.size > 0) {
    const sessionText = buildSearchableSessionText(summary);
    if (sessionText) {
      const sessionTextTokens = normalizeToTokens(sessionText);
      if (allQueryTokensMatch(queryTokens, sessionTextTokens)) {
        return { tier: 1, kind: 'matched_notes' };
      }

      const ratio = weightedFuzzyQueryTokenMatchRatio(queryTokens, sessionTextTokens);
      if (ratio >= MIN_PARTIAL_MATCH_RATIO) {
        return { tier: 2, kind: 'matched_notes_partial', matchRatio: ratio };
      }
    }

    // Tier 3: exact or partial match on workflow id
    const workflowTokens = normalizeToTokens(String(summary.workflow.workflowId));
    if (allQueryTokensMatch(queryTokens, workflowTokens)) {
      return { tier: 3, kind: 'matched_workflow_id' };
    }

    const workflowRatio = weightedFuzzyQueryTokenMatchRatio(queryTokens, workflowTokens);
    if (workflowRatio >= MIN_PARTIAL_MATCH_RATIO) {
      return { tier: 3, kind: 'matched_workflow_id' };
    }
  }

  // Tier 4: exact match on git_head_sha
  if (query.gitHeadSha && summary.observations.gitHeadSha === query.gitHeadSha) {
    return { tier: 4, kind: 'matched_head_sha' };
  }

  // Tier 5: exact or prefix match on git_branch
  if (query.gitBranch && summary.observations.gitBranch) {
    if (summary.observations.gitBranch === query.gitBranch) {
      return { tier: 5, kind: 'matched_branch', matchType: 'exact' };
    }
    if (
      summary.observations.gitBranch.startsWith(query.gitBranch) ||
      query.gitBranch.startsWith(summary.observations.gitBranch)
    ) {
      return { tier: 5, kind: 'matched_branch', matchType: 'prefix' };
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
  /** Human-readable identity hint for the session. */
  readonly sessionTitle: string | null;
  /** Git branch observed for the session, if known. */
  readonly gitBranch: string | null;
  /** Current pending step ID (e.g. "phase-3-implement"), null if unknown or complete. */
  readonly pendingStepId: string | null;
  /** Whether the workflow run has completed. */
  readonly isComplete: boolean;
  /** Filesystem modification time (epoch ms), null if unavailable. */
  readonly lastModifiedMs: number | null;
  /** Coarse confidence band for agent-facing recommendation quality. */
  readonly confidence: 'strong' | 'medium' | 'weak';
  /** Short natural-language explanation of the ranking outcome. */
  readonly matchExplanation: string;
}

/** Max candidates returned (locked §2.3). */
export const MAX_RESUME_CANDIDATES = 5;

// ---------------------------------------------------------------------------
// Pure ranking function
// ---------------------------------------------------------------------------

/**
 * Rank session summaries against a query using the 7-tier algorithm.
 *
 * Query-bearing signals are ranked ahead of passive git-context signals.
 * Deterministic ordering is preserved within each tier.
 *
 * Within a tier, order by:
 * 1. same repo as current workspace
 * 2. in-progress over completed
 * 3. query relevance score desc
 * 4. partial-match ratio desc (for partial text matches)
 * 5. lastActivityEventIndex desc
 * 6. sessionId lex
 *
 * Returns at most MAX_RESUME_CANDIDATES candidates.
 */
export function rankResumeCandidates(
  summaries: readonly HealthySessionSummary[],
  query: ResumeQuery,
): readonly RankedResumeCandidate[] {
  // Assign tier to each summary
  const withTier = summaries
    .filter((summary) => shouldKeepSummary(summary, query))
    .map((summary) => ({
      summary,
      tier: assignTier(summary, query),
      queryScore: computeQueryRelevanceScore(summary, query),
    }));

  // Sort: tier asc, then completed after in-progress within same tier,
  // queryScore desc, matchRatio desc (for partial matches), lastActivityEventIndex desc, sessionId lex.
  // Note: tier takes priority over completion status so that a completed session
  // with an exact ID match (tier 0) still ranks above an in-progress recency fallback (tier 6).
  const sorted = [...withTier].sort((a, b) => {
    if (a.tier.tier !== b.tier.tier) return a.tier.tier - b.tier.tier;
    const aSameRepo = repoScopeMatches(a.summary, query);
    const bSameRepo = repoScopeMatches(b.summary, query);
    if (aSameRepo !== bSameRepo) return aSameRepo ? -1 : 1;
    // Within the same tier, completed sessions sort after in-progress ones
    if (a.summary.isComplete !== b.summary.isComplete) {
      return a.summary.isComplete ? 1 : -1;
    }
    if (a.queryScore !== b.queryScore) return b.queryScore - a.queryScore;
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
  return sorted.slice(0, MAX_RESUME_CANDIDATES).map(({ summary, tier }) => {
    const whyMatched = collectMatchReasons(summary, query, tier);
    return {
      sessionId: summary.sessionId,
      runId: summary.runId,
      preferredTipNodeId: summary.preferredTip.nodeId,
      snippet: buildPreviewSnippet(summary, query),
      whyMatched,
      tierAssignment: tier,
      lastActivityEventIndex: summary.preferredTip.lastActivityEventIndex,
      workflowHash: summary.workflow.workflowHash,
      workflowId: summary.workflow.workflowId,
      sessionTitle: summary.sessionTitle,
      gitBranch: summary.observations.gitBranch,
      pendingStepId: summary.pendingStepId,
      isComplete: summary.isComplete,
      lastModifiedMs: summary.lastModifiedMs,
      confidence: deriveConfidence(tier, whyMatched),
      matchExplanation: buildMatchExplanation(tier, whyMatched, summary),
    };
  });
}
