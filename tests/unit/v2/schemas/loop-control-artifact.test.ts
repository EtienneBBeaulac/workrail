/**
 * Loop Control Artifact Schema Tests
 * 
 * Tests for the LoopControlArtifactV1 schema that replaces
 * brittle substring validation with typed artifacts.
 * 
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 */

import { describe, it, expect } from 'vitest';
import {
  LoopControlArtifactV1Schema,
  LoopControlDecisionSchema,
  LoopControlMetadataV1Schema,
  LOOP_CONTROL_CONTRACT_REF,
  isLoopControlArtifact,
  parseLoopControlArtifact,
  findLoopControlArtifact,
  type LoopControlArtifactV1,
} from '../../../../src/v2/durable-core/schemas/artifacts/index.js';

describe('LoopControlArtifactV1Schema', () => {
  describe('valid artifacts', () => {
    it('accepts minimal valid artifact with continue decision', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'plan-iteration',
        decision: 'continue',
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.kind).toBe('wr.loop_control');
        expect(result.data.loopId).toBe('plan-iteration');
        expect(result.data.decision).toBe('continue');
        expect(result.data.metadata).toBeUndefined();
      }
    });

    it('accepts minimal valid artifact with stop decision', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'implementation-loop',
        decision: 'stop',
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.decision).toBe('stop');
      }
    });

    it('accepts artifact with full metadata', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'review-cycle',
        decision: 'continue',
        metadata: {
          reason: 'Found 2 gaps that need addressing',
          issuesFound: 2,
          iterationIndex: 3,
          confidence: 85,
        },
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.metadata?.reason).toBe('Found 2 gaps that need addressing');
        expect(result.data.metadata?.issuesFound).toBe(2);
        expect(result.data.metadata?.iterationIndex).toBe(3);
        expect(result.data.metadata?.confidence).toBe(85);
      }
    });

    it('accepts artifact with partial metadata', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'test-loop',
        decision: 'stop',
        metadata: {
          reason: 'Clean pass - no issues found',
        },
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(true);
    });

    it('accepts loopId with hyphens and underscores', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'plan_iteration-v2',
        decision: 'continue',
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid artifacts', () => {
    it('rejects artifact with wrong kind', () => {
      const artifact = {
        kind: 'wrong_kind',
        loopId: 'test',
        decision: 'continue',
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(false);
    });

    it('rejects artifact with invalid decision', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'test',
        decision: 'maybe', // Invalid
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(false);
    });

    it('accepts artifact with missing loopId (anonymous — engine infers from active loop)', () => {
      const artifact = {
        kind: 'wr.loop_control',
        decision: 'continue',
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.loopId).toBeUndefined();
        expect(result.data.decision).toBe('continue');
      }
    });

    it('rejects artifact with missing decision', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'test',
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(false);
    });

    it('rejects artifact with non-delimiter-safe loopId (uppercase)', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'TestLoop', // Uppercase not allowed
        decision: 'continue',
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(false);
    });

    it('rejects artifact with non-delimiter-safe loopId (spaces)', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'test loop', // Spaces not allowed
        decision: 'continue',
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(false);
    });

    it('rejects artifact with extra fields (strict mode)', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'test',
        decision: 'continue',
        extraField: 'not allowed', // Extra field
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(false);
    });

    it('rejects metadata with invalid confidence (> 100)', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'test',
        decision: 'continue',
        metadata: {
          confidence: 150, // Invalid
        },
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(false);
    });

    it('rejects metadata with negative issuesFound', () => {
      const artifact = {
        kind: 'wr.loop_control',
        loopId: 'test',
        decision: 'continue',
        metadata: {
          issuesFound: -1, // Invalid
        },
      };

      const result = LoopControlArtifactV1Schema.safeParse(artifact);
      expect(result.success).toBe(false);
    });
  });

  describe('decision schema', () => {
    it('only accepts continue or stop', () => {
      expect(LoopControlDecisionSchema.safeParse('continue').success).toBe(true);
      expect(LoopControlDecisionSchema.safeParse('stop').success).toBe(true);
      expect(LoopControlDecisionSchema.safeParse('pause').success).toBe(false);
      expect(LoopControlDecisionSchema.safeParse('').success).toBe(false);
      expect(LoopControlDecisionSchema.safeParse(null).success).toBe(false);
    });
  });

  describe('contract reference', () => {
    it('has correct contract ref value', () => {
      expect(LOOP_CONTROL_CONTRACT_REF).toBe('wr.contracts.loop_control');
    });
  });
});

