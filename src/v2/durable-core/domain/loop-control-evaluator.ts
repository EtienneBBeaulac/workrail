import {
  findLoopControlArtifact,
  isLoopControlArtifact,
  type LoopControlDecision,
  type LoopControlArtifactV1,
} from '../schemas/artifacts/index.js';

/**
 * Loop control evaluation result.
 *
 * Discriminated union — exhaustive switch is required in consumers.
 * - found: valid artifact with a decision
 * - not_found: no wr.loop_control artifact present at all
 * - invalid: artifact with kind='wr.loop_control' exists but fails schema validation
 */
export type LoopControlEvaluationResult =
  | { readonly kind: 'found'; readonly decision: LoopControlDecision; readonly artifact: LoopControlArtifactV1 }
  | { readonly kind: 'not_found'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Evaluate loop control decision from artifacts.
 *
 * Pure function: searches artifacts for a valid wr.loop_control artifact,
 * validates against schema, and returns the decision ('continue' | 'stop').
 *
 * Distinguishes three cases:
 * - found: valid artifact → decision is authoritative
 * - not_found: no kind='wr.loop_control' artifact at all → first iteration, safe to continue
 * - invalid: kind matches but schema fails → agent tried but produced bad data
 *
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 *
 * @param artifacts - Array of unknown artifacts to search (chronological order)
 * @returns Evaluation result: found (with decision), not_found, or invalid
 */
export function evaluateLoopControlFromArtifacts(
  artifacts: readonly unknown[],
): LoopControlEvaluationResult {
  if (artifacts.length === 0) {
    return {
      kind: 'not_found',
      reason: 'No artifacts provided for loop control evaluation',
    };
  }

  const artifact = findLoopControlArtifact(artifacts);

  if (artifact) {
    return {
      kind: 'found',
      decision: artifact.decision,
      artifact,
    };
  }

  // No valid artifact found — distinguish "no wr.loop_control at all" from
  // "kind matches but schema validation failed" (agent tried but produced bad data)
  const hasKindMatch = artifacts.some(isLoopControlArtifact);

  if (hasKindMatch) {
    return {
      kind: 'invalid',
      reason: 'Artifact with kind=wr.loop_control found but failed schema validation (bad loopId format, missing decision, or extra fields)',
    };
  }

  return {
    kind: 'not_found',
    reason: 'No wr.loop_control artifact found',
  };
}
