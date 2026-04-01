import { z } from 'zod';

const MAX_ASSESSMENT_SUMMARY_LENGTH = 1024;
const MAX_DIMENSION_RATIONALE_LENGTH = 512;

/**
 * Pseudo contract reference used for assessment-gate boundary validation.
 *
 * Assessment-gate submissions currently travel through the existing output
 * artifact channel even when a step does not declare `outputContract`.
 */
export const ASSESSMENT_CONTRACT_REF = 'wr.contracts.assessment' as const;

export const AssessmentDimensionSubmissionSchema = z.union([
  z.string().min(1),
  z.object({
    level: z.string().min(1),
    rationale: z.string().min(1).max(MAX_DIMENSION_RATIONALE_LENGTH).optional(),
  }).strict(),
]);

export type AssessmentDimensionSubmission = z.infer<typeof AssessmentDimensionSubmissionSchema>;

export const AssessmentArtifactV1Schema = z.object({
  kind: z.literal('wr.assessment'),
  assessmentId: z.string().min(1).max(64).optional(),
  dimensions: z.record(AssessmentDimensionSubmissionSchema).refine(
    (value) => Object.keys(value).length > 0,
    'dimensions must contain at least one entry',
  ),
  summary: z.string().max(MAX_ASSESSMENT_SUMMARY_LENGTH).optional(),
}).strict();

export type AssessmentArtifactV1 = z.infer<typeof AssessmentArtifactV1Schema>;

export function isAssessmentArtifact(artifact: unknown): artifact is { readonly kind: 'wr.assessment' } {
  return typeof artifact === 'object' && artifact !== null && (artifact as Record<string, unknown>).kind === 'wr.assessment';
}

export function parseAssessmentArtifact(artifact: unknown): AssessmentArtifactV1 | null {
  const result = AssessmentArtifactV1Schema.safeParse(artifact);
  return result.success ? result.data : null;
}
