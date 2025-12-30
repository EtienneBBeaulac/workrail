import type { RandomEntropyPortV2 } from '../../../src/v2/ports/random-entropy.port.js';

/**
 * Fake random entropy for deterministic testing.
 *
 * Generates a predictable sequence of bytes based on an internal counter.
 * Useful for testing cryptographic operations in a deterministic manner.
 */
export class FakeRandomEntropyV2 implements RandomEntropyPortV2 {
  private sequence = 0;

  generateBytes(count: number): Uint8Array {
    // Deterministic sequence for testing
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      bytes[i] = (this.sequence + i) % 256;
    }
    this.sequence += count;
    return bytes;
  }

  reset() {
    this.sequence = 0;
  }
}
