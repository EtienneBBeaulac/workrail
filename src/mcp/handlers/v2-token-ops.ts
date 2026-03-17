/**
 * v2 Token Operations
 *
 * Parse, verify, sign, and mint tokens for v2 tool handlers.
 *
 * WHY DUAL PATH:
 * v1 tokens (st1.../ack1.../chk1...) are self-contained bech32m payloads.
 * v2 short tokens (st_.../ak_.../ck_...) are 27-char reference tokens backed
 * by a server-side alias index. Both formats must be accepted during transition.
 * Prefix dispatch determines which path to use — no ambiguity exists between formats.
 *
 * INVARIANT: The three parseXxxOrFail() functions are the single gateway for all
 * incoming tokens. Any new token format must be handled here, not in callers.
 */

import type { ResultAsync } from 'neverthrow';
import { okAsync, errAsync } from 'neverthrow';
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
import {
  parseShortToken,
  verifyShortTokenHmac,
  mintShortToken,
  SHORT_TOKEN_NONCE_BYTES,
} from '../../v2/durable-core/tokens/short-token.js';
import type { TokenAliasStorePortV2, TokenAliasEntryV2 } from '../../v2/ports/token-alias-store.port.js';
import type { RandomEntropyPortV2 } from '../../v2/ports/random-entropy.port.js';
import type {
  StateTokenPayloadV1,
  AckTokenPayloadV1,
  CheckpointTokenPayloadV1,
} from '../../v2/durable-core/tokens/payloads.js';
import {
  asAttemptId,
  asNodeId,
  asRunId,
  asSessionId,
  asWorkflowHashRef,
} from '../../v2/durable-core/ids/index.js';

// Branded token input types (compile-time guarantee of token kind)
export type StateTokenInput = ParsedTokenV1Binary & {
  readonly payload: StateTokenPayloadV1;
};
export type AckTokenInput = ParsedTokenV1Binary & {
  readonly payload: AckTokenPayloadV1;
};
export type CheckpointTokenInput = ParsedTokenV1Binary & {
  readonly payload: CheckpointTokenPayloadV1;
};

/**
 * Resolved continue token — carries ALL fields needed for both advance and rehydrate.
 *
 * WHY: The one-token protocol collapses stateToken + ackToken into a single opaque token.
 * The server resolves session identity AND advance authority from this alone.
 * No need for separate state/ack parsing or scope-matching assertions.
 */
export interface ContinueTokenResolved {
  readonly sessionId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly attemptId: string;
  readonly workflowHashRef: string;
}

// --------------------------------------------------------------------------
// Internal: v2 short token → synthetic ParsedTokenV1Binary
// --------------------------------------------------------------------------

/**
 * Resolve a v2 short token to a synthetic ParsedTokenV1Binary via the alias store.
 *
 * WHY SYNTHETIC: The handlers downstream expect ParsedTokenV1Binary.
 * Rather than threading a new type through all handlers, we reconstruct the
 * equivalent parsed structure from the alias entry. The payload fields are
 * typed-asserted from the entry's string values, which were validated when
 * the alias was registered.
 */
