import type { ValidationCriteria, ValidationResult } from '../../../types/validation.js';
import type { OutputContract } from '../../../types/workflow-definition.js';
import type { OutputRequirementStatus } from './blocking-decision.js';
import { validateArtifactContract } from './artifact-contract-validator.js';

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
 * @deprecated Use getOutputRequirementStatusWithArtifactsV1 for new code.
 * This function only handles validationCriteria (prose validation).
 * New steps should use outputContract (typed artifact validation).
 * 
 * Returns discriminated union status:
 * - not_required: Step has no validationCriteria
 * - satisfied: Validation criteria met and validation passed
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

  return { kind: 'satisfied' };
}

/**
 * Determine output requirement status with artifact contract support.
 * 
 * This is the preferred validation function that handles both:
 * - outputContract (new): Typed artifact validation (machine-checkable)
 * - validationCriteria (deprecated): Prose validation (substring matching)
 * 
 * Priority order:
 * 1. If outputContract is defined → use artifact validation
 * 2. Else if validationCriteria is defined → use prose validation (legacy)
 * 3. Else → not_required
 * 
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 * 
 * @param args.outputContract - Step's artifact contract (preferred)
 * @param args.artifacts - Agent's output artifacts
 * @param args.validationCriteria - Step's prose validation criteria (deprecated)
 * @param args.notesMarkdown - Agent's output notes
 * @param args.validation - Validation result from ValidationEngine
 * @returns Output requirement status for blocking decision
 */
export function getOutputRequirementStatusWithArtifactsV1(args: {
  readonly outputContract: OutputContract | undefined;
  readonly artifacts: readonly unknown[];
  readonly validationCriteria: ValidationCriteria | undefined;
  readonly notesMarkdown: string | undefined;
  readonly validation: ValidationResult | undefined;
}): OutputRequirementStatus {
  // Priority 1: Artifact contract validation (new, preferred)
  if (args.outputContract) {
    const result = validateArtifactContract(args.artifacts, args.outputContract);
    
    if (!result.valid) {
      const error = result.error;
      
      if (error.code === 'MISSING_REQUIRED_ARTIFACT') {
        return { kind: 'missing', contractRef: error.contractRef };
      }
      
      if (error.code === 'INVALID_ARTIFACT_SCHEMA') {
        // Convert to ValidationResult format for consistency
        const validationResult: ValidationResult = {
          valid: false,
          issues: error.issues.map(issue => issue),
          suggestions: ['Provide a valid artifact matching the contract schema'],
        };
        return { kind: 'invalid', contractRef: error.contractRef, validation: validationResult };
      }
      
      if (error.code === 'UNKNOWN_CONTRACT_REF') {
        // Treat as invariant violation - missing contractRef (shouldn't happen if workflows are valid)
        return { kind: 'missing', contractRef: error.contractRef };
      }
    }
    
    // Artifact validation passed
    return { kind: 'satisfied' };
  }
  
  // Priority 2: Prose validation (legacy, deprecated)
  return getOutputRequirementStatusV1({
    validationCriteria: args.validationCriteria,
    notesMarkdown: args.notesMarkdown,
    validation: args.validation,
  });
}
