/**
 * Artifact Schemas Index
 * 
 * Typed artifacts for machine-checkable workflow control.
 * These replace brittle substring validation with structured data.
 * 
 * Lock: §19 Evidence-based validation design
 */

export {
  // Assessment
  ASSESSMENT_CONTRACT_REF,
  AssessmentArtifactV1Schema,
  AssessmentDimensionSubmissionSchema,
  isAssessmentArtifact,
  parseAssessmentArtifact,
  type AssessmentArtifactV1,
  type AssessmentDimensionSubmission,
} from './assessment.js';

export {
  // Loop Control
  LOOP_CONTROL_CONTRACT_REF,
  LoopControlDecisionSchema,
  LoopControlMetadataV1Schema,
  LoopControlArtifactV1Schema,
  isLoopControlArtifact,
  parseLoopControlArtifact,
  findLoopControlArtifact,
  type LoopControlDecision,
  type LoopControlMetadataV1,
  type LoopControlArtifactV1,
} from './loop-control.js';

export {
  // Coordinator Signal
  COORDINATOR_SIGNAL_CONTRACT_REF,
  CoordinatorSignalKindSchema,
  CoordinatorSignalArtifactV1Schema,
  isCoordinatorSignalArtifact,
  parseCoordinatorSignalArtifact,
  type CoordinatorSignalKind,
  type CoordinatorSignalArtifactV1,
} from './coordinator-signal.js';

/**
 * Registry of all artifact contract references.
 * Used for validation and documentation.
 */
export const ARTIFACT_CONTRACT_REFS = [
  'wr.contracts.assessment',
  'wr.contracts.loop_control',
  'wr.contracts.coordinator_signal',
] as const;

export type ArtifactContractRef = (typeof ARTIFACT_CONTRACT_REFS)[number];

/**
 * Type guard to check if a string is a valid artifact contract reference.
 */
export function isValidContractRef(ref: string): ref is ArtifactContractRef {
  return (ARTIFACT_CONTRACT_REFS as readonly string[]).includes(ref);
}
