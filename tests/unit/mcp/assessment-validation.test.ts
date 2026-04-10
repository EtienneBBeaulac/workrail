import { describe, it, expect } from 'vitest';
import { validateAssessmentForStep } from '../../../src/mcp/handlers/v2-advance-core/assessment-validation.js';
import type { AssessmentDefinition, WorkflowStepDefinition } from '../../../src/types/workflow-definition.js';
import { ASSESSMENT_CONTRACT_REF } from '../../../src/v2/durable-core/schemas/artifacts/index.js';

const assessment: AssessmentDefinition = {
  id: 'readiness_gate',
  purpose: 'Assess readiness before continuing.',
  dimensions: [
    {
      id: 'confidence',
      purpose: 'How confident the agent is.',
      levels: ['low', 'medium', 'high'],
    },
    {
      id: 'scope',
      purpose: 'How complete the understanding is.',
      levels: ['partial', 'complete'],
    },
  ],
};

const step: WorkflowStepDefinition = {
  id: 'step-1',
  title: 'Step 1',
  prompt: 'Assess readiness.',
  assessmentRefs: ['readiness_gate'],
};

describe('validateAssessmentForStep', () => {
  it('accepts canonical assessment artifacts', () => {
    const result = validateAssessmentForStep({
      step,
      assessments: [assessment],
      artifacts: [
        {
          kind: 'wr.assessment',
          assessmentId: 'readiness_gate',
          dimensions: {
            confidence: 'high',
            scope: 'complete',
          },
        },
      ],
    });

    expect(result?.contractRef).toBe(ASSESSMENT_CONTRACT_REF);
    expect(result?.validation.valid).toBe(true);
    expect(result?.acceptedArtifacts[0]?.artifact).toBeDefined();
    expect(result?.acceptedArtifacts[0]?.artifactIndex).toBe(0);
    expect(result?.recordedAssessments[0]).toEqual({
      assessmentId: 'readiness_gate',
      summary: undefined,
      normalizationNotes: [],
      dimensions: [
        {
          dimensionId: 'confidence',
          level: 'high',
          normalization: 'exact',
          rationale: undefined,
        },
        {
          dimensionId: 'scope',
          level: 'complete',
          normalization: 'exact',
          rationale: undefined,
        },
      ],
    });
  });

  it('normalizes safe case-only near misses without failing', () => {
    const result = validateAssessmentForStep({
      step,
      assessments: [assessment],
      artifacts: [
        {
          kind: 'wr.assessment',
          assessmentId: 'readiness_gate',
          dimensions: {
            confidence: 'HIGH',
            scope: 'COMPLETE',
          },
        },
      ],
    });

    expect(result?.validation.valid).toBe(true);
    expect(result?.validation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Normalized level "HIGH"'),
        expect.stringContaining('Normalized level "COMPLETE"'),
      ]),
    );
    expect(result?.recordedAssessments[0]?.dimensions).toEqual([
      {
        dimensionId: 'confidence',
        level: 'high',
        normalization: 'normalized',
        rationale: undefined,
      },
      {
        dimensionId: 'scope',
        level: 'complete',
        normalization: 'normalized',
        rationale: undefined,
      },
    ]);
  });

  it('rejects missing required dimensions', () => {
    const result = validateAssessmentForStep({
      step,
      assessments: [assessment],
      artifacts: [
        {
          kind: 'wr.assessment',
          assessmentId: 'readiness_gate',
          dimensions: {
            confidence: 'high',
          },
        },
      ],
    });

    expect(result?.validation.valid).toBe(false);
    expect(result?.validation.issues).toEqual(expect.arrayContaining([expect.stringContaining('Missing assessment dimension "scope"')]));
  });

  it('rejects unknown dimension values without silent coercion', () => {
    const result = validateAssessmentForStep({
      step,
      assessments: [assessment],
      artifacts: [
        {
          kind: 'wr.assessment',
          assessmentId: 'readiness_gate',
          dimensions: {
            confidence: 'very-high',
            scope: 'complete',
          },
        },
      ],
    });

    expect(result?.validation.valid).toBe(false);
    expect(result?.validation.issues).toEqual(expect.arrayContaining([expect.stringContaining('Level "very-high" is not allowed')]));
  });

  it('rejects artifacts targeting the wrong assessment id', () => {
    const result = validateAssessmentForStep({
      step,
      assessments: [assessment],
      artifacts: [
        {
          kind: 'wr.assessment',
          assessmentId: 'other_gate',
          dimensions: {
            confidence: 'high',
            scope: 'complete',
          },
        },
      ],
    });

    expect(result?.validation.valid).toBe(false);
    expect(result?.validation.issues).toEqual(expect.arrayContaining([expect.stringContaining('expects "readiness_gate"')]));
  });
});
