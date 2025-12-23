import { z } from 'zod';
import { JsonValueSchema } from '../../canonical/json-zod.js';

const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'Expected sha256:<64 hex chars>')
  .describe('sha256 digest in WorkRail v2 format');

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
  workflowHash: sha256DigestSchema,
  workflowSourceKind: WorkflowSourceKindSchema,
  workflowSourceRef: z.string().min(1),
});

const NodeKindSchema = z.enum(['step', 'checkpoint']);

const NodeCreatedDataV1Schema = z.object({
  nodeKind: NodeKindSchema,
  parentNodeId: z.string().min(1).nullable(),
  workflowHash: sha256DigestSchema,
  snapshotRef: sha256DigestSchema,
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
    data: JsonValueSchema,
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
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('advance_recorded'), data: JsonValueSchema }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('node_output_appended'), data: JsonValueSchema }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('preferences_changed'), data: JsonValueSchema }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('capability_observed'), data: JsonValueSchema }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('gap_recorded'), data: JsonValueSchema }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('divergence_recorded'), data: JsonValueSchema }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('decision_trace_appended'), data: JsonValueSchema }),
]);

export type DomainEventV1 = z.infer<typeof DomainEventV1Schema>;
