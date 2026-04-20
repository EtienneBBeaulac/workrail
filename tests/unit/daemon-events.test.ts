/**
 * Tests for src/daemon/daemon-events.ts
 *
 * Covers:
 * - Events written to a temp directory (not ~/.workrail)
 * - Each event appends a valid JSON line with ts and kind
 * - Daily rotation: different date strings produce different files
 * - Errors are swallowed: fs failures do not propagate from emit()
 * - Directory is created lazily on first write
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonEventEmitter } from '../../src/daemon/daemon-events.js';
import type { DaemonEvent } from '../../src/daemon/daemon-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory for each test. */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-daemon-events-test-'));
}

/**
 * Read all JSONL lines from a file, parsed as objects.
 * Returns an empty array if the file does not exist.
 */
async function readJsonlLines(filePath: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Wait for all pending async I/O to flush. */
async function flushAsync(): Promise<void> {
  // emit() fires a detached Promise. The underlying fs.appendFile is async I/O.
  // We poll until the file appears or a reasonable number of ticks pass.
  // Using multiple setTimeout(0) + setImmediate rounds ensures both microtasks
  // and I/O callbacks complete before we inspect the result.
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DaemonEventEmitter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    // Clean up temp dir after each test.
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates the daily JSONL file and writes a valid JSON line', async () => {
    const emitter = new DaemonEventEmitter(tmpDir);

    emitter.emit({ kind: 'daemon_started', port: 3200, workspacePath: '/workspace' });

    await flushAsync();

    const files = await fs.readdir(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const lines = await readJsonlLines(path.join(tmpDir, files[0]!));
    expect(lines).toHaveLength(1);

    const line = lines[0]!;
    expect(typeof line['ts']).toBe('number');
    expect(line['kind']).toBe('daemon_started');
    expect(line['port']).toBe(3200);
    expect(line['workspacePath']).toBe('/workspace');
  });

  it('appends multiple events as separate lines', async () => {
    const emitter = new DaemonEventEmitter(tmpDir);

    emitter.emit({ kind: 'trigger_fired', triggerId: 'trig-1', workflowId: 'wf-1' });
    emitter.emit({ kind: 'session_queued', triggerId: 'trig-1', workflowId: 'wf-1' });
    emitter.emit({ kind: 'session_started', sessionId: 'sess-1', workflowId: 'wf-1', workspacePath: '/ws' });

    await flushAsync();

    const files = await fs.readdir(tmpDir);
    const lines = await readJsonlLines(path.join(tmpDir, files[0]!));
    expect(lines).toHaveLength(3);
    // Ordering is not guaranteed for concurrent fire-and-forget appends.
    // Verify all 3 kinds are present.
    const kinds = lines.map((l) => l['kind']);
    expect(kinds).toContain('trigger_fired');
    expect(kinds).toContain('session_queued');
    expect(kinds).toContain('session_started');
  });

  it('creates directory lazily on first write', async () => {
    // Use a nested path that does not exist yet.
    const nestedDir = path.join(tmpDir, 'sub', 'dir');
    const emitter = new DaemonEventEmitter(nestedDir);

    emitter.emit({ kind: 'step_advanced', sessionId: 'sess-1' });
    await flushAsync();

    const files = await fs.readdir(nestedDir);
    expect(files).toHaveLength(1);
  });

  it('daily rotation: different date strings produce different files', async () => {
    const emitter = new DaemonEventEmitter(tmpDir);

    // Spy on Date.prototype.toISOString to return two different dates.
    const originalToISOString = Date.prototype.toISOString;

    // First emit on "day 1"
    Date.prototype.toISOString = () => '2026-01-01T12:00:00.000Z';
    emitter.emit({ kind: 'tool_called', sessionId: 's1', toolName: 'Bash' });
    await flushAsync();

    // Second emit on "day 2"
    Date.prototype.toISOString = () => '2026-01-02T12:00:00.000Z';
    emitter.emit({ kind: 'tool_called', sessionId: 's1', toolName: 'Read' });
    await flushAsync();

    // Restore original
    Date.prototype.toISOString = originalToISOString;

    const files = (await fs.readdir(tmpDir)).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toBe('2026-01-01.jsonl');
    expect(files[1]).toBe('2026-01-02.jsonl');
  });

  it('swallows errors when appendFile throws -- emit() returns void without throwing', async () => {
    // Use a path that is actually a file (not a directory) so mkdir/appendFile will fail.
    const blockingFile = path.join(tmpDir, 'blocker');
    await fs.writeFile(blockingFile, 'occupied', 'utf8');

    // The emitter's dir is the path of a regular file -- appendFile will fail.
    const emitter = new DaemonEventEmitter(blockingFile);

    // Must not throw synchronously or asynchronously.
    expect(() => {
      emitter.emit({ kind: 'session_completed', sessionId: 's1', workflowId: 'wf-1', outcome: 'error' });
    }).not.toThrow();

    // Wait for the detached Promise to settle (error swallowed).
    await flushAsync();

    // No crash, no unhandled rejection -- test passes.
  });

  it('each event kind has the correct discriminant field', async () => {
    const emitter = new DaemonEventEmitter(tmpDir);

    const events: DaemonEvent[] = [
      { kind: 'daemon_started', port: 3200, workspacePath: '/ws' },
      // Daemon lifecycle events.
      { kind: 'daemon_stopped', reason: 'graceful', ts: Date.now() },
      { kind: 'daemon_heartbeat', activeSessions: 2, ts: Date.now() },
      { kind: 'trigger_fired', triggerId: 't1', workflowId: 'w1' },
      { kind: 'session_queued', triggerId: 't1', workflowId: 'w1' },
      { kind: 'session_started', sessionId: 's1', workflowId: 'w1', workspacePath: '/ws' },
      { kind: 'tool_called', sessionId: 's1', toolName: 'Bash' },
      { kind: 'tool_error', sessionId: 's1', toolName: 'Bash', error: 'fail' },
      { kind: 'step_advanced', sessionId: 's1' },
      { kind: 'session_completed', sessionId: 's1', workflowId: 'w1', outcome: 'success' },
      { kind: 'delivery_attempted', callbackUrl: 'https://example.com', outcome: 'success' },
      { kind: 'issue_reported', sessionId: 's1', issueKind: 'tool_failure', severity: 'warn', summary: 'test' },
      // New conversation logging events (Slice 1).
      { kind: 'llm_turn_started', sessionId: 's1', messageCount: 3 },
      { kind: 'llm_turn_completed', sessionId: 's1', stopReason: 'tool_use', outputTokens: 150, inputTokens: 1200, toolNamesRequested: ['Bash'] },
      { kind: 'tool_call_started', sessionId: 's1', toolName: 'Bash', argsSummary: '{"command":"git status"}' },
      { kind: 'tool_call_completed', sessionId: 's1', toolName: 'Bash', durationMs: 45, resultSummary: 'On branch main' },
      { kind: 'tool_call_failed', sessionId: 's1', toolName: 'Bash', durationMs: 12, errorMessage: 'Command failed' },
      // Stuck detection event.
      { kind: 'agent_stuck', sessionId: 's1', reason: 'repeated_tool_call', detail: 'Same tool+args 3 times', toolName: 'Bash', argsSummary: '{"command":"npm test"}' },
      // Session aborted by daemon shutdown.
      { kind: 'session_aborted', sessionId: 'sess_abc123', workrailSessionId: 'sess_abc123', reason: 'daemon_shutdown', ts: Date.now() },
    ];

    for (const event of events) {
      emitter.emit(event);
    }
    await flushAsync();

    const files = await fs.readdir(tmpDir);
    const lines = await readJsonlLines(path.join(tmpDir, files[0]!));
    expect(lines).toHaveLength(events.length);

    // Ordering is not guaranteed for concurrent fire-and-forget appends.
    // Verify all event kinds are present and each line has a numeric ts.
    const kinds = lines.map((l) => l['kind']);
    for (const event of events) {
      expect(kinds).toContain(event.kind);
    }
    for (const line of lines) {
      expect(typeof line['ts']).toBe('number');
    }
  });
});
