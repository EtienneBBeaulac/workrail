import { bech32m } from '@scure/base';
import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { Bech32mPortV2, Bech32mDecodeError, TokenHrp } from '../../../ports/bech32m.port.js';

/**
 * Bech32m adapter using @scure/base library.
 *
 * Implements BIP 350 bech32m encoding for token serialization.
 * Provides built-in checksum validation and error detection.
 */
export class Bech32mAdapterV2 implements Bech32mPortV2 {
  // Maximum length for bech32m strings (generous limit for 98-byte tokens)
  private static readonly MAX_LENGTH = 1023;

  encode(hrp: TokenHrp, data: Uint8Array): string {
    // @scure/base bech32m.encode expects:
    // - hrp: human-readable prefix
    // - words: 5-bit words (we need to convert bytes to words)
    const words = bech32m.toWords(data);
    return bech32m.encode(hrp, words, Bech32mAdapterV2.MAX_LENGTH);
  }

  decode(encoded: string, expectedHrp: TokenHrp): Result<Uint8Array, Bech32mDecodeError> {
    try {
      // @scure/base bech32m.decode returns { prefix, words }
      // Cast to template literal type expected by library
      const decoded = bech32m.decode(encoded as `${string}1${string}`, Bech32mAdapterV2.MAX_LENGTH);

      // Validate HRP matches expected
      if (decoded.prefix !== expectedHrp) {
        return err({
          code: 'BECH32M_HRP_MISMATCH',
          message: `HRP mismatch: expected '${expectedHrp}', got '${decoded.prefix}'`,
        });
      }

      // Convert 5-bit words back to bytes
      const bytes = bech32m.fromWords(decoded.words);
      return ok(new Uint8Array(bytes));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      // Detect checksum failures
      if (/checksum/i.test(msg)) {
        return err({
          code: 'BECH32M_CHECKSUM_FAILED',
          message: `Bech32m checksum validation failed (likely corruption): ${msg}`,
          position: this.tryExtractPosition(msg),
        });
      }

      return err({
        code: 'BECH32M_INVALID_FORMAT',
        message: `Invalid bech32m: ${msg}`,
      });
    }
  }

  /**
   * Extract error position from @scure/base error message.
   * 
   * @scure/base may include position info in various formats:
   * - "Invalid character at position 42"
   * - "position: 42"
   * - "pos 42"
   * 
   * Returns undefined if position cannot be extracted.
   */
  private tryExtractPosition(msg: string): number | undefined {
    // Try multiple regex patterns to maximize extraction success
    const patterns = [
      /position\s*:?\s*(\d+)/i,
      /at\s+position\s+(\d+)/i,
      /pos\s+(\d+)/i,
      /index\s+(\d+)/i,
    ];
    
    for (const pattern of patterns) {
      const match = msg.match(pattern);
      if (match) {
        const pos = parseInt(match[1], 10);
        return Number.isNaN(pos) ? undefined : pos;
      }
    }
    
    return undefined;
  }
}
