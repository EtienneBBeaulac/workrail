import { z } from 'zod';
import type { JsonValue } from '../v2/durable-core/canonical/json-types.js';

const shape: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(shape), z.record(shape),
]));

/** JSON shape is a transport constraint, not domain approval. Preserve the original
 * properties: Zod record parsing strips __proto__, losing rejected receipt evidence. */
export const AnswerJsonSchema = z.custom<JsonValue>(value => shape.safeParse(value).success);
