import type { JsonObject } from '../canonical/json-types.js';
import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';

export type ContextMergeError = {
  readonly code: 'RESERVED_KEY_REJECTED';
  readonly message: string;
  readonly key: string;
};

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Shallow merge stored context with caller delta.
 *
 * Semantics (locked for implementation per §18.2):
 * - Caller keys override stored keys at top level
 * - null values delete the key (tombstone)
 * - undefined values are ignored (no-op)
 * - Arrays/objects are replaced, not merged
 * - Reserved keys (__proto__, constructor, prototype) are rejected
 *
 * @example
 * mergeContext({a:1, b:2}, {b:3, c:4}) => {a:1, b:3, c:4}
 * mergeContext({a:1, b:2}, {b:null})   => {a:1}
 * mergeContext({a:1}, {b:undefined})   => {a:1}
 */
export function mergeContext(
  stored: JsonObject | undefined,
  delta: JsonObject | undefined
): Result<JsonObject, ContextMergeError> {
  if (!delta) return ok(stored ?? {});
  if (!stored) return stripNullAndValidate(delta);

  // Check for reserved keys in delta
  // Note: Object.keys() doesn't include __proto__, so we check with 'in' operator
  for (const reservedKey of RESERVED_KEYS) {
    if (reservedKey in delta && Object.prototype.hasOwnProperty.call(delta, reservedKey)) {
      return err({
        code: 'RESERVED_KEY_REJECTED',
        message: `Context key '${reservedKey}' is reserved and cannot be used.`,
        key: reservedKey,
      });
    }
  }

  // Functional merge: start with stored, apply delta transformations
  const tombstones = new Set(
    Object.entries(delta)
      .filter(([_, v]) => v === null)
      .map(([k]) => k)
  );

  const overrides = Object.fromEntries(
    Object.entries(delta).filter(([_, v]) => v !== null && v !== undefined)
  );

  // Filter out tombstoned keys from stored, then apply overrides
  const mergedEntries = Object.entries(stored)
    .filter(([k]) => !tombstones.has(k))
    .concat(Object.entries(overrides));

  return ok(Object.fromEntries(mergedEntries) as JsonObject);
}

/**
 * Strip null values and validate no reserved keys.
 */
function stripNullAndValidate(obj: JsonObject): Result<JsonObject, ContextMergeError> {
  // Check for reserved keys first
  const reservedKey = Object.keys(obj).find(k => RESERVED_KEYS.has(k));
  if (reservedKey) {
    return err({
      code: 'RESERVED_KEY_REJECTED',
      message: `Context key '${reservedKey}' is reserved and cannot be used.`,
      key: reservedKey,
    });
  }

  // Filter out null/undefined values functionally
  const entries = Object.entries(obj).filter(([_, v]) => v !== null && v !== undefined);
  return ok(Object.fromEntries(entries) as JsonObject);
}