function resolveShortToken(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<ParsedTokenV1Binary, ToolFailure> {
  const parsed = parseShortToken(raw, ports.base64url);
  if (parsed.isErr()) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', `Short token format invalid: ${parsed.error.code}`, {
        suggestion: 'Use the token returned by WorkRail (st_... / ak_... / ck_...).',
      }) as ToolFailure,
    );
  }

  const hmacResult = verifyShortTokenHmac(parsed.value, ports.keyring, ports.hmac, ports.base64url);
  if (hmacResult.isErr()) {
    return errAsync(
      errNotRetryable('TOKEN_BAD_SIGNATURE', 'Short token HMAC verification failed.', {
        suggestion: 'Use the exact token returned by WorkRail — do not modify it.',
      }) as ToolFailure,
    );
  }

  const entry = aliasStore.lookup(parsed.value.nonceHex);
  if (!entry) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Short token not found in alias index (unknown nonce).', {
        suggestion: 'Use the token returned by WorkRail in the current session.',
      }) as ToolFailure,
    );
  }

  // Reconstruct a synthetic ParsedTokenV1Binary from the alias entry.
  // payloadBytes and signatureBytes are left empty — they are not used by
  // handler logic; only payload.* fields are accessed downstream.
  let payload: TokenPayloadV1;
  if (entry.tokenKind === 'state') {
    if (!entry.workflowHashRef) {
      return errAsync(
        errNotRetryable('TOKEN_INVALID_FORMAT', 'Alias entry for state token is missing workflowHashRef.') as ToolFailure,
      );
    }
    const statePayload: StateTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: asSessionId(entry.sessionId),
      runId: asRunId(entry.runId),
      nodeId: asNodeId(entry.nodeId),
      workflowHashRef: asWorkflowHashRef(entry.workflowHashRef),
    };
    payload = statePayload;
  } else if (entry.tokenKind === 'ack') {
    if (!entry.attemptId) {
      return errAsync(
        errNotRetryable('TOKEN_INVALID_FORMAT', 'Alias entry for ack token is missing attemptId.') as ToolFailure,
      );
    }
    const ackPayload: AckTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'ack',
      sessionId: asSessionId(entry.sessionId),
      runId: asRunId(entry.runId),
      nodeId: asNodeId(entry.nodeId),
      attemptId: asAttemptId(entry.attemptId),
    };
    payload = ackPayload;
  } else {
    // checkpoint
    if (!entry.attemptId) {
      return errAsync(
        errNotRetryable('TOKEN_INVALID_FORMAT', 'Alias entry for checkpoint token is missing attemptId.') as ToolFailure,
      );
    }
    const ckPayload: CheckpointTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'checkpoint',
      sessionId: asSessionId(entry.sessionId),
      runId: asRunId(entry.runId),
      nodeId: asNodeId(entry.nodeId),
      attemptId: asAttemptId(entry.attemptId),
    };
    payload = ckPayload;
  }

  const synthetic: ParsedTokenV1Binary = {
    hrp: entry.tokenKind === 'state' ? 'st' : entry.tokenKind === 'ack' ? 'ack' : 'chk',
    version: '1',
    payloadBytes: new Uint8Array(66),    // synthetic — not used by handlers
    signatureBytes: new Uint8Array(32),  // synthetic — not used by handlers
    payload,
  };

  return okAsync(synthetic);
}

// --------------------------------------------------------------------------
// Public: dual-path async parse functions
// --------------------------------------------------------------------------

/**
 * Parse and verify a raw state token string (v1 or v2 short format).
 * Returns a branded StateTokenInput or a ToolFailure.
 */
export function parseStateTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<StateTokenInput, ToolFailure> {
  // v2 short token path
  if (raw.startsWith('st_')) {
    return resolveShortToken(raw, ports, aliasStore).andThen((resolved) => {
      if (resolved.payload.tokenKind !== 'state') {
        return errAsync(
          errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a state token (st_... or st1...).', {
            suggestion: 'Use the stateToken returned by WorkRail.',
          }) as ToolFailure,
        );
      }
      return okAsync(resolved as StateTokenInput);
    });
  }

  // v1 bech32m path
  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return errAsync(mapTokenDecodeErrorToToolError(parsedRes.error));
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return errAsync(mapTokenVerifyErrorToToolError(verified.error));
  }

  if (parsedRes.value.payload.tokenKind !== 'state') {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a state token (st1...).', {
        suggestion: 'Use the stateToken returned by WorkRail.',
      }) as ToolFailure,
    );
  }

  return okAsync(parsedRes.value as StateTokenInput);
}

/**
 * Parse and verify a raw ack token string (v1 or v2 short format).
 * Returns a branded AckTokenInput or a ToolFailure.
 */
