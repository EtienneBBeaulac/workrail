import { z } from 'zod';

/**
 * Review Verdict Artifact Schema (v1)
 *
 * Typed artifact for communicating a structured PR review verdict from the
 * mr-review-workflow agent to the pr-review coordinator.
 *
 * Replaces brittle keyword scanning on step notes with machine-checkable
 * structured data. The coordinator reads this via the existing node detail
 * API (GET /api/v2/sessions/:id/nodes/:nodeId -> artifacts[]).
 *
 * Design invariants:
 * - `verdict` maps directly to `ReviewSeverity` in the coordinator
 * - `findings` is always an array (empty for clean verdicts)
 * - `required: false` on the workflow step during transition period
 *   (fall back to keyword scan if agent does not emit)
 *
 * Related: docs/discovery/artifacts-coordinator-channel.md (Candidate A)
 */

/**
 * Contract reference for review verdict artifacts.
 * Used in workflow step definitions to declare the output contract.
 */
export const REVIEW_VERDICT_CONTRACT_REF = 'wr.contracts.review_verdict' as const;

/**
 * Review Verdict Artifact V1 Schema
 *
 * Machine-checkable artifact for pr-review coordinator consumption.
 * Emitted by the agent in complete_step's artifacts[] parameter on the
 * final handoff step of mr-review-workflow.
 */
export const ReviewVerdictArtifactV1Schema = z
  .object({
    /** Artifact kind discriminator (must be 'wr.review_verdict') */
    kind: z.literal('wr.review_verdict'),

    /**
     * Overall review verdict.
     * Maps directly to ReviewSeverity in the coordinator:
     * 'clean' -> auto-merge queue, 'minor' -> fix-agent loop, 'blocking' -> escalate
     */
    verdict: z.enum(['clean', 'minor', 'blocking']),

    /**
     * Agent's stated confidence in the verdict.
     * Used for coordinator logging and monitoring -- does not affect routing.
     */
    confidence: z.enum(['high', 'medium', 'low']),

    /**
     * Structured list of findings.
     * Empty array for clean verdicts.
     */
    findings: z.array(
      z
        .object({
          /** Finding severity classification */
          severity: z.enum(['critical', 'major', 'minor', 'nit']),
          /** One-line finding description (for fix-agent goal string) */
          summary: z.string().min(1),
          /**
           * Category of the finding. Used by coordinators to route audit chains.
           * Optional for backward compatibility with sessions that do not emit this field.
           * architecture -> wr.architecture-scalability-audit; all others -> wr.production-readiness-audit.
           */
          findingCategory: z
            .enum([
              'correctness',
              'security',
              'architecture',
              'ux',
              'performance',
              'testing',
              'style',
            ])
            .optional()
            .describe(
              'Category of the finding. Used by coordinators to route audit chains.',
            ),
        })
        .strict(),
    ),

    /** One-line summary for logging and display */
    summary: z.string().min(1),
  })
  .strict();

export type ReviewVerdictArtifactV1 = z.infer<typeof ReviewVerdictArtifactV1Schema>;

/**
 * Type guard to check if an unknown artifact is a review verdict artifact.
 *
 * Checks the kind discriminant only -- does not validate the full schema.
 * Use parseReviewVerdictArtifact() for full validation.
 */
export function isReviewVerdictArtifact(
  artifact: unknown,
): artifact is { readonly kind: 'wr.review_verdict' } {
  return (
    typeof artifact === 'object' &&
    artifact !== null &&
    (artifact as Record<string, unknown>).kind === 'wr.review_verdict'
  );
}

/**
 * Parse and validate an unknown artifact as a review verdict artifact.
 *
 * Returns the parsed artifact on success, null on validation failure.
 * Use isReviewVerdictArtifact() to check kind before calling this
 * if you want to distinguish "wrong kind" from "wrong schema".
 */
export function parseReviewVerdictArtifact(
  artifact: unknown,
): ReviewVerdictArtifactV1 | null {
  const result = ReviewVerdictArtifactV1Schema.safeParse(artifact);
  return result.success ? result.data : null;
}
