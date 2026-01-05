/**
 * Property-based tests for binary token encoding using fast-check.
 *
 * Purpose:
 * - Verify pack/unpack roundtrip properties hold for ALL valid inputs
 * - Detect edge cases that unit tests might miss
 * - Ensure binary format is robust across the full input space
 *
 * @enforces token-binary-roundtrip
 * @enforces binary-payload-deterministic
 * @enforces token-binary-payload-layout
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  packStateTokenPayload,
  packAckTokenPayload,
  packCheckpointTokenPayload,
  unpackTokenPayload,
} from '../../../src/v2/durable-core/tokens/binary-payload.js';
import type {
  StateTokenPayloadV1,
  AckTokenPayloadV1,
  CheckpointTokenPayloadV1,
} from '../../../src/v2/durable-core/tokens/payloads.js';
import { encodeBase32LowerNoPad } from '../../../src/v2/durable-core/encoding/base32-lower.js';
import { asSessionId, asRunId, asNodeId, asAttemptId, asWorkflowHashRef } from '../../../src/v2/durable-core/ids/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';

// Shared Base32 adapter for all tests
const base32 = new Base32AdapterV2();

// Arbitrary generators for IDs (16-byte base32-encoded)
const arbId = (prefix: string) =>
  fc
    .uint8Array({ minLength: 16, maxLength: 16 })
    .map((bytes) => `${prefix}_${encodeBase32LowerNoPad(bytes)}`);

const arbSessionId = arbId('sess').map(asSessionId);
const arbRunId = arbId('run').map(asRunId);
const arbNodeId = arbId('node').map(asNodeId);
const arbAttemptId = arbId('attempt').map(asAttemptId);
const arbWorkflowHashRef = arbId('wf').map(asWorkflowHashRef);

const arbStatePayload: fc.Arbitrary<StateTokenPayloadV1> = fc.record({
  tokenVersion: fc.constant(1 as const),
  tokenKind: fc.constant('state' as const),
  sessionId: arbSessionId,
  runId: arbRunId,
  nodeId: arbNodeId,
  workflowHashRef: arbWorkflowHashRef,
});

const arbAckPayload: fc.Arbitrary<AckTokenPayloadV1> = fc.record({
  tokenVersion: fc.constant(1 as const),
  tokenKind: fc.constant('ack' as const),
  sessionId: arbSessionId,
  runId: arbRunId,
  nodeId: arbNodeId,
  attemptId: arbAttemptId,
});

const arbCheckpointPayload: fc.Arbitrary<CheckpointTokenPayloadV1> = fc.record({
  tokenVersion: fc.constant(1 as const),
  tokenKind: fc.constant('checkpoint' as const),
  sessionId: arbSessionId,
  runId: arbRunId,
  nodeId: arbNodeId,
  attemptId: arbAttemptId,
});

describe('Property-based: binary token encoding', () => {
  describe('State token roundtrip', () => {
    it('pack → unpack recovers original payload (10000 samples)', () => {
      fc.assert(
        fc.property(arbStatePayload, (payload) => {
          const packed = packStateTokenPayload(payload, base32);
          expect(packed.isOk()).toBe(true);
          if (packed.isErr()) return;

          const unpacked = unpackTokenPayload(packed.value);
          expect(unpacked.isOk()).toBe(true);
          if (unpacked.isErr()) return;

          expect(unpacked.value.tokenVersion).toBe(payload.tokenVersion);
          expect(unpacked.value.tokenKind).toBe(payload.tokenKind);
          expect(unpacked.value.sessionId).toBe(payload.sessionId);
          expect(unpacked.value.runId).toBe(payload.runId);
          expect(unpacked.value.nodeId).toBe(payload.nodeId);
          expect((unpacked.value as StateTokenPayloadV1).workflowHashRef).toBe(payload.workflowHashRef);
        }),
        { numRuns: 10000 }
      );
    });

    it('pack → unpack → pack is idempotent (5000 samples)', () => {
      fc.assert(
        fc.property(arbStatePayload, (payload) => {
          const packed1 = packStateTokenPayload(payload, base32);
          expect(packed1.isOk()).toBe(true);
          if (packed1.isErr()) return;

          const unpacked = unpackTokenPayload(packed1.value);
          expect(unpacked.isOk()).toBe(true);
          if (unpacked.isErr()) return;

          const packed2 = packStateTokenPayload(unpacked.value as StateTokenPayloadV1);
          expect(packed2.isOk()).toBe(true);
          if (packed2.isErr()) return;

          // Binary representation must be identical
          expect(Array.from(packed2.value)).toEqual(Array.from(packed1.value));
        }),
        { numRuns: 5000 }
      );
    });

    it('packed output is always exactly 66 bytes', () => {
      fc.assert(
        fc.property(arbStatePayload, (payload) => {
          const packed = packStateTokenPayload(payload, base32);
          expect(packed.isOk()).toBe(true);
          if (packed.isErr()) return;

          expect(packed.value.length).toBe(66);
        }),
        { numRuns: 10000 }
      );
    });
  });

  describe('Ack token roundtrip', () => {
    it('pack → unpack recovers original payload (10000 samples)', () => {
      fc.assert(
        fc.property(arbAckPayload, (payload) => {
          const packed = packAckTokenPayload(payload, base32);
          expect(packed.isOk()).toBe(true);
          if (packed.isErr()) return;

          const unpacked = unpackTokenPayload(packed.value);
          expect(unpacked.isOk()).toBe(true);
          if (unpacked.isErr()) return;

          expect(unpacked.value.tokenKind).toBe('ack');
          expect(unpacked.value.sessionId).toBe(payload.sessionId);
          expect(unpacked.value.runId).toBe(payload.runId);
          expect(unpacked.value.nodeId).toBe(payload.nodeId);
          expect((unpacked.value as AckTokenPayloadV1).attemptId).toBe(payload.attemptId);
        }),
        { numRuns: 10000 }
      );
    });

    it('packed output is always exactly 66 bytes', () => {
      fc.assert(
        fc.property(arbAckPayload, (payload) => {
          const packed = packAckTokenPayload(payload, base32);
          expect(packed.isOk()).toBe(true);
          if (packed.isErr()) return;

          expect(packed.value.length).toBe(66);
        }),
        { numRuns: 10000 }
      );
    });
  });

  describe('Checkpoint token roundtrip', () => {
    it('pack → unpack recovers original payload (10000 samples)', () => {
      fc.assert(
        fc.property(arbCheckpointPayload, (payload) => {
          const packed = packCheckpointTokenPayload(payload, base32);
          expect(packed.isOk()).toBe(true);
          if (packed.isErr()) return;

          const unpacked = unpackTokenPayload(packed.value);
          expect(unpacked.isOk()).toBe(true);
          if (unpacked.isErr()) return;

          expect(unpacked.value.tokenKind).toBe('checkpoint');
          expect(unpacked.value.sessionId).toBe(payload.sessionId);
          expect(unpacked.value.runId).toBe(payload.runId);
          expect(unpacked.value.nodeId).toBe(payload.nodeId);
          expect((unpacked.value as CheckpointTokenPayloadV1).attemptId).toBe(payload.attemptId);
        }),
        { numRuns: 10000 }
      );
    });
  });

  describe('Binary format invariants', () => {
    it('different payloads produce different packed bytes (5000 samples)', () => {
      fc.assert(
        fc.property(arbStatePayload, arbStatePayload, (p1, p2) => {
          // Skip if payloads are identical
          if (
            p1.sessionId === p2.sessionId &&
            p1.runId === p2.runId &&
            p1.nodeId === p2.nodeId &&
            p1.workflowHashRef === p2.workflowHashRef
          ) {
            return;
          }

          const packed1 = packStateTokenPayload(p1);
          const packed2 = packStateTokenPayload(p2);

          expect(packed1.isOk()).toBe(true);
          expect(packed2.isOk()).toBe(true);
          if (packed1.isErr() || packed2.isErr()) return;

          // Different payloads MUST produce different bytes
          expect(Array.from(packed1.value)).not.toEqual(Array.from(packed2.value));
        }),
        { numRuns: 5000 }
      );
    });

    it('rejects invalid ID prefixes deterministically (1000 samples)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('wrong', 'bad', 'invalid', 'x'),
          fc.uint8Array({ minLength: 16, maxLength: 16 }),
          arbRunId,
          arbNodeId,
          arbWorkflowHashRef,
          (badPrefix, bytes, runId, nodeId, wfRef) => {
            const badId = `${badPrefix}_${encodeBase32LowerNoPad(bytes)}`;
            const payload = {
              tokenVersion: 1 as const,
              tokenKind: 'state' as const,
              sessionId: badId as any, // Intentionally wrong prefix
              runId,
              nodeId,
              workflowHashRef: wfRef,
            };

            const result = packStateTokenPayload(payload, base32);
            expect(result.isErr()).toBe(true);
            if (result.isErr()) {
              expect(result.error.code).toBe('BINARY_INVALID_ID_FORMAT');
            }
          }
        ),
        { numRuns: 1000 }
      );
    });
  });

  describe('Error code reachability', () => {
    it('BINARY_INVALID_VERSION is reachable', () => {
      const validSessionId = fc.sample(arbSessionId, 1)[0];
      const validRunId = fc.sample(arbRunId, 1)[0];
      const validNodeId = fc.sample(arbNodeId, 1)[0];
      const validWfRef = fc.sample(arbWorkflowHashRef, 1)[0];
      
      const invalidPayload = {
        tokenVersion: 2 as any, // Invalid: must be 1
        tokenKind: 'state' as const,
        sessionId: validSessionId,
        runId: validRunId,
        nodeId: validNodeId,
        workflowHashRef: validWfRef,
      };
      
      const result = packStateTokenPayload(invalidPayload as any, base32);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('BINARY_INVALID_VERSION');
      }
    });

    it('BINARY_INVALID_ID_FORMAT is reachable (wrong prefix)', () => {
      const validRunId = fc.sample(arbRunId, 1)[0];
      const validNodeId = fc.sample(arbNodeId, 1)[0];
      const validWfRef = fc.sample(arbWorkflowHashRef, 1)[0];
      
      const invalidPayload = {
        tokenVersion: 1,
        tokenKind: 'state' as const,
        sessionId: 'run_abc2def3ghi4jkl5mno6pqr7s2' as any, // Wrong prefix (should be sess_)
        runId: validRunId,
        nodeId: validNodeId,
        workflowHashRef: validWfRef,
      };
      
      const result = packStateTokenPayload(invalidPayload as any, base32);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('BINARY_INVALID_ID_FORMAT');
      }
    });

    it('BINARY_INVALID_TOKEN_KIND is reachable', () => {
      const validSessionId = fc.sample(arbSessionId, 1)[0];
      const validRunId = fc.sample(arbRunId, 1)[0];
      const validNodeId = fc.sample(arbNodeId, 1)[0];
      const validWfRef = fc.sample(arbWorkflowHashRef, 1)[0];
      
      const invalidPayload = {
        tokenVersion: 1,
        tokenKind: 'ack' as any, // Wrong kind for packStateTokenPayload
        sessionId: validSessionId,
        runId: validRunId,
        nodeId: validNodeId,
        workflowHashRef: validWfRef,
      };
      
      const result = packStateTokenPayload(invalidPayload as any, base32);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('BINARY_INVALID_TOKEN_KIND');
      }
    });
  });
});
