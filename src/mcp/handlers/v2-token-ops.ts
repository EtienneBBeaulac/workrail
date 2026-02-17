/**
 * v2 Token Operations
 *
 * Pure functions for token parsing, verification, signing, and attempt ID management.
 * Extracted from v2-execution.ts to reduce god-file complexity.
 *
 * All functions are stateless and side-effect-free.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import {
  parseTokenV1Binary,
  verifyTokenSignatureV1Binary,
  signTokenV1Binary,
  type ParsedTokenV1Binary,
  type TokenDecodeErrorV2,
  type TokenVerifyErrorV2,
  type TokenSignErrorV2,
  type TokenPayloadV1,
  type AttemptId,
} from '../../v2/durable-core/tokens/index.js';
import type { TokenCodecPorts } from '../../v2/durable-core/tokens/token-codec-ports.js';
import type { Sha256PortV2 } from '../../v2/ports/sha256.port.js';
import { deriveChildAttemptId } from '../../v2/durable-core/ids/attempt-id-derivation.js';
import { errNotRetryable } from '../types.js';
import { mapTokenDecodeErrorToToolError, mapTokenVerifyErrorToToolError, type ToolFailure } from './v2-execution-helpers.js';

// Branded token input types (compile-time guarantee of token kind)
export type StateTokenInput = ParsedTokenV1Binary & {
  readonly payload: import('../../v2/durable-core/tokens/payloads.js').StateTokenPayloadV1;
};
export type AckTokenInput = ParsedTokenV1Binary & {
  readonly payload: import('../../v2/durable-core/tokens/payloads.js').AckTokenPayloadV1;
};
export type CheckpointTokenInput = ParsedTokenV1Binary & {
  readonly payload: import('../../v2/durable-core/tokens/payloads.js').CheckpointTokenPayloadV1;
};

/**
 * Parse and verify a raw state token string.
 * Returns a branded StateTokenInput or a ToolFailure.
 */
export function parseStateTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
): { ok: true; token: StateTokenInput } | { ok: false; failure: ToolFailure } {
  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return { ok: false, failure: mapTokenDecodeErrorToToolError(parsedRes.error) };
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return { ok: false, failure: mapTokenVerifyErrorToToolError(verified.error) };
  }

  if (parsedRes.value.payload.tokenKind !== 'state') {
    return {
      ok: false,
      failure: errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a state token (st1...).', {
        suggestion: 'Use the stateToken returned by WorkRail.',
      }) as ToolFailure,
    };
  }

  return { ok: true, token: parsedRes.value as StateTokenInput };
}

/**
 * Parse and verify a raw ack token string.
 * Returns a branded AckTokenInput or a ToolFailure.
 */
export function parseAckTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
): { ok: true; token: AckTokenInput } | { ok: false; failure: ToolFailure } {
  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return { ok: false, failure: mapTokenDecodeErrorToToolError(parsedRes.error) };
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return { ok: false, failure: mapTokenVerifyErrorToToolError(verified.error) };
  }

  if (parsedRes.value.payload.tokenKind !== 'ack') {
    return {
      ok: false,
      failure: errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected an ack token (ack1...).', {
        suggestion: 'Use the ackToken returned by WorkRail.',
      }) as ToolFailure,
    };
  }

  return { ok: true, token: parsedRes.value as AckTokenInput };
}

/**
 * Parse and verify a raw checkpoint token string.
 * Returns a branded CheckpointTokenInput or a ToolFailure.
 */
export function parseCheckpointTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
): { ok: true; token: CheckpointTokenInput } | { ok: false; failure: ToolFailure } {
  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return { ok: false, failure: mapTokenDecodeErrorToToolError(parsedRes.error) };
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return { ok: false, failure: mapTokenVerifyErrorToToolError(verified.error) };
  }

  if (parsedRes.value.payload.tokenKind !== 'checkpoint') {
    return {
      ok: false,
      failure: errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a checkpoint token (chk1...).', {
        suggestion: 'Use the checkpointToken returned by WorkRail.',
      }) as ToolFailure,
    };
  }

  return { ok: true, token: parsedRes.value as CheckpointTokenInput };
}

/**
 * Mint a fresh attempt ID.
 */
export function newAttemptId(idFactory: { readonly mintAttemptId: () => AttemptId }): AttemptId {
  return idFactory.mintAttemptId();
}

/**
 * Derive a deterministic child attempt ID for the next node.
 * Deterministic so replay can re-mint the same next-node tokens.
 */
export function attemptIdForNextNode(parentAttemptId: AttemptId, sha256: Sha256PortV2): Result<AttemptId, import('../../v2/durable-core/ids/attempt-id-derivation.js').AttemptIdDerivationError> {
  return deriveChildAttemptId(parentAttemptId, sha256);
}

/**
 * Sign a token payload, returning the encoded string or an error.
 */
export function signTokenOrErr(args: {
  payload: TokenPayloadV1;
  ports: TokenCodecPorts;
}): Result<string, TokenDecodeErrorV2 | TokenVerifyErrorV2 | TokenSignErrorV2> {
  const token = signTokenV1Binary(args.payload, args.ports);
  if (token.isErr()) return err(token.error);
  return ok(token.value);
}
