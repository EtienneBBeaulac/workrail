/**
 * v2 Token Operations Use Cases
 *
 * Parse, verify, sign, and mint tokens for v2 durable execution.
 * Decoupled from the MCP layer.
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
} from '../durable-core/tokens/index.js';
import type { TokenCodecPorts } from '../durable-core/tokens/token-codec-ports.js';
import type { Sha256PortV2 } from '../ports/sha256.port.js';
import { deriveChildAttemptId } from '../durable-core/ids/attempt-id-derivation.js';
import {
  parseShortToken,
  verifyShortTokenHmac,
  mintShortToken,
  SHORT_TOKEN_NONCE_BYTES,
} from '../durable-core/tokens/short-token.js';
import type { TokenAliasStorePortV2, TokenAliasEntryV2 } from '../ports/token-alias-store.port.js';
import type { RandomEntropyPortV2 } from '../ports/random-entropy.port.js';
import type {
  StateTokenPayloadV1,
  AckTokenPayloadV1,
  CheckpointTokenPayloadV1,
} from '../durable-core/tokens/payloads.js';
import {
  asAttemptId,
  asNodeId,
  asRunId,
  asSessionId,
  asWorkflowHashRef,
} from '../durable-core/ids/index.js';
import type { SessionId, RunId, NodeId, WorkflowHashRef } from '../durable-core/ids/index.js';

export interface TokenOpsError {
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly details?: unknown;
}

function errNotRetryable(code: string, message: string, extra?: { suggestion?: string; details?: unknown }): TokenOpsError {
  return { code, message, suggestion: extra?.suggestion, details: extra?.details };
}

export function mapTokenDecodeErrorToTokenOpsError(e: TokenDecodeErrorV2): TokenOpsError {
  if (e.code === 'TOKEN_INVALID_FORMAT' && e.details?.bech32mError) {
    const bech32mErr = e.details.bech32mError;
    if (bech32mErr.code === 'BECH32M_CHECKSUM_FAILED') {
      return errNotRetryable(
        'TOKEN_INVALID_FORMAT',
        'Token corrupted (bech32m checksum failed). Likely copy/paste error.',
        {
          suggestion: 'Use the exact token string as returned. Do not truncate or modify it.',
          details: {
            errorType: 'corruption_detected',
            estimatedPosition: bech32mErr.position ?? null,
            tokenFormat: 'binary+bech32m',
          },
        }
      );
    }
    if (bech32mErr.code === 'BECH32M_HRP_MISMATCH') {
      return errNotRetryable(
        'TOKEN_INVALID_FORMAT',
        `Wrong token type. ${e.message}`,
        {
          suggestion: 'Ensure you are using the correct token type for this operation (continueToken, checkpointToken, or resumeToken).',
          details: {
            errorType: 'hrp_mismatch',
          },
        }
      );
    }
  }

  switch (e.code) {
    case 'TOKEN_INVALID_FORMAT':
      return errNotRetryable('TOKEN_INVALID_FORMAT', e.message, {
        suggestion: 'Use the exact tokens returned by WorkRail. Tokens are opaque; do not edit or construct them.',
      });
    case 'TOKEN_UNSUPPORTED_VERSION':
      return errNotRetryable('TOKEN_UNSUPPORTED_VERSION', e.message, {
        suggestion: 'Update WorkRail to a version that supports this token format.',
      });
    case 'TOKEN_SCOPE_MISMATCH':
      return errNotRetryable('TOKEN_SCOPE_MISMATCH', e.message, {
        suggestion: 'Tokens must come from the same WorkRail response. Do not mix tokens from different runs or nodes.',
      });
    case 'TOKEN_PAYLOAD_INVALID':
      return errNotRetryable('TOKEN_INVALID_FORMAT', e.message, {
        suggestion: 'Use the exact tokens returned by WorkRail.',
      });
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}

export function mapTokenVerifyErrorToTokenOpsError(e: TokenVerifyErrorV2): TokenOpsError {
  switch (e.code) {
    case 'TOKEN_BAD_SIGNATURE':
      return errNotRetryable('TOKEN_BAD_SIGNATURE', e.message, {
        suggestion: 'Token signature verification failed. Use the exact tokens returned by WorkRail.',
      });
    case 'TOKEN_INVALID_FORMAT':
      return errNotRetryable('TOKEN_INVALID_FORMAT', e.message, {
        suggestion: 'Use the exact tokens returned by WorkRail.',
      });
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}

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
 */
