import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import {
  findLoopControlArtifact,
  type LoopControlDecision,
  type LoopControlArtifactV1,
} from '../schemas/artifacts/index.js';

/**
 * Loop control evaluation result.
 */
export type LoopControlEvaluationResult =
  | { readonly kind: 'found'; readonly decision: LoopControlDecision; readonly artifact: LoopControlArtifactV1 }
  | { readonly kind: 'not_found'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Error type for loop control evaluation failures.
 */
export type LoopControlEvaluationError =
  | { readonly code: 'MISSING_LOOP_CONTROL_ARTIFACT'; readonly loopId: string; readonly message: string }
  | { readonly code: 'INVALID_LOOP_CONTROL_ARTIFACT'; readonly loopId: string; readonly message: string };

/**
 * Evaluate loop control decision from artifacts.
 * 
 * This is a pure function that:
 * 1. Searches artifacts for a loop control artifact matching loopId
 * 2. Validates the artifact against schema
 * 3. Returns the decision ('continue' | 'stop')
 * 
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 * 
 * @param artifacts - Array of unknown artifacts to search
 * @param loopId - The loop ID to find the control artifact for
 * @returns Evaluation result indicating found decision, not found, or invalid
 */
export function evaluateLoopControlFromArtifacts(
  artifacts: readonly unknown[],
  loopId: string
): LoopControlEvaluationResult {
  if (artifacts.length === 0) {
    return {
      kind: 'not_found',
      reason: `No artifacts provided to evaluate loop control for loopId=${loopId}`,
    };
  }

  const artifact = findLoopControlArtifact(artifacts, loopId);
  
  if (!artifact) {
    return {
      kind: 'not_found',
      reason: `No loop control artifact found for loopId=${loopId}`,
    };
  }

  return {
    kind: 'found',
    decision: artifact.decision,
    artifact,
  };
}

/**
 * Determine if a loop should continue based on artifacts.
 * 
 * Returns:
 * - ok(true) if loop should continue
 * - ok(false) if loop should stop
 * - err if artifact not found or invalid
 * 
 * Use this for strict validation where artifact is required.
 * 
 * @param artifacts - Array of unknown artifacts to search
 * @param loopId - The loop ID to evaluate
 * @returns Result<boolean, error> indicating continue decision
 */
export function shouldLoopContinue(
  artifacts: readonly unknown[],
  loopId: string
): Result<boolean, LoopControlEvaluationError> {
  const result = evaluateLoopControlFromArtifacts(artifacts, loopId);

  switch (result.kind) {
    case 'found':
      return ok(result.decision === 'continue');
    
    case 'not_found':
      return err({
        code: 'MISSING_LOOP_CONTROL_ARTIFACT',
        loopId,
        message: result.reason,
      });
    
    case 'invalid':
      return err({
        code: 'INVALID_LOOP_CONTROL_ARTIFACT',
        loopId,
        message: result.reason,
      });
  }
}

/**
 * Evaluate loop control with fallback to context-based evaluation.
 * 
 * Order of evaluation:
 * 1. Check for artifact-based loop control → use if found
 * 2. Fall back to context-based evaluation → use contextDecision
 * 
 * This provides backward compatibility during migration from
 * substring-based validation to artifact-based validation.
 * 
 * @param artifacts - Array of unknown artifacts to search
 * @param loopId - The loop ID to evaluate
 * @param contextDecision - Fallback decision from context evaluation (true = continue)
 * @returns Decision to continue (true) or stop (false)
 */
export function evaluateLoopControlWithFallback(
  artifacts: readonly unknown[],
  loopId: string,
  contextDecision: boolean
): boolean {
  const result = evaluateLoopControlFromArtifacts(artifacts, loopId);

  if (result.kind === 'found') {
    return result.decision === 'continue';
  }

  // Fall back to context-based evaluation
  return contextDecision;
}

/**
 * Source of loop control decision for diagnostics.
 */
export type LoopControlDecisionSource = 'artifact' | 'context_fallback';

/**
 * Detailed result of loop control evaluation with source tracking.
 */
export interface LoopControlEvaluationDetails {
  /** Whether the loop should continue */
  readonly shouldContinue: boolean;
  /** Source of the decision */
  readonly source: LoopControlDecisionSource;
  /** The artifact used (if source is 'artifact') */
  readonly artifact?: LoopControlArtifactV1;
  /** Diagnostic reason (for debugging) */
  readonly reason: string;
}

/**
 * Evaluate loop control with detailed diagnostics.
 * 
 * Same as evaluateLoopControlWithFallback but returns detailed
 * information about where the decision came from.
 * 
 * @param artifacts - Array of unknown artifacts to search
 * @param loopId - The loop ID to evaluate
 * @param contextDecision - Fallback decision from context evaluation
 * @returns Detailed evaluation result with source tracking
 */
export function evaluateLoopControlDetailed(
  artifacts: readonly unknown[],
  loopId: string,
  contextDecision: boolean
): LoopControlEvaluationDetails {
  const result = evaluateLoopControlFromArtifacts(artifacts, loopId);

  if (result.kind === 'found') {
    return {
      shouldContinue: result.decision === 'continue',
      source: 'artifact',
      artifact: result.artifact,
      reason: `Loop control artifact found: decision=${result.decision}`,
    };
  }

  return {
    shouldContinue: contextDecision,
    source: 'context_fallback',
    reason: result.reason,
  };
}
