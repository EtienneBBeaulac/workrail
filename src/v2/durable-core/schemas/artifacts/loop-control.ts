import { z } from 'zod';
import { DELIMITER_SAFE_ID_PATTERN } from '../../constants.js';

/**
 * Maximum length for artifact metadata reason strings.
 *
 * Why 1024: Allows meaningful context without becoming verbose.
 */
const MAX_ARTIFACT_METADATA_REASON_LENGTH = 1024;

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
    /** Human-readable reason for the decision (max 1024 chars) */
    reason: z.string().max(MAX_ARTIFACT_METADATA_REASON_LENGTH).optional(),
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
 * Find the most recent loop control artifact for a specific loopId.
 *
 * Iterates in reverse so the last (newest) matching artifact wins.
 * Artifacts are collected in chronological order by the engine, so the last
 * one is the most recent exit-decision — the only one that matters for
 * deciding whether to continue or stop.
 *
 * @param artifacts - Array of unknown artifacts (chronological order)
 * @param loopId - The loop ID to find
 * @returns The most recent matching loop control artifact or null
 */
export function findLoopControlArtifact(
  artifacts: readonly unknown[],
  loopId: string
): LoopControlArtifactV1 | null {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i];
    if (!isLoopControlArtifact(artifact)) continue;
    const parsed = parseLoopControlArtifact(artifact);
    if (parsed && parsed.loopId === loopId) {
      return parsed;
    }
  }
  return null;
}
