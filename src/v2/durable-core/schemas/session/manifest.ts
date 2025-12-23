import { z } from 'zod';

const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'Expected sha256:<64 hex chars>')
  .describe('sha256 digest in WorkRail v2 format');

/**
 * `manifest.jsonl` record kinds (schemaVersion 1, locked)
 *
 * Locked by: `docs/design/v2-core-design-locks.md` (Two-stream model).
 */
export const ManifestRecordV1Schema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    manifestIndex: z.number().int().nonnegative(),
    sessionId: z.string().min(1),
    kind: z.literal('segment_closed'),
    firstEventIndex: z.number().int().nonnegative(),
    lastEventIndex: z.number().int().nonnegative(),
    segmentRelPath: z.string().min(1), // relative; no abs validation here (adapter must enforce)
    sha256: sha256DigestSchema,
    bytes: z.number().int().nonnegative(),
  }),
  z.object({
    v: z.literal(1),
    manifestIndex: z.number().int().nonnegative(),
    sessionId: z.string().min(1),
    kind: z.literal('snapshot_pinned'),
    eventIndex: z.number().int().nonnegative(),
    snapshotRef: sha256DigestSchema,
    createdByEventId: z.string().min(1),
  }),
]);

export type ManifestRecordV1 = z.infer<typeof ManifestRecordV1Schema>;
