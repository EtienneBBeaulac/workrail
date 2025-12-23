import type { SessionLockHandleV2 } from '../../ports/session-lock.port.js';

/**
 * Opaque capability witness proving:
 * - the session lock is held
 * - session health has been validated as `healthy`
 *
 * NOTE: This is intentionally difficult to forge without `as any`.
 * The branding symbol is not exported from this module.
 */
declare const withHealthySessionLockBrand: unique symbol;

export type WithHealthySessionLock = SessionLockHandleV2 & {
  /**
   * Runtime guard against witness misuse after the gate callback ends.
   *
   * Slice 2.5 lock: append MUST fail-fast if the witness is used after the lexical
   * gate lifetime ends (even if the same session is re-locked later).
   */
  readonly assertHeld: () => boolean;

  readonly [withHealthySessionLockBrand]: 'WithHealthySessionLock';
};
