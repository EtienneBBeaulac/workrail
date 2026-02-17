import type { AutonomyV2, RiskPolicyV2 } from '../schemas/session/preferences.js';

/**
 * Workflow-declared preference recommendations.
 *
 * Lock: §5 "closedset recommendation targets"
 * These are optional hints from the workflow author about what preferences
 * are appropriate for this workflow. They never hard-block user choice.
 */
export interface RecommendedPreferencesV2 {
  readonly recommendedAutonomy?: AutonomyV2;
  readonly recommendedRiskPolicy?: RiskPolicyV2;
}

/**
 * Recommendation exceedance warning.
 *
 * Lock: §5 "emitted when effective preferences exceed recommendation"
 * - structured + text-first
 * - recorded durably on the node (event or artifact)
 * - never hard-block user choice
 */
export type RecommendationWarning =
  | {
      readonly kind: 'autonomy_exceeds_recommendation';
      readonly effective: AutonomyV2;
      readonly recommended: AutonomyV2;
      readonly summary: string;
    }
  | {
      readonly kind: 'risk_policy_exceeds_recommendation';
      readonly effective: RiskPolicyV2;
      readonly recommended: RiskPolicyV2;
      readonly summary: string;
    };

/**
 * Partial order for autonomy (increasing automation).
 * Lock: §4 "guided < full_auto_stop_on_user_deps < full_auto_never_stop"
 */
const AUTONOMY_ORDER: Record<AutonomyV2, number> = {
  guided: 0,
  full_auto_stop_on_user_deps: 1,
  full_auto_never_stop: 2,
};

/**
 * Partial order for risk policy (increasing risk tolerance).
 * Lock: §4 "conservative < balanced < aggressive"
 */
const RISK_POLICY_ORDER: Record<RiskPolicyV2, number> = {
  conservative: 0,
  balanced: 1,
  aggressive: 2,
};

/**
 * Check if effective preferences exceed workflow recommendations.
 *
 * Pure function. Returns warnings for each dimension where
 * effective > recommended (by the locked partial orders).
 *
 * Lock: §5 "emitted when effective preferences exceed recommendation"
 *
 * Returns empty array when:
 * - No recommendations declared (nothing to exceed)
 * - Effective <= recommended (no exceedance)
 */
export function checkRecommendationExceedance(
  effective: { readonly autonomy: AutonomyV2; readonly riskPolicy: RiskPolicyV2 },
  recommended: RecommendedPreferencesV2,
): readonly RecommendationWarning[] {
  const warnings: RecommendationWarning[] = [];

  if (
    recommended.recommendedAutonomy !== undefined &&
    AUTONOMY_ORDER[effective.autonomy] > AUTONOMY_ORDER[recommended.recommendedAutonomy]
  ) {
    warnings.push({
      kind: 'autonomy_exceeds_recommendation',
      effective: effective.autonomy,
      recommended: recommended.recommendedAutonomy,
      summary: `Effective autonomy '${effective.autonomy}' exceeds workflow recommendation '${recommended.recommendedAutonomy}'.`,
    });
  }

  if (
    recommended.recommendedRiskPolicy !== undefined &&
    RISK_POLICY_ORDER[effective.riskPolicy] > RISK_POLICY_ORDER[recommended.recommendedRiskPolicy]
  ) {
    warnings.push({
      kind: 'risk_policy_exceeds_recommendation',
      effective: effective.riskPolicy,
      recommended: recommended.recommendedRiskPolicy,
      summary: `Effective riskPolicy '${effective.riskPolicy}' exceeds workflow recommendation '${recommended.recommendedRiskPolicy}'.`,
    });
  }

  return warnings;
}
