import { describe, it, expect } from 'vitest';
import { V2BlockerReportSchema } from '../../src/mcp/output-schemas.js';

describe('v2 BlockerReport budgets enforcement (v2 locks)', () => {
  it('rejects blockers array exceeding max count (10)', () => {
    const blockers = Array.from({ length: 11 }, (_, i) => ({
      code: 'INVARIANT_VIOLATION' as const,
      pointer: { kind: 'workflow_step' as const, stepId: `step_${i}` },
      message: 'Test blocker',
    }));
    
    const result = V2BlockerReportSchema.safeParse({ blockers });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(e => e.path.includes('blockers'))).toBe(true);
    }
  });

  it('accepts blockers at max count (10)', () => {
    const blockers = Array.from({ length: 10 }, (_, i) => ({
      code: 'INVARIANT_VIOLATION' as const,
      pointer: { kind: 'workflow_step' as const, stepId: `step_${i}` },
      message: 'Test blocker',
    }));
    
    const result = V2BlockerReportSchema.safeParse({ blockers });
    expect(result.success).toBe(true);
  });

  it('rejects blocker message exceeding 512 bytes', () => {
    const message = 'x'.repeat(513); // 513 bytes
    const blocker = {
      code: 'INVARIANT_VIOLATION' as const,
      pointer: { kind: 'workflow_step' as const, stepId: 'test' },
      message,
    };
    
    const result = V2BlockerReportSchema.safeParse({ blockers: [blocker] });
    expect(result.success).toBe(false);
  });

  it('rejects suggestedFix exceeding 1024 bytes', () => {
    const suggestedFix = 'x'.repeat(1025);
    const blocker = {
      code: 'INVARIANT_VIOLATION' as const,
      pointer: { kind: 'workflow_step' as const, stepId: 'test' },
      message: 'Test',
      suggestedFix,
    };
    
    const result = V2BlockerReportSchema.safeParse({ blockers: [blocker] });
    expect(result.success).toBe(false);
  });
});