export function parseAckTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<AckTokenInput, ToolFailure> {
  // v2 short token path
  if (raw.startsWith('ak_')) {
    return resolveShortToken(raw, ports, aliasStore).andThen((resolved) => {
      if (resolved.payload.tokenKind !== 'ack') {
        return errAsync(
          errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected an ack token (ak_... or ack1...).', {
            suggestion: 'Use the ackToken returned by WorkRail.',
          }) as ToolFailure,
        );
      }
      return okAsync(resolved as AckTokenInput);
    });
  }

  // v1 bech32m path
  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return errAsync(mapTokenDecodeErrorToToolError(parsedRes.error));
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return errAsync(mapTokenVerifyErrorToToolError(verified.error));
  }

  if (parsedRes.value.payload.tokenKind !== 'ack') {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected an ack token (ack1...).', {
        suggestion: 'Use the ackToken returned by WorkRail.',
      }) as ToolFailure,
    );
  }

  return okAsync(parsedRes.value as AckTokenInput);
}

/**
 * Parse and verify a raw checkpoint token string (v1 or v2 short format).
 * Returns a branded CheckpointTokenInput or a ToolFailure.
 */
export function parseCheckpointTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<CheckpointTokenInput, ToolFailure> {
  // v2 short token path
  if (raw.startsWith('ck_')) {
    return resolveShortToken(raw, ports, aliasStore).andThen((resolved) => {
      if (resolved.payload.tokenKind !== 'checkpoint') {
        return errAsync(
          errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a checkpoint token (ck_... or chk1...).', {
            suggestion: 'Use the checkpointToken returned by WorkRail.',
          }) as ToolFailure,
        );
      }
      return okAsync(resolved as CheckpointTokenInput);
    });
  }

  // v1 bech32m path
  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return errAsync(mapTokenDecodeErrorToToolError(parsedRes.error));
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return errAsync(mapTokenVerifyErrorToToolError(verified.error));
  }

  if (parsedRes.value.payload.tokenKind !== 'checkpoint') {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a checkpoint token (chk1...).', {
        suggestion: 'Use the checkpointToken returned by WorkRail.',
      }) as ToolFailure,
    );
  }

  return okAsync(parsedRes.value as CheckpointTokenInput);
}

// --------------------------------------------------------------------------
// Public: continue token (one-token protocol)
// --------------------------------------------------------------------------

/**
 * Parse and verify a raw continue token string (`ct_` prefix, v2 short format only).
 *
 * WHY: The continue token is the single token agents pass to `continue_workflow`.
 * It resolves to all 5 position fields (session, run, node, attempt, workflowHashRef).
 * No v1 bech32m equivalent exists -- this is a v2-only concept.
 */
export function parseContinueTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<ContinueTokenResolved, ToolFailure> {
  if (!raw.startsWith('ct_')) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a continue token (ct_...).', {
        suggestion: 'Use the continueToken returned by WorkRail.',
      }) as ToolFailure,
    );
  }

  const parsed = parseShortToken(raw, ports.base64url);
  if (parsed.isErr()) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', `Continue token format invalid: ${parsed.error.code}`, {
        suggestion: 'Use the continueToken returned by WorkRail.',
      }) as ToolFailure,
    );
  }

  const hmacResult = verifyShortTokenHmac(parsed.value, ports.keyring, ports.hmac, ports.base64url);
  if (hmacResult.isErr()) {
    return errAsync(
      errNotRetryable('TOKEN_BAD_SIGNATURE', 'Continue token HMAC verification failed.', {
        suggestion: 'Use the exact continueToken returned by WorkRail -- do not modify it.',
      }) as ToolFailure,
    );
  }

  const entry = aliasStore.lookup(parsed.value.nonceHex);
  if (!entry) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Continue token not found in alias index (unknown nonce).', {
        suggestion: 'Use the continueToken returned by WorkRail in the current session.',
      }) as ToolFailure,
    );
  }

  if (entry.tokenKind !== 'continue') {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Token alias is not a continue token.', {
        suggestion: 'Use the continueToken returned by WorkRail.',
      }) as ToolFailure,
    );
  }

  if (!entry.attemptId || !entry.workflowHashRef) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Continue token alias entry is missing required fields.', {
        suggestion: 'Use the continueToken returned by WorkRail.',
      }) as ToolFailure,
    );
  }

  return okAsync({
    sessionId: entry.sessionId,
    runId: entry.runId,
    nodeId: entry.nodeId,
    attemptId: entry.attemptId,
    workflowHashRef: entry.workflowHashRef,
  });
}

