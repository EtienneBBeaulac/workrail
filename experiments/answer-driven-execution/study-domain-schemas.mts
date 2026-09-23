import { z } from 'zod';
import type { StageBCall, StageBFault } from './stage-b-scorer-contract.js';
import type { Trial as StageATrial } from './usability-scorer.mjs';

export const stageBCallSchema = z
  .object({
    id: z.string().min(1),
    atMs: z.number().int().min(0),
    operation: z.enum(['read', 'write']),
    outcome: z.enum([
      'success',
      'invalid_arguments',
      'invalid_authority',
      'rejected_content',
      'infrastructure_error',
      'injected_fault',
    ]),
  })
  .strict() satisfies z.ZodType<StageBCall>;

export const faultNoneVariantSchema = z
  .object({
    kind: z.literal('none'),
  })
  .strict();

export const stageAFaultVariantSchema = z
  .object({
    kind: z.enum(['malformed', 'lost_response']),
    callId: z.string().min(1),
    noticeAtMs: z.number().int().min(0),
  })
  .strict();

export const faultMissingSummaryVariantSchema = z
  .object({
    kind: z.literal('missing_summary'),
    callId: z.string().min(1),
    noticeAtMs: z.number().int().min(0),
  })
  .strict();

export const faultRecoveryAfterPartialWorkVariantSchema = z
  .object({
    kind: z.literal('recovery_after_partial_work'),
    callId: z.string().min(1),
    noticeAtMs: z.number().int().min(0),
    committedEventId: z.string().min(1),
    priorConversationId: z.string().min(1),
    recoveryConversationId: z.string().min(1),
  })
  .strict();

export const faultNoneSchema = faultNoneVariantSchema;
export const faultMissingSummarySchema = faultMissingSummaryVariantSchema;
export const faultRecoveryAfterPartialWorkSchema = faultRecoveryAfterPartialWorkVariantSchema;

export const stageAFaultSchema = z.discriminatedUnion('kind', [
  faultNoneVariantSchema,
  stageAFaultVariantSchema,
]) satisfies z.ZodType<StageATrial['fault']>;

export const stageBFaultSchema = z.discriminatedUnion('kind', [
  faultNoneVariantSchema,
  faultMissingSummaryVariantSchema,
  faultRecoveryAfterPartialWorkVariantSchema,
]) satisfies z.ZodType<StageBFault>;

export const faultSchema = z.discriminatedUnion('kind', [
  faultNoneVariantSchema,
  stageAFaultVariantSchema,
  faultMissingSummaryVariantSchema,
  faultRecoveryAfterPartialWorkVariantSchema,
]) satisfies z.ZodType<StageATrial['fault'] | StageBFault>;
