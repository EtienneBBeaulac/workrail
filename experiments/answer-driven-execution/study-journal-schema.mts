import { z } from 'zod';
import type {
  HostRecord,
  HostRecordPayload,
} from './study-runner-contract.js';
import type {
  AgentEvent,
  LedgerRecord,
  TrialRequest,
  ObservedEnvironment,
} from './trial-executor-contract.js';
import type {
  StageBCall,
  StageBObservation,
  StageBFault,
  StageBTrial,
} from './stage-b-scorer-contract.js';
import type { Trial as StageATrial } from './usability-scorer.mjs';
import {
  ReviewVerdictArtifactV1Schema,
  type ReviewVerdictArtifactV1,
} from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';
import {
  observationSchema,
  pairFixtureSchema,
  armSettingsSchema,
  budgetsSpecSchema,
  ALL_SCENARIOS,
  ARMS,
} from './study-manifest.mjs';

export interface HostStreamOrderEntry {
  readonly seq: number;
  readonly runId: string;
  readonly arm: 'baseline' | 'candidate';
  readonly type: 'host';
  readonly recordId: string;
  readonly kind: HostRecord['kind'];
  readonly hostRunId: string;
  readonly atMs: number;
  readonly conversationId?: string;
}

export interface AgentStreamOrderEntry {
  readonly seq: number;
  readonly runId: string;
  readonly arm: 'baseline' | 'candidate';
  readonly type: 'agent';
  readonly eventType: AgentEvent['type'];
  readonly conversationId?: string;
  readonly priorConversationId?: string;
}

export type StreamOrderEntry = HostStreamOrderEntry | AgentStreamOrderEntry;

import {
  stageBCallSchema,
  faultSchema,
} from './study-domain-schemas.mjs';

export {
  stageBCallSchema,
  faultSchema,
};

const hostBaseFields = {
  recordId: z.string().min(1),
  runId: z.string().min(1),
  atMs: z.number().int().min(0).finite(),
  source: z.string().min(1),
  rawProvenance: z.string(),
};

export const hostRecordSchema: z.ZodType<HostRecord> = z.discriminatedUnion('kind', [
  z.object({ ...hostBaseFields, kind: z.literal('coverage'), status: z.enum(['opened', 'closed']) }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('tool_call'), conversationId: z.string().min(1), call: stageBCallSchema }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('commit'), conversationId: z.string().min(1), eventId: z.string().min(1), callId: z.string().min(1), observation: observationSchema }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('retained_snapshot'), observation: observationSchema }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('read'), conversationId: z.string().min(1), callId: z.string().min(1), observation: observationSchema }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('engine_recreated'), priorInstanceId: z.string().min(1), instanceId: z.string().min(1), priorConversationId: z.string().min(1), recoveryConversationId: z.string().min(1) }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('fault'), fault: faultSchema }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('submitted_review'), conversationId: z.string().min(1), artifact: ReviewVerdictArtifactV1Schema }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('accepted_review'), conversationId: z.string().min(1), artifact: ReviewVerdictArtifactV1Schema }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('unauthorized_effect'), effect: z.string().min(1) }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('host_completion'), completed: z.boolean() }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('host_termination'), termination: z.enum(['finished', 'timeout', 'assisted', 'failed', 'unknown']) }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('token_usage'), tokensUsed: z.number().int().min(0).finite().nullable() }).strict(),
  z.object({ ...hostBaseFields, kind: z.literal('observed_answer'), observation: observationSchema }).strict(),
]);

export const observedEnvironmentSchema: z.ZodType<ObservedEnvironment> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('reported'),
    model: z.string().min(1),
    effort: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('unknown'),
  }).strict(),
]);

export const agentEventSchema: z.ZodType<AgentEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('started'),
    conversationId: z.string().min(1),
    observedEnvironment: observedEnvironmentSchema,
  }).strict(),
  z.object({
    type: z.literal('conversation_restarted'),
    priorConversationId: z.string().min(1),
    conversationId: z.string().min(1),
    observedEnvironment: observedEnvironmentSchema,
  }).strict(),
  z.object({
    type: z.literal('model_started'),
    callId: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('model_finished'),
    callId: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal('trace'),
    raw: z.string(),
  }).strict(),
  z.object({
    type: z.literal('ended'),
    outcome: z.enum(['completed', 'failed']),
    raw: z.string(),
  }).strict(),
]);

