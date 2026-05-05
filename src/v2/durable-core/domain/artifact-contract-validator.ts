import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { OutputContract } from '../../../types/workflow-definition.js';
import {
  LOOP_CONTROL_CONTRACT_REF,
  LoopControlArtifactV1Schema,
  isLoopControlArtifact,
  isValidContractRef,
  type LoopControlArtifactV1,
  COORDINATOR_SIGNAL_CONTRACT_REF,
  CoordinatorSignalArtifactV1Schema,
  isCoordinatorSignalArtifact,
  REVIEW_VERDICT_CONTRACT_REF,
  ReviewVerdictArtifactV1Schema,
  isReviewVerdictArtifact,
  DISCOVERY_HANDOFF_CONTRACT_REF,
  DiscoveryHandoffArtifactV1Schema,
  isDiscoveryHandoffArtifact,
  SHAPING_HANDOFF_CONTRACT_REF,
  ShapingHandoffArtifactV1Schema,
  isShapingHandoffArtifact,
  CODING_HANDOFF_CONTRACT_REF,
  CodingHandoffArtifactV1Schema,
  isCodingHandoffArtifact,
} from '../schemas/artifacts/index.js';

/**
 * Artifact contract validation errors.
 * Forms a closed set for deterministic error handling.
 */
export type ArtifactContractValidationError =
  | { readonly code: 'MISSING_REQUIRED_ARTIFACT'; readonly contractRef: string; readonly message: string }
  | { readonly code: 'INVALID_ARTIFACT_SCHEMA'; readonly contractRef: string; readonly message: string; readonly issues: readonly string[] }
  | { readonly code: 'UNKNOWN_CONTRACT_REF'; readonly contractRef: string; readonly message: string };

/**
 * Artifact contract validation result.
 */
export type ArtifactContractValidationResult =
  | { readonly valid: true; readonly artifact: unknown }
  | { readonly valid: false; readonly error: ArtifactContractValidationError };

/**
 * Validate artifacts against an output contract.
 * 
 * This is a pure function that:
 * 1. Checks if the contract reference is known
 * 2. Searches for an artifact matching the contract
 * 3. Validates the artifact against the contract schema
 * 
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 * 
 * @param artifacts - Array of unknown artifacts from agent output
 * @param contract - The output contract to validate against
 * @returns Validation result (valid with artifact, or invalid with error)
 */
export function validateArtifactContract(
  artifacts: readonly unknown[],
  contract: OutputContract
): ArtifactContractValidationResult {
  const { contractRef, required = true } = contract;

  // Check if contract reference is known
  if (!isValidContractRef(contractRef)) {
    return {
      valid: false,
      error: {
        code: 'UNKNOWN_CONTRACT_REF',
        contractRef,
        message: `Unknown artifact contract reference: ${contractRef}`,
      },
    };
  }

  // Dispatch to contract-specific validator
  switch (contractRef) {
    case LOOP_CONTROL_CONTRACT_REF:
      return validateLoopControlContract(artifacts, contractRef, required);

    case COORDINATOR_SIGNAL_CONTRACT_REF:
      return validateCoordinatorSignalContract(artifacts, contractRef, required);

    case REVIEW_VERDICT_CONTRACT_REF:
      return validateReviewVerdictContract(artifacts, contractRef, required);

    case DISCOVERY_HANDOFF_CONTRACT_REF:
      return validateDiscoveryHandoffContract(artifacts, contractRef, required);

    case SHAPING_HANDOFF_CONTRACT_REF:
      return validateShapingHandoffContract(artifacts, contractRef, required);

    case CODING_HANDOFF_CONTRACT_REF:
      return validateCodingHandoffContract(artifacts, contractRef, required);

    default:
      // Type system should prevent this, but fail-fast just in case
      return {
        valid: false,
        error: {
          code: 'UNKNOWN_CONTRACT_REF',
          contractRef,
          message: `No validator implemented for contract: ${contractRef}`,
        },
      };
  }
}

/**
 * Validate loop control artifact contract.
 */
