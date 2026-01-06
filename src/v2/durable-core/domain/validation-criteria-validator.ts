import type { ValidationCriteria, ValidationResult } from '../../../types/validation.js';
import type { OutputRequirementStatus } from './blocking-decision.js';

export const VALIDATION_CRITERIA_CONTRACT_REF = 'wr.validationCriteria' as const;

/**
 * Determine output requirement status based on validation criteria.
 * 
 * Used in blocking decision logic to detect missing or invalid required outputs.
 * When a step declares validationCriteria, this function checks if the agent's
 * output.notesMarkdown meets the requirements.
 * 
 * Lock: §13 Required output enforcement (current authoring contract mechanism)
 * 
 * Returns discriminated union status:
 * - not_required: Step has no validationCriteria
 * - missing: Step requires output but notesMarkdown not provided
 * - invalid: Output provided but validation failed (issues present)
 * 
 * @param args.validationCriteria - Step's output requirements (if any)
 * @param args.notesMarkdown - Agent's output notes (if provided)
 * @param args.validation - Validation result from ValidationEngine
 * @returns Output requirement status for blocking decision
 */
export function getOutputRequirementStatusV1(args: {
  readonly validationCriteria: ValidationCriteria | undefined;
  readonly notesMarkdown: string | undefined;
  readonly validation: ValidationResult | undefined;
}): OutputRequirementStatus {
  if (!args.validationCriteria) return { kind: 'not_required' };

  if (!args.notesMarkdown) {
    return { kind: 'missing', contractRef: VALIDATION_CRITERIA_CONTRACT_REF };
  }

  if (args.validation && !args.validation.valid) {
    return { kind: 'invalid', contractRef: VALIDATION_CRITERIA_CONTRACT_REF, validation: args.validation };
  }

  return { kind: 'not_required' };
}
