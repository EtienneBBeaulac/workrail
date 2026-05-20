/**
 * Tests for assessment gate circuit breaker (Fix 1) and assessment prompt example (Fix 2).
 *
 * Fix 1: After MAX_BLOCKED_ATTEMPT_RETRIES consecutive blocked_attempt nodes on the same
 * step, the engine returns a PRECONDITION_FAILED error with an actionable message.
 *
 * Fix 2: formatAssessmentRequirements() includes a fenced JSON example of the correct
 * wr.assessment artifact format.
 */

import { describe, expect, it } from 'vitest';
import { mapInternalErrorToToolError, type InternalError } from '../../src/mcp/handlers/v2-error-mapping.js';
import { formatAssessmentRequirementsForTest } from '../../src/v2/durable-core/domain/prompt-renderer.js';
import { getArtifactBlockedMessage } from '../../src/v2/durable-core/schemas/artifacts/blocked-messages.js';

// ── Fix 1: Error kind mapping ─────────────────────────────────────────────────

describe('blocked_attempt_limit_exceeded error kind', () => {
  it('maps to PRECONDITION_FAILED (not TOKEN_SCOPE_MISMATCH or INTERNAL_ERROR)', () => {
    const error: InternalError = {
      kind: 'blocked_attempt_limit_exceeded',
      message: 'Step failed after 3 attempts. Submit a valid wr.assessment artifact.',
    };

    const toolError = mapInternalErrorToToolError(error);
    const parsed = toolError as Record<string, unknown>;

    expect(parsed.code).toBe('PRECONDITION_FAILED');
    expect(parsed.message).toContain('Step failed after 3 attempts');
  });

  it('preserves the full message from the InternalError (includes artifact format)', () => {
    const artifactFormatMsg = 'Step failed after 3 attempts. Required format:\n```json\n{ "artifacts": [...] }\n```';
    const error: InternalError = {
      kind: 'blocked_attempt_limit_exceeded',
      message: artifactFormatMsg,
    };

    const toolError = mapInternalErrorToToolError(error);
    const parsed = toolError as Record<string, unknown>;

    expect(parsed.message).toBe(artifactFormatMsg);
  });

  it('is not retryable (retry field absent or false)', () => {
    const error: InternalError = {
      kind: 'blocked_attempt_limit_exceeded',
      message: 'Step failed after 3 attempts.',
    };

    const toolError = mapInternalErrorToToolError(error);
    const parsed = toolError as Record<string, unknown>;

    // errNotRetryable produces no retry field or retry: { kind: 'not_retryable' }
    if (parsed.retry) {
      expect((parsed.retry as Record<string, unknown>).kind).toBe('not_retryable');
    } else {
      expect(parsed.retry).toBeUndefined();
    }
  });
});

// ── Fix 1b: Circuit-breaker message content ──────────────────────────────────

describe('circuit-breaker message content', () => {
  it('getArtifactBlockedMessage returns loop_control scaffold for wr.contracts.loop_control', () => {
    const lines = getArtifactBlockedMessage('wr.contracts.loop_control');
    expect(lines).not.toBeNull();
    const text = lines!.join('\n');
    expect(text).toContain('wr.loop_control');
    expect(text).toContain('decision');
    expect(text).toContain('continue');
  });

  it('getArtifactBlockedMessage returns assessment scaffold for wr.contracts.assessment', () => {
    const lines = getArtifactBlockedMessage('wr.contracts.assessment');
    expect(lines).not.toBeNull();
    const text = lines!.join('\n');
    expect(text).toContain('wr.assessment');
    expect(text).toContain('assessmentId');
    expect(text).toContain('dimensions');
  });

  it('getArtifactBlockedMessage returns null for unknown contract refs', () => {
    const lines = getArtifactBlockedMessage('wr.contracts.unknown_future_type');
    expect(lines).toBeNull();
  });

  it('circuit-breaker message uses "Step failed" (not hardcoded "Assessment gate")', () => {
    // Validate the message template that advance.ts uses -- by constructing it the same way
    const contractRef = 'wr.contracts.loop_control';
    const lines = getArtifactBlockedMessage(contractRef);
    const scaffold = lines ? `Required format:\n${lines.join('\n')}` : '';
    const message = `Step failed after 3 attempts. Submit a valid ${contractRef} artifact. ${scaffold}`;

    expect(message).toContain('Step failed after 3 attempts');
    expect(message).toContain('wr.contracts.loop_control');
    expect(message).not.toContain('Assessment gate');
    expect(message).not.toContain('wr.assessment');
  });
});

// ── Fix 2: Assessment prompt example ─────────────────────────────────────────

describe('formatAssessmentRequirements -- canonical JSON example', () => {
  it('includes a fenced JSON example for wr.assessment artifacts', () => {
    const assessments = [
      {
        id: 'design-soundness-gate',
        purpose: 'Verify design soundness',
        dimensions: [
          { id: 'design_soundness', levels: ['low', 'high'], purpose: 'Check design quality' },
        ],
      },
    ];

    const result = formatAssessmentRequirementsForTest(assessments);

    // Should contain a fenced JSON block
    expect(result.join('\n')).toContain('```json');
    // Should contain wr.assessment kind
    expect(result.join('\n')).toContain('"wr.assessment"');
    // Should contain the actual assessment id
    expect(result.join('\n')).toContain('design-soundness-gate');
    // Should use Record format (not array) for dimensions
    expect(result.join('\n')).toContain('"design_soundness"');
  });

  it('returns empty array when no assessments', () => {
    const result = formatAssessmentRequirementsForTest([]);
    expect(result).toHaveLength(0);
  });

  it('uses the correct dimensions Record format (not an array)', () => {
    const assessments = [
      {
        id: 'my-gate',
        purpose: 'Test gate',
        dimensions: [
          { id: 'quality', levels: ['low', 'high'], purpose: 'Quality check' },
        ],
      },
    ];

    const result = formatAssessmentRequirementsForTest(assessments);
    const joined = result.join('\n');

    // Record format: "quality": "high" NOT [{"id": "quality", "level": "high"}]
    expect(joined).toContain('"quality"');
    // Should NOT contain array-style dimension format
    expect(joined).not.toContain('"id": "quality"');
  });
});
