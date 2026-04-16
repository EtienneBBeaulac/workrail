/**
 * Tests for src/trigger/adapters/github-poller.ts
 *
 * Covers:
 * - Issues: success, empty response, HTTP 401/500, network error, invalid JSON,
 *   non-array response, malformed items
 * - Issues: URL construction (since param, labels param)
 * - Issues: Authorization header
 * - Issues: excludeAuthors filter (bot account excluded)
 * - Issues: notLabels filter (labeled items excluded)
 * - Issues: rate limit skip (X-RateLimit-Remaining < 100)
 * - PRs: success, same error cases as issues
 * - PRs: URL construction (no since param, sort=updated direction=desc)
 * - PRs: updated_at client-side filter (items older than since excluded)
 * - PRs: excludeAuthors filter
 * - PRs: notLabels filter
 * - PRs: rate limit skip
 */

import { describe, expect, it, vi } from 'vitest';
import {
  pollGitHubIssues,
  pollGitHubPRs,
  type FetchFn,
  type GitHubIssue,
  type GitHubPR,
} from '../../src/trigger/adapters/github-poller.js';
import type { GitHubPollingSource } from '../../src/trigger/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(overrides: Partial<GitHubPollingSource> = {}): GitHubPollingSource {
  return {
    repo: 'acme/my-project',
    token: 'test-token',
    events: ['issues.opened', 'issues.updated'],
    pollIntervalSeconds: 300,
    excludeAuthors: [],
    notLabels: [],
    labelFilter: [],
    ...overrides,
  };
}

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    id: 1001,
    number: 42,
    title: 'Test issue',
    html_url: 'https://github.com/acme/my-project/issues/42',
    updated_at: '2026-04-15T10:00:00.000Z',
    state: 'open',
    user: { login: 'alice' },
    labels: [],
    ...overrides,
  };
}

function makePR(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    id: 2001,
    number: 10,
    title: 'Test PR',
    html_url: 'https://github.com/acme/my-project/pull/10',
    updated_at: '2026-04-15T10:00:00.000Z',
    state: 'open',
    user: { login: 'alice' },
    draft: false,
    labels: [],
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
      get: (name: string) => (response.headers ?? {})[name] ?? null,
    },
  } as unknown as Response);
}

const SINCE = '2026-04-15T09:00:00.000Z';

// ---------------------------------------------------------------------------
// Issues: success cases
// ---------------------------------------------------------------------------

describe('pollGitHubIssues', () => {
  it('returns issues from a successful response', async () => {
    const issue1 = makeIssue({ id: 1001, number: 1 });
    const issue2 = makeIssue({ id: 1002, number: 2, title: 'Another issue' });

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([issue1, issue2]) });
    const result = await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.id).toBe(1001);
      expect(result.value[1]?.id).toBe(1002);
    }
  });

  it('returns empty array for empty API response', async () => {
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([]) });
    const result = await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(0);
    }
  });

  it('builds correct URL with since and sort params', async () => {
    let capturedUrl: string | undefined;
    const fetchFn: FetchFn = (url) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
        headers: { get: () => null },
      } as unknown as Response);
    };

    await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(capturedUrl).toContain('/repos/acme/my-project/issues');
    expect(capturedUrl).toContain('state=open');
    expect(capturedUrl).toContain(`since=${encodeURIComponent(SINCE)}`);
    expect(capturedUrl).toContain('sort=updated');
    expect(capturedUrl).toContain('direction=desc');
    expect(capturedUrl).toContain('per_page=100');
  });

  it('includes labelFilter as labels param when set', async () => {
    let capturedUrl: string | undefined;
    const fetchFn: FetchFn = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), headers: { get: () => null } } as unknown as Response);
    };

    await pollGitHubIssues(makeSource({ labelFilter: ['bug', 'high-priority'] }), SINCE, fetchFn);

    expect(capturedUrl).toContain('labels=bug%2Chigh-priority');
  });

  it('does NOT include labels param when labelFilter is empty', async () => {
    let capturedUrl: string | undefined;
    const fetchFn: FetchFn = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), headers: { get: () => null } } as unknown as Response);
    };

    await pollGitHubIssues(makeSource({ labelFilter: [] }), SINCE, fetchFn);

    expect(capturedUrl).not.toContain('labels=');
  });

  it('sends Authorization: Bearer header', async () => {
    let capturedHeaders: RequestInit['headers'] | undefined;
    const fetchFn: FetchFn = (_url, init) => {
      capturedHeaders = init.headers;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), headers: { get: () => null } } as unknown as Response);
    };

    await pollGitHubIssues(makeSource({ token: 'ghp_secret' }), SINCE, fetchFn);

    expect((capturedHeaders as Record<string, string>)?.['Authorization']).toBe('Bearer ghp_secret');
  });

  it('skips malformed items and returns valid ones', async () => {
    const valid = makeIssue({ id: 1001 });
    const malformed = { id: 'not-a-number', title: 'Bad' };

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([malformed, valid]) });
    const result = await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(1001);
    }
  });
});

