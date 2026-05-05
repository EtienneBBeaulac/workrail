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

export {
  // Review Verdict
  REVIEW_VERDICT_CONTRACT_REF,
  ReviewVerdictArtifactV1Schema,
  isReviewVerdictArtifact,
  parseReviewVerdictArtifact,
  type ReviewVerdictArtifactV1,
} from './review-verdict.js';

export {
  // Discovery Handoff
  DISCOVERY_HANDOFF_CONTRACT_REF,
  DiscoveryHandoffArtifactV1Schema,
  isDiscoveryHandoffArtifact,
  parseDiscoveryHandoffArtifact,
  type DiscoveryHandoffArtifactV1,
} from './discovery-handoff.js';

export {
  // Phase Handoff (Shaping + Coding + union)
  SHAPING_HANDOFF_CONTRACT_REF,
  ShapingHandoffArtifactV1Schema,
  isShapingHandoffArtifact,
  parseShapingHandoffArtifact,
  type ShapingHandoffArtifactV1,
  CODING_HANDOFF_CONTRACT_REF,
  CodingHandoffArtifactV1Schema,
  isCodingHandoffArtifact,
  parseCodingHandoffArtifact,
  type CodingHandoffArtifactV1,
  type PhaseHandoffArtifact,
} from './phase-handoff.js';

/**
 * Registry of all artifact contract references.
 * Used for validation and documentation.
 */
export const ARTIFACT_CONTRACT_REFS = [
  'wr.contracts.assessment',
  'wr.contracts.loop_control',
  'wr.contracts.coordinator_signal',
  'wr.contracts.review_verdict',
  'wr.contracts.discovery_handoff',
  'wr.contracts.shaping_handoff',
  'wr.contracts.coding_handoff',
] as const;

export type ArtifactContractRef = (typeof ARTIFACT_CONTRACT_REFS)[number];

/**
 * Type guard to check if a string is a valid artifact contract reference.
 */
export function isValidContractRef(ref: string): ref is ArtifactContractRef {
  return (ARTIFACT_CONTRACT_REFS as readonly string[]).includes(ref);
}
