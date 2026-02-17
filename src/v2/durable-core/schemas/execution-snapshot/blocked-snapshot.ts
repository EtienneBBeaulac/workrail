import { z } from 'zod';
import {
  DELIMITER_SAFE_ID_PATTERN,
  MAX_BLOCKERS,
  MAX_BLOCKER_MESSAGE_BYTES,
  MAX_BLOCKER_SUGGESTED_FIX_BYTES,
} from '../../constants.js';

const DelimiterSafeIdSchema = z
  .string()
  .min(1)
  .regex(DELIMITER_SAFE_ID_PATTERN, 'Expected delimiter-safe identifier: [a-z0-9_-]+');

const CapabilityV2Schema = z.enum(['delegation', 'web_browsing']);

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const BlockerCodeSchema = z.enum([
  'USER_ONLY_DEPENDENCY',
  'MISSING_REQUIRED_OUTPUT',
  'INVALID_REQUIRED_OUTPUT',
  'REQUIRED_CAPABILITY_UNKNOWN',
  'REQUIRED_CAPABILITY_UNAVAILABLE',
  'INVARIANT_VIOLATION',
  'STORAGE_CORRUPTION_DETECTED',
]);

const BlockerPointerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context_key'), key: DelimiterSafeIdSchema }).strict(),
  z.object({ kind: z.literal('context_budget') }).strict(),
  z.object({ kind: z.literal('output_contract'), contractRef: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('capability'), capability: CapabilityV2Schema }).strict(),
  z.object({ kind: z.literal('workflow_step'), stepId: DelimiterSafeIdSchema }).strict(),
]);

const BlockerV1Schema = z.object({
  code: BlockerCodeSchema,
  pointer: BlockerPointerSchema,
  message: z
    .string()
    .min(1)
    .refine((s) => utf8ByteLength(s) <= MAX_BLOCKER_MESSAGE_BYTES, {
      message: `Blocker message exceeds ${MAX_BLOCKER_MESSAGE_BYTES} bytes (UTF-8)`,
    }),
  suggestedFix: z
    .string()
    .min(1)
    .refine((s) => utf8ByteLength(s) <= MAX_BLOCKER_SUGGESTED_FIX_BYTES, {
      message: `Blocker suggestedFix exceeds ${MAX_BLOCKER_SUGGESTED_FIX_BYTES} bytes (UTF-8)`,
    })
    .optional(),
});

const BlockerReportV1Schema = z.object({
  blockers: z.array(BlockerV1Schema).min(1).max(MAX_BLOCKERS),
});

export const ContractViolationReasonV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invalid_required_output'), contractRef: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('missing_required_output'), contractRef: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('missing_context_key'), key: DelimiterSafeIdSchema }).strict(),
  z.object({ kind: z.literal('context_budget_exceeded') }).strict(),
]);

export const TerminalReasonV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user_only_dependency'),
    detail: z.enum([
      'needs_user_secret_or_token',
      'needs_user_account_access',
      'needs_user_artifact',
      'needs_user_choice',
      'needs_user_approval',
      'needs_user_environment_action',
    ]),
    stepId: DelimiterSafeIdSchema,
  }).strict(),
  z.object({ kind: z.literal('required_capability_unknown'), capability: CapabilityV2Schema }).strict(),
  z.object({ kind: z.literal('required_capability_unavailable'), capability: CapabilityV2Schema }).strict(),
  z.object({ kind: z.literal('invariant_violation') }).strict(),
  z.object({ kind: z.literal('storage_corruption_detected') }).strict(),
  z.object({ kind: z.literal('evaluation_error') }).strict(),
]);

export const BlockedSnapshotV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('retryable_block'),
    reason: ContractViolationReasonV1Schema,
    retryAttemptId: z.string().min(1),
    validationRef: z.string().min(1),
    blockers: BlockerReportV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('terminal_block'),
    reason: TerminalReasonV1Schema,
    validationRef: z.string().min(1).optional(),
    blockers: BlockerReportV1Schema,
  }).strict(),
]);

export type BlockedSnapshotV1 = z.infer<typeof BlockedSnapshotV1Schema>;
export type ContractViolationReasonV1 = z.infer<typeof ContractViolationReasonV1Schema>;
export type TerminalReasonV1 = z.infer<typeof TerminalReasonV1Schema>;
