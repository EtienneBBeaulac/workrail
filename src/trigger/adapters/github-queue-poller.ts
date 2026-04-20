/**
 * WorkRail Auto: GitHub Queue Issues Adapter
 *
 * Fetches open GitHub issues for the queue poller. Unlike github-poller.ts (which
 * fetches issues updated since a timestamp for deduplication), this adapter fetches
 * ALL open issues matching the queue config filter (e.g. assigned to a user).
 *
 * API used:
 *   GET /repos/:owner/:repo/issues?state=open&assignee=<user>&per_page=100
 *   Header: Authorization: Bearer <token>
 *
 * Design notes:
 * - fetchFn is injectable for testing without real HTTP. Defaults to globalThis.fetch.
 * - Returns Result<GitHubQueueIssue[], GitHubQueuePollError> -- no throws at boundary.
 * - Rate limit: if X-RateLimit-Remaining < 100, returns ok([]) and logs warning.
 * - On any HTTP error (non-2xx), returns err(). Caller skips the cycle.
 * - Pagination: only first page (per_page=100). Per pitch: accepted limitation.
 *
 * Maturity inference (3 deterministic heuristics -- SCOPE LOCK, no LLM):
 * - H1 (ready): body contains upstream_spec: line with http/https URL, OR a http/https
 *   URL in the first paragraph
 * - H2 (specced): body contains `- [ ]` checklist items OR heading matching
 *   /acceptance criteria|test plan|implementation checklist/i OR `### Implementation`
 * - Default: 'idea'
 * Note: H3 (active/skip) is applied in polling-scheduler.ts before calling inferMaturity().
 *
 * Idempotency check:
 * - Scans sessionsDir (default: ~/.workrail/daemon-sessions/) for JSON files
 * - For each file: parse context.taskCandidate.issueNumber
 * - If matching issueNumber found: return 'active'
 * - On ANY error (ENOENT, parse error, missing field): return 'active' (conservative default)
 * - WHY conservative: double-dispatch is worse than missed dispatch
 */

import type { GitHubQueuePollingSource } from '../types.js';
import type { GitHubQueueConfig } from '../github-queue-config.js';
import type { Result } from '../../runtime/result.js';
import { ok, err } from '../../runtime/result.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Label shape from GitHub API */
export interface GitHubQueueLabel {
  readonly name: string;
}

/**
 * A GitHub Issue as returned by the queue issues list API.
 * Contains only the fields needed by the queue poller.
 */
export interface GitHubQueueIssue {
  /** Globally unique issue ID (across all repos). */
  readonly id: number;
  /** Repository-scoped issue number (the #123 number). */
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly labels: readonly GitHubQueueLabel[];
  readonly createdAt: string;
}

export type GitHubQueuePollError =
  | { readonly kind: 'http_error'; readonly status: number; readonly message: string }
  | { readonly kind: 'network_error'; readonly message: string }
  | { readonly kind: 'parse_error'; readonly message: string }
  | { readonly kind: 'not_implemented'; readonly message: string };

/**
 * Injectable fetch function type. Matches the global fetch signature.
 * Default: globalThis.fetch (Node 18+).
 */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Default sessions directory
// ---------------------------------------------------------------------------

export const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.workrail', 'daemon-sessions');

// ---------------------------------------------------------------------------
// Rate limit check (same pattern as github-poller.ts)
// ---------------------------------------------------------------------------

/**
 * Check the GitHub API rate limit headers on a successful response.
 * Returns true if healthy (>= 100 remaining).
 * Returns false and logs a warning if remaining < 100.
 */
function checkRateLimit(response: Response): boolean {
  const remainingHeader = response.headers.get('X-RateLimit-Remaining');
  const resetHeader = response.headers.get('X-RateLimit-Reset');
  if (remainingHeader === null) return true;

  const remaining = parseInt(remainingHeader, 10);
  if (isNaN(remaining) || remaining >= 100) return true;

  const resetTs = parseInt(resetHeader ?? '0', 10);
  const resetAt = resetTs > 0 ? new Date(resetTs * 1000).toISOString() : 'unknown';
  console.warn(
    `[GitHubQueuePoller] Rate limit low: remaining=${remaining}, resets at ${resetAt}. ` +
    `Skipping poll cycle to avoid exhaustion.`,
  );
  return false;
}

// ---------------------------------------------------------------------------
// pollGitHubQueueIssues: fetch open issues matching the queue config filter
// ---------------------------------------------------------------------------

/**
 * Fetch open GitHub issues matching the queue config filter.
 *
 * For type === 'assignee': fetches issues with assignee=<config.user>.
 * For other types: returns err({ kind: 'not_implemented' }) -- caller skips cycle.
 *
 * @param source - Queue polling source configuration (repo, token, pollInterval)
 * @param config - Queue filter configuration loaded from ~/.workrail/config.json
 * @param fetchFn - Optional injectable fetch function (default: globalThis.fetch)
 * @returns Result<GitHubQueueIssue[], GitHubQueuePollError>
 */
