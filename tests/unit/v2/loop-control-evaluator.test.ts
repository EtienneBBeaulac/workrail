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

      const result = evaluateLoopControlFromArtifacts(artifacts, 'test-loop');
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.decision).toBe('continue');
        expect(result.artifact.loopId).toBe('test-loop');
      }
    });

    it('returns found with stop decision', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'stop' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts, 'test-loop');
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.decision).toBe('stop');
      }
    });

    it('finds correct artifact among multiple', () => {
      const artifacts = [
        { kind: 'other_artifact', data: 'value' },
        { kind: 'wr.loop_control', loopId: 'loop-a', decision: 'continue' },
        { kind: 'wr.loop_control', loopId: 'loop-b', decision: 'stop' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts, 'loop-b');
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

      const result = evaluateLoopControlFromArtifacts(artifacts, 'test-loop');
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.artifact.metadata?.reason).toBe('Issues found');
      }
    });
  });

  describe('not found', () => {
    it('returns not_found for empty artifacts', () => {
      const result = evaluateLoopControlFromArtifacts([], 'test-loop');
      expect(result.kind).toBe('not_found');
      if (result.kind === 'not_found') {
        expect(result.reason).toContain('No artifacts provided');
      }
    });

    it('returns not_found when loopId not present', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'other-loop', decision: 'continue' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts, 'test-loop');
      expect(result.kind).toBe('not_found');
      if (result.kind === 'not_found') {
        expect(result.reason).toContain('No loop control artifact found');
        expect(result.reason).toContain('test-loop');
      }
    });

    it('returns not_found when only non-loop-control artifacts exist', () => {
      const artifacts = [
        { kind: 'other_artifact', data: 'value' },
        { kind: 'another_artifact', data: 'value2' },
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts, 'test-loop');
      expect(result.kind).toBe('not_found');
    });
  });

  describe('edge cases', () => {
    it('handles artifacts with invalid schema (returns not_found)', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'INVALID-CAPS', decision: 'continue' }, // Invalid loopId
      ];

      const result = evaluateLoopControlFromArtifacts(artifacts, 'INVALID-CAPS');
      expect(result.kind).toBe('not_found');
    });

    it('handles null in artifacts array', () => {
      const artifacts = [null, { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'continue' }];

      const result = evaluateLoopControlFromArtifacts(artifacts as any, 'test-loop');
      expect(result.kind).toBe('found');
    });
  });
});
