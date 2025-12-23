import { z } from 'zod';

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
  data: z.record(z.unknown()),
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
    data: z.record(z.unknown()),
  }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('run_started'), data: z.record(z.unknown()) }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('node_created'), data: z.record(z.unknown()) }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('edge_created'), data: z.record(z.unknown()) }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('advance_recorded'), data: z.record(z.unknown()) }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('node_output_appended'), data: z.record(z.unknown()) }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('preferences_changed'), data: z.record(z.unknown()) }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('capability_observed'), data: z.record(z.unknown()) }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('gap_recorded'), data: z.record(z.unknown()) }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('divergence_recorded'), data: z.record(z.unknown()) }),
  DomainEventEnvelopeV1Schema.extend({ kind: z.literal('decision_trace_appended'), data: z.record(z.unknown()) }),
]);

export type DomainEventV1 = z.infer<typeof DomainEventV1Schema>;
