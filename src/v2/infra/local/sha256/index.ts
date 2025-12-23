import { createHash } from 'crypto';
import type { Sha256PortV2 } from '../../../ports/sha256.port.js';
import type { Sha256Digest } from '../../../durable-core/ids/index.js';
import { asSha256Digest } from '../../../durable-core/ids/index.js';

export class NodeSha256V2 implements Sha256PortV2 {
  sha256(bytes: Uint8Array): Sha256Digest {
    const hex = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    return asSha256Digest(`sha256:${hex}`);
  }
}
