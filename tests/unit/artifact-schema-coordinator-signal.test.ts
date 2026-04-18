/**
 * Unit tests for the wr.coordinator_signal artifact schema.
 *
 * Verifies:
 * - Valid artifacts for all 5 signal kinds parse correctly
 * - Required fields (signalKind, payload) are enforced
 * - Extra fields are rejected by .strict()
 * - isCoordinatorSignalArtifact() checks kind only
 * - parseCoordinatorSignalArtifact() does full schema validation
 * - validateArtifactContract() happy-path returns valid: true
 * - validateArtifactContract() missing required artifact returns MISSING_REQUIRED_ARTIFACT
 *
 * WHY no mocks: these are pure function tests -- Zod schemas and the validator
 * are deterministic functions with no I/O or external dependencies.
 */

import { describe, it, expect } from 'vitest';
import {
  isCoordinatorSignalArtifact,
  parseCoordinatorSignalArtifact,
  COORDINATOR_SIGNAL_CONTRACT_REF,
} from '../../src/v2/durable-core/schemas/artifacts/coordinator-signal.js';
import { validateArtifactContract } from '../../src/v2/durable-core/domain/artifact-contract-validator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PROGRESS = {
  kind: 'wr.coordinator_signal',
  signalKind: 'progress',
  payload: {},
} as const;

const VALID_FINDING = {
  kind: 'wr.coordinator_signal',
  signalKind: 'finding',
  payload: { summary: 'Found 3 critical issues in module A' },
} as const;

const VALID_DATA_NEEDED = {
  kind: 'wr.coordinator_signal',
  signalKind: 'data_needed',
  payload: { request: 'Need full diff of PR #456' },
} as const;

const VALID_APPROVAL_NEEDED = {
  kind: 'wr.coordinator_signal',
  signalKind: 'approval_needed',
  payload: { action: 'delete production table users_v1' },
} as const;

const VALID_BLOCKED = {
  kind: 'wr.coordinator_signal',
  signalKind: 'blocked',
  payload: { reason: 'Cannot access external API -- credentials not in context' },
} as const;

const VALID_WITH_SESSION_ID = {
  kind: 'wr.coordinator_signal',
  signalKind: 'progress',
  payload: {},
  sessionId: 'abc-123-session',
} as const;

// ---------------------------------------------------------------------------
// Tests: isCoordinatorSignalArtifact()
// ---------------------------------------------------------------------------