export interface ContinueTokenResolved {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
  readonly workflowHashRef: WorkflowHashRef;
}

function resolveShortToken(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<ParsedTokenV1Binary, TokenOpsError> {
  const parsed = parseShortToken(raw, ports.base64url);
  if (parsed.isErr()) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', `Short token format invalid: ${parsed.error.code}`, {
        suggestion: 'Use the token returned by WorkRail (st_... / ak_... / ck_...).',
      })
    );
  }

  const hmacResult = verifyShortTokenHmac(parsed.value, ports.keyring, ports.hmac, ports.base64url);
  if (hmacResult.isErr()) {
    return errAsync(
      errNotRetryable('TOKEN_BAD_SIGNATURE', 'Short token HMAC verification failed.', {
        suggestion: 'Use the exact token returned by WorkRail — do not modify it.',
      })
    );
  }

  const entry = aliasStore.lookup(parsed.value.nonceHex);
  if (!entry) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Short token not found in alias index (unknown nonce).', {
        suggestion: 'Use the token returned by WorkRail in the current session.',
      })
    );
  }

  let payload: TokenPayloadV1;
  if (entry.tokenKind === 'state') {
    if (!entry.workflowHashRef) {
      return errAsync(
        errNotRetryable('TOKEN_INVALID_FORMAT', 'Alias entry for state token is missing workflowHashRef.')
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
        errNotRetryable('TOKEN_INVALID_FORMAT', 'Alias entry for ack token is missing attemptId.')
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
    if (!entry.attemptId) {
      return errAsync(
        errNotRetryable('TOKEN_INVALID_FORMAT', 'Alias entry for checkpoint token is missing attemptId.')
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
    payloadBytes: new Uint8Array(66),
    signatureBytes: new Uint8Array(32),
    payload,
  };

  return okAsync(synthetic);
}

export function parseStateTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<StateTokenInput, TokenOpsError> {
  if (raw.startsWith('st_')) {
    return resolveShortToken(raw, ports, aliasStore).andThen((resolved) => {
      if (resolved.payload.tokenKind !== 'state') {
        return errAsync(
          errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a state token (st_... or st1...).', {
            suggestion: 'Use the resumeToken returned by WorkRail.',
          })
        );
      }
      return okAsync(resolved as StateTokenInput);
    });
  }

  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return errAsync(mapTokenDecodeErrorToTokenOpsError(parsedRes.error));
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return errAsync(mapTokenVerifyErrorToTokenOpsError(verified.error));
  }

  if (parsedRes.value.payload.tokenKind !== 'state') {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a state token (st1...).', {
        suggestion: 'Use the resumeToken returned by WorkRail.',
      })
    );
  }

  return okAsync(parsedRes.value as StateTokenInput);
}

export function parseAckTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<AckTokenInput, TokenOpsError> {
  if (raw.startsWith('ak_')) {
    return resolveShortToken(raw, ports, aliasStore).andThen((resolved) => {
      if (resolved.payload.tokenKind !== 'ack') {
        return errAsync(
          errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected an ack token (ak_... or ack1...).', {
            suggestion: 'Use the ackToken returned by WorkRail.',
          })
        );
      }
      return okAsync(resolved as AckTokenInput);
    });
  }

  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return errAsync(mapTokenDecodeErrorToTokenOpsError(parsedRes.error));
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return errAsync(mapTokenVerifyErrorToTokenOpsError(verified.error));
  }

  if (parsedRes.value.payload.tokenKind !== 'ack') {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected an ack token (ack1...).', {
        suggestion: 'Use the ackToken returned by WorkRail.',
      })
    );
  }

  return okAsync(parsedRes.value as AckTokenInput);
}

