import { z } from 'zod';
import { JsonValueSchema } from '../../canonical/json-zod.js';
import { asSha256Digest, asWorkflowHash } from '../../ids/index.js';
import { AutonomyV2Schema, RiskPolicyV2Schema } from './preferences.js';
import {
  MAX_DECISION_TRACE_ENTRIES,
  MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES,
  MAX_DECISION_TRACE_TOTAL_BYTES,
  MAX_OBSERVATION_SHORT_STRING_LENGTH,
  SHA256_DIGEST_PATTERN,
} from '../../constants.js';
import { DecisionTraceRefsV1Schema } from '../lib/decision-trace-ref.js';
import { DedupeKeyV1Schema } from '../lib/dedupe-key.js';
import { utf8BoundedString } from '../lib/utf8-bounded-string.js';
import { utf8ByteLength } from '../lib/utf8-byte-length.js';
import { ValidationPerformedDataV1Schema } from './validation-event.js';
import { BlockerReportV1Schema } from './blockers.js';
import { NodeOutputAppendedDataV1Schema } from './outputs.js';
import { GapRecordedDataV1Schema } from './gaps.js';
import { NodeCreatedDataV1Schema, EdgeCreatedDataV1Schema } from './dag-topology.js';

const sha256DigestSchema = z
  .string()
  .regex(SHA256_DIGEST_PATTERN, 'Expected sha256:<64 hex chars>')
  .describe('sha256 digest in WorkRail v2 format');

const workflowHashSchema = sha256DigestSchema
  .transform((v) => asWorkflowHash(asSha256Digest(v)))
  .describe('WorkflowHash (sha256 digest of workflow definition)');

/**
 * Minimal domain event envelope (initial v2 schema, locked)
 *
 * Note: Slice 2 needs the envelope shape to be stable for the session event log substrate,
 * even before token-based orchestration (Slice 3) is implemented.
 */
export const DomainEventEnvelopeV1Schema = z.object({
  v: z.literal(1),
  eventId: z.string().min(1),
  eventIndex: z.number().int().nonnegative(), // 0-based
  sessionId: z.string().min(1),
  kind: z.string().min(1), // further constrained by union below
  // Lock: dedupeKey is ASCII-safe, length-bounded, and follows a recipe pattern
  dedupeKey: DedupeKeyV1Schema,
  scope: z
    .object({
      runId: z.string().min(1).optional(),
      nodeId: z.string().min(1).optional(),
    })
    .optional(),
  data: JsonValueSchema,
});

/**
 * Projection-critical payload schemas (locked)
 * These are tightened early to enable type-safe pure projections.
 */
const WorkflowSourceKindSchema = z.enum(['bundled', 'user', 'project', 'remote', 'plugin']);

const RunStartedDataV1Schema = z.object({
  workflowId: z.string().min(1),
  workflowHash: workflowHashSchema,
  workflowSourceKind: WorkflowSourceKindSchema,
  workflowSourceRef: z.string().min(1),
});

/**
 * @deprecated The blocked outcome variant is deprecated as of the blocked nodes architectural upgrade (ADR 008).
 * Use blocked_attempt nodes (nodeKind=blocked_attempt) instead.
 * This variant will be removed in 2 releases to allow for backward compatibility during migration.
 * 
 * Migration path:
 * - Query blocked attempts via DAG topology: `projectRunDagV2(events)` and filter nodes by `nodeKind === 'blocked_attempt'`
 * - Load validation details from `validation_performed` events
 * - Load blockers from the blocked snapshot (engineState.blocked.blockers)
 */
const AdvanceRecordedOutcomeV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('blocked'), blockers: BlockerReportV1Schema }),
  z.object({ kind: z.literal('advanced'), toNodeId: z.string().min(1) }),
]);

const AdvanceRecordedDataV1Schema = z.object({
  attemptId: z.string().min(1),
  intent: z.literal('ack_pending'),
  outcome: AdvanceRecordedOutcomeV1Schema,
});

const PreferencesChangedDataV1Schema = z
  .object({
    changeId: z.string().min(1),
    source: z.enum(['user', 'workflow_recommendation', 'system']),
    delta: z
      .array(
        z.discriminatedUnion('key', [
          z.object({ key: z.literal('autonomy'), value: AutonomyV2Schema }),
          z.object({ key: z.literal('riskPolicy'), value: RiskPolicyV2Schema }),
        ])
      )
      .min(1),
    effective: z.object({
      autonomy: AutonomyV2Schema,
      riskPolicy: RiskPolicyV2Schema,
    }),
  })
  .superRefine((v, ctx) => {
    const keys = v.delta.map((d) => d.key);
    const unique = new Set(keys);
    if (unique.size !== keys.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'delta must not contain duplicate keys', path: ['delta'] });
    }
  });

/**
 * Closed-set domain event kinds (initial v2 union, locked).
 *
 * Slice 2 does not need full per-kind schemas yet, but it does need the kind set
 * to be closed so projections and storage don't drift under "stringly kinds".
 */
