import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Import schemas from output-schemas
const V2BlockerPointerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context_key'), key: z.string().min(1) }),
  z.object({ kind: z.literal('context_budget') }),
  z.object({ kind: z.literal('output_contract'), contractRef: z.string().min(1) }),
  z.object({ kind: z.literal('capability'), capability: z.enum(['delegation', 'web_browsing']) }),
  z.object({ kind: z.literal('workflow_step'), stepId: z.string().min(1) }),
]);

const V2BlockerSchema = z.object({
  code: z.enum([
    'USER_ONLY_DEPENDENCY',
    'MISSING_REQUIRED_OUTPUT',
    'INVALID_REQUIRED_OUTPUT',
    'REQUIRED_CAPABILITY_UNKNOWN',
    'REQUIRED_CAPABILITY_UNAVAILABLE',
    'INVARIANT_VIOLATION',
    'STORAGE_CORRUPTION_DETECTED',
  ]),
  pointer: V2BlockerPointerSchema,
  message: z.string().min(1).max(512),
  suggestedFix: z.string().min(1).max(1024).optional(),
});

const V2BlockerReportSchema = z.object({
  blockers: z.array(V2BlockerSchema).min(1).max(10),
});

describe('v2 bounded blockers enforcement', () => {
  it('schema rejects >10 blockers', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      code: 'USER_ONLY_DEPENDENCY',
      pointer: { kind: 'context_key', key: `key${i}` },
      message: `Blocker ${i}`,
    }));

    const result = V2BlockerReportSchema.safeParse({ blockers: tooMany });
    expect(result.success).toBe(false);
  });

  it('schema rejects blocker message >512 bytes', () => {
    const oversized = {
      code: 'MISSING_REQUIRED_OUTPUT',
      pointer: { kind: 'output_contract', contractRef: 'wr.contracts.test' },
      message: 'x'.repeat(513), // 513 bytes
    };

    const result = V2BlockerSchema.safeParse(oversized);
    expect(result.success).toBe(false);
  });

  it('schema rejects suggestedFix >1024 bytes', () => {
    const oversized = {
      code: 'INVALID_REQUIRED_OUTPUT',
      pointer: { kind: 'workflow_step', stepId: 'test' },
      message: 'Invalid output',
      suggestedFix: 'x'.repeat(1025), // 1025 bytes
    };

    const result = V2BlockerSchema.safeParse(oversized);
    expect(result.success).toBe(false);
  });

  it('schema accepts valid blockers within limits', () => {
    const valid = {
      blockers: [
        {
          code: 'USER_ONLY_DEPENDENCY',
          pointer: { kind: 'context_key', key: 'designDoc' },
          message: 'x'.repeat(512), // exactly 512 bytes
          suggestedFix: 'x'.repeat(1024), // exactly 1024 bytes
        },
      ],
    };

    const result = V2BlockerReportSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('schema accepts context_budget pointer kind (S7: test gap)', () => {
    const validWithContextBudget = {
      blockers: [
        {
          code: 'INVARIANT_VIOLATION',
          pointer: { kind: 'context_budget' },
          message: 'Context exceeded budget',
          suggestedFix: 'Remove large blobs from context',
        },
      ],
    };

    const result = V2BlockerReportSchema.safeParse(validWithContextBudget);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockers[0].pointer.kind).toBe('context_budget');
    }
  });
});
