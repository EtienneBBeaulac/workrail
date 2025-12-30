import { z } from 'zod';

const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'Expected sha256:<64 hex chars>')
  .describe('sha256 digest in WorkRail v2 format');

/**
 * Relative path validation: reject absolute paths and path traversal.
 * Locked by: `docs/design/v2-core-design-locks.md` Section 13 (paths-relative-only).
 */
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith('/') && !path.startsWith('\\'),
    'Path must be relative (no absolute paths)',
  )
  .refine(
    (path) => !path.includes('../') && !path.includes('..\\'),
    'Path must not contain path traversal (..)',
  );

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
    segmentRelPath: relativePathSchema,
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