export const DomainEventV1Schema = z.discriminatedUnion('kind', [
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('session_created'), data: z.object({}) }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('observation_recorded'),
    scope: z.undefined(),
    data: z.object({
      key: z.enum(['git_branch', 'git_head_sha', 'repo_root_hash']),
      value: z.discriminatedUnion('type', [
        z.object({ type: z.literal('short_string'), value: z.string().min(1).max(MAX_OBSERVATION_SHORT_STRING_LENGTH) }),
        z.object({ type: z.literal('git_sha1'), value: z.string().regex(/^[0-9a-f]{40}$/) }),
        z.object({ type: z.literal('sha256'), value: sha256DigestSchema }),
      ]),
      confidence: z.enum(['low', 'med', 'high']),
    }),
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('run_started'),
    scope: z.object({ runId: z.string().min(1) }),
    data: RunStartedDataV1Schema,
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('node_created'),
    scope: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    data: NodeCreatedDataV1Schema,
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('edge_created'),
    scope: z.object({ runId: z.string().min(1) }),
    data: EdgeCreatedDataV1Schema,
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('advance_recorded'),
    scope: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    data: AdvanceRecordedDataV1Schema,
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('validation_performed'),
    scope: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    data: ValidationPerformedDataV1Schema,
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('node_output_appended'),
    scope: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    data: NodeOutputAppendedDataV1Schema,
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('preferences_changed'),
    scope: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    data: PreferencesChangedDataV1Schema,
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('capability_observed'),
    scope: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    data: z
      .object({
        capObsId: z.string().min(1),
        capability: z.enum(['delegation', 'web_browsing']),
        status: z.enum(['unknown', 'available', 'unavailable']),
        provenance: z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('probe_step'),
            enforcementGrade: z.literal('strong'),
            detail: z.object({
              probeTemplateId: z.string().min(1),
              probeStepId: z.string().min(1),
              result: z.enum(['success', 'failure']),
            }),
          }),
          z.object({
            kind: z.literal('attempted_use'),
            enforcementGrade: z.literal('strong'),
            detail: z.object({
              attemptContext: z.enum(['workflow_step', 'system_probe']),
              result: z.enum(['success', 'failure']),
              failureCode: z.enum(['tool_missing', 'tool_error', 'policy_blocked', 'unknown']).optional(),
            }),
          }),
          z.object({
            kind: z.literal('manual_claim'),
            enforcementGrade: z.literal('weak'),
            detail: z.object({
              claimedBy: z.enum(['agent', 'user']),
              claim: z.enum(['available', 'unavailable']),
            }),
          }),
        ]),
      })
      .superRefine((v, ctx) => {
        // Lock: attempted_use failure must include failureCode.
        if (v.provenance.kind === 'attempted_use') {
          const detail = v.provenance.detail;
          if (detail.result === 'failure' && !detail.failureCode) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'attempted_use failure requires failureCode',
              path: ['provenance', 'detail', 'failureCode'],
            });
          }
        }
      }),
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('gap_recorded'),
    scope: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    data: GapRecordedDataV1Schema,
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('context_set'),
    scope: z.object({ runId: z.string().min(1) }),
    data: z.object({
      contextId: z.string().min(1),
      context: JsonValueSchema,
      source: z.enum(['initial', 'agent_delta']),
    }),
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('divergence_recorded'),
    scope: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    data: z.object({
      divergenceId: z.string().min(1),
      reason: z.enum(['missing_user_context', 'capability_unavailable', 'efficiency_skip', 'safety_stop', 'policy_constraint']),
      summary: z.string().min(1),
      relatedStepId: z.string().min(1).optional(),
    }),
  }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('decision_trace_appended'),
    scope: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    data: z
      .object({
        traceId: z.string().min(1),
        entries: z
          .array(
            z.object({
              kind: z.enum(['selected_next_step', 'evaluated_condition', 'entered_loop', 'exited_loop', 'detected_non_tip_advance']),
              // Lock: summary is bounded by UTF-8 bytes (not code units)
              summary: utf8BoundedString({ maxBytes: MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES, label: 'decision trace entry summary', minLength: 1 }),
              // Lock: refs is a closed union, not an open bag. See decision-trace-ref.ts
              refs: DecisionTraceRefsV1Schema,
            })
          )
          .min(1)
          .max(MAX_DECISION_TRACE_ENTRIES),
      })
      .refine(
        (data) => {
          // Locked: total UTF-8 bytes across all entry summaries must not exceed MAX_DECISION_TRACE_TOTAL_BYTES
          const totalBytes = data.entries.reduce((sum, entry) => sum + utf8ByteLength(entry.summary), 0);
          return totalBytes <= MAX_DECISION_TRACE_TOTAL_BYTES;
        },
        { message: `Decision trace total bytes exceeds ${MAX_DECISION_TRACE_TOTAL_BYTES}` }
      ),
  }),
]);

export type DomainEventV1 = z.infer<typeof DomainEventV1Schema>;