describe('isLoopControlArtifact', () => {
  it('returns true for valid loop control artifact', () => {
    const artifact = {
      kind: 'wr.loop_control',
      loopId: 'test',
      decision: 'continue',
    };
    expect(isLoopControlArtifact(artifact)).toBe(true);
  });

  it('returns false for artifact with wrong kind', () => {
    const artifact = {
      kind: 'other_kind',
      loopId: 'test',
      decision: 'continue',
    };
    expect(isLoopControlArtifact(artifact)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isLoopControlArtifact(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isLoopControlArtifact(undefined)).toBe(false);
  });

  it('returns false for primitive values', () => {
    expect(isLoopControlArtifact('string')).toBe(false);
    expect(isLoopControlArtifact(123)).toBe(false);
    expect(isLoopControlArtifact(true)).toBe(false);
  });
});

describe('parseLoopControlArtifact', () => {
  it('returns parsed artifact for valid input', () => {
    const artifact = {
      kind: 'wr.loop_control',
      loopId: 'test',
      decision: 'stop',
    };

    const result = parseLoopControlArtifact(artifact);
    expect(result).not.toBeNull();
    expect(result?.loopId).toBe('test');
    expect(result?.decision).toBe('stop');
  });

  it('returns null for invalid input', () => {
    const artifact = {
      kind: 'wr.loop_control',
      loopId: 'test',
      decision: 'invalid',
    };

    const result = parseLoopControlArtifact(artifact);
    expect(result).toBeNull();
  });

  it('returns null for non-loop-control artifact', () => {
    const artifact = {
      kind: 'other',
      data: 'value',
    };

    const result = parseLoopControlArtifact(artifact);
    expect(result).toBeNull();
  });
});

describe('findLoopControlArtifact', () => {
  const artifacts = [
    { kind: 'other_artifact', data: 'value' },
    { kind: 'wr.loop_control', loopId: 'loop-a', decision: 'continue' },
    { kind: 'wr.loop_control', loopId: 'loop-b', decision: 'stop' },
    { kind: 'another_artifact', data: 'value2' },
  ];

  it('finds artifact by loopId', () => {
    const result = findLoopControlArtifact(artifacts, 'loop-a');
    expect(result).not.toBeNull();
    expect(result?.loopId).toBe('loop-a');
    expect(result?.decision).toBe('continue');
  });

  it('finds correct artifact when multiple exist', () => {
    const result = findLoopControlArtifact(artifacts, 'loop-b');
    expect(result).not.toBeNull();
    expect(result?.loopId).toBe('loop-b');
    expect(result?.decision).toBe('stop');
  });

  it('returns null for non-existent loopId', () => {
    const result = findLoopControlArtifact(artifacts, 'loop-c');
    expect(result).toBeNull();
  });

  it('returns null for empty artifacts array', () => {
    const result = findLoopControlArtifact([], 'any-loop');
    expect(result).toBeNull();
  });

  it('handles artifacts with invalid schema gracefully', () => {
    const badArtifacts = [
      { kind: 'wr.loop_control', loopId: 'INVALID-CAPS', decision: 'continue' }, // Invalid loopId
      { kind: 'wr.loop_control', loopId: 'valid-loop', decision: 'stop' },
    ];

    const result = findLoopControlArtifact(badArtifacts, 'valid-loop');
    expect(result).not.toBeNull();
    expect(result?.loopId).toBe('valid-loop');
  });

  it('matches anonymous artifact (no loopId) for any expectedLoopId', () => {
    const artifacts = [
      { kind: 'wr.loop_control', decision: 'stop' }, // no loopId
    ];

    const result = findLoopControlArtifact(artifacts, 'plan-iteration');
    expect(result).not.toBeNull();
    expect(result?.decision).toBe('stop');
    expect(result?.loopId).toBeUndefined();
  });

  it('prefers the most recent artifact — anonymous stop wins over older named continue', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'plan-iteration', decision: 'continue' },
      { kind: 'wr.loop_control', decision: 'stop' }, // anonymous, most recent
    ];

    const result = findLoopControlArtifact(artifacts, 'plan-iteration');
    expect(result).not.toBeNull();
    expect(result?.decision).toBe('stop');
  });

  it('skips anonymous artifact when a named match appears later', () => {
    const artifacts = [
      { kind: 'wr.loop_control', decision: 'stop' }, // anonymous, older
      { kind: 'wr.loop_control', loopId: 'plan-iteration', decision: 'continue' }, // named, most recent
    ];

    const result = findLoopControlArtifact(artifacts, 'plan-iteration');
    expect(result).not.toBeNull();
    expect(result?.decision).toBe('continue');
  });
});
