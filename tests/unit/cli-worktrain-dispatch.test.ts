/**
 * Unit tests for worktrain dispatch command.
 *
 * executeWorktrainDispatchCommand() is tested with injected fakes.
 * No real HTTP, no filesystem access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeWorktrainDispatchCommand,
  type WorktrainDispatchCommandDeps,
  type WorktrainDispatchCommandOpts,
} from '../../src/cli/commands/worktrain-dispatch.js';

// ---------------------------------------------------------------------------
// Fake builder
// ---------------------------------------------------------------------------

interface FakeDispatchDeps extends WorktrainDispatchCommandDeps {
  stdoutLines: string[];
  stderrLines: string[];
  fetchCalls: Array<{ url: string; body: unknown }>;
  files: Map<string, string>;
  nowMs: number;
}

function buildFakeDeps(overrides: Partial<WorktrainDispatchCommandDeps> = {}): FakeDispatchDeps {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  const files = new Map<string, string>();
  let nowMs = 1_000_000;

  const deps: FakeDispatchDeps = {
    stdoutLines,
    stderrLines,
    fetchCalls,
    files,
    get nowMs() { return nowMs; },
    fetch: async (url, opts) => {
      let body: unknown;
      try { body = JSON.parse(opts.body); } catch { body = opts.body; }
      fetchCalls.push({ url, body });
      // Default: success response with a session handle
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { sessionHandle: 'sess_test_abc123' } }),
      };
    },
    readFile: async (p: string) => files.get(p) ?? null,
    stdout: (line: string) => { stdoutLines.push(line); },
    stderr: (line: string) => { stderrLines.push(line); },
    homedir: () => '/fake/home',
    joinPath: (...parts: string[]) => parts.join('/'),
    pathIsAbsolute: (p: string) => p.startsWith('/'),
    statPath: async (_p: string) => ({ isDirectory: () => true }),
    sleep: async (_ms: number) => {},
    now: () => nowMs,
    ...overrides,
  };
  return deps;
}

const BASE_OPTS: WorktrainDispatchCommandOpts = {
  task: 'Fix the login bug',
  workspace: '/fake/project',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeWorktrainDispatchCommand', () => {
  describe('basic dispatch', () => {
    it('posts to daemon dispatch endpoint and prints session ID to stdout', async () => {
      const deps = buildFakeDeps();
      const result = await executeWorktrainDispatchCommand(deps, BASE_OPTS);

      expect(result.kind).toBe('success');
      expect(deps.fetchCalls.length).toBe(1);
      expect(deps.fetchCalls[0]!.url).toContain('/api/v2/auto/dispatch');
      expect(deps.stdoutLines).toEqual(['sess_test_abc123']);
    });

    it('sends goal and workspacePath in POST body', async () => {
      const deps = buildFakeDeps();
      await executeWorktrainDispatchCommand(deps, BASE_OPTS);

      const body = deps.fetchCalls[0]!.body as Record<string, unknown>;
      expect(body['goal']).toBe('Fix the login bug');
      expect(body['workspacePath']).toBe('/fake/project');
    });

    it('includes workflowId in body when --workflow is provided', async () => {
      const deps = buildFakeDeps();
      await executeWorktrainDispatchCommand(deps, { ...BASE_OPTS, workflow: 'wr.coding-task' });

      const body = deps.fetchCalls[0]!.body as Record<string, unknown>;
      expect(body['workflowId']).toBe('wr.coding-task');
    });

    it('routes to wr.mr-review when --pr is provided', async () => {
      const deps = buildFakeDeps();
      await executeWorktrainDispatchCommand(deps, { ...BASE_OPTS, pr: 42 });

      const body = deps.fetchCalls[0]!.body as Record<string, unknown>;
      expect(body['workflowId']).toBe('wr.mr-review');
      expect(body['goal']).toBe('Review PR #42');
    });

    it('returns failure when daemon is not running (ECONNREFUSED)', async () => {
      const deps = buildFakeDeps({
        fetch: async () => { throw new Error('fetch failed: ECONNREFUSED'); },
      });
      const result = await executeWorktrainDispatchCommand(deps, BASE_OPTS);
      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(result.output.message).toContain('Daemon is not running');
        expect(result.output.message).toContain('worktrain daemon start');
      }
    });

    it('returns misuse when --workspace is not provided', async () => {
      const deps = buildFakeDeps();
      const result = await executeWorktrainDispatchCommand(deps, { ...BASE_OPTS, workspace: '' });
      expect(result.kind).toBe('failure');
    });

    it('returns misuse when no task, --workflow, or --pr provided', async () => {
      const deps = buildFakeDeps();
      const result = await executeWorktrainDispatchCommand(deps, { workspace: '/fake/project' });
      expect(result.kind).toBe('failure');
    });
  });

  describe('--json flag', () => {
    it('outputs JSON to stdout when --json is set', async () => {
      const deps = buildFakeDeps();
      await executeWorktrainDispatchCommand(deps, { ...BASE_OPTS, json: true });

      expect(deps.stdoutLines.length).toBe(1);
      const parsed = JSON.parse(deps.stdoutLines[0]!);
      expect(parsed).toEqual({ sessionId: 'sess_test_abc123' });
    });
  });

  describe('--wait flag', () => {
    it('polls for success outcome and exits 0', async () => {
      const events = [
        JSON.stringify({ kind: 'session_completed', sessionId: 'sess_test_abc123', outcome: 'success', ts: 1000 }),
      ].join('\n');

      const deps = buildFakeDeps();
      deps.files.set('/fake/home/.workrail/events/daemon/' + new Date().toISOString().slice(0, 10) + '.jsonl', events);

      const result = await executeWorktrainDispatchCommand(deps, { ...BASE_OPTS, wait: true, timeoutMs: 60_000 });
      expect(result.kind).toBe('success');
    });

    it('polls for failure outcome and exits 1', async () => {
      const events = [
        JSON.stringify({ kind: 'session_completed', sessionId: 'sess_test_abc123', outcome: 'error', ts: 1000 }),
      ].join('\n');

      const deps = buildFakeDeps();
      deps.files.set('/fake/home/.workrail/events/daemon/' + new Date().toISOString().slice(0, 10) + '.jsonl', events);

      const result = await executeWorktrainDispatchCommand(deps, { ...BASE_OPTS, wait: true, timeoutMs: 60_000 });
      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(result.output.message).not.toContain('__exit2__');
      }
    });

    it('returns __exit2__ sentinel when timeout expires before terminal event', async () => {
      // No event file -- session never completes.
      // Use a now() that advances each call to simulate time passing.
      let callCount = 0;
      const nowValues = [1_000_000, 1_000_000, 1_001_000]; // third call is after deadline
      const deps = buildFakeDeps({
        now: () => nowValues[Math.min(callCount++, nowValues.length - 1)] ?? 1_002_000,
      });
      const result = await executeWorktrainDispatchCommand(deps, {
        ...BASE_OPTS,
        wait: true,
        timeoutMs: 500, // deadline = first_now + 500 = 1_000_500
      });
      expect(result.kind).toBe('failure');
      if (result.kind === 'failure') {
        expect(result.output.message).toContain('__exit2__');
      }
    });

    it('outputs JSON with outcome when --wait --json', async () => {
      const events = [
        JSON.stringify({ kind: 'session_completed', sessionId: 'sess_test_abc123', outcome: 'success', ts: 1000 }),
      ].join('\n');

      const deps = buildFakeDeps();
      deps.files.set('/fake/home/.workrail/events/daemon/' + new Date().toISOString().slice(0, 10) + '.jsonl', events);

      await executeWorktrainDispatchCommand(deps, { ...BASE_OPTS, wait: true, json: true, timeoutMs: 60_000 });

      expect(deps.stdoutLines.length).toBe(1);
      const parsed = JSON.parse(deps.stdoutLines[0]!);
      expect(parsed['sessionId']).toBe('sess_test_abc123');
      expect(parsed['outcome']).toBe('success');
    });
  });
});
