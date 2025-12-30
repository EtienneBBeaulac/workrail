import { z } from 'zod';
import type { Brand } from '../../../../runtime/brand.js';

/**
 * DedupeKey (v2, locked).
 *
 * Lock: dedupeKey is a stable idempotency key derived only from stable identifiers.
 * - Must be ASCII-safe (no unicode, no whitespace except none)
 * - Must be length-bounded
 * - Must NOT be derived from eventId (eventId is server-minted per append)
 * - Must follow a recipe pattern: `<kind>:<sessionId>:<...parts>`
 *
 * See: docs/design/v2-core-design-locks.md (Idempotency via dedupeKey)
 */

/**
 * DedupeKey branded type.
 *
 * Lock: dedupeKey is constructed, not arbitrary.
 */
export type DedupeKeyV1 = Brand<string, 'v2.DedupeKeyV1'>;

/**
 * Allowed characters in a dedupeKey.
 *
 * Lock: ASCII-safe, includes lowercase letters, digits, underscore, hyphen, colon, and greater-than.
 * Pattern: `[a-z0-9_:>-]+`
 *
 * Note: hyphen at end of character class to avoid range interpretation.
 */
export const DEDUPE_KEY_PATTERN = /^[a-z0-9_:>-]+$/;

/**
 * Maximum length of a dedupeKey.
 *
 * Lock: bounded to prevent unbounded growth.
 * Typical keys are ~60-100 chars; 256 allows headroom for long IDs.
 */
export const MAX_DEDUPE_KEY_LENGTH = 256;

/**
 * DedupeKey schema (validation-only, no transform).
 *
 * Lock: validates pattern and length.
 *
 * Note: This schema validates but does not transform to the branded type.
 * Use buildDedupeKey() for construction with branding.
 * This allows existing event construction code to work while enforcing validation.
 */
export const DedupeKeyV1Schema = z
  .string()
  .min(1)
  .max(MAX_DEDUPE_KEY_LENGTH)
  .regex(DEDUPE_KEY_PATTERN, 'dedupeKey must be ASCII-safe: [a-z0-9_:->]+');

/**
 * Builds a dedupeKey from a kind and parts.
 *
 * Lock: dedupeKey recipe is `<kind>:<parts joined by ":">`
 *
 * @param kind Event kind (e.g., 'session_created', 'node_created')
 * @param parts Stable identifier parts (e.g., sessionId, runId, nodeId)
 * @returns DedupeKey
 *
 * @example
 * buildDedupeKey('session_created', ['sess_01JH']) // 'session_created:sess_01JH'
 * buildDedupeKey('node_created', ['sess_01JH', 'run_01JH', 'node_01JH']) // 'node_created:sess_01JH:run_01JH:node_01JH'
 * buildDedupeKey('edge_created', ['sess_01JH', 'run_01JH', 'nodeA->nodeB', 'acked_step']) // 'edge_created:sess_01JH:run_01JH:nodeA->nodeB:acked_step'
 */
export function buildDedupeKey(kind: string, parts: readonly string[]): DedupeKeyV1 {
  const key = [kind, ...parts].join(':');
  
  // Validate at construction time (fail-fast)
  if (!DEDUPE_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid dedupeKey: "${key}" does not match pattern ${DEDUPE_KEY_PATTERN}`);
  }
  if (key.length > MAX_DEDUPE_KEY_LENGTH) {
    throw new Error(`Invalid dedupeKey: "${key}" exceeds max length ${MAX_DEDUPE_KEY_LENGTH}`);
  }
  
  return key as DedupeKeyV1;
}

/**
 * Validates a raw string as a dedupeKey.
 *
 * Use this when parsing external input; prefer buildDedupeKey for construction.
 */
export function isValidDedupeKey(value: string): value is DedupeKeyV1 {
  return (
    value.length > 0 &&
    value.length <= MAX_DEDUPE_KEY_LENGTH &&
    DEDUPE_KEY_PATTERN.test(value)
  );
}