function validateLoopControlContract(
  artifacts: readonly unknown[],
  contractRef: string,
  required: boolean
): ArtifactContractValidationResult {
  // Find loop control artifacts
  const loopControlArtifacts = artifacts.filter(isLoopControlArtifact);

  if (loopControlArtifacts.length === 0) {
    if (required) {
      return {
        valid: false,
        error: {
          code: 'MISSING_REQUIRED_ARTIFACT',
          contractRef,
          message: `Required artifact missing: ${contractRef}. Agent must provide an artifact with kind='wr.loop_control'.`,
        },
      };
    }
    // Not required and not present - valid (no artifact returned)
    return { valid: true, artifact: null };
  }

  // Validate the first matching artifact
  const artifact = loopControlArtifacts[0]!;
  const parseResult = LoopControlArtifactV1Schema.safeParse(artifact);

  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(
      issue => `${issue.path.join('.')}: ${issue.message}`
    );
    return {
      valid: false,
      error: {
        code: 'INVALID_ARTIFACT_SCHEMA',
        contractRef,
        message: `Artifact schema validation failed for ${contractRef}`,
        issues,
      },
    };
  }

  return { valid: true, artifact: parseResult.data };
}

/**
 * Validate coordinator signal artifact contract.
 */
function validateCoordinatorSignalContract(
  artifacts: readonly unknown[],
  contractRef: string,
  required: boolean
): ArtifactContractValidationResult {
  // Find coordinator signal artifacts by kind discriminant
  const signalArtifacts = artifacts.filter(isCoordinatorSignalArtifact);

  if (signalArtifacts.length === 0) {
    if (required) {
      return {
        valid: false,
        error: {
          code: 'MISSING_REQUIRED_ARTIFACT',
          contractRef,
          message: `Required artifact missing: ${contractRef}. Agent must provide an artifact with kind='wr.coordinator_signal'.`,
        },
      };
    }
    // Not required and not present -- valid (no artifact returned)
    return { valid: true, artifact: null };
  }

  // Validate the first matching artifact
  const artifact = signalArtifacts[0]!;
  const parseResult = CoordinatorSignalArtifactV1Schema.safeParse(artifact);

  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    );
    return {
      valid: false,
      error: {
        code: 'INVALID_ARTIFACT_SCHEMA',
        contractRef,
        message: `Artifact schema validation failed for ${contractRef}`,
        issues,
      },
    };
  }

  return { valid: true, artifact: parseResult.data };
}

/**
 * Validate review verdict artifact contract.
 */
function validateReviewVerdictContract(
  artifacts: readonly unknown[],
  contractRef: string,
  required: boolean
): ArtifactContractValidationResult {
  // Find review verdict artifacts by kind discriminant
  const verdictArtifacts = artifacts.filter(isReviewVerdictArtifact);

  if (verdictArtifacts.length === 0) {
    if (required) {
      return {
        valid: false,
        error: {
          code: 'MISSING_REQUIRED_ARTIFACT',
          contractRef,
          message: `Required artifact missing: ${contractRef}. Agent must provide an artifact with kind='wr.review_verdict'.`,
        },
      };
    }
    // Not required and not present -- valid (no artifact returned)
    return { valid: true, artifact: null };
  }

  // Validate the first matching artifact
  const artifact = verdictArtifacts[0]!;
  const parseResult = ReviewVerdictArtifactV1Schema.safeParse(artifact);

  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    );
    return {
      valid: false,
      error: {
        code: 'INVALID_ARTIFACT_SCHEMA',
        contractRef,
        message: `Artifact schema validation failed for ${contractRef}`,
        issues,
      },
    };
  }

  return { valid: true, artifact: parseResult.data };
}

/**
 * Validate discovery handoff artifact contract.
 */
function validateDiscoveryHandoffContract(
  artifacts: readonly unknown[],
  contractRef: string,
  required: boolean
): ArtifactContractValidationResult {
  const handoffArtifacts = artifacts.filter(isDiscoveryHandoffArtifact);

  if (handoffArtifacts.length === 0) {
    if (required) {
      return {
        valid: false,
        error: {
          code: 'MISSING_REQUIRED_ARTIFACT',
          contractRef,
          message: `Required artifact missing: ${contractRef}. Agent must provide an artifact with kind='wr.discovery_handoff'.`,
        },
      };
    }
    return { valid: true, artifact: null };
  }

  const artifact = handoffArtifacts[0]!;
  const parseResult = DiscoveryHandoffArtifactV1Schema.safeParse(artifact);

  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    );
    return {
      valid: false,
      error: {
        code: 'INVALID_ARTIFACT_SCHEMA',
        contractRef,
        message: `Artifact schema validation failed for ${contractRef}`,
        issues,
      },
    };
  }

  return { valid: true, artifact: parseResult.data };
}

