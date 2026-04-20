/**
 * Unit tests for executeWorktrainTriggerPollCommand
 *
 * Uses fake deps (in-memory, no real I/O). No vi.mock() -- follows repo pattern
 * of "prefer fakes over mocks".
 *
 * Test cases:
 * 1. Success: cycleRan=true -> prints cycle started message, exits 0
 * 2. Success: cycleRan=false -> prints cycle skipped message, exits 0
 * 3. HTTP 400 (trigger not found) -> prints error, exits 1
 * 4. HTTP 400 (wrong provider) -> prints error, exits 1
 * 5. ECONNREFUSED -> prints daemon not running error, exits 1
 */

import { describe, it, expect } from 'vitest';
import {
  executeWorktrainTriggerPollCommand,
  type WorktrainTriggerPollDeps,
} from '../../src/cli/commands/worktrain-trigger-poll.js';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function makeBaseDeps(overrides: Partial<WorktrainTriggerPollDeps> = {}): {
  deps: WorktrainTriggerPollDeps;
  printLines: string[];
  stderrLines: string[];
} {
  const printLines: string[] = [];
  const stderrLines: string[] = [];

  const deps: WorktrainTriggerPollDeps = {
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { triggerId: 'self-improvement', cycleRan: true, message: 'Poll cycle started.' },
      }),
    }),
    readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    print: (line) => printLines.push(line),
    stderr: (line) => stderrLines.push(line),
    homedir: () => '/home/test',
    joinPath: (...parts) => parts.join('/'),
    ...overrides,
  };

  return { deps, printLines, stderrLines };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('executeWorktrainTriggerPollCommand', () => {
  it('prints cycle started message and exits 0 when cycleRan=true', async () => {
    const { deps, printLines } = makeBaseDeps({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { triggerId: 'self-improvement', cycleRan: true, message: "Poll cycle started for trigger 'self-improvement'." },
        }),
      }),
    });

    const result = await executeWorktrainTriggerPollCommand(deps, { triggerId: 'self-improvement' });

    expect(result.kind).toBe('success');
    expect(printLines).toContain('[Poll] Forcing immediate poll cycle for trigger: self-improvement');
    expect(printLines.some((l) => l.includes('Poll cycle started'))).toBe(true);
    expect(printLines).toContain('[Poll] Done.');
  });

  it('prints cycle skipped message and exits 0 when cycleRan=false', async () => {
    const { deps, printLines } = makeBaseDeps({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            triggerId: 'self-improvement',
            cycleRan: false,
            message: "Poll cycle skipped for trigger 'self-improvement' -- a previous cycle is still running.",
          },
        }),
      }),
    });

    const result = await executeWorktrainTriggerPollCommand(deps, { triggerId: 'self-improvement' });

    expect(result.kind).toBe('success');
    expect(printLines.some((l) => l.includes('skipped'))).toBe(true);
    expect(printLines).toContain('[Poll] Done.');
  });

  it('prints error and exits 1 when HTTP 400 (trigger not found)', async () => {
    const { deps, stderrLines } = makeBaseDeps({
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ success: false, error: "Trigger 'unknown-trigger' not found" }),
      }),
    });

    const result = await executeWorktrainTriggerPollCommand(deps, { triggerId: 'unknown-trigger' });

    expect(result.kind).toBe('failure');
    expect(stderrLines.some((l) => l.includes('not found'))).toBe(true);
  });

  it('prints error and exits 1 when HTTP 400 (wrong provider)', async () => {
    const { deps, stderrLines } = makeBaseDeps({
      fetch: async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          success: false,
          error: "Trigger 'my-webhook' is not a queue poll trigger (provider: generic)",
        }),
      }),
    });

    const result = await executeWorktrainTriggerPollCommand(deps, { triggerId: 'my-webhook' });

    expect(result.kind).toBe('failure');
    expect(stderrLines.some((l) => l.includes('queue poll trigger'))).toBe(true);
  });

  it('prints daemon not running error and exits 1 when ECONNREFUSED', async () => {
    const { deps, stderrLines } = makeBaseDeps({
      fetch: async () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:3200');
        throw err;
      },
    });

    const result = await executeWorktrainTriggerPollCommand(deps, { triggerId: 'self-improvement', port: 3200 });

    expect(result.kind).toBe('failure');
    expect(stderrLines.some((l) => l.includes('Could not connect to WorkTrain daemon'))).toBe(true);
  });

  it('uses daemon-console.lock port when lock file is present', async () => {
    let capturedUrl = '';
    const { deps } = makeBaseDeps({
      readFile: async (p) => {
        if (p.includes('daemon-console.lock')) {
          return JSON.stringify({ pid: 1234, port: 3456 });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      fetch: async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { triggerId: 'self-improvement', cycleRan: true, message: 'Done.' },
          }),
        };
      },
    });

    await executeWorktrainTriggerPollCommand(deps, { triggerId: 'self-improvement' });

    expect(capturedUrl).toContain('3456');
  });

  it('defaults to port 3200 when no lock file and no --port', async () => {
    let capturedUrl = '';
    const { deps } = makeBaseDeps({
      fetch: async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { triggerId: 'self-improvement', cycleRan: true, message: 'Done.' },
          }),
        };
      },
    });

    await executeWorktrainTriggerPollCommand(deps, { triggerId: 'self-improvement' });

    expect(capturedUrl).toContain('3200');
  });

  it('uses --port override when provided', async () => {
    let capturedUrl = '';
    const { deps } = makeBaseDeps({
      fetch: async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { triggerId: 'self-improvement', cycleRan: true, message: 'Done.' },
          }),
        };
      },
    });

    await executeWorktrainTriggerPollCommand(deps, { triggerId: 'self-improvement', port: 9999 });

    expect(capturedUrl).toContain('9999');
  });
});
