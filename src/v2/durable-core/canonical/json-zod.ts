import { z } from 'zod';

/**
 * Zod schema for JSON values.
 *
 * Used to enforce "JSON only" at v2 durable boundaries (events, manifest, snapshots),
 * so canonicalization and hashing don't accept non-JSON runtime values.
 */
export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), JsonArraySchema, JsonObjectSchema])
);

const JsonArraySchema: z.ZodType<unknown> = z.lazy(() => z.array(JsonValueSchema));
const JsonObjectSchema: z.ZodType<unknown> = z.lazy(() => z.record(JsonValueSchema));
