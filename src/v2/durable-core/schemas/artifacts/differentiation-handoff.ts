import { z } from 'zod';

/**
 * Differentiation Handoff Artifact Schema (v1)
 *
 * Typed artifact for threading context from the wr.differentiation workflow session
 * to the wr.shaping workflow session.
 */

export const DIFFERENTIATION_HANDOFF_CONTRACT_REF = 'wr.contracts.differentiation_handoff' as const;

export const DifferentiationHandoffArtifactV1Schema = z
  .object({
    kind: z.literal('wr.differentiation_handoff'),
    version: z.literal(1),

    /** The winning differentiation candidate name and description. */
    winningCandidate: z.string().min(1),

    /** The target segment (ICP) description. */
    targetSegment: z.string().min(1),

    /** Target Jobs-To-Be-Done functional, emotional, and social statements. */
    targetJTBD: z.object({
      functional: z.string().min(1),
      emotional: z.string().optional(),
      social: z.string().optional()
    }),

    /** Killer features prioritized from the ledger. */
    killerFeatures: z.array(z.string().min(1).max(200)).max(6),

    /** Incumbent self-harm points, brand conflicts, or data-model friction. */
    incumbentVulnerabilities: z.array(z.string().min(1).max(300)).max(8),

    /** Sizing appetite (e.g. "Small batch (1-2 days)", "Medium (1 week)"). */
    shapingAppetite: z.string().min(1).max(100),

    /** Verifiable acceptance criteria for subsequent coding/review agents. */
    validationChecklist: z.array(z.string().min(1).max(200)).max(10)
  })
  .strict();

export type DifferentiationHandoffArtifactV1 = z.infer<typeof DifferentiationHandoffArtifactV1Schema>;

export function isDifferentiationHandoffArtifact(
  artifact: unknown,
): artifact is { readonly kind: 'wr.differentiation_handoff' } {
  return (
    typeof artifact === 'object' &&
    artifact !== null &&
    (artifact as Record<string, unknown>).kind === 'wr.differentiation_handoff'
  );
}

export function parseDifferentiationHandoffArtifact(
  artifact: unknown,
): DifferentiationHandoffArtifactV1 | null {
  const result = DifferentiationHandoffArtifactV1Schema.safeParse(artifact);
  return result.success ? result.data : null;
}

export function getDifferentiationHandoffBlockedMessage(): readonly string[] {
  return [
    `Artifact contract: ${DIFFERENTIATION_HANDOFF_CONTRACT_REF}`,
    `Provide a wr.differentiation_handoff artifact in complete_step's artifacts[] parameter.`,
    `Required fields: winningCandidate (string), targetSegment (string), targetJTBD (object), killerFeatures (string[]), incumbentVulnerabilities (string[]), shapingAppetite (string), validationChecklist (string[]).`,
    `See the step prompt for the full schema.`,
  ];
}
