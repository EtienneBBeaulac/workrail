import { z } from 'zod';

/**
 * Differentiation Handoff Artifact Schema (v1)
 *
 * Typed artifact for threading context from the wr.differentiation workflow session
 * to the wr.shaping workflow session.
 * 
 * Strictly non-redundant: shapingHandoff is the single source of truth.
 */

export const DIFFERENTIATION_HANDOFF_CONTRACT_REF = 'wr.contracts.differentiation_handoff' as const;

export const SevenPowersSchema = z.enum([
  'Counter-Positioning',
  'Switching Costs',
  'Network Economies',
  'Scale Economies',
  'Cornered Resource',
  'Process Power',
  'Branding',
  'None_Imitable'
]);

export const DifferentiationHandoffArtifactV1Schema = z
  .object({
    kind: z.literal('wr.differentiation_handoff'),
    version: z.literal(1),
    schemaVersion: z.literal('1.0.0'),
    generatedAt: z.string().datetime(),

    /** Freshness markers for data-stale gating */
    evidenceFreshness: z.object({
      oldestCapturedAt: z.string().datetime(),
      newestCapturedAt: z.string().datetime()
    }),

    /** Verifiable acceptance criteria for subsequent coding/review agents. */
    validationChecklist: z.array(z.string().min(1).max(200)).max(10),

    /** Singer's Shape Up "Pitch" contract primitives - Canonical Handoff */
    shapingHandoff: z.object({
      rawIdea: z.string().min(1),
      problem: z.string().min(1), // Singer's specific friction story
      baseline: z.string().min(1), // what customers are doing without it
      appetiteHint: z.enum(['small_batch', 'big_batch']),
      noGosHints: z.array(z.string()), // things we will NOT build
      constraints: z.object({
        teamSize: z.number().int().positive(),
        technicalCapabilities: z.array(z.string()).min(1),
        exclusions: z.array(z.string()).default([])
      }),
      evidenceTopK: z.array(z.string().uuid()).max(10),
      defensibilityClaim: z.object({
        power: SevenPowersSchema,
        cannibalization: z.string()
      })
    })
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

export function getDifferentiationHandoffBlockedMessage(options?: { readonly isAutonomous?: boolean }): readonly string[] {
  const isAutonomous = options?.isAutonomous ?? false;
  const paramPath = isAutonomous ? "complete_step's artifacts[] parameter" : "continue_workflow's output.artifacts parameter (or top-level artifacts)";
  return [
    `Artifact contract: ${DIFFERENTIATION_HANDOFF_CONTRACT_REF}`,
    `Provide a wr.differentiation_handoff artifact in ${paramPath}.`,
    `Required fields: schemaVersion ("1.0.0"), evidenceFreshness (object), validationChecklist (string[]), shapingHandoff (object containing rawIdea, problem, baseline, appetiteHint, noGosHints, constraints, evidenceTopK, defensibilityClaim).`,
    `See the step prompt for the full schema.`,
  ];
}
