/**
 * Unit tests for the wr.discovery_handoff artifact contract enforcement.
 *
 * Verifies:
 * - Valid artifacts parse correctly
 * - The contract is required by default
 * - Missing artifact returns MISSING_REQUIRED_ARTIFACT
 * - Invalid schema returns INVALID_ARTIFACT_SCHEMA
 * - isDiscoveryHandoffArtifact() checks kind only
 *
 * Regression: wr.discovery phase-7-handoff previously had no outputContract.
 * The contract was added in v3.6.0. This test locks in the enforcement behavior.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isDiscoveryHandoffArtifact,
  DISCOVERY_HANDOFF_CONTRACT_REF,
} from '../../src/v2/durable-core/schemas/artifacts/discovery-handoff.js';
import { validateArtifactContract } from '../../src/v2/durable-core/domain/artifact-contract-validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_MINIMAL: unknown = {
  kind: 'wr.discovery_handoff',
  version: 1,
  selectedDirection: 'Implement the feature using the existing middleware pattern',
  designDocPath: '',
  confidenceBand: 'high',
  selectionTier: 'strong_recommendation',
  keyInvariants: ['Must not break the existing auth flow'],
  rejectedDirections: [],
  implementationConstraints: ['Do not modify src/auth/'],
  keyCodebaseLocations: [{ path: 'src/middleware/auth.ts', relevance: 'Entry point for auth middleware' }],
};

const VALID_WITH_DESIGN_DOC: unknown = {
  kind: 'wr.discovery_handoff',
  version: 1,
  selectedDirection: 'Refactor the pipeline coordinator',
  designDocPath: '.workrail/discovery-2026-05-13.md',
  confidenceBand: 'medium',
  selectionTier: 'provisional_recommendation',
  keyInvariants: ['Coordinator must not call LLM for routing decisions'],
  rejectedDirections: [{ direction: 'Rewrite in Rust', reason: 'Not worth the migration cost' }],
  implementationConstraints: [],
  keyCodebaseLocations: [],
};

// ---------------------------------------------------------------------------
// isDiscoveryHandoffArtifact
// ---------------------------------------------------------------------------

describe('isDiscoveryHandoffArtifact', () => {
  it('returns true for objects with kind: wr.discovery_handoff', () => {
    expect(isDiscoveryHandoffArtifact({ kind: 'wr.discovery_handoff' })).toBe(true);
  });

  it('returns false for wrong kind', () => {
    expect(isDiscoveryHandoffArtifact({ kind: 'wr.review_verdict' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isDiscoveryHandoffArtifact(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateArtifactContract -- enforcement
// ---------------------------------------------------------------------------

describe('validateArtifactContract: wr.discovery_handoff (required by default)', () => {
  const CONTRACT = { contractRef: DISCOVERY_HANDOFF_CONTRACT_REF };

  it('returns valid: true when a valid artifact is present', () => {
    const result = validateArtifactContract([VALID_MINIMAL], CONTRACT);
    expect(result.valid).toBe(true);
  });

  it('returns MISSING_REQUIRED_ARTIFACT when artifact is absent', () => {
    const result = validateArtifactContract([], CONTRACT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe('MISSING_REQUIRED_ARTIFACT');
    expect(result.error.contractRef).toBe(DISCOVERY_HANDOFF_CONTRACT_REF);
  });

  it('returns valid: true for absent artifact when required: false', () => {
    const result = validateArtifactContract([], { contractRef: DISCOVERY_HANDOFF_CONTRACT_REF, required: false });
    expect(result.valid).toBe(true);
  });

  it('returns INVALID_ARTIFACT_SCHEMA for unknown confidenceBand', () => {
    const bad = { ...VALID_MINIMAL as object, confidenceBand: 'very_high' };
    const result = validateArtifactContract([bad], CONTRACT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe('INVALID_ARTIFACT_SCHEMA');
  });

  it('accepts artifact with optional designDocPath', () => {
    const result = validateArtifactContract([VALID_WITH_DESIGN_DOC], CONTRACT);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: wr.discovery phase-7-handoff outputContract is now present
// ---------------------------------------------------------------------------

describe('wr.discovery phase-7-handoff outputContract enforcement', () => {
  it('workflow JSON declares outputContract on phase-7-handoff (added v3.6.0)', () => {
    const workflowPath = path.resolve(__dirname, '../../workflows/wr.discovery.json');
    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));
    const finalStep = workflow.steps.find((s: any) => s.id === 'phase-7-handoff');
    expect(finalStep).toBeDefined();
    expect(finalStep.outputContract).toBeDefined();
    expect(finalStep.outputContract.contractRef).toBe(DISCOVERY_HANDOFF_CONTRACT_REF);
    expect(finalStep.outputContract.required).toBeUndefined();
  });
});
