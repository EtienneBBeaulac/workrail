/**
 * v2 MCP tool contract tests.
 *
 * Purpose: assert that tool response shapes match the locked output schemas.
 * These are pure boundary tests — no behavioral assertions, no side effects.
 * If a response shape drifts, these tests name the exact contract that broke.
 *
 * Why separate from protocol tests:
 * - Protocol tests verify orchestration behavior (rehydrate/advance/replay)
 * - Contract tests verify response shape at the MCP boundary
 * - When a contract breaks, the failure message should say "contract" not "protocol"
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  V2WorkflowListOutputSchema,
  V2WorkflowListItemSchema,
  V2WorkflowInspectOutputSchema,
  V2StartWorkflowOutputSchema,
  V2ContinueWorkflowOutputSchema,
  V2CheckpointWorkflowOutputSchema,
  V2PendingStepSchema,
  V2PreferencesSchema,
  V2NextIntentSchema,
  V2BlockerReportSchema,
} from '../../src/mcp/output-schemas.js';

// ---------------------------------------------------------------------------
// Helpers: minimal valid response shapes (boundary-only, no runtime deps)
// ---------------------------------------------------------------------------

const VALID_STATE_TOKEN = 'st1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const VALID_ACK_TOKEN = 'ack1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const VALID_CHECKPOINT_TOKEN = 'chk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

function validPendingStep() {
  return { stepId: 'step-1', title: 'Step 1', prompt: 'Do the thing' };
}

function validPreferences() {
  return { autonomy: 'guided' as const, riskPolicy: 'conservative' as const };
}

// ---------------------------------------------------------------------------
// list_workflows response contract
// ---------------------------------------------------------------------------

describe('list_workflows response contract', () => {
  it('accepts valid workflow list', () => {
    const response = {
      workflows: [
        { workflowId: 'test.wf', name: 'Test', description: 'Desc', version: '1.0.0', kind: 'workflow', workflowHash: 'sha256:abc123' },
        { workflowId: 'test.wf2', name: 'Test 2', description: 'Desc 2', version: '1.0.0', kind: 'workflow', workflowHash: null },
      ],
    };
    expect(V2WorkflowListOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects empty workflowId', () => {
    const response = {
      workflows: [{ workflowId: '', name: 'Test', description: 'Desc', version: '1.0.0', kind: 'workflow', workflowHash: null }],
    };
    expect(V2WorkflowListOutputSchema.safeParse(response).success).toBe(false);
  });

  it('accepts empty workflow list', () => {
    expect(V2WorkflowListOutputSchema.safeParse({ workflows: [] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inspect_workflow response contract
// ---------------------------------------------------------------------------

describe('inspect_workflow response contract', () => {
  it('accepts valid metadata mode response', () => {
    const response = {
      workflowId: 'test.wf',
      workflowHash: 'sha256:abc',
      mode: 'metadata',
      compiled: { schemaVersion: 1, sourceKind: 'v1_preview', workflowId: 'test.wf' },
    };
    expect(V2WorkflowInspectOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts valid preview mode response', () => {
    const response = {
      workflowId: 'test.wf',
      workflowHash: 'sha256:abc',
      mode: 'preview',
      compiled: {
        schemaVersion: 1,
        sourceKind: 'v1_preview',
        workflowId: 'test.wf',
        name: 'Test',
        description: 'Desc',
        version: '1.0.0',
        preview: { stepId: 's1', title: 'S1', prompt: 'P' },
      },
    };
    expect(V2WorkflowInspectOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects invalid mode', () => {
    const response = {
      workflowId: 'test.wf',
      workflowHash: 'sha256:abc',
      mode: 'invalid',
      compiled: {},
    };
    expect(V2WorkflowInspectOutputSchema.safeParse(response).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// start_workflow response contract
// ---------------------------------------------------------------------------

describe('start_workflow response contract', () => {
  it('accepts valid response with pending step', () => {
    const response = {
      stateToken: VALID_STATE_TOKEN,
      ackToken: VALID_ACK_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow' as const, params: { intent: 'advance' as const, stateToken: VALID_STATE_TOKEN, ackToken: VALID_ACK_TOKEN } },
    };
    expect(V2StartWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts complete workflow (no pending, no ackToken)', () => {
    const response = {
      stateToken: VALID_STATE_TOKEN,
      isComplete: true,
      pending: null,
      preferences: validPreferences(),
      nextIntent: 'complete',
      nextCall: null,
    };
    expect(V2StartWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects pending step without ackToken', () => {
    const response = {
      stateToken: VALID_STATE_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: null,
    };
    // ackToken is required when pending exists (refine rule)
    expect(V2StartWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });

  it('rejects invalid stateToken format', () => {
    const response = {
      stateToken: 'not-a-valid-token',
      ackToken: VALID_ACK_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow' as const, params: { intent: 'advance' as const, stateToken: 'not-a-valid-token', ackToken: VALID_ACK_TOKEN } },
    };
    expect(V2StartWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// continue_workflow response contract
// ---------------------------------------------------------------------------

describe('continue_workflow response contract', () => {
  it('accepts valid ok response', () => {
    const response = {
      kind: 'ok',
      stateToken: VALID_STATE_TOKEN,
      ackToken: VALID_ACK_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow' as const, params: { intent: 'advance' as const, stateToken: VALID_STATE_TOKEN, ackToken: VALID_ACK_TOKEN } },
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts valid blocked response', () => {
    const response = {
      kind: 'blocked',
      stateToken: VALID_STATE_TOKEN,
      ackToken: VALID_ACK_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: null,
      blockers: {
        blockers: [
          {
            code: 'MISSING_REQUIRED_OUTPUT',
            pointer: { kind: 'output_contract', contractRef: 'wr.contracts.loop_control' },
            message: 'Required artifact missing',
            suggestedFix: 'Provide a loop control artifact',
          },
        ],
      },
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('accepts rehydrate-only response (complete, no pending)', () => {
    const response = {
      kind: 'ok',
      stateToken: VALID_STATE_TOKEN,
      isComplete: true,
      pending: null,
      preferences: validPreferences(),
      nextIntent: 'complete',
      nextCall: null,
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects unknown kind', () => {
    const response = {
      kind: 'unknown',
      stateToken: VALID_STATE_TOKEN,
      isComplete: false,
      pending: null,
      preferences: validPreferences(),
      nextIntent: 'rehydrate_only',
      nextCall: null,
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sub-schema contracts (closed sets from design locks)
// ---------------------------------------------------------------------------

describe('closed set contracts', () => {
  describe('nextIntent', () => {
    const LOCKED_VALUES = ['perform_pending_then_continue', 'await_user_confirmation', 'rehydrate_only', 'complete'] as const;

    for (const value of LOCKED_VALUES) {
      it(`accepts locked value: ${value}`, () => {
        expect(V2NextIntentSchema.safeParse(value).success).toBe(true);
      });
    }

    it('rejects unlocked value', () => {
      expect(V2NextIntentSchema.safeParse('auto_advance').success).toBe(false);
    });
  });

  describe('preferences', () => {
    it('accepts all locked autonomy values', () => {
      for (const a of ['guided', 'full_auto_stop_on_user_deps', 'full_auto_never_stop']) {
        expect(V2PreferencesSchema.safeParse({ autonomy: a, riskPolicy: 'conservative' }).success).toBe(true);
      }
    });

    it('accepts all locked riskPolicy values', () => {
      for (const r of ['conservative', 'balanced', 'aggressive']) {
        expect(V2PreferencesSchema.safeParse({ autonomy: 'guided', riskPolicy: r }).success).toBe(true);
      }
    });

    it('rejects unlocked autonomy value', () => {
      expect(V2PreferencesSchema.safeParse({ autonomy: 'turbo', riskPolicy: 'conservative' }).success).toBe(false);
    });
  });

  describe('blocker codes (via report schema)', () => {
    const LOCKED_CODES = [
      'USER_ONLY_DEPENDENCY',
      'MISSING_REQUIRED_OUTPUT',
      'INVALID_REQUIRED_OUTPUT',
      'REQUIRED_CAPABILITY_UNKNOWN',
      'REQUIRED_CAPABILITY_UNAVAILABLE',
      'INVARIANT_VIOLATION',
      'STORAGE_CORRUPTION_DETECTED',
    ] as const;

    for (const code of LOCKED_CODES) {
      it(`accepts locked blocker code: ${code}`, () => {
        const report = {
          blockers: [{ code, pointer: { kind: 'context_budget' }, message: 'test' }],
        };
        expect(V2BlockerReportSchema.safeParse(report).success).toBe(true);
      });
    }

    it('rejects unlocked blocker code', () => {
      const report = {
        blockers: [{ code: 'TIMEOUT_EXCEEDED', pointer: { kind: 'context_budget' }, message: 'test' }],
      };
      expect(V2BlockerReportSchema.safeParse(report).success).toBe(false);
    });
  });

  describe('blocker pointer kinds (via report schema)', () => {
    const LOCKED_POINTERS = [
      { kind: 'context_key', key: 'my-key' },
      { kind: 'context_budget' },
      { kind: 'output_contract', contractRef: 'wr.contracts.loop_control' },
      { kind: 'capability', capability: 'delegation' },
      { kind: 'workflow_step', stepId: 'step-1' },
    ] as const;

    for (const pointer of LOCKED_POINTERS) {
      it(`accepts locked pointer kind: ${pointer.kind}`, () => {
        const report = {
          blockers: [{ code: 'INVARIANT_VIOLATION', pointer, message: 'test' }],
        };
        expect(V2BlockerReportSchema.safeParse(report).success).toBe(true);
      });
    }

    it('rejects unlocked pointer kind', () => {
      const report = {
        blockers: [{ code: 'INVARIANT_VIOLATION', pointer: { kind: 'file_path', path: '/foo' }, message: 'test' }],
      };
      expect(V2BlockerReportSchema.safeParse(report).success).toBe(false);
    });
  });

  describe('blocker report ordering', () => {
    it('rejects unsorted blockers', () => {
      const report = {
        blockers: [
          { code: 'USER_ONLY_DEPENDENCY', pointer: { kind: 'context_budget' }, message: 'b' },
          { code: 'INVARIANT_VIOLATION', pointer: { kind: 'context_budget' }, message: 'a' },
        ],
      };
      // USER_ONLY > INVARIANT lex → unsorted
      expect(V2BlockerReportSchema.safeParse(report).success).toBe(false);
    });

    it('accepts sorted blockers', () => {
      const report = {
        blockers: [
          { code: 'INVARIANT_VIOLATION', pointer: { kind: 'context_budget' }, message: 'a' },
          { code: 'USER_ONLY_DEPENDENCY', pointer: { kind: 'context_budget' }, message: 'b' },
        ],
      };
      expect(V2BlockerReportSchema.safeParse(report).success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// checkpoint_workflow response contract
// ---------------------------------------------------------------------------

describe('checkpoint_workflow response contract', () => {
  it('accepts valid checkpoint output', () => {
    const response = {
      checkpointNodeId: 'node_abc123',
      stateToken: VALID_STATE_TOKEN,
    };
    expect(V2CheckpointWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects missing checkpointNodeId', () => {
    const response = { stateToken: VALID_STATE_TOKEN };
    expect(V2CheckpointWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });

  it('rejects missing stateToken', () => {
    const response = { checkpointNodeId: 'node_abc123' };
    expect(V2CheckpointWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });

  it('rejects invalid stateToken format', () => {
    const response = { checkpointNodeId: 'node_abc123', stateToken: 'not-a-token' };
    expect(V2CheckpointWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkpointToken in continue_workflow / start_workflow contracts
// ---------------------------------------------------------------------------

describe('checkpointToken in response contracts', () => {
  it('continue_workflow accepts checkpointToken', () => {
    const response = {
      kind: 'ok',
      stateToken: VALID_STATE_TOKEN,
      ackToken: VALID_ACK_TOKEN,
      checkpointToken: VALID_CHECKPOINT_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow', params: { intent: 'advance', stateToken: VALID_STATE_TOKEN, ackToken: VALID_ACK_TOKEN } },
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('continue_workflow accepts response without checkpointToken (backward compatible)', () => {
    const response = {
      kind: 'ok',
      stateToken: VALID_STATE_TOKEN,
      ackToken: VALID_ACK_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow', params: { intent: 'advance', stateToken: VALID_STATE_TOKEN, ackToken: VALID_ACK_TOKEN } },
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('start_workflow accepts checkpointToken', () => {
    const response = {
      stateToken: VALID_STATE_TOKEN,
      ackToken: VALID_ACK_TOKEN,
      checkpointToken: VALID_CHECKPOINT_TOKEN,
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow', params: { intent: 'advance', stateToken: VALID_STATE_TOKEN, ackToken: VALID_ACK_TOKEN } },
    };
    expect(V2StartWorkflowOutputSchema.safeParse(response).success).toBe(true);
  });

  it('rejects invalid checkpointToken format', () => {
    const response = {
      kind: 'ok',
      stateToken: VALID_STATE_TOKEN,
      ackToken: VALID_ACK_TOKEN,
      checkpointToken: 'invalid-format',
      isComplete: false,
      pending: validPendingStep(),
      preferences: validPreferences(),
      nextIntent: 'perform_pending_then_continue',
      nextCall: { tool: 'continue_workflow', params: { intent: 'advance', stateToken: VALID_STATE_TOKEN, ackToken: VALID_ACK_TOKEN } },
    };
    expect(V2ContinueWorkflowOutputSchema.safeParse(response).success).toBe(false);
  });
});
