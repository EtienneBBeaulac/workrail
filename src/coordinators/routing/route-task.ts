/**
 * Adaptive Pipeline Routing: routeTask()
 *
 * Pure synchronous function. No I/O except the injectable fileExists check.
 * No LLM calls. No async. Same inputs always produce the same output (determinism invariant).
 *
 * Rules applied in priority order (first match wins):
 * 1. dep-bump keywords AND PR/MR number in goal -> QUICK_REVIEW
 * 2. PR/MR number in goal OR github_prs_poll trigger provider -> REVIEW_ONLY
 * 3. .workrail/current-pitch.md exists in workspace -> IMPLEMENT
 * 4. Default -> FULL
 *
 * WHY context-sensitive PR regex (not bare `#\d+`):
 * A task like "refactor auth code" must not match REVIEW_ONLY just because
 * a ticket number like "#123" appears. `\bPR\s*#\d+\b` and `\bMR\s*!?\d+\b`
 * are specific to pull/merge request references (rabbit hole #4 in pitch).
 *
 * Design invariant: routeTask() is the ONLY place routing decisions are made.
 * The adaptive-pipeline.ts entry point calls it before writing the routing log
 * and before spawning any session. No routing logic in mode executors.
 */

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Named pipeline mode -- discriminated union.
 *
 * WHY discriminated union: exhaustive switch at compile time ensures every
 * routing decision handles all variants. No string comparison bugs.
 * Makes illegal combinations (e.g., IMPLEMENT without pitchPath) unrepresentable.
 */
export type PipelineMode =
  | { readonly kind: 'QUICK_REVIEW'; readonly prNumbers: readonly number[] }
  | { readonly kind: 'REVIEW_ONLY'; readonly prNumbers: readonly number[] }
  | { readonly kind: 'IMPLEMENT'; readonly pitchPath: string }
  | { readonly kind: 'FULL'; readonly goal: string }
  | { readonly kind: 'ESCALATE'; readonly reason: string };

/**
 * Deps injected into routeTask() for the single fileExists check.
 *
 * WHY injectable: allows tests to exercise all routing rules without
 * touching the real filesystem. The dep is a single function because
 * routeTask() has zero other I/O needs.
 */
export interface RoutingDeps {
  readonly fileExists: (path: string) => boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTING CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dep-bump keywords: goal must contain one of these to qualify for Rule 1.
 * Matched case-insensitively against the normalized goal string.
 */
const DEP_BUMP_KEYWORDS = [
  'bump',
  'chore:',
  'dependabot',
  'dependency upgrade',
] as const;

/**
 * Context-sensitive PR/MR number regex.
 *
 * WHY two patterns:
 * - PR_REGEX: matches "PR #123", "PR#123", "PR # 123" (GitHub-style)
 * - MR_REGEX: matches "MR !123", "MR!123", "MR #123" (GitLab-style)
 *
 * WHY word boundaries (\b) before PR/MR:
 * Prevents matching "APPROVE #123" or "XPRO #123" as PR references.
 *
 * WHY NOT bare `#\d+`:
 * Would match ticket numbers in task descriptions like "Fix issue #42" -> REVIEW_ONLY.
 * This would be a false positive that incorrectly skips discovery+shaping.
 */
const PR_REGEX = /\bPR\s*#\d+\b/i;
const MR_REGEX = /\bMR\s*!?\d+\b/i;

/**
 * Relative path to the pitch file within the workspace.
 * If this file exists, route to IMPLEMENT.
 */
const PITCH_FILE_PATH = '.workrail/current-pitch.md';

// ═══════════════════════════════════════════════════════════════════════════
// PURE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract PR numbers from a goal string.
 *
 * Returns all numeric values found in PR/MR references.
 * Returns empty array if no PR/MR references are found.
 *
 * Examples:
 *   "Review PR #123" -> [123]
 *   "Review MR !456 and PR #789" -> [456, 789]
 *   "Refactor auth code" -> []
 */
export function extractPrNumbers(goal: string): number[] {
  const numbers: number[] = [];

  // Extract from PR #N references
  const prMatches = goal.matchAll(/\bPR\s*#(\d+)\b/gi);
  for (const match of prMatches) {
    const n = parseInt(match[1]!, 10);
    if (!isNaN(n)) numbers.push(n);
  }

  // Extract from MR !N or MR #N references
  const mrMatches = goal.matchAll(/\bMR\s*!?#?(\d+)\b/gi);
  for (const match of mrMatches) {
    const n = parseInt(match[1]!, 10);
    if (!isNaN(n)) numbers.push(n);
  }

  return numbers;
}

/**
 * Returns true if the goal contains dep-bump keywords.
 * Case-insensitive match.
 */
function hasDependencyBumpKeywords(goal: string): boolean {
  const lower = goal.toLowerCase();
  return DEP_BUMP_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Returns true if the goal contains a context-sensitive PR or MR reference.
 */
function hasPrOrMrReference(goal: string): boolean {
  return PR_REGEX.test(goal) || MR_REGEX.test(goal);
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTING FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Route a task goal to the appropriate pipeline mode.
 *
 * Pure function. No async. No LLM. No I/O except the injectable fileExists check.
 * Rules are applied in priority order; first match wins.
 *
 * @param goal - The task goal string (e.g. "Review PR #123" or "Implement auth refresh")
 * @param workspace - Absolute path to the workspace directory
 * @param deps - Injectable { fileExists } for pitch detection
 * @param triggerProvider - Optional trigger provider name (e.g. 'github_prs_poll')
 * @returns PipelineMode discriminated union
 */
export function routeTask(
  goal: string,
  workspace: string,
  deps: RoutingDeps,
  triggerProvider?: string,
): PipelineMode {
  const prNumbers = extractPrNumbers(goal);
  const hasDepBump = hasDependencyBumpKeywords(goal);
  const hasPrRef = hasPrOrMrReference(goal);
  const isGithubPrsPoll = triggerProvider === 'github_prs_poll';

  // ── Rule 1: QUICK_REVIEW ─────────────────────────────────────────────────
  // dep-bump keywords AND PR/MR number in goal
  // WHY AND: dep-bump without a PR number means we don't know what to review.
  // In that case, fall through to IMPLEMENT or FULL (no pitch, no PR = FULL).
  if (hasDepBump && hasPrRef) {
    return { kind: 'QUICK_REVIEW', prNumbers };
  }

  // ── Rule 2: REVIEW_ONLY ──────────────────────────────────────────────────
  // PR/MR number in goal OR github_prs_poll trigger provider
  // WHY OR: the queue poller fires with provider='github_prs_poll' even when
  // the goal text doesn't contain an explicit PR number (the PR number may be
  // in the trigger context, not the goal string).
  if (hasPrRef || isGithubPrsPoll) {
    return { kind: 'REVIEW_ONLY', prNumbers };
  }

  // ── Rule 3: IMPLEMENT ────────────────────────────────────────────────────
  // .workrail/current-pitch.md exists in workspace
  // WHY relative join: the coordinator passes workspace as an absolute path;
  // we form the full path by joining with the relative pitch location.
  // The fileExists dep is the ONLY I/O in this function.
  const pitchPath = workspace.endsWith('/')
    ? workspace + PITCH_FILE_PATH
    : workspace + '/' + PITCH_FILE_PATH;

  if (deps.fileExists(pitchPath)) {
    return { kind: 'IMPLEMENT', pitchPath };
  }

  // ── Rule 4: FULL (default) ───────────────────────────────────────────────
  // No signals matched -- full discovery+shaping+coding+review pipeline.
  return { kind: 'FULL', goal };
}