describe('isCoordinatorSignalArtifact()', () => {
  it('returns true for artifact with kind wr.coordinator_signal', () => {
    expect(isCoordinatorSignalArtifact(VALID_PROGRESS)).toBe(true);
  });

  it('returns false for artifact with a different kind', () => {
    expect(isCoordinatorSignalArtifact({ kind: 'wr.loop_control', decision: 'stop' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isCoordinatorSignalArtifact(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isCoordinatorSignalArtifact('wr.coordinator_signal')).toBe(false);
  });

  it('returns false for object with no kind field', () => {
    expect(isCoordinatorSignalArtifact({ signalKind: 'progress', payload: {} })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: parseCoordinatorSignalArtifact() -- valid inputs
// ---------------------------------------------------------------------------

describe('parseCoordinatorSignalArtifact() -- valid inputs', () => {
  it('TC1: parses progress signal with empty payload', () => {
    const result = parseCoordinatorSignalArtifact(VALID_PROGRESS);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('wr.coordinator_signal');
    expect(result?.signalKind).toBe('progress');
    expect(result?.payload).toEqual({});
  });

  it('TC2: parses finding signal with non-empty payload', () => {
    const result = parseCoordinatorSignalArtifact(VALID_FINDING);
    expect(result).not.toBeNull();
    expect(result?.signalKind).toBe('finding');
    expect(result?.payload).toEqual({ summary: 'Found 3 critical issues in module A' });
  });

  it('TC3: parses data_needed signal', () => {
    const result = parseCoordinatorSignalArtifact(VALID_DATA_NEEDED);
    expect(result).not.toBeNull();
    expect(result?.signalKind).toBe('data_needed');
  });

  it('TC4: parses approval_needed signal', () => {
    const result = parseCoordinatorSignalArtifact(VALID_APPROVAL_NEEDED);
    expect(result).not.toBeNull();
    expect(result?.signalKind).toBe('approval_needed');
  });

  it('TC5: parses blocked signal', () => {
    const result = parseCoordinatorSignalArtifact(VALID_BLOCKED);
    expect(result).not.toBeNull();
    expect(result?.signalKind).toBe('blocked');
  });

  it('TC6: parses artifact with optional sessionId', () => {
    const result = parseCoordinatorSignalArtifact(VALID_WITH_SESSION_ID);
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe('abc-123-session');
  });

  it('TC7: parses artifact without optional sessionId (undefined)', () => {
    const result = parseCoordinatorSignalArtifact(VALID_PROGRESS);
    expect(result).not.toBeNull();
    expect(result?.sessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: parseCoordinatorSignalArtifact() -- invalid inputs
// ---------------------------------------------------------------------------

describe('parseCoordinatorSignalArtifact() -- invalid inputs', () => {
  it('TC8: returns null when signalKind is missing', () => {
    const result = parseCoordinatorSignalArtifact({
      kind: 'wr.coordinator_signal',
      payload: {},
    });
    expect(result).toBeNull();
  });

  it('TC9: returns null when signalKind is an unknown value', () => {
    const result = parseCoordinatorSignalArtifact({
      kind: 'wr.coordinator_signal',
      signalKind: 'unknown_kind',
      payload: {},
    });
    expect(result).toBeNull();
  });

  it('TC10: returns null when payload is missing (required field)', () => {
    const result = parseCoordinatorSignalArtifact({
      kind: 'wr.coordinator_signal',
      signalKind: 'progress',
    });
    expect(result).toBeNull();
  });

  it('TC11: returns null when extra field is present (.strict() enforcement)', () => {
    const result = parseCoordinatorSignalArtifact({
      kind: 'wr.coordinator_signal',
      signalKind: 'progress',
      payload: {},
      unknownExtraField: 'should be rejected',
    });
    expect(result).toBeNull();
  });

  it('TC12: returns null for null input', () => {
    expect(parseCoordinatorSignalArtifact(null)).toBeNull();
  });

  it('TC13: returns null for non-object input', () => {
    expect(parseCoordinatorSignalArtifact('not an artifact')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: validateArtifactContract()
// ---------------------------------------------------------------------------

describe('validateArtifactContract() with wr.contracts.coordinator_signal', () => {
  it('TC9-happy: valid artifact returns valid: true with parsed artifact', () => {
    const result = validateArtifactContract(
      [VALID_PROGRESS],
      { contractRef: COORDINATOR_SIGNAL_CONTRACT_REF },
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect((result.artifact as { kind: string }).kind).toBe('wr.coordinator_signal');
    }
  });

  it('TC9-finding: valid finding artifact with payload returns valid: true', () => {
    const result = validateArtifactContract(
      [VALID_FINDING],
      { contractRef: COORDINATOR_SIGNAL_CONTRACT_REF },
    );
    expect(result.valid).toBe(true);
  });

  it('TC10-missing: empty artifacts with required:true returns MISSING_REQUIRED_ARTIFACT', () => {
    const result = validateArtifactContract(
      [],
      { contractRef: COORDINATOR_SIGNAL_CONTRACT_REF, required: true },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('MISSING_REQUIRED_ARTIFACT');
      expect(result.error.contractRef).toBe(COORDINATOR_SIGNAL_CONTRACT_REF);
    }
  });

  it('TC10-optional: empty artifacts with required:false returns valid: true', () => {
    const result = validateArtifactContract(
      [],
      { contractRef: COORDINATOR_SIGNAL_CONTRACT_REF, required: false },
    );
    expect(result.valid).toBe(true);
  });

  it('TC11-invalid-schema: artifact with extra field returns INVALID_ARTIFACT_SCHEMA', () => {
    const result = validateArtifactContract(
      [{ kind: 'wr.coordinator_signal', signalKind: 'progress', payload: {}, extra: 'field' }],
      { contractRef: COORDINATOR_SIGNAL_CONTRACT_REF },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('INVALID_ARTIFACT_SCHEMA');
    }
  });

  it('TC12-unknown-ref: unknown contract ref returns UNKNOWN_CONTRACT_REF', () => {
    const result = validateArtifactContract(
      [VALID_PROGRESS],
      { contractRef: 'wr.contracts.nonexistent' as never },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.code).toBe('UNKNOWN_CONTRACT_REF');
    }
  });
});
