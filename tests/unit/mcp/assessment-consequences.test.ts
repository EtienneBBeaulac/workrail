import { describe, it, expect } from 'vitest';
import { evaluateAssessmentConsequences } from '../../../src/mcp/handlers/v2-advance-core/assessment-consequences.js';
import type { WorkflowStepDefinition } from '../../../src/types/workflow-definition.js';
import type { RecordedAssessmentV1 } from '../../../src/mcp/handlers/v2-advance-core/assessment-validation.js';

describe('evaluateAssessmentConsequences -- single dimension (equivalent to exact match)', () => {
  const step: WorkflowStepDefinition = {
    id: 'step-1',
    title: 'Step 1',
    prompt: 'Assess the situation.',
    assessmentRefs: ['readiness_gate'],
    assessmentConsequences: [
      {
        when: { anyEqualsLevel: 'low' },
        effect: { kind: 'require_followup', guidance: 'Gather more context before proceeding.' },
      },
    ],
  };

  it('fires when the single dimension equals the level', () => {
    const recordedAssessment: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'confidence', level: 'low', normalization: 'exact' },
      ],
    };

    expect(
      evaluateAssessmentConsequences({ step, recordedAssessment })
    ).toEqual({
      kind: 'require_followup',
      assessmentId: 'readiness_gate',
      firstMatchedDimensionId: 'confidence',
      triggerLevel: 'low',
      guidance: 'Gather more context before proceeding.',
    });
  });

  it('returns undefined when the dimension does not match', () => {
    const recordedAssessment: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'confidence', level: 'high', normalization: 'exact' },
      ],
    };

    expect(evaluateAssessmentConsequences({ step, recordedAssessment })).toBeUndefined();
  });
});

describe('evaluateAssessmentConsequences -- anyEqualsLevel trigger', () => {
  const stepWithAnyTrigger: WorkflowStepDefinition = {
    id: 'step-review',
    title: 'Review Gate',
    prompt: 'Assess readiness.',
    assessmentRefs: ['readiness_gate'],
    assessmentConsequences: [
      {
        when: { anyEqualsLevel: 'low' },
        effect: { kind: 'require_followup', guidance: 'Address all low dimensions before proceeding.' },
      },
    ],
  };

  it('fires when the first dimension is low', () => {
    const recordedAssessment: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'evidence_quality', level: 'low', normalization: 'exact' },
        { dimensionId: 'coverage_completeness', level: 'high', normalization: 'exact' },
        { dimensionId: 'contradiction_resolution', level: 'high', normalization: 'exact' },
      ],
    };

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessment })).toEqual({
      kind: 'require_followup',
      assessmentId: 'readiness_gate',
      firstMatchedDimensionId: 'evidence_quality',
      triggerLevel: 'low',
      guidance: 'Address all low dimensions before proceeding.',
    });
  });

  it('fires when a non-first dimension is low', () => {
    const recordedAssessment: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'evidence_quality', level: 'high', normalization: 'exact' },
        { dimensionId: 'coverage_completeness', level: 'high', normalization: 'exact' },
        { dimensionId: 'contradiction_resolution', level: 'low', normalization: 'exact' },
      ],
    };

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessment })).toEqual({
      kind: 'require_followup',
      assessmentId: 'readiness_gate',
      firstMatchedDimensionId: 'contradiction_resolution',
      triggerLevel: 'low',
      guidance: 'Address all low dimensions before proceeding.',
    });
  });

  it('returns the first matched dimension when multiple are low', () => {
    const recordedAssessment: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'evidence_quality', level: 'low', normalization: 'exact' },
        { dimensionId: 'coverage_completeness', level: 'low', normalization: 'exact' },
        { dimensionId: 'contradiction_resolution', level: 'high', normalization: 'exact' },
      ],
    };

    const result = evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessment });
    expect(result?.firstMatchedDimensionId).toBe('evidence_quality');
    expect(result?.triggerLevel).toBe('low');
  });

  it('does not fire when all dimensions are high', () => {
    const recordedAssessment: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'evidence_quality', level: 'high', normalization: 'exact' },
        { dimensionId: 'coverage_completeness', level: 'high', normalization: 'exact' },
        { dimensionId: 'contradiction_resolution', level: 'high', normalization: 'exact' },
      ],
    };

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessment })).toBeUndefined();
  });

  it('does not fire when no dimensions are present', () => {
    const recordedAssessment: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [],
    };

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessment })).toBeUndefined();
  });
});
