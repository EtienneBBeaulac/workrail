import { describe, it, expect } from 'vitest';
import { computeWorkflowStaleness, shouldShowStaleness } from '../../../src/mcp/handlers/v2-workflow.js';

describe('computeWorkflowStaleness', () => {
  it('returns none when stamp matches current version', () => {
    expect(computeWorkflowStaleness(3, 3)).toEqual({
      level: 'none',
      reason: 'Workflow validated against current authoring spec (v3).',
      specVersionAtLastReview: 3,
    });
  });

  it('returns likely when stamp is older', () => {
    expect(computeWorkflowStaleness(2, 3)).toEqual({
      level: 'likely',
      reason: 'Authoring spec updated from v2 to v3 since this workflow was last reviewed.',
      specVersionAtLastReview: 2,
    });
  });

  it('returns possible when no stamp', () => {
    const result = computeWorkflowStaleness(undefined, 3);
    expect(result?.level).toBe('possible');
    expect('specVersionAtLastReview' in (result ?? {})).toBe(false);
  });

  it('returns undefined when spec unreadable', () => {
    expect(computeWorkflowStaleness(undefined, null)).toBeUndefined();
    expect(computeWorkflowStaleness(3, null)).toBeUndefined();
  });
});

describe('shouldShowStaleness', () => {
  describe('default mode (devMode=false)', () => {
    it('shows for user-owned categories', () => {
      expect(shouldShowStaleness('personal', false)).toBe(true);
      expect(shouldShowStaleness('rooted_sharing', false)).toBe(true);
      expect(shouldShowStaleness('external', false)).toBe(true);
    });

    it('hides for built_in and legacy_project', () => {
      expect(shouldShowStaleness('built_in', false)).toBe(false);
      expect(shouldShowStaleness('legacy_project', false)).toBe(false);
    });

    it('hides when category is undefined', () => {
      expect(shouldShowStaleness(undefined, false)).toBe(false);
    });
  });

  describe('dev mode (devMode=true)', () => {
    it('shows for all categories including built_in and legacy_project', () => {
      expect(shouldShowStaleness('built_in', true)).toBe(true);
      expect(shouldShowStaleness('legacy_project', true)).toBe(true);
      expect(shouldShowStaleness('personal', true)).toBe(true);
      expect(shouldShowStaleness(undefined, true)).toBe(true);
    });
  });
});
