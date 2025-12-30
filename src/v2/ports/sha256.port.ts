import type { Sha256Digest } from '../durable-core/ids/index.js';

/**
 * Port: SHA-256 hashing for raw bytes (file/segment digests).
 * 
 * Purpose:
 * - Compute digests of raw file bytes (segments, manifests)
 * - Separate from canonical JSON hashing (which uses CryptoPort)
 * 
 * Note: Intentionally accepts raw Uint8Array, not CanonicalBytes.
 * For canonical JSON hashing, use CryptoPort instead.
 * 
 * Guarantees:
 * - Deterministic: same bytes → same digest
 * - Pure function (no side effects)
 * 
 * Example:
 * ```typescript
 * const segmentBytes = await fs.readFile(segmentPath);
 * const digest = sha256Port.sha256(segmentBytes);
 * ```
 */
export interface Sha256PortV2 {
  sha256(bytes: Uint8Array): Sha256Digest;
}
