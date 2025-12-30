import { randomBytes } from 'node:crypto';
import type { RandomEntropyPortV2 } from '../../../ports/random-entropy.port.js';

/**
 * Node crypto adapter for random entropy generation.
 *
 * Uses Node.js crypto.randomBytes() which is cryptographically secure.
 * Based on OpenSSL's RAND_bytes() on most platforms.
 */
export class NodeRandomEntropyV2 implements RandomEntropyPortV2 {
  generateBytes(count: number): Uint8Array {
    // randomBytes is sync in Node 18+ (backed by CSPRNG)
    return new Uint8Array(randomBytes(count));
  }
}
