/**
 * Unit tests for executeWorktrainInboxCommand
 *
 * Uses fake deps (in-memory file system state).
 * No vi.mock() -- follows repo pattern of "prefer fakes over mocks".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  executeWorktrainInboxCommand,
  type WorktrainInboxCommandDeps,
  type OutboxMessage,
} from '../../src/cli/commands/worktrain-inbox.js';

// ═══════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════════════════

interface FakeFsState {
  files: Map<string, string>;
}

function makeTestDeps(
  fsState: FakeFsState,
  overrides: Partial<WorktrainInboxCommandDeps> = {},
): WorktrainInboxCommandDeps {
  return {
    readFile: async (filePath: string): Promise<string> => {
      const content = fsState.files.get(filePath);
      if (content === undefined) {
        const err = Object.assign(new Error(`ENOENT: no such file or directory: ${filePath}`), {
          code: 'ENOENT',
        });
        throw err;
      }
      return content;
    },
    writeFile: async (filePath: string, content: string): Promise<void> => {
      fsState.files.set(filePath, content);
    },
    mkdir: async (): Promise<string | undefined> => {
      return undefined;
    },
    homedir: () => '/home/testuser',
    joinPath: path.join,
    print: () => undefined,
    ...overrides,
  };
}

function makeOutboxLine(msg: Partial<OutboxMessage> = {}): string {
  const entry: OutboxMessage = {
    id: msg.id ?? 'msg-id-1',
    message: msg.message ?? 'Hello from daemon',
    timestamp: msg.timestamp ?? '2026-04-15T00:00:00.000Z',
  };
  return JSON.stringify(entry);
}

function makeOutbox(messages: Array<Partial<OutboxMessage>>): string {
  return messages.map(makeOutboxLine).join('\n') + '\n';
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('executeWorktrainInboxCommand', () => {
  let fsState: FakeFsState;

  const outboxPath = path.join('/home/testuser', '.workrail', 'outbox.jsonl');
  const cursorPath = path.join('/home/testuser', '.workrail', 'inbox-cursor.json');

  beforeEach(() => {
    fsState = { files: new Map() };
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it('shows unread messages and returns success', async () => {
    fsState.files.set(outboxPath, makeOutbox([
      { message: 'Task completed' },
      { message: 'PR opened' },
    ]));

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    const result = await executeWorktrainInboxCommand(deps);

    expect(result.kind).toBe('success');
    expect(printed.some((line) => line.includes('Task completed'))).toBe(true);
    expect(printed.some((line) => line.includes('PR opened'))).toBe(true);
  });

  it('prints message count summary', async () => {
    fsState.files.set(outboxPath, makeOutbox([
      { message: 'msg 1' },
      { message: 'msg 2' },
    ]));

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    await executeWorktrainInboxCommand(deps);

    expect(printed.some((line) => line.includes('2 new message'))).toBe(true);
  });

  it('prints timestamp in message line', async () => {
    fsState.files.set(outboxPath, makeOutbox([
      { message: 'test', timestamp: '2026-04-15T12:30:00.000Z' },
    ]));

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    await executeWorktrainInboxCommand(deps);

    expect(printed.some((line) => line.includes('2026-04-15T12:30:00.000Z'))).toBe(true);
    expect(printed.some((line) => line.includes('test'))).toBe(true);
  });

  it('writes updated cursor after showing messages', async () => {
    fsState.files.set(outboxPath, makeOutbox([
      { message: 'msg 1' },
      { message: 'msg 2' },
    ]));

    const deps = makeTestDeps(fsState);
    await executeWorktrainInboxCommand(deps);

    const cursorContent = fsState.files.get(cursorPath);
    expect(cursorContent).toBeDefined();
    const cursor = JSON.parse(cursorContent!) as { lastReadCount: number };
    expect(cursor.lastReadCount).toBe(2);
  });

  // ── Missing outbox ───────────────────────────────────────────────────────

  it('prints "No messages" when outbox does not exist', async () => {
    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    const result = await executeWorktrainInboxCommand(deps);

    expect(result.kind).toBe('success');
    expect(printed.some((line) => line.includes('No messages'))).toBe(true);
  });

  // ── Cursor behavior ──────────────────────────────────────────────────────

  it('shows only unread messages (lines after cursor)', async () => {
    fsState.files.set(outboxPath, makeOutbox([
      { message: 'old message' },
      { message: 'new message' },
    ]));
    // Set cursor to have already read first message
    fsState.files.set(cursorPath, JSON.stringify({ lastReadCount: 1 }));

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    await executeWorktrainInboxCommand(deps);

    expect(printed.some((line) => line.includes('new message'))).toBe(true);
    expect(printed.some((line) => line.includes('old message'))).toBe(false);
  });

  it('shows 0 new messages when all are already read', async () => {
    fsState.files.set(outboxPath, makeOutbox([
      { message: 'already read' },
    ]));
    fsState.files.set(cursorPath, JSON.stringify({ lastReadCount: 1 }));

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    const result = await executeWorktrainInboxCommand(deps);

    expect(result.kind).toBe('success');
    expect(printed.some((line) => line.includes('No new messages'))).toBe(true);
  });

  it('shows all messages when cursor file is absent', async () => {
    fsState.files.set(outboxPath, makeOutbox([
      { message: 'msg 1' },
      { message: 'msg 2' },
    ]));
    // No cursor file

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    await executeWorktrainInboxCommand(deps);

    expect(printed.some((line) => line.includes('msg 1'))).toBe(true);
    expect(printed.some((line) => line.includes('msg 2'))).toBe(true);
    expect(printed.some((line) => line.includes('2 new message'))).toBe(true);
  });

  it('treats corrupted cursor JSON as 0 (show all)', async () => {
    fsState.files.set(outboxPath, makeOutbox([{ message: 'test' }]));
    fsState.files.set(cursorPath, 'NOT VALID JSON{{{');

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    const result = await executeWorktrainInboxCommand(deps);

    expect(result.kind).toBe('success');
    expect(printed.some((line) => line.includes('test'))).toBe(true);
  });

  // ── Cursor desync ────────────────────────────────────────────────────────

  it('resets cursor to 0 when cursor >= totalLines (outbox truncated)', async () => {
    fsState.files.set(outboxPath, makeOutbox([
      { message: 'new message after truncation' },
    ]));
    // Cursor says 50 messages read, but only 1 exists now
    fsState.files.set(cursorPath, JSON.stringify({ lastReadCount: 50 }));

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    const result = await executeWorktrainInboxCommand(deps);

    expect(result.kind).toBe('success');
    expect(printed.some((line) => line.includes('new message after truncation'))).toBe(true);
  });

  it('does NOT reset cursor when cursor < totalLines', async () => {
    fsState.files.set(outboxPath, makeOutbox([
      { message: 'read' },
      { message: 'unread' },
    ]));
    fsState.files.set(cursorPath, JSON.stringify({ lastReadCount: 1 }));

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    await executeWorktrainInboxCommand(deps);

    // Should only show 'unread', not 'read'
    expect(printed.some((line) => line.includes('unread'))).toBe(true);
    expect(printed.some((line) => line.includes('read') && !line.includes('unread'))).toBe(false);
  });

  // ── Malformed lines ──────────────────────────────────────────────────────

  it('skips malformed JSON lines and shows warning', async () => {
    const validLine = makeOutboxLine({ message: 'valid' });
    const badLine = 'NOT JSON{{';
    fsState.files.set(outboxPath, validLine + '\n' + badLine + '\n');

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    const result = await executeWorktrainInboxCommand(deps);

    expect(result.kind).toBe('success');
    expect(printed.some((line) => line.includes('valid'))).toBe(true);
    expect(printed.some((line) => line.toLowerCase().includes('malformed'))).toBe(true);
    expect(printed.some((line) => line.includes('1'))).toBe(true);
  });

  it('shows all valid messages even when some lines are malformed', async () => {
    const content = [
      makeOutboxLine({ message: 'good 1' }),
      'BAD LINE',
      makeOutboxLine({ message: 'good 2' }),
    ].join('\n') + '\n';
    fsState.files.set(outboxPath, content);

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    await executeWorktrainInboxCommand(deps);

    expect(printed.some((line) => line.includes('good 1'))).toBe(true);
    expect(printed.some((line) => line.includes('good 2'))).toBe(true);
  });

  // ── --watch flag ─────────────────────────────────────────────────────────

  it('--watch prints stub message and returns success', async () => {
    const printed: string[] = [];
    const deps = makeTestDeps(fsState, { print: (line) => printed.push(line) });
    const result = await executeWorktrainInboxCommand(deps, { watch: true });

    expect(result.kind).toBe('success');
    expect(printed.some((line) => line.toLowerCase().includes('not yet implemented'))).toBe(true);
  });

  it('--watch does not read outbox or write cursor', async () => {
    fsState.files.set(outboxPath, makeOutbox([{ message: 'test' }]));

    const deps = makeTestDeps(fsState);
    await executeWorktrainInboxCommand(deps, { watch: true });

    // Cursor should not have been written
    expect(fsState.files.has(cursorPath)).toBe(false);
  });

  // ── Cursor write failure (non-fatal) ─────────────────────────────────────

  it('returns success even if cursor write fails', async () => {
    fsState.files.set(outboxPath, makeOutbox([{ message: 'test' }]));

    const printed: string[] = [];
    const deps = makeTestDeps(fsState, {
      writeFile: async () => {
        throw new Error('disk full');
      },
      print: (line) => printed.push(line),
    });
    const result = await executeWorktrainInboxCommand(deps);

    expect(result.kind).toBe('success');
    expect(printed.some((line) => line.includes('test'))).toBe(true);
    // Should print warning about cursor failure
    expect(printed.some((line) => line.toLowerCase().includes('cursor') || line.toLowerCase().includes('warning'))).toBe(true);
  });

  // ── Cursor is written at end ─────────────────────────────────────────────

  it('cursor advances by the number of new messages shown', async () => {
    fsState.files.set(outboxPath, makeOutbox([
      { message: 'a' },
      { message: 'b' },
      { message: 'c' },
    ]));
    // Already read 1
    fsState.files.set(cursorPath, JSON.stringify({ lastReadCount: 1 }));

    const deps = makeTestDeps(fsState);
    await executeWorktrainInboxCommand(deps);

    const cursor = JSON.parse(fsState.files.get(cursorPath)!) as { lastReadCount: number };
    // Total lines = 3, so cursor should now be 3
    expect(cursor.lastReadCount).toBe(3);
  });
});
