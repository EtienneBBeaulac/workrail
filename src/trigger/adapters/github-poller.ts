/**
 * WorkRail Auto: GitHub Issues and PRs Polling Adapter
 *
 * Fetches new or updated issues and pull requests from the GitHub REST API.
 *
 * APIs used:
 *   Issues: GET /repos/:owner/:repo/issues
 *     ?state=open&since=<ISO 8601>&sort=updated&direction=desc&per_page=100
 *     [&labels=<labelFilter>]
 *   PRs:    GET /repos/:owner/:repo/pulls
 *     ?state=open&sort=updated&direction=desc&per_page=100
 *
 *   Header: Authorization: Bearer <token>
 *
 * Design notes:
 * - fetchFn is injectable for testing without real HTTP. Defaults to globalThis.fetch.
 * - Returns Result<Item[], GitHubPollError> -- no throws at the boundary.
 * - Issues API: supports a `since` (ISO 8601) server-side filter. Use lastPollAt directly.
 * - PRs API: does NOT support a `since` parameter. Fetch all open PRs sorted by update
 *   time (desc), then filter client-side: only items with updated_at > since.
 * - Pagination: only the first page (100 items) is fetched. If more than 100 issues/PRs
 *   were updated in one poll interval, some will be deferred to the next cycle.
 *   This is an accepted limitation documented in GitHubPollingSource.
 * - excludeAuthors: items whose user.login exactly matches an entry are dropped before
 *   dispatch. IMPORTANT: set this to your WorkTrain bot account login to prevent
 *   infinite self-review loops.
 *   TODO(follow-up): add glob pattern matching for bot accounts with variable suffixes.
 * - notLabels: items with ANY matching label name are dropped (client-side filter).
 * - labelFilter: passed as `labels=` query parameter to the Issues API (server-side include).
 *   Not supported by the PRs API -- ignored silently for github_prs_poll.
 * - Rate limiting: if X-RateLimit-Remaining < 100, the cycle is skipped (ok([]) returned)
 *   and a warning is logged with the reset timestamp. This is not an error -- the next
 *   cycle will proceed normally after the rate limit resets.
 *
 * Note on the Issues API: GitHub's Issues endpoint returns open PRs as well (a PR is
 * also an issue). If you want PR-only polling, use github_prs_poll instead.
 * If you use github_issues_poll with labelFilter, open PRs with those labels will
 * also be returned.
 *
 * At-least-once delivery: this function only fetches data. The caller
 * (PollingScheduler) is responsible for dispatch ordering and recording.
 */

import type { GitHubPollingSource } from '../types.js';
import type { Result } from '../../runtime/result.js';
import { ok, err } from '../../runtime/result.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Label shape from GitHub API */
export interface GitHubLabel {
  readonly name: string;
}

/**
 * A GitHub Issue as returned by the Issues list API.
 * Contains only the fields needed by the polling scheduler.
 *
 * Note: this shape also matches open PRs returned by the Issues endpoint.
 * If you need PR-only polling, use pollGitHubPRs instead.
 */
export interface GitHubIssue {
  /** Globally unique issue ID (across all repos). Used as the deduplication key. */
  readonly id: number;
  /** Repository-scoped issue number (the #123 number). */
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly updated_at: string;
  readonly state: string;
  /** Author login. Used for excludeAuthors filtering. */
  readonly user?: { readonly login?: string };
  /** Labels on the issue. Used for notLabels filtering. */
  readonly labels?: readonly GitHubLabel[];
}

/**
 * A GitHub Pull Request as returned by the PRs list API.
 * Contains only the fields needed by the polling scheduler.
 */
export interface GitHubPR {
  /** Globally unique PR ID (across all repos). Used as the deduplication key. */
  readonly id: number;
  /** Repository-scoped PR number (the #123 number). */
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly updated_at: string;
  readonly state: string;
  /** Author login. Used for excludeAuthors filtering. */
  readonly user?: { readonly login?: string };
  /** Whether the PR is a draft. */
  readonly draft?: boolean;
  /** Labels on the PR. Used for notLabels filtering. */
  readonly labels?: readonly GitHubLabel[];
}

export type GitHubPollError =
  | { readonly kind: 'http_error'; readonly status: number; readonly message: string }
  | { readonly kind: 'network_error'; readonly message: string }
  | { readonly kind: 'parse_error'; readonly message: string };

