import { describe, it, expect } from 'vitest';
import { evaluateAssessmentConsequences } from '../../../src/mcp/handlers/v2-advance-core/assessment-consequences.js';
import type { WorkflowStepDefinition } from '../../../src/types/workflow-definition.js';
import type { RecordedAssessmentV1 } from '../../../src/mcp/handlers/v2-advance-core/assessment-validation.js';

describe('evaluateAssessmentConsequences -- single consequence, single dimension', () => {
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
    ).toEqual([{
      kind: 'require_followup',
      assessmentId: 'readiness_gate',
      dimensionId: 'confidence',
      triggerLevel: 'low',
      guidance: 'Gather more context before proceeding.',
    }]);
  });

  it('returns empty array when the dimension does not match', () => {
    const recorded: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'confidence', level: 'high', normalization: 'exact' },
      ],
    };

    expect(evaluateAssessmentConsequences({ step, recordedAssessments: [recorded] })).toEqual([]);
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

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessments: [recorded] })).toEqual([{
      kind: 'require_followup',
      assessmentId: 'readiness_gate',
      dimensionId: 'evidence_quality',
      triggerLevel: 'low',
      guidance: 'Address all low dimensions before proceeding.',
    }]);
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

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessments: [recorded] })).toEqual([{
      kind: 'require_followup',
      assessmentId: 'readiness_gate',
      dimensionId: 'contradiction_resolution',
      triggerLevel: 'low',
      guidance: 'Address all low dimensions before proceeding.',
    }]);
  });

  it('returns the first matched dimension when multiple dimensions are low (one consequence fires once)', () => {
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
    expect(result).toHaveLength(1);
    expect(result[0]?.dimensionId).toBe('evidence_quality');
    expect(result[0]?.triggerLevel).toBe('low');
  });

  it('returns empty array when all dimensions are high', () => {
    const recorded: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [
        { dimensionId: 'evidence_quality', level: 'high', normalization: 'exact' },
        { dimensionId: 'coverage_completeness', level: 'high', normalization: 'exact' },
        { dimensionId: 'contradiction_resolution', level: 'high', normalization: 'exact' },
      ],
    };

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessments: [recorded] })).toEqual([]);
  });

  it('returns empty array when no dimensions are present', () => {
    const recorded: RecordedAssessmentV1 = {
      assessmentId: 'readiness_gate',
      normalizationNotes: [],
      dimensions: [],
    };

    expect(evaluateAssessmentConsequences({ step: stepWithAnyTrigger, recordedAssessments: [recorded] })).toEqual([]);
  });

  it('fires on the matching assessment when multiple refs are present', () => {
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
    expect(result).toEqual([{
      kind: 'require_followup',
      assessmentId: 'coverage_gate',
      dimensionId: 'completeness',
      triggerLevel: 'low',
      guidance: 'Fix before proceeding.',
    }]);
  });

  it('returns empty array when all dimensions across multiple refs are high', () => {
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

    expect(evaluateAssessmentConsequences({ step: stepMultiRef, recordedAssessments: [qualityGate, coverageGate] })).toEqual([]);
  });
});

describe('evaluateAssessmentConsequences -- multiple consequences', () => {
  it('fires all matching consequences independently', () => {
    const step: WorkflowStepDefinition = {
      id: 'multi-gate',
      title: 'Multi-gate Step',
      prompt: 'Assess.',
      assessmentRefs: ['constraint_gate', 'type_gate'],
      assessmentConsequences: [
        {
          when: { anyEqualsLevel: 'low' },
          effect: { kind: 'require_followup', guidance: 'Rewrite vague constraints.' },
        },
        {
          when: { anyEqualsLevel: 'unsound' },
          effect: { kind: 'require_followup', guidance: 'Redesign unsound types as explicit variants.' },
        },
      ],
    };

    const constraintAssessment: RecordedAssessmentV1 = {
      assessmentId: 'constraint_gate',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'specificity', level: 'low', normalization: 'exact' }],
    };
    const typeAssessment: RecordedAssessmentV1 = {
      assessmentId: 'type_gate',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'soundness', level: 'unsound', normalization: 'exact' }],
    };

    const result = evaluateAssessmentConsequences({ step, recordedAssessments: [constraintAssessment, typeAssessment] });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      kind: 'require_followup',
      assessmentId: 'constraint_gate',
      dimensionId: 'specificity',
      triggerLevel: 'low',
      guidance: 'Rewrite vague constraints.',
    });
    expect(result[1]).toEqual({
      kind: 'require_followup',
      assessmentId: 'type_gate',
      dimensionId: 'soundness',
      triggerLevel: 'unsound',
      guidance: 'Redesign unsound types as explicit variants.',
    });
  });

  it('fires only the consequences whose level matches', () => {
    const step: WorkflowStepDefinition = {
      id: 'partial-gate',
      title: 'Partial Gate',
      prompt: 'Assess.',
      assessmentRefs: ['gate_a', 'gate_b'],
      assessmentConsequences: [
        {
          when: { anyEqualsLevel: 'low' },
          effect: { kind: 'require_followup', guidance: 'Fix low.' },
        },
        {
          when: { anyEqualsLevel: 'unsound' },
          effect: { kind: 'require_followup', guidance: 'Fix unsound.' },
        },
      ],
    };

    const gateA: RecordedAssessmentV1 = {
      assessmentId: 'gate_a',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'quality', level: 'low', normalization: 'exact' }],
    };
    const gateB: RecordedAssessmentV1 = {
      assessmentId: 'gate_b',
      normalizationNotes: [],
      // 'sound' -- does not match 'unsound'
      dimensions: [{ dimensionId: 'soundness', level: 'sound', normalization: 'exact' }],
    };

    const result = evaluateAssessmentConsequences({ step, recordedAssessments: [gateA, gateB] });
    expect(result).toHaveLength(1);
    expect(result[0]?.triggerLevel).toBe('low');
    expect(result[0]?.guidance).toBe('Fix low.');
  });

  it('returns empty array when no consequence level matches', () => {
    const step: WorkflowStepDefinition = {
      id: 'no-match-gate',
      title: 'No Match',
      prompt: 'Assess.',
      assessmentRefs: ['gate_a'],
      assessmentConsequences: [
        { when: { anyEqualsLevel: 'low' }, effect: { kind: 'require_followup', guidance: 'Fix.' } },
        { when: { anyEqualsLevel: 'unsound' }, effect: { kind: 'require_followup', guidance: 'Redesign.' } },
      ],
    };

    const gateA: RecordedAssessmentV1 = {
      assessmentId: 'gate_a',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'quality', level: 'high', normalization: 'exact' }],
    };

    expect(evaluateAssessmentConsequences({ step, recordedAssessments: [gateA] })).toEqual([]);
  });
});

