/**
 * Artifact Contract Validation Tests
 * 
 * Tests for validating artifacts against output contracts.
 * 
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 */

import { describe, it, expect } from 'vitest';
import {
  validateArtifactContract,
  requiresArtifactValidation,
  formatArtifactValidationError,
  extractValidatedArtifact,
  type ArtifactContractValidationError,
} from '../../../src/v2/durable-core/domain/artifact-contract-validator.js';
import { LOOP_CONTROL_CONTRACT_REF } from '../../../src/v2/durable-core/schemas/artifacts/index.js';

describe('validateArtifactContract', () => {
  describe('loop control contract', () => {
    it('validates valid loop control artifact', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'continue' },
      ];

      const result = validateArtifactContract(artifacts, {
        contractRef: LOOP_CONTROL_CONTRACT_REF,
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.artifact).toEqual({
          kind: 'wr.loop_control',
          loopId: 'test-loop',
          decision: 'continue',
        });
      }
    });

    it('validates artifact with metadata', () => {
      const artifacts = [
        {
          kind: 'wr.loop_control',
          loopId: 'test-loop',
          decision: 'stop',
          metadata: { reason: 'Clean pass' },
        },
      ];

      const result = validateArtifactContract(artifacts, {
        contractRef: LOOP_CONTROL_CONTRACT_REF,
      });

      expect(result.valid).toBe(true);
    });

    it('returns MISSING_REQUIRED_ARTIFACT when no artifact present', () => {
      const artifacts: unknown[] = [];

      const result = validateArtifactContract(artifacts, {
        contractRef: LOOP_CONTROL_CONTRACT_REF,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe('MISSING_REQUIRED_ARTIFACT');
        expect(result.error.contractRef).toBe(LOOP_CONTROL_CONTRACT_REF);
        expect(result.error.message).toContain('Required artifact missing');
      }
    });

    it('returns MISSING_REQUIRED_ARTIFACT when only non-loop-control artifacts', () => {
      const artifacts = [
        { kind: 'other_artifact', data: 'value' },
      ];

      const result = validateArtifactContract(artifacts, {
        contractRef: LOOP_CONTROL_CONTRACT_REF,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe('MISSING_REQUIRED_ARTIFACT');
      }
    });

    it('returns INVALID_ARTIFACT_SCHEMA for malformed artifact', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'INVALID-CAPS', decision: 'continue' },
      ];

      const result = validateArtifactContract(artifacts, {
        contractRef: LOOP_CONTROL_CONTRACT_REF,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe('INVALID_ARTIFACT_SCHEMA');
        expect(result.error.message).toContain('schema validation failed');
      }
    });

    it('returns INVALID_ARTIFACT_SCHEMA for invalid decision', () => {
      const artifacts = [
        { kind: 'wr.loop_control', loopId: 'test-loop', decision: 'maybe' },
      ];

      const result = validateArtifactContract(artifacts, {
        contractRef: LOOP_CONTROL_CONTRACT_REF,
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe('INVALID_ARTIFACT_SCHEMA');
      }
    });

    it('allows missing artifact when required=false', () => {
      const artifacts: unknown[] = [];

      const result = validateArtifactContract(artifacts, {
        contractRef: LOOP_CONTROL_CONTRACT_REF,
        required: false,
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.artifact).toBeNull();
      }
    });

    it('validates first matching artifact when multiple present', () => {
      const artifacts = [
        { kind: 'other_artifact' },
        { kind: 'wr.loop_control', loopId: 'first', decision: 'continue' },
        { kind: 'wr.loop_control', loopId: 'second', decision: 'stop' },
      ];

      const result = validateArtifactContract(artifacts, {
        contractRef: LOOP_CONTROL_CONTRACT_REF,
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        const artifact = result.artifact as { loopId: string };
        expect(artifact.loopId).toBe('first');
      }
    });
  });

  describe('unknown contract', () => {
    it('returns UNKNOWN_CONTRACT_REF for unknown contract', () => {
      const artifacts = [{ kind: 'some_artifact' }];

      const result = validateArtifactContract(artifacts, {
        contractRef: 'wr.contracts.unknown',
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe('UNKNOWN_CONTRACT_REF');
        expect(result.error.contractRef).toBe('wr.contracts.unknown');
      }
    });
  });
});

describe('requiresArtifactValidation', () => {
  it('returns false for undefined contract', () => {
    expect(requiresArtifactValidation(undefined)).toBe(false);
  });

  it('returns true for contract without required field', () => {
    expect(requiresArtifactValidation({
      contractRef: LOOP_CONTROL_CONTRACT_REF,
    })).toBe(true);
  });

  it('returns true for contract with required=true', () => {
    expect(requiresArtifactValidation({
      contractRef: LOOP_CONTROL_CONTRACT_REF,
      required: true,
    })).toBe(true);
  });

  it('returns false for contract with required=false', () => {
    expect(requiresArtifactValidation({
      contractRef: LOOP_CONTROL_CONTRACT_REF,
      required: false,
    })).toBe(false);
  });
});

describe('formatArtifactValidationError', () => {
  it('formats MISSING_REQUIRED_ARTIFACT error', () => {
    const error: ArtifactContractValidationError = {
      code: 'MISSING_REQUIRED_ARTIFACT',
      contractRef: LOOP_CONTROL_CONTRACT_REF,
      message: 'Required artifact missing',
    };

    const formatted = formatArtifactValidationError(error);
    expect(formatted.code).toBe('MISSING_REQUIRED_OUTPUT');
    expect(formatted.suggestedFix).toContain('Provide an artifact');
  });

  it('formats INVALID_ARTIFACT_SCHEMA error', () => {
    const error: ArtifactContractValidationError = {
      code: 'INVALID_ARTIFACT_SCHEMA',
      contractRef: LOOP_CONTROL_CONTRACT_REF,
      message: 'Schema validation failed',
      issues: ['loopId: must be lowercase', 'decision: invalid enum value'],
    };

    const formatted = formatArtifactValidationError(error);
    expect(formatted.code).toBe('INVALID_REQUIRED_OUTPUT');
    expect(formatted.message).toContain('loopId: must be lowercase');
    expect(formatted.message).toContain('decision: invalid enum value');
    expect(formatted.suggestedFix).toContain('Fix the artifact');
  });

  it('formats UNKNOWN_CONTRACT_REF error', () => {
    const error: ArtifactContractValidationError = {
      code: 'UNKNOWN_CONTRACT_REF',
      contractRef: 'wr.contracts.unknown',
      message: 'Unknown contract',
    };

    const formatted = formatArtifactValidationError(error);
    expect(formatted.code).toBe('INVARIANT_VIOLATION');
  });
});

describe('extractValidatedArtifact', () => {
  it('returns ok with artifact on success', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'test', decision: 'continue' },
    ];

    const result = extractValidatedArtifact(artifacts, {
      contractRef: LOOP_CONTROL_CONTRACT_REF,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const artifact = result.value as { loopId: string };
      expect(artifact.loopId).toBe('test');
    }
  });

  it('returns err with error on failure', () => {
    const artifacts: unknown[] = [];

    const result = extractValidatedArtifact(artifacts, {
      contractRef: LOOP_CONTROL_CONTRACT_REF,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('MISSING_REQUIRED_ARTIFACT');
    }
  });
});
