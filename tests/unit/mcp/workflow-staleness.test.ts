import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeWorkflowStaleness } from '../../../src/mcp/handlers/v2-workflow.js';

describe('computeWorkflowStaleness', () => {
  it('returns none when stamp matches current version', () => {
    const result = computeWorkflowStaleness(3, 3);
    expect(result).toEqual({
      level: 'none',
      reason: 'Workflow validated against current authoring spec (v3).',
      specVersionAtLastReview: 3,
    });
  });

  it('returns likely when stamp is older than current version', () => {
    const result = computeWorkflowStaleness(2, 3);
    expect(result).toEqual({
      level: 'likely',
      reason: 'Authoring spec updated from v2 to v3 since this workflow was last reviewed.',
      specVersionAtLastReview: 2,
    });
  });

  it('returns possible when stamp is absent', () => {
    const result = computeWorkflowStaleness(undefined, 3);
    expect(result).toEqual({
      level: 'possible',
      reason: 'This workflow has not been validated against the authoring spec via workflow-for-workflows.',
    });
    expect(result).not.toHaveProperty('specVersionAtLastReview');
  });

  it('returns undefined when current version is null (spec unreadable)', () => {
    expect(computeWorkflowStaleness(undefined, null)).toBeUndefined();
    expect(computeWorkflowStaleness(3, null)).toBeUndefined();
  });

  it('possible result has no specVersionAtLastReview field', () => {
    const result = computeWorkflowStaleness(undefined, 3);
    expect(result?.level).toBe('possible');
    expect('specVersionAtLastReview' in (result ?? {})).toBe(false);
  });
});

describe('shouldShowStaleness visibility filter', () => {
  const originalEnv = process.env['WORKRAIL_DEV_STALENESS'];

  beforeEach(() => {
    delete process.env['WORKRAIL_DEV_STALENESS'];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['WORKRAIL_DEV_STALENESS'] = originalEnv;
    } else {
      delete process.env['WORKRAIL_DEV_STALENESS'];
    }
  });

  // Note: DEV_STALENESS and shouldShowStaleness are module-level, so we test
  // the end-to-end behavior via the exported computeWorkflowStaleness with
  // known visibility categories passed through the handler. The predicate
  // logic is verified by checking which categories produce staleness output
  // in the integration-level output schema tests.
  //
  // Unit-level: verify computeWorkflowStaleness itself is category-agnostic
  // (the filter is applied at the call site in the handler, not inside the fn).
  it('computeWorkflowStaleness is category-agnostic — filtering is handler responsibility', () => {
    // The function always returns a result regardless of category
    // Category filtering happens in shouldShowStaleness at the call site
    expect(computeWorkflowStaleness(undefined, 3)?.level).toBe('possible');
    expect(computeWorkflowStaleness(2, 3)?.level).toBe('likely');
    expect(computeWorkflowStaleness(3, 3)?.level).toBe('none');
  });
});
