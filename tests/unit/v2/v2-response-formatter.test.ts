/**
 * V2 Response Formatter Tests
 *
 * Tests the natural language formatting of v2 execution tool responses.
 * Each test builds a typed response object (matching the output schema shape)
 * and verifies the formatter produces the expected natural language output.
 *
 * @module tests/unit/v2/v2-response-formatter
 */

import { describe, it, expect } from 'vitest';
import { formatV2ExecutionResponse } from '../../../src/mcp/v2-response-formatter.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_PREFERENCES = { autonomy: 'full_auto_stop_on_user_deps' as const, riskPolicy: 'balanced' as const };

function startResponse(overrides: Record<string, unknown> = {}) {
  return {
    stateToken: 'st1testtoken',
    ackToken: 'ack1testtoken',
    checkpointToken: 'chk1testtoken',
    isComplete: false,
    pending: {
      stepId: 'phase-2-define-problem',
      title: 'Phase 2: Define the Problem Space',
      prompt: 'Turn empathy into a precise definition.\n\nDocument the POV statement.',
    },
    preferences: BASE_PREFERENCES,
    nextIntent: 'perform_pending_then_continue',
    nextCall: {
      tool: 'continue_workflow' as const,
      params: { intent: 'advance' as const, stateToken: 'st1testtoken', ackToken: 'ack1testtoken' },
    },
    ...overrides,
  };
}

function continueOkResponse(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ok' as const,
    ...startResponse(overrides),
  };
}

function continueBlockedResponse(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'blocked' as const,
    stateToken: 'st1testtoken',
    ackToken: 'ack1testtoken',
    checkpointToken: 'chk1testtoken',
    isComplete: false,
    pending: {
      stepId: 'phase-1-empathize',
      title: 'Phase 1: Empathize',
      prompt: 'Conduct user interviews.',
    },
    preferences: BASE_PREFERENCES,
    nextIntent: 'perform_pending_then_continue',
    nextCall: {
      tool: 'continue_workflow' as const,
      params: { intent: 'advance' as const, stateToken: 'st1testtoken', ackToken: 'ack1retrytoken' },
    },
    blockers: {
      blockers: [
        {
          code: 'MISSING_REQUIRED_NOTES',
          pointer: { kind: 'output_contract', contractRef: 'notesMarkdown' },
          message: 'Step "phase-1-empathize" requires notes documenting your work.',
          suggestedFix: 'Add output.notesMarkdown with a detailed recap.',
        },
      ],
    },
    retryable: true,
    retryAckToken: 'ack1retrytoken',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

describe('formatV2ExecutionResponse — shape detection', () => {
  it('returns null for non-object data', () => {
    expect(formatV2ExecutionResponse(null)).toBeNull();
    expect(formatV2ExecutionResponse('hello')).toBeNull();
    expect(formatV2ExecutionResponse(42)).toBeNull();
    expect(formatV2ExecutionResponse(undefined)).toBeNull();
  });

  it('returns null for non-execution tool outputs', () => {
    expect(formatV2ExecutionResponse({ workflows: [] })).toBeNull();
    expect(formatV2ExecutionResponse({ checkpointNodeId: 'n1', stateToken: 'st1x' })).toBeNull();
    expect(formatV2ExecutionResponse({ candidates: [], totalEligible: 0 })).toBeNull();
  });

  it('matches start_workflow response shape', () => {
    const result = formatV2ExecutionResponse(startResponse());
    expect(result).not.toBeNull();
    expect(result).toContain('Phase 2: Define the Problem Space');
  });

  it('matches continue_workflow ok response shape', () => {
    const result = formatV2ExecutionResponse(continueOkResponse());
    expect(result).not.toBeNull();
    expect(result).toContain('Phase 2: Define the Problem Space');
  });

  it('matches continue_workflow blocked response shape', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse());
    expect(result).not.toBeNull();
    expect(result).toContain('Blocked');
  });
});

// ---------------------------------------------------------------------------
// Success (advance / start)
// ---------------------------------------------------------------------------

