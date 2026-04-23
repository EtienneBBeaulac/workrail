/**
 * Unit tests for loadSessionNotes() in workflow-runner.ts.
 *
 * Covers all four failure paths and the happy path, per Issue #393.
 *
 * loadSessionNotes() is a best-effort helper: every failure path returns []
 * and emits a console.warn -- it never throws. This is the core invariant.
 *
 * ## Failure paths tested
 *
 * 1. parseContinueTokenOrFail returns isErr() → warn + []
 * 2. ctx.v2.sessionStore.load() returns isErr() → warn + []
 * 3. projectNodeOutputsV2() returns isErr() → warn + []
 * 4. Unexpected exception thrown inside the try block → warn + []
 *
 * ## Happy path tested
 *
 * 5. Notes are collected, truncated at MAX_SESSION_NOTE_CHARS, and sliced
 *    to the last MAX_SESSION_RECAP_NOTES (3) in event order.
 *
 * ## Strategy: vi.mock for module-level dependencies
 *
 * loadSessionNotes() calls parseContinueTokenOrFail, ctx.v2.sessionStore.load,
 * and projectNodeOutputsV2 via module-level imports -- none are injected via
 * parameters. vi.mock is the only way to stub these without refactoring production
 * code, following the same approach as workflow-runner-spawn-agent.test.ts.
 *
 * ctx.v2.sessionStore.load is stubbed via a minimal fake V2ToolContext whose
 * sessionStore.load is a vi.fn(). This avoids touching the real session store.
 *
 * WHY parseContinueTokenOrFail and projectNodeOutputsV2 are module-mocked but
 * sessionStore.load is a fake: parseContinueTokenOrFail and projectNodeOutputsV2
 * are free functions imported at the top of workflow-runner.ts and cannot be
 * passed in. sessionStore.load is accessed via ctx.v2.sessionStore, which IS
 * a parameter -- so a fake is the right tool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errAsync, okAsync } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { V2ToolContext } from '../../src/mcp/types.js';

// ── Hoisted mock variables ────────────────────────────────────────────────────
//
// vi.mock calls are hoisted above all imports by vitest's transformer. Any variable
// referenced inside a vi.mock factory must also be hoisted via vi.hoisted().

const { mockParseContinueToken, mockProjectNodeOutputs } = vi.hoisted(() => ({
  mockParseContinueToken: vi.fn(),
  mockProjectNodeOutputs: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/mcp/handlers/v2-token-ops.js', () => ({
  parseContinueTokenOrFail: mockParseContinueToken,
}));

vi.mock('../../src/v2/projections/node-outputs.js', () => ({
  projectNodeOutputsV2: mockProjectNodeOutputs,
}));

// Import AFTER mocks are registered so the mocked modules are in scope.
import { loadSessionNotes } from '../../src/daemon/workflow-runner.js';

// ── Constants (must match workflow-runner.ts to catch drift) ──────────────────

const MAX_SESSION_RECAP_NOTES = 3;
const MAX_SESSION_NOTE_CHARS = 800;

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Minimal fake V2ToolContext for loadSessionNotes.
 *
 * loadSessionNotes only accesses:
 *   ctx.v2.tokenCodecPorts   -- passed to parseContinueTokenOrFail (mocked)
 *   ctx.v2.tokenAliasStore   -- passed to parseContinueTokenOrFail (mocked)
 *   ctx.v2.sessionStore.load -- called with sessionId
 *
 * The fake only needs to provide a load stub on sessionStore.
 * tokenCodecPorts and tokenAliasStore are passed through to the mock,
 * so any value works -- the mock ignores them.
 */
function makeFakeCtx(loadFn: ReturnType<typeof vi.fn>): V2ToolContext {
  return {
    v2: {
      tokenCodecPorts: {} as V2ToolContext['v2']['tokenCodecPorts'],
      tokenAliasStore: {} as V2ToolContext['v2']['tokenAliasStore'],
      sessionStore: {
        load: loadFn,
      } as unknown as V2ToolContext['v2']['sessionStore'],
    },
  } as unknown as V2ToolContext;
}

/**
 * A fake resolved continue token value -- returned by mockParseContinueToken
 * on the happy path. loadSessionNotes reads only the sessionId field.
 */
const FAKE_RESOLVED_TOKEN = {
  sessionId: 'sess_abc123',
  runId: 'run_abc',
  nodeId: 'node_abc',
  attemptId: 'att_abc',
  workflowHashRef: 'wfhash_abc',
};

/**
 * Build a fake LoadedSessionTruthV2 with no node_output_appended events.
 * loadSessionNotes reads only the `events` array.
 */
function makeEmptyLoadedSession() {
  return {
    manifest: [],
    events: [],
  };
}

/**
 * Build a fake NodeOutputsProjectionV2 with the given notes under a single node.
 *
 * loadSessionNotes iterates `Object.values(result.nodesById)`, then reads
 * `.currentByChannel.recap` and checks `output.payload.payloadKind === 'notes'`.
 */
