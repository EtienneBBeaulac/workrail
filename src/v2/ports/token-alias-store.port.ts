/**
 * Port: Token alias store — maps v2 short token nonces to session position data.
 *
 * WHY: v2 short tokens (~27 chars) don't carry session data in their payload.
 * The nonce maps to an alias entry that contains all the information needed to
 * reconstruct the session position (equivalent to what v1 tokens carry inline).
 *
 * The store is durable (persisted to token-index.jsonl) and loaded into memory
 * at startup for O(1) lookups.
 *
 * Invariant: register() must succeed before returning the minted token to the caller.
 * An unregistered nonce = an unretrievable token = a production incident.
 */

import type { ResultAsync } from 'neverthrow';
import type { ShortTokenKind } from '../durable-core/tokens/short-token.js';

// --------------------------------------------------------------------------
// Alias entry �� the durable record per token
// --------------------------------------------------------------------------

export interface TokenAliasEntryV2 {
  /** Lowercase hex of the 12-byte nonce. This is the primary lookup key. */
  readonly nonceHex: string;
  readonly tokenKind: ShortTokenKind;
  /** Optional reverse-index discriminator for positions that mint multiple tokens of the same kind. */
  readonly aliasSlot?: 'retry';
  readonly sessionId: string;
  readonly runId: string;
  readonly nodeId: string;
  /** Present for ack, checkpoint, and continue tokens; absent for state tokens. */
  readonly attemptId?: string;
  /** Present for state and continue tokens; absent for ack/checkpoint tokens. */
  readonly workflowHashRef?: string;
}

// --------------------------------------------------------------------------
// Error types
// --------------------------------------------------------------------------

export type TokenAliasRegistrationError =
  | { readonly code: 'ALIAS_IO_ERROR'; readonly message: string }
  | { readonly code: 'ALIAS_DUPLICATE_NONCE'; readonly nonceHex: string };

export type TokenAliasLookupError =
  | { readonly code: 'ALIAS_IO_ERROR'; readonly message: string };

export type TokenAliasLoadError =
  | { readonly code: 'ALIAS_IO_ERROR'; readonly message: string };

// --------------------------------------------------------------------------
// Port
// --------------------------------------------------------------------------

/**
 * Token alias store port.
 *
 * Implementations:
 * - LocalTokenAliasStoreV2: JSONL file + in-memory Map (production)
 * - InMemoryTokenAliasStoreV2: in-memory only (testing)
 */
export interface TokenAliasStorePortV2 {
  /**
   * Register a new alias entry.
   *
   * Must succeed before the minted token is returned to the caller.
   * The entry is both written to durable storage and added to the in-memory index.
   */
  register(entry: TokenAliasEntryV2): ResultAsync<void, TokenAliasRegistrationError>;

  /**
   * Look up an alias entry by nonce hex.
   *
   * Returns null if not found (not an error — caller handles).
   */
  lookup(nonceHex: string): TokenAliasEntryV2 | null;

  /**
   * Reverse lookup: find an existing alias entry by session position + token kind.
   *
   * Used by replay paths to return the same token they issued before (idempotency).
   * The position key is: tokenKind + aliasSlot + sessionId + nodeId + attemptId (if present).
   *
   * Returns null if no entry has been registered for this position.
   */
  lookupByPosition(
    tokenKind: ShortTokenKind,
    sessionId: string,
    nodeId: string,
    attemptId?: string,
    aliasSlot?: 'retry',
  ): TokenAliasEntryV2 | null;

  /**
   * Load (or reload) the alias index from durable storage into memory.
   *
   * Called once at startup. Malformed lines are skipped (not an error — partial corruption
   * only loses the affected entries, not the entire index).
   *
   * Idempotent: safe to call multiple times (re-reads from disk).
   */
  loadIndex(): ResultAsync<void, TokenAliasLoadError>;
}