/**
 * Injectable fetch function type. Matches the global fetch signature.
 * Default: globalThis.fetch (Node 18+).
 */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Rate limit check
// ---------------------------------------------------------------------------

/**
 * Check the GitHub API rate limit headers on a successful response.
 * Returns true if the rate limit is healthy (>= 100 remaining).
 * Returns false and logs a warning if remaining < 100.
 *
 * WHY skip rather than error: rate limit exhaustion is temporary and expected
 * under burst conditions. Returning ok([]) means the caller records an empty
 * poll cycle and the next cycle proceeds normally after the reset time.
 */
function checkRateLimit(response: Response): boolean {
  const remainingHeader = response.headers.get('X-RateLimit-Remaining');
  const resetHeader = response.headers.get('X-RateLimit-Reset');
  if (remainingHeader === null) return true; // No header: assume healthy

  const remaining = parseInt(remainingHeader, 10);
  if (isNaN(remaining) || remaining >= 100) return true;

  const resetTs = parseInt(resetHeader ?? '0', 10);
  const resetAt = resetTs > 0 ? new Date(resetTs * 1000).toISOString() : 'unknown';
  console.warn(
    `[GitHubPoller] Rate limit low: remaining=${remaining}, resets at ${resetAt}. ` +
    `Skipping poll cycle to avoid exhaustion.`,
  );
  return false;
}

// ---------------------------------------------------------------------------
// pollGitHubIssues: fetch open issues updated since a timestamp
// ---------------------------------------------------------------------------

/**
 * Fetch GitHub Issues updated after the given timestamp.
 *
 * Uses the Issues list API with `since=<lastPollAt>` (server-side filter).
 * Also applies client-side filters: excludeAuthors, notLabels.
 *
 * @param source - GitHub polling source configuration
 * @param since - ISO 8601 timestamp; only issues updated after this are returned
 * @param fetchFn - Optional injectable fetch function (default: globalThis.fetch)
 * @returns Result<GitHubIssue[], GitHubPollError>
 *
 * Notes:
 * - Only fetches the first page (per_page=100). Pagination is not implemented.
 * - The `since` param is passed directly to the GitHub API as a server-side filter.
 * - If X-RateLimit-Remaining < 100, returns ok([]) and logs a warning.
 * - If source.excludeAuthors is empty, a warning was already emitted at config load time.
 *   The adapter does not re-warn here -- it simply does not filter.
 */
