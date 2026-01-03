import { describe, it, expect } from 'vitest';
import type { RandomEntropyPortV2 } from '../../../src/v2/ports/random-entropy.port.js';
import { IdFactoryV2 } from '../../../src/v2/infra/local/id-factory/index.js';

describe('IdFactoryV2', () => {
  it('mints lowercase base32 IDs with expected prefixes', () => {
    const entropy: RandomEntropyPortV2 = {
      generateBytes(count: number) {
        // deterministic, but not all zeros (to avoid degenerate encodings)
        return new Uint8Array(Array.from({ length: count }, (_, i) => (i * 31 + 7) & 0xff));
      },
    };

    const ids = new IdFactoryV2(entropy);

    expect(String(ids.mintSessionId())).toMatch(/^sess_[a-z2-7]{26}$/);
    expect(String(ids.mintRunId())).toMatch(/^run_[a-z2-7]{26}$/);
    expect(String(ids.mintNodeId())).toMatch(/^node_[a-z2-7]{26}$/);
    expect(String(ids.mintAttemptId())).toMatch(/^attempt_[a-z2-7]{26}$/);
    expect(ids.mintEventId()).toMatch(/^evt_[a-z2-7]{26}$/);
  });

  it('produces distinct IDs across calls', () => {
    let ctr = 0;
    const entropy: RandomEntropyPortV2 = {
      generateBytes(count: number) {
        const out = new Uint8Array(count);
        out.fill(0);
        out[0] = ctr++ & 0xff;
        return out;
      },
    };

    const ids = new IdFactoryV2(entropy);
    const a = String(ids.mintSessionId());
    const b = String(ids.mintSessionId());

    expect(a).not.toBe(b);
  });
});