// --------------------------------------------------------------------------
// Public: mint continue token + checkpoint token pair
// --------------------------------------------------------------------------

export interface ContinueAndCheckpointTokens {
  readonly continueToken: string;
  readonly checkpointToken: string;
}

/**
 * Mint a continue token (ct_) and checkpoint token (ck_) pair for a step response.
 *
 * The continue token carries ALL position data (session, run, node, attempt, workflowHashRef).
 * This replaces the old triple-mint (state + ack + checkpoint) for one-token responses.
 *
 * INVARIANT: Both aliases are registered before any token string is returned.
 */
export function mintContinueAndCheckpointTokens(
  args: Omit<MintShortTokenTripleArgs, 'entry'> & {
    readonly entry: Omit<TokenAliasEntryV2, 'nonceHex' | 'tokenKind'>;
  },
): ResultAsync<ContinueAndCheckpointTokens, ToolFailure> {
  const { entry, ports, aliasStore, entropy } = args;

  // Idempotency: check if continue token already exists for this position
  const existingContinue = aliasStore.lookupByPosition('continue', entry.sessionId, entry.nodeId, entry.attemptId, entry.aliasSlot);
  const existingCk = aliasStore.lookupByPosition('checkpoint', entry.sessionId, entry.nodeId, entry.attemptId, entry.aliasSlot);

  if (existingContinue && existingCk) {
    const replayContinue = reTokenFromNonceHex('continue', existingContinue.nonceHex, ports);
    const replayCk = reTokenFromNonceHex('checkpoint', existingCk.nonceHex, ports);
    if (replayContinue.isOk() && replayCk.isOk()) {
      return okAsync({
        continueToken: replayContinue.value,
        checkpointToken: replayCk.value,
      });
    }
    // Fallthrough: re-mint on reconstruction failure
  }

  // Mint continue token (always fresh — no existing continue found above)
  const continueNonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);
  const continueMinted = mintShortToken('continue', continueNonce, ports.keyring, ports.hmac, ports.base64url);
  if (continueMinted.isErr()) {
    return errAsync(
      errNotRetryable('INTERNAL_ERROR', `Token minting failed: ${continueMinted.error.code}`) as ToolFailure,
    );
  }
  const continueNonceHex = bufToHex(continueNonce);

  // Reuse existing checkpoint if one was already registered (e.g. by mintShortTokenTriple)
  // to maintain idempotency when both minting functions are called for the same position.
  let ckTokenStr: string;
  if (existingCk) {
    const replayCk = reTokenFromNonceHex('checkpoint', existingCk.nonceHex, ports);
    if (replayCk.isOk()) {
      // Existing checkpoint reused; register only the new continue alias and return.
      const continueEntry: TokenAliasEntryV2 = {
        nonceHex: continueNonceHex, tokenKind: 'continue', aliasSlot: entry.aliasSlot,
        sessionId: entry.sessionId, runId: entry.runId, nodeId: entry.nodeId,
        attemptId: entry.attemptId, workflowHashRef: entry.workflowHashRef,
      };
      return aliasStore.register(continueEntry)
        .map(() => ({ continueToken: continueMinted.value, checkpointToken: replayCk.value }))
        .mapErr((regErr) => errNotRetryable('INTERNAL_ERROR', `Alias registration failed: ${regErr.code}`) as ToolFailure);
    }
    // Fallback: mint fresh checkpoint (nonce reconstruction failed)
    const ckNonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);
    const ckMinted = mintShortToken('checkpoint', ckNonce, ports.keyring, ports.hmac, ports.base64url);
    if (ckMinted.isErr()) return errAsync(errNotRetryable('INTERNAL_ERROR', `Token minting failed: ${ckMinted.error.code}`) as ToolFailure);
    ckTokenStr = ckMinted.value;
    const ckEntry: TokenAliasEntryV2 = { nonceHex: bufToHex(ckNonce), tokenKind: 'checkpoint', aliasSlot: entry.aliasSlot, sessionId: entry.sessionId, runId: entry.runId, nodeId: entry.nodeId, attemptId: entry.attemptId };
    return aliasStore.register({ nonceHex: continueNonceHex, tokenKind: 'continue', aliasSlot: entry.aliasSlot, sessionId: entry.sessionId, runId: entry.runId, nodeId: entry.nodeId, attemptId: entry.attemptId, workflowHashRef: entry.workflowHashRef } satisfies TokenAliasEntryV2)
      .andThen(() => aliasStore.register(ckEntry))
      .map(() => ({ continueToken: continueMinted.value, checkpointToken: ckTokenStr }))
      .mapErr((regErr) => errNotRetryable('INTERNAL_ERROR', `Alias registration failed: ${regErr.code}`) as ToolFailure);
  } else {
    const ckNonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);
    const ckMinted = mintShortToken('checkpoint', ckNonce, ports.keyring, ports.hmac, ports.base64url);
    if (ckMinted.isErr()) return errAsync(errNotRetryable('INTERNAL_ERROR', `Token minting failed: ${ckMinted.error.code}`) as ToolFailure);
    ckTokenStr = ckMinted.value;
    const ckEntry: TokenAliasEntryV2 = { nonceHex: bufToHex(ckNonce), tokenKind: 'checkpoint', aliasSlot: entry.aliasSlot, sessionId: entry.sessionId, runId: entry.runId, nodeId: entry.nodeId, attemptId: entry.attemptId };
    return aliasStore.register({ nonceHex: continueNonceHex, tokenKind: 'continue', aliasSlot: entry.aliasSlot, sessionId: entry.sessionId, runId: entry.runId, nodeId: entry.nodeId, attemptId: entry.attemptId, workflowHashRef: entry.workflowHashRef } satisfies TokenAliasEntryV2)
      .andThen(() => aliasStore.register(ckEntry))
      .map(() => ({ continueToken: continueMinted.value, checkpointToken: ckTokenStr }))
      .mapErr((regErr) => errNotRetryable('INTERNAL_ERROR', `Alias registration failed: ${regErr.code}`) as ToolFailure);
  }
}

