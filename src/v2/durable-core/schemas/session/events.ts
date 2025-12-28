import { z } from 'zod';
import { JsonValueSchema } from '../../canonical/json-zod.js';
import { asSha256Digest, asSnapshotRef, asWorkflowHash } from '../../ids/index.js';

const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'Expected sha256:<64 hex chars>')
  .describe('sha256 digest in WorkRail v2 format');

const workflowHashSchema = sha256DigestSchema
  .transform((v) => asWorkflowHash(asSha256Digest(v)))
  .describe('WorkflowHash (sha256 digest of workflow definition)');

const snapshotRefSchema = sha256DigestSchema
  .transform((v) => asSnapshotRef(asSha256Digest(v)))
  .describe('SnapshotRef (content-addressed sha256 ref)');

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
  dedupeKey: z.string().min(1),
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

const NodeKindSchema = z.enum(['step', 'checkpoint']);

const NodeCreatedDataV1Schema = z.object({
  nodeKind: NodeKindSchema,
  parentNodeId: z.string().min(1).nullable(),
  workflowHash: workflowHashSchema,
  snapshotRef: snapshotRefSchema,
});

const EdgeKindSchema = z.enum(['acked_step', 'checkpoint']);
const EdgeCauseKindSchema = z.enum(['idempotent_replay', 'intentional_fork', 'non_tip_advance', 'checkpoint_created']);
const EdgeCauseSchema = z.object({
  kind: EdgeCauseKindSchema,
  eventId: z.string().min(1),
});

const EdgeCreatedDataV1Schema = z
  .object({
    edgeKind: EdgeKindSchema,
    fromNodeId: z.string().min(1),
    toNodeId: z.string().min(1),
    cause: EdgeCauseSchema,
  })
  .superRefine((v, ctx) => {
    // Lock: for checkpoint edges, cause.kind must be checkpoint_created.
    if (v.edgeKind === 'checkpoint' && v.cause.kind !== 'checkpoint_created') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'edgeKind=checkpoint requires cause.kind=checkpoint_created',
        path: ['cause', 'kind'],
      });
    }
  });

const OutputChannelSchema = z.enum(['recap', 'artifact']);

const NotesPayloadV1Schema = z.object({
  payloadKind: z.literal('notes'),
  notesMarkdown: z.string().min(1),
});

const ArtifactRefPayloadV1Schema = z.object({
  payloadKind: z.literal('artifact_ref'),
  sha256: sha256DigestSchema,
  contentType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
});

const OutputPayloadV1Schema = z.discriminatedUnion('payloadKind', [NotesPayloadV1Schema, ArtifactRefPayloadV1Schema]);

const NodeOutputAppendedDataV1Schema = z
  .object({
    outputId: z.string().min(1),
    supersedesOutputId: z.string().min(1).optional(),
    outputChannel: OutputChannelSchema,
    payload: OutputPayloadV1Schema,
  })
  .superRefine((v, ctx) => {
    // Locked: recap channel must use notes payload.
    if (v.outputChannel === 'recap' && v.payload.payloadKind !== 'notes') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'outputChannel=recap requires payloadKind=notes',
        path: ['payload', 'payloadKind'],
      });
    }
  });

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
  z.object({ kind: z.literal('context_key'), key: z.string().min(1) }),
  z.object({ kind: z.literal('context_budget') }),
  z.object({ kind: z.literal('output_contract'), contractRef: z.string().min(1) }),
  z.object({ kind: z.literal('capability'), capability: z.enum(['delegation', 'web_browsing']) }),
  z.object({ kind: z.literal('workflow_step'), stepId: z.string().min(1) }),
]);

const BlockerSchema = z.object({
  code: BlockerCodeSchema,
  pointer: BlockerPointerSchema,
  message: z.string().min(1),
  suggestedFix: z.string().min(1).optional(),
});

const BlockerReportV1Schema = z
  .object({
    blockers: z.array(BlockerSchema).min(1).max(10),
  })
  .superRefine((v, ctx) => {
    // Deterministic ordering lock: (code, pointer.kind, pointer.* stable fields) ascending.
    const keyFor = (b: z.infer<typeof BlockerSchema>): string => {
      const p = b.pointer;
      let ptrStable: string;
      switch (p.kind) {
        case 'context_key':
          ptrStable = p.key;
          break;
        case 'output_contract':
          ptrStable = p.contractRef;
          break;
        case 'capability':
          ptrStable = p.capability;
          break;
        case 'workflow_step':
          ptrStable = p.stepId;
          break;
        case 'context_budget':
          ptrStable = '';
          break;
        default:
          const _exhaustive: never = p;
          ptrStable = _exhaustive;
      }
      return `${b.code}|${p.kind}|${String(ptrStable)}`;
    };

    for (let i = 1; i < v.blockers.length; i++) {
      if (keyFor(v.blockers[i - 1]!) > keyFor(v.blockers[i]!)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'blockers must be deterministically sorted',
          path: ['blockers'],
        });
        break;
      }
    }
  });

