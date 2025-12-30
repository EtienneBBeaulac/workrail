import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { HmacSha256PortV2 } from '../../ports/hmac-sha256.port.js';
import type { KeyringV1 } from '../../ports/keyring.port.js';
import type { Base64UrlPortV2 } from '../../ports/base64url.port.js';
import type { CanonicalBytes, TokenStringV1 } from '../ids/index.js';
import { asTokenStringV1 } from '../ids/index.js';
import type { ParsedTokenV1, TokenDecodeErrorV2 } from './token-codec.js';

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
