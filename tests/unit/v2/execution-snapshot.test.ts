/**
 * @enforces snapshot-discriminated-union
 * @enforces snapshot-pending-explicit
 * @enforces snapshot-impossible-state-rejected
 * @enforces snapshot-loop-id-unique
 * @enforces snapshot-completed-sorted
 * @enforces snapshot-rehydration-only
 */
import { describe, it, expect } from 'vitest';
import { ExecutionSnapshotFileV1Schema } from '../../../src/v2/durable-core/schemas/execution-snapshot/index.js';
import { toCanonicalBytes } from '../../../src/v2/durable-core/canonical/jcs.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('v2 execution snapshot schema (Slice 3 prereq)', () => {
  it('is JCS-canonicalizable with a stable golden sha256', () => {
    // @enforces snapshot-discriminated-union, snapshot-pending-explicit, snapshot-impossible-state-rejected, snapshot-loop-id-unique, snapshot-completed-sorted, snapshot-rehydration-only
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

  it('schema rejects unsorted completed step instances', () => {
    // @enforces snapshot-completed-sorted
    const unsortedSnapshot = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: {
        v: 1,
        engineState: {
          kind: 'running',
          completed: {
            kind: 'set',
            values: ['step3', 'step1', 'step2'],
          },
          loopStack: [],
          pending: { kind: 'none' },
        },
      },
    };

    const parseRes = ExecutionSnapshotFileV1Schema.safeParse(unsortedSnapshot);
    expect(parseRes.success).toBe(false);
    if (!parseRes.success) {
      expect(parseRes.error.issues[0]?.message).toContain('sorted lexicographically');
    }
  });

  it('schema accepts sorted completed step instances', () => {
    // @enforces snapshot-completed-sorted
    const sortedSnapshot = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: {
        v: 1,
        engineState: {
          kind: 'running',
          completed: {
            kind: 'set',
            values: ['step1', 'step2', 'step3'],
          },
          loopStack: [],
          pending: { kind: 'none' },
        },
      },
    };

    const parseRes = ExecutionSnapshotFileV1Schema.safeParse(sortedSnapshot);
    expect(parseRes.success).toBe(true);
  });

  it('rejects unknown engineState.kind (discriminated union)', () => {
    // @enforces snapshot-discriminated-union
    const bad = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: {
        v: 1,
        engineState: {
          kind: 'weird',
        },
      },
    };

    const res = ExecutionSnapshotFileV1Schema.safeParse(bad);
    expect(res.success).toBe(false);
  });

  it('rejects unknown pending.kind', () => {
    // @enforces snapshot-pending-explicit
    const bad = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: {
        v: 1,
        engineState: {
          kind: 'running',
          completed: { kind: 'set', values: [] },
          loopStack: [],
          pending: { kind: 'maybe' },
        },
      },
    };

    const res = ExecutionSnapshotFileV1Schema.safeParse(bad);
    expect(res.success).toBe(false);
  });

  it('rejects duplicate loopId in loopStack', () => {
    // @enforces snapshot-loop-id-unique
    const bad = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: {
        v: 1,
        engineState: {
          kind: 'running',
          completed: { kind: 'set', values: [] },
          loopStack: [
            { loopId: 'outer', iteration: 0, bodyIndex: 0 },
            { loopId: 'outer', iteration: 1, bodyIndex: 0 },
          ],
          pending: { kind: 'none' },
        },
      },
    };

    const res = ExecutionSnapshotFileV1Schema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message.includes('must not contain the same loopId twice'))).toBe(true);
    }
  });

  it('rejects pending.loopPath mismatch with loopStack', () => {
    const bad = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: {
        v: 1,
        engineState: {
          kind: 'running',
          completed: { kind: 'set', values: [] },
          loopStack: [{ loopId: 'outer', iteration: 0, bodyIndex: 0 }],
          pending: {
            kind: 'some',
            step: { stepId: 'triage', loopPath: [] },
          },
        },
      },
    };

    const res = ExecutionSnapshotFileV1Schema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message.includes('loopPath must exactly match loopStack'))).toBe(true);
    }
  });

  it('rejects impossible state: pending step instance already completed', () => {
    // @enforces snapshot-impossible-state-rejected
    const bad = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: {
        v: 1,
        engineState: {
          kind: 'running',
          completed: { kind: 'set', values: ['triage'] },
          loopStack: [],
          pending: {
            kind: 'some',
            step: { stepId: 'triage', loopPath: [] },
          },
        },
      },
    };

    const res = ExecutionSnapshotFileV1Schema.safeParse(bad);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.message.includes('Impossible state'))).toBe(true);
    }
  });

  it('rejects extra fields (rehydration-only)', () => {
    // @enforces snapshot-rehydration-only
    const bad = {
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: {
        v: 1,
        engineState: { kind: 'init' },
      },
      cachedProjection: { foo: 'bar' },
    };

    const res = ExecutionSnapshotFileV1Schema.safeParse(bad);
    expect(res.success).toBe(false);
  });
});
