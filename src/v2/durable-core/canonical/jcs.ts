import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import { asCanonicalBytes } from '../ids/index.js';
import type { CanonicalBytes } from '../ids/index.js';
import type { JsonObject, JsonValue } from './json-types.js';

export type CanonicalJsonError =
  | { readonly code: 'CANONICAL_JSON_UNSUPPORTED_VALUE'; readonly message: string }
  | { readonly code: 'CANONICAL_JSON_NON_FINITE_NUMBER'; readonly message: string };

const textEncoder = new TextEncoder();

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS)
 *
 * Slice 1 implementation notes:
 * - Objects: keys sorted lexicographically by UTF-16 code units (JS default string sort).
 * - Arrays: order preserved.
 * - Numbers: reject NaN/Infinity; normalize -0 to 0; otherwise rely on JS number-to-string
 *   (must be stable and round-trippable).
 * - Strings: rely on JSON string escaping via JSON.stringify.
 *
 * This returns canonical UTF-8 bytes, intended to be the only input to v2 hashing.
 */
export function toCanonicalBytes(value: JsonValue): Result<CanonicalBytes, CanonicalJsonError> {
  const rendered = render(value);
  if (rendered.isErr()) return err(rendered.error);
  return ok(asCanonicalBytes(textEncoder.encode(rendered.value)));
}

function render(value: JsonValue): Result<string, CanonicalJsonError> {
  switch (typeof value) {
    case 'string':
      return ok(JSON.stringify(value));
    case 'number':
      return renderNumber(value);
    case 'boolean':
      return ok(value ? 'true' : 'false');
    case 'object':
      if (value === null) return ok('null');
      if (Array.isArray(value)) return renderArray(value);
      return renderObject(value as JsonObject);
    default:
      return err({
        code: 'CANONICAL_JSON_UNSUPPORTED_VALUE',
        message: `Unsupported JSON value type: ${typeof value}`,
      });
  }
}

function renderNumber(value: number): Result<string, CanonicalJsonError> {
  if (!Number.isFinite(value)) {
    return err({
      code: 'CANONICAL_JSON_NON_FINITE_NUMBER',
      message: `Non-finite numbers are not allowed in canonical JSON: ${String(value)}`,
    });
  }

  // JCS forbids -0; normalize to 0.
  const normalized = Object.is(value, -0) ? 0 : value;
  return ok(JSON.stringify(normalized));
}

function renderArray(values: readonly JsonValue[]): Result<string, CanonicalJsonError> {
  const parts: string[] = [];
  for (const v of values) {
    const r = render(v);
    if (r.isErr()) return err(r.error);
    parts.push(r.value);
  }
  return ok(`[${parts.join(',')}]`);
}

function renderObject(obj: JsonObject): Result<string, CanonicalJsonError> {
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];

  for (const key of keys) {
    const keyJson = JSON.stringify(key);
    const valueJson = render(obj[key]!);
    if (valueJson.isErr()) return err(valueJson.error);
    parts.push(`${keyJson}:${valueJson.value}`);
  }

  return ok(`{${parts.join(',')}}`);
}
