import type { Result } from 'neverthrow';
import { ok } from 'neverthrow';
import type { CanonicalJsonError } from './jcs.js';
import { toCanonicalBytes } from './jcs.js';
import type { JsonValue } from './json-types.js';

/**
 * Deterministic JSONL line encoding.
 *
 * Lock intent:
 * - storage files should be deterministic on disk
 * - each record is rendered as canonical JSON (RFC 8785 JCS), followed by '\n'
 *
 * Note: the returned bytes are NOT "canonical JSON bytes" because of the trailing newline.
 */
export function toJsonlLineBytes(value: JsonValue): Result<Uint8Array, CanonicalJsonError> {
  return toCanonicalBytes(value).map((canonical) => concatNewline(canonical as unknown as Uint8Array));
}

function concatNewline(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  out[out.length - 1] = 0x0a; // '\n'
  return out;
}
