/**
 * Golden hash fixtures: determinism verification suite.
 *
 * Purpose (from v2-core-design-locks.md Section 16.4):
 * - Verify workflowHash and snapshotRef computation is stable across runs
 * - Prevent canonicalization drift
 * - Ensure replay produces byte-identical hashes
 *
 * @enforces jcs-rfc-8785
 * @enforces hash-format-sha256-hex
 * @enforces workflow-hash-jcs-sha256
 * @enforces snapshot-content-addressed
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { toCanonicalBytes } from '../../../../src/v2/durable-core/canonical/jcs.js';
import { workflowHashForCompiledSnapshot, snapshotRefForExecutionSnapshotFileV1 } from '../../../../src/v2/durable-core/canonical/hashing.js';
import { NodeCryptoV2 } from '../../../../src/v2/infra/local/crypto/index.js';
import type { JsonValue } from '../../../../src/v2/durable-core/canonical/json-types.js';
import type { ExecutionSnapshotFileV1 } from '../../../../src/v2/durable-core/schemas/execution-snapshot/index.js';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

interface GoldenFixture {
  readonly description: string;
  readonly input: JsonValue;
  readonly expectedJcsText?: string;
  readonly expectedSha256?: string;
}

function loadFixture(filename: string): GoldenFixture {
  const content = fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
  return JSON.parse(content) as GoldenFixture;
}

const crypto = new NodeCryptoV2();

describe('Golden hash fixtures (determinism verification)', () => {
  describe('Compiled workflow snapshots', () => {
    it('minimal v1_preview: hash matches pinned golden value', () => {
      const fixture = loadFixture('compiled-workflow-v1-minimal.json');
      
      const canonicalRes = toCanonicalBytes(fixture.input);
      expect(canonicalRes.isOk()).toBe(true);
      
      const canonical = canonicalRes._unsafeUnwrap();
      const text = new TextDecoder().decode(canonical as unknown as Uint8Array);
      
      // Verify JCS properties: keys sorted, compact (no spaces)
      expect(text).toContain('"description":"A minimal test workflow"');
      expect(text).toContain('"name":"Minimal Test Workflow"');
      expect(text).not.toContain('  '); // no whitespace
      
      // Compute hash and assert exact pinned value
      const hash = workflowHashForCompiledSnapshot(fixture.input, crypto)._unsafeUnwrap();
      expect(String(hash)).toBe(fixture.expectedSha256);
    });

    it('v1_pinned with definition: hash matches pinned golden value', () => {
      const fixture = loadFixture('compiled-workflow-v1-pinned.json');
      
      const canonicalRes = toCanonicalBytes(fixture.input);
      expect(canonicalRes.isOk()).toBe(true);
      
      const hash = workflowHashForCompiledSnapshot(fixture.input, crypto)._unsafeUnwrap();
      expect(String(hash)).toBe(fixture.expectedSha256);
    });
  });

  describe('Execution snapshots', () => {
    it('init state: hash matches pinned golden value', () => {
      const fixture = loadFixture('execution-snapshot-v1-init.json');
      expect(toCanonicalBytes(fixture.input).isOk()).toBe(true);
      
      const ref = snapshotRefForExecutionSnapshotFileV1(fixture.input as ExecutionSnapshotFileV1, crypto)._unsafeUnwrap();
      expect(String(ref)).toBe(fixture.expectedSha256);
    });

    it('running state: hash matches pinned golden value', () => {
      const fixture = loadFixture('execution-snapshot-v1-running.json');
      expect(toCanonicalBytes(fixture.input).isOk()).toBe(true);
      
      const ref = snapshotRefForExecutionSnapshotFileV1(fixture.input as ExecutionSnapshotFileV1, crypto)._unsafeUnwrap();
      expect(String(ref)).toBe(fixture.expectedSha256);
    });

    it('complete state: hash matches pinned golden value', () => {
      const fixture = loadFixture('execution-snapshot-v1-complete.json');
      expect(toCanonicalBytes(fixture.input).isOk()).toBe(true);
      
      const ref = snapshotRefForExecutionSnapshotFileV1(fixture.input as ExecutionSnapshotFileV1, crypto)._unsafeUnwrap();
      expect(String(ref)).toBe(fixture.expectedSha256);
    });

    it('with loop: hash matches pinned golden value', () => {
      const fixture = loadFixture('execution-snapshot-v1-with-loop.json');
      expect(toCanonicalBytes(fixture.input).isOk()).toBe(true);
      
      const ref = snapshotRefForExecutionSnapshotFileV1(fixture.input as ExecutionSnapshotFileV1, crypto)._unsafeUnwrap();
      expect(String(ref)).toBe(fixture.expectedSha256);
    });
  });

  // Token payloads: Removed (replaced by tests/unit/v2/golden-tokens/ for binary format)

  describe('Determinism under replay (100x stress test)', () => {
    it('workflowHash is byte-identical across 100 computations', () => {
      const fixture = loadFixture('compiled-workflow-v1-minimal.json');
      
      const hashes: string[] = [];
      for (let i = 0; i < 100; i++) {
        const hashRes = workflowHashForCompiledSnapshot(fixture.input, crypto);
        expect(hashRes.isOk()).toBe(true);
        hashes.push(String(hashRes._unsafeUnwrap()));
      }
      
      // All 100 hashes must be identical
      const unique = new Set(hashes);
      expect(unique.size).toBe(1);
      
      console.log(`[Determinism] 100x replay → stable hash: ${hashes[0]}`);
    });

    it('snapshotRef is byte-identical across 100 computations', () => {
      const fixture = loadFixture('execution-snapshot-v1-running.json');
      
      const refs: string[] = [];
      for (let i = 0; i < 100; i++) {
        const refRes = snapshotRefForExecutionSnapshotFileV1(
          fixture.input as ExecutionSnapshotFileV1,
          crypto
        );
        expect(refRes.isOk()).toBe(true);
        refs.push(String(refRes._unsafeUnwrap()));
      }
      
      const unique = new Set(refs);
      expect(unique.size).toBe(1);
      
      console.log(`[Determinism] 100x replay → stable ref: ${refs[0]}`);
    });

    // Token payload encoding: Removed (replaced by tests/unit/v2/tokens-property-based.test.ts for binary format)
  });

  describe('JCS canonicalization properties', () => {
    it('object key ordering is deterministic regardless of input order', () => {
      const input1: JsonValue = { z: 3, a: 1, m: 2 };
      const input2: JsonValue = { m: 2, z: 3, a: 1 };
      const input3: JsonValue = { a: 1, m: 2, z: 3 };
      
      const bytes1 = toCanonicalBytes(input1)._unsafeUnwrap();
      const bytes2 = toCanonicalBytes(input2)._unsafeUnwrap();
      const bytes3 = toCanonicalBytes(input3)._unsafeUnwrap();
      
      const text1 = new TextDecoder().decode(bytes1 as unknown as Uint8Array);
      const text2 = new TextDecoder().decode(bytes2 as unknown as Uint8Array);
      const text3 = new TextDecoder().decode(bytes3 as unknown as Uint8Array);
      
      expect(text1).toBe(text2);
      expect(text2).toBe(text3);
      expect(text1).toBe('{"a":1,"m":2,"z":3}');
    });

    it('nested object key ordering is deterministic', () => {
      const input: JsonValue = {
        outer2: { inner2: 'b', inner1: 'a' },
        outer1: { inner2: 'd', inner1: 'c' },
      };
      
      const canonical = toCanonicalBytes(input)._unsafeUnwrap();
      const text = new TextDecoder().decode(canonical as unknown as Uint8Array);
      
      // Verify both outer and inner keys are sorted
      expect(text).toBe('{"outer1":{"inner1":"c","inner2":"d"},"outer2":{"inner1":"a","inner2":"b"}}');
    });

    it('array order is preserved (not sorted)', () => {
      const input: JsonValue = { arr: [3, 1, 2] };
      
      const canonical = toCanonicalBytes(input)._unsafeUnwrap();
      const text = new TextDecoder().decode(canonical as unknown as Uint8Array);
      
      expect(text).toBe('{"arr":[3,1,2]}');
    });

    it('normalizes -0 to 0', () => {
      const input: JsonValue = { zero: -0, normal: 0 };
      
      const canonical = toCanonicalBytes(input)._unsafeUnwrap();
      const text = new TextDecoder().decode(canonical as unknown as Uint8Array);
      
      expect(text).toBe('{"normal":0,"zero":0}');
    });

    it('rejects NaN', () => {
      const input: JsonValue = { bad: Number.NaN };
      
      const res = toCanonicalBytes(input);
      expect(res.isErr()).toBe(true);
      expect(res._unsafeUnwrapErr().code).toBe('CANONICAL_JSON_NON_FINITE_NUMBER');
    });

    it('rejects Infinity', () => {
      const input: JsonValue = { bad: Number.POSITIVE_INFINITY };
      
      const res = toCanonicalBytes(input);
      expect(res.isErr()).toBe(true);
      expect(res._unsafeUnwrapErr().code).toBe('CANONICAL_JSON_NON_FINITE_NUMBER');
    });
  });

  describe('Hash stability under equivalent inputs', () => {
    it('same workflow content → same workflowHash regardless of key order', () => {
      const input1: JsonValue = {
        schemaVersion: 1,
        sourceKind: 'v1_preview',
        workflowId: 'test.stable',
        name: 'Test',
        description: 'Desc',
        version: '1.0.0',
        preview: { stepId: 's1', title: 'S1', prompt: 'P' },
      };
      
      const input2: JsonValue = {
        workflowId: 'test.stable',
        version: '1.0.0',
        sourceKind: 'v1_preview',
        schemaVersion: 1,
        preview: { prompt: 'P', stepId: 's1', title: 'S1' },
        name: 'Test',
        description: 'Desc',
      };
      
      const hash1 = workflowHashForCompiledSnapshot(input1, crypto)._unsafeUnwrap();
      const hash2 = workflowHashForCompiledSnapshot(input2, crypto)._unsafeUnwrap();
      
      expect(hash1).toBe(hash2);
    });

    it('different content → different workflowHash', () => {
      const input1: JsonValue = {
        schemaVersion: 1,
        sourceKind: 'v1_preview',
        workflowId: 'test.a',
        name: 'A',
        description: 'A',
        version: '1.0.0',
        preview: { stepId: 's1', title: 'S1', prompt: 'P' },
      };
      
      const input2: JsonValue = {
        schemaVersion: 1,
        sourceKind: 'v1_preview',
        workflowId: 'test.b',
        name: 'B',
        description: 'B',
        version: '1.0.0',
        preview: { stepId: 's1', title: 'S1', prompt: 'P' },
      };
      
      const hash1 = workflowHashForCompiledSnapshot(input1, crypto)._unsafeUnwrap();
      const hash2 = workflowHashForCompiledSnapshot(input2, crypto)._unsafeUnwrap();
      
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Replay stress test (lock: byte-identical across 1000x)', () => {
    it('1000x workflowHash computation is byte-identical', () => {
      const fixture = loadFixture('compiled-workflow-v1-pinned.json');
      
      const hashes = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const hashRes = workflowHashForCompiledSnapshot(fixture.input, crypto);
        expect(hashRes.isOk()).toBe(true);
        hashes.add(String(hashRes._unsafeUnwrap()));
      }
      
      expect(hashes.size).toBe(1);
      console.log(`[Stress] 1000x workflowHash → stable: ${Array.from(hashes)[0]}`);
    });

    it('1000x snapshotRef computation is byte-identical', () => {
      const fixture = loadFixture('execution-snapshot-v1-with-loop.json');
      
      const refs = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const refRes = snapshotRefForExecutionSnapshotFileV1(
          fixture.input as ExecutionSnapshotFileV1,
          crypto
        );
        expect(refRes.isOk()).toBe(true);
        refs.add(String(refRes._unsafeUnwrap()));
      }
      
      expect(refs.size).toBe(1);
      console.log(`[Stress] 1000x snapshotRef → stable: ${Array.from(refs)[0]}`);
    });

    // Token payload encoding: Removed (replaced by tests/unit/v2/tokens-property-based.test.ts for binary format)
  });
});