// --------------------------------------------------------------------------
// Internal: reconstruct a short token string from a stored nonce hex
// --------------------------------------------------------------------------

/**
 * Re-derive the token string from a stored nonce hex (for idempotent replay).
 *
 * The stored entry has the nonce; we re-compute the HMAC to get the full token.
 * This is deterministic given the same key and nonce.
 */
function reTokenFromNonceHex(
  kind: import('../../v2/durable-core/tokens/short-token.js').ShortTokenKind,
  nonceHex: string,
  ports: TokenCodecPorts,
): Result<string, ToolFailure> {
  const nonceBytes = hexToBuf(nonceHex);
  if (!nonceBytes) {
    return err(errNotRetryable('INTERNAL_ERROR', `Invalid stored nonce hex: ${nonceHex}`) as ToolFailure);
  }
  const result = mintShortToken(kind, nonceBytes, ports.keyring, ports.hmac, ports.base64url);
  if (result.isErr()) {
    return err(errNotRetryable('INTERNAL_ERROR', `Failed to reconstruct token from nonce: ${result.error.code}`) as ToolFailure);
  }
  return ok(result.value);
}

// --------------------------------------------------------------------------
// Short token minting helper
// --------------------------------------------------------------------------

export interface ShortTokenTriple {
  readonly stateToken: string;
  readonly ackToken: string;
  readonly checkpointToken: string;
}

export interface MintShortTokenTripleArgs {
  readonly entry: Omit<TokenAliasEntryV2, 'nonceHex' | 'tokenKind'>;
  readonly ports: TokenCodecPorts;
  readonly aliasStore: TokenAliasStorePortV2;
  readonly entropy: RandomEntropyPortV2;
}

/**
 * Mint a complete set of short tokens (state + ack + checkpoint) for a step response.
 *
 * INVARIANT: All three aliases are registered before any token string is returned.
 * If any registration fails, the whole operation fails — no partial token set is emitted.
 *
 * Caller supplies the position data (sessionId, runId, nodeId, attemptId, workflowHashRef)
 * that will be stored in the alias entries.
 */
