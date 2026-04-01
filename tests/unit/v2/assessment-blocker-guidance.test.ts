import { describe, it, expect } from 'vitest';
import { reasonToBlocker } from '../../../src/v2/durable-core/domain/reason-model.js';
import { ASSESSMENT_CONTRACT_REF } from '../../../src/v2/durable-core/schemas/artifacts/index.js';

describe('assessment blocker guidance', () => {
  it('uses artifact-oriented guidance for missing assessment output', () => {
    const result = reasonToBlocker({
      kind: 'missing_required_output',
      contractRef: ASSESSMENT_CONTRACT_REF,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.suggestedFix).toContain('output.artifacts');
      expect(result.value.suggestedFix).toContain('wr.assessment');
      expect(result.value.suggestedFix).not.toContain('output.notesMarkdown');
    }
  });

  it('uses artifact-oriented guidance for invalid assessment output', () => {
    const result = reasonToBlocker({
      kind: 'invalid_required_output',
      contractRef: ASSESSMENT_CONTRACT_REF,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.suggestedFix).toContain('assessment artifact');
      expect(result.value.suggestedFix).toContain('output.artifacts');
      expect(result.value.suggestedFix).not.toContain('output.notesMarkdown');
    }
  });

  it('uses same-step follow-up guidance for matched assessment consequences', () => {
    const result = reasonToBlocker({
      kind: 'assessment_followup_required',
      assessmentId: 'readiness_gate',
      dimensionId: 'confidence',
      level: 'low',
      guidance: 'Gather more context before proceeding.',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.code).toBe('ASSESSMENT_FOLLOWUP_REQUIRED');
      expect(result.value.message).toContain('Follow-up required before this step can proceed');
      expect(result.value.suggestedFix).toContain('Stay on this step');
      expect(result.value.suggestedFix).toContain('Gather more context before proceeding.');
      expect(result.value.suggestedFix).not.toContain('rehydrate');
    }
  });
});
