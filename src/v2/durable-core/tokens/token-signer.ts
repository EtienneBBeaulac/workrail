import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { HmacSha256PortV2 } from '../../ports/hmac-sha256.port.js';
import type { KeyringV1 } from '../../ports/keyring.port.js';
import type { Base64UrlPortV2 } from '../../ports/base64url.port.js';
import type { Bech32mPortV2 } from '../../ports/bech32m.port.js';
import type { Base32PortV2 } from '../../ports/base32.port.js';
import type { CanonicalBytes, TokenStringV1 } from '../ids/index.js';
import { asTokenStringV1 } from '../ids/index.js';
import type { ParsedTokenV1, ParsedTokenV1Binary, TokenDecodeErrorV2 } from './token-codec.js';
import { encodeTokenPayloadV1Binary } from './token-codec.js';
import type { TokenPayloadV1 } from './payloads.js';

export type TokenVerifyErrorV2 =
  | { readonly code: 'TOKEN_BAD_SIGNATURE'; readonly message: string }
  | { readonly code: 'TOKEN_INVALID_FORMAT'; readonly message: string };

function decodeKeyBytes(keyBase64Url: string, base64url: Base64UrlPortV2): Result<Uint8Array, TokenVerifyErrorV2> {
  const decoded = base64url.decodeBase64Url(keyBase64Url);
  if (decoded.isErr()) return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Invalid key encoding' });
  if (decoded.value.length !== 32) return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Invalid key length' });
  return ok(decoded.value);
}

export function signTokenV1(
  unsignedTokenPrefix: 'st.v1.' | 'ack.v1.' | 'chk.v1.',
  payloadBytes: CanonicalBytes,
  keyring: KeyringV1,
  hmac: HmacSha256PortV2,
  base64url: Base64UrlPortV2
): Result<TokenStringV1, TokenVerifyErrorV2> {
  const key = decodeKeyBytes(keyring.current.keyBase64Url, base64url);
  if (key.isErr()) return err(key.error);

  const sig = hmac.hmacSha256(key.value, payloadBytes as unknown as Uint8Array);
  const token = `${unsignedTokenPrefix}${base64url.encodeBase64Url(payloadBytes as unknown as Uint8Array)}.${base64url.encodeBase64Url(sig)}`;
  return ok(asTokenStringV1(token));
}

export function verifyTokenSignatureV1(
  parsed: ParsedTokenV1,
  keyring: KeyringV1,
  hmac: HmacSha256PortV2,
  base64url: Base64UrlPortV2
): Result<void, TokenVerifyErrorV2> {
  const sigBytes = base64url.decodeBase64Url(parsed.sigBase64Url);
  if (sigBytes.isErr()) return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Invalid signature encoding' });
  if (sigBytes.value.length !== 32) return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Invalid signature length' });

  const keys: string[] = [keyring.current.keyBase64Url];
  if (keyring.previous) keys.push(keyring.previous.keyBase64Url);

  for (const k of keys) {
    const key = decodeKeyBytes(k, base64url);
    if (key.isErr()) continue;
    const expected = hmac.hmacSha256(key.value, parsed.payloadBytes as unknown as Uint8Array);
    if (hmac.timingSafeEqual(expected, sigBytes.value)) return ok(undefined);
  }

  return err({ code: 'TOKEN_BAD_SIGNATURE', message: 'Signature verification failed' });
}

export function assertTokenScopeMatchesState(
  state: ParsedTokenV1,
  other: ParsedTokenV1
): Result<void, TokenDecodeErrorV2> {
  if (state.payload.tokenKind !== 'state') {
    return err({ code: 'TOKEN_SCOPE_MISMATCH', message: 'Expected a state token for scope comparison' });
  }
  if (state.payload.sessionId !== other.payload.sessionId) return err({ code: 'TOKEN_SCOPE_MISMATCH', message: 'sessionId mismatch' });
  if (state.payload.runId !== other.payload.runId) return err({ code: 'TOKEN_SCOPE_MISMATCH', message: 'runId mismatch' });
  if (state.payload.nodeId !== other.payload.nodeId) return err({ code: 'TOKEN_SCOPE_MISMATCH', message: 'nodeId mismatch' });
  return ok(undefined);
}

