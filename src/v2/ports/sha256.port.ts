import type { Sha256Digest } from '../durable-core/ids/index.js';

/**
 * Raw sha256 for file/segment digests.
 *
 * Note: this is intentionally separate from canonical-json hashing inputs
 * (`CryptoPortV2` expects `CanonicalBytes`).
 */
export interface Sha256PortV2 {
  sha256(bytes: Uint8Array): Sha256Digest;
}