export async function pollGitHubIssues(
  source: GitHubPollingSource,
  since: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<Result<GitHubIssue[], GitHubPollError>> {
  const [owner, repo] = source.repo.split('/');
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('since', since);
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'desc');
  url.searchParams.set('per_page', '100');
  if (source.labelFilter.length > 0) {
    url.searchParams.set('labels', source.labelFilter.join(','));
  }

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      headers: {
        'Authorization': `Bearer ${source.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (e) {
    return err({
      kind: 'network_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (!response.ok) {
    return err({
      kind: 'http_error',
      status: response.status,
      message: `GitHub API returned HTTP ${response.status}: ${response.statusText}`,
    });
  }

  if (!checkRateLimit(response)) {
    return ok([]);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (e) {
    return err({
      kind: 'parse_error',
      message: `Failed to parse GitHub Issues API response: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  if (!Array.isArray(raw)) {
    return err({
      kind: 'parse_error',
      message: `Expected array from GitHub Issues API, got: ${typeof raw}`,
    });
  }

  const issues: GitHubIssue[] = [];
  for (const item of raw) {
    if (isGitHubIssueShape(item)) {
      issues.push(item);
    }
  }

  return ok(applyIssueFilters(issues, source));
}

// ---------------------------------------------------------------------------
// pollGitHubPRs: fetch open PRs sorted by update time
// ---------------------------------------------------------------------------

/**
 * Fetch GitHub Pull Requests updated after the given timestamp.
 *
 * The PRs list API has no `since` parameter. Fetches all open PRs sorted by
 * update time (desc) and filters client-side: only items with updated_at > since.
 * This means more items are fetched per cycle than the Issues adapter, but the
 * result set is equivalent given the 100-item page limit.
 *
 * @param source - GitHub polling source configuration
 * @param since - ISO 8601 timestamp; only PRs with updated_at > since are returned
 * @param fetchFn - Optional injectable fetch function (default: globalThis.fetch)
 * @returns Result<GitHubPR[], GitHubPollError>
 *
 * Notes:
 * - Only fetches the first page (per_page=100). Pagination is not implemented.
 * - `labelFilter` is NOT passed to the PRs endpoint (unsupported). Ignored silently.
 * - If X-RateLimit-Remaining < 100, returns ok([]) and logs a warning.
 */
export async function pollGitHubPRs(
  source: GitHubPollingSource,
  since: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<Result<GitHubPR[], GitHubPollError>> {
  const [owner, repo] = source.repo.split('/');
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/pulls`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'desc');
  url.searchParams.set('per_page', '100');
  // NOTE: labelFilter is not supported by the PRs list endpoint. Ignored.

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      headers: {
        'Authorization': `Bearer ${source.token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (e) {
    return err({
      kind: 'network_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (!response.ok) {
    return err({
      kind: 'http_error',
      status: response.status,
      message: `GitHub API returned HTTP ${response.status}: ${response.statusText}`,
    });
  }

  if (!checkRateLimit(response)) {
    return ok([]);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (e) {
    return err({
      kind: 'parse_error',
      message: `Failed to parse GitHub PRs API response: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  if (!Array.isArray(raw)) {
    return err({
      kind: 'parse_error',
      message: `Expected array from GitHub PRs API, got: ${typeof raw}`,
    });
  }

  const prs: GitHubPR[] = [];
  for (const item of raw) {
    if (isGitHubPRShape(item)) {
      prs.push(item);
    }
  }

  // PRs endpoint has no `since` param -- filter updated_at > since client-side
  const filtered = prs.filter(pr => pr.updated_at > since);

  return ok(applyPRFilters(filtered, source));
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Apply excludeAuthors and notLabels filters to a list of issues.
 * excludeAuthors: exact string match on user.login (case-sensitive).
 * notLabels: drop issues with ANY matching label name.
 */
function applyIssueFilters(issues: GitHubIssue[], source: GitHubPollingSource): GitHubIssue[] {
  return issues.filter(issue => {
    // excludeAuthors filter -- runs BEFORE dispatch (invariant: never dispatch for excluded authors)
    // Fail-safe: if login is absent (deleted/ghost account), treat as excluded -- we cannot
    // verify the author is safe, so the safer behavior is to drop the item.
    if (source.excludeAuthors.length > 0) {
      const login = issue.user?.login;
      if (!login || source.excludeAuthors.includes(login)) return false;
    }
    // notLabels filter
    if (source.notLabels.length > 0 && issue.labels) {
      const labelNames = issue.labels.map(l => l.name);
      if (source.notLabels.some(nl => labelNames.includes(nl))) return false;
    }
    return true;
  });
}

/**
 * Apply excludeAuthors and notLabels filters to a list of PRs.
 * Same semantics as applyIssueFilters.
 */
function applyPRFilters(prs: GitHubPR[], source: GitHubPollingSource): GitHubPR[] {
  return prs.filter(pr => {
    // excludeAuthors filter -- runs BEFORE dispatch
    // Fail-safe: if login is absent (deleted/ghost account), treat as excluded -- we cannot
    // verify the author is safe, so the safer behavior is to drop the item.
    if (source.excludeAuthors.length > 0) {
      const login = pr.user?.login;
      if (!login || source.excludeAuthors.includes(login)) return false;
    }
    // notLabels filter
    if (source.notLabels.length > 0 && pr.labels) {
      const labelNames = pr.labels.map(l => l.name);
      if (source.notLabels.some(nl => labelNames.includes(nl))) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isGitHubIssueShape(item: unknown): item is GitHubIssue {
  if (typeof item !== 'object' || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj['id'] === 'number' &&
    typeof obj['number'] === 'number' &&
    typeof obj['title'] === 'string' &&
    typeof obj['html_url'] === 'string' &&
    typeof obj['updated_at'] === 'string' &&
    typeof obj['state'] === 'string'
  );
}

function isGitHubPRShape(item: unknown): item is GitHubPR {
  if (typeof item !== 'object' || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj['id'] === 'number' &&
    typeof obj['number'] === 'number' &&
    typeof obj['title'] === 'string' &&
    typeof obj['html_url'] === 'string' &&
    typeof obj['updated_at'] === 'string' &&
    typeof obj['state'] === 'string'
  );
}
