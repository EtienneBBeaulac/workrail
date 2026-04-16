/**
 * Unit tests for blocked-response handling in makeContinueWorkflowTool().
 *
 * Strategy: inject a fake executeContinueWorkflow that returns deterministic
 * blocked responses. Verify that:
 * - Blocked responses return human-readable feedback
 * - onAdvance() is NOT called (step did not advance)
 * - onComplete() is NOT called
 * - Retryable vs non-retryable blocked produce appropriate guidance
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

/** A minimal blocked response with one blocker and validation details. */
function makeBlockedResponse(overrides: {
  retryable?: boolean;
  retryToken?: string;
  validationIssues?: string[];
  validationSuggestions?: string[];
  assessmentFollowup?: { title: string; guidance: string };
} = {}) {
  const retryToken = overrides.retryToken ?? 'ct_retrytoken123456789012345678';
  return {
    kind: 'blocked' as const,
    continueToken: 'ct_sessiontoken1234567890123456',
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
          message: 'Notes are required for this step. Provide substantive notes describing what you did.',
          suggestedFix: 'Include output.notesMarkdown with at least 10 lines describing your work.',
        },
      ],
    },
    retryable: overrides.retryable ?? true,
    retryContinueToken: overrides.retryToken,
    validation: {
      issues: overrides.validationIssues ?? ['Notes are missing or too short'],
      suggestions: overrides.validationSuggestions ?? ['Add at least 10 lines to notesMarkdown'],
    },
    assessmentFollowup: overrides.assessmentFollowup,
  };
}

/** Fake executeContinueWorkflow that returns a blocked response. */
function makeFakeBlockedExec(blockedResponse: ReturnType<typeof makeBlockedResponse>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (_input: any, _ctx: any) => okAsync({ response: blockedResponse as any });
}

/** Null V2ToolContext -- not used by the fake. */
const NULL_CTX = {} as unknown as V2ToolContext;

/** Stub schemas -- ContinueWorkflowParams not used in tests. */
const STUB_SCHEMAS = { ContinueWorkflowParams: {} };

/** Params passed to continue_workflow execute. */
function makeParams(continueToken = 'ct_agenttoken12345678901234567') {
  return {
    continueToken,
    intent: 'advance',
    notesMarkdown: 'My notes',
  };
}

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

describe('makeContinueWorkflowTool() -- blocked response handling', () => {
  describe('feedback content', () => {
    it('returns feedback containing the blocker message when blocked', async () => {
      const sessionId = makeSessionId();
      const blocked = makeBlockedResponse();
      const tool = makeContinueWorkflowTool(
        sessionId,
        NULL_CTX,
        () => { throw new Error('onAdvance must not be called'); },
        () => { throw new Error('onComplete must not be called'); },
        STUB_SCHEMAS,
        makeFakeBlockedExec(blocked),
      );

      const result = await tool.execute('call-1', makeParams());
      const text = (result.content[0] as { type: string; text: string }).text;

      expect(text).toContain('Notes are required for this step');
    });

    it('includes validation issues in feedback', async () => {
      const sessionId = makeSessionId();
      const blocked = makeBlockedResponse({
        validationIssues: ['Custom issue: foo is missing'],
        validationSuggestions: ['Add foo to your output'],
      });
      const tool = makeContinueWorkflowTool(
        sessionId, NULL_CTX, () => {}, () => {}, STUB_SCHEMAS,
        makeFakeBlockedExec(blocked),
      );

      const result = await tool.execute('call-1', makeParams());
      const text = (result.content[0] as { type: string; text: string }).text;

      expect(text).toContain('Custom issue: foo is missing');
      expect(text).toContain('Add foo to your output');
    });

    it('includes assessment followup in feedback when present', async () => {
      const sessionId = makeSessionId();
      const blocked = makeBlockedResponse({
        assessmentFollowup: {
          title: 'Design soundness matched "low"',
          guidance: 'Commit to a design approach before proceeding.',
        },
      });
      const tool = makeContinueWorkflowTool(
        sessionId, NULL_CTX, () => {}, () => {}, STUB_SCHEMAS,
        makeFakeBlockedExec(blocked),
      );

      const result = await tool.execute('call-1', makeParams());
      const text = (result.content[0] as { type: string; text: string }).text;

      expect(text).toContain('Design soundness matched "low"');
      expect(text).toContain('Commit to a design approach before proceeding.');
    });

    it('includes the retry token in feedback', async () => {
      const sessionId = makeSessionId();
      const retryToken = 'ct_retrytoken123456789012345678';
      const blocked = makeBlockedResponse({ retryToken });
      const tool = makeContinueWorkflowTool(
        sessionId, NULL_CTX, () => {}, () => {}, STUB_SCHEMAS,
        makeFakeBlockedExec(blocked),
      );

      const result = await tool.execute('call-1', makeParams());
      const text = (result.content[0] as { type: string; text: string }).text;

      expect(text).toContain(retryToken);
    });

    it('tells agent to retry when retryable=true', async () => {
      const sessionId = makeSessionId();
      const blocked = makeBlockedResponse({ retryable: true });
      const tool = makeContinueWorkflowTool(
        sessionId, NULL_CTX, () => {}, () => {}, STUB_SCHEMAS,
        makeFakeBlockedExec(blocked),
      );

      const result = await tool.execute('call-1', makeParams());
      const text = (result.content[0] as { type: string; text: string }).text;

      expect(text).toMatch(/retry/i);
    });

    it('tells agent to inform user when retryable=false', async () => {
      const sessionId = makeSessionId();
      const blocked = makeBlockedResponse({ retryable: false });
      const tool = makeContinueWorkflowTool(
        sessionId, NULL_CTX, () => {}, () => {}, STUB_SCHEMAS,
        makeFakeBlockedExec(blocked),
      );

      const result = await tool.execute('call-1', makeParams());
      const text = (result.content[0] as { type: string; text: string }).text;

      expect(text).toMatch(/inform.*user|user.*response/i);
    });
  });

  describe('onAdvance invariant', () => {
    it('does NOT call onAdvance when blocked', async () => {
      const sessionId = makeSessionId();
      let advanceCalled = false;
      const blocked = makeBlockedResponse();
      const tool = makeContinueWorkflowTool(
        sessionId,
        NULL_CTX,
        () => { advanceCalled = true; },
        () => {},
        STUB_SCHEMAS,
        makeFakeBlockedExec(blocked),
      );

      await tool.execute('call-1', makeParams());

      expect(advanceCalled).toBe(false);
    });
  });

  describe('onComplete invariant', () => {
    it('does NOT call onComplete when blocked', async () => {
      const sessionId = makeSessionId();
      let completeCalled = false;
      const blocked = makeBlockedResponse();
      const tool = makeContinueWorkflowTool(
        sessionId,
        NULL_CTX,
        () => {},
        () => { completeCalled = true; },
        STUB_SCHEMAS,
        makeFakeBlockedExec(blocked),
      );

      await tool.execute('call-1', makeParams());

      expect(completeCalled).toBe(false);
    });
  });
});
