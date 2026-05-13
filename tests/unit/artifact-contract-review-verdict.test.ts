/**
 * Unit tests for the wr.review_verdict artifact contract enforcement.
 *
 * Verifies:
 * - Valid artifacts for all three verdict values parse correctly
 * - The contract is required by default (required: true is the default in validateArtifactContract)
 * - Missing artifact returns MISSING_REQUIRED_ARTIFACT (not valid: true)
 * - Invalid schema returns INVALID_ARTIFACT_SCHEMA
 * - Extra fields are rejected by .strict()
 * - isReviewVerdictArtifact() checks kind only
 * - parseReviewVerdictArtifact() does full schema validation
 *
 * WHY this test exists: the wr.mr-review workflow's phase-6-final-handoff step previously
 * declared outputContract.required: false, making the typed verdict path dead code in
 * production. That flag was removed -- the contract is now required. This test locks in
 * the enforcement behavior so a regression (re-adding required: false) fails CI.
 */

import { describe, it, expect } from 'vitest';
import {
  isReviewVerdictArtifact,
  parseReviewVerdictArtifact,
  REVIEW_VERDICT_CONTRACT_REF,
} from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';
import { validateArtifactContract } from '../../src/v2/durable-core/domain/artifact-contract-validator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_CLEAN: unknown = {
  kind: 'wr.review_verdict',
  verdict: 'clean',
  confidence: 'high',
  findings: [],
  summary: 'No issues found',
};

const VALID_MINOR: unknown = {
  kind: 'wr.review_verdict',
  verdict: 'minor',
  confidence: 'medium',
  findings: [
    { severity: 'minor', summary: 'Missing test coverage', findingCategory: 'testing' },
    { severity: 'nit', summary: 'Inconsistent naming' },
  ],
  summary: 'Small issues only',
};

const VALID_BLOCKING: unknown = {
  kind: 'wr.review_verdict',
  verdict: 'blocking',
  confidence: 'high',
  findings: [
    { severity: 'critical', summary: 'SQL injection risk', findingCategory: 'security' },
    { severity: 'major', summary: 'Broken invariant', findingCategory: 'architecture' },
  ],
  summary: 'Critical security finding blocks merge',
};

// ---------------------------------------------------------------------------
// isReviewVerdictArtifact
// ---------------------------------------------------------------------------

describe('isReviewVerdictArtifact', () => {
  it('returns true for objects with kind: wr.review_verdict', () => {
    expect(isReviewVerdictArtifact({ kind: 'wr.review_verdict' })).toBe(true);
  });

  it('returns false for wrong kind', () => {
    expect(isReviewVerdictArtifact({ kind: 'wr.discovery_handoff' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isReviewVerdictArtifact(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isReviewVerdictArtifact('wr.review_verdict')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseReviewVerdictArtifact
// ---------------------------------------------------------------------------

describe('parseReviewVerdictArtifact', () => {
  it('parses a clean verdict', () => {
    const result = parseReviewVerdictArtifact(VALID_CLEAN);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('clean');
    expect(result!.findings).toHaveLength(0);
  });

  it('parses a minor verdict with findings', () => {
    const result = parseReviewVerdictArtifact(VALID_MINOR);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('minor');
    expect(result!.findings).toHaveLength(2);
    expect(result!.findings[0]!.findingCategory).toBe('testing');
  });

  it('parses a blocking verdict with findingCategory', () => {
    const result = parseReviewVerdictArtifact(VALID_BLOCKING);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('blocking');
    expect(result!.findings[0]!.findingCategory).toBe('security');
    expect(result!.findings[1]!.findingCategory).toBe('architecture');
  });

  it('returns null for extra fields (strict schema)', () => {
    const withExtra = { ...VALID_CLEAN as object, unexpectedField: 'value' };
    expect(parseReviewVerdictArtifact(withExtra)).toBeNull();
  });

  it('returns null for invalid verdict value', () => {
    const bad = { ...VALID_CLEAN as object, verdict: 'approved' };
    expect(parseReviewVerdictArtifact(bad)).toBeNull();
  });

  it('returns null for missing required fields', () => {
    expect(parseReviewVerdictArtifact({ kind: 'wr.review_verdict' })).toBeNull();
  });

  it('findingCategory is optional -- finding without it parses correctly', () => {
    const noCategory = {
      kind: 'wr.review_verdict',
      verdict: 'minor',
      confidence: 'low',
      findings: [{ severity: 'nit', summary: 'Minor naming issue' }],
      summary: 'Nit only',
    };
    const result = parseReviewVerdictArtifact(noCategory);
    expect(result).not.toBeNull();
    expect(result!.findings[0]!.findingCategory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateArtifactContract -- enforcement tests
// ---------------------------------------------------------------------------

describe('validateArtifactContract: wr.review_verdict (required by default)', () => {
  const CONTRACT = { contractRef: REVIEW_VERDICT_CONTRACT_REF };

  it('returns valid: true when a valid artifact is present', () => {
    const result = validateArtifactContract([VALID_CLEAN], CONTRACT);
    expect(result.valid).toBe(true);
  });

  it('returns MISSING_REQUIRED_ARTIFACT when artifact is absent (required by default)', () => {
    const result = validateArtifactContract([], CONTRACT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe('MISSING_REQUIRED_ARTIFACT');
    expect(result.error.contractRef).toBe(REVIEW_VERDICT_CONTRACT_REF);
  });

  it('returns valid: true for absent artifact when required: false', () => {
    const result = validateArtifactContract([], { contractRef: REVIEW_VERDICT_CONTRACT_REF, required: false });
    expect(result.valid).toBe(true);
  });

  it('returns INVALID_ARTIFACT_SCHEMA when artifact has wrong schema', () => {
    const bad = { kind: 'wr.review_verdict', verdict: 'not-a-valid-verdict' };
    const result = validateArtifactContract([bad], CONTRACT);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.error.code).toBe('INVALID_ARTIFACT_SCHEMA');
  });

  it('picks the first matching artifact when multiple are present', () => {
    const result = validateArtifactContract([VALID_CLEAN, VALID_BLOCKING], CONTRACT);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const artifact = result.artifact as typeof VALID_CLEAN;
    expect((artifact as any).verdict).toBe('clean');
  });

  it('ignores non-verdict artifacts in the array', () => {
    const otherArtifact = { kind: 'wr.discovery_handoff', selectedDirection: 'A' };
    const result = validateArtifactContract([otherArtifact, VALID_MINOR], CONTRACT);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect((result.artifact as any).verdict).toBe('minor');
  });
});

// ---------------------------------------------------------------------------
// Regression: mr-review-workflow phase-6 outputContract is now required
// ---------------------------------------------------------------------------

describe('wr.mr-review phase-6 outputContract enforcement', () => {
  it('workflow JSON declares outputContract without required: false on phase-6-final-handoff', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const workflowPath = path.resolve(__dirname, '../../workflows/mr-review-workflow.agentic.v2.json');
    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));
    const finalStep = workflow.steps.find((s: any) => s.id === 'phase-6-final-handoff');
    expect(finalStep).toBeDefined();
    expect(finalStep.outputContract).toBeDefined();
    expect(finalStep.outputContract.contractRef).toBe(REVIEW_VERDICT_CONTRACT_REF);
    // required: false must NOT be present -- absence means required: true (the default)
    expect(finalStep.outputContract.required).toBeUndefined();
  });
});
