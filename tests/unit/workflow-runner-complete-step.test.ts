/**
 * Unit tests for makeCompleteStepTool().
 *
 * Verifies that:
 * - Happy-path advance returns { status: 'advanced', nextStep: ... }
 * - Workflow complete returns { status: 'complete' }
 * - Blocked retryable response calls onTokenUpdate and says 'call complete_step again'
 * - Blocked non-retryable response says 'cannot proceed without resolving'
 * - Notes shorter than 50 chars cause the tool to throw
 * - Notes absent cause the tool to throw
 * - Artifacts are forwarded to executeContinueWorkflow
 * - Empty artifacts array does NOT construct a spurious output.artifacts
 * - continueToken is NOT included in response text (regression guard)
 * - getCurrentToken() is called to inject the token (not a hardcoded value)
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
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { okAsync, errAsync } from 'neverthrow';
import type { V2ToolContext } from '../../src/mcp/types.js';
import { makeCompleteStepTool } from '../../src/daemon/workflow-runner.js';
import { DAEMON_SESSIONS_DIR } from '../../src/daemon/workflow-runner.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal ok response for a successful advance with a next step. */
function makeOkResponse(overrides: { isComplete?: boolean; continueToken?: string } = {}) {
  const nextToken = overrides.continueToken ?? 'ct_nexttoken12345678901234567890';
  return {
    kind: 'ok' as const,
    continueToken: nextToken,
    checkpointToken: undefined,
    isComplete: overrides.isComplete ?? false,
    pending: overrides.isComplete ? null : {
      stepId: 'step-2',
      title: 'Step 2: Do More Work',
      prompt: 'Do the second piece of work now.',
    },
    preferences: {
      autonomy: 'full_auto_never_stop' as const,
      riskPolicy: 'balanced' as const,
    },
    nextIntent: 'perform_pending_then_continue' as const,
    nextCall: {
      tool: 'complete_step' as const,
      params: { continueToken: nextToken },
    },
  };
}

/** Minimal blocked response (retryable by default). */
function makeBlockedResponse(overrides: {
  retryable?: boolean;
  retryToken?: string;
} = {}) {
  const retryToken = overrides.retryToken ?? 'ct_retrytoken12345678901234567';
  return {
    kind: 'blocked' as const,
    continueToken: 'ct_sessiontoken123456789012345',
    checkpointToken: undefined,
    isComplete: false,
    pending: {
      stepId: 'step-1',
      title: 'Step 1',
      prompt: 'Do the work.',
    },
    preferences: {
      autonomy: 'full_auto_never_stop' as const,
      riskPolicy: 'balanced' as const,
    },
    nextIntent: 'perform_pending_then_continue' as const,
    nextCall: {
      tool: 'continue_workflow' as const,
      params: { continueToken: retryToken },
    },
    blockers: {
      blockers: [
        {
          code: 'MISSING_REQUIRED_NOTES' as const,
          pointer: { kind: 'workflow_step' as const, stepId: 'step-1' },
          message: 'Notes are required for this step.',
          suggestedFix: 'Include output.notesMarkdown with at least 10 lines.',
        },
      ],
    },
    retryable: overrides.retryable ?? true,
    retryContinueToken: retryToken,
    validation: {
      issues: ['Notes are missing or too short'],
      suggestions: ['Add at least 10 lines to notes'],
    },
    assessmentFollowup: undefined,
  };
}

/**
 * Fake executeContinueWorkflow that captures input for inspection.
 *
 * WHY a mutable container object: destructuring `captured` from the returned
 * object would snapshot its value at destructure time (null). Using a container
 * object lets tests read `container.captured` after the async call completes
 * and see the updated value.
 */
function makeFakeCapturingExec(responseFactory: () => ReturnType<typeof makeOkResponse> | ReturnType<typeof makeBlockedResponse> = makeOkResponse): {
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
      return okAsync({ response: responseFactory() as any });
    },
  };
}

/** Fake that returns a blocked response. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeBlockedExec(blocked: ReturnType<typeof makeBlockedResponse>): (input: any, _ctx: any) => ReturnType<typeof okAsync> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (_input: any, _ctx: any) => okAsync({ response: blocked as any });
}

/** Null V2ToolContext -- not used by the fake. */
const NULL_CTX = {} as unknown as V2ToolContext;

/** Stub schemas -- CompleteStepParams not needed in tests (tool uses inputSchema from getSchemas). */
const STUB_SCHEMAS = { CompleteStepParams: {} };

/** Notes that satisfy the 50-char minimum. */
const VALID_NOTES = 'I reviewed the code and found the relevant module. Everything is in order.';