export function mintShortTokenTriple(
  args: MintShortTokenTripleArgs,
): ResultAsync<ShortTokenTriple, ToolFailure> {
  const { entry, ports, aliasStore, entropy } = args;

  // --- Idempotency check ---
  // If aliases for this position already exist (replay path), return the same tokens.
  // State tokens don't embed attemptId — their position key is (kind, sessionId, nodeId, undefined).
  // Ack and checkpoint tokens include attemptId in the key.
  const existingState = aliasStore.lookupByPosition('state', entry.sessionId, entry.nodeId, undefined, entry.aliasSlot);
  const existingAck = aliasStore.lookupByPosition('ack', entry.sessionId, entry.nodeId, entry.attemptId, entry.aliasSlot);
  const existingCk = aliasStore.lookupByPosition('checkpoint', entry.sessionId, entry.nodeId, entry.attemptId, entry.aliasSlot);

  if (existingState && existingAck && existingCk) {
    // Reconstruct the token strings from the existing alias entries.
    const replayState = reTokenFromNonceHex('state', existingState.nonceHex, ports);
    const replayAck = reTokenFromNonceHex('ack', existingAck.nonceHex, ports);
    const replayCk = reTokenFromNonceHex('checkpoint', existingCk.nonceHex, ports);
    if (replayState.isOk() && replayAck.isOk() && replayCk.isOk()) {
      return okAsync({
        stateToken: replayState.value,
        ackToken: replayAck.value,
        checkpointToken: replayCk.value,
      });
    }
    // Fallthrough: re-minting if nonce reconstruction fails (should not happen).
  }

  // Mint three independent nonces — one per token kind.
  const stateNonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);
  const ackNonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);
  const ckNonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);

  const stateMinted = mintShortToken('state', stateNonce, ports.keyring, ports.hmac, ports.base64url);
  const ackMinted = mintShortToken('ack', ackNonce, ports.keyring, ports.hmac, ports.base64url);
  const ckMinted = mintShortToken('checkpoint', ckNonce, ports.keyring, ports.hmac, ports.base64url);

  if (stateMinted.isErr() || ackMinted.isErr() || ckMinted.isErr()) {
    const msg = stateMinted.isErr()
      ? stateMinted.error.code
      : ackMinted.isErr()
      ? ackMinted.error.code
      : ckMinted.isErr()
      ? ckMinted.error.code
      : 'UNKNOWN';
    return errAsync(
      errNotRetryable('INTERNAL_ERROR', `Short token minting failed: ${msg}`) as ToolFailure,
    );
  }

  const stateTokenStr = stateMinted.value;
  const ackTokenStr = ackMinted.value;
  const ckTokenStr = ckMinted.value;

  const stateNonceHex = bufToHex(stateNonce);
  const ackNonceHex = bufToHex(ackNonce);
  const ckNonceHex = bufToHex(ckNonce);

  // Register all three aliases before returning any token string.
  const stateEntry: TokenAliasEntryV2 = {
    nonceHex: stateNonceHex,
    tokenKind: 'state',
    aliasSlot: entry.aliasSlot,
    sessionId: entry.sessionId,
    runId: entry.runId,
    nodeId: entry.nodeId,
    workflowHashRef: entry.workflowHashRef,
  };
  const ackEntry: TokenAliasEntryV2 = {
    nonceHex: ackNonceHex,
    tokenKind: 'ack',
    aliasSlot: entry.aliasSlot,
    sessionId: entry.sessionId,
    runId: entry.runId,
    nodeId: entry.nodeId,
    attemptId: entry.attemptId,
  };
  const ckEntry: TokenAliasEntryV2 = {
    nonceHex: ckNonceHex,
    tokenKind: 'checkpoint',
    aliasSlot: entry.aliasSlot,
    sessionId: entry.sessionId,
    runId: entry.runId,
    nodeId: entry.nodeId,
    attemptId: entry.attemptId,
  };

  return aliasStore.register(stateEntry)
    .andThen(() => aliasStore.register(ackEntry))
    .andThen(() => aliasStore.register(ckEntry))
    .map(() => ({
      stateToken: stateTokenStr,
      ackToken: ackTokenStr,
      checkpointToken: ckTokenStr,
    }))
    .mapErr((regErr) => {
      const detail = regErr.code === 'ALIAS_DUPLICATE_NONCE'
        ? `duplicate nonce: ${regErr.nonceHex}`
        : regErr.message;
      return errNotRetryable(
        'INTERNAL_ERROR',
        `Token alias registration failed: ${detail}`,
      ) as ToolFailure;
    });
}