export async function pollGitHubQueueIssues(
  source: GitHubQueuePollingSource,
  config: GitHubQueueConfig,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<Result<GitHubQueueIssue[], GitHubQueuePollError>> {
  // Only 'assignee' type is implemented -- other types throw not_implemented at runtime
  if (config.type !== 'assignee') {
    return err({
      kind: 'not_implemented',
      message: `Queue type '${config.type}' is not implemented. Only 'assignee' is supported.`,
    });
  }

  const [owner, repo] = source.repo.split('/');
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('per_page', '100');

  // Apply assignee filter
  if (config.user) {
    url.searchParams.set('assignee', config.user);
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

  const issues: GitHubQueueIssue[] = [];
  for (const item of raw) {
    const shaped = toGitHubQueueIssue(item);
    if (shaped !== null) {
      issues.push(shaped);
    }
  }

  return ok(issues);
}

// ---------------------------------------------------------------------------
// inferMaturity: 3 deterministic heuristics (SCOPE LOCK -- do not add a 4th)
//
// SCOPE LOCK: exactly 3 heuristics. Adding a 4th requires a new pitch.
// ---------------------------------------------------------------------------

/**
 * Infer the maturity of an issue from its body.
 *
 * Heuristics (applied in order, first match wins):
 * H1 (ready): body has upstream_spec: line with http/https URL, OR any http/https URL
 *   in the first paragraph
 * H2 (specced): body has `- [ ]` checklist items, OR heading matching
 *   /acceptance criteria|test plan|implementation checklist/i, OR `### Implementation`
 * Default: 'idea'
 *
 * Note: H3 (active/in-progress exclusion) is NOT a maturity level -- it is applied
 * as an exclusion BEFORE inferMaturity() is called (in polling-scheduler.ts).
 *
 * SCOPE LOCK: exactly 3 heuristics (H1, H2, default). Do not add more without a new pitch.
 */
export function inferMaturity(body: string): 'idea' | 'specced' | 'ready' {
  // H1: ready -- upstream_spec: line with URL, OR http/https URL in first paragraph
  const specLineMatch = /upstream_spec:\s*(https?:\/\/\S+)/i.exec(body);
  if (specLineMatch) return 'ready';

  const firstPara = body.split(/\n\s*\n/)[0] ?? '';
  if (/(https?:\/\/\S+)/.test(firstPara)) return 'ready';

  // H2: specced -- checklist items OR acceptance criteria heading OR ### Implementation
  if (/- \[ \]/.test(body)) return 'specced';
  if (/#{1,6}\s*(acceptance criteria|test plan|implementation checklist|implementation)/i.test(body)) return 'specced';

  // Default: idea
  return 'idea';
}

// ---------------------------------------------------------------------------
// checkIdempotency: per-issue idempotency check via session file scan
//
// Conservative default: any parse error -> 'active' (never dispatch on uncertainty)
// ---------------------------------------------------------------------------

/**
 * Check if an issue already has an active session.
 *
 * Scans all JSON files in sessionsDir. For each file:
 *   - Parse the file as JSON
 *   - Check if context.taskCandidate.issueNumber === issueNumber
 *   - If match: return 'active'
 *   - On ANY error (ENOENT, parse, missing field): return 'active' (conservative)
 *
 * Returns 'clear' only if no session file claims this issue number.
 *
 * INVARIANT: Conservative default -- any error = 'active', not 'clear'.
 * Double-dispatch is worse than missed dispatch.
 *
 * @param issueNumber - The GitHub issue number to check
 * @param sessionsDir - Path to daemon-sessions directory (injectable for testing)
 */
export async function checkIdempotency(
  issueNumber: number,
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): Promise<'clear' | 'active'> {
  let files: string[];
  try {
    files = await fs.readdir(sessionsDir);
  } catch {
    // Sessions dir absent or unreadable -- no active sessions
    return 'clear';
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'));

  for (const filename of jsonFiles) {
    // Outer try/catch: conservative default -- any error for this file = treat as active
    try {
      const content = await fs.readFile(path.join(sessionsDir, filename), 'utf8');
      const parsed: unknown = JSON.parse(content);

      if (typeof parsed !== 'object' || parsed === null) {
        // Malformed session file -- treat as active (conservative)
        return 'active';
      }

      const session = parsed as Record<string, unknown>;
      const context = session['context'];
      if (typeof context !== 'object' || context === null) {
        // No context -- can't determine if this session owns the issue
        // Conservative default: treat as active
        return 'active';
      }

      const ctx = context as Record<string, unknown>;
      const taskCandidate = ctx['taskCandidate'];
      if (typeof taskCandidate !== 'object' || taskCandidate === null) {
        // No taskCandidate in context -- conservative default: treat as active
        return 'active';
      }

      const tc = taskCandidate as Record<string, unknown>;
      if (tc['issueNumber'] === issueNumber) {
        return 'active';
      }
    } catch {
      // Any read/parse error -- conservative default: treat as active
      return 'active';
    }
  }

  return 'clear';
}

// ---------------------------------------------------------------------------
// Type guard / mapper
// ---------------------------------------------------------------------------

/**
 * Map a raw GitHub API issue object to GitHubQueueIssue.
 * Returns null if the item does not have the required shape.
 */
function toGitHubQueueIssue(item: unknown): GitHubQueueIssue | null {
  if (typeof item !== 'object' || item === null) return null;
  const obj = item as Record<string, unknown>;

  if (
    typeof obj['id'] !== 'number' ||
    typeof obj['number'] !== 'number' ||
    typeof obj['title'] !== 'string' ||
    typeof obj['html_url'] !== 'string'
  ) {
    return null;
  }

  // body can be null in GitHub API (no body set)
  const body = typeof obj['body'] === 'string' ? obj['body'] : '';
  const createdAt = typeof obj['created_at'] === 'string' ? obj['created_at'] : '';

  // Labels: array of objects with name field
  const rawLabels = Array.isArray(obj['labels']) ? obj['labels'] : [];
  const labels: GitHubQueueLabel[] = rawLabels
    .filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
    .filter((l) => typeof l['name'] === 'string')
    .map((l) => ({ name: l['name'] as string }));

  return {
    id: obj['id'] as number,
    number: obj['number'] as number,
    title: obj['title'] as string,
    body,
    url: obj['html_url'] as string,
    labels,
    createdAt,
  };
}
