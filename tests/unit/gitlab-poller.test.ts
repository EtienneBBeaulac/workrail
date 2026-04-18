/**
 * Tests for src/trigger/adapters/gitlab-poller.ts
 *
 * Covers:
 * - Success: 2 MRs returned from fake fetch
 * - Empty result: API returns empty array
 * - HTTP 401: returns GitLabPollError.http_error
 * - HTTP 500: returns GitLabPollError.http_error
 * - Network error: fetch throws, returns GitLabPollError.network_error
 * - Invalid JSON: returns GitLabPollError.parse_error
 * - Non-array response: returns GitLabPollError.parse_error
 * - Malformed MR entries: skipped, valid entries returned
 * - Event filter: "merge_request.opened" only
 * - Event filter: "merge_request.updated" includes all
 * - Event filter: empty events includes all
 * - URL encoding: projectId with slashes is encoded
 */

import { describe, expect, it, vi } from 'vitest';
import { pollGitLabMRs, type FetchFn, type GitLabMR } from '../../src/trigger/adapters/gitlab-poller.js';
import type { GitLabPollingSource } from '../../src/trigger/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSource(overrides: Partial<GitLabPollingSource> = {}): GitLabPollingSource {
  return {
    baseUrl: 'https://gitlab.example.com',
    projectId: '12345',
    token: 'test-token',
    events: ['merge_request.opened', 'merge_request.updated'],
    pollIntervalSeconds: 60,
    ...overrides,
  };
}

function makeMR(overrides: Partial<GitLabMR> = {}): GitLabMR {
  return {
    id: 1001,
    iid: 42,
    title: 'Test MR',
    web_url: 'https://gitlab.example.com/group/repo/-/merge_requests/42',
    updated_at: '2026-04-15T10:00:00.000Z',
    state: 'opened',
    ...overrides,
  };
}

function makeFetch(response: { ok: boolean; status?: number; statusText?: string; json?: () => Promise<unknown> }): FetchFn {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    statusText: response.statusText ?? (response.ok ? 'OK' : 'Error'),
    json: response.json ?? (() => Promise.resolve([])),
  } as Response);
}

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe('pollGitLabMRs', () => {
  it('returns MRs from a successful response', async () => {
    const mr1 = makeMR({ id: 1001, iid: 1 });
    const mr2 = makeMR({ id: 1002, iid: 2, title: 'Another MR' });

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([mr1, mr2]) });
    const result = await pollGitLabMRs(makeSource(), '2026-01-01T00:00:00.000Z', fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.id).toBe(1001);
      expect(result.value[1]?.id).toBe(1002);
    }
  });

  it('returns empty array for empty API response', async () => {
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([]) });
    const result = await pollGitLabMRs(makeSource(), '2026-01-01T00:00:00.000Z', fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(0);
    }
  });

  it('builds correct API URL with query params', async () => {
    let capturedUrl: string | undefined;
    const fetchFn: FetchFn = (url) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      } as Response);
    };

    await pollGitLabMRs(makeSource(), '2026-04-15T10:00:00.000Z', fetchFn);

    expect(capturedUrl).toContain('/api/v4/projects/12345/merge_requests');
    expect(capturedUrl).toContain('state=opened');
    expect(capturedUrl).toContain('updated_after=2026-04-15T10');
    expect(capturedUrl).toContain('per_page=100');
  });

  it('sends PRIVATE-TOKEN header', async () => {
    let capturedHeaders: RequestInit['headers'] | undefined;
    const fetchFn: FetchFn = (_url, init) => {
      capturedHeaders = init.headers;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      } as Response);
    };

    await pollGitLabMRs(makeSource({ token: 'my-secret-token' }), '2026-01-01T00:00:00.000Z', fetchFn);

    expect((capturedHeaders as Record<string, string>)?.['PRIVATE-TOKEN']).toBe('my-secret-token');
  });

  it('URL-encodes projectId with slashes', async () => {
    let capturedUrl: string | undefined;
    const fetchFn: FetchFn = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) } as Response);
    };

    await pollGitLabMRs(makeSource({ projectId: 'my-group/my-project' }), '2026-01-01T00:00:00.000Z', fetchFn);

    expect(capturedUrl).toContain('my-group%2Fmy-project');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('pollGitLabMRs error handling', () => {
  it('returns http_error for HTTP 401', async () => {
    const fetchFn = makeFetch({ ok: false, status: 401, statusText: 'Unauthorized' });
    const result = await pollGitLabMRs(makeSource(), '2026-01-01T00:00:00.000Z', fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('http_error');
      expect((result.error as { kind: 'http_error'; status: number }).status).toBe(401);
    }
  });

  it('returns http_error for HTTP 500', async () => {
    const fetchFn = makeFetch({ ok: false, status: 500, statusText: 'Internal Server Error' });
    const result = await pollGitLabMRs(makeSource(), '2026-01-01T00:00:00.000Z', fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('http_error');
    }
  });

  it('returns network_error when fetch throws', async () => {
    const fetchFn: FetchFn = () => Promise.reject(new Error('Connection refused'));
    const result = await pollGitLabMRs(makeSource(), '2026-01-01T00:00:00.000Z', fetchFn);

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
    } as Response);
    const result = await pollGitLabMRs(makeSource(), '2026-01-01T00:00:00.000Z', fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('parse_error');
    }
  });

  it('returns parse_error for non-array response', async () => {
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve({ data: [] }) });
    const result = await pollGitLabMRs(makeSource(), '2026-01-01T00:00:00.000Z', fetchFn);

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('parse_error');
    }
  });

  it('skips malformed MR entries and returns valid ones', async () => {
    const validMR = makeMR({ id: 1001 });
    const malformed = { id: 'not-a-number', title: 'Bad MR' }; // id should be a number

    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([malformed, validMR]) });
    const result = await pollGitLabMRs(makeSource(), '2026-01-01T00:00:00.000Z', fetchFn);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(1001);
    }
  });
});

// ---------------------------------------------------------------------------
// Event filter
// ---------------------------------------------------------------------------

describe('pollGitLabMRs event filtering', () => {
  const openMR = makeMR({ id: 1, state: 'opened' });
  const closedMR = makeMR({ id: 2, state: 'merged' });

  it('includes all MRs when events contains merge_request.updated', async () => {
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([openMR, closedMR]) });
    const result = await pollGitLabMRs(
      makeSource({ events: ['merge_request.updated'] }),
      '2026-01-01T00:00:00.000Z',
      fetchFn,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(2);
    }
  });

  it('includes only opened MRs when events contains only merge_request.opened', async () => {
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([openMR, closedMR]) });
    const result = await pollGitLabMRs(
      makeSource({ events: ['merge_request.opened'] }),
      '2026-01-01T00:00:00.000Z',
      fetchFn,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.id).toBe(1);
    }
  });

  it('includes all MRs when events is empty (permissive default)', async () => {
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([openMR, closedMR]) });
    const result = await pollGitLabMRs(
      makeSource({ events: [] }),
      '2026-01-01T00:00:00.000Z',
      fetchFn,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(2);
    }
  });

  it('includes all MRs when events contains both opened and updated', async () => {
    const fetchFn = makeFetch({ ok: true, json: () => Promise.resolve([openMR, closedMR]) });
    const result = await pollGitLabMRs(
      makeSource({ events: ['merge_request.opened', 'merge_request.updated'] }),
      '2026-01-01T00:00:00.000Z',
      fetchFn,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toHaveLength(2);
    }
  });
});
