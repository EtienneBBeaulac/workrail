/**
 * In-memory fake for keyring (token signing keys).
 *
 * Implements keyring invariants:
 * - Active set: current (required) + previous (optional)
 * - Keys are 32-byte entropy encoded as base64url
 * - rotate() updates current → previous, generates new current
 *
 * @enforces keyring-active-set
 * @enforces token-key-entropy
 */

import { okAsync, type ResultAsync } from 'neverthrow';
import type { KeyringPortV2, KeyringError, KeyringV1 } from '../../../src/v2/ports/keyring.port.js';
import { randomBytes } from 'node:crypto';

/**
 * In-memory fake keyring.
 *
 * Behavior:
 * - loadOrCreate() returns an existing keyring or creates a new one with random current key
 * - rotate() moves current → previous, generates new random current
 */
export class InMemoryKeyring implements KeyringPortV2 {
  private keyring: KeyringV1 | null = null;

  loadOrCreate(): ResultAsync<KeyringV1, KeyringError> {
    if (this.keyring) {
      return okAsync(this.keyring);
    }

    // Create new keyring with random current key
    const randomKey = randomBytes(32).toString('base64url');
    this.keyring = {
      v: 1,
      current: { alg: 'hmac_sha256', keyBase64Url: randomKey },
      previous: null,
    };

    return okAsync(this.keyring);
  }

  rotate(): ResultAsync<KeyringV1, KeyringError> {
    // Ensure keyring is initialized
    if (!this.keyring) {
      return this.loadOrCreate().andThen(() => this.rotate());
    }

    // Rotate: current → previous, generate new current
    const newCurrent = randomBytes(32).toString('base64url');
    this.keyring = {
      v: 1,
      current: { alg: 'hmac_sha256', keyBase64Url: newCurrent },
      previous: this.keyring.current,
    };

    return okAsync(this.keyring);
  }
}
