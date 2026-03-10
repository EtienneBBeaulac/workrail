/**
 * Loop Control Evaluator Tests
 * 
 * Tests for evaluating loop control decisions from artifacts.
 * 
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateLoopControlFromArtifacts,
} from '../../../src/v2/durable-core/domain/loop-control-evaluator.js';

describe('evaluateLoopControlFromArtifacts', () => {
  describe('found artifacts', () => {
    it('returns found with continue decision', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'continue' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.decision).toBe('continue');
        expect(result.artifact.loopId).toBe('test-loop');
      }
    });

    it('returns found for anonymous artifact (no loopId)', () => {
      const artifacts = [
        { kind: 'wr.loop_control', decision: 'stop' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.decision).toBe('stop');
        expect(result.artifact.loopId).toBeUndefined();
      }
    });

    it('returns found with stop decision', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'stop' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.decision).toBe('stop');
      }
    });

    it('finds most recent artifact among multiple', () => {
      const artifacts = [
        { kind: 'other_artifact', data: 'value' },
        { kind: 'wr.loop_control', loopId: 'loop-a', decision: 'continue' },
        { kind: 'wr.loop_control', loopId: 'loop-b', decision: 'stop' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.decision).toBe('stop');
        expect(result.artifact.loopId).toBe('loop-b');
      }
    });

    it('includes full artifact in result', () => {
      const artifacts = [
        {
          kind: 'wr.loop_control',
          loopId: 'test-loop',
          decision: 'continue',
          metadata: { reason: 'Issues found' },
        },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.artifact.metadata?.reason).toBe('Issues found');
      }
    });
  });

  describe('not found', () => {
    it('returns not_found for empty artifacts', () => {
      const result = evaluateLoopControlFromArtifacts([]);
      expect(result.kind).toBe('not_found');
      if (result.kind === 'not_found') {
        expect(result.reason).toContain('No artifacts provided');
      }
    });

    it('finds artifact even when agent provides a different loopId than expected', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'other-loop', decision: 'continue' },
      ];

      // The function is loopId-agnostic — it finds any valid artifact
      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.decision).toBe('continue');
        expect(result.artifact.loopId).toBe('other-loop');
      }
    });

    it('returns not_found when only non-loop-control artifacts exist', () => {
      const artifacts = [
        { kind: 'other_artifact', data: 'value' },
        { kind: 'another_artifact', data: 'value2' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('not_found');
    });
  });

  describe('invalid (kind matches but schema fails)', () => {
    it('returns invalid for artifact with bad loopId format', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'INVALID-CAPS', decision: 'continue' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.reason).toContain('schema validation');
      }
    });

    it('returns invalid for artifact with missing decision field', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'test-loop' }, // no decision
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('invalid');
    });

    it('returns invalid for artifact with extra fields (strict mode)', () => {
      const artifacts = [
        { kind: 'wr.loop_control', decision: 'stop', extraField: 'unexpected' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('invalid');
    });

    it('returns found when valid artifact exists alongside invalid one', () => {
      // findLoopControlArtifact reverse-searches, so the valid one (last) is found
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'INVALID-CAPS', decision: 'continue' }, // invalid schema
        { kind: 'wr.loop_control', decision: 'stop' }, // valid (no loopId)
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts);
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.decision).toBe('stop');
      }
    });
  });

  describe('edge cases', () => {
    it('handles null in artifacts array', () => {
      const artifacts = [null, { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'continue' }];

      const result = evaluateLoopControlFromArtifacts(artifacts as any);
      expect(result.kind).toBe('found');
    });
  });
});
