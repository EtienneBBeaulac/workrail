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
  shouldLoopContinue,
  evaluateLoopControlWithFallback,
  evaluateLoopControlDetailed,
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

describe('shouldLoopContinue', () => {
  it('returns ok(true) for continue decision', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'continue' },
    ];

    const result = shouldLoopContinue(artifacts, 'test-loop');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(true);
    }
  });

  it('returns ok(false) for stop decision', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'stop' },
    ];

    const result = shouldLoopContinue(artifacts, 'test-loop');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(false);
    }
  });

  it('returns err for missing artifact', () => {
    const artifacts: unknown[] = [];

    const result = shouldLoopContinue(artifacts, 'test-loop');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('MISSING_LOOP_CONTROL_ARTIFACT');
      expect(result.error.loopId).toBe('test-loop');
    }
  });

  it('returns err for wrong loopId', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'other-loop', decision: 'continue' },
    ];

    const result = shouldLoopContinue(artifacts, 'test-loop');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('MISSING_LOOP_CONTROL_ARTIFACT');
    }
  });
});

describe('evaluateLoopControlWithFallback', () => {
  it('uses artifact decision when found', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'stop' },
    ];

    const result = evaluateLoopControlWithFallback(artifacts, 'test-loop', true);
    expect(result).toBe(false); // Artifact says stop, ignores fallback
  });

  it('uses artifact continue over fallback stop', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'continue' },
    ];

    const result = evaluateLoopControlWithFallback(artifacts, 'test-loop', false);
    expect(result).toBe(true); // Artifact says continue, ignores fallback
  });

  it('falls back to context when artifact not found', () => {
    const artifacts: unknown[] = [];

    const resultContinue = evaluateLoopControlWithFallback(artifacts, 'test-loop', true);
    expect(resultContinue).toBe(true);

    const resultStop = evaluateLoopControlWithFallback(artifacts, 'test-loop', false);
    expect(resultStop).toBe(false);
  });

  it('falls back when loopId not matched', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'other-loop', decision: 'stop' },
    ];

    const result = evaluateLoopControlWithFallback(artifacts, 'test-loop', true);
    expect(result).toBe(true); // Falls back to contextDecision
  });
});

describe('evaluateLoopControlDetailed', () => {
  it('returns artifact source when found', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'continue' },
    ];

    const result = evaluateLoopControlDetailed(artifacts, 'test-loop', false);
    expect(result.source).toBe('artifact');
    expect(result.shouldContinue).toBe(true);
    expect(result.artifact).toBeDefined();
    expect(result.artifact?.loopId).toBe('test-loop');
    expect(result.reason).toContain('artifact found');
  });

  it('returns context_fallback source when not found', () => {
    const artifacts: unknown[] = [];

    const result = evaluateLoopControlDetailed(artifacts, 'test-loop', true);
    expect(result.source).toBe('context_fallback');
    expect(result.shouldContinue).toBe(true);
    expect(result.artifact).toBeUndefined();
    expect(result.reason).toContain('No artifacts provided');
  });

  it('returns context_fallback with correct decision', () => {
    const artifacts = [
      { kind: 'other_artifact', data: 'value' },
    ];

    const resultContinue = evaluateLoopControlDetailed(artifacts, 'test-loop', true);
    expect(resultContinue.source).toBe('context_fallback');
    expect(resultContinue.shouldContinue).toBe(true);

    const resultStop = evaluateLoopControlDetailed(artifacts, 'test-loop', false);
    expect(resultStop.source).toBe('context_fallback');
    expect(resultStop.shouldContinue).toBe(false);
  });

  it('includes decision in reason for artifact source', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'stop' },
    ];

    const result = evaluateLoopControlDetailed(artifacts, 'test-loop', true);
    expect(result.reason).toContain('decision=stop');
  });
});
