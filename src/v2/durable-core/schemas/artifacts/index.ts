/**
 * Artifact Schemas Index
 * 
 * Typed artifacts for machine-checkable workflow control.
 * These replace brittle substring validation with structured data.
 * 
 * Lock: §19 Evidence-based validation design
 */

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

/**
 * Registry of all artifact contract references.
 * Used for validation and documentation.
 */
export const ARTIFACT_CONTRACT_REFS = [
  'wr.contracts.loop_control',
] as const;

export type ArtifactContractRef = (typeof ARTIFACT_CONTRACT_REFS)[number];

/**
 * Type guard to check if a string is a valid artifact contract reference.
 */
export function isValidContractRef(ref: string): ref is ArtifactContractRef {
  return (ARTIFACT_CONTRACT_REFS as readonly string[]).includes(ref);
}
