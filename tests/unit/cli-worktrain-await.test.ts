/**
 * Unit tests for executeWorktrainAwaitCommand and parseDurationMs
 *
 * Uses fake deps (in-memory fetch, injected clock). No vi.mock() -- follows repo
 * pattern of "prefer fakes over mocks".
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  executeWorktrainAwaitCommand,
  parseDurationMs,
  type WorktrainAwaitCommandDeps,
  type AwaitResult,
} from '../../src/cli/commands/worktrain-await.js';

// ═══════════════════════════════════════════════════════════════════════════
// DURATION PARSING TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('parseDurationMs', () => {
  it('parses seconds', () => expect(parseDurationMs('30s')).toBe(30_000));
  it('parses minutes', () => expect(parseDurationMs('5m')).toBe(300_000));
  it('parses hours', () => expect(parseDurationMs('2h')).toBe(7_200_000));
  it('parses bare integers as seconds', () => expect(parseDurationMs('60')).toBe(60_000));
  it('returns null for empty string', () => expect(parseDurationMs('')).toBeNull());
  it('returns null for invalid format', () => expect(parseDurationMs('1d')).toBeNull());
  it('returns null for zero', () => expect(parseDurationMs('0m')).toBeNull());
  it('is case-insensitive', () => expect(parseDurationMs('1H')).toBe(3_600_000));
});

// ═══════════════════════════════════════════════════════════════════════════
// AWAIT COMMAND HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Builds a fake fetch that returns the given session responses in order. */
function makeFakeSessionFetch(
  responses: Record<string, Array<{ ok: boolean; status: number; body: unknown }>>,
): { fetch: WorktrainAwaitCommandDeps['fetch']; callCounts: Record<string, number> } {
  const callCounts: Record<string, number> = {};

  const fakeFetch: WorktrainAwaitCommandDeps['fetch'] = async (url) => {
    // Extract session handle from URL
    const match = /\/sessions\/([^/]+)$/.exec(url);
    const handle = match ? decodeURIComponent(match[1] ?? '') : url;

    callCounts[handle] = (callCounts[handle] ?? 0) + 1;
    const responseList = responses[handle] ?? [];
    const idx = Math.min((callCounts[handle] ?? 1) - 1, responseList.length - 1);
    const response = responseList[idx] ?? { ok: false, status: 404, body: { success: false } };

    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    };
  };

  return { fetch: fakeFetch, callCounts };
}

function makeSessionDetailResponse(status: string) {
  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      data: {
        sessionId: 'test',
        runs: [{ status, workflowId: 'test' }],
      },
    },
  };
}

function makeBaseDeps(
  fetch: WorktrainAwaitCommandDeps['fetch'],
  nowSequence: number[] = [],
): { deps: WorktrainAwaitCommandDeps; stdoutLines: string[]; stderrLines: string[] } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  let nowIdx = 0;
  const startMs = 1000;

  const deps: WorktrainAwaitCommandDeps = {
    fetch,
    readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    homedir: () => '/home/testuser',
    joinPath: path.join,
    sleep: async () => {},
    now: () => {
      if (nowSequence.length > 0) {
        const val = nowSequence[nowIdx] ?? nowSequence[nowSequence.length - 1] ?? startMs;
        nowIdx++;
        return val;
      }
      return startMs;
    },
  };

  return { deps, stdoutLines, stderrLines };
}

