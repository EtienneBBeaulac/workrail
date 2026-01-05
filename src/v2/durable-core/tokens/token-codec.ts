import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import { toCanonicalBytes } from '../canonical/jcs.js';
import type { CanonicalBytes } from '../ids/index.js';
import { asCanonicalBytes, asTokenStringV1 } from '../ids/index.js';
import type { TokenStringV1 } from '../ids/index.js';
import type { Base64UrlPortV2 } from '../../ports/base64url.port.js';
import type { Bech32mPortV2, Bech32mDecodeError, TokenHrp } from '../../ports/bech32m.port.js';
import type { Base32PortV2 } from '../../ports/base32.port.js';
import { expectedPrefixForTokenKind, TokenPayloadV1Schema, type TokenPayloadV1, type TokenPrefixV1 } from './payloads.js';
import type { JsonValue } from '../canonical/json-types.js';
import {
  packStateTokenPayload,
  packAckTokenPayload,
  packCheckpointTokenPayload,
  unpackTokenPayload,
  type BinaryPackError,
} from './binary-payload.js';

export type TokenDecodeErrorV2 =
  | { readonly code: 'TOKEN_INVALID_FORMAT'; readonly message: string; readonly details?: { bech32mError?: Bech32mDecodeError } }
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

// ============================================================================
// Binary Token Format (Direction B: Binary + Bech32m)
// ============================================================================

/**
 * Parsed binary token structure.
 *
 * Wire format: <hrp>1<bech32m-data> where:
 * - hrp: 'st', 'ack', or 'chk'
 * - bech32m-data: bech32m encoding of (payload-bytes || signature-bytes)
 */
export interface ParsedTokenV1Binary {
  readonly hrp: TokenHrp; // 'st', 'ack', or 'chk'
  readonly version: '1';
  readonly payloadBytes: Uint8Array; // 66 bytes
  readonly signatureBytes: Uint8Array; // 32 bytes
  readonly payload: TokenPayloadV1;
}

/**
 * Encode token payload to binary format (66 bytes, no signature).
 * 
 * INVARIANTS:
 * - Pure function: no side effects, deterministic encoding
 * - Dispatches to kind-specific pack function (packStateTokenPayload, etc.)
 * - HRP derived from tokenKind ('st' for state, 'ack' for ack, 'chk' for checkpoint)
 * - Exhaustive switch ensures all token kinds handled (compile-time check via never)
 * - Returns both payload bytes AND hrp (caller needs both for bech32m encoding)
 * - Does NOT compute signature (separate concern, handled by token-signer.ts)
 * 
 * @param payload - Token payload (StateTokenPayloadV1 | AckTokenPayloadV1 | CheckpointTokenPayloadV1)
 * @param base32 - Base32 encoder for ID serialization
 * @returns Object with { payloadBytes: 66-byte buffer, hrp: TokenHrp } or error
 */
export function encodeTokenPayloadV1Binary(
  payload: TokenPayloadV1,
  base32: Base32PortV2,
): Result<{ payloadBytes: Uint8Array; hrp: TokenHrp }, TokenDecodeErrorV2> {
  let packResult: Result<Uint8Array, BinaryPackError>;
  let hrp: TokenHrp;

  switch (payload.tokenKind) {
    case 'state':
      packResult = packStateTokenPayload(payload, base32);
      hrp = 'st';
      break;
    case 'ack':
      packResult = packAckTokenPayload(payload, base32);
      hrp = 'ack';
      break;
    case 'checkpoint':
      packResult = packCheckpointTokenPayload(payload, base32);
      hrp = 'chk';
      break;
    default: {
      const _exhaustive: never = payload;
      return err({
        code: 'TOKEN_PAYLOAD_INVALID',
        message: `Unknown token kind in payload: expected 'state' | 'ack' | 'checkpoint'`,
      });
    }
  }

  if (packResult.isErr()) {
    return err({
      code: 'TOKEN_PAYLOAD_INVALID',
      message: `Binary pack failed: ${packResult.error.code}`,
    });
  }

  return ok({ payloadBytes: packResult.value, hrp });
}