function makeProjectionWithNotes(notes: string[]) {
  return {
    nodesById: {
      'node-1': {
        currentByChannel: {
          recap: notes.map((notesMarkdown, i) => ({
            outputId: `out-${i}`,
            outputChannel: 'recap',
            payload: { payloadKind: 'notes', notesMarkdown },
            createdAtEventIndex: i,
          })),
          artifact: [],
        },
        historyByChannel: { recap: [], artifact: [] },
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('loadSessionNotes()', () => {
  const FAKE_TOKEN = 'ct_fake_continue_token';

  beforeEach(() => {
    mockParseContinueToken.mockReset();
    mockProjectNodeOutputs.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // ── Failure path 1: parseContinueTokenOrFail returns isErr() ─────────────

  it('returns [] when token decode fails (does not throw)', async () => {
    mockParseContinueToken.mockReturnValue(
      errAsync({
        kind: 'not_retryable' as const,
        code: 'TOKEN_INVALID_FORMAT',
        message: 'Expected a continue token (ct_...).',
      }),
    );

    const loadFn = vi.fn();
    const ctx = makeFakeCtx(loadFn);

    const result = await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(result).toEqual([]);
    // Must not proceed to sessionStore.load when token decode fails
    expect(loadFn).not.toHaveBeenCalled();
  });

  it('emits a console.warn when token decode fails', async () => {
    mockParseContinueToken.mockReturnValue(
      errAsync({
        kind: 'not_retryable' as const,
        code: 'TOKEN_INVALID_FORMAT',
        message: 'bad token',
      }),
    );

    const ctx = makeFakeCtx(vi.fn());
    await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[WorkflowRunner]'),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('bad token'),
    );
  });

  // ── Failure path 2: sessionStore.load returns isErr() ────────────────────

  it('returns [] when session store load fails (does not throw)', async () => {
    mockParseContinueToken.mockReturnValue(okAsync(FAKE_RESOLVED_TOKEN));

    const loadFn = vi.fn().mockResolvedValue({
      isErr: () => true,
      isOk: () => false,
      error: {
        code: 'SESSION_STORE_IO_ERROR',
        message: 'disk read failed',
      },
    });
    const ctx = makeFakeCtx(loadFn);

    const result = await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(result).toEqual([]);
    expect(loadFn).toHaveBeenCalledOnce();
    // Must not proceed to projectNodeOutputsV2 when store load fails
    expect(mockProjectNodeOutputs).not.toHaveBeenCalled();
  });

  it('emits a console.warn when session store load fails', async () => {
    mockParseContinueToken.mockReturnValue(okAsync(FAKE_RESOLVED_TOKEN));

    const loadFn = vi.fn().mockResolvedValue({
      isErr: () => true,
      isOk: () => false,
      error: {
        code: 'SESSION_STORE_IO_ERROR',
        message: 'disk read failed',
      },
    });
    const ctx = makeFakeCtx(loadFn);

    await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[WorkflowRunner]'),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('SESSION_STORE_IO_ERROR'),
    );
  });

  // ── Failure path 3: projectNodeOutputsV2 returns isErr() ─────────────────

  it('returns [] when projection fails (does not throw)', async () => {
    mockParseContinueToken.mockReturnValue(okAsync(FAKE_RESOLVED_TOKEN));

    const loadFn = vi.fn().mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: makeEmptyLoadedSession(),
    });
    const ctx = makeFakeCtx(loadFn);

    mockProjectNodeOutputs.mockReturnValue(
      err({
        code: 'PROJECTION_INVARIANT_VIOLATION',
        message: 'Events must be sorted by eventIndex ascending',
      }),
    );

    const result = await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(result).toEqual([]);
  });

  it('emits a console.warn when projection fails', async () => {
    mockParseContinueToken.mockReturnValue(okAsync(FAKE_RESOLVED_TOKEN));

    const loadFn = vi.fn().mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: makeEmptyLoadedSession(),
    });
    const ctx = makeFakeCtx(loadFn);

    mockProjectNodeOutputs.mockReturnValue(
      err({
        code: 'PROJECTION_INVARIANT_VIOLATION',
        message: 'sort order violated',
      }),
    );

    await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[WorkflowRunner]'),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('PROJECTION_INVARIANT_VIOLATION'),
    );
  });

  // ── Failure path 4: unexpected exception ─────────────────────────────────

  it('returns [] when an unexpected exception is thrown (does not throw)', async () => {
    mockParseContinueToken.mockImplementation(() => {
      throw new Error('unexpected internal error');
    });

    const ctx = makeFakeCtx(vi.fn());

    const result = await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(result).toEqual([]);
  });

  it('emits a console.warn when an unexpected exception is thrown', async () => {
    mockParseContinueToken.mockImplementation(() => {
      throw new Error('boom');
    });

    const ctx = makeFakeCtx(vi.fn());

    await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[WorkflowRunner]'),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('boom'),
    );
  });

  // ── Happy path: notes collected, truncated, and sliced ───────────────────

  it('returns empty array when session has no notes', async () => {
    mockParseContinueToken.mockReturnValue(okAsync(FAKE_RESOLVED_TOKEN));

    const loadFn = vi.fn().mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: makeEmptyLoadedSession(),
    });
    const ctx = makeFakeCtx(loadFn);

    mockProjectNodeOutputs.mockReturnValue(ok({ nodesById: {} }));

    const result = await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(result).toEqual([]);
  });

  it('returns notes from the session in order (up to MAX_SESSION_RECAP_NOTES)', async () => {
    mockParseContinueToken.mockReturnValue(okAsync(FAKE_RESOLVED_TOKEN));

    const loadFn = vi.fn().mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: makeEmptyLoadedSession(),
    });
    const ctx = makeFakeCtx(loadFn);

    const notes = ['note A', 'note B', 'note C'];
    mockProjectNodeOutputs.mockReturnValue(ok(makeProjectionWithNotes(notes)));

    const result = await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(result).toEqual(['note A', 'note B', 'note C']);
  });

  it('slices to the last MAX_SESSION_RECAP_NOTES when more notes exist', async () => {
    mockParseContinueToken.mockReturnValue(okAsync(FAKE_RESOLVED_TOKEN));

    const loadFn = vi.fn().mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: makeEmptyLoadedSession(),
    });
    const ctx = makeFakeCtx(loadFn);

    // 5 notes: only the last MAX_SESSION_RECAP_NOTES (3) should be returned
    const notes = ['note 1', 'note 2', 'note 3', 'note 4', 'note 5'];
    expect(notes.length).toBeGreaterThan(MAX_SESSION_RECAP_NOTES);
    mockProjectNodeOutputs.mockReturnValue(ok(makeProjectionWithNotes(notes)));

    const result = await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(result).toHaveLength(MAX_SESSION_RECAP_NOTES);
    expect(result).toEqual(['note 3', 'note 4', 'note 5']);
  });

  it('truncates notes longer than MAX_SESSION_NOTE_CHARS', async () => {
    mockParseContinueToken.mockReturnValue(okAsync(FAKE_RESOLVED_TOKEN));

    const loadFn = vi.fn().mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: makeEmptyLoadedSession(),
    });
    const ctx = makeFakeCtx(loadFn);

    const longNote = 'x'.repeat(MAX_SESSION_NOTE_CHARS + 50);
    mockProjectNodeOutputs.mockReturnValue(ok(makeProjectionWithNotes([longNote])));

    const result = await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain('[truncated]');
    expect(result[0]!.length).toBeLessThan(longNote.length);
    // The non-truncated portion must be exactly MAX_SESSION_NOTE_CHARS chars
    // followed by '\n[truncated]'
    expect(result[0]).toBe('x'.repeat(MAX_SESSION_NOTE_CHARS) + '\n[truncated]');
  });

  it('does not truncate notes at exactly MAX_SESSION_NOTE_CHARS', async () => {
    mockParseContinueToken.mockReturnValue(okAsync(FAKE_RESOLVED_TOKEN));

    const loadFn = vi.fn().mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: makeEmptyLoadedSession(),
    });
    const ctx = makeFakeCtx(loadFn);

    const exactNote = 'y'.repeat(MAX_SESSION_NOTE_CHARS);
    mockProjectNodeOutputs.mockReturnValue(ok(makeProjectionWithNotes([exactNote])));

    const result = await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(exactNote);
    expect(result[0]).not.toContain('[truncated]');
  });

  it('skips outputs with payloadKind !== notes (e.g. artifact_ref)', async () => {
    mockParseContinueToken.mockReturnValue(okAsync(FAKE_RESOLVED_TOKEN));

    const loadFn = vi.fn().mockResolvedValue({
      isErr: () => false,
      isOk: () => true,
      value: makeEmptyLoadedSession(),
    });
    const ctx = makeFakeCtx(loadFn);

    mockProjectNodeOutputs.mockReturnValue(
      ok({
        nodesById: {
          'node-1': {
            currentByChannel: {
              recap: [
                {
                  outputId: 'out-art',
                  outputChannel: 'recap',
                  payload: {
                    payloadKind: 'artifact_ref',
                    sha256: 'abc123',
                    contentType: 'text/plain',
                    byteLength: 100,
                  },
                  createdAtEventIndex: 0,
                },
                {
                  outputId: 'out-note',
                  outputChannel: 'recap',
                  payload: { payloadKind: 'notes', notesMarkdown: 'real note' },
                  createdAtEventIndex: 1,
                },
              ],
              artifact: [],
            },
            historyByChannel: { recap: [], artifact: [] },
          },
        },
      }),
    );

    const result = await loadSessionNotes(FAKE_TOKEN, ctx);

    expect(result).toEqual(['real note']);
  });
});