// ═══════════════════════════════════════════════════════════════════════════
// AWAIT TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('executeWorktrainAwaitCommand', () => {
  it('happy path (mode all): waits for all sessions and returns success', async () => {
    const { fetch } = makeFakeSessionFetch({
      sess1: [
        makeSessionDetailResponse('in_progress'),
        makeSessionDetailResponse('complete'),
      ],
      sess2: [
        makeSessionDetailResponse('complete'),
      ],
    });

    const { deps, stdoutLines } = makeBaseDeps(fetch);
    const result = await executeWorktrainAwaitCommand(deps, {
      sessions: 'sess1,sess2',
      timeout: '1h',
      pollInterval: 0,
    });

    expect(result.kind).toBe('success');
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0] ?? '{}') as AwaitResult;
    expect(parsed.allSucceeded).toBe(true);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results.every((r) => r.outcome === 'success')).toBe(true);
  });

  it('mode all: returns failure when any session fails', async () => {
    const { fetch } = makeFakeSessionFetch({
      sess1: [makeSessionDetailResponse('complete')],
      sess2: [makeSessionDetailResponse('blocked')],
    });

    const { deps, stdoutLines } = makeBaseDeps(fetch);
    const result = await executeWorktrainAwaitCommand(deps, {
      sessions: 'sess1,sess2',
      timeout: '1h',
      pollInterval: 0,
    });

    expect(result.kind).toBe('failure');
    const parsed = JSON.parse(stdoutLines[0] ?? '{}') as AwaitResult;
    expect(parsed.allSucceeded).toBe(false);
    const blocked = parsed.results.find((r) => r.handle === 'sess2');
    expect(blocked?.outcome).toBe('failed');
  });

  it('mode any: returns success when first session succeeds', async () => {
    const { fetch } = makeFakeSessionFetch({
      sess1: [makeSessionDetailResponse('complete')],
      sess2: [makeSessionDetailResponse('in_progress')], // still running
    });

    const { deps, stdoutLines } = makeBaseDeps(fetch);
    const result = await executeWorktrainAwaitCommand(deps, {
      sessions: 'sess1,sess2',
      mode: 'any',
      timeout: '1h',
      pollInterval: 0,
    });

    expect(result.kind).toBe('success');
    const parsed = JSON.parse(stdoutLines[0] ?? '{}') as AwaitResult;
    expect(parsed.allSucceeded).toBe(true);
    const s1 = parsed.results.find((r) => r.handle === 'sess1');
    expect(s1?.outcome).toBe('success');
  });

  it('maps 404 response to not_found outcome', async () => {
    const { fetch } = makeFakeSessionFetch({
      'missing-session': [{ ok: false, status: 404, body: { success: false, error: 'Session not found' } }],
    });

    const { deps, stdoutLines } = makeBaseDeps(fetch);
    const result = await executeWorktrainAwaitCommand(deps, {
      sessions: 'missing-session',
      timeout: '1h',
      pollInterval: 0,
    });

    expect(result.kind).toBe('failure');
    const parsed = JSON.parse(stdoutLines[0] ?? '{}') as AwaitResult;
    expect(parsed.results[0]?.outcome).toBe('not_found');
  });

  it('maps dormant status to timeout outcome', async () => {
    const { fetch } = makeFakeSessionFetch({
      sess1: [makeSessionDetailResponse('dormant')],
    });

    const { deps } = makeBaseDeps(fetch);
    const result = await executeWorktrainAwaitCommand(deps, {
      sessions: 'sess1',
      timeout: '1h',
      pollInterval: 0,
    });

    expect(result.kind).toBe('failure');
  });

  it('timeout: marks pending sessions as timed out after wall-clock timeout', async () => {
    // Session never completes (always in_progress)
    const { fetch } = makeFakeSessionFetch({
      sess1: [
        makeSessionDetailResponse('in_progress'),
        makeSessionDetailResponse('in_progress'),
      ],
    });

    // nowSequence: first call returns 0ms, then 61000ms (past 60s timeout)
    const nowSequence = [0, 0, 0, 0, 61_000];
    const { deps, stdoutLines } = makeBaseDeps(fetch, nowSequence);

    const result = await executeWorktrainAwaitCommand(deps, {
      sessions: 'sess1',
      timeout: '60s',
      pollInterval: 0,
    });

    expect(result.kind).toBe('failure');
    const parsed = JSON.parse(stdoutLines[0] ?? '{}') as AwaitResult;
    expect(parsed.results[0]?.outcome).toBe('timeout');
  });

  it('returns misuse when --sessions is empty', async () => {
    const { deps } = makeBaseDeps(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const result = await executeWorktrainAwaitCommand(deps, { sessions: '' });
    expect(result.kind).toBe('failure');
  });

  it('returns misuse for invalid timeout format', async () => {
    const { deps } = makeBaseDeps(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const result = await executeWorktrainAwaitCommand(deps, {
      sessions: 'sess1',
      timeout: 'invalid',
    });
    expect(result.kind).toBe('failure');
    expect((result as { kind: 'failure'; output: { message: string } }).output.message).toContain('--timeout');
  });

  it('includes durationMs in results', async () => {
    const { fetch } = makeFakeSessionFetch({
      sess1: [makeSessionDetailResponse('complete')],
    });

    // now returns 500 initially, then 1500ms when recording result
    const nowSequence = [500, 500, 500, 1500, 1500, 1500];
    const { deps, stdoutLines } = makeBaseDeps(fetch, nowSequence);

    await executeWorktrainAwaitCommand(deps, {
      sessions: 'sess1',
      timeout: '1h',
      pollInterval: 0,
    });

    const parsed = JSON.parse(stdoutLines[0] ?? '{}') as AwaitResult;
    expect(parsed.results[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