describe('formatV2ExecutionResponse — success', () => {
  it('renders step title as heading', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    expect(result).toMatch(/^# Phase 2: Define the Problem Space$/m);
  });

  it('embeds stepId as HTML comment for debugging', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    expect(result).toContain('<!-- stepId: phase-2-define-problem -->');
  });

  it('renders step prompt as body', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    expect(result).toContain('Turn empathy into a precise definition.');
    expect(result).toContain('Document the POV statement.');
  });

  it('includes instruction to execute and continue', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    expect(result).toContain('Execute this step, then call `continue_workflow` to advance.');
  });

  it('includes notes guidance', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    expect(result).toContain('output.notesMarkdown');
  });

  it('renders token JSON block with stateToken and ackToken', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    expect(result).toContain('```json');
    expect(result).toContain('"stateToken":"st1testtoken"');
    expect(result).toContain('"ackToken":"ack1testtoken"');
  });

  it('does not include intent in the token JSON block', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    const jsonMatch = result.match(/```json\n(.*)\n```/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed).not.toHaveProperty('intent');
  });

  it('mentions checkpointToken separately', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    expect(result).toContain('Checkpoint token (for `checkpoint_workflow`): `chk1testtoken`');
  });

  it('omits checkpointToken line when not present', () => {
    const result = formatV2ExecutionResponse(startResponse({ checkpointToken: undefined }))!;
    expect(result).not.toContain('checkpoint_workflow');
  });

  it('renders preferences summary', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    expect(result).toContain('Preferences: full autonomy (stop on user deps), balanced risk.');
  });

  it('renders guided + conservative preferences', () => {
    const result = formatV2ExecutionResponse(startResponse({
      preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
    }))!;
    expect(result).toContain('Preferences: guided mode, conservative risk.');
  });

  it('renders full_auto_never_stop + aggressive preferences', () => {
    const result = formatV2ExecutionResponse(startResponse({
      preferences: { autonomy: 'full_auto_never_stop', riskPolicy: 'aggressive' },
    }))!;
    expect(result).toContain('Preferences: full autonomy (never stop), aggressive risk.');
  });
});

// ---------------------------------------------------------------------------
// Rehydrate
// ---------------------------------------------------------------------------

describe('formatV2ExecutionResponse — rehydrate', () => {
  it('renders title with (resumed) suffix', () => {
    const result = formatV2ExecutionResponse(continueOkResponse({
      nextIntent: 'rehydrate_only',
    }))!;
    expect(result).toMatch(/^# Phase 2: Define the Problem Space \(resumed\)$/m);
  });

  it('includes instruction to continue working', () => {
    const result = formatV2ExecutionResponse(continueOkResponse({
      nextIntent: 'rehydrate_only',
    }))!;
    expect(result).toContain('Continue working on this step.');
  });

  it('renders prompt body', () => {
    const result = formatV2ExecutionResponse(continueOkResponse({
      nextIntent: 'rehydrate_only',
    }))!;
    expect(result).toContain('Turn empathy into a precise definition.');
  });

  it('handles rehydrate with no pending step', () => {
    const result = formatV2ExecutionResponse(continueOkResponse({
      nextIntent: 'rehydrate_only',
      pending: null,
      ackToken: undefined,
      nextCall: null,
    }))!;
    expect(result).toContain('State Recovered');
    expect(result).toContain('No pending step');
  });
});

// ---------------------------------------------------------------------------
// Blocked (retryable)
// ---------------------------------------------------------------------------

describe('formatV2ExecutionResponse — blocked retryable', () => {
  it('renders Blocked heading from blocker code', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse())!;
    expect(result).toMatch(/^# Blocked: Missing Required Notes$/m);
  });

  it('renders blocker message', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse())!;
    expect(result).toContain('Step "phase-1-empathize" requires notes documenting your work.');
  });

  it('renders suggestedFix as "What to do"', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse())!;
    expect(result).toContain('**What to do:** Add output.notesMarkdown with a detailed recap.');
  });

  it('includes retry instruction', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse())!;
    expect(result).toContain('Retry with corrected output:');
  });

  it('uses ackToken (not retryAckToken) as key in the JSON block', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse())!;
    const jsonMatch = result.match(/```json\n(.*)\n```/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed).toHaveProperty('ackToken', 'ack1retrytoken');
    expect(parsed).not.toHaveProperty('retryAckToken');
  });

  it('renders validation issues as bulleted list', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse({
      validation: {
        issues: ['notesMarkdown must be at least 50 characters', 'notesMarkdown must contain a heading'],
        suggestions: ['Include a summary under ## Summary'],
      },
    }))!;
    expect(result).toContain('**Issues:**');
    expect(result).toContain('- notesMarkdown must be at least 50 characters');
    expect(result).toContain('- notesMarkdown must contain a heading');
    expect(result).toContain('**Suggestions:**');
    expect(result).toContain('- Include a summary under ## Summary');
  });
});

