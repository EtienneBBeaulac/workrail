import { describe, it, expect } from 'vitest';
import { ExecutionSnapshotFileV1Schema } from '../../../src/v2/durable-core/schemas/execution-snapshot/index.js';
import { toCanonicalBytes } from '../../../src/v2/durable-core/canonical/jcs.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('v2 execution snapshot schema (Slice 3 prereq)', () => {
  it('is JCS-canonicalizable with a stable golden sha256', () => {
    const snapshot = ExecutionSnapshotFileV1Schema.parse({
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: {
        v: 1,
        engineState: {
          kind: 'running',
          completed: {
            kind: 'set',
            values: ['outer@0::gather_evidence', 'triage'],
          },
          loopStack: [{ loopId: 'outer', iteration: 0, bodyIndex: 1 }],
          pending: { kind: 'some', step: { stepId: 'update_hypotheses', loopPath: [{ loopId: 'outer', iteration: 0 }] } },
        },
      },
    });

    const canonical = toCanonicalBytes(snapshot as any);
    expect(canonical.isOk()).toBe(true);
    const bytes = canonical._unsafeUnwrap();

    // Golden: canonical JSON string (debuggable) + sha256 digest.
    expect(decodeUtf8(bytes)).toBe(
      '{"enginePayload":{"engineState":{"completed":{"kind":"set","values":["outer@0::gather_evidence","triage"]},"kind":"running","loopStack":[{"bodyIndex":1,"iteration":0,"loopId":"outer"}],"pending":{"kind":"some","step":{"loopPath":[{"iteration":0,"loopId":"outer"}],"stepId":"update_hypotheses"}}},"v":1},"kind":"execution_snapshot","v":1}'
    );

    const crypto = new NodeCryptoV2();
    const digest = crypto.sha256(bytes);
    expect(digest).toBe('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2');
  });
});
