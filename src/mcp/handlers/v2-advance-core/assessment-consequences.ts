import type { AssessmentConsequenceDefinition, WorkflowStepDefinition } from '../../../types/workflow-definition.js';
import type { RecordedAssessmentV1 } from '../../../v2/durable-core/domain/assessment-record.js';

export interface TriggeredAssessmentConsequenceV1 {
  readonly kind: 'require_followup';
  readonly assessmentId: string;
  readonly triggerDimensionId: string;
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

  const matchedDimension = args.recordedAssessment.dimensions.find(
    dimension =>
      dimension.dimensionId === consequence.when.dimensionId &&
      dimension.level === consequence.when.equalsLevel,
  );
  if (!matchedDimension) return undefined;

  return {
    kind: 'require_followup',
    assessmentId: args.recordedAssessment.assessmentId,
    triggerDimensionId: consequence.when.dimensionId,
    triggerLevel: consequence.when.equalsLevel,
    guidance: consequence.effect.guidance,
  };
}

export function getDeclaredAssessmentConsequence(
  step: WorkflowStepDefinition | undefined,
): AssessmentConsequenceDefinition | undefined {
  return step?.assessmentConsequences?.[0];
}
