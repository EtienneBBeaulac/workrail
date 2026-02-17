import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { HmacSha256PortV2 } from '../../ports/hmac-sha256.port.js';
import type { KeyringV1 } from '../../ports/keyring.port.js';
import type { Base64UrlPortV2 } from '../../ports/base64url.port.js';
import type { ParsedTokenV1Binary, TokenDecodeErrorV2 } from './token-codec.js';
import { encodeTokenPayloadV1Binary } from './token-codec.js';
import type { TokenPayloadV1 } from './payloads.js';
import type { TokenSignPorts, TokenVerifyPorts } from './token-codec-capabilities.js';

export type TokenVerifyErrorV2 =
  | { readonly code: 'TOKEN_BAD_SIGNATURE'; readonly message: string }
  | { readonly code: 'TOKEN_INVALID_FORMAT'; readonly message: string };

function decodeKeyBytes(keyBase64Url: string, base64url: Base64UrlPortV2): Result<Uint8Array, TokenVerifyErrorV2> {
  const decoded = base64url.decodeBase64Url(keyBase64Url);
  if (decoded.isErr()) return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Invalid key encoding' });
  if (decoded.value.length !== 32) return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Invalid key length' });
  return ok(decoded.value);
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
  ports: TokenSignPorts,
): Result<string, TokenSignErrorV2> {
  const { keyring, hmac, base64url, base32, bech32m } = ports;

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
  ports: TokenVerifyPorts,
): Result<void, TokenVerifyErrorV2> {
  const { keyring, hmac, base64url } = ports;

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
