/**
 * ReviewApprovalAdapter: interface and GitHub implementation for creating
 * PENDING draft reviews and polling for submission.
 *
 * Design notes:
 * - All methods return Result<T, ReviewApprovalError> -- never throw.
 * - fetchFn is injectable for testing without real GitHub API calls.
 * - createDraftReview() performs a pre-creation GET check for an existing
 *   PENDING draft by the same login before POSTing (dedup guard).
 * - A per-instance Set (creatingReviewPRs) acts as an in-process mutex
 *   between the GET check and the POST to close the race window when
 *   two sessions finish concurrently for the same PR.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewApprovalErrorKind =
  | 'network_error'
  | 'api_error'
  | 'parse_error'
  | 'already_creating';

export interface ReviewApprovalError {
  readonly kind: ReviewApprovalErrorKind;
  readonly message: string;
  /** HTTP status code (only present for api_error). */
  readonly status?: number;
}

export interface CreateDraftReviewOpts {
  readonly prNumber: number;
  readonly prRepo: string;
  /** Resolved API token for the reviewer's platform account. */
  readonly token: string;
  /** Reviewer login/username on the platform. */
  readonly login: string;
  /** Findings from wr.review_verdict to post as inline-or-body comments. */
  readonly findings: readonly { readonly summary: string; readonly severity: string }[];
  /** PR/MR URL for the review body summary. */
  readonly prUrl: string;
}

export interface DraftReviewCreated {
  readonly reviewId: number;
  /** True when an existing PENDING draft was found and reused (no new POST). */
  readonly reused: boolean;
}

export type CreateDraftReviewResult =
  | { readonly kind: 'ok'; readonly value: DraftReviewCreated }
  | { readonly kind: 'err'; readonly error: ReviewApprovalError };

// ---------------------------------------------------------------------------
// ReviewApprovalAdapter interface
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CheckSubmissionOpts / CheckSubmissionResult
// ---------------------------------------------------------------------------

export interface CheckSubmissionOpts {
  readonly prNumber: number;
  readonly prRepo: string;
  readonly token: string;
  readonly login: string;
  /** The platform-specific review ID returned by createDraftReview. */
  readonly reviewId: number;
}

/**
 * Result of checking whether a pending review has been submitted.
 *
 * WHY discriminated union (not boolean): callers need to distinguish "still
 * pending", "submitted", and "error" without string-parsing or null checks.
 * Each variant carries only the fields relevant to that state.
 */
export type CheckSubmissionResult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'submitted'; readonly submittedAt: string }
  | { readonly kind: 'err'; readonly error: ReviewApprovalError };

// ---------------------------------------------------------------------------
// ReviewApprovalAdapter interface
// ---------------------------------------------------------------------------

/**
 * Platform-agnostic adapter for creating draft reviews and polling for submission.
 *
 * WHY interface (not class): allows injectable fakes in tests and enables
 * platform-specific implementations (GitHub, GitLab, future) without coupling
 * the polling loop to any single platform's API.
 *
 * Implementations:
 * - GitHubReviewApprovalAdapter: uses GitHub REST API (pending draft review)
 * - Future GitLabReviewApprovalAdapter: different creation + polling mechanism
 *
 * The PendingDraftReviewPoller calls checkSubmission() on each tick -- it is
 * entirely platform-agnostic. All platform-specific logic lives in the adapter.
 */
export interface ReviewApprovalAdapter {
  /**
   * Create a platform-appropriate draft/pending review under the operator's identity.
   *
   * The adapter handles the platform-specific creation mechanism:
   * - GitHub: POST /pulls/:number/reviews with no event field (creates PENDING draft)
   * - GitLab (future): create a draft note batch, or commit to a review-staging branch
   *
   * Performs a pre-creation check for an existing pending review by the same login
   * to avoid duplicates when two sessions finish concurrently for the same PR.
   *
   * Returns err on network failure or non-2xx API response.
   */
  createDraftReview(opts: CreateDraftReviewOpts): Promise<CreateDraftReviewResult>;

