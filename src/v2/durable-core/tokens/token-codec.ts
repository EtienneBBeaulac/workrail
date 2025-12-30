import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import { toCanonicalBytes } from '../canonical/jcs.js';
import type { CanonicalBytes } from '../ids/index.js';
import { asCanonicalBytes, asTokenStringV1 } from '../ids/index.js';
import type { TokenStringV1 } from '../ids/index.js';
import type { Base64UrlPortV2 } from '../../ports/base64url.port.js';
import { expectedPrefixForTokenKind, TokenPayloadV1Schema, type TokenPayloadV1, type TokenPrefixV1 } from './payloads.js';
import type { JsonValue } from '../canonical/json-types.js';

export type TokenDecodeErrorV2 =
  | { readonly code: 'TOKEN_INVALID_FORMAT'; readonly message: string }
  | { readonly code: 'TOKEN_UNSUPPORTED_VERSION'; readonly message: string }
  | { readonly code: 'TOKEN_SCOPE_MISMATCH'; readonly message: string }
  | { readonly code: 'TOKEN_PAYLOAD_INVALID'; readonly message: string };

export interface ParsedTokenV1 {
  readonly prefix: TokenPrefixV1;
  readonly version: 1;
  readonly payloadBase64Url: string;
  readonly sigBase64Url: string;
  readonly payloadBytes: CanonicalBytes;
  readonly payload: TokenPayloadV1;
}

export function encodeTokenPayloadV1(payload: TokenPayloadV1): Result<CanonicalBytes, TokenDecodeErrorV2> {
  // The payload itself is the locked canonical JSON input for signing (via base64url wrapper).
  return toCanonicalBytes(payload as unknown as JsonValue).mapErr((e) => ({
    code: 'TOKEN_PAYLOAD_INVALID',
    message: e.message,
  }) as const);
}

export function encodeUnsignedTokenV1(
  payload: TokenPayloadV1,
  base64url: Base64UrlPortV2
): Result<{ readonly token: TokenStringV1; readonly payloadBytes: CanonicalBytes }, TokenDecodeErrorV2> {
  const bytes = encodeTokenPayloadV1(payload);
  if (bytes.isErr()) return err(bytes.error);

  const prefix = expectedPrefixForTokenKind(payload.tokenKind);
  const token = `${prefix}.v1.${base64url.encodeBase64Url(bytes.value as unknown as Uint8Array)}.`; // signature appended by signer
  return ok({ token: asTokenStringV1(token), payloadBytes: bytes.value });
}

export function parseTokenV1(token: string, base64url: Base64UrlPortV2): Result<ParsedTokenV1, TokenDecodeErrorV2> {
  const parts = token.split('.');
  if (parts.length !== 4) return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Expected 4 dot-separated segments' });

  const [prefix, versionPart, payloadB64, sigB64] = parts as [string, string, string, string];
  if (versionPart !== 'v1') return err({ code: 'TOKEN_UNSUPPORTED_VERSION', message: `Unsupported token version: ${versionPart}` });
  if (prefix !== 'st' && prefix !== 'ack' && prefix !== 'chk') {
    return err({ code: 'TOKEN_INVALID_FORMAT', message: `Unknown token prefix: ${prefix}` });
  }
  if (payloadB64.trim() === '' || sigB64.trim() === '') {
    return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Missing payload or signature segment' });
  }

  const decoded = base64url.decodeBase64Url(payloadB64);
  if (decoded.isErr()) return err({ code: 'TOKEN_INVALID_FORMAT', message: decoded.error.message });

  // Payload bytes are the UTF-8 bytes of JCS canonical JSON.
  const payloadBytes = asCanonicalBytes(decoded.value);

  let payloadText: string;
  try {
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes as unknown as Uint8Array);
  } catch {
    return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Payload is not valid UTF-8' });
  }

  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(payloadText);
  } catch {
    return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Payload is not valid JSON' });
  }

  const validated = TokenPayloadV1Schema.safeParse(payloadJson);
  if (!validated.success) return err({ code: 'TOKEN_INVALID_FORMAT', message: 'Token payload failed schema validation' });

  // Prefix must match payload.tokenKind to prevent ambiguous tokens.
  const expectedPrefix = expectedPrefixForTokenKind(validated.data.tokenKind);
  if (expectedPrefix !== prefix) {
    return err({ code: 'TOKEN_SCOPE_MISMATCH', message: 'Token prefix does not match payload tokenKind' });
  }

  return ok({
    prefix,
    version: 1,
    payloadBase64Url: payloadB64,
    sigBase64Url: sigB64,
    payloadBytes,
    payload: validated.data,
  });
}
