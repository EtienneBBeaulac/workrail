import { isStandardStepDefinition, type WorkflowDefinition } from '../types/workflow-definition.js';

/** Enrollment and retained admission must agree on the executable subset. */
export function classifyAnswerWorkflow(definition: WorkflowDefinition): 'notes' | 'review' | 'unsupported' {
  if (definition.steps.length === 0 || !definition.steps.every(step => isStandardStepDefinition(step)
    && !step.requireConfirmation && !step.validationCriteria && !step.assessmentRefs && !step.runCondition
    && (!step.outputContract || step.outputContract.contractRef === 'wr.contracts.review_verdict'))) return 'unsupported';
  return definition.steps.some(step => isStandardStepDefinition(step) && step.outputContract?.contractRef === 'wr.contracts.review_verdict')
    ? 'review' : 'notes';
}