// --------------------------------------------------------------------------
// Single-token mint helper (for cases that need one token, not a full triple)
// --------------------------------------------------------------------------

export interface MintSingleShortTokenArgs {
  readonly kind: import('../../v2/durable-core/tokens/short-token.js').ShortTokenKind;
  readonly entry: Omit<TokenAliasEntryV2, 'nonceHex' | 'tokenKind'>;
  readonly ports: TokenCodecPorts;
  readonly aliasStore: TokenAliasStorePortV2;
  readonly entropy: RandomEntropyPortV2;
}

/**
 * Mint a single short token of the given kind and register its alias.
 *
 * Used for individual tokens that don't need a full triple (e.g. retryAckToken,
 * or a standalone checkpoint token on a blocked replay).
 */
export function mintSingleShortToken(
  args: MintSingleShortTokenArgs,
): ResultAsync<string, ToolFailure> {
  const { kind, entry, ports, aliasStore, entropy } = args;

  // Idempotency: state tokens don't embed attemptId — use undefined for their key.
  const lookupAttemptId = kind === 'state' ? undefined : entry.attemptId;
  const existing = aliasStore.lookupByPosition(kind, entry.sessionId, entry.nodeId, lookupAttemptId, entry.aliasSlot);
  if (existing) {
    const rebuilt = reTokenFromNonceHex(kind, existing.nonceHex, ports);
    if (rebuilt.isOk()) return okAsync(rebuilt.value);
    // Fallthrough: re-mint on reconstruction failure (should not happen).
  }

  const nonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);
  const minted = mintShortToken(kind, nonce, ports.keyring, ports.hmac, ports.base64url);
  if (minted.isErr()) {
    return errAsync(
      errNotRetryable('INTERNAL_ERROR', `Short token minting failed: ${minted.error.code}`) as ToolFailure,
    );
  }

  const tokenStr = minted.value;
  const nonceHex = bufToHex(nonce);

  const aliasEntry: TokenAliasEntryV2 = {
    nonceHex,
    tokenKind: kind,
    aliasSlot: entry.aliasSlot,
    sessionId: entry.sessionId,
    runId: entry.runId,
    nodeId: entry.nodeId,
    attemptId: entry.attemptId,
    workflowHashRef: entry.workflowHashRef,
  };

  return aliasStore.register(aliasEntry)
    .map(() => tokenStr)
    .mapErr((regErr) => {
      const detail = regErr.code === 'ALIAS_DUPLICATE_NONCE'
        ? `duplicate nonce: ${regErr.nonceHex}`
        : regErr.message;
      return errNotRetryable(
        'INTERNAL_ERROR',
        `Token alias registration failed: ${detail}`,
      ) as ToolFailure;
    });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function bufToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (isNaN(byte)) return null;
    bytes[i] = byte;
  }
  return bytes;
}

// --------------------------------------------------------------------------
// Unchanged utilities
// --------------------------------------------------------------------------

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
 *
 * @deprecated Use mintShortTokenTriple() for new minting call sites.
 * This function remains for any v1-only code paths that have not yet been migrated.
 */
export function signTokenOrErr(args: {
  payload: TokenPayloadV1;
  ports: TokenCodecPorts;
}): Result<string, TokenDecodeErrorV2 | TokenVerifyErrorV2 | TokenSignErrorV2> {
  const token = signTokenV1Binary(args.payload, args.ports);
  if (token.isErr()) return err(token.error);
  return ok(token.value);
}