export function parseCheckpointTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<CheckpointTokenInput, TokenOpsError> {
  if (raw.startsWith('ck_')) {
    return resolveShortToken(raw, ports, aliasStore).andThen((resolved) => {
      if (resolved.payload.tokenKind !== 'checkpoint') {
        return errAsync(
          errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a checkpoint token (ck_... or chk1...).', {
            suggestion: 'Use the checkpointToken returned by WorkRail.',
          })
        );
      }
      return okAsync(resolved as CheckpointTokenInput);
    });
  }

  const parsedRes = parseTokenV1Binary(raw, ports);
  if (parsedRes.isErr()) {
    return errAsync(mapTokenDecodeErrorToTokenOpsError(parsedRes.error));
  }

  const verified = verifyTokenSignatureV1Binary(parsedRes.value, ports);
  if (verified.isErr()) {
    return errAsync(mapTokenVerifyErrorToTokenOpsError(verified.error));
  }

  if (parsedRes.value.payload.tokenKind !== 'checkpoint') {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a checkpoint token (chk1...).', {
        suggestion: 'Use the checkpointToken returned by WorkRail.',
      })
    );
  }

  return okAsync(parsedRes.value as CheckpointTokenInput);
}

export function parseContinueTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<ContinueTokenResolved, TokenOpsError> {
  if (!raw.startsWith('ct_')) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Expected a continue token (ct_...).', {
        suggestion: 'Use the continueToken returned by WorkRail.',
      })
    );
  }

  const parsed = parseShortToken(raw, ports.base64url);
  if (parsed.isErr()) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', `Continue token format invalid: ${parsed.error.code}`, {
        suggestion: 'Use the continueToken returned by WorkRail.',
      })
    );
  }

  const hmacResult = verifyShortTokenHmac(parsed.value, ports.keyring, ports.hmac, ports.base64url);
  if (hmacResult.isErr()) {
    return errAsync(
      errNotRetryable('TOKEN_BAD_SIGNATURE', 'Continue token HMAC verification failed.', {
        suggestion: 'Use the exact continueToken returned by WorkRail -- do not modify it.',
      })
    );
  }

  const entry = aliasStore.lookup(parsed.value.nonceHex);
  if (!entry) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Continue token not found in alias index (unknown nonce).', {
        suggestion: 'Use the continueToken returned by WorkRail in the current session.',
      })
    );
  }

  if (entry.tokenKind !== 'continue') {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Token alias is not a continue token.', {
        suggestion: 'Use the continueToken returned by WorkRail.',
      })
    );
  }

  if (!entry.attemptId || !entry.workflowHashRef) {
    return errAsync(
      errNotRetryable('TOKEN_INVALID_FORMAT', 'Continue token alias entry is missing required fields.', {
        suggestion: 'Use the continueToken returned by WorkRail.',
      })
    );
  }

  return okAsync({
    sessionId: asSessionId(entry.sessionId),
    runId: asRunId(entry.runId),
    nodeId: asNodeId(entry.nodeId),
    attemptId: asAttemptId(entry.attemptId),
    workflowHashRef: asWorkflowHashRef(entry.workflowHashRef),
  });
}

export interface ContinueAndCheckpointTokens {
  readonly continueToken: string;
  readonly checkpointToken: string;
}

export interface ShortTokenTriple {
  readonly resumeToken: string;
  readonly ackToken: string;
  readonly checkpointToken: string;
}

export interface MintShortTokenTripleArgs {
  readonly entry: Omit<TokenAliasEntryV2, 'nonceHex' | 'tokenKind'>;
  readonly ports: TokenCodecPorts;
  readonly aliasStore: TokenAliasStorePortV2;
  readonly entropy: RandomEntropyPortV2;
}

function reTokenFromNonceHex(
  kind: import('../durable-core/tokens/short-token.js').ShortTokenKind,
  nonceHex: string,
  ports: TokenCodecPorts,
): Result<string, TokenOpsError> {
  const nonceBytes = hexToBuf(nonceHex);
  if (!nonceBytes) {
    return err(errNotRetryable('INTERNAL_ERROR', `Invalid stored nonce hex: ${nonceHex}`));
  }
  const result = mintShortToken(kind, nonceBytes, ports.keyring, ports.hmac, ports.base64url);
  if (result.isErr()) {
    return err(errNotRetryable('INTERNAL_ERROR', `Failed to reconstruct token from nonce: ${result.error.code}`));
  }
  return ok(result.value);
}

