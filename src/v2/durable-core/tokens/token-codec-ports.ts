import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { KeyringV1 } from '../../ports/keyring.port.js';
import type { HmacSha256PortV2 } from '../../ports/hmac-sha256.port.js';
import type { Base64UrlPortV2 } from '../../ports/base64url.port.js';
import type { Base32PortV2 } from '../../ports/base32.port.js';
import type { Bech32mPortV2 } from '../../ports/bech32m.port.js';

declare const tokenCodecPortsBrand: unique symbol;

/**
 * Grouped dependencies for token encoding/decoding/signing/verification.
 *
 * WHY: These 5 ports always travel together. Grouping prevents "forgot base32" bugs.
 *
 * INVARIANTS:
 * - All fields non-null (enforced by createTokenCodecPorts)
 * - Immutable (readonly fields, frozen in constructor)
 * - Created only via factory functions (not direct literals)
 *
 * USAGE:
 * - At boundaries: createTokenCodecPorts (validates, returns Result)
 * - In tests: unsafeTokenCodecPorts (assumes deps valid)
 */
export type TokenCodecPorts = Readonly<{
  readonly keyring: KeyringV1;
  readonly hmac: HmacSha256PortV2;
  readonly base64url: Base64UrlPortV2;
  readonly base32: Base32PortV2;
  readonly bech32m: Bech32mPortV2;
}> & {
  /**
   * Opaque brand to prevent accidental construction via object literals.
   * Obtain values via createTokenCodecPorts / unsafeTokenCodecPorts.
   */
  readonly [tokenCodecPortsBrand]: 'TokenCodecPorts';
};

export type TokenCodecPortsError =
  | { readonly code: 'TOKEN_CODEC_PORTS_MISSING_KEYRING' }
  | { readonly code: 'TOKEN_CODEC_PORTS_MISSING_HMAC' }
  | { readonly code: 'TOKEN_CODEC_PORTS_MISSING_BASE64URL' }
  | { readonly code: 'TOKEN_CODEC_PORTS_MISSING_BASE32' }
  | { readonly code: 'TOKEN_CODEC_PORTS_MISSING_BECH32M' };

/**
 * Create TokenCodecPorts with validation (boundary function).
 *
 * Returns Result<TokenCodecPorts, Error> - errors as data, not exceptions.
 * Use at system boundaries (DI container setup, integration test setup).
 */
export function createTokenCodecPorts(deps: {
  readonly keyring?: KeyringV1 | null;
  readonly hmac?: HmacSha256PortV2 | null;
  readonly base64url?: Base64UrlPortV2 | null;
  readonly base32?: Base32PortV2 | null;
  readonly bech32m?: Bech32mPortV2 | null;
}): Result<TokenCodecPorts, TokenCodecPortsError> {
  if (!deps.keyring) return err({ code: 'TOKEN_CODEC_PORTS_MISSING_KEYRING' });
  if (!deps.hmac) return err({ code: 'TOKEN_CODEC_PORTS_MISSING_HMAC' });
  if (!deps.base64url) return err({ code: 'TOKEN_CODEC_PORTS_MISSING_BASE64URL' });
  if (!deps.base32) return err({ code: 'TOKEN_CODEC_PORTS_MISSING_BASE32' });
  if (!deps.bech32m) return err({ code: 'TOKEN_CODEC_PORTS_MISSING_BECH32M' });

  return ok(
    Object.freeze({
      keyring: deps.keyring,
      hmac: deps.hmac,
      base64url: deps.base64url,
      base32: deps.base32,
      bech32m: deps.bech32m,
    }) as TokenCodecPorts,
  );
}

/**
 * Create TokenCodecPorts without validation (internal use).
 *
 * Use ONLY when:
 * - TypeScript proves all deps exist (non-optional fields)
 * - In tests where you control construction
 *
 * DO NOT use at boundaries where deps might be missing.
 */
export function unsafeTokenCodecPorts(deps: {
  readonly keyring: KeyringV1;
  readonly hmac: HmacSha256PortV2;
  readonly base64url: Base64UrlPortV2;
  readonly base32: Base32PortV2;
  readonly bech32m: Bech32mPortV2;
}): TokenCodecPorts {
  return Object.freeze({ ...deps }) as TokenCodecPorts;
}
