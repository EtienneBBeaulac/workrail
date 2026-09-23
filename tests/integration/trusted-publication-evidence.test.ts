/**
 * Real adapter, fake HTTP. Intended behavior: baseline failures remain unmet acceptance obligations.
 * This suite neither contacts GitHub nor proves end-to-end gate authorization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubReviewApprovalAdapter,
  type ReviewFetchFn,
  type CheckSubmissionOpts,
} from '../../src/trigger/review-approval-adapter.js';

const now = '2026-09-21T14:00:00.000Z';
const publishedAt = '2026-09-21T10:15:30.000Z';
const opts: CheckSubmissionOpts = {
  prRepo: 'owner/repo', prNumber: 42, reviewId: 12345,
  token: 'fixture-token', login: 'reviewer-alice',
};
const validReview = {
  id: opts.reviewId, state: 'APPROVED', submitted_at: publishedAt,
  user: { login: opts.login },
};
const { submitted_at: _timestamp, ...withoutTimestamp } = validReview;

async function check(response: Awaited<ReturnType<ReviewFetchFn>>) {
  const urls: string[] = [];
  const fetch: ReviewFetchFn = async (url) => { urls.push(url); return response; };
  const result = await new GitHubReviewApprovalAdapter(fetch).checkSubmission(opts);
  expect(urls).toEqual(['https://api.github.com/repos/owner/repo/pulls/42/reviews/12345']);
  return result;
}
function http(body: unknown, status = 200): Awaited<ReturnType<ReviewFetchFn>> {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('positive publication evidence', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(now)); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED'])(
    'recognizes publication in %s state with the reported timestamp', async (state) => {
      expect(await check(http({ ...validReview, state }))).toEqual({
        kind: 'submitted', submittedAt: publishedAt,
      });
    },
  );
  it('keeps a pending review pending', async () => {
    expect(await check(http({ ...validReview, state: 'PENDING', submitted_at: null })))
      .toEqual({ kind: 'pending' });
  });
  it('reports HTTP failure rather than publication', async () => {
    expect(await check(http({}, 503))).toMatchObject({ kind: 'err', error: { kind: 'api_error', status: 503 } });
  });
  it('reports malformed JSON rather than publication', async () => {
    const response = http({});
    expect(await check({ ...response, json: async () => JSON.parse('not-json') }))
      .toMatchObject({ kind: 'err', error: { kind: 'parse_error' } });
  });

  // Each valid-shaped payload changes one dimension; {} is a separate boundary case.
  it.each([
    { name: 'HTTP 404', response: http({ message: 'Not Found' }, 404) },
    { name: 'empty object', response: http({}) },
    { name: 'null body', response: http(null) },
    { name: 'array body', response: http([]) },
    { name: 'invalid timestamp', response: http({ ...validReview, submitted_at: 'yesterday' }) },
    { name: 'invalid calendar date', response: http({ ...validReview, submitted_at: '2026-02-31T00:00:00Z' }) },
    { name: 'unknown state', response: http({ ...validReview, state: 'UNRECOGNIZED_STATE' }) },
    { name: 'missing publication time', response: http(withoutTimestamp) },
    { name: 'wrong review ID', response: http({ ...validReview, id: opts.reviewId + 1 }) },
    { name: 'wrong reviewer', response: http({ ...validReview, user: { login: 'another-reviewer' } }) },
  ])('does not infer publication from $name', async ({ response }) => {
    expect((await check(response)).kind).not.toBe('submitted');
  });
});
