import { describe, it, expect } from 'vitest';
import { z } from 'zod';

describe('Blocked response backward compatibility', () => {
  // Old schema (before blocked nodes feature - v0.8.x)
  const OldV2ContinueWorkflowBlockedSchema = z.object({
    kind: z.literal('blocked'),
    continueToken: z.string(),
    isComplete: z.boolean(),
    pending: z.object({ stepId: z.string(), title: z.string(), prompt: z.string() }).nullable(),
    preferences: z.any(),
    nextIntent: z.string(),
    blockers: z.any(),
  });

  it('old schema parses new blocked response (extra fields ignored)', () => {
    // New response with retryable, retryContinueToken, validation fields
    const newResponse = {
      kind: 'blocked',
      continueToken: 'ct_test123',
      isComplete: false,
      pending: { stepId: 'step1', title: 'Test', prompt: 'Do something' },
      preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
      nextIntent: 'perform_pending_then_continue',
      blockers: {
        blockers: [
          {
            code: 'MISSING_REQUIRED_OUTPUT',
            pointer: { kind: 'output_contract', contractRef: 'wr.test' },
            message: 'Missing required output',
          },
        ],
      },
      
      // New fields (should be ignored by old clients)
      retryable: true,
      retryContinueToken: 'ack1retry9x8gf2tvdw0s3jn54khce6mua7l',
      validation: {
        issues: ['Missing required field'],
        suggestions: ['Add the field'],
      },
    };

    // Old client should parse successfully, ignoring new fields
    const result = OldV2ContinueWorkflowBlockedSchema.safeParse(newResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('blocked');
      expect(result.data.continueToken).toBe('ct_test123');
      
      // Verify old client doesn't see new fields (Zod strips them)
      expect('retryable' in result.data).toBe(false);
      expect('retryContinueToken' in result.data).toBe(false);
      expect('validation' in result.data).toBe(false);
    }
  });

  it('terminal block response (retryable=false) still parses for old clients', () => {
    const terminalBlockResponse = {
      kind: 'blocked',
      continueToken: 'ct_test123',
      isComplete: false,
      pending: null,
      preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
      nextIntent: 'await_user_confirmation',
      blockers: {
        blockers: [
          {
            code: 'INVARIANT_VIOLATION',
            pointer: { kind: 'context_budget' },
            message: 'Invariant violated',
          },
        ],
      },
      retryable: false,  // New field
      // No retryContinueToken (terminal)
      validation: {
        issues: ['Invariant violation occurred'],
        suggestions: [],
      },
    };

    const result = OldV2ContinueWorkflowBlockedSchema.safeParse(terminalBlockResponse);
    expect(result.success).toBe(true);
  });
});
