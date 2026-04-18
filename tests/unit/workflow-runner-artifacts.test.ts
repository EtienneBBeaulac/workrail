/**
 * Unit tests for artifacts pass-through in makeContinueWorkflowTool().
 *
 * Verifies that:
 * - artifacts are forwarded to executeContinueWorkflow when present
 * - artifacts-only case (no notesMarkdown) constructs output correctly
 * - empty artifacts array does NOT construct output
 * - both artifacts and notesMarkdown present are both forwarded
 * - neither present -> output is undefined (regression guard)
 *
 * WHY fake injection over mocking: follows the "prefer fakes over mocks"
 * principle from CLAUDE.md. The optional `_executeContinueWorkflowFn`
 * parameter accepts a real fake, keeping tests deterministic and realistic.
 *
 * Note: persistTokens() writes to ~/.workrail/daemon-sessions/<sessionId>.json.
 * Each test uses a unique UUID session ID so files never collide. Files are
 * cleaned up in afterEach.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { okAsync } from 'neverthrow';
import type { V2ToolContext } from '../../src/mcp/types.js';
import { makeContinueWorkflowTool } from '../../src/daemon/workflow-runner.js';
import { DAEMON_SESSIONS_DIR } from '../../src/daemon/workflow-runner.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal ok response for a successful advance. */
function makeOkResponse() {
  return {
    kind: 'ok' as const,
    continueToken: 'ct_nexttoken12345678901234567890',
    checkpointToken: undefined,
    isComplete: false,
    pending: {
      stepId: 'step-2',
      title: 'Step 2',
      prompt: 'Do the next work.',
    },
    preferences: {
      autonomy: 'full_auto_never_stop' as const,
      riskPolicy: 'balanced' as const,
    },
    nextIntent: 'perform_pending_then_continue' as const,
    nextCall: {
      tool: 'continue_workflow' as const,
      params: { continueToken: 'ct_nexttoken12345678901234567890' },
    },
  };
}

/**
 * Fake executeContinueWorkflow that captures the input for inspection and
 * returns a successful ok response.
 *
 * WHY a mutable container object: destructuring `captured` from the returned
 * object would snapshot its value at destructure time (null). Using a container
 * object lets tests read `container.captured` after the async call completes
 * and see the updated value.
 */
function makeFakeCapturingExec(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  container: { captured: any | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fake: (input: any, _ctx: any) => ReturnType<typeof okAsync>;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const container: { captured: any | null } = { captured: null };
  return {
    container,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fake: (input: any, _ctx: any) => {
      container.captured = input;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return okAsync({ response: makeOkResponse() as any });
    },
  };
}

/** Null V2ToolContext -- not used by the fake. */
const NULL_CTX = {} as unknown as V2ToolContext;

/** Stub schemas -- ContinueWorkflowParams not used in tests. */
const STUB_SCHEMAS = { ContinueWorkflowParams: {} };

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const sessionIdsToClean: string[] = [];

afterEach(async () => {
  for (const sessionId of sessionIdsToClean) {
    const filePath = path.join(DAEMON_SESSIONS_DIR, `${sessionId}.json`);
    await fs.unlink(filePath).catch(() => { /* ignore if not created */ });
  }
  sessionIdsToClean.length = 0;
});

function makeSessionId(): string {
  const id = randomUUID();
  sessionIdsToClean.push(id);
  return id;
}

/** A sample wr.assessment artifact. */
const SAMPLE_ASSESSMENT = {
  kind: 'wr.assessment',
  assessmentId: 'some-gate',
  dimensions: { some_dimension: 'high' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeContinueWorkflowTool() -- artifacts pass-through', () => {
  describe('TC1: artifacts present, notesMarkdown absent', () => {
    it('forwards artifacts in output.artifacts and omits notesMarkdown', async () => {
      const sessionId = makeSessionId();
      const { container, fake } = makeFakeCapturingExec();
      const tool = makeContinueWorkflowTool(
        sessionId, NULL_CTX, () => {}, () => {}, STUB_SCHEMAS, fake,
      );

      await tool.execute('call-1', {
        continueToken: 'ct_agenttoken12345678901234567',
        artifacts: [SAMPLE_ASSESSMENT],
      });

      expect(container.captured?.output).toBeDefined();
      expect(container.captured?.output?.artifacts).toEqual([SAMPLE_ASSESSMENT]);
      expect(container.captured?.output?.notesMarkdown).toBeUndefined();
    });
  });

  describe('TC2: empty artifacts array', () => {
    it('does NOT construct output when artifacts is empty and notesMarkdown is absent', async () => {
      const sessionId = makeSessionId();
      const { container, fake } = makeFakeCapturingExec();
      const tool = makeContinueWorkflowTool(
        sessionId, NULL_CTX, () => {}, () => {}, STUB_SCHEMAS, fake,
      );

      await tool.execute('call-1', {
        continueToken: 'ct_agenttoken12345678901234567',
        artifacts: [],
      });

      expect(container.captured?.output).toBeUndefined();
    });
  });

  describe('TC3: both artifacts and notesMarkdown present', () => {
    it('forwards both notesMarkdown and artifacts in output', async () => {
      const sessionId = makeSessionId();
      const { container, fake } = makeFakeCapturingExec();
      const tool = makeContinueWorkflowTool(
        sessionId, NULL_CTX, () => {}, () => {}, STUB_SCHEMAS, fake,
      );

      await tool.execute('call-1', {
        continueToken: 'ct_agenttoken12345678901234567',
        notesMarkdown: 'My detailed notes',
        artifacts: [SAMPLE_ASSESSMENT],
      });

      expect(container.captured?.output?.notesMarkdown).toBe('My detailed notes');
      expect(container.captured?.output?.artifacts).toEqual([SAMPLE_ASSESSMENT]);
    });
  });

  describe('TC4: neither artifacts nor notesMarkdown present (regression guard)', () => {
    it('passes output as undefined when neither artifacts nor notesMarkdown are present', async () => {
      const sessionId = makeSessionId();
      const { container, fake } = makeFakeCapturingExec();
      const tool = makeContinueWorkflowTool(
        sessionId, NULL_CTX, () => {}, () => {}, STUB_SCHEMAS, fake,
      );

      await tool.execute('call-1', {
        continueToken: 'ct_agenttoken12345678901234567',
      });

      expect(container.captured?.output).toBeUndefined();
    });
  });
});