/** A sample wr.assessment artifact. */
const SAMPLE_ASSESSMENT = {
  kind: 'wr.assessment',
  assessmentId: 'some-gate',
  dimensions: { some_dimension: 'high' },
};

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeCompleteStepTool()', () => {

  describe('TC1: happy-path advance', () => {
    it('returns { status: advanced, nextStep } and calls onAdvance', async () => {
      const sessionId = makeSessionId();
      let advancedWith: { stepText: string; continueToken: string } | null = null;
      const { fake } = makeFakeCapturingExec(() => makeOkResponse({ continueToken: 'ct_nexttoken12345678901234567890' }));

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => 'ct_current12345678901234567890',
        (stepText, continueToken) => { advancedWith = { stepText, continueToken }; },
        () => {},
        () => {},
        STUB_SCHEMAS,
        fake,
      );

      const result = await tool.execute('call-1', { notes: VALID_NOTES });

      expect(result.content[0].text).toContain('"status":"advanced"');
      expect(result.content[0].text).toContain('Step 2: Do More Work');
      expect(advancedWith).not.toBeNull();
      expect(advancedWith!.continueToken).toBe('ct_nexttoken12345678901234567890');
    });
  });

  describe('TC2: workflow complete', () => {
    it('returns { status: complete } and calls onComplete with notes', async () => {
      const sessionId = makeSessionId();
      let completedWith: string | undefined = undefined;
      const { fake } = makeFakeCapturingExec(() => makeOkResponse({ isComplete: true }));

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => 'ct_current12345678901234567890',
        () => {},
        (notes) => { completedWith = notes; },
        () => {},
        STUB_SCHEMAS,
        fake,
      );

      const result = await tool.execute('call-1', { notes: VALID_NOTES });

      expect(result.content[0].text).toBe(JSON.stringify({ status: 'complete' }));
      expect(completedWith).toBe(VALID_NOTES);
    });
  });

  describe('TC3: blocked retryable', () => {
    it('calls onTokenUpdate with retry token and says call complete_step again', async () => {
      const sessionId = makeSessionId();
      let tokenUpdatedTo: string | null = null;
      const blocked = makeBlockedResponse({ retryable: true, retryToken: 'ct_retrytoken1234567890' });

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => 'ct_current12345678901234567890',
        () => {},
        () => {},
        (t) => { tokenUpdatedTo = t; },
        STUB_SCHEMAS,
        makeFakeBlockedExec(blocked),
      );

      const result = await tool.execute('call-1', { notes: VALID_NOTES });

      expect(tokenUpdatedTo).toBe('ct_retrytoken1234567890');
      expect(result.content[0].text).toContain('call complete_step again');
      expect(result.content[0].text).not.toContain('continue_workflow');
    });
  });

  describe('TC4: blocked non-retryable', () => {
    it('says cannot proceed without resolving', async () => {
      const sessionId = makeSessionId();
      const blocked = makeBlockedResponse({ retryable: false });

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => 'ct_current12345678901234567890',
        () => {},
        () => {},
        () => {},
        STUB_SCHEMAS,
        makeFakeBlockedExec(blocked),
      );

      const result = await tool.execute('call-1', { notes: VALID_NOTES });

      expect(result.content[0].text).toContain('cannot proceed without resolving');
    });
  });

  describe('TC5: notes too short (< 50 chars)', () => {
    it('throws with a descriptive error', async () => {
      const sessionId = makeSessionId();
      const { fake } = makeFakeCapturingExec();

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => 'ct_current12345678901234567890',
        () => {},
        () => {},
        () => {},
        STUB_SCHEMAS,
        fake,
      );

      await expect(
        tool.execute('call-1', { notes: 'Too short' })
      ).rejects.toThrow(/at least 50 characters/);
    });
  });

  describe('TC6: notes absent', () => {
    it('throws with a descriptive error', async () => {
      const sessionId = makeSessionId();
      const { fake } = makeFakeCapturingExec();

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => 'ct_current12345678901234567890',
        () => {},
        () => {},
        () => {},
        STUB_SCHEMAS,
        fake,
      );

      await expect(
        tool.execute('call-1', {})
      ).rejects.toThrow(/notes is required/);
    });
  });

  describe('TC7: artifacts pass-through', () => {
    it('forwards artifacts to executeContinueWorkflow', async () => {
      const sessionId = makeSessionId();
      const { container, fake } = makeFakeCapturingExec();

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => 'ct_current12345678901234567890',
        () => {},
        () => {},
        () => {},
        STUB_SCHEMAS,
        fake,
      );

      await tool.execute('call-1', {
        notes: VALID_NOTES,
        artifacts: [SAMPLE_ASSESSMENT],
      });

      expect(container.captured?.output?.artifacts).toEqual([SAMPLE_ASSESSMENT]);
      expect(container.captured?.output?.notesMarkdown).toBe(VALID_NOTES);
    });
  });

  describe('TC8: empty artifacts array', () => {
    it('does NOT include artifacts in output when array is empty', async () => {
      const sessionId = makeSessionId();
      const { container, fake } = makeFakeCapturingExec();

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => 'ct_current12345678901234567890',
        () => {},
        () => {},
        () => {},
        STUB_SCHEMAS,
        fake,
      );

      await tool.execute('call-1', {
        notes: VALID_NOTES,
        artifacts: [],
      });

      // Empty artifacts array: output is constructed only because notes is present.
      // artifacts should not be present in the output object.
      expect(container.captured?.output?.artifacts).toBeUndefined();
      expect(container.captured?.output?.notesMarkdown).toBe(VALID_NOTES);
    });
  });

  describe('TC9: continueToken NOT in response text (regression guard)', () => {
    it('advance response does not include continueToken string', async () => {
      const sessionId = makeSessionId();
      const injectedToken = 'ct_current12345678901234567890';
      const { fake } = makeFakeCapturingExec(() => makeOkResponse({ continueToken: 'ct_nexttoken12345678901234567890' }));

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => injectedToken,
        () => {},
        () => {},
        () => {},
        STUB_SCHEMAS,
        fake,
      );

      const result = await tool.execute('call-1', { notes: VALID_NOTES });

      // The LLM must never see the continueToken in tool responses.
      expect(result.content[0].text).not.toContain(injectedToken);
      expect(result.content[0].text).not.toContain('ct_nexttoken12345678901234567890');
      expect(result.content[0].text).not.toContain('continueToken');
    });
  });

  describe('TC10: getCurrentToken() is called at execution time', () => {
    it('injects the token from getCurrentToken, not a stale value', async () => {
      const sessionId = makeSessionId();
      let tokenUsedByEngine: string | undefined;

      // The token changes between calls (simulating onAdvance updating currentContinueToken).
      let currentToken = 'ct_token_first_call_1234567890';
      const { fake } = makeFakeCapturingExec(() => {
        // Capture the token that was passed to executeContinueWorkflow.
        return makeOkResponse({ continueToken: 'ct_nexttoken12345678901234567890' });
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const capturingFake = (input: any, ctx: any) => {
        tokenUsedByEngine = input.continueToken;
        return fake(input, ctx);
      };

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => currentToken,
        () => {},
        () => {},
        () => {},
        STUB_SCHEMAS,
        capturingFake,
      );

      // First call with initial token
      await tool.execute('call-1', { notes: VALID_NOTES });
      expect(tokenUsedByEngine).toBe('ct_token_first_call_1234567890');

      // Simulate onAdvance updating the closure variable
      currentToken = 'ct_token_second_call_234567890';
      await tool.execute('call-2', { notes: VALID_NOTES });
      expect(tokenUsedByEngine).toBe('ct_token_second_call_234567890');
    });
  });

  describe('TC11: executeContinueWorkflow error propagates', () => {
    it('throws when executeContinueWorkflow returns an error', async () => {
      const sessionId = makeSessionId();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorFake = (_input: any, _ctx: any) =>
        errAsync({ kind: 'validation_failed' as const, failure: { code: 'TOKEN_BAD_SIGNATURE', message: 'bad sig' } as any });

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => 'ct_current12345678901234567890',
        () => {},
        () => {},
        () => {},
        STUB_SCHEMAS,
        errorFake,
      );

      await expect(
        tool.execute('call-1', { notes: VALID_NOTES })
      ).rejects.toThrow(/complete_step failed/);
    });
  });

  describe('TC12: onComplete receives artifacts alongside notes', () => {
    it('forwards artifacts array to onComplete when workflow is complete', async () => {
      const sessionId = makeSessionId();
      let completedNotes: string | undefined;
      let completedArtifacts: readonly unknown[] | undefined;

      const { fake } = makeFakeCapturingExec(() => makeOkResponse({ isComplete: true }));

      const tool = makeCompleteStepTool(
        sessionId,
        NULL_CTX,
        () => 'ct_current12345678901234567890',
        () => {},
        (notes, artifacts) => {
          completedNotes = notes;
          completedArtifacts = artifacts;
        },
        () => {},
        STUB_SCHEMAS,
        fake,
      );

      const result = await tool.execute('call-1', {
        notes: VALID_NOTES,
        artifacts: [SAMPLE_ASSESSMENT],
      });

      expect(result.content[0].text).toBe(JSON.stringify({ status: 'complete' }));
      // Both notes and artifacts must be forwarded to onComplete for coordinator consumption.
      // See docs/discovery/artifacts-coordinator-channel.md for why both fields are needed.
      expect(completedNotes).toBe(VALID_NOTES);
      expect(completedArtifacts).toEqual([SAMPLE_ASSESSMENT]);
    });
  });
});
