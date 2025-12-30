import type { Utf8PortV2 } from '../../../ports/utf8.port.js';

/**
 * Node UTF-8 adapter using TextEncoder (runtime-neutral, but in infra for consistency).
 *
 * This adapter provides UTF-8 byte length measurement across all runtimes.
 * TextEncoder is available in Node.js 11+, Deno, browsers, and Cloudflare Workers.
 */
export class NodeUtf8V2 implements Utf8PortV2 {
  private encoder = new TextEncoder();

  utf8ByteLength(s: string): number {
    return this.encoder.encode(s).length;
  }
}