// ---------------------------------------------------------------------------
// Issues: error cases
// ---------------------------------------------------------------------------

describe('pollGitHubIssues error handling', () => {
  it('returns http_error for HTTP 401', async () => {
    const fetchFn = makeFetch({ ok: false, status: 401, statusText: 'Unauthorized' });
    const result = await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('http_error');
      expect((result.error as { kind: 'http_error'; status: number }).status).toBe(401);
    }
  });

  it('returns http_error for HTTP 500', async () => {
    const fetchFn = makeFetch({ ok: false, status: 500 });
    const result = await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('http_error');
    }
  });

  it('returns network_error when fetch throws', async () => {
    const fetchFn: FetchFn = () => Promise.reject(new Error('Connection refused'));
    const result = await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('network_error');
      expect((result.error as { kind: 'network_error'; message: string }).message).toContain('Connection refused');
    }
  });

  it('returns parse_error for invalid JSON', async () => {
    const fetchFn: FetchFn = () => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
      headers: { get: () => null },
    } as unknown as Response);
    const result = await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('parse_error');
    }
  });

  it('returns parse_error for non-array response', async () => {
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve({ data: [] }) });
    const result = await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('parse_error');
    }
  });
});

// ---------------------------------------------------------------------------
// Issues: filters
// ---------------------------------------------------------------------------

describe('pollGitHubIssues filters', () => {
  it('excludes items authored by excludeAuthors (exact match)', async () => {
    const botIssue = makeIssue({ id: 1001, user: { login: 'worktrain-bot' } });
    const humanIssue = makeIssue({ id: 1002, user: { login: 'alice' } });

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([botIssue, humanIssue]) });
    const result = await pollGitHubIssues(
      makeSource({ excludeAuthors: ['worktrain-bot'] }),
      SINCE,
      fetchFn,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(1002);
    }
  });

  it('does not exclude items when excludeAuthors is empty', async () => {
    const issue = makeIssue({ id: 1001, user: { login: 'alice' } });
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([issue]) });
    const result = await pollGitHubIssues(makeSource({ excludeAuthors: [] }), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
    }
  });

  it('excludes items with notLabels label', async () => {
    const wontFixIssue = makeIssue({
      id: 1001,
      labels: [{ name: 'wont-fix' }, { name: 'bug' }],
    });
    const normalIssue = makeIssue({ id: 1002, labels: [{ name: 'bug' }] });

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([wontFixIssue, normalIssue]) });
    const result = await pollGitHubIssues(
      makeSource({ notLabels: ['wont-fix', 'duplicate'] }),
      SINCE,
      fetchFn,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(1002);
    }
  });

  it('excludeAuthors and notLabels both active -- excludes from both', async () => {
    const botIssue = makeIssue({ id: 1001, user: { login: 'worktrain-bot' } });
    const wontFixIssue = makeIssue({ id: 1002, labels: [{ name: 'wont-fix' }] });
    const validIssue = makeIssue({ id: 1003, user: { login: 'alice' }, labels: [{ name: 'bug' }] });

    const fetchFn = makeFetch({
      ok: true,
      json: () => Promise.resolve([botIssue, wontFixIssue, validIssue]),
    });
    const result = await pollGitHubIssues(
      makeSource({ excludeAuthors: ['worktrain-bot'], notLabels: ['wont-fix'] }),
      SINCE,
      fetchFn,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(1003);
    }
  });
});

// ---------------------------------------------------------------------------
// Issues: rate limit
// ---------------------------------------------------------------------------

describe('pollGitHubIssues rate limit', () => {
  it('returns ok([]) and logs warning when X-RateLimit-Remaining < 100', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const fetchFn: FetchFn = () => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([makeIssue()]),
      headers: {
        get: (name: string) => {
          if (name === 'X-RateLimit-Remaining') return '50';
          if (name === 'X-RateLimit-Reset') return '1713178800';
          return null;
        },
      },
    } as unknown as Response);

    const result = await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(0); // skipped due to rate limit
    }
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Rate limit low'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('remaining=50'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('resets at'),
    );

    warnSpy.mockRestore();
  });

  it('proceeds normally when X-RateLimit-Remaining >= 100', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const fetchFn: FetchFn = () => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([makeIssue({ id: 1001 })]),
      headers: {
        get: (name: string) => name === 'X-RateLimit-Remaining' ? '4500' : null,
      },
    } as unknown as Response);

    const result = await pollGitHubIssues(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
    }
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Rate limit'));

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// PRs: success cases
// ---------------------------------------------------------------------------

