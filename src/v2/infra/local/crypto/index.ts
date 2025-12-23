import { createHash } from 'crypto';
import type { CryptoPortV2 } from '../../../durable-core/canonical/hashing.js';
import type { CanonicalBytes, Sha256Digest } from '../../../durable-core/ids/index.js';
import { asSha256Digest } from '../../../durable-core/ids/index.js';

export class NodeCryptoV2 implements CryptoPortV2 {
  sha256(bytes: CanonicalBytes): Sha256Digest {
    const hex = createHash('sha256').update(Buffer.from(bytes as unknown as Uint8Array)).digest('hex');
    return asSha256Digest(`sha256:${hex}`);
  }
}