const AdvanceRecordedOutcomeV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('blocked'), blockers: BlockerReportV1Schema }),
  z.object({ kind: z.literal('advanced'), toNodeId: z.string().min(1) }),
]);

const AdvanceRecordedDataV1Schema = z.object({
  attemptId: z.string().min(1),
  intent: z.literal('ack_pending'),
  outcome: AdvanceRecordedOutcomeV1Schema,
});

const AutonomySchema = z.enum(['guided', 'full_auto_stop_on_user_deps', 'full_auto_never_stop']);
const RiskPolicySchema = z.enum(['conservative', 'balanced', 'aggressive']);

const PreferencesChangedDataV1Schema = z
  .object({
    changeId: z.string().min(1),
    source: z.enum(['user', 'workflow_recommendation', 'system']),
    delta: z
      .array(
        z.discriminatedUnion('key', [
          z.object({ key: z.literal('autonomy'), value: AutonomySchema }),
          z.object({ key: z.literal('riskPolicy'), value: RiskPolicySchema }),
        ])
      )
      .min(1),
    effective: z.object({
      autonomy: AutonomySchema,
      riskPolicy: RiskPolicySchema,
    }),
  })
  .superRefine((v, ctx) => {
    const keys = v.delta.map((d) => d.key);
    const unique = new Set(keys);
    if (unique.size !== keys.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'delta must not contain duplicate keys', path: ['delta'] });
    }
  });

const UserOnlyDependencyReasonSchema = z.enum([
  'needs_user_secret_or_token',
  'needs_user_account_access',
  'needs_user_artifact',
  'needs_user_choice',
  'needs_user_approval',
  'needs_user_environment_action',
]);

const GapReasonSchema = z.discriminatedUnion('category', [
  z.object({ category: z.literal('user_only_dependency'), detail: UserOnlyDependencyReasonSchema }),
  z.object({ category: z.literal('contract_violation'), detail: z.enum(['missing_required_output', 'invalid_required_output']) }),
  z.object({
    category: z.literal('capability_missing'),
    detail: z.enum(['required_capability_unavailable', 'required_capability_unknown']),
  }),
  z.object({ category: z.literal('unexpected'), detail: z.enum(['invariant_violation', 'storage_corruption_detected']) }),
]);

const GapResolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unresolved') }),
  z.object({ kind: z.literal('resolves'), resolvesGapId: z.string().min(1) }),
]);

const GapEvidenceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), eventId: z.string().min(1) }),
  z.object({ kind: z.literal('output'), outputId: z.string().min(1) }),
]);

const GapRecordedDataV1Schema = z.object({
  gapId: z.string().min(1),
  severity: z.enum(['info', 'warning', 'critical']),
  reason: GapReasonSchema,
  summary: z.string().min(1),
  resolution: GapResolutionSchema,
  evidenceRefs: z.array(GapEvidenceRefSchema).optional(),
});

/**
 * Closed-set domain event kinds (initial v2 union, locked).
 *
 * Slice 2 does not need full per-kind schemas yet, but it does need the kind set
 * to be closed so projections and storage don’t drift under “stringly kinds”.
 */
export const DomainEventV1Schema = z.discriminatedUnion('kind', [
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('session_created'), data: z.object({}) }),
  DomainEventEnvelopeV1Schema.extend({
    kind: z.literal('observation_recorded'),
    scope: z.undefined(),
    data: z.object({
      key: z.enum(['git_branch', 'git_head_sha', 'repo_root_hash']),
      value: z.discriminatedUnion('type', [
        z.object({ type: z.literal('short_string'), value: z.string().min(1).max(80) }),
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
    data: z.object({
      traceId: z.string().min(1),
      entries: z
        .array(
          z.object({
            kind: z.enum(['selected_next_step', 'evaluated_condition', 'entered_loop', 'exited_loop', 'detected_non_tip_advance']),
            summary: z.string().min(1).max(512),
            refs: z.record(z.unknown()).optional(),
          })
        )
        .min(1)
        .max(25),
    }),
  }),
]);

export type DomainEventV1 = z.infer<typeof DomainEventV1Schema>;
