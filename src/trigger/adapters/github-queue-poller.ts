/**
 * WorkRail Auto: GitHub Queue Issues Adapter
 *
 * Fetches open GitHub issues for the queue poller. Unlike github-poller.ts (which
 * fetches issues updated since a timestamp for deduplication), this adapter fetches
 * ALL open issues matching the queue config filter (e.g. assigned to a user).
 *
 * API used:
 *   Assignee filter: GET /repos/:owner/:repo/issues?state=open&assignee=<user>&per_page=100
 *   Label filter:    GET /repos/:owner/:repo/issues?state=open&labels=<label>&per_page=100
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
 *   URL with a spec-implying path segment (/pitch|prd|spec|brd|rfc|design/) in the first
 *   paragraph (plain issue/PR URLs do NOT trigger ready)
 * - H2 (specced): body contains `- [ ]` checklist items OR an exact heading line of
 *   `## Acceptance Criteria` or `## Implementation Plan` (case-insensitive)
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
// QueueIssueSidecar: the shape of queue-issue-<N>.json files
// ---------------------------------------------------------------------------

/**
 * Shape of the sidecar file written before each dispatch of a queue issue.
 *
 * WHY dual-purpose design:
 * The sidecar serves two separate concerns:
 *   1. Active-dispatch lock (TTL-based): `dispatchedAt + ttlMs > Date.now()` indicates
 *      a session is currently in flight. Used by checkIdempotency().
 *   2. Failure counter (persistent): `attemptCount` increments on each failed dispatch.
 *      Survives TTL expiry. Only reset by daemon restart (clearQueueIssueSidecars()) or
 *      manual sidecar deletion.
 *
 * These two fields have intentionally different lifecycles -- the lock expires,
 * the counter persists. This is documented here to prevent future confusion.
 */
