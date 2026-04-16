/**
 * WorkRail Auto: GitHub Issues and PRs Polling Adapter
 *
 * Polls the GitHub API for issues and pull requests updated after a given timestamp.
 * Returns Result<T[], PollError>. Never throws.
 *
 * Design notes:
 * - FetchFn is injected to allow testing without real HTTP calls.
 * - Error kinds: http_error (non-2xx), network_error (fetch threw), parse_error (bad JSON or non-array).
 * - Malformed individual items are skipped (isGitHubIssue / isGitHubPR type guard).
 * - Rate limit guard: if X-RateLimit-Remaining < 100, returns ok([]) and warns.
 * - excludeAuthors: client-side filter, exact login match.
 * - notLabels: client-side filter, excludes items with any matching label name.
 * - labelFilter: server-side for issues (?labels=...), silently ignored for PRs
 *   (the GitHub PRs list endpoint does not support a labels filter parameter).
 * - Issues endpoint: supports `since` (server-side) and `labels` (server-side).
 * - PRs endpoint: does NOT support `since`; updated_at filter is client-side (strictly after).
 */

import type { Result } from '../../runtime/result.js';
import { ok, err } from '../../runtime/result.js';
import type { GitHubPollingSource } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubIssue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly updated_at: string;
  readonly state: string;
  readonly user: { readonly login: string };
  readonly labels: ReadonlyArray<{ readonly name: string }>;
}

export interface GitHubPR {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly updated_at: string;
  readonly state: string;
  readonly user: { readonly login: string };
  readonly draft: boolean;
  readonly labels: ReadonlyArray<{ readonly name: string }>;
}

export type GitHubPollError =
  | { readonly kind: 'http_error'; readonly status: number; readonly statusText: string }
  | { readonly kind: 'network_error'; readonly message: string }
  | { readonly kind: 'parse_error'; readonly message: string };

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function hasUserLogin(item: Record<string, unknown>): boolean {
  const user = item['user'];
  return typeof user === 'object' && user !== null && typeof (user as Record<string, unknown>)['login'] === 'string';
}

function isGitHubIssue(item: unknown): item is GitHubIssue {
  if (typeof item !== 'object' || item === null) return false;
  const m = item as Record<string, unknown>;
  return (
    typeof m['id'] === 'number' &&
    typeof m['number'] === 'number' &&
    typeof m['title'] === 'string' &&
    typeof m['html_url'] === 'string' &&
    typeof m['updated_at'] === 'string' &&
    typeof m['state'] === 'string' &&
    hasUserLogin(m) &&
    Array.isArray(m['labels'])
  );
}

function isGitHubPR(item: unknown): item is GitHubPR {
  if (typeof item !== 'object' || item === null) return false;
  const m = item as Record<string, unknown>;
  return (
    typeof m['id'] === 'number' &&
    typeof m['number'] === 'number' &&
    typeof m['title'] === 'string' &&
    typeof m['html_url'] === 'string' &&
    typeof m['updated_at'] === 'string' &&
    typeof m['state'] === 'string' &&
    hasUserLogin(m) &&
    typeof m['draft'] === 'boolean' &&
    Array.isArray(m['labels'])
  );
}

// ---------------------------------------------------------------------------
// Rate limit guard
// ---------------------------------------------------------------------------

/**
 * Check the X-RateLimit-Remaining header. If below threshold, log a warning
 * and return true (caller should skip results and return ok([])).
 */