export function mintContinueAndCheckpointTokens(
  args: Omit<MintShortTokenTripleArgs, 'entry'> & {
    readonly entry: Omit<TokenAliasEntryV2, 'nonceHex' | 'tokenKind'>;
  },
): ResultAsync<ContinueAndCheckpointTokens, TokenOpsError> {
  const { entry, ports, aliasStore, entropy } = args;

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
  }

  const continueNonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);
  const continueMinted = mintShortToken('continue', continueNonce, ports.keyring, ports.hmac, ports.base64url);
  if (continueMinted.isErr()) {
    return errAsync(
      errNotRetryable('INTERNAL_ERROR', `Token minting failed: ${continueMinted.error.code}`)
    );
  }
  const continueNonceHex = bufToHex(continueNonce);

  let ckTokenStr: string;
  if (existingCk) {
    const replayCk = reTokenFromNonceHex('checkpoint', existingCk.nonceHex, ports);
    if (replayCk.isOk()) {
      const continueEntry: TokenAliasEntryV2 = {
        nonceHex: continueNonceHex, tokenKind: 'continue', aliasSlot: entry.aliasSlot,
        sessionId: entry.sessionId, runId: entry.runId, nodeId: entry.nodeId,
        attemptId: entry.attemptId, workflowHashRef: entry.workflowHashRef,
      };
      return aliasStore.register(continueEntry)
        .map(() => ({ continueToken: continueMinted.value, checkpointToken: replayCk.value }))
        .mapErr((regErr) => errNotRetryable('INTERNAL_ERROR', `Alias registration failed: ${regErr.code}`));
    }
    const ckNonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);
    const ckMinted = mintShortToken('checkpoint', ckNonce, ports.keyring, ports.hmac, ports.base64url);
    if (ckMinted.isErr()) return errAsync(errNotRetryable('INTERNAL_ERROR', `Token minting failed: ${ckMinted.error.code}`));
    ckTokenStr = ckMinted.value;
    const ckEntry: TokenAliasEntryV2 = { nonceHex: bufToHex(ckNonce), tokenKind: 'checkpoint', aliasSlot: entry.aliasSlot, sessionId: entry.sessionId, runId: entry.runId, nodeId: entry.nodeId, attemptId: entry.attemptId };
    return aliasStore.register({ nonceHex: continueNonceHex, tokenKind: 'continue', aliasSlot: entry.aliasSlot, sessionId: entry.sessionId, runId: entry.runId, nodeId: entry.nodeId, attemptId: entry.attemptId, workflowHashRef: entry.workflowHashRef } satisfies TokenAliasEntryV2)
      .andThen(() => aliasStore.register(ckEntry))
      .map(() => ({ continueToken: continueMinted.value, checkpointToken: ckTokenStr }))
      .mapErr((regErr) => errNotRetryable('INTERNAL_ERROR', `Alias registration failed: ${regErr.code}`));
  } else {
    const ckNonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);
    const ckMinted = mintShortToken('checkpoint', ckNonce, ports.keyring, ports.hmac, ports.base64url);
    if (ckMinted.isErr()) return errAsync(errNotRetryable('INTERNAL_ERROR', `Token minting failed: ${ckMinted.error.code}`));
    ckTokenStr = ckMinted.value;
    const ckEntry: TokenAliasEntryV2 = { nonceHex: bufToHex(ckNonce), tokenKind: 'checkpoint', aliasSlot: entry.aliasSlot, sessionId: entry.sessionId, runId: entry.runId, nodeId: entry.nodeId, attemptId: entry.attemptId };
    return aliasStore.register({ nonceHex: continueNonceHex, tokenKind: 'continue', aliasSlot: entry.aliasSlot, sessionId: entry.sessionId, runId: entry.runId, nodeId: entry.nodeId, attemptId: entry.attemptId, workflowHashRef: entry.workflowHashRef } satisfies TokenAliasEntryV2)
      .andThen(() => aliasStore.register(ckEntry))
      .map(() => ({ continueToken: continueMinted.value, checkpointToken: ckTokenStr }))
      .mapErr((regErr) => errNotRetryable('INTERNAL_ERROR', `Alias registration failed: ${regErr.code}`));
  }
}