export const trialRequestSchema: z.ZodType<TrialRequest> = z
  .object({
    runId: z.string().min(1),
    arm: z.enum(ARMS),
    workspacePath: z.string().min(1),
    scenario: z.enum(ALL_SCENARIOS),
    repetition: z.number().int().min(1).max(5),
    fixture: pairFixtureSchema,
    expectedObservations: z.array(observationSchema).length(2),
    requestedEnvironment: armSettingsSchema,
    budgets: budgetsSpecSchema,
  })
  .strict();

export const ledgerRecordSchema: z.ZodType<LedgerRecord> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('launch'),
    request: trialRequestSchema,
  }).strict(),
  z.object({
    type: z.literal('event'),
    runId: z.string().min(1),
    event: agentEventSchema,
  }).strict(),
  z.object({
    type: z.literal('stop'),
    runId: z.string().min(1),
    reason: z.enum(['model_deadline', 'conversation_deadline', 'caller_cancelled']),
  }).strict(),
  z.object({
    type: z.literal('outcome'),
    runId: z.string().min(1),
    outcome: z.enum(['completed', 'failed', 'unknown_remote', 'conversation_reused']),
  }).strict(),
]);

export const hostRecordKindSchema = z.enum([
  'coverage',
  'tool_call',
  'commit',
  'retained_snapshot',
  'read',
  'engine_recreated',
  'fault',
  'submitted_review',
  'accepted_review',
  'unauthorized_effect',
  'host_completion',
  'host_termination',
  'token_usage',
  'observed_answer',
]);

export const hostStreamOrderEntrySchema = z
  .object({
    seq: z.number().int().min(0).finite(),
    runId: z.string().min(1),
    arm: z.enum(['baseline', 'candidate']),
    type: z.literal('host'),
    recordId: z.string().min(1),
    kind: hostRecordKindSchema,
    hostRunId: z.string().min(1),
    atMs: z.number().int().min(0).finite(),
    conversationId: z.string().min(1).optional(),
  })
  .strict();

export const agentStreamOrderEntrySchema = z
  .object({
    seq: z.number().int().min(0).finite(),
    runId: z.string().min(1),
    arm: z.enum(['baseline', 'candidate']),
    type: z.literal('agent'),
    eventType: z.enum([
      'started',
      'conversation_restarted',
      'model_started',
      'model_finished',
      'trace',
      'ended',
    ]),
    conversationId: z.string().min(1).optional(),
    priorConversationId: z.string().min(1).optional(),
  })
  .strict();

export const streamOrderEntrySchema: z.ZodType<StreamOrderEntry> = z.discriminatedUnion('type', [
  hostStreamOrderEntrySchema,
  agentStreamOrderEntrySchema,
]);

export function isHostRecord(value: unknown): value is HostRecord {
  return hostRecordSchema.safeParse(value).success;
}

export function isLedgerRecord(value: unknown): value is LedgerRecord {
  return ledgerRecordSchema.safeParse(value).success;
}

export function isStreamOrderEntry(value: unknown): value is StreamOrderEntry {
  return streamOrderEntrySchema.safeParse(value).success;
}

export interface JournalParseError {
  readonly lineNumber: number;
  readonly rawLine: string;
  readonly reason: string;
}

export type JournalParseOutcome<T> =
  | {
      readonly ok: true;
      readonly kind: 'valid';
      readonly records: readonly T[];
    }
  | {
      readonly ok: false;
      readonly kind: 'corrupted';
      readonly error: JournalParseError;
      readonly validPrefix: readonly T[];
    };

export function parseJournal<T>(
  content: string,
  schema: z.ZodType<T>,
): JournalParseOutcome<T> {
  const lines = content.split('\n');
  const validRecords: T[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch (err: unknown) {
      return {
        ok: false,
        kind: 'corrupted',
        error: {
          lineNumber: i + 1,
          rawLine,
          reason: err instanceof Error ? err.message : 'Invalid JSON',
        },
        validPrefix: validRecords,
      };
    }

    const parseRes = schema.safeParse(parsedJson);
    if (!parseRes.success) {
      return {
        ok: false,
        kind: 'corrupted',
        error: {
          lineNumber: i + 1,
          rawLine,
          reason: parseRes.error.message,
        },
        validPrefix: validRecords,
      };
    }

    validRecords.push(parseRes.data);
  }

  return {
    ok: true,
    kind: 'valid',
    records: validRecords,
  };
}

export function parseLedgerRecords(content: string): JournalParseOutcome<LedgerRecord> {
  return parseJournal(content, ledgerRecordSchema);
}

export function parseHostRecords(content: string): JournalParseOutcome<HostRecord> {
  return parseJournal(content, hostRecordSchema);
}

export function parseStreamOrder(content: string): JournalParseOutcome<StreamOrderEntry> {
  return parseJournal(content, streamOrderEntrySchema);
}
