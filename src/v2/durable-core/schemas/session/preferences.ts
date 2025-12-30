import { z } from 'zod';

/**
 * Closed set: Autonomy (execution mode preference).
 *
 * Lock: docs/design/v2-core-design-locks.md Section 4
 * Lock: docs/reference/workflow-execution-contract.md (Preferences & modes)
 *
 * Why closed:
 * - Ensures deterministic orchestration behavior
 * - Prevents “mode drift” (no ad-hoc automation levels)
 *
 * Values:
 * - `guided`: agent waits for user input (asks/confirmations)
 * - `full_auto_stop_on_user_deps`: auto except when user-only dependency hit
 * - `full_auto_never_stop`: never blocks; must disclose and proceed explicitly
 *
 * Partial order (increasing automation):
 * guided < full_auto_stop_on_user_deps < full_auto_never_stop
 */
export type AutonomyV2 = 'guided' | 'full_auto_stop_on_user_deps' | 'full_auto_never_stop';

/**
 * Closed set: RiskPolicy (workflow recommendation guardrails).
 *
 * Lock: docs/design/v2-core-design-locks.md Section 4
 *
 * Why closed:
 * - Deterministic warning thresholds and default selection behavior
 * - Prevents policy drift that would alter execution semantics
 *
 * Values:
 * - `conservative`: strict warnings, prefer safe defaults
 * - `balanced`: moderate warnings, balanced selection
 * - `aggressive`: minimal warnings, optimize for speed
 *
 * Partial order (increasing risk tolerance):
 * conservative < balanced < aggressive
 */
export type RiskPolicyV2 = 'conservative' | 'balanced' | 'aggressive';

export const AutonomyV2Schema = z.enum(['guided', 'full_auto_stop_on_user_deps', 'full_auto_never_stop']);
export const RiskPolicyV2Schema = z.enum(['conservative', 'balanced', 'aggressive']);
