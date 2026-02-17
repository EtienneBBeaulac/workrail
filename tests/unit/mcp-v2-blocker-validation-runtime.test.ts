import { describe, expect, it } from 'vitest';
import { V2BlockerReportSchema } from '../../src/mcp/output-schemas.js';

/**
 * Blocker validation: fail-fast enforcement of budget constraints.
 * 
 * Invariants (locked):
 * - Max 10 blockers
 * - Message max 512 bytes (fail-fast, never truncate silently)
 * - suggestedFix max 1024 bytes (fail-fast, never truncate silently)
 * 
 * This test verifies Zod schema validation enforces these at runtime.
 */
describe('v2 output: blocker validation fail-fast at runtime', () => {
  const baseBlocker = {
    code: 'USER_ONLY_DEPENDENCY' as const,
    pointer: { kind: 'context_key' as const, key: 'test' },
  };

  it('accepts valid blockers within budget constraints', () => {
    const valid = {
      blockers: [
        {
          ...baseBlocker,
          message: 'This is a valid message',
          suggestedFix: 'This is valid advice',
        },
        {
          ...baseBlocker,
          message: 'Another valid message',
        },
      ],
    };

    const result = V2BlockerReportSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects blockers when count exceeds 10 (max 10)', () => {
    const blockers = Array.from({ length: 11 }, (_, i) => ({
      ...baseBlocker,
      message: `Blocker ${i + 1}`,
    }));

    const invalid = { blockers };

    const result = V2BlockerReportSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    
    if (!result.success) {
      const errorMessage = result.error.toString();
      // Verify the error relates to array size
      expect(errorMessage.toLowerCase()).toMatch(/max|length|array/i);
    }
  });

  it('rejects blocker with message exceeding 512 bytes (fail-fast, no truncation)', () => {
    const longMessage = 'x'.repeat(513); // 513 bytes, exceeds 512 limit

    const invalid = {
      blockers: [
        {
          ...baseBlocker,
          message: longMessage,
        },
      ],
    };

    const result = V2BlockerReportSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    
    if (!result.success) {
      const errorMessage = result.error.toString();
      // Verify error indicates byte budget constraint
      expect(errorMessage.toLowerCase()).toMatch(/bytes|utf-8|exceeds|max|length/i);
    }
  });

  it('rejects blocker with suggestedFix exceeding 1024 bytes (fail-fast, no truncation)', () => {
    const longFix = 'y'.repeat(1025); // 1025 bytes, exceeds 1024 limit

    const invalid = {
      blockers: [
        {
          ...baseBlocker,
          message: 'Valid message',
          suggestedFix: longFix,
        },
      ],
    };

    const result = V2BlockerReportSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    
    if (!result.success) {
      const errorMessage = result.error.toString();
      // Verify error indicates byte budget constraint
      expect(errorMessage.toLowerCase()).toMatch(/bytes|utf-8|exceeds|max|length/i);
    }
  });

  it('accepts blocker with message exactly at 512-byte boundary', () => {
    const exactMessage = 'x'.repeat(512); // Exactly 512 bytes

    const valid = {
      blockers: [
        {
          ...baseBlocker,
          message: exactMessage,
        },
      ],
    };

    const result = V2BlockerReportSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('accepts blocker with suggestedFix exactly at 1024-byte boundary', () => {
    const exactFix = 'y'.repeat(1024); // Exactly 1024 bytes

    const valid = {
      blockers: [
        {
          ...baseBlocker,
          message: 'Valid message',
          suggestedFix: exactFix,
        },
      ],
    };

    const result = V2BlockerReportSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('accepts exactly 10 blockers (max boundary)', () => {
    const blockers = Array.from({ length: 10 }, (_, i) => ({
      ...baseBlocker,
      message: `Blocker ${i + 1}`,
    }));

    const valid = { blockers };

    const result = V2BlockerReportSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects empty blocker array (min 1)', () => {
    const invalid = { blockers: [] };

    const result = V2BlockerReportSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    
    if (!result.success) {
      const errorMessage = result.error.toString();
      expect(errorMessage.toLowerCase()).toMatch(/min|array|length/i);
    }
  });

  it('validates all blocker budget constraints independently (composition)', () => {
    // Multiple blockers, each at boundary, total within count limit
    const valid = {
      blockers: [
        {
          ...baseBlocker,
          message: 'x'.repeat(512), // Max message
          suggestedFix: 'y'.repeat(1024), // Max fix
        },
        {
          ...baseBlocker,
          message: 'a'.repeat(512), // Max message again
          suggestedFix: 'b'.repeat(1024), // Max fix again
        },
      ],
    };

    const result = V2BlockerReportSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });
});
