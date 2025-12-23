import { createHmac, timingSafeEqual } from 'crypto';
import type { HmacSha256PortV2 } from '../../../ports/hmac-sha256.port.js';

export class NodeHmacSha256V2 implements HmacSha256PortV2 {
  hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
    const out = createHmac('sha256', Buffer.from(key)).update(Buffer.from(message)).digest();
    return new Uint8Array(out);
  }

  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
}
