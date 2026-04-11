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
    const recorded: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'confidence', level: 'low', normalization: 'exact' },
      ],
    };

    expect(
      evaluateAssessmentConsequences({ step, recordedAssessments: [recorded] })
    ).toEqual({
      kind: 'require_followup',
      assessmentId: 'readiness_gate',
      firstMatchedDimensionId: 'confidence',
      triggerLevel: 'low',
      guidance: 'Gather more context before proceeding.',
    });
  });

  it('returns undefined when the dimension does not match', () => {
    const recorded: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'confidence', level: 'high', normalization: 'exact' },
      ],
    };

    expect(evaluateAssessmentConsequences({ step, recordedAssessments: [recorded] })).toBeUndefined();
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
    const recorded: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'evidence_quality', level: 'low', normalization: 'exact' },
        { dimensionId: 'coverage_completeness', level: 'high', normalization: 'exact' },
        { dimensionId: 'contradiction_resolution', level: 'high', normalization: 'exact' },
      ],
    };

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessments: [recorded] })).toEqual({
      kind: 'require_followup',
      assessmentId: 'readiness_gate',
      firstMatchedDimensionId: 'evidence_quality',
      triggerLevel: 'low',
      guidance: 'Address all low dimensions before proceeding.',
    });
  });

  it('fires when a non-first dimension is low', () => {
    const recorded: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'evidence_quality', level: 'high', normalization: 'exact' },
        { dimensionId: 'coverage_completeness', level: 'high', normalization: 'exact' },
        { dimensionId: 'contradiction_resolution', level: 'low', normalization: 'exact' },
      ],
    };

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessments: [recorded] })).toEqual({
      kind: 'require_followup',
      assessmentId: 'readiness_gate',
      firstMatchedDimensionId: 'contradiction_resolution',
      triggerLevel: 'low',
      guidance: 'Address all low dimensions before proceeding.',
    });
  });

  it('returns the first matched dimension when multiple are low', () => {
    const recorded: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'evidence_quality', level: 'low', normalization: 'exact' },
        { dimensionId: 'coverage_completeness', level: 'low', normalization: 'exact' },
        { dimensionId: 'contradiction_resolution', level: 'high', normalization: 'exact' },
      ],
    };

    const result = evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessments: [recorded] });
    expect(result?.firstMatchedDimensionId).toBe('evidence_quality');
    expect(result?.triggerLevel).toBe('low');
  });

  it('does not fire when all dimensions are high', () => {
    const recorded: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'evidence_quality', level: 'high', normalization: 'exact' },
        { dimensionId: 'coverage_completeness', level: 'high', normalization: 'exact' },
        { dimensionId: 'contradiction_resolution', level: 'high', normalization: 'exact' },
      ],
    };

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessments: [recorded] })).toBeUndefined();
  });

  it('does not fire when no dimensions are present', () => {
    const recorded: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [],
    };

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessments: [recorded] })).toBeUndefined();
  });

  it('fires on the first matching assessment when multiple refs are present', () => {
    const qualityGate: RecordedAssessmentV1 = {
      assessmentId: 'quality_gate',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'depth', level: 'high', normalization: 'exact' }],
    };
    const coverageGate: RecordedAssessmentV1 = {
      assessmentId: 'coverage_gate',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'completeness', level: 'low', normalization: 'exact' }],
    };
    const stepMultiRef: WorkflowStepDefinition = {
      id: 'multi-step',
      title: 'Multi-ref Gate',
      prompt: 'Assess.',
      assessmentRefs: ['quality_gate', 'coverage_gate'],
      assessmentConsequences: [
        { when: { anyEqualsLevel: 'low' }, effect: { kind: 'require_followup', guidance: 'Fix before proceeding.' } },
      ],
    };

    const result = evaluateAssessmentConsequences({ step: stepMultiRef, recordedAssessments: [qualityGate, coverageGate] });
    expect(result).toEqual({
      kind: 'require_followup',
      assessmentId: 'coverage_gate',
      firstMatchedDimensionId: 'completeness',
      triggerLevel: 'low',
      guidance: 'Fix before proceeding.',
    });
  });

  it('does not fire when all dimensions across multiple refs are high', () => {
    const qualityGate: RecordedAssessmentV1 = {
      assessmentId: 'quality_gate',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'depth', level: 'high', normalization: 'exact' }],
    };
    const coverageGate: RecordedAssessmentV1 = {
      assessmentId: 'coverage_gate',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'completeness', level: 'high', normalization: 'exact' }],
    };
    const stepMultiRef: WorkflowStepDefinition = {
      id: 'multi-step',
      title: 'Multi-ref Gate',
      prompt: 'Assess.',
      assessmentRefs: ['quality_gate', 'coverage_gate'],
      assessmentConsequences: [
        { when: { anyEqualsLevel: 'low' }, effect: { kind: 'require_followup', guidance: 'Fix before proceeding.' } },
      ],
    };

    expect(evaluateAssessmentConsequences({ step: stepMultiRef, recordedAssessments: [qualityGate, coverageGate] })).toBeUndefined();
  });
});
