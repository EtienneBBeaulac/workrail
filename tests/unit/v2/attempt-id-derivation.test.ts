import { describe, it, expect } from 'vitest';
import type { Sha256PortV2 } from '../../../src/v2/ports/sha256.port.js';
import { asAttemptId } from '../../../src/v2/durable-core/ids/index.js';
import { deriveChildAttemptId } from '../../../src/v2/durable-core/ids/attempt-id-derivation.js';

describe('deriveChildAttemptId', () => {
  it('is deterministic and bounded (does not grow with depth)', () => {
    const sha256: Sha256PortV2 = {
      sha256(bytes: Uint8Array) {
        // Deterministic but simple fake: hash = sha256:<repeated 00..ff>
        // We only rely on the first 16 bytes, so provide a stable 64-hex payload.
        const seed = bytes.length & 0xff;
        const hex = Array.from({ length: 64 }, (_, i) => ((seed + i) & 0xf).toString(16)).join('');
        return `sha256:${hex}` as any;
      },
    };

    let cur = asAttemptId('attempt_seed');
    const first = deriveChildAttemptId(cur, sha256);

    // Derive deep chain
    for (let i = 0; i < 50; i++) {
      cur = deriveChildAttemptId(cur, sha256);
      expect(String(cur)).toMatch(/^attempt_[a-z2-7]{26}$/);
      expect(String(cur).length).toBe('attempt_'.length + 26);
    }

    // Determinism check
    expect(deriveChildAttemptId(asAttemptId('attempt_seed'), sha256)).toBe(first);
  });
});
