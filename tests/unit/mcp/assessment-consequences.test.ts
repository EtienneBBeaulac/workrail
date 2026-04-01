import { describe, it, expect } from 'vitest';
import { evaluateAssessmentConsequences } from '../../../src/mcp/handlers/v2-advance-core/assessment-consequences.js';
import type { WorkflowStepDefinition } from '../../../src/types/workflow-definition.js';
import type { RecordedAssessmentV1 } from '../../../src/mcp/handlers/v2-advance-core/assessment-validation.js';

describe('evaluateAssessmentConsequences', () => {
  const step: WorkflowStepDefinition = {
    id: 'step-1',
    title: 'Step 1',
    prompt: 'Assess the situation.',
    assessmentRefs: ['readiness_gate'],
    assessmentConsequences: [
      {
        when: { dimensionId: 'confidence', equalsLevel: 'low' },
        effect: { kind: 'require_followup', guidance: 'Gather more context before proceeding.' },
      },
    ],
  };

  it('returns a triggered follow-up consequence on exact match', () => {
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
      triggerDimensionId: 'confidence',
      triggerLevel: 'low',
      guidance: 'Gather more context before proceeding.',
    });
  });

  it('returns undefined when the canonical level does not match', () => {
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
