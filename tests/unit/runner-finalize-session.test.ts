/**
 * Unit tests for runner/finalize-session.ts
 *
 * Focuses on: correct cleanup for each result variant, DaemonRegistry
 * unregister semantics, sidecar deletion, and conversation file lifecycle.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpPath } from '../helpers/platform.js';
import { finalizeSession } from '../../src/daemon/runner/finalize-session.js';
import { tagToStatsOutcome } from '../../src/daemon/core/session-result.js';
import type { FinalizationContext } from '../../src/daemon/runner/runner-types.js';
import type { WorkflowRunResult } from '../../src/daemon/types.js';
import type { DaemonEventEmitter } from '../../src/daemon/daemon-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-finalize-test-'));
});

afterEach(async () => {
  // writeExecutionStats is fire-and-forget and chains writeStatsSummary.
  // Poll for stats-summary.json to confirm the write chain completed before cleanup.
  const summaryPath = path.join(tmpDir, 'stats-summary.json');
  for (let i = 0; i < 50; i++) {
    try { await fs.access(summaryPath); break; } catch { await new Promise<void>((r) => setTimeout(r, 10)); }
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<FinalizationContext> = {}): FinalizationContext {
  return {
    sessionId: 'sess-local-001',
    workrailSessionId: 'sess_wr001',
    startMs: Date.now() - 1000,
    stepAdvanceCount: 3,
    branchStrategy: 'none',
    statsDir: tmpDir,
    sessionsDir: tmpDir,
    conversationPath: path.join(tmpDir, 'sess-local-001-conversation.jsonl'),
    emitter: undefined,
    daemonRegistry: undefined,
    workflowId: 'wr.test',
    ...overrides,
  };
}

function makeSidecar(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.json`);
}

async function writeSidecar(p: string): Promise<void> {
  await fs.writeFile(p, JSON.stringify({ continueToken: 'ct_test', ts: Date.now() }), 'utf8');
}

async function writeConversation(p: string): Promise<void> {
  await fs.writeFile(p, '{"role":"user"}\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Tests: success + none strategy -- sidecar deleted, conversation deleted
// ---------------------------------------------------------------------------

describe('finalizeSession -- success / none branch strategy', () => {
  it('deletes sidecar on success with none strategy', async () => {
    const ctx = makeCtx();
    const sidecarPath = makeSidecar(tmpDir, 'sess-local-001');
    await writeSidecar(sidecarPath);

    const result: WorkflowRunResult = { _tag: 'success', workflowId: 'wr.test', stopReason: 'stop' };
    await finalizeSession(result, ctx);

    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });

  it('deletes conversation file on success with none strategy', async () => {
    const ctx = makeCtx();
    const convPath = ctx.conversationPath;
    await writeConversation(convPath);

    const result: WorkflowRunResult = { _tag: 'success', workflowId: 'wr.test', stopReason: 'stop' };
    await finalizeSession(result, ctx);

    await expect(fs.access(convPath)).rejects.toThrow();
  });

  it('writes execution-stats.jsonl entry', async () => {
    const ctx = makeCtx();
    const result: WorkflowRunResult = { _tag: 'success', workflowId: 'wr.test', stopReason: 'stop' };
    await finalizeSession(result, ctx);

    // stats file is written fire-and-forget; poll briefly
    await new Promise((r) => setTimeout(r, 50));
    const statsPath = path.join(tmpDir, 'execution-stats.jsonl');
    const content = await fs.readFile(statsPath, 'utf8').catch(() => '');
    expect(content).toContain('"outcome":"success"');
    expect(content).toContain('"workflowId":"wr.test"');
  });
});

// ---------------------------------------------------------------------------
// Tests: success + worktree -- sidecar RETAINED, conversation RETAINED
// ---------------------------------------------------------------------------

describe('finalizeSession -- success / worktree branch strategy', () => {
  it('retains sidecar on success with worktree strategy (delivery will delete it)', async () => {
    const ctx = makeCtx({ branchStrategy: 'worktree' });
    const sidecarPath = makeSidecar(tmpDir, 'sess-local-001');
    await writeSidecar(sidecarPath);

    const result: WorkflowRunResult = { _tag: 'success', workflowId: 'wr.test', stopReason: 'stop' };
    await finalizeSession(result, ctx);

    // Sidecar must still exist
    await expect(fs.access(sidecarPath)).resolves.toBeUndefined();
  });

  it('retains conversation file on success with worktree strategy', async () => {
    const ctx = makeCtx({ branchStrategy: 'worktree' });
    const convPath = ctx.conversationPath;
    await writeConversation(convPath);

    const result: WorkflowRunResult = { _tag: 'success', workflowId: 'wr.test', stopReason: 'stop' };
    await finalizeSession(result, ctx);

    await expect(fs.access(convPath)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: error / timeout / stuck -- sidecar deleted, conversation retained
// ---------------------------------------------------------------------------

describe('finalizeSession -- error/timeout/stuck', () => {
  it('deletes sidecar on error', async () => {
    const ctx = makeCtx();
    const sidecarPath = makeSidecar(tmpDir, 'sess-local-001');
    await writeSidecar(sidecarPath);

    const result: WorkflowRunResult = { _tag: 'error', workflowId: 'wr.test', message: 'agent error', stopReason: 'error' };
    await finalizeSession(result, ctx);

    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });

  it('deletes sidecar on timeout', async () => {
    const ctx = makeCtx();
    const sidecarPath = makeSidecar(tmpDir, 'sess-local-001');
    await writeSidecar(sidecarPath);

    const result: WorkflowRunResult = { _tag: 'timeout', workflowId: 'wr.test', reason: 'wall_clock', message: 'timed out', stopReason: 'aborted' };
    await finalizeSession(result, ctx);

    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });

  it('deletes sidecar on stuck', async () => {
    const ctx = makeCtx();
    const sidecarPath = makeSidecar(tmpDir, 'sess-local-001');
    await writeSidecar(sidecarPath);

    const result: WorkflowRunResult = { _tag: 'stuck', workflowId: 'wr.test', reason: 'repeated_tool_call', message: 'stuck', stopReason: 'aborted' };
    await finalizeSession(result, ctx);

    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });

  it('retains conversation file on error (useful for debugging)', async () => {
    const ctx = makeCtx();
    const convPath = ctx.conversationPath;
    await writeConversation(convPath);

    const result: WorkflowRunResult = { _tag: 'error', workflowId: 'wr.test', message: 'agent error', stopReason: 'error' };
    await finalizeSession(result, ctx);

    await expect(fs.access(convPath)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: DaemonRegistry unregister semantics
// ---------------------------------------------------------------------------

describe('finalizeSession -- DaemonRegistry unregister', () => {
  it('calls daemonRegistry.unregister with completed on success', async () => {
    const unregister = vi.fn();
    const ctx = makeCtx({ daemonRegistry: { unregister } as unknown as FinalizationContext['daemonRegistry'] });

    const result: WorkflowRunResult = { _tag: 'success', workflowId: 'wr.test', stopReason: 'stop' };
    await finalizeSession(result, ctx);

    expect(unregister).toHaveBeenCalledWith('sess_wr001', 'completed');
  });

  it('calls daemonRegistry.unregister with failed on error', async () => {
    const unregister = vi.fn();
    const ctx = makeCtx({ daemonRegistry: { unregister } as unknown as FinalizationContext['daemonRegistry'] });

    const result: WorkflowRunResult = { _tag: 'error', workflowId: 'wr.test', message: 'oops', stopReason: 'error' };
    await finalizeSession(result, ctx);

    expect(unregister).toHaveBeenCalledWith('sess_wr001', 'failed');
  });

  it('does not call unregister when workrailSessionId is null', async () => {
    const unregister = vi.fn();
    const ctx = makeCtx({
      workrailSessionId: null,
      daemonRegistry: { unregister } as unknown as FinalizationContext['daemonRegistry'],
    });

    const result: WorkflowRunResult = { _tag: 'success', workflowId: 'wr.test', stopReason: 'stop' };
    await finalizeSession(result, ctx);

    expect(unregister).not.toHaveBeenCalled();
  });

  it('works safely when daemonRegistry is undefined', async () => {
    const ctx = makeCtx({ daemonRegistry: undefined });
    const result: WorkflowRunResult = { _tag: 'success', workflowId: 'wr.test', stopReason: 'stop' };
    await expect(finalizeSession(result, ctx)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: event emission
// ---------------------------------------------------------------------------

describe('finalizeSession -- session_completed event', () => {
  it('emits session_completed with correct outcome for each result tag', async () => {
    const results: Array<[WorkflowRunResult, string]> = [
      [{ _tag: 'success', workflowId: 'wr.t', stopReason: 'stop' }, 'success'],
      [{ _tag: 'error', workflowId: 'wr.t', message: 'err', stopReason: 'error' }, 'error'],
      [{ _tag: 'timeout', workflowId: 'wr.t', reason: 'wall_clock', message: 'timed out', stopReason: 'aborted' }, 'timeout'],
      [{ _tag: 'stuck', workflowId: 'wr.t', reason: 'repeated_tool_call', message: 'stuck', stopReason: 'aborted' }, 'stuck'],
    ];

    for (const [result, expectedOutcome] of results) {
      const emittedEvents: unknown[] = [];
      const ctx = makeCtx({
        emitter: { emit: (e: unknown) => emittedEvents.push(e) } as unknown as DaemonEventEmitter,
      });

      await finalizeSession(result, ctx);

      const evt = emittedEvents.find(
        (e): e is { kind: string; outcome: string } =>
          typeof e === 'object' && e !== null && (e as { kind?: string }).kind === 'session_completed',
      );
      expect(evt?.outcome).toBe(expectedOutcome);
    }
  });

  it('delivery_failed event outcome is success per tagToStatsOutcome (workflow succeeded)', () => {
    // WHY: finalizeSession is never called with delivery_failed (invariant 1.2 -- runWorkflow
    // never produces it; only TriggerRouter does after delivery). We test the outcome mapping
    // via tagToStatsOutcome directly rather than via finalizeSession.
    expect(tagToStatsOutcome('delivery_failed')).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// Tests: no-op safety when sidecar / conversation don't exist
// ---------------------------------------------------------------------------

describe('finalizeSession -- missing files', () => {
  it('does not throw when sidecar does not exist', async () => {
    const ctx = makeCtx(); // sidecar never created
    const result: WorkflowRunResult = { _tag: 'success', workflowId: 'wr.test', stopReason: 'stop' };
    await expect(finalizeSession(result, ctx)).resolves.toBeUndefined();
  });

  it('does not throw when conversation file does not exist', async () => {
    const ctx = makeCtx(); // conversation never created
    const result: WorkflowRunResult = { _tag: 'success', workflowId: 'wr.test', stopReason: 'stop' };
    await expect(finalizeSession(result, ctx)).resolves.toBeUndefined();
  });
});
