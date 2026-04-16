/**
 * WorkRail Auto: GitLab MR Polling Adapter
 *
 * Fetches open merge requests from the GitLab API that were updated after a
 * given ISO 8601 timestamp. Returns a Result<GitLabMR[], PollError>.
 *
 * Design notes:
 * - FetchFn is injected to allow testing without real HTTP calls.
 * - Errors are data: Result<T,E> from runtime/result.ts -- never throws.
 * - Error kinds: http_error (non-2xx), network_error (fetch threw), parse_error (bad JSON or non-array).
 * - Malformed individual items are silently skipped (logged); valid items are returned.
 * - GitLab API endpoint: GET /api/v4/projects/:projectId/merge_requests
 *   params: state=opened, updated_after=<since>, per_page=100, order_by=updated_at
 * - projectId with slashes (e.g. "my-group/my-project") is URL-encoded.
 * - Event filtering (opened vs. updated) is done client-side because the GitLab
 *   MR list API does not filter by event type.
 */

import type { Result } from '../../runtime/result.js';
import { ok, err } from '../../runtime/result.js';
import type { GitLabPollingSource } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface GitLabMR {
  readonly id: number;
  readonly iid: number;
  readonly title: string;
  readonly web_url: string;
  readonly updated_at: string;
  readonly state: string;
}

export type GitLabPollError =
  | { readonly kind: 'http_error'; readonly status: number; readonly statusText: string }
  | { readonly kind: 'network_error'; readonly message: string }
  | { readonly kind: 'parse_error'; readonly message: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isGitLabMR(item: unknown): item is GitLabMR {
  if (typeof item !== 'object' || item === null) return false;
  const m = item as Record<string, unknown>;
  return (
    typeof m['id'] === 'number' &&
    typeof m['iid'] === 'number' &&
    typeof m['title'] === 'string' &&
    typeof m['web_url'] === 'string' &&
    typeof m['updated_at'] === 'string' &&
    typeof m['state'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Event filter
// ---------------------------------------------------------------------------

/**
 * Filter MRs by event type.
 *
 * - Empty events or containing 'merge_request.updated': include all states.
 * - Only 'merge_request.opened': include only MRs with state === 'opened'.
 */
function applyEventFilter(mrs: GitLabMR[], events: readonly string[]): GitLabMR[] {
  if (events.length === 0) return mrs;
  if (events.includes('merge_request.updated')) return mrs;
  if (events.includes('merge_request.opened')) {
    return mrs.filter((mr) => mr.state === 'opened');
  }
  return mrs;
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

/**
 * Poll the GitLab MR list API for merge requests updated after `since`.
 *
 * @param source - GitLab polling source configuration.
 * @param since - ISO 8601 timestamp; only MRs updated after this are returned.
 * @param fetchFn - Injectable fetch implementation (default: global fetch).
 * @returns Result<GitLabMR[], GitLabPollError>. Never throws.
 */
export async function pollGitLabMRs(
  source: GitLabPollingSource,
  since: string,
  fetchFn: FetchFn = fetch as FetchFn,
): Promise<Result<GitLabMR[], GitLabPollError>> {
  // URL-encode projectId: "my-group/my-project" -> "my-group%2Fmy-project"
  const encodedProjectId = encodeURIComponent(source.projectId);

  const params = new URLSearchParams({
    state: 'opened',
    updated_after: since,
    per_page: '100',
    order_by: 'updated_at',
    sort: 'desc',
  });

  const url = `${source.baseUrl}/api/v4/projects/${encodedProjectId}/merge_requests?${params.toString()}`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        'PRIVATE-TOKEN': source.token,
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

  // Filter out malformed items; keep valid ones.
  const mrs: GitLabMR[] = [];
  for (const item of raw) {
    if (isGitLabMR(item)) {
      mrs.push(item);
    }
    // Silently skip malformed items (type-guard failure is not logged to avoid noise)
  }

  // Apply event-type client-side filter
  const filtered = applyEventFilter(mrs, source.events);

  return ok(filtered);
}