/**
 * Parse binary + bech32m token format and extract payload.
 * 
 * INVARIANTS:
 * - Validates wire format at boundaries (fail fast on corruption)
 * - HRP prefix validation: st1/ack1/chk1 required
 * - Bech32m checksum validated before unpacking (corruption detection)
 * - Length validation: expects exactly 98 bytes (66 payload + 32 signature)
 * - HRP/kind consistency: prefix must match payload tokenKind (prevent confusion attacks)
 * - Returns defensive copies of byte arrays (prevent mutation by caller)
 * - Does NOT verify signature (caller's responsibility via verifyTokenSignatureV1Binary)
 * - Does NOT validate session/run/node existence (handler's responsibility)
 * 
 * @param tokenString - Complete token string (e.g., "st1qpzry9x8gf2tvdw0...")
 * @param bech32m - Bech32m decoder with checksum validation
 * @param base32 - Base32 decoder for ID deserialization
 * @returns ParsedTokenV1Binary with payload and signature bytes, or structured error
 */
export function parseTokenV1Binary(
  tokenString: string,
  bech32m: Bech32mPortV2,
  base32: Base32PortV2,
): Result<ParsedTokenV1Binary, TokenDecodeErrorV2> {
  // Detect prefix (st1, ack1, or chk1)
  let hrp: TokenHrp;
  let expectedKind: number;

  if (tokenString.startsWith('st1')) {
    hrp = 'st';
    expectedKind = 0;
  } else if (tokenString.startsWith('ack1')) {
    hrp = 'ack';
    expectedKind = 1;
  } else if (tokenString.startsWith('chk1')) {
    hrp = 'chk';
    expectedKind = 2;
  } else {
    return err({
      code: 'TOKEN_INVALID_FORMAT',
      message: `Invalid token format: expected st1/ack1/chk1 prefix, got '${tokenString.slice(0, 4)}'`,
    });
  }

  // Decode bech32m (includes checksum validation)
  const decodedResult = bech32m.decode(tokenString, hrp);
  if (decodedResult.isErr()) {
    const bech32mErr = decodedResult.error;

    if (bech32mErr.code === 'BECH32M_CHECKSUM_FAILED') {
      return err({
        code: 'TOKEN_INVALID_FORMAT',
        message: 'Token corrupted (bech32m checksum failed). Likely copy/paste error.',
        details: { bech32mError: bech32mErr },
      });
    }

    return err({
      code: 'TOKEN_INVALID_FORMAT',
      message: `Bech32m decode failed: ${bech32mErr.message}`,
      details: { bech32mError: bech32mErr },
    });
  }

  const allBytes = decodedResult.value;

  // Split payload (66 bytes) + signature (32 bytes)
  if (allBytes.length !== 98) {
    return err({
      code: 'TOKEN_INVALID_FORMAT',
      message: `Expected 98 bytes (66 payload + 32 sig), got ${allBytes.length}`,
    });
  }

  const payloadBytes = allBytes.slice(0, 66);
  const signatureBytes = allBytes.slice(66, 98);

  // Unpack binary payload
  const unpackedResult = unpackTokenPayload(payloadBytes, base32);
  if (unpackedResult.isErr()) {
    const unpackErr = unpackedResult.error;
    return err({
      code: unpackErr.code === 'BINARY_UNSUPPORTED_VERSION' ? 'TOKEN_UNSUPPORTED_VERSION' : 'TOKEN_INVALID_FORMAT',
      message: `Payload unpack failed: ${unpackErr.code}`,
    });
  }

  // Validate HRP matches payload tokenKind
  const actualKind = unpackedResult.value.tokenKind;
  const expectedKindStr = expectedKind === 0 ? 'state' : expectedKind === 1 ? 'ack' : 'checkpoint';

  if (
    (expectedKind === 0 && actualKind !== 'state') ||
    (expectedKind === 1 && actualKind !== 'ack') ||
    (expectedKind === 2 && actualKind !== 'checkpoint')
  ) {
    return err({
      code: 'TOKEN_INVALID_FORMAT',
      message: `Token kind mismatch: HRP implies ${expectedKindStr}, payload contains ${actualKind}`,
    });
  }

  return ok({
    hrp,
    version: '1',
    // Defensive copies prevent external mutation of internal buffers
    // (payloadBytes and signatureBytes are sliced from same underlying ArrayBuffer)
    payloadBytes: payloadBytes.slice(),      // Defensive copy: prevent mutation
    signatureBytes: signatureBytes.slice(),  // Defensive copy: prevent mutation
    payload: unpackedResult.value,           // Fresh object from unpacker (safe)
  });
}
