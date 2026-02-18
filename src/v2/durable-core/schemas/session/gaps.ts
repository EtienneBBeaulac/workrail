import { z } from 'zod';

export const UserOnlyDependencyReasonSchema = z.enum([
  'needs_user_secret_or_token',
  'needs_user_account_access',
  'needs_user_artifact',
  'needs_user_choice',
  'needs_user_approval',
  'needs_user_environment_action',
]);

export const GapReasonSchema = z.discriminatedUnion('category', [
  z.object({ category: z.literal('user_only_dependency'), detail: UserOnlyDependencyReasonSchema }),
  z.object({ category: z.literal('contract_violation'), detail: z.enum(['missing_required_output', 'invalid_required_output', 'missing_required_notes']) }),
  z.object({
    category: z.literal('capability_missing'),
    detail: z.enum(['required_capability_unavailable', 'required_capability_unknown']),
  }),
  z.object({ category: z.literal('unexpected'), detail: z.enum(['invariant_violation', 'storage_corruption_detected', 'evaluation_error']) }),
]);

export const GapResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unresolved') }),
  z.object({ kind: z.literal('resolves'), resolvesGapId: z.string().min(1) }),
]);

export const GapEvidenceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), eventId: z.string().min(1) }),
  z.object({ kind: z.literal('output'), outputId: z.string().min(1) }),
]);

export const GapRecordedDataV1Schema = z.object({
  gapId: z.string().min(1),
  severity: z.enum(['info', 'warning', 'critical']),
  reason: GapReasonSchema,
  summary: z.string().min(1),
  resolution: GapResolutionSchema,
  evidenceRefs: z.array(GapEvidenceRefSchema).optional(),
});
