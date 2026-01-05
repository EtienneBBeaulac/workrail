import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import { encodeBase32LowerNoPad, decodeBase32LowerNoPad } from '../../../durable-core/encoding/base32-lower.js';
import type { Base32PortV2, Base32DecodeError } from '../../../ports/base32.port.js';

/**
 * Base32 adapter implementing RFC 4648 (lowercase, no padding).
 *
 * Uses internal base32-lower encoder/decoder with port interface wrapper.
 */
export class Base32AdapterV2 implements Base32PortV2 {
  encode(bytes: Uint8Array): string {
    return encodeBase32LowerNoPad(bytes);
  }

  decode(encoded: string): Result<Uint8Array, Base32DecodeError> {
    // Validate: only [a-z2-7] characters (canonical form)
    if (!/^[a-z2-7]+$/.test(encoded)) {
      const invalidMatch = encoded.match(/[^a-z2-7]/);
      return err({
        code: 'BASE32_INVALID_CHARACTERS',
        message: `Invalid base32 character: ${invalidMatch?.[0] || 'unknown'}`,
        position: invalidMatch?.index,
      });
    }

    // Decode using internal function
    try {
      const bytes = decodeBase32LowerNoPad(encoded);
      return ok(bytes);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      
      // Categorize error based on message content
      if (/padding|non-canonical/i.test(message)) {
        return err({
          code: 'BASE32_NON_CANONICAL',
          message: `Non-canonical base32 encoding: ${message}`,
        });
      }
      
      if (/length/i.test(message)) {
        return err({
          code: 'BASE32_INVALID_LENGTH',
          message: `Invalid base32 length: ${message}`,
        });
      }
      
      // Default to invalid characters
      return err({
        code: 'BASE32_INVALID_CHARACTERS',
        message: `Base32 decode failed: ${message}`,
      });
    }
  }
}
