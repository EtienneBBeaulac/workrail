/**
 * Unit tests for metrics_outcome enum validation in checkContextBudget.
 *
 * Why this matters: agents set context.metrics_outcome to free-text values
 * (e.g. 'recommendation_delivered', 'pitch_written') and received no feedback
 * because the projection silently mapped invalid values to null. These tests
 * verify that checkContextBudget closes that enforcement loop by rejecting
 * invalid values with a VALIDATION_ERROR before any session I/O occurs.
 */
import { describe, it, expect } from 'vitest';
import { checkContextBudget } from '../../../src/mcp/handlers/v2-context-budget.js';
import { VALID_METRICS_OUTCOME } from '../../../src/v2/durable-core/constants.js';

describe('checkContextBudget: metrics_outcome validation', () => {
  describe('invalid values are rejected', () => {
    it('rejects a free-text value that looks like a task outcome', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: { metrics_outcome: 'pitch_written' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(result.error.message).toContain('"pitch_written"');
        // All four valid values must appear in the error message
        for (const v of VALID_METRICS_OUTCOME) {
          expect(result.error.message).toContain(`"${v}"`);
        }
      }
    });

    it('rejects another common free-text value', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: { metrics_outcome: 'recommendation_delivered' },
      });

      expect(result.ok).toBe(false);
    });

    it('populates details.details.kind = context_invalid_metrics_outcome', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: { metrics_outcome: 'not_valid' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // errNotRetryable's third argument is { suggestion, details } where
        // details is the ContextValidationDetails object.
        const payload = (result.error as unknown as { details?: Record<string, unknown> }).details;
        expect(payload).toBeDefined();
        if (payload) {
          const innerDetails = payload['details'] as Record<string, unknown> | undefined;
          expect(innerDetails).toBeDefined();
          expect(innerDetails?.['kind']).toBe('context_invalid_metrics_outcome');
        }
      }
    });

    it('populates details.details.invalidValue with the submitted value', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: { metrics_outcome: 'bad_value' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const payload = (result.error as unknown as { details?: Record<string, unknown> }).details;
        if (payload) {
          const innerDetails = payload['details'] as Record<string, unknown> | undefined;
          expect(innerDetails?.['invalidValue']).toBe('bad_value');
        }
      }
    });

    it('populates details.details.validValues with all four valid values', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: { metrics_outcome: 'wrong' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const payload = (result.error as unknown as { details?: Record<string, unknown> }).details;
        if (payload) {
          const innerDetails = payload['details'] as Record<string, unknown> | undefined;
          const validValues = innerDetails?.['validValues'];
          expect(Array.isArray(validValues)).toBe(true);
          if (Array.isArray(validValues)) {
            expect(validValues).toHaveLength(4);
            for (const v of VALID_METRICS_OUTCOME) {
              expect(validValues).toContain(v);
            }
          }
        }
      }
    });
  });

  describe('valid enum values pass through', () => {
    for (const validValue of VALID_METRICS_OUTCOME) {
      it(`accepts "${validValue}"`, () => {
        const result = checkContextBudget({
          tool: 'continue_workflow',
          context: { metrics_outcome: validValue },
        });

        expect(result.ok).toBe(true);
      });
    }
  });

  describe('absent and null values pass through (backward compat)', () => {
    it('passes when metrics_outcome is absent from context', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: {},
      });

      expect(result.ok).toBe(true);
    });

    it('passes when metrics_outcome is null', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: { metrics_outcome: null },
      });

      expect(result.ok).toBe(true);
    });

    it('passes when context has no metrics_outcome key at all', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: { someOtherKey: 'anything' },
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('other context keys are unaffected', () => {
    it('does not validate non-metrics_outcome context keys', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: {
          metrics_files_changed: 'not_a_number', // would fail if we validated this key
          metrics_lines_added: 'also_not_a_number',
          someOtherKey: 'any_value',
        },
      });

      expect(result.ok).toBe(true);
    });

    it('passes a valid metrics_outcome alongside other keys', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: {
          metrics_outcome: 'success',
          metrics_pr_numbers: [123, 456],
          ticketId: 'TICKET-1',
        },
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('error message is actionable', () => {
    it('error message names the invalid value', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: { metrics_outcome: 'my_custom_outcome' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('my_custom_outcome');
      }
    });

    it('error message includes the tool name', () => {
      const result = checkContextBudget({
        tool: 'continue_workflow',
        context: { metrics_outcome: 'bad' },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('continue_workflow');
      }
    });
  });
});
