/**
 * Short reference token codec — pure functions, no I/O.
 *
 * WHY: v1 tokens are ~162 chars (bech32m self-contained payloads). Agents struggle to
 * copy them reliably. v2 short tokens are 27 chars: a 12-byte random nonce plus a
 * 6-byte truncated HMAC, base64url-encoded. The full session position is resolved
 * from a server-side alias index when the token is presented.
 *
 * Format: <prefix>_<base64url(nonce || hmac6)>
 *   prefix = "st_" | "ak_" | "ck_"
 *   nonce  = 12 random bytes (2^96 collision space)
 *   hmac6  = HMAC-SHA256(key, nonce || kindByte)[0..5]  (6 bytes, tamper detection)
 *   total  = 3 + 1 + 24 = 28 chars  (well, 27 if we count the prefix as 2+underscore)
 *
 * Actually: "st_" = 3 chars + 24 base64url = 27 chars total. ✓
 *
 * INVARIANTS:
 * - All functions are pure (no I/O, no global state)
 * - Errors are returned as Result, never thrown
 * - Nonce is caller-supplied (enables deterministic testing)
 * - HMAC is over (nonce || kindByte) to prevent cross-kind substitution attacks
 */

import { ok, err } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { HmacSha256PortV2 } from '../../ports/hmac-sha256.port.js';
import type { Base64UrlPortV2 } from '../../ports/base64url.port.js';
import type { KeyringV1 } from '../../ports/keyring.port.js';

// --------------------------------------------------------------------------
// Token kind
// --------------------------------------------------------------------------

export type ShortTokenKind = 'state' | 'ack' | 'checkpoint' | 'continue';

const KIND_PREFIXES: Record<ShortTokenKind, string> = {
  state: 'st_',
  ack: 'ak_',
  checkpoint: 'ck_',
  continue: 'ct_',
};

const PREFIX_TO_KIND: Record<string, ShortTokenKind> = {
  'st_': 'state',
  'ak_': 'ack',
  'ck_': 'checkpoint',
  'ct_': 'continue',
};

/** Single byte discriminator per kind, used as HMAC input suffix. */
const KIND_BYTES: Record<ShortTokenKind, number> = {
  state: 0x01,
  ack: 0x02,
  checkpoint: 0x03,
  continue: 0x04,
};

// --------------------------------------------------------------------------
// Payload size constants
// --------------------------------------------------------------------------

export const SHORT_TOKEN_NONCE_BYTES = 12;
export const SHORT_TOKEN_HMAC_BYTES = 6;
export const SHORT_TOKEN_PAYLOAD_BYTES = SHORT_TOKEN_NONCE_BYTES + SHORT_TOKEN_HMAC_BYTES; // 18

// --------------------------------------------------------------------------
// Error types
// --------------------------------------------------------------------------

export type ShortTokenError =
  | { readonly code: 'SHORT_TOKEN_UNKNOWN_PREFIX'; readonly raw: string }
  | { readonly code: 'SHORT_TOKEN_INVALID_LENGTH'; readonly expected: number; readonly actual: number }
  | { readonly code: 'SHORT_TOKEN_INVALID_ENCODING'; readonly message: string }
  | { readonly code: 'SHORT_TOKEN_BAD_SIGNATURE' }
  | { readonly code: 'SHORT_TOKEN_SIGNING_FAILED'; readonly message: string };

// --------------------------------------------------------------------------
// Parsed token (after format decode, before alias resolution)
// --------------------------------------------------------------------------

export interface ParsedShortToken {
  readonly kind: ShortTokenKind;
  readonly nonce: Uint8Array;       // 12 bytes
  readonly hmac6: Uint8Array;       // 6 bytes
  readonly nonceHex: string;        // lowercase hex of nonce — used as alias index key
}

// --------------------------------------------------------------------------
// Mint
// --------------------------------------------------------------------------

/**
 * Mint a short token string.
 *
 * Pure: caller supplies nonce (from RandomEntropyPortV2) and crypto ports.
 * Does NOT register the alias — that is the caller's responsibility.
 */
export function mintShortToken(
  kind: ShortTokenKind,
  nonce: Uint8Array,
  keyring: KeyringV1,
  hmac: HmacSha256PortV2,
  base64url: Base64UrlPortV2,
): Result<string, ShortTokenError> {
  if (nonce.length !== SHORT_TOKEN_NONCE_BYTES) {
    return err({
      code: 'SHORT_TOKEN_INVALID_LENGTH',
      expected: SHORT_TOKEN_NONCE_BYTES,
      actual: nonce.length,
    });
  }

  const keyResult = decodeKey(keyring.current.keyBase64Url, base64url);
  if (keyResult.isErr()) return err(keyResult.error);
  const key = keyResult.value;

  const hmacInput = buildHmacInput(nonce, kind);
  const hmacFull = hmac.hmacSha256(key, hmacInput);
  const hmac6 = hmacFull.slice(0, SHORT_TOKEN_HMAC_BYTES);

  const payload = new Uint8Array(SHORT_TOKEN_PAYLOAD_BYTES);
  payload.set(nonce, 0);
  payload.set(hmac6, SHORT_TOKEN_NONCE_BYTES);

  const encoded = base64url.encodeBase64Url(payload);
  return ok(`${KIND_PREFIXES[kind]}${encoded}`);
}

