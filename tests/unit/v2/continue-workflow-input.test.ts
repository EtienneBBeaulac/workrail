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

  it('requires workspacePath for explicit rehydrate intent', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_test_123',
      intent: 'rehydrate',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join('.') === 'workspacePath')).toBe(true);
      expect(result.error.issues.some((issue) => issue.message.includes('Shared WorkRail servers cannot safely infer your current workspace'))).toBe(true);
    }
  });

  it('allows advance without workspacePath', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_test_123',
      intent: 'advance',
      output: { notesMarkdown: 'Done.' },
    });

    expect(result.success).toBe(true);
  });
});