// ---------------------------------------------------------------------------
// Blocked (non-retryable)
// ---------------------------------------------------------------------------

describe('formatV2ExecutionResponse — blocked non-retryable', () => {
  it('renders Blocked heading', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse({
      retryable: false,
      retryAckToken: undefined,
      nextCall: null,
      blockers: {
        blockers: [{
          code: 'USER_ONLY_DEPENDENCY',
          pointer: { kind: 'context_key', key: 'ticketId' },
          message: 'Missing context key: ticketId — Provide the ticket ID for this task.',
        }],
      },
    }))!;
    expect(result).toMatch(/^# Blocked: User Input Required$/m);
  });

  it('includes user-facing guidance', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse({
      retryable: false,
      retryAckToken: undefined,
      nextCall: null,
      blockers: {
        blockers: [{
          code: 'USER_ONLY_DEPENDENCY',
          pointer: { kind: 'context_key', key: 'ticketId' },
          message: 'Missing context key: ticketId.',
        }],
      },
    }))!;
    expect(result).toContain('You cannot proceed without resolving this.');
    expect(result).toContain('Inform the user');
  });

  it('includes only stateToken in the JSON block when nextCall is null', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse({
      retryable: false,
      retryAckToken: undefined,
      nextCall: null,
      blockers: {
        blockers: [{
          code: 'USER_ONLY_DEPENDENCY',
          pointer: { kind: 'context_key', key: 'ticketId' },
          message: 'Missing context key.',
        }],
      },
    }))!;
    const jsonMatch = result.match(/```json\n(.*)\n```/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![1]);
    expect(parsed).toEqual({ stateToken: 'st1testtoken' });
  });
});

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

describe('formatV2ExecutionResponse — complete', () => {
  it('renders completion heading', () => {
    const result = formatV2ExecutionResponse(continueOkResponse({
      nextIntent: 'complete',
      pending: null,
      ackToken: undefined,
      checkpointToken: undefined,
      isComplete: true,
      nextCall: null,
    }))!;
    expect(result).toMatch(/^# Workflow Complete$/m);
    expect(result).toContain('The workflow has finished.');
  });

  it('does not include a token JSON block', () => {
    const result = formatV2ExecutionResponse(continueOkResponse({
      nextIntent: 'complete',
      pending: null,
      ackToken: undefined,
      checkpointToken: undefined,
      isComplete: true,
      nextCall: null,
    }))!;
    expect(result).not.toContain('```json');
  });
});

// ---------------------------------------------------------------------------
// Multiple blockers
// ---------------------------------------------------------------------------

describe('formatV2ExecutionResponse — multiple blockers', () => {
  it('renders all blocker messages', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse({
      retryable: false,
      retryAckToken: undefined,
      nextCall: null,
      blockers: {
        blockers: [
          {
            code: 'MISSING_CONTEXT_KEY',
            pointer: { kind: 'context_key', key: 'branch' },
            message: 'Missing context key: branch.',
            suggestedFix: 'Set context.branch to the current git branch.',
          },
          {
            code: 'MISSING_CONTEXT_KEY',
            pointer: { kind: 'context_key', key: 'ticketId' },
            message: 'Missing context key: ticketId.',
            suggestedFix: 'Set context.ticketId to the ticket ID.',
          },
        ],
      },
    }))!;
    expect(result).toContain('Missing context key: branch.');
    expect(result).toContain('Missing context key: ticketId.');
    expect(result).toContain('Set context.branch');
    expect(result).toContain('Set context.ticketId');
  });
});

// ---------------------------------------------------------------------------
// Persona section headers
// ---------------------------------------------------------------------------

const USER_HEADER = '---------\nUSER\n---------';
const SYSTEM_HEADER = '---------\nSYSTEM\n---------';