/**
 * Validate shaping handoff artifact contract.
 */
function validateShapingHandoffContract(
  artifacts: readonly unknown[],
  contractRef: string,
  required: boolean
): ArtifactContractValidationResult {
  const handoffArtifacts = artifacts.filter(isShapingHandoffArtifact);

  if (handoffArtifacts.length === 0) {
    if (required) {
      return {
        valid: false,
        error: {
          code: 'MISSING_REQUIRED_ARTIFACT',
          contractRef,
          message: `Required artifact missing: ${contractRef}. Agent must provide an artifact with kind='wr.shaping_handoff'.`,
        },
      };
    }
    return { valid: true, artifact: null };
  }

  const artifact = handoffArtifacts[0]!;
  const parseResult = ShapingHandoffArtifactV1Schema.safeParse(artifact);

  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    );
    return {
      valid: false,
      error: {
        code: 'INVALID_ARTIFACT_SCHEMA',
        contractRef,
        message: `Artifact schema validation failed for ${contractRef}`,
        issues,
      },
    };
  }

  return { valid: true, artifact: parseResult.data };
}

/**
 * Validate coding handoff artifact contract.
 */
function validateCodingHandoffContract(
  artifacts: readonly unknown[],
  contractRef: string,
  required: boolean
): ArtifactContractValidationResult {
  const handoffArtifacts = artifacts.filter(isCodingHandoffArtifact);

  if (handoffArtifacts.length === 0) {
    if (required) {
      return {
        valid: false,
        error: {
          code: 'MISSING_REQUIRED_ARTIFACT',
          contractRef,
          message: `Required artifact missing: ${contractRef}. Agent must provide an artifact with kind='wr.coding_handoff'.`,
        },
      };
    }
    return { valid: true, artifact: null };
  }

  const artifact = handoffArtifacts[0]!;
  const parseResult = CodingHandoffArtifactV1Schema.safeParse(artifact);

  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`
    );
    return {
      valid: false,
      error: {
        code: 'INVALID_ARTIFACT_SCHEMA',
        contractRef,
        message: `Artifact schema validation failed for ${contractRef}`,
        issues,
      },
    };
  }

  return { valid: true, artifact: parseResult.data };
}

/**
 * Check if step has an output contract that requires validation.
 *
 * @param outputContract - The step's output contract (optional)
 * @returns True if validation is required
 */
export function requiresArtifactValidation(outputContract: OutputContract | undefined): boolean {
  if (!outputContract) return false;
  return outputContract.required !== false; // Default to true
}

/**
 * Convert validation error to blocker-compatible format.
 * 
 * @param error - The artifact validation error
 * @returns Formatted error for blocker report
 */
export function formatArtifactValidationError(error: ArtifactContractValidationError): {
  readonly code: string;
  readonly message: string;
  readonly suggestedFix?: string;
} {
  switch (error.code) {
    case 'MISSING_REQUIRED_ARTIFACT':
      return {
        code: 'MISSING_REQUIRED_OUTPUT',
        message: error.message,
        suggestedFix: `Provide an artifact with kind matching the contract: ${error.contractRef}`,
      };
    
    case 'INVALID_ARTIFACT_SCHEMA':
      return {
        code: 'INVALID_REQUIRED_OUTPUT',
        message: `${error.message}: ${error.issues.join('; ')}`,
        suggestedFix: `Fix the artifact schema errors and retry`,
      };
    
    case 'UNKNOWN_CONTRACT_REF':
      return {
        code: 'INVARIANT_VIOLATION',
        message: error.message,
      };
  }
}

/**
 * Extract validated artifacts from agent output.
 * 
 * This is a convenience function that:
 * 1. Validates artifacts against contract
 * 2. Returns the validated artifact on success
 * 3. Returns error details on failure
 * 
 * @param artifacts - Array of unknown artifacts
 * @param contract - The output contract
 * @returns Result with validated artifact or error
 */
export function extractValidatedArtifact(
  artifacts: readonly unknown[],
  contract: OutputContract
): Result<unknown, ArtifactContractValidationError> {
  const result = validateArtifactContract(artifacts, contract);
  
  if (result.valid) {
    return ok(result.artifact);
  }
  
  return err(result.error);
}
