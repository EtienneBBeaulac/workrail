/**
 * In-memory token alias store — for testing only.
 *
 * No I/O, no persistence. Implements the same port as LocalTokenAliasStoreV2
 * so tests can use it without a real filesystem.
 */

import { okAsync, errAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import type {
  TokenAliasStorePortV2,
  TokenAliasEntryV2,
  TokenAliasRegistrationError,
  TokenAliasLoadError,
} from '../../../ports/token-alias-store.port.js';
import type { ShortTokenKind } from '../../../durable-core/tokens/short-token.js';

function positionKey(
  tokenKind: ShortTokenKind,
  sessionId: string,
  nodeId: string,
  attemptId?: string,
  aliasSlot?: 'retry',
): string {
  return `${tokenKind}:${aliasSlot ?? ''}:${sessionId}:${nodeId}:${attemptId ?? ''}`;
}

export class InMemoryTokenAliasStoreV2 implements TokenAliasStorePortV2 {
  private readonly index = new Map<string, TokenAliasEntryV2>();
  private readonly positionIndex = new Map<string, string>();

  register(entry: TokenAliasEntryV2): ResultAsync<void, TokenAliasRegistrationError> {
    if (this.index.has(entry.nonceHex)) {
      return errAsync({
        code: 'ALIAS_DUPLICATE_NONCE' as const,
        nonceHex: entry.nonceHex,
      });
    }
    this.index.set(entry.nonceHex, entry);
    this.positionIndex.set(
      positionKey(entry.tokenKind, entry.sessionId, entry.nodeId, entry.attemptId, entry.aliasSlot),
      entry.nonceHex,
    );
    return okAsync(undefined);
  }

  lookup(nonceHex: string): TokenAliasEntryV2 | null {
    return this.index.get(nonceHex) ?? null;
  }

  lookupByPosition(
    tokenKind: ShortTokenKind,
    sessionId: string,
    nodeId: string,
    attemptId?: string,
    aliasSlot?: 'retry',
  ): TokenAliasEntryV2 | null {
    const key = positionKey(tokenKind, sessionId, nodeId, attemptId, aliasSlot);
    const nonceHex = this.positionIndex.get(key);
    if (!nonceHex) return null;
    return this.index.get(nonceHex) ?? null;
  }

  loadIndex(): ResultAsync<void, TokenAliasLoadError> {
    return okAsync(undefined);
  }
}
