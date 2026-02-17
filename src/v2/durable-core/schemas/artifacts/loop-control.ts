import { z } from 'zod';
import { DELIMITER_SAFE_ID_PATTERN } from '../../constants.js';

/**
 * Loop Control Artifact Schema (v1)
 * 
 * Typed artifact for controlling workflow loop iteration.
 * Replaces brittle substring validation on notesMarkdown with
 * machine-checkable structured data.
 * 
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 * Related: Phase 3 architectural fix for validation brittleness
 * 
 * Example usage in workflow:
 * ```json
 * {
 *   "id": "decide-loop",
 *   "prompt": "Should we continue iterating?",
 *   "output": {
 *     "contractRef": "wr.contracts.loop_control"
 *   }
 * }
 * ```
 * 
 * Agent provides:
 * ```json
 * {
 *   "artifacts": [{
 *     "kind": "wr.loop_control",
 *     "loopId": "plan-iteration",
 *     "decision": "continue",
 *     "metadata": {
 *       "reason": "Found 2 gaps that need addressing"
 *     }
 *   }]
 * }
 * ```
 */

/**
 * Contract reference for loop control artifacts.
 * Used in workflow step definitions to declare required artifact.
 */
export const LOOP_CONTROL_CONTRACT_REF = 'wr.contracts.loop_control' as const;

/**
 * Valid loop control decisions.
 * - 'continue': Loop should iterate again
 * - 'stop': Loop should exit and proceed to next step
 */
export const LoopControlDecisionSchema = z.enum(['continue', 'stop']);
export type LoopControlDecision = z.infer<typeof LoopControlDecisionSchema>;

/**
 * Optional metadata for loop control decisions.
 * Provides context without affecting validation.
 */
export const LoopControlMetadataV1Schema = z
  .object({
    /** Human-readable reason for the decision */
    reason: z.string().max(1024).optional(),
    /** Number of issues/gaps found this iteration */
    issuesFound: z.number().int().nonnegative().optional(),
    /** Current iteration number (0-indexed) */
    iterationIndex: z.number().int().nonnegative().optional(),
    /** Confidence in the decision (0-100) */
    confidence: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .optional();

export type LoopControlMetadataV1 = z.infer<typeof LoopControlMetadataV1Schema>;

/**
 * Loop Control Artifact V1 Schema
 * 
 * Machine-checkable artifact for loop flow control.
 * Validated against this schema when step declares
 * `output.contractRef: 'wr.contracts.loop_control'`.
 */
export const LoopControlArtifactV1Schema = z
  .object({
    /** Artifact kind discriminator (must be 'wr.loop_control') */
    kind: z.literal('wr.loop_control'),
    
    /** 
     * Loop identifier matching the workflow's loop definition.
     * Must be delimiter-safe for deterministic key generation.
     */
    loopId: z.string().min(1).max(64).regex(DELIMITER_SAFE_ID_PATTERN, 'loopId must be delimiter-safe: [a-z0-9_-]+'),
    
    /** The loop control decision: continue or stop */
    decision: LoopControlDecisionSchema,
    
    /** Optional metadata providing context (not validated) */
    metadata: LoopControlMetadataV1Schema,
  })
  .strict();

export type LoopControlArtifactV1 = z.infer<typeof LoopControlArtifactV1Schema>;

/**
 * Type guard to check if an unknown artifact is a loop control artifact.
 * 
 * @param artifact - Unknown artifact to check
 * @returns True if artifact has the loop control kind
 */
export function isLoopControlArtifact(artifact: unknown): artifact is LoopControlArtifactV1 {
  if (typeof artifact !== 'object' || artifact === null) return false;
  return (artifact as Record<string, unknown>).kind === 'wr.loop_control';
}

/**
 * Parse and validate an unknown artifact as a loop control artifact.
 * 
 * @param artifact - Unknown artifact to validate
 * @returns Parsed artifact or null if validation fails
 */
export function parseLoopControlArtifact(artifact: unknown): LoopControlArtifactV1 | null {
  const result = LoopControlArtifactV1Schema.safeParse(artifact);
  return result.success ? result.data : null;
}

/**
 * Find a loop control artifact for a specific loopId in an artifacts array.
 * 
 * @param artifacts - Array of unknown artifacts
 * @param loopId - The loop ID to find
 * @returns The matching loop control artifact or null
 */
export function findLoopControlArtifact(
  artifacts: readonly unknown[],
  loopId: string
): LoopControlArtifactV1 | null {
  for (const artifact of artifacts) {
    if (!isLoopControlArtifact(artifact)) continue;
    const parsed = parseLoopControlArtifact(artifact);
    if (parsed && parsed.loopId === loopId) {
      return parsed;
    }
  }
  return null;
}
