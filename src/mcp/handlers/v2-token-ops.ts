/**
 * v2 Token Operations
 *
 * Delegating execution to the v2 use case layer and mapping use case errors
 * to MCP ToolFailure protocol objects.
 */

import type { ResultAsync } from 'neverthrow';
import type { Result } from 'neverthrow';
import { errNotRetryable } from '../types.js';
import type { ToolFailure } from './v2-execution-helpers.js';
import type { TokenCodecPorts } from '../../v2/durable-core/tokens/token-codec-ports.js';
import type { Sha256PortV2 } from '../../v2/ports/sha256.port.js';
import type { TokenAliasStorePortV2 } from '../../v2/ports/token-alias-store.port.js';
import type { RandomEntropyPortV2 } from '../../v2/ports/random-entropy.port.js';
import type { AttemptId } from '../../v2/durable-core/tokens/index.js';
import type { TokenPayloadV1 } from '../../v2/durable-core/tokens/index.js';
import type { TokenDecodeErrorV2, TokenVerifyErrorV2, TokenSignErrorV2 } from '../../v2/durable-core/tokens/index.js';
import * as u from '../../v2/usecases/v2-token-ops.js';

export type {
  StateTokenInput,
  AckTokenInput,
  CheckpointTokenInput,
  ContinueTokenResolved,
  ContinueAndCheckpointTokens,
  ShortTokenTriple,
  MintShortTokenTripleArgs,
  MintSingleShortTokenArgs,
} from '../../v2/usecases/v2-token-ops.js';

function mapTokenOpsErrorToToolError(err: u.TokenOpsError): ToolFailure {
  return errNotRetryable(err.code as import('../types.js').ErrorCode, err.message, {
    suggestion: err.suggestion,
    details: err.details as any,
  } as any) as ToolFailure;
}

export function parseStateTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<u.StateTokenInput, ToolFailure> {
  return u.parseStateTokenOrFail(raw, ports, aliasStore).mapErr(mapTokenOpsErrorToToolError);
}

export function parseAckTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<u.AckTokenInput, ToolFailure> {
  return u.parseAckTokenOrFail(raw, ports, aliasStore).mapErr(mapTokenOpsErrorToToolError);
}

export function parseCheckpointTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<u.CheckpointTokenInput, ToolFailure> {
  return u.parseCheckpointTokenOrFail(raw, ports, aliasStore).mapErr(mapTokenOpsErrorToToolError);
}

export function parseContinueTokenOrFail(
  raw: string,
  ports: TokenCodecPorts,
  aliasStore: TokenAliasStorePortV2,
): ResultAsync<u.ContinueTokenResolved, ToolFailure> {
  return u.parseContinueTokenOrFail(raw, ports, aliasStore).mapErr(mapTokenOpsErrorToToolError);
}

export function mintContinueAndCheckpointTokens(
  args: Omit<u.MintShortTokenTripleArgs, 'entry'> & {
    readonly entry: Omit<import('../../v2/ports/token-alias-store.port.js').TokenAliasEntryV2, 'nonceHex' | 'tokenKind'>;
  },
): ResultAsync<u.ContinueAndCheckpointTokens, ToolFailure> {
  return u.mintContinueAndCheckpointTokens(args).mapErr(mapTokenOpsErrorToToolError);
}

export function mintShortTokenTriple(
  args: u.MintShortTokenTripleArgs,
): ResultAsync<u.ShortTokenTriple, ToolFailure> {
  return u.mintShortTokenTriple(args).mapErr(mapTokenOpsErrorToToolError);
}

export function mintSingleShortToken(
  args: u.MintSingleShortTokenArgs,
): ResultAsync<string, ToolFailure> {
  return u.mintSingleShortToken(args).mapErr(mapTokenOpsErrorToToolError);
}

export function newAttemptId(idFactory: { readonly mintAttemptId: () => AttemptId }): AttemptId {
  return u.newAttemptId(idFactory);
}

export function attemptIdForNextNode(
  parentAttemptId: AttemptId,
  sha256: Sha256PortV2,
): Result<AttemptId, import('../../v2/durable-core/ids/attempt-id-derivation.js').AttemptIdDerivationError> {
  return u.attemptIdForNextNode(parentAttemptId, sha256);
}

export function signTokenOrErr(args: {
  payload: TokenPayloadV1;
  ports: TokenCodecPorts;
}): Result<string, TokenDecodeErrorV2 | TokenVerifyErrorV2 | TokenSignErrorV2> {
  return u.signTokenOrErr(args);
}