export interface QueueIssueSidecar {
  readonly issueNumber: number;
  readonly triggerId: string;
  readonly dispatchedAt: number;
  readonly ttlMs: number;
  /**
   * Number of times this issue has been dispatched (including the current dispatch).
   * Value is 1 on the first dispatch, incremented on each failure.
   * On success: sidecar is deleted (not incremented).
   * On daemon restart: sidecar is deleted unconditionally by clearQueueIssueSidecars().
   */
  readonly attemptCount: number;
}

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
 * For type === 'label': fetches issues with labels=<config.queueLabel>.
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
  const [owner, repo] = source.repo.split('/');
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('per_page', '100');

  // Apply queue filter based on config type.
  // WHY: only assignee and label are implemented; other types return not_implemented
  // so the caller (polling-scheduler) can skip the cycle cleanly.
  if (config.type === 'assignee' && config.user) {
    url.searchParams.set('assignee', config.user);
  } else if (config.type === 'label' && config.queueLabel) {
    url.searchParams.set('labels', config.queueLabel);
  } else {
    return err({
      kind: 'not_implemented',
      message: `Queue type "${config.type}" is not yet implemented`,
    });
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
    // Assignee pre-filter (type: assignee only): defensive client-side check to confirm the
    // item is actually assigned to the configured user. Config is not available inside
    // toGitHubQueueIssue(), so this check lives here.
    // WHY: API assignee filter is correct, but caching or API bugs could return unassigned items.
    // See toGitHubQueueIssue() for the state and pull_request guards.
    if (config.type === 'assignee' && config.user) {
      const rawItem = item as Record<string, unknown>;
      const assignees = rawItem['assignees'];
      if (
        !Array.isArray(assignees) ||
        !assignees.some(
          (a): a is Record<string, unknown> =>
            typeof a === 'object' &&
            a !== null &&
            (a as Record<string, unknown>)['login'] === config.user,
        )
      ) {
        continue;
      }
    }

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
 * H1 (ready): body has upstream_spec: line with http/https URL, OR a http/https URL
 *   containing a spec-implying path segment (/pitch|prd|spec|brd|rfc|design/) in the
 *   first paragraph. WHY path segment: avoids plain issue/PR URLs triggering 'ready'.
 * H2 (specced): body has `- [ ]` checklist items, OR an exact heading line matching
 *   `## Acceptance Criteria` or `## Implementation Plan` (any level, case-insensitive).
 *   WHY exact: loose match on 'implementation' catches non-spec sentences.
 * Default: 'idea'
 *
 * Note: H3 (active/in-progress exclusion) is NOT a maturity level -- it is applied
 * as an exclusion BEFORE inferMaturity() is called (in polling-scheduler.ts).
 *
 * SCOPE LOCK: exactly 3 heuristics (H1, H2, default). Do not add more without a new pitch.
 */
export function inferMaturity(body: string): 'idea' | 'specced' | 'ready' {
  // H1: ready -- upstream_spec: line with http/https URL (any URL), OR http/https URL
  // with a spec-implying path segment in the first paragraph.
  // WHY path segment requirement on first-para: prevents plain GitHub issue links,
  // PR links, and other non-spec URLs from falsely triggering 'ready'.
  const specLineMatch = /upstream_spec:\s*(https?:\/\/\S+)/i.exec(body);
  if (specLineMatch) return 'ready';

  const firstPara = body.split(/\n\s*\n/)[0] ?? '';
  if (/https?:\/\/\S*\/(?:pitch|prd|spec|brd|rfc|design)\b/i.test(firstPara)) return 'ready';

  // H2: specced -- checklist items OR exact headings (Acceptance Criteria / Implementation Plan)
  // WHY exact headings: loose matching on 'implementation' would catch sentences like
  // "implementation details are TBD" and falsely elevate issues to 'specced'.
  if (/- \[ \]/.test(body)) return 'specced';
  if (/^#{1,6}\s*(Acceptance Criteria|Implementation Plan)\s*$/im.test(body)) return 'specced';

  // Default: idea
  return 'idea';
}

// ---------------------------------------------------------------------------
// checkIdempotency: per-issue idempotency check via session file scan
//
// Conservative default: any parse error -> 'active' (never dispatch on uncertainty)
//
// NOTE on asymmetric conservative defaults (checkIdempotency vs readSidecarAttemptCount):
// - checkIdempotency returns 'active' on error: conservative to prevent double-dispatch
// - readSidecarAttemptCount returns 0 on error: non-blocking because a read error means
//   we cannot confirm the issue is over-limit; one extra dispatch is preferable to
//   permanently suppressing a valid issue due to a disk read error.
// Both defaults are intentional and correct for their respective purposes.
// ---------------------------------------------------------------------------

/**
 * Check if an issue already has an active session.
 *
 * Checks two sources:
 *
 * 1. Queue-issue sidecar file (`queue-issue-<issueNumber>.json`):
 *    Written by polling-scheduler.ts before dispatch; deleted on pipeline completion.
 *    Provides cross-restart idempotency for the dispatch window (RC3 fix).
 *    Sidecar format: see QueueIssueSidecar interface.
 *    If found and `dispatchedAt + ttlMs > Date.now()`: return 'active' (not expired).
 *    If found and expired: return 'clear' (pipeline window elapsed; eligible for re-dispatch).
 *    On any read/parse error for the sidecar: return 'active' (conservative).
 *
 *    NOTE: after this function returns 'clear', doPollGitHubQueue() calls
 *    readSidecarAttemptCount() separately to check if the attempt cap has been reached.
 *    These are two distinct checks with intentionally asymmetric conservative defaults.
 *
 * 2. Regular session files (all other `*.json` files):
 *    Written by persistTokens() -- contain `{ continueToken, checkpointToken, ts }`.
 *    Checks `context.taskCandidate.issueNumber === issueNumber`.
 *    Note: persistTokens() does not write the `context` field, so these files always
 *    return 'clear' for the session scan. This path is kept for forward-compat in case
 *    a future persistTokens() change adds `context`.
 *    - If file has no context or no taskCandidate: 'clear' for this file.
 *    - On any read/parse error: 'active' (conservative).
 *
 * Returns 'clear' if no source claims this issue number as active.
 *
 * INVARIANT: 'active' ONLY when (a) a file is unreadable/unparseable, OR
 * (b) sidecar exists and is not expired, OR
 * (c) context.taskCandidate.issueNumber === issueNumber.
 *
 * @param issueNumber - The GitHub issue number to check
 * @param sessionsDir - Path to daemon-sessions directory (injectable for testing)
 */
export async function checkIdempotency(
  issueNumber: number,
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): Promise<'clear' | 'active'> {
  // Step 1: Check for queue-issue sidecar file (cross-restart idempotency, RC3 fix).
  // The sidecar filename is deterministic, so we check it directly rather than scanning all files.
  const sidecarFilename = `queue-issue-${issueNumber}.json`;
  const sidecarFilePath = path.join(sessionsDir, sidecarFilename);
  try {
    const sidecarContent = await fs.readFile(sidecarFilePath, 'utf8');
    const sidecarParsed: unknown = JSON.parse(sidecarContent);
    if (typeof sidecarParsed !== 'object' || sidecarParsed === null) {
      // Malformed sidecar -- conservative: treat as active
      return 'active';
    }
    const sidecar = sidecarParsed as Record<string, unknown>;
    const dispatchedAt = sidecar['dispatchedAt'];
    const ttlMs = sidecar['ttlMs'];
    if (typeof dispatchedAt === 'number' && typeof ttlMs === 'number') {
      // Check TTL: if not expired, issue is actively being dispatched
      if (dispatchedAt + ttlMs > Date.now()) {
        return 'active';
      }
      // Expired sidecar -- pipeline window elapsed; treat as clear
      return 'clear';
    }
    // Sidecar exists but missing required fields -- conservative: treat as active
    return 'active';
  } catch (e: unknown) {
    // ENOENT: sidecar does not exist -- continue to session file scan
    // Other errors (permissions, etc.) -- conservative: treat as active
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return 'active';
    }
  }

  // Step 2: Scan regular session files for context.taskCandidate.issueNumber match.
  let files: string[];
  try {
    files = await fs.readdir(sessionsDir);
  } catch {
    // Sessions dir absent or unreadable -- no active sessions
    return 'clear';
  }

  // Skip the sidecar file itself in the regular scan (already handled above)
  const jsonFiles = files.filter(f => f.endsWith('.json') && f !== sidecarFilename);

  for (const filename of jsonFiles) {
    try {
      const content = await fs.readFile(path.join(sessionsDir, filename), 'utf8');
      const parsed: unknown = JSON.parse(content);

      if (typeof parsed !== 'object' || parsed === null) {
        // Malformed session file -- cannot trust it, conservative default: treat as active
        return 'active';
      }

      const session = parsed as Record<string, unknown>;
      const context = session['context'];
      if (typeof context !== 'object' || context === null) {
        // No context field -- this is a normal persistTokens() session file that does not
        // own any issue. Cannot block dispatch. Return 'clear' for this file.
        continue;
      }

      const ctx = context as Record<string, unknown>;
      const taskCandidate = ctx['taskCandidate'];
      if (typeof taskCandidate !== 'object' || taskCandidate === null) {
        // Context exists but no taskCandidate -- not a queue-originated session.
        // Cannot claim issue ownership. Return 'clear' for this file.
        continue;
      }

      const tc = taskCandidate as Record<string, unknown>;
      if (tc['issueNumber'] === issueNumber) {
        return 'active';
      }
    } catch {
      // Any read/parse error -- conservative default: treat as active
      // WHY: we cannot determine whether this file owns the issue.
      return 'active';
    }
  }

  return 'clear';
}

// ---------------------------------------------------------------------------
// readSidecarAttemptCount: read previous attempt count from an expired sidecar
// ---------------------------------------------------------------------------

/**
 * Read the previous attempt count from a queue-issue sidecar file.
 *
 * Called AFTER `checkIdempotency()` returns 'clear' (i.e. the sidecar TTL has expired
 * or the sidecar doesn't exist) to determine if this issue has been attempted too many
 * times already.
 *
 * Conservative default: 0 (not active).
 * WHY 0 on error (asymmetric from checkIdempotency):
 *   - checkIdempotency() returns 'active' on error -- conservative to prevent double-dispatch
 *   - readSidecarAttemptCount() returns 0 on error -- non-blocking because a failed read
 *     means we cannot confirm the issue is over-limit; one extra dispatch is preferable
 *     to permanently suppressing a valid issue due to a disk read error.
 *
 * @param issueNumber - The GitHub issue number to check
 * @param sessionsDir - Path to daemon-sessions directory (injectable for testing)
 */
export async function readSidecarAttemptCount(
  issueNumber: number,
  sessionsDir: string = DEFAULT_SESSIONS_DIR,
): Promise<number> {
  const sidecarFilePath = path.join(sessionsDir, `queue-issue-${issueNumber}.json`);
  try {
    const content = await fs.readFile(sidecarFilePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn(`[QueuePoller] Malformed sidecar for issue #${issueNumber}: expected object`);
      return 0;
    }
    const sidecar = parsed as Record<string, unknown>;
    const attemptCount = sidecar['attemptCount'];
    if (typeof attemptCount === 'number' && Number.isInteger(attemptCount) && attemptCount >= 0) {
      return attemptCount;
    }
    // Sidecar exists but missing or invalid attemptCount field -- treat as 0
    // (could be a legacy sidecar written before this field was added)
    return 0;
  } catch (e: unknown) {
    const nodeErr = e as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      // No sidecar -- first time we've seen this issue
      return 0;
    }
    // Unexpected read error -- log and default to 0 (non-blocking)
    console.warn(
      `[QueuePoller] Could not read sidecar attempt count for issue #${issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Type guard / mapper
// ---------------------------------------------------------------------------

/**
 * Map a raw GitHub API issue object to GitHubQueueIssue.
 * Returns null if the item does not have the required shape, is not open, or is a PR.
 *
 * NOTE: assignee pre-filter for type: assignee configs runs in pollGitHubQueueIssues()
 * before this function is called (config is not available here).
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

  // Defensive state guard: API sends state=open but caching or API quirks can return closed items.
  // WHY: a closed issue should never enter the queue regardless of how it arrived.
  if (obj['state'] !== 'open') return null;

  // PR filter: GitHub Issues API returns PRs alongside issues. PRs have a pull_request field.
  // WHY: queue poll should only dispatch coding tasks from issues, not from PRs.
  if ('pull_request' in obj) return null;

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
