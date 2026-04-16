/**
 * Unit tests for executeWorktrainTellCommand
 *
 * Uses fake deps (in-memory file system state).
 * No vi.mock() -- follows repo pattern of "prefer fakes over mocks".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  executeWorktrainTellCommand,
  type WorktrainTellCommandDeps,
  type WorktrainTellCommandOpts,
  type Priority,
} from '../../src/cli/commands/worktrain-tell.js';

// ═══════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════

interface FakeFsState {
  files: Map<string, string>;
  dirs: Set<string>;
}

function makeTestDeps(
  fsState: FakeFsState,
  overrides: Partial<WorktrainTellCommandDeps> = {},
): WorktrainTellCommandDeps {
  return {
    appendFile: async (filePath: string, content: string): Promise<void> => {
      const existing = fsState.files.get(filePath) ?? '';
      fsState.files.set(filePath, existing + content);
    },
    mkdir: async (dirPath: string): Promise<string | undefined> => {
      fsState.dirs.add(dirPath);
      return undefined;
    },
    homedir: () => '/home/testuser',
    joinPath: path.join,
    print: () => undefined,
    now: () => '2026-04-15T00:00:00.000Z',
    generateId: () => 'test-uuid-1234',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('executeWorktrainTellCommand', () => {
  let fsState: FakeFsState;

  beforeEach(() => {
    fsState = {
      files: new Map(),
      dirs: new Set(),
    };
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it('appends a valid JSONL line to message-queue.jsonl', async () => {
    const deps = makeTestDeps(fsState);
    const result = await executeWorktrainTellCommand('hello daemon', deps);

    expect(result.kind).toBe('success');

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const content = fsState.files.get(queuePath);
    expect(content).toBeDefined();

    const parsed = JSON.parse(content!.trim());
    expect(parsed.message).toBe('hello daemon');
    expect(parsed.id).toBe('test-uuid-1234');
    expect(parsed.timestamp).toBe('2026-04-15T00:00:00.000Z');
    expect(parsed.priority).toBe('normal');
    expect(parsed.workspaceHint).toBeUndefined();
  });

  it('appends a newline after the JSON line', async () => {
    const deps = makeTestDeps(fsState);
    await executeWorktrainTellCommand('hello', deps);

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const content = fsState.files.get(queuePath)!;
    expect(content.endsWith('\n')).toBe(true);
  });

  it('creates ~/.workrail/ directory before appending', async () => {
    const deps = makeTestDeps(fsState);
    await executeWorktrainTellCommand('hello', deps);

    const workrailDir = path.join('/home/testuser', '.workrail');
    expect(fsState.dirs.has(workrailDir)).toBe(true);
  });

  it('prints confirmation message', async () => {
    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    await executeWorktrainTellCommand('hello', deps);

    expect(printed.some((line) => line.includes('Message queued'))).toBe(true);
    expect(printed.some((line) => line.includes('normal'))).toBe(true);
  });

  // ── Priority flag ────────────────────────────────────────────────────────

  it('default priority is "normal"', async () => {
    const deps = makeTestDeps(fsState);
    await executeWorktrainTellCommand('hello', deps, {});

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const parsed = JSON.parse(fsState.files.get(queuePath)!.trim());
    expect(parsed.priority).toBe('normal');
  });

  it('sets priority to "high" when specified', async () => {
    const deps = makeTestDeps(fsState);
    await executeWorktrainTellCommand('urgent task', deps, { priority: 'high' });

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const parsed = JSON.parse(fsState.files.get(queuePath)!.trim());
    expect(parsed.priority).toBe('high');
  });

  it('sets priority to "low" when specified', async () => {
    const deps = makeTestDeps(fsState);
    await executeWorktrainTellCommand('low priority task', deps, { priority: 'low' });

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const parsed = JSON.parse(fsState.files.get(queuePath)!.trim());
    expect(parsed.priority).toBe('low');
  });

  it('prints priority in confirmation message', async () => {
    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    await executeWorktrainTellCommand('hello', deps, { priority: 'high' });

    expect(printed.some((line) => line.includes('high'))).toBe(true);
  });

  // ── Workspace flag ───────────────────────────────────────────────────────

  it('includes workspaceHint when --workspace is set', async () => {
    const deps = makeTestDeps(fsState);
    await executeWorktrainTellCommand('hello', deps, { workspace: 'my-project' });

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const parsed = JSON.parse(fsState.files.get(queuePath)!.trim());
    expect(parsed.workspaceHint).toBe('my-project');
  });

  it('omits workspaceHint when --workspace is not set', async () => {
    const deps = makeTestDeps(fsState);
    await executeWorktrainTellCommand('hello', deps, {});

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const parsed = JSON.parse(fsState.files.get(queuePath)!.trim());
    expect('workspaceHint' in parsed).toBe(false);
  });

  // ── Multiple messages ────────────────────────────────────────────────────

  it('appends multiple messages as separate JSONL lines', async () => {
    const deps = makeTestDeps(fsState);
    await executeWorktrainTellCommand('first message', deps);
    await executeWorktrainTellCommand('second message', deps);

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const content = fsState.files.get(queuePath)!;
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.message).toBe('first message');
    expect(second.message).toBe('second message');
  });

  // ── Input validation ─────────────────────────────────────────────────────

  it('returns misuse for empty message', async () => {
    const deps = makeTestDeps(fsState);
    const result = await executeWorktrainTellCommand('', deps);

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.exitCode.kind).toBe('misuse');
    }
  });

  it('returns misuse for whitespace-only message', async () => {
    const deps = makeTestDeps(fsState);
    const result = await executeWorktrainTellCommand('   ', deps);

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.exitCode.kind).toBe('misuse');
    }
  });

  it('trims whitespace from message text', async () => {
    const deps = makeTestDeps(fsState);
    await executeWorktrainTellCommand('  trimmed  ', deps);

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const parsed = JSON.parse(fsState.files.get(queuePath)!.trim());
    expect(parsed.message).toBe('trimmed');
  });

  // ── I/O errors ───────────────────────────────────────────────────────────

  it('returns failure when appendFile throws', async () => {
    const deps = makeTestDeps(fsState, {
      appendFile: async () => {
        throw new Error('disk full');
      },
    });
    const result = await executeWorktrainTellCommand('hello', deps);

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('disk full');
    }
  });

  it('returns failure when mkdir throws', async () => {
    const deps = makeTestDeps(fsState, {
      mkdir: async () => {
        throw new Error('permission denied');
      },
    });
    const result = await executeWorktrainTellCommand('hello', deps);

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.output.message).toContain('permission denied');
    }
  });

  // ── Message schema ───────────────────────────────────────────────────────

  it('message JSON contains all required fields', async () => {
    const deps = makeTestDeps(fsState);
    await executeWorktrainTellCommand('test message', deps, {
      workspace: 'ws',
      priority: 'high',
    });

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const parsed = JSON.parse(fsState.files.get(queuePath)!.trim());
    expect(parsed).toHaveProperty('id');
    expect(parsed).toHaveProperty('message');
    expect(parsed).toHaveProperty('timestamp');
    expect(parsed).toHaveProperty('priority');
    expect(parsed).toHaveProperty('workspaceHint');
  });

  it('uses injected generateId and now', async () => {
    let idCalled = false;
    let nowCalled = false;

    const deps = makeTestDeps(fsState, {
      generateId: () => { idCalled = true; return 'custom-id'; },
      now: () => { nowCalled = true; return '2099-01-01T00:00:00.000Z'; },
    });
    await executeWorktrainTellCommand('test', deps);

    expect(idCalled).toBe(true);
    expect(nowCalled).toBe(true);

    const queuePath = path.join('/home/testuser', '.workrail', 'message-queue.jsonl');
    const parsed = JSON.parse(fsState.files.get(queuePath)!.trim());
    expect(parsed.id).toBe('custom-id');
    expect(parsed.timestamp).toBe('2099-01-01T00:00:00.000Z');
  });
});
