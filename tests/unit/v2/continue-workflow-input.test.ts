import { describe, expect, it } from 'vitest';
import { V2ContinueWorkflowInput } from '../../../src/mcp/v2/tools.js';

describe('V2ContinueWorkflowInput alias normalization', () => {
  it('accepts contextVariables and normalizes it to context', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_test_123',
      contextVariables: {
        branch: 'main',
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        continueToken: 'ct_test_123',
        intent: 'rehydrate',
        context: {
          branch: 'main',
        },
      });
    }
  });

  it('rejects providing both context and contextVariables', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_test_123',
      context: { branch: 'main' },
      contextVariables: { branch: 'dev' },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['contextVariables']);
      expect(result.error.issues[0]?.message).toContain('Canonical field: "context"');
    }
  });
});
