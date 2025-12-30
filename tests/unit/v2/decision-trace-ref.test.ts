import { describe, it, expect } from 'vitest';
import {
  DecisionTraceRefV1Schema,
  DecisionTraceRefsV1Schema,
  MAX_DECISION_TRACE_REFS_PER_ENTRY,
} from '../../../src/v2/durable-core/schemas/lib/decision-trace-ref';

describe('decision-trace-ref', () => {
  describe('DecisionTraceRefV1Schema', () => {
    it('parses valid step_id ref', () => {
      const result = DecisionTraceRefV1Schema.safeParse({
        kind: 'step_id',
        stepId: 'phase-1-triage',
      });
      expect(result.success).toBe(true);
    });

    it('parses valid loop_id ref', () => {
      const result = DecisionTraceRefV1Schema.safeParse({
        kind: 'loop_id',
        loopId: 'main-loop',
      });
      expect(result.success).toBe(true);
    });

    it('parses valid condition_id ref', () => {
      const result = DecisionTraceRefV1Schema.safeParse({
        kind: 'condition_id',
        conditionId: 'should-continue',
      });
      expect(result.success).toBe(true);
    });

    it('parses valid iteration ref', () => {
      const result = DecisionTraceRefV1Schema.safeParse({
        kind: 'iteration',
        value: 3,
      });
      expect(result.success).toBe(true);
    });

    it('rejects unknown kind', () => {
      const result = DecisionTraceRefV1Schema.safeParse({
        kind: 'unknown',
        foo: 'bar',
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-delimiter-safe stepId', () => {
      const result = DecisionTraceRefV1Schema.safeParse({
        kind: 'step_id',
        stepId: 'has spaces',
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-delimiter-safe loopId', () => {
      const result = DecisionTraceRefV1Schema.safeParse({
        kind: 'loop_id',
        loopId: 'has/slash',
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative iteration value', () => {
      const result = DecisionTraceRefV1Schema.safeParse({
        kind: 'iteration',
        value: -1,
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra fields (strict mode)', () => {
      const result = DecisionTraceRefV1Schema.safeParse({
        kind: 'step_id',
        stepId: 'valid-id',
        extraField: 'not allowed',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('DecisionTraceRefsV1Schema', () => {
    it('parses empty array', () => {
      const result = DecisionTraceRefsV1Schema.safeParse([]);
      expect(result.success).toBe(true);
    });

    it('parses undefined (optional)', () => {
      const result = DecisionTraceRefsV1Schema.safeParse(undefined);
      expect(result.success).toBe(true);
    });

    it('parses array with multiple refs', () => {
      const result = DecisionTraceRefsV1Schema.safeParse([
        { kind: 'step_id', stepId: 'phase-1' },
        { kind: 'loop_id', loopId: 'main-loop' },
        { kind: 'iteration', value: 2 },
      ]);
      expect(result.success).toBe(true);
    });

    it('rejects array exceeding max refs', () => {
      const refs = Array.from({ length: MAX_DECISION_TRACE_REFS_PER_ENTRY + 1 }, (_, i) => ({
        kind: 'step_id' as const,
        stepId: `step-${i}`,
      }));
      const result = DecisionTraceRefsV1Schema.safeParse(refs);
      expect(result.success).toBe(false);
    });

    it('accepts array at exactly max refs', () => {
      const refs = Array.from({ length: MAX_DECISION_TRACE_REFS_PER_ENTRY }, (_, i) => ({
        kind: 'step_id' as const,
        stepId: `step-${i}`,
      }));
      const result = DecisionTraceRefsV1Schema.safeParse(refs);
      expect(result.success).toBe(true);
    });
  });

  describe('closed union (locked)', () => {
    it('only allows known ref kinds', () => {
      // These should all succeed
      const validKinds = ['step_id', 'loop_id', 'condition_id', 'iteration'];
      for (const kind of validKinds) {
        const testData = kind === 'iteration' 
          ? { kind, value: 0 }
          : { kind, [`${kind.replace('_id', '')}Id`]: 'test-id' };
        
        // Handle the naming pattern
        let data: Record<string, unknown>;
        switch (kind) {
          case 'step_id':
            data = { kind, stepId: 'test-id' };
            break;
          case 'loop_id':
            data = { kind, loopId: 'test-id' };
            break;
          case 'condition_id':
            data = { kind, conditionId: 'test-id' };
            break;
          case 'iteration':
            data = { kind, value: 0 };
            break;
          default:
            throw new Error(`Unknown kind: ${kind}`);
        }
        
        const result = DecisionTraceRefV1Schema.safeParse(data);
        expect(result.success, `Expected ${kind} to be valid`).toBe(true);
      }
    });
  });
});