// --------------------------------------------------------------------------
// Parse (format decode only, no alias lookup)
// --------------------------------------------------------------------------

/**
 * Decode a short token string into its constituent parts.
 *
 * Does NOT verify the HMAC or resolve the alias.
 * Use verifyShortTokenHmac() after this for integrity check.
 */
export function parseShortToken(
  raw: string,
  base64url: Base64UrlPortV2,
): Result<ParsedShortToken, ShortTokenError> {
  const prefix = raw.slice(0, 3);
  const kind = PREFIX_TO_KIND[prefix];
  if (!kind) {
    return err({ code: 'SHORT_TOKEN_UNKNOWN_PREFIX', raw });
  }

  const encoded = raw.slice(3);
  const decoded = base64url.decodeBase64Url(encoded);
  if (decoded.isErr()) {
    return err({ code: 'SHORT_TOKEN_INVALID_ENCODING', message: decoded.error.message });
  }

  const bytes = decoded.value;
  if (bytes.length !== SHORT_TOKEN_PAYLOAD_BYTES) {
    return err({
      code: 'SHORT_TOKEN_INVALID_LENGTH',
      expected: SHORT_TOKEN_PAYLOAD_BYTES,
      actual: bytes.length,
    });
  }

  const nonce = bytes.slice(0, SHORT_TOKEN_NONCE_BYTES);
  const hmac6 = bytes.slice(SHORT_TOKEN_NONCE_BYTES);
  const nonceHex = bufToHex(nonce);

  return ok({ kind, nonce, hmac6, nonceHex });
}

// --------------------------------------------------------------------------
// Verify HMAC
// --------------------------------------------------------------------------

/**
 * Verify the truncated HMAC of a parsed short token.
 *
 * Tries current key first, then previous key (for rotation tolerance).
 * Returns err if neither key matches.
 */
export function verifyShortTokenHmac(
  parsed: ParsedShortToken,
  keyring: KeyringV1,
  hmac: HmacSha256PortV2,
  base64url: Base64UrlPortV2,
): Result<void, ShortTokenError> {
  const hmacInput = buildHmacInput(parsed.nonce, parsed.kind);

  if (checkHmac(parsed.hmac6, hmacInput, keyring.current.keyBase64Url, hmac, base64url)) {
    return ok(undefined);
  }
  if (keyring.previous) {
    if (checkHmac(parsed.hmac6, hmacInput, keyring.previous.keyBase64Url, hmac, base64url)) {
      return ok(undefined);
    }
  }
  return err({ code: 'SHORT_TOKEN_BAD_SIGNATURE' });
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

function buildHmacInput(nonce: Uint8Array, kind: ShortTokenKind): Uint8Array {
  const input = new Uint8Array(SHORT_TOKEN_NONCE_BYTES + 1);
  input.set(nonce, 0);
  input[SHORT_TOKEN_NONCE_BYTES] = KIND_BYTES[kind];
  return input;
}

function checkHmac(
  expected6: Uint8Array,
  hmacInput: Uint8Array,
  keyBase64Url: string,
  hmac: HmacSha256PortV2,
  base64url: Base64UrlPortV2,
): boolean {
  const keyResult = decodeKey(keyBase64Url, base64url);
  if (keyResult.isErr()) return false;
  const full = hmac.hmacSha256(keyResult.value, hmacInput);
  const truncated = full.slice(0, SHORT_TOKEN_HMAC_BYTES);
  return hmac.timingSafeEqual(truncated, expected6);
}

function decodeKey(
  keyBase64Url: string,
  base64url: Base64UrlPortV2,
): Result<Uint8Array, ShortTokenError> {
  const r = base64url.decodeBase64Url(keyBase64Url);
  if (r.isErr()) return err({ code: 'SHORT_TOKEN_SIGNING_FAILED', message: r.error.message });
  return ok(r.value);
}

function bufToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// --------------------------------------------------------------------------
// Native parse helper (no port injection — for tests and DI-free contexts)
// --------------------------------------------------------------------------

export interface NativeParsedShortToken {
  readonly kind: ShortTokenKind;
  readonly nonceHex: string;
}

/**
 * Parse a short token string using Node's built-in Buffer (no port injection).
 *
 * Returns null if the token is not a recognized v2 short token.
 * Does NOT verify the HMAC — call the port-based verifyShortTokenHmac() for that.
 * Intended for resolving alias lookups in tests and non-DI contexts.
 */
export function parseShortTokenNative(raw: string): NativeParsedShortToken | null {
  const prefix = raw.slice(0, 3);
  const kind = PREFIX_TO_KIND[prefix];
  if (!kind) return null;

  const encoded = raw.slice(3);
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length !== SHORT_TOKEN_PAYLOAD_BYTES) return null;
    const nonceHex = Buffer.from(bytes.slice(0, SHORT_TOKEN_NONCE_BYTES)).toString('hex');
    return { kind, nonceHex };
  } catch {
    return null;
  }
}