describe('evaluateAssessmentConsequences -- forAssessment scoping', () => {
  it('fires only the consequence scoped to the assessment that matched', () => {
    const step: WorkflowStepDefinition = {
      id: 'scoped-gate',
      title: 'Scoped Gate',
      prompt: 'Assess.',
      assessmentRefs: ['constraint_gate', 'type_gate'],
      assessmentConsequences: [
        {
          when: { anyEqualsLevel: 'low', forAssessment: 'constraint_gate' },
          effect: { kind: 'require_followup', guidance: 'Fix constraint specificity.' },
        },
        {
          when: { anyEqualsLevel: 'low', forAssessment: 'type_gate' },
          effect: { kind: 'require_followup', guidance: 'Redesign unsound types.' },
        },
      ],
    };

    // Only constraint_gate is low -- type_gate is high.
    const constraintAssessment: RecordedAssessmentV1 = {
      assessmentId: 'constraint_gate',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'specificity', level: 'low', normalization: 'exact' }],
    };
    const typeAssessment: RecordedAssessmentV1 = {
      assessmentId: 'type_gate',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'soundness', level: 'high', normalization: 'exact' }],
    };

    const result = evaluateAssessmentConsequences({ step, recordedAssessments: [constraintAssessment, typeAssessment] });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: 'require_followup',
      assessmentId: 'constraint_gate',
      dimensionId: 'specificity',
      triggerLevel: 'low',
      guidance: 'Fix constraint specificity.',
    });
  });

  it('fires both scoped consequences when both assessments match', () => {
    const step: WorkflowStepDefinition = {
      id: 'both-low-gate',
      title: 'Both Low Gate',
      prompt: 'Assess.',
      assessmentRefs: ['constraint_gate', 'type_gate'],
      assessmentConsequences: [
        {
          when: { anyEqualsLevel: 'low', forAssessment: 'constraint_gate' },
          effect: { kind: 'require_followup', guidance: 'Fix constraints.' },
        },
        {
          when: { anyEqualsLevel: 'low', forAssessment: 'type_gate' },
          effect: { kind: 'require_followup', guidance: 'Fix types.' },
        },
      ],
    };

    const constraintAssessment: RecordedAssessmentV1 = {
      assessmentId: 'constraint_gate',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'specificity', level: 'low', normalization: 'exact' }],
    };
    const typeAssessment: RecordedAssessmentV1 = {
      assessmentId: 'type_gate',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'soundness', level: 'low', normalization: 'exact' }],
    };

    const result = evaluateAssessmentConsequences({ step, recordedAssessments: [constraintAssessment, typeAssessment] });
    expect(result).toHaveLength(2);
    expect(result[0]?.guidance).toBe('Fix constraints.');
    expect(result[1]?.guidance).toBe('Fix types.');
  });

  it('does not fire a scoped consequence for an assessment that scored high', () => {
    const step: WorkflowStepDefinition = {
      id: 'none-low-gate',
      title: 'None Low Gate',
      prompt: 'Assess.',
      assessmentRefs: ['gate_a'],
      assessmentConsequences: [
        {
          when: { anyEqualsLevel: 'low', forAssessment: 'gate_a' },
          effect: { kind: 'require_followup', guidance: 'Fix gate_a.' },
        },
      ],
    };

    const assessment: RecordedAssessmentV1 = {
      assessmentId: 'gate_a',
      normalizationNotes: [],
      dimensions: [{ dimensionId: 'quality', level: 'high', normalization: 'exact' }],
    };

    expect(evaluateAssessmentConsequences({ step, recordedAssessments: [assessment] })).toEqual([]);
  });
});