export function mintShortTokenTriple(
  args: MintShortTokenTripleArgs,
): ResultAsync<ShortTokenTriple, TokenOpsError> {
  const { entry, ports, aliasStore, entropy } = args;

  const existingState = aliasStore.lookupByPosition('state', entry.sessionId, entry.nodeId, undefined, entry.aliasSlot);
  const existingAck = aliasStore.lookupByPosition('ack', entry.sessionId, entry.nodeId, entry.attemptId, entry.aliasSlot);
  const existingCk = aliasStore.lookupByPosition('checkpoint', entry.sessionId, entry.nodeId, entry.attemptId, entry.aliasSlot);

  if (existingState && existingAck && existingCk) {
    const replayState = reTokenFromNonceHex('state', existingState.nonceHex, ports);
    const replayAck = reTokenFromNonceHex('ack', existingAck.nonceHex, ports);
    const replayCk = reTokenFromNonceHex('checkpoint', existingCk.nonceHex, ports);
    if (replayState.isOk() && replayAck.isOk() && replayCk.isOk()) {
      return okAsync({
        resumeToken: replayState.value,
        ackToken: replayAck.value,
        checkpointToken: replayCk.value,
      });
    }
  }

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
      errNotRetryable('INTERNAL_ERROR', `Short token minting failed: ${msg}`)
    );
  }

  const resumeTokenStr = stateMinted.value;
  const ackTokenStr = ackMinted.value;
  const ckTokenStr = ckMinted.value;

  const stateNonceHex = bufToHex(stateNonce);
  const ackNonceHex = bufToHex(ackNonce);
  const ckNonceHex = bufToHex(ckNonce);

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
      resumeToken: resumeTokenStr,
      ackToken: ackTokenStr,
      checkpointToken: ckTokenStr,
    }))
    .mapErr((regErr) => {
      const detail = regErr.code === 'ALIAS_DUPLICATE_NONCE'
        ? `duplicate nonce: ${regErr.nonceHex}`
        : regErr.message;
      return errNotRetryable(
        'INTERNAL_ERROR',
        `Token alias registration failed: ${detail}`
      );
    });
}

export interface MintSingleShortTokenArgs {
  readonly kind: import('../durable-core/tokens/short-token.js').ShortTokenKind;
  readonly entry: Omit<TokenAliasEntryV2, 'nonceHex' | 'tokenKind'>;
  readonly ports: TokenCodecPorts;
  readonly aliasStore: TokenAliasStorePortV2;
  readonly entropy: RandomEntropyPortV2;
}

export function mintSingleShortToken(
  args: MintSingleShortTokenArgs,
): ResultAsync<string, TokenOpsError> {
  const { kind, entry, ports, aliasStore, entropy } = args;

  const lookupAttemptId = kind === 'state' ? undefined : entry.attemptId;
  const existing = aliasStore.lookupByPosition(kind, entry.sessionId, entry.nodeId, lookupAttemptId, entry.aliasSlot);
  if (existing) {
    const rebuilt = reTokenFromNonceHex(kind, existing.nonceHex, ports);
    if (rebuilt.isOk()) return okAsync(rebuilt.value);
  }

  const nonce = entropy.generateBytes(SHORT_TOKEN_NONCE_BYTES);
  const minted = mintShortToken(kind, nonce, ports.keyring, ports.hmac, ports.base64url);
  if (minted.isErr()) {
    return errAsync(
      errNotRetryable('INTERNAL_ERROR', `Short token minting failed: ${minted.error.code}`)
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
        `Token alias registration failed: ${detail}`
      );
    });
}

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

export function newAttemptId(idFactory: { readonly mintAttemptId: () => AttemptId }): AttemptId {
  return idFactory.mintAttemptId();
}

export function attemptIdForNextNode(
  parentAttemptId: AttemptId,
  sha256: Sha256PortV2,
): Result<AttemptId, import('../durable-core/ids/attempt-id-derivation.js').AttemptIdDerivationError> {
  return deriveChildAttemptId(parentAttemptId, sha256);
}

export function signTokenOrErr(args: {
  payload: TokenPayloadV1;
  ports: TokenCodecPorts;
}): Result<string, TokenDecodeErrorV2 | TokenVerifyErrorV2 | TokenSignErrorV2> {
  const token = signTokenV1Binary(args.payload, args.ports);
  if (token.isErr()) return err(token.error);
  return ok(token.value);
}