describe('formatV2ExecutionResponse — persona headers', () => {
  it('success: has USER section before prompt and SYSTEM section after', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    const userIdx = result.indexOf(USER_HEADER);
    const systemIdx = result.indexOf(SYSTEM_HEADER);
    const promptIdx = result.indexOf('Turn empathy into a precise definition.');
    const tokenIdx = result.indexOf('```json');

    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(systemIdx).toBeGreaterThan(userIdx);
    expect(promptIdx).toBeGreaterThan(userIdx);
    expect(promptIdx).toBeLessThan(systemIdx);
    expect(tokenIdx).toBeGreaterThan(systemIdx);
  });

  it('success: USER section contains title and prompt', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    const userIdx = result.indexOf(USER_HEADER);
    const systemIdx = result.indexOf(SYSTEM_HEADER);
    const userSection = result.slice(userIdx, systemIdx);

    expect(userSection).toContain('# Phase 2: Define the Problem Space');
    expect(userSection).toContain('Turn empathy into a precise definition.');
  });

  it('success: SYSTEM section contains tokens and preferences', () => {
    const result = formatV2ExecutionResponse(startResponse())!;
    const systemIdx = result.indexOf(SYSTEM_HEADER);
    const systemSection = result.slice(systemIdx);

    expect(systemSection).toContain('```json');
    expect(systemSection).toContain('Preferences:');
    expect(systemSection).toContain('Execute this step');
  });

  it('rehydrate: has USER section before prompt and SYSTEM section after', () => {
    const result = formatV2ExecutionResponse(continueOkResponse({
      nextIntent: 'rehydrate_only',
    }))!;
    const userIdx = result.indexOf(USER_HEADER);
    const systemIdx = result.indexOf(SYSTEM_HEADER);

    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(systemIdx).toBeGreaterThan(userIdx);

    const userSection = result.slice(userIdx, systemIdx);
    expect(userSection).toContain('Phase 2: Define the Problem Space (resumed)');
    expect(userSection).toContain('Turn empathy into a precise definition.');
  });

  it('rehydrate with no pending: SYSTEM-only, no USER header', () => {
    const result = formatV2ExecutionResponse(continueOkResponse({
      nextIntent: 'rehydrate_only',
      pending: null,
      ackToken: undefined,
      nextCall: null,
    }))!;
    expect(result).not.toContain(USER_HEADER);
    expect(result).toContain(SYSTEM_HEADER);
    expect(result).toContain('State Recovered');
  });

  it('blocked retryable: SYSTEM-only, no USER header', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse())!;
    expect(result).not.toContain(USER_HEADER);
    expect(result).toContain(SYSTEM_HEADER);
    expect(result).toContain('# Blocked: Missing Required Notes');
  });

  it('blocked non-retryable: SYSTEM-only, no USER header', () => {
    const result = formatV2ExecutionResponse(continueBlockedResponse({
      retryable: false,
      retryAckToken: undefined,
      nextCall: null,
      blockers: {
        blockers: [{
          code: 'USER_ONLY_DEPENDENCY',
          pointer: { kind: 'context_key', key: 'ticketId' },
          message: 'Missing context key: ticketId.',
        }],
      },
    }))!;
    expect(result).not.toContain(USER_HEADER);
    expect(result).toContain(SYSTEM_HEADER);
    expect(result).toContain('# Blocked: User Input Required');
  });

  it('complete: SYSTEM-only, no USER header', () => {
    const result = formatV2ExecutionResponse(continueOkResponse({
      nextIntent: 'complete',
      pending: null,
      ackToken: undefined,
      checkpointToken: undefined,
      isComplete: true,
      nextCall: null,
    }))!;
    expect(result).not.toContain(USER_HEADER);
    expect(result).toContain(SYSTEM_HEADER);
    expect(result).toContain('# Workflow Complete');
  });

  it('no response has both USER and SYSTEM headers appearing more than once', () => {
    const variants = [
      formatV2ExecutionResponse(startResponse())!,
      formatV2ExecutionResponse(continueOkResponse({ nextIntent: 'rehydrate_only' }))!,
      formatV2ExecutionResponse(continueBlockedResponse())!,
      formatV2ExecutionResponse(continueOkResponse({
        nextIntent: 'complete', pending: null, ackToken: undefined,
        checkpointToken: undefined, isComplete: true, nextCall: null,
      }))!,
    ];

    for (const result of variants) {
      const userCount = result.split(USER_HEADER).length - 1;
      const systemCount = result.split(SYSTEM_HEADER).length - 1;
      expect(userCount).toBeLessThanOrEqual(1);
      expect(systemCount).toBe(1);
    }
  });
});
