import { z } from 'zod';

/**
 * Discovery Handoff Artifact Schema (v1)
 *
 * Typed artifact for threading context from the wr.discovery workflow session
 * to the wr.shaping workflow session in the FULL pipeline mode.
 *
 * The discovery session emits this artifact on completion. The adaptive pipeline
 * coordinator reads it via getAgentResult() -> artifacts[], validates it with Zod,
 * and injects the relevant fields as context for the shaping session spawn.
 *
 * WHY Zod validation: follows the same validate-at-boundaries pattern as
 * ReviewVerdictArtifactV1Schema. The coordinator trusts validated types internally
 * and never uses `unknown` casts in its core logic.
 *
 * Context threading invariant (pitch invariant 12):
 * - If artifact is present and valid: inject { selectedDirection, designDocPath,
 *   assembledContextSummary: renderHandoff(artifact) } into shaping spawn context.
 * - Fallback: if no valid artifact, use lastStepNotes as assembledContextSummary
 *   ONLY IF lastStepNotes.trim().length > 50. Otherwise: no assembledContextSummary.
 *
 * Kind discriminator follows the `wr.` prefix convention:
 *   wr.review_verdict, wr.loop_control, wr.coordinator_signal, wr.discovery_handoff
 */

/**
 * Contract reference for discovery handoff artifacts.
 * Used in workflow step definitions to declare the output contract.
 */
export const DISCOVERY_HANDOFF_CONTRACT_REF = 'wr.contracts.discovery_handoff' as const;

/**
 * Discovery Handoff Artifact V1 Schema
 *
 * Emitted by the wr.discovery workflow on the final handoff step.
 * Consumed by the adaptive pipeline coordinator to thread context to shaping.
 */
export const DiscoveryHandoffArtifactV1Schema = z
  .object({
    /** Artifact kind discriminator (must be 'wr.discovery_handoff') */
    kind: z.literal('wr.discovery_handoff'),

    /**
     * Schema version. Must be 1 for V1.
     * Allows future schema evolution without breaking the coordinator.
     */
    version: z.literal(1),

    /**
     * The selected design direction from discovery.
     * One-sentence description of the chosen approach.
     */
    selectedDirection: z.string().min(1),

    /**
     * Absolute or workspace-relative path to the generated design document.
     * May be empty string if no design doc was generated.
     */
    designDocPath: z.string(),

    /**
     * Confidence band for the selected direction.
     * Used by the coordinator for logging and monitoring -- does not affect routing.
     */
    confidenceBand: z.enum(['high', 'medium', 'low']),

    /**
     * Key invariants discovered during the discovery session.
     * Array of one-line invariant statements.
     * Used in renderHandoff() to build the context summary for shaping.
     */
    keyInvariants: z.array(z.string().min(1).max(200)).max(12),

    /**
     * Directions considered but rejected during discovery, with reasons.
     * Prevents shaping agents from re-exploring already-ruled-out approaches.
     * Optional for backward compatibility with sessions that predate this field.
     */
    rejectedDirections: z.array(z.object({
      direction: z.string().min(1).max(200),
      reason: z.string().min(1).max(300),
    })).max(5).optional(),

    /**
     * Constraints the coding agent must respect during implementation.
     * Things the implementation MUST NOT do or MUST preserve.
     * Optional for backward compatibility.
     */
    implementationConstraints: z.array(z.string().min(1).max(200)).max(8).optional(),

    /**
     * Key codebase locations relevant to this feature.
     * Orients the coding agent without requiring it to re-run discovery.
     * Optional for backward compatibility.
     */
    keyCodebaseLocations: z.array(z.object({
      path: z.string().min(1).max(300),
      relevance: z.string().min(1).max(150),
    })).max(10).optional(),
  })
  .strict();

export type DiscoveryHandoffArtifactV1 = z.infer<typeof DiscoveryHandoffArtifactV1Schema>;

/**
 * Type guard to check if an unknown artifact is a discovery handoff artifact.
 *
 * Checks the kind discriminant only -- does not validate the full schema.
 * Use DiscoveryHandoffArtifactV1Schema.safeParse() for full validation.
 */
export function isDiscoveryHandoffArtifact(
  artifact: unknown,
): artifact is { readonly kind: 'wr.discovery_handoff' } {
  return (
    typeof artifact === 'object' &&
    artifact !== null &&
    (artifact as Record<string, unknown>).kind === 'wr.discovery_handoff'
  );
}

/**
 * Parse and validate an unknown artifact as a discovery handoff artifact.
 *
 * Returns the parsed artifact on success, null on validation failure.
 * Use isDiscoveryHandoffArtifact() to check kind before calling this
 * if you want to distinguish "wrong kind" from "wrong schema".
 */
export function parseDiscoveryHandoffArtifact(
  artifact: unknown,
): DiscoveryHandoffArtifactV1 | null {
  const result = DiscoveryHandoffArtifactV1Schema.safeParse(artifact);
  return result.success ? result.data : null;
}
