/**
 * v2 Branded ID Types Tests
 *
 * @enforces branded-id-types
 */
import { describe, it, expect } from 'vitest';
import {
  asSessionId,
  asRunId,
  asNodeId,
  asEventId,
  asEventIndex,
  asManifestIndex,
  asAttemptId,
  asOutputId,
  asTokenStringV1,
  asSha256Digest,
  asWorkflowHash,
  asCanonicalBytes,
  asSnapshotRef,
} from '../../../src/v2/durable-core/ids/index.js';

describe('v2 branded ID types', () => {
  describe('SessionId constructor', () => {
    it('accepts valid string and returns branded type', () => {
      const sessionId = asSessionId('sess_01JH8X2ABC');
      expect(typeof sessionId).toBe('string');
      expect(sessionId).toBe('sess_01JH8X2ABC');
    });

    it('preserves string value through identity', () => {
      const input = 'sess_unique_123';
      const branded = asSessionId(input);
      expect(branded).toBe(input);
    });
  });

  describe('RunId constructor', () => {
    it('accepts valid string and returns branded type', () => {
      const runId = asRunId('run_01JFDXYZ');
      expect(typeof runId).toBe('string');
      expect(runId).toBe('run_01JFDXYZ');
    });
  });

  describe('NodeId constructor', () => {
    it('accepts valid string and returns branded type', () => {
      const nodeId = asNodeId('node_01JFDN123');
      expect(typeof nodeId).toBe('string');
      expect(nodeId).toBe('node_01JFDN123');
    });
  });

  describe('EventId constructor', () => {
    it('accepts valid string and returns branded type', () => {
      const eventId = asEventId('evt_01JH8X2DEF');
      expect(typeof eventId).toBe('string');
      expect(eventId).toBe('evt_01JH8X2DEF');
    });
  });

  describe('EventIndex constructor', () => {
    it('accepts non-negative integer and returns branded type', () => {
      const idx = asEventIndex(0);
      expect(typeof idx).toBe('number');
      expect(idx).toBe(0);
    });

    it('preserves index value through identity', () => {
      const idx = asEventIndex(42);
      expect(idx).toBe(42);
    });
  });

  describe('ManifestIndex constructor', () => {
    it('accepts non-negative integer and returns branded type', () => {
      const idx = asManifestIndex(0);
      expect(typeof idx).toBe('number');
      expect(idx).toBe(0);
    });

    it('preserves manifest index value through identity', () => {
      const idx = asManifestIndex(7);
      expect(idx).toBe(7);
    });
  });

  describe('AttemptId constructor', () => {
    it('accepts valid string and returns branded type', () => {
      const attemptId = asAttemptId('attempt_01JH8X2GHI');
      expect(typeof attemptId).toBe('string');
      expect(attemptId).toBe('attempt_01JH8X2GHI');
    });
  });

  describe('OutputId constructor', () => {
    it('accepts valid string and returns branded type', () => {
      const outputId = asOutputId('out_recap_attempt_01...');
      expect(typeof outputId).toBe('string');
      expect(outputId).toBe('out_recap_attempt_01...');
    });
  });

  describe('TokenStringV1 constructor', () => {
    it('accepts token string and returns branded type', () => {
      const tokenStr = 'st1qpzry9x8gf2tvdw0s3jn54khce6mua7l';
      const token = asTokenStringV1(tokenStr);
      expect(typeof token).toBe('string');
      expect(token).toBe(tokenStr);
    });
  });

  describe('Sha256Digest constructor', () => {
    it('accepts digest string in canonical format', () => {
      const digest = asSha256Digest('sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11');
      expect(typeof digest).toBe('string');
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('WorkflowHash constructor', () => {
    it('accepts Sha256Digest and returns branded type', () => {
      const digest = asSha256Digest('sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11');
      const hash = asWorkflowHash(digest);
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('CanonicalBytes constructor', () => {
    it('accepts Uint8Array and returns branded type', () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const canonical = asCanonicalBytes(bytes);
      expect(canonical).toBeInstanceOf(Uint8Array);
      expect(canonical.length).toBe(4);
    });
  });

  describe('SnapshotRef constructor', () => {
    it('accepts Sha256Digest and returns branded type', () => {
      const digest = asSha256Digest('sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234');
      const ref = asSnapshotRef(digest);
      expect(typeof ref).toBe('string');
      expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('Type safety (compile-time guarantee)', () => {
    it('all branded ID constructors exist and are callable', () => {
      // This test verifies constructors are exported and callable.
      // Runtime just delegates to the Brand<> wrapper (pure functions).
      expect(typeof asSessionId).toBe('function');
      expect(typeof asRunId).toBe('function');
      expect(typeof asNodeId).toBe('function');
      expect(typeof asEventId).toBe('function');
      expect(typeof asEventIndex).toBe('function');
      expect(typeof asManifestIndex).toBe('function');
      expect(typeof asAttemptId).toBe('function');
      expect(typeof asOutputId).toBe('function');
      expect(typeof asTokenStringV1).toBe('function');
      expect(typeof asSha256Digest).toBe('function');
      expect(typeof asWorkflowHash).toBe('function');
      expect(typeof asCanonicalBytes).toBe('function');
      expect(typeof asSnapshotRef).toBe('function');
    });
  });

  describe('Branded types prevent mixing (type-level enforcement)', () => {
    it('session, run, and node IDs are distinct types (type system enforces at compile time)', () => {
      const sessionId = asSessionId('sess_1');
      const runId = asRunId('run_1');
      const nodeId = asNodeId('node_1');

      // Runtime: these are all just strings, but at compile time, TypeScript prevents assignment:
      // const bad1: SessionId = runId; // compile error
      // const bad2: RunId = nodeId;   // compile error

      // This test documents the brand invariant.
      expect(sessionId).toBe('sess_1');
      expect(runId).toBe('run_1');
      expect(nodeId).toBe('node_1');
    });
  });
});
