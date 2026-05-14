import type { WorkflowStepDefinition } from '../../../types/workflow-definition.js';
import type { RecordedAssessmentV1 } from '../../../v2/durable-core/domain/assessment-record.js';

export interface TriggeredAssessmentConsequenceV1 {
  readonly kind: 'require_followup';
  readonly assessmentId: string;
  readonly dimensionId: string;
  readonly triggerLevel: string;
  readonly guidance: string;
}

/**
 * Evaluate all assessment consequences declared on a step.
 *
 * Each consequence is evaluated independently against all recorded assessments.
 * A consequence fires when ANY dimension across ANY recorded assessment equals
 * its anyEqualsLevel. Multiple consequences with distinct trigger levels can
 * fire in the same call -- callers receive one entry per fired consequence.
 *
 * Returns an empty array when no consequences fire (never returns undefined).
 * Evaluation order follows the declaration order in assessmentConsequences.
 */
export function evaluateAssessmentConsequences(args: {
  readonly step: WorkflowStepDefinition | undefined;
  readonly recordedAssessments: readonly RecordedAssessmentV1[];
}): readonly TriggeredAssessmentConsequenceV1[] {
  if (!args.step?.assessmentConsequences || args.step.assessmentConsequences.length === 0) return [];
  if (args.recordedAssessments.length === 0) return [];

  const triggered: TriggeredAssessmentConsequenceV1[] = [];

  for (const consequence of args.step.assessmentConsequences) {
    const scopedToAssessment = consequence.when.forAssessment;

    // When forAssessment is set, only the named assessment is checked.
    // When absent, all recorded assessments are scanned -- the first match fires.
    const candidateAssessments = scopedToAssessment
      ? args.recordedAssessments.filter(r => r.assessmentId === scopedToAssessment)
      : args.recordedAssessments;

    for (const recorded of candidateAssessments) {
      const matched = recorded.dimensions.find(d => d.level === consequence.when.anyEqualsLevel);
      if (matched) {
        triggered.push({
          kind: 'require_followup',
          assessmentId: recorded.assessmentId,
          dimensionId: matched.dimensionId,
          triggerLevel: consequence.when.anyEqualsLevel,
          guidance: consequence.effect.guidance,
        });
        break; // This consequence fired -- move to the next one.
      }
    }
  }

  return triggered;
}