  /**
   * Check whether the pending review has been submitted (published) by the operator.
   *
   * Called by PendingDraftReviewPoller on each polling tick. Returns:
   * - { kind: 'pending' }: review still exists in draft/pending state
   * - { kind: 'submitted', submittedAt }: operator published it (any non-pending state)
   * - { kind: 'err', error }: network/API failure (poller should log and retry)
   *
   * WHY on the adapter (not the poller): submission detection is platform-specific.
   * GitHub polls GET /reviews and checks state !== 'PENDING'. GitLab will check
   * a different signal (note published, branch merged, etc.). The poller is dumb.
   */
  checkSubmission(opts: CheckSubmissionOpts): Promise<CheckSubmissionResult>;
}

// ---------------------------------------------------------------------------
// FetchFn injectable type (same pattern as github-poller.ts)
// ---------------------------------------------------------------------------

export type ReviewFetchFn = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// ---------------------------------------------------------------------------
// GitHubReviewApprovalAdapter
// ---------------------------------------------------------------------------

/**
 * Production implementation of ReviewApprovalAdapter.
 *
 * Calls the GitHub REST API to create PENDING draft reviews.
 * Uses injectable fetchFn so tests can substitute fakes.
 */
export class GitHubReviewApprovalAdapter implements ReviewApprovalAdapter {
  /**
   * In-process mutex: keys are `${prRepo}#${prNumber}`.
   * Held between GET check and POST to prevent duplicate draft creation
   * when two sessions finish concurrently for the same PR.
   */
  private readonly creatingReviewPRs = new Set<string>();

  constructor(private readonly fetchFn: ReviewFetchFn = defaultFetch) {}

  async createDraftReview(opts: CreateDraftReviewOpts): Promise<CreateDraftReviewResult> {
    const { prNumber, prRepo, token, login, findings, prUrl } = opts;
    const mutexKey = `${prRepo}#${prNumber}`;

    // In-process mutex: prevent concurrent POST for same PR.
    if (this.creatingReviewPRs.has(mutexKey)) {
      return {
        kind: 'err',
        error: { kind: 'already_creating', message: `Already creating a draft review for ${mutexKey}` },
      };
    }
    this.creatingReviewPRs.add(mutexKey);

    try {
      // Step 1: Check for existing PENDING draft by this reviewer.
      const existingResult = await this._findExistingPendingDraft(prRepo, prNumber, token, login);
      if (existingResult.kind === 'err') return existingResult;
      if (existingResult.reviewId !== null) {
        return { kind: 'ok', value: { reviewId: existingResult.reviewId, reused: true } };
      }

      // Step 2: Build review body from findings.
      const body = buildReviewBody(findings, prUrl);

      // Step 3: POST a new PENDING draft review (no inline comments in v1 --
      // filePath/lineNumber not yet in wr.review_verdict schema).
      const apiUrl = `https://api.github.com/repos/${prRepo}/pulls/${prNumber}/reviews`;
      let response: { ok: boolean; status: number; json(): Promise<unknown> };
      try {
        response = await this.fetchFn(apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          },
          // Omitting `event` creates a PENDING (draft) review -- omission is the correct
          // way to create drafts. Passing event:'PENDING' returns a 422 from the GitHub API.
          body: JSON.stringify({ body }),
        });
      } catch (e) {
        return { kind: 'err', error: { kind: 'network_error', message: `POST draft review failed: ${e instanceof Error ? e.message : String(e)}` } };
      }

