/**
 * Tests for src/trigger/adapters/github-queue-poller.ts
 *
 * Covers:
 * - Fetches issues matching assignee filter (assignee query param set)
 * - type: label with queueLabel fetches with labels= query param
 * - type: label without queueLabel returns not_implemented
 * - type: assignee regression (still works after label support added)
 * - Skips cycle on GitHub API error (network error, HTTP error)
 * - Idempotency: skips issue with matching active session file
 * - Idempotency: returns 'clear' when no matching session
 * - Idempotency: returns 'active' on any parse error (conservative default)
 * - Maturity H1: spec URL in upstream_spec line -> 'ready'
 * - Maturity H1: http URL in first paragraph -> 'ready'
 * - Maturity H2: checklist items -> 'specced'
 * - Maturity H2: acceptance criteria heading -> 'specced'
 * - Maturity default: plain body -> 'idea'
 * - H3 exclusion: worktrain:in-progress label (in scheduler, not inferMaturity)
 * - Rate limit skip: X-RateLimit-Remaining < 100 -> ok([])
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  pollGitHubQueueIssues,
  inferMaturity,
  checkIdempotency,
  type FetchFn,
  type GitHubQueueIssue,
} from '../../src/trigger/adapters/github-queue-poller.js';
import type { GitHubQueuePollingSource } from '../../src/trigger/types.js';
import type { GitHubQueueConfig } from '../../src/trigger/github-queue-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(overrides: Partial<GitHubQueuePollingSource> = {}): GitHubQueuePollingSource {
  return {
    repo: 'acme/my-project',
    token: 'test-token',
    pollIntervalSeconds: 300,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GitHubQueueConfig> = {}): GitHubQueueConfig {
  return {
    type: 'assignee',
    user: 'worktrain-etienneb',
    repo: 'acme/my-project',
    token: 'test-token',
    pollIntervalSeconds: 300,
    maxTotalConcurrentSessions: 1,
    excludeLabels: [],
    ...overrides,
  };
}

function makeIssue(overrides: Partial<{
  id: number;
  number: number;
  title: string;
  body: string;
  html_url: string;
  labels: Array<{ name: string }>;
  created_at: string;
  state: string;
  assignees: Array<{ login: string }>;
}> = {}): object {
  return {
    id: 1001,
    number: 42,
    title: 'Test issue',
    body: 'A plain issue body.',
    html_url: 'https://github.com/acme/my-project/issues/42',
    labels: [],
    created_at: '2026-04-19T00:00:00Z',
    state: 'open',
    // Default assignee matches makeConfig() default user so existing tests pass the
    // defensive client-side assignee pre-filter in pollGitHubQueueIssues().
    assignees: [{ login: 'worktrain-etienneb' }],
    ...overrides,
  };
}

function makeFetch(response: {
  ok: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  headers?: Record<string, string>;
}): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    statusText: response.statusText ?? (response.ok ? 'OK' : 'Error'),
    json: response.json ?? (() => Promise.resolve([])),
    headers: {
      get: (key: string) => response.headers?.[key] ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// pollGitHubQueueIssues tests
// ---------------------------------------------------------------------------

describe('pollGitHubQueueIssues', () => {
  it('fetches issues matching assignee filter', async () => {
    const issue = makeIssue({ number: 42, title: 'Add Glob tool', body: 'Simple body', assignees: [{ login: 'bob' }] });
    const fetchFn = makeFetch({
      ok: true,
      json: () => Promise.resolve([issue]),
    });

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig({ user: 'bob' }), fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.number).toBe(42);
      expect(result.value[0]?.title).toBe('Add Glob tool');
    }

    // Verify assignee query param was set
    const fetchCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall?.[0]).toContain('assignee=bob');
  });

  it('type: label with queueLabel fetches with labels= query param', async () => {
    const issue = makeIssue({ number: 55, title: 'Label issue' });
    const fetchFn = makeFetch({
      ok: true,
      json: () => Promise.resolve([issue]),
    });

    const result = await pollGitHubQueueIssues(
      makeSource(),
      makeConfig({ type: 'label', queueLabel: 'worktrain:ready' }),
      fetchFn,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.number).toBe(55);
    }

    // Verify labels query param was set correctly (colon is percent-encoded)
    const fetchCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall?.[0]).toContain('labels=worktrain%3Aready');
    // Should NOT have assignee param
    expect(fetchCall?.[0]).not.toContain('assignee=');
  });

  it('type: label without queueLabel returns not_implemented', async () => {
    const fetchFn = makeFetch({ ok: true });

    const result = await pollGitHubQueueIssues(
      makeSource(),
      makeConfig({ type: 'label' }),
      fetchFn,
    );

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('not_implemented');
    }
    // fetchFn should NOT be called when config is invalid
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('type: assignee regression - still works after label support added', async () => {
    const issue = makeIssue({ number: 99, title: 'Assignee issue', assignees: [{ login: 'alice' }] });
    const fetchFn = makeFetch({
      ok: true,
      json: () => Promise.resolve([issue]),
    });

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig({ user: 'alice' }), fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.number).toBe(99);
    }

    // Verify assignee param and no labels param
    const fetchCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall?.[0]).toContain('assignee=alice');
    expect(fetchCall?.[0]).not.toContain('labels=');
  });

  it('returns network_error on fetch throw', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig(), fetchFn as FetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('network_error');
    }
  });

  it('returns http_error on non-2xx response', async () => {
    const fetchFn = makeFetch({ ok: false, status: 401, statusText: 'Unauthorized' });

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig(), fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('http_error');
    }
  });

  it('returns ok([]) on rate limit exceeded (X-RateLimit-Remaining < 100)', async () => {
    const issue = makeIssue({ number: 42 });
    const fetchFn = makeFetch({
      ok: true,
      json: () => Promise.resolve([issue]),
      headers: { 'X-RateLimit-Remaining': '50', 'X-RateLimit-Reset': '9999999999' },
    });

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig(), fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(0); // Rate limit skip returns empty array
    }
  });

  it('returns ok([]) on parse error (non-JSON response)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
      headers: { get: () => null },
    });

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig(), fetchFn as FetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('parse_error');
    }
  });

  it('maps GitHub API issue fields to GitHubQueueIssue', async () => {
    const issue = makeIssue({
      id: 9999,
      number: 7,
      title: 'Fix the bug',
      body: 'This is the body.',
      html_url: 'https://github.com/acme/my-project/issues/7',
      labels: [{ name: 'bug' }, { name: 'worktrain' }],
      created_at: '2026-01-01T00:00:00Z',
    });
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([issue]) });

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig(), fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const mapped = result.value[0];
      expect(mapped?.id).toBe(9999);
      expect(mapped?.number).toBe(7);
      expect(mapped?.title).toBe('Fix the bug');
      expect(mapped?.body).toBe('This is the body.');
      expect(mapped?.url).toBe('https://github.com/acme/my-project/issues/7');
      expect(mapped?.labels).toEqual([{ name: 'bug' }, { name: 'worktrain' }]);
      expect(mapped?.createdAt).toBe('2026-01-01T00:00:00Z');
    }
  });

  it('handles null body from GitHub API (empty string result)', async () => {
    const issue = { ...makeIssue(), body: null };
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([issue]) });

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig(), fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value[0]?.body).toBe('');
    }
  });

  it('filters out closed issues in API response (state guard)', async () => {
    // Defensive guard: API sends state=open but caching or API quirks can return closed items.
    // A closed issue should never enter the queue regardless of how it arrived.
    const closedIssue = makeIssue({ number: 42, state: 'closed' });
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([closedIssue]) });

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig(), fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(0);
    }
  });

  it('filters out pull requests in API response (pull_request field guard)', async () => {
    // GitHub Issues API returns PRs alongside issues. PRs have a pull_request field.
    // Queue poll should only dispatch coding tasks from issues, not PRs.
    const pr = {
      ...makeIssue({ number: 43 }),
      pull_request: { url: 'https://api.github.com/repos/acme/my-project/pulls/43' },
    };
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([pr]) });

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig(), fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(0);
    }
  });

  it('passes through open issues without pull_request field', async () => {
    // Regression guard: a standard open issue with no pull_request field must pass all filters.
    const openIssue = makeIssue({ number: 44, title: 'Valid open issue' });
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([openIssue]) });

    const result = await pollGitHubQueueIssues(makeSource(), makeConfig(), fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.number).toBe(44);
    }
  });
});

// ---------------------------------------------------------------------------
// inferMaturity tests (3 heuristics -- SCOPE LOCK)
// ---------------------------------------------------------------------------

describe('inferMaturity', () => {
  it('H1: body with upstream_spec: line -> ready', () => {
    const body = `## WorkTrain\nupstream_spec: https://example.com/pitch.md\n\nSome details.`;
    expect(inferMaturity(body)).toBe('ready');
  });

  it('H1: body with spec-implying URL (/spec path) in first paragraph -> ready', () => {
    const body = `See https://example.com/spec/my-feature for the full spec.\n\nDetails here.`;
    expect(inferMaturity(body)).toBe('ready');
  });

  it('H1: body with spec-implying URL (/prd path) in first paragraph -> ready', () => {
    const body = `Spec: https://docs.example.com/prd/feature-123\n\nDetails here.`;
    expect(inferMaturity(body)).toBe('ready');
  });

  it('H1: plain GitHub issue URL in first paragraph does NOT trigger ready (no spec path)', () => {
    // A plain issue link has no spec-implying path segment -> falls through to H2/default
    const body = `See https://github.com/acme/my-project/issues/1 for context.\n\nDetails here.`;
    expect(inferMaturity(body)).toBe('idea');
  });

  it('H1: URL in second paragraph does NOT trigger ready', () => {
    // Second paragraph means no URL in first paragraph -> falls through to H2
    const body = `Plain first paragraph.\n\nSee https://example.com for details.`;
    // Should be 'idea' since no checklist and no heading match
    expect(inferMaturity(body)).toBe('idea');
  });

  it('H2: checklist items -> specced', () => {
    const body = `## Task\n- [ ] Write tests\n- [ ] Update docs\n`;
    expect(inferMaturity(body)).toBe('specced');
  });

  it('H2: Acceptance Criteria heading -> specced', () => {
    const body = `## Acceptance Criteria\n- Must do X\n- Must do Y\n`;
    expect(inferMaturity(body)).toBe('specced');
  });

  it('H2: Implementation Plan heading -> specced', () => {
    const body = `## Implementation Plan\nDo this then that.`;
    expect(inferMaturity(body)).toBe('specced');
  });

  it('H2: loose implementation mention does NOT trigger specced (N1 tightening)', () => {
    // "### Implementation" and "Test Plan" no longer match -- only exact headings do.
    const body = `### Implementation\nDo this then that.`;
    expect(inferMaturity(body)).toBe('idea');
  });

  it('H2: Test Plan heading does NOT trigger specced after N1 tightening', () => {
    // Only "Acceptance Criteria" and "Implementation Plan" are exact matches.
    const body = `## Test Plan\n1. Run unit tests\n2. Check integration`;
    expect(inferMaturity(body)).toBe('idea');
  });

  it('Default: plain body -> idea', () => {
    const body = `This is a vague issue with no spec, no checklist, and no URL.`;
    expect(inferMaturity(body)).toBe('idea');
  });

  it('Default: empty body -> idea', () => {
    expect(inferMaturity('')).toBe('idea');
  });

  it('H1 takes precedence over H2 when both present', () => {
    const body = `See https://example.com/pitch\n\n- [ ] Implement\n- [ ] Test`;
    // H1 matches first -> 'ready'
    expect(inferMaturity(body)).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// checkIdempotency tests
// ---------------------------------------------------------------------------

describe('checkIdempotency', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-idempotency-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns clear when sessions directory is empty', async () => {
    const status = await checkIdempotency(42, tmpDir);
    expect(status).toBe('clear');
  });

  it('returns clear when no session file has matching issueNumber', async () => {
    const sessionFile = {
      continueToken: 'ct_abc',
      checkpointToken: null,
      ts: Date.now(),
      context: { taskCandidate: { issueNumber: 99, title: 'Other issue' } },
    };
    await fs.writeFile(path.join(tmpDir, 'sess_abc.json'), JSON.stringify(sessionFile), 'utf8');

    const status = await checkIdempotency(42, tmpDir);
    expect(status).toBe('clear');
  });

  it('returns active when session file has matching issueNumber', async () => {
    const sessionFile = {
      continueToken: 'ct_abc',
      checkpointToken: null,
      ts: Date.now(),
      context: { taskCandidate: { issueNumber: 42, title: 'Add Glob tool' } },
    };
    await fs.writeFile(path.join(tmpDir, 'sess_abc.json'), JSON.stringify(sessionFile), 'utf8');

    const status = await checkIdempotency(42, tmpDir);
    expect(status).toBe('active');
  });

  it('returns active (conservative) on malformed JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'sess_bad.json'), '{ invalid json }', 'utf8');

    const status = await checkIdempotency(42, tmpDir);
    expect(status).toBe('active');
  });

  it('returns clear when session file has no context field (real persistTokens format)', async () => {
    // Real session files written by persistTokens() contain only { continueToken, checkpointToken, ts }.
    // A file without context cannot claim ownership of any issue.
    const sessionFile = { continueToken: 'ct_abc', checkpointToken: null, ts: Date.now() };
    await fs.writeFile(path.join(tmpDir, 'sess_nocontext.json'), JSON.stringify(sessionFile), 'utf8');

    const status = await checkIdempotency(42, tmpDir);
    expect(status).toBe('clear');
  });

  it('returns clear when context has no taskCandidate (non-queue session)', async () => {
    // A session file with context but no taskCandidate is not a queue-originated session.
    // It cannot claim ownership of any issue.
    const sessionFile = {
      continueToken: 'ct_abc',
      context: { someOtherField: 'value' },
    };
    await fs.writeFile(path.join(tmpDir, 'sess_notask.json'), JSON.stringify(sessionFile), 'utf8');

    const status = await checkIdempotency(42, tmpDir);
    expect(status).toBe('clear');
  });

  it('regression C1: real-format session file {continueToken, checkpointToken, ts} returns clear', async () => {
    // Regression test for C1: persistTokens() writes this format -- no context field.
    // Before the C1 fix, this would return 'active' and permanently block queue dispatch.
    const sessionFile = { continueToken: 'ct_xxx', checkpointToken: 'cp_xxx', ts: 123 };
    await fs.writeFile(path.join(tmpDir, 'sess_real.json'), JSON.stringify(sessionFile), 'utf8');

    const status = await checkIdempotency(42, tmpDir);
    expect(status).toBe('clear');
  });

  it('returns clear when sessions dir does not exist', async () => {
    const nonExistentDir = path.join(tmpDir, 'does-not-exist');
    const status = await checkIdempotency(42, nonExistentDir);
    expect(status).toBe('clear');
  });

  it('ignores non-JSON files in sessions dir', async () => {
    await fs.writeFile(path.join(tmpDir, 'readme.txt'), 'not a session', 'utf8');
    await fs.writeFile(path.join(tmpDir, '.gitkeep'), '', 'utf8');

    const status = await checkIdempotency(42, tmpDir);
    expect(status).toBe('clear');
  });
});
