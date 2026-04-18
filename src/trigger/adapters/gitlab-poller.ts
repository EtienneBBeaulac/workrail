/**
 * WorkRail Auto: GitLab MR Polling Adapter
 *
 * Fetches new or updated merge requests from the GitLab Projects API.
 *
 * API used:
 *   GET /api/v4/projects/:id/merge_requests
 *     ?state=opened
 *     &updated_after=<ISO 8601>
 *     &per_page=100
 *   Header: PRIVATE-TOKEN: <token>
 *
 * Design notes:
 * - fetchFn is injectable for testing without real HTTP. Defaults to globalThis.fetch.
 * - Returns Result<GitLabMR[], GitLabPollError> -- no throws at the boundary.
 * - Pagination: only the first page (100 MRs) is fetched. If more than 100 MRs
 *   were updated in one poll interval, some will be deferred to the next cycle.
 *   This is an accepted limitation documented in the implementation plan.
 * - The `events` filter in GitLabPollingSource is applied client-side here.
 *   The GitLab API does not filter MRs by event type in the list endpoint.
 *
 * At-least-once delivery: this function only fetches data. The caller
 * (PollingScheduler) is responsible for dispatch ordering and recording.
 */

import type { GitLabPollingSource } from '../types.js';
import type { Result } from '../../runtime/result.js';
import { ok, err } from '../../runtime/result.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A GitLab merge request as returned by the MR list API.
 * Contains only the fields needed by the polling scheduler.
 */
export interface GitLabMR {
  /** Globally unique MR ID (across all projects). Used as the deduplication key. */
  readonly id: number;
  /** Project-scoped MR number (the !123 number). Used in goalTemplate interpolation. */
  readonly iid: number;
  readonly title: string;
  readonly web_url: string;
  readonly updated_at: string;
  readonly state: string;
  /** Author login name. Used for goalTemplate interpolation. */
  readonly author?: { readonly username?: string; readonly name?: string };
}

export type GitLabPollError =
  | { readonly kind: 'http_error'; readonly status: number; readonly message: string }
  | { readonly kind: 'network_error'; readonly message: string }
  | { readonly kind: 'parse_error'; readonly message: string };

/**
 * Injectable fetch function type. Matches the global fetch signature.
 * Default: globalThis.fetch (Node 18+).
 */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// pollGitLabMRs: main poll function
// ---------------------------------------------------------------------------

/**
 * Fetch GitLab merge requests updated after the given timestamp.
 *
 * @param source - GitLab polling source configuration
 * @param updatedAfter - ISO 8601 timestamp; only MRs updated after this are returned
 * @param fetchFn - Optional injectable fetch function (default: globalThis.fetch)
 * @returns Result<GitLabMR[], GitLabPollError>
 *
 * Notes:
 * - Only fetches the first page (per_page=100). Pagination is not implemented.
 * - Applies the `source.events` filter client-side: only MRs whose state
 *   matches an event in `source.events` are returned.
 *   "merge_request.opened" -> state === 'opened'
 *   "merge_request.updated" -> any state (all MRs are returned for this event)
 * - Uses the MR's global `id` (not `iid`) as the deduplication key.
 */
export async function pollGitLabMRs(
  source: GitLabPollingSource,
  updatedAfter: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<Result<GitLabMR[], GitLabPollError>> {
  // Build the API URL
  // projectId may be a numeric string ("12345") or a URL-encoded path ("namespace%2Fproject")
  const encodedProjectId = encodeURIComponent(source.projectId);
  const baseUrl = source.baseUrl.replace(/\/$/, ''); // strip trailing slash

  const url = new URL(
    `${baseUrl}/api/v4/projects/${encodedProjectId}/merge_requests`,
  );
  url.searchParams.set('state', 'opened');
  url.searchParams.set('updated_after', updatedAfter);
  url.searchParams.set('per_page', '100');

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      headers: {
        'PRIVATE-TOKEN': source.token,
        'Content-Type': 'application/json',
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
      message: `GitLab API returned HTTP ${response.status}: ${response.statusText}`,
    });
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (e) {
    return err({
      kind: 'parse_error',
      message: `Failed to parse GitLab API response: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  if (!Array.isArray(raw)) {
    return err({
      kind: 'parse_error',
      message: `Expected array from GitLab MR API, got: ${typeof raw}`,
    });
  }

  // Map to our GitLabMR type, filtering out malformed entries
  const mrs: GitLabMR[] = [];
  for (const item of raw) {
    if (isGitLabMRShape(item)) {
      mrs.push(item);
    }
  }

  // Apply client-side event filter
  // "merge_request.opened" -> only state === 'opened'
  // "merge_request.updated" -> all states (any MR that was updated)
  const filtered = applyEventFilter(mrs, source.events);

  return ok(filtered);
}

// ---------------------------------------------------------------------------
// Event filter
// ---------------------------------------------------------------------------

/**
 * Apply the `events` filter from GitLabPollingSource to the MR list.
 *
 * The GitLab MR list endpoint already returns only open MRs (state=opened).
 * The events filter is a semantic layer on top:
 * - "merge_request.opened": include MRs in 'opened' state (default, all returned)
 * - "merge_request.updated": include all returned MRs (any update counts)
 *
 * If the events list is empty or contains an unrecognized event, all MRs are included.
 * This is a permissive default -- better to over-fire than silently miss events.
 */
function applyEventFilter(mrs: GitLabMR[], events: readonly string[]): GitLabMR[] {
  if (events.length === 0) return mrs;

  const includeOpened = events.includes('merge_request.opened');
  const includeUpdated = events.includes('merge_request.updated');

  // If only "opened" events: filter to state === 'opened' (which is already the case
  // since we queried with state=opened, so all MRs qualify)
  // If "updated" is included: all MRs qualify (an update to an open MR is always interesting)
  // If neither: all MRs are included (permissive default)
  if (!includeOpened && !includeUpdated) {
    // Unknown event types: permissive -- include all
    return mrs;
  }

  // Both opened and updated: include everything
  if (includeUpdated) return mrs;

  // Only "opened": include state === 'opened' (already filtered by API, but be explicit)
  return mrs.filter(mr => mr.state === 'opened');
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isGitLabMRShape(item: unknown): item is GitLabMR {
  if (typeof item !== 'object' || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj['id'] === 'number' &&
    typeof obj['iid'] === 'number' &&
    typeof obj['title'] === 'string' &&
    typeof obj['web_url'] === 'string' &&
    typeof obj['updated_at'] === 'string' &&
    typeof obj['state'] === 'string'
  );
}