      if (!response.ok) {
        return { kind: 'err', error: { kind: 'api_error', message: `POST draft review returned HTTP ${response.status}`, status: response.status } };
      }

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        return { kind: 'err', error: { kind: 'parse_error', message: 'Failed to parse POST draft review response body' } };
      }

      const reviewId = (responseBody as Record<string, unknown>)['id'];
      if (typeof reviewId !== 'number') {
        return { kind: 'err', error: { kind: 'parse_error', message: `POST draft review response missing numeric 'id' field` } };
      }

      return { kind: 'ok', value: { reviewId, reused: false } };
    } finally {
      this.creatingReviewPRs.delete(mutexKey);
    }
  }

  private async _findExistingPendingDraft(
    prRepo: string,
    prNumber: number,
    token: string,
    login: string,
  ): Promise<{ kind: 'ok'; reviewId: number | null } | { kind: 'err'; error: ReviewApprovalError }> {
    const apiUrl = `https://api.github.com/repos/${prRepo}/pulls/${prNumber}/reviews`;
    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      response = await this.fetchFn(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (e) {
      return { kind: 'err', error: { kind: 'network_error', message: `GET reviews failed: ${e instanceof Error ? e.message : String(e)}` } };
    }

    if (!response.ok) {
      // 404 = PR not found; treat as no existing draft.
      if (response.status === 404) return { kind: 'ok', reviewId: null };
      return { kind: 'err', error: { kind: 'api_error', message: `GET reviews returned HTTP ${response.status}`, status: response.status } };
    }

    let reviews: unknown;
    try {
      reviews = await response.json();
    } catch {
      return { kind: 'err', error: { kind: 'parse_error', message: 'Failed to parse GET reviews response' } };
    }

    if (!Array.isArray(reviews)) return { kind: 'ok', reviewId: null };

    for (const review of reviews) {
      if (
        typeof review === 'object' && review !== null &&
        (review as Record<string, unknown>)['state'] === 'PENDING' &&
        typeof (review as Record<string, unknown>)['id'] === 'number' &&
        (review as Record<string, unknown>)['user'] !== null &&
        typeof (review as Record<string, unknown>)['user'] === 'object' &&
        ((review as Record<string, unknown>)['user'] as Record<string, unknown>)['login'] === login
      ) {
        return { kind: 'ok', reviewId: (review as Record<string, unknown>)['id'] as number };
      }
    }

    return { kind: 'ok', reviewId: null };
  }

  async checkSubmission(opts: CheckSubmissionOpts): Promise<CheckSubmissionResult> {
    const { prNumber, prRepo, token, reviewId } = opts;
    const apiUrl = `https://api.github.com/repos/${prRepo}/pulls/${prNumber}/reviews/${reviewId}`;
    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      response = await this.fetchFn(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (e) {
      return { kind: 'err', error: { kind: 'network_error', message: `GET review failed: ${e instanceof Error ? e.message : String(e)}` } };
    }

    // 404 means the review was deleted -- treat as submitted/gone.
    if (response.status === 404) {
      return { kind: 'submitted', submittedAt: new Date().toISOString() };
    }
    if (!response.ok) {
      return { kind: 'err', error: { kind: 'api_error', message: `GET review returned HTTP ${response.status}`, status: response.status } };
    }

    let body: unknown;
    try { body = await response.json(); } catch {
      return { kind: 'err', error: { kind: 'parse_error', message: 'Failed to parse GET review response' } };
    }

    const obj = body as Record<string, unknown>;
    const state = obj['state'];
    // Any state other than PENDING means the operator acted on the review.
    if (state !== 'PENDING') {
      const submittedAt = typeof obj['submitted_at'] === 'string'
        ? obj['submitted_at']
        : new Date().toISOString();
      return { kind: 'submitted', submittedAt };
    }
    return { kind: 'pending' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReviewBody(
  findings: readonly { readonly summary: string; readonly severity: string }[],
  prUrl: string,
): string {
  if (findings.length === 0) {
    return `WorkTrain review complete. No findings. PR: ${prUrl}`;
  }
  const lines: string[] = ['**WorkTrain review findings:**', ''];
  for (const f of findings) {
    lines.push(`- **[${f.severity.toUpperCase()}]** ${f.summary}`);
  }
  lines.push('', `PR: ${prUrl}`);
  return lines.join('\n');
}

function defaultFetch(url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  return fetch(url, init as RequestInit) as Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}
