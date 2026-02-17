/**
 * Recommendation warnings tests.
 *
 * Tests for preference exceedance detection against workflow recommendations.
 * Lock: §5 "emitted when effective preferences exceed recommendation"
 */

import { describe, it, expect } from 'vitest';
import {
  checkRecommendationExceedance,
  type RecommendedPreferencesV2,
} from '../../../src/v2/durable-core/domain/recommendation-warnings.js';
import type { AutonomyV2, RiskPolicyV2 } from '../../../src/v2/durable-core/schemas/session/preferences.js';

describe('checkRecommendationExceedance', () => {
  describe('autonomy exceedance', () => {
    it('detects full_auto_never_stop > guided', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'full_auto_never_stop', riskPolicy: 'conservative' },
        { recommendedAutonomy: 'guided' },
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.kind).toBe('autonomy_exceeds_recommendation');
      if (warnings[0]!.kind === 'autonomy_exceeds_recommendation') {
        expect(warnings[0]!.effective).toBe('full_auto_never_stop');
        expect(warnings[0]!.recommended).toBe('guided');
        expect(warnings[0]!.summary).toContain('full_auto_never_stop');
        expect(warnings[0]!.summary).toContain('guided');
      }
    });

    it('detects full_auto_stop_on_user_deps > guided', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'full_auto_stop_on_user_deps', riskPolicy: 'conservative' },
        { recommendedAutonomy: 'guided' },
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.kind).toBe('autonomy_exceeds_recommendation');
    });

    it('no warning when effective == recommended', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'guided', riskPolicy: 'conservative' },
        { recommendedAutonomy: 'guided' },
      );
      expect(warnings).toHaveLength(0);
    });

    it('no warning when effective < recommended', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'guided', riskPolicy: 'conservative' },
        { recommendedAutonomy: 'full_auto_never_stop' },
      );
      expect(warnings).toHaveLength(0);
    });
  });

  describe('riskPolicy exceedance', () => {
    it('detects aggressive > conservative', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'guided', riskPolicy: 'aggressive' },
        { recommendedRiskPolicy: 'conservative' },
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.kind).toBe('risk_policy_exceeds_recommendation');
      if (warnings[0]!.kind === 'risk_policy_exceeds_recommendation') {
        expect(warnings[0]!.effective).toBe('aggressive');
        expect(warnings[0]!.recommended).toBe('conservative');
      }
    });

    it('detects balanced > conservative', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'guided', riskPolicy: 'balanced' },
        { recommendedRiskPolicy: 'conservative' },
      );
      expect(warnings).toHaveLength(1);
    });

    it('no warning when effective == recommended', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'guided', riskPolicy: 'balanced' },
        { recommendedRiskPolicy: 'balanced' },
      );
      expect(warnings).toHaveLength(0);
    });
  });

  describe('both dimensions', () => {
    it('returns warnings for both when both exceed', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'full_auto_never_stop', riskPolicy: 'aggressive' },
        { recommendedAutonomy: 'guided', recommendedRiskPolicy: 'conservative' },
      );
      expect(warnings).toHaveLength(2);
      expect(warnings.map((w) => w.kind).sort()).toEqual([
        'autonomy_exceeds_recommendation',
        'risk_policy_exceeds_recommendation',
      ]);
    });
  });

  describe('no recommendations', () => {
    it('returns empty when no recommendations declared', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'full_auto_never_stop', riskPolicy: 'aggressive' },
        {},
      );
      expect(warnings).toHaveLength(0);
    });

    it('checks only autonomy when only autonomy recommended', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'full_auto_never_stop', riskPolicy: 'aggressive' },
        { recommendedAutonomy: 'guided' },
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.kind).toBe('autonomy_exceeds_recommendation');
    });

    it('checks only riskPolicy when only riskPolicy recommended', () => {
      const warnings = checkRecommendationExceedance(
        { autonomy: 'full_auto_never_stop', riskPolicy: 'aggressive' },
        { recommendedRiskPolicy: 'conservative' },
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.kind).toBe('risk_policy_exceeds_recommendation');
    });
  });
});
