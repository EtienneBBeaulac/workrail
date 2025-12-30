import type { ResultAsync } from 'neverthrow';

/**
 * Keyring active set (current + previous signing keys).
 *
 * Lock: docs/design/v2-core-design-locks.md Section 1.2 (token signing)
 * - Exactly 2 keys: current (required), previous (nullable)
 * - Keys are for HMAC-SHA256 and represent 32 bytes of entropy
 * - Keys are encoded as base64url for storage/transport
 */
export interface KeyringV1 {
  readonly v: 1;
  readonly current: { readonly alg: 'hmac_sha256'; readonly keyBase64Url: string };
  readonly previous: { readonly alg: 'hmac_sha256'; readonly keyBase64Url: string } | null;
}

export type KeyringError =
  | { readonly code: 'KEYRING_IO_ERROR'; readonly message: string }
  | { readonly code: 'KEYRING_CORRUPTION_DETECTED'; readonly message: string }
  | { readonly code: 'KEYRING_INVARIANT_VIOLATION'; readonly message: string };

/**
 * Port: Keyring management (token signing keys).
 *
 * Purpose:
 * - Load signing keys from durable local storage
 * - Create keys if none exist (first-run bootstrap)
 * - Support rotation (current → previous, new current)
 *
 * Locked invariants (docs/design/v2-core-design-locks.md Section 10 / token security):
 * - Storage location is within WorkRail data dir (not workflow dirs)
 * - Keys are 32-byte crypto-secure random values (represented as base64url)
 * - Active set: current + optional previous (for rotation without instant invalidation)
 * - Rotation: current becomes previous; previous is replaced; new random current generated
 * - Writes are crash-safe (tmp → rename)
 *
 * Guarantees:
 * - loadOrCreate() returns a usable keyring (existing or newly created)
 * - rotate() updates keyring atomically
 * - Best-effort file permissions (readable only by current user)
 *
 * When to use:
 * - Load once at process startup
 * - Pass keys to token sign/verify functions
 * - Rotate explicitly (manual/controlled; not time-based by default)
 *
 * Example:
 * ```typescript
 * const keyring = await keyringPort.loadOrCreate();
 * const sig = hmac.hmacSha256(keyBytes, payloadBytes);
 * ```
 */
export interface KeyringPortV2 {
  /**
   * Load keyring or create it if missing.
   *
   * Creates a new keyring with a random current key on first run.
   */
  loadOrCreate(): ResultAsync<KeyringV1, KeyringError>;

  /**
   * Rotate keys: current → previous, generate new current.
   *
   * Invalidates the old previous key.
   */
  rotate(): ResultAsync<KeyringV1, KeyringError>;
}