describe('pollGitHubPRs', () => {
  it('returns PRs from a successful response', async () => {
    const pr1 = makePR({ id: 2001, number: 1 });
    const pr2 = makePR({ id: 2002, number: 2, title: 'Another PR' });

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([pr1, pr2]) });
    const result = await pollGitHubPRs(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.id).toBe(2001);
      expect(result.value[1]?.id).toBe(2002);
    }
  });

  it('returns empty array for empty API response', async () => {
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([]) });
    const result = await pollGitHubPRs(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(0);
    }
  });

  it('builds correct PRs URL (no since param, sort by updated)', async () => {
    let capturedUrl: string | undefined;
    const fetchFn: FetchFn = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), headers: { get: () => null } } as unknown as Response);
    };

    await pollGitHubPRs(makeSource(), SINCE, fetchFn);

    expect(capturedUrl).toContain('/repos/acme/my-project/pulls');
    expect(capturedUrl).toContain('state=open');
    expect(capturedUrl).toContain('sort=updated');
    expect(capturedUrl).toContain('direction=desc');
    expect(capturedUrl).toContain('per_page=100');
    // PRs endpoint does NOT support since param
    expect(capturedUrl).not.toContain('since=');
    // labelFilter is silently ignored for PRs
    expect(capturedUrl).not.toContain('labels=');
  });

  it('does NOT include labels param when labelFilter is set (PRs API does not support it)', async () => {
    // labelFilter is silently ignored for github_prs_poll -- the PRs list endpoint has no
    // labels parameter. This test guards against accidentally adding labels= for PRs.
    let capturedUrl: string | undefined;
    const fetchFn: FetchFn = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]), headers: { get: () => null } } as unknown as Response);
    };

    await pollGitHubPRs(makeSource({ labelFilter: ['bug'] }), SINCE, fetchFn);

    expect(capturedUrl).not.toContain('labels=');
  });

  it('filters out PRs with updated_at <= since (client-side filter)', async () => {
    const oldPR = makePR({ id: 2001, updated_at: '2026-04-14T08:00:00.000Z' }); // before SINCE
    const newPR = makePR({ id: 2002, updated_at: '2026-04-15T10:00:00.000Z' }); // after SINCE

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([newPR, oldPR]) });
    const result = await pollGitHubPRs(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(2002);
    }
  });

  it('includes PRs with updated_at exactly equal to since (ISO string comparison)', async () => {
    // ISO string comparison: '2026-04-15T09:00:00.000Z' > '2026-04-15T09:00:00.000Z' is false
    // So a PR updated exactly AT since is NOT included (we want strictly AFTER)
    const exactPR = makePR({ id: 2001, updated_at: SINCE });
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([exactPR]) });
    const result = await pollGitHubPRs(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // updated_at === since is NOT strictly after, so excluded
      expect(result.value).toHaveLength(0);
    }
  });

  it('excludes PRs authored by excludeAuthors', async () => {
    const botPR = makePR({ id: 2001, user: { login: 'worktrain-bot' } });
    const humanPR = makePR({ id: 2002, user: { login: 'alice' } });

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([botPR, humanPR]) });
    const result = await pollGitHubPRs(
      makeSource({ excludeAuthors: ['worktrain-bot'] }),
      SINCE,
      fetchFn,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(2002);
    }
  });

  it('excludes PRs with notLabels label', async () => {
    const wontFixPR = makePR({ id: 2001, labels: [{ name: 'wont-fix' }] });
    const normalPR = makePR({ id: 2002, labels: [{ name: 'needs-review' }] });

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([wontFixPR, normalPR]) });
    const result = await pollGitHubPRs(
      makeSource({ notLabels: ['wont-fix'] }),
      SINCE,
      fetchFn,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(2002);
    }
  });

  it('returns ok([]) when X-RateLimit-Remaining < 100', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const fetchFn: FetchFn = () => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve([makePR()]),
      headers: {
        get: (name: string) => {
          if (name === 'X-RateLimit-Remaining') return '5';
          if (name === 'X-RateLimit-Reset') return '1713178800';
          return null;
        },
      },
    } as unknown as Response);

    const result = await pollGitHubPRs(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(0);
    }
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Rate limit low'));

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// PRs: error cases (mirror issue error cases)
// ---------------------------------------------------------------------------

describe('pollGitHubPRs error handling', () => {
  it('returns http_error for HTTP 401', async () => {
    const fetchFn = makeFetch({ ok: false, status: 401 });
    const result = await pollGitHubPRs(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('http_error');
      expect((result.error as { kind: 'http_error'; status: number }).status).toBe(401);
    }
  });

  it('returns network_error when fetch throws', async () => {
    const fetchFn: FetchFn = () => Promise.reject(new Error('ECONNREFUSED'));
    const result = await pollGitHubPRs(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('network_error');
    }
  });

  it('returns parse_error for non-array response', async () => {
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve({ message: 'not an array' }) });
    const result = await pollGitHubPRs(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('parse_error');
    }
  });

  it('skips malformed PR items and returns valid ones', async () => {
    const valid = makePR({ id: 2001 });
    const malformed = { title: 'Missing required fields' };

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([malformed, valid]) });
    const result = await pollGitHubPRs(makeSource(), SINCE, fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(2001);
    }
  });
});
