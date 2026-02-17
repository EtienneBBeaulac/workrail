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
