/**
 * Unit tests for executeWorktrainSpawnCommand and executeWorktrainAwaitCommand
 *
 * Uses fake deps (in-memory fetch, fake fs). No vi.mock() -- follows repo pattern
 * of "prefer fakes over mocks".
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { tmpPath } from '../helpers/platform.js';
import {
  executeWorktrainSpawnCommand,
  type WorktrainSpawnCommandDeps,
} from '../../src/cli/commands/worktrain-spawn.js';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function makeFakeFetch(response: { ok: boolean; status: number; body: unknown }) {
  const calls: FetchCall[] = [];
  const fakeFetch: WorktrainSpawnCommandDeps['fetch'] = async (url, opts) => {
    calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    };
  };
  return { fakeFetch, calls };
}

function makeBaseDeps(overrides: Partial<WorktrainSpawnCommandDeps> = {}): {
  deps: WorktrainSpawnCommandDeps;
  stdoutLines: string[];
  stderrLines: string[];
} {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  const deps: WorktrainSpawnCommandDeps = {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { sessionHandle: 'test-handle' } }) }),
    readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    homedir: () => '/home/testuser',
    joinPath: path.join,
    pathIsAbsolute: path.isAbsolute,
    statPath: async () => ({ isDirectory: () => true }),
    ...overrides,
  };

  return { deps, stdoutLines, stderrLines };
}

const VALID_OPTS = {
  workflow: 'coding-task-workflow-agentic',
  goal: 'test goal',
  workspace: tmpPath('workspace'),
};

// ═══════════════════════════════════════════════════════════════════════════
// SPAWN TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('executeWorktrainSpawnCommand', () => {
  it('happy path: prints session handle to stdout and returns success', async () => {
    const { deps, stdoutLines } = makeBaseDeps({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { sessionHandle: 'sess_abc123', workflowId: 'coding-task-workflow-agentic' },
        }),
      }),
    });

    const result = await executeWorktrainSpawnCommand(deps, VALID_OPTS);

    expect(result.kind).toBe('success');
    expect(stdoutLines).toEqual(['sess_abc123']);
  });

  it('uses port from daemon-console.lock (standalone console) with priority over dashboard.lock', async () => {
    const fetchCalls: string[] = [];
    const { deps } = makeBaseDeps({
      readFile: async (p) => {
        if (p.includes('daemon-console.lock')) return JSON.stringify({ port: 8888, pid: 11111 });
        if (p.includes('dashboard.lock')) return JSON.stringify({ port: 9999, pid: 12345 });
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      fetch: async (url, opts) => {
        fetchCalls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { sessionHandle: 'h1' } }),
        };
      },
    });

    await executeWorktrainSpawnCommand(deps, VALID_OPTS);

    // daemon-console.lock (port 8888) takes priority over dashboard.lock (port 9999)
    expect(fetchCalls[0]).toContain(':8888/');
  });

  it('falls back to dashboard.lock when daemon-console.lock is absent', async () => {
    const fetchCalls: string[] = [];
    const { deps } = makeBaseDeps({
      readFile: async (p) => {
        if (p.includes('daemon-console.lock')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        if (p.includes('dashboard.lock')) return JSON.stringify({ port: 9999, pid: 12345 });
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      fetch: async (url, opts) => {
        fetchCalls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { sessionHandle: 'h1' } }),
        };
      },
    });

    await executeWorktrainSpawnCommand(deps, VALID_OPTS);

    expect(fetchCalls[0]).toContain(':9999/');
  });

  it('falls back to port 3456 when lock file is absent', async () => {
    const fetchCalls: string[] = [];
    const { deps } = makeBaseDeps({
      fetch: async (url, opts) => {
        fetchCalls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { sessionHandle: 'h1' } }),
        };
      },
    });

    await executeWorktrainSpawnCommand(deps, VALID_OPTS);

    expect(fetchCalls[0]).toContain(':3456/');
  });

  it('uses explicit --port override over lock file port', async () => {
    const fetchCalls: string[] = [];
    const { deps } = makeBaseDeps({
      readFile: async () => JSON.stringify({ port: 9999 }),
      fetch: async (url, opts) => {
        fetchCalls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { sessionHandle: 'h1' } }),
        };
      },
    });

    await executeWorktrainSpawnCommand(deps, { ...VALID_OPTS, port: 7777 });

    expect(fetchCalls[0]).toContain(':7777/');
  });

  it('returns failure when connection is refused', async () => {
    const { deps, stdoutLines } = makeBaseDeps({
      fetch: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3456'); },
    });

    const result = await executeWorktrainSpawnCommand(deps, VALID_OPTS);

    expect(result.kind).toBe('failure');
    expect((result as { kind: 'failure'; output: { message: string } }).output.message).toContain('Could not connect');
    expect(stdoutLines).toEqual([]); // nothing to stdout on error
  });

  it('returns failure when dispatch returns error response', async () => {
    const { deps } = makeBaseDeps({
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ success: false, error: 'workflowId not found' }),
      }),
    });

    const result = await executeWorktrainSpawnCommand(deps, VALID_OPTS);

    expect(result.kind).toBe('failure');
    expect((result as { kind: 'failure'; output: { message: string } }).output.message).toContain('workflowId not found');
  });

  it('returns misuse when --workflow is empty', async () => {
    const { deps } = makeBaseDeps();

    const result = await executeWorktrainSpawnCommand(deps, { ...VALID_OPTS, workflow: '  ' });

    expect(result.kind).toBe('failure');
    expect((result as { kind: 'failure'; output: { message: string } }).output.message).toContain('--workflow');
  });

  it('returns misuse when --workspace is relative', async () => {
    const { deps } = makeBaseDeps();

    const result = await executeWorktrainSpawnCommand(deps, { ...VALID_OPTS, workspace: 'relative/path' });

    expect(result.kind).toBe('failure');
    expect((result as { kind: 'failure'; output: { message: string } }).output.message).toContain('absolute');
  });

  it('returns failure when workspace does not exist', async () => {
    const { deps } = makeBaseDeps({
      statPath: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    });

    const result = await executeWorktrainSpawnCommand(deps, VALID_OPTS);

    expect(result.kind).toBe('failure');
    expect((result as { kind: 'failure'; output: { message: string } }).output.message).toContain('does not exist');
  });

  it('returns failure when response is missing sessionHandle', async () => {
    const { deps } = makeBaseDeps({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { workflowId: 'foo' } }), // no sessionHandle
      }),
    });

    const result = await executeWorktrainSpawnCommand(deps, VALID_OPTS);

    expect(result.kind).toBe('failure');
    expect((result as { kind: 'failure'; output: { message: string } }).output.message).toContain('session handle');
  });
});