// ============================================================================
// Binary Token Format (Direction B: Binary + Bech32m)
// ============================================================================

export type TokenSignErrorV2 =
  | { readonly code: 'TOKEN_ENCODE_FAILED'; readonly message: string }
  | { readonly code: 'KEYRING_INVALID'; readonly message: string };

/**
 * Sign token payload and encode to bech32m format.
 *
 * Wire format: <hrp>1<bech32m-data> where:
 * - hrp: 'st', 'ack', or 'chk'
 * - bech32m-data: bech32m encoding of (payload-bytes || signature-bytes)
 *
 * Example: st1qpzry9x8gf2tvdw0s3jn54khce6mua7l...
 */
export function signTokenV1Binary(
  payload: TokenPayloadV1,
  keyring: KeyringV1,
  hmac: HmacSha256PortV2,
  base64url: Base64UrlPortV2,
  bech32m: Bech32mPortV2,
  base32: Base32PortV2,
): Result<string, TokenSignErrorV2> {
  // Decode key from keyring
  const key = decodeKeyBytes(keyring.current.keyBase64Url, base64url);
  if (key.isErr()) {
    return err({ code: 'KEYRING_INVALID', message: 'Invalid current key' });
  }

  // Pack to binary (66 bytes)
  const encodeResult = encodeTokenPayloadV1Binary(payload, base32);
  if (encodeResult.isErr()) {
    return err({
      code: 'TOKEN_ENCODE_FAILED',
      message: `Binary pack failed: ${encodeResult.error.message}`,
    });
  }

  const { payloadBytes, hrp } = encodeResult.value;

  // Sign payload bytes (HMAC-SHA256, 32 bytes)
  const signature = hmac.hmacSha256(key.value, payloadBytes);

  // Concatenate payload + signature (66 + 32 = 98 bytes)
  const combined = new Uint8Array(98);
  combined.set(payloadBytes, 0);
  combined.set(signature, 66);

  // Encode to bech32m with HRP
  const token = bech32m.encode(hrp, combined);

  return ok(token);
}

/**
 * Verify signature of a binary token.
 *
 * Supports key rotation: tries current key first, then previous key.
 */
export function verifyTokenSignatureV1Binary(
  parsed: ParsedTokenV1Binary,
  keyring: KeyringV1,
  hmac: HmacSha256PortV2,
  base64url: Base64UrlPortV2,
): Result<void, TokenVerifyErrorV2> {
  if (parsed.signatureBytes.length !== 32) {
    return err({
      code: 'TOKEN_INVALID_FORMAT',
      message: `Expected 32-byte signature, got ${parsed.signatureBytes.length}`,
    });
  }

  const keys: string[] = [keyring.current.keyBase64Url];
  if (keyring.previous) keys.push(keyring.previous.keyBase64Url);

  for (const k of keys) {
    const key = decodeKeyBytes(k, base64url);
    if (key.isErr()) continue;

    const expected = hmac.hmacSha256(key.value, parsed.payloadBytes);

    if (hmac.timingSafeEqual(expected, parsed.signatureBytes)) {
      return ok(undefined);
    }
  }

  return err({
    code: 'TOKEN_BAD_SIGNATURE',
    message: 'Signature verification failed',
  });
}

/**
 * Assert that a binary token's scope matches a state token.
 */
export function assertTokenScopeMatchesStateBinary(
  state: ParsedTokenV1Binary,
  other: ParsedTokenV1Binary,
): Result<void, TokenDecodeErrorV2> {
  if (state.payload.tokenKind !== 'state') {
    return err({ code: 'TOKEN_SCOPE_MISMATCH', message: 'Expected a state token for scope comparison' });
  }
  if (state.payload.sessionId !== other.payload.sessionId) {
    return err({ code: 'TOKEN_SCOPE_MISMATCH', message: 'sessionId mismatch' });
  }
  if (state.payload.runId !== other.payload.runId) {
    return err({ code: 'TOKEN_SCOPE_MISMATCH', message: 'runId mismatch' });
  }
  if (state.payload.nodeId !== other.payload.nodeId) {
    return err({ code: 'TOKEN_SCOPE_MISMATCH', message: 'nodeId mismatch' });
  }
  return ok(undefined);
}