function isRateLimited(headers: Pick<Response['headers'], 'get'>): boolean {
  const remaining = headers.get('X-RateLimit-Remaining');
  if (remaining === null) return false;

  const remainingNum = Number(remaining);
  if (remainingNum < 100) {
    const reset = headers.get('X-RateLimit-Reset');
    const resetStr = reset ? new Date(Number(reset) * 1000).toISOString() : 'unknown';
    console.warn(
      `[GitHubPoller] Rate limit low: remaining=${remainingNum}, resets at ${resetStr}. Skipping this poll cycle.`,
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Client-side filters
// ---------------------------------------------------------------------------

function applyExcludeAuthors<T extends { readonly user: { readonly login: string } }>(
  items: T[],
  excludeAuthors: readonly string[],
): T[] {
  if (excludeAuthors.length === 0) return items;
  return items.filter((item) => !excludeAuthors.includes(item.user.login));
}

function applyNotLabels<T extends { readonly labels: ReadonlyArray<{ readonly name: string }> }>(
  items: T[],
  notLabels: readonly string[],
): T[] {
  if (notLabels.length === 0) return items;
  const notSet = new Set(notLabels);
  return items.filter((item) => !item.labels.some((label) => notSet.has(label.name)));
}

// ---------------------------------------------------------------------------
// Issues poller
// ---------------------------------------------------------------------------

/**
 * Poll GitHub Issues API for open issues updated after `since`.
 *
 * @param source - GitHub polling source configuration.
 * @param since - ISO 8601 timestamp; used as the `since` query param (server-side filter).
 * @param fetchFn - Injectable fetch implementation (default: global fetch).
 * @returns Result<GitHubIssue[], GitHubPollError>. Never throws.
 */
export async function pollGitHubIssues(
  source: GitHubPollingSource,
  since: string,
  fetchFn: FetchFn = fetch as FetchFn,
): Promise<Result<GitHubIssue[], GitHubPollError>> {
  const params = new URLSearchParams({
    state: 'open',
    since: since,
    sort: 'updated',
    direction: 'desc',
    per_page: '100',
  });

  // labelFilter is applied server-side for issues
  if (source.labelFilter.length > 0) {
    params.set('labels', source.labelFilter.join(','));
  }

  const url = `https://api.github.com/repos/${source.repo}/issues?${params.toString()}`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        'Authorization': `Bearer ${source.token}`,
        'Accept': 'application/vnd.github+json',
      },
    });
  } catch (e: unknown) {
    return err({
      kind: 'network_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (!response.ok) {
    return err({
      kind: 'http_error',
      status: response.status,
      statusText: response.statusText,
    });
  }

  // Rate limit guard: check AFTER confirming ok response
  if (isRateLimited(response.headers)) {
    return ok([]);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (e: unknown) {
    return err({
      kind: 'parse_error',
      message: e instanceof Error ? e.message : 'Failed to parse JSON response',
    });
  }

  if (!Array.isArray(raw)) {
    return err({
      kind: 'parse_error',
      message: `Expected array response, got ${typeof raw}`,
    });
  }

  // Filter out malformed items
  let issues: GitHubIssue[] = [];
  for (const item of raw) {
    if (isGitHubIssue(item)) {
      issues.push(item);
    }
  }

  // Client-side filters
  issues = applyExcludeAuthors(issues, source.excludeAuthors);
  issues = applyNotLabels(issues, source.notLabels);

  return ok(issues);
}

// ---------------------------------------------------------------------------
// PRs poller
// ---------------------------------------------------------------------------

/**
 * Poll GitHub Pull Requests API for open PRs updated after `since`.
 *
 * Note: the GitHub PRs list endpoint does NOT support a `since` parameter.
 * The `since` filter is applied client-side (updated_at > since, strictly).
 * labelFilter is also silently ignored for PRs (endpoint does not support it).
 *
 * @param source - GitHub polling source configuration.
 * @param since - ISO 8601 timestamp; used as a client-side filter.
 * @param fetchFn - Injectable fetch implementation (default: global fetch).
 * @returns Result<GitHubPR[], GitHubPollError>. Never throws.
 */
export async function pollGitHubPRs(
  source: GitHubPollingSource,
  since: string,
  fetchFn: FetchFn = fetch as FetchFn,
): Promise<Result<GitHubPR[], GitHubPollError>> {
  // PRs endpoint: no `since` param, no `labels` param
  const params = new URLSearchParams({
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: '100',
  });

  const url = `https://api.github.com/repos/${source.repo}/pulls?${params.toString()}`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        'Authorization': `Bearer ${source.token}`,
        'Accept': 'application/vnd.github+json',
      },
    });
  } catch (e: unknown) {
    return err({
      kind: 'network_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (!response.ok) {
    return err({
      kind: 'http_error',
      status: response.status,
      statusText: response.statusText,
    });
  }

  // Rate limit guard: check AFTER confirming ok response
  if (isRateLimited(response.headers)) {
    return ok([]);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (e: unknown) {
    return err({
      kind: 'parse_error',
      message: e instanceof Error ? e.message : 'Failed to parse JSON response',
    });
  }

  if (!Array.isArray(raw)) {
    return err({
      kind: 'parse_error',
      message: `Expected array response, got ${typeof raw}`,
    });
  }

  // Filter out malformed items
  let prs: GitHubPR[] = [];
  for (const item of raw) {
    if (isGitHubPR(item)) {
      prs.push(item);
    }
  }

  // Client-side updated_at filter: strictly after since (ISO string comparison is valid for ISO 8601)
  prs = prs.filter((pr) => pr.updated_at > since);

  // Client-side filters
  prs = applyExcludeAuthors(prs, source.excludeAuthors);
  prs = applyNotLabels(prs, source.notLabels);

  return ok(prs);
}
