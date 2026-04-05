import type { AssessmentConsequenceDefinition, WorkflowStepDefinition } from '../../../types/workflow-definition.js';
import type { RecordedAssessmentV1 } from '../../../v2/durable-core/domain/assessment-record.js';

export interface TriggeredAssessmentConsequenceV1 {
  readonly kind: 'require_followup';
  readonly assessmentId: string;
  readonly firstMatchedDimensionId: string;
  readonly triggerLevel: string;
  readonly guidance: string;
}

export function evaluateAssessmentConsequences(args: {
  readonly step: WorkflowStepDefinition | undefined;
  readonly recordedAssessment: RecordedAssessmentV1 | undefined;
}): TriggeredAssessmentConsequenceV1 | undefined {
  if (!args.step?.assessmentConsequences || args.step.assessmentConsequences.length === 0) return undefined;
  if (!args.recordedAssessment) return undefined;

  const consequence = args.step.assessmentConsequences[0];
  if (!consequence) return undefined;

  const matched = args.recordedAssessment.dimensions.find(d => d.level === consequence.when.anyEqualsLevel);
  if (!matched) return undefined;

  return {
    kind: 'require_followup',
    assessmentId: args.recordedAssessment.assessmentId,
    firstMatchedDimensionId: matched.dimensionId,
    triggerLevel: consequence.when.anyEqualsLevel,
    guidance: consequence.effect.guidance,
  };
}

export function getDeclaredAssessmentConsequence(
  step: WorkflowStepDefinition | undefined,
): AssessmentConsequenceDefinition | undefined {
  return step?.assessmentConsequences?.[0];
}
