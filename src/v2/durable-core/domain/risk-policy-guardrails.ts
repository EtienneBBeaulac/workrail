import type { RiskPolicyV2 } from '../schemas/session/preferences.js';
import type { ReasonV1 } from './reason-model.js';

/**
 * Risk policy guardrail outcome for a single reason.
 *
 * Lock: §4 riskPolicy guardrails
 * - allowed: warning thresholds + default selection between correct paths
 * - disallowed: bypassing contracts/capabilities enforcement, changing fork/token semantics,
 *   suppressing disclosure, redefining user-only deps
 *
 * Why a discriminated union (not boolean):
 * - Makes "what happened" explicit for observability
 * - Enables downstream code to distinguish "downgraded" from "unchanged" (Studio badges, gaps)
 * - Exhaustive handling prevents silent drift
 */
export type GuardrailOutcome =
  | { readonly disposition: 'block'; readonly reason: ReasonV1 }
  | { readonly disposition: 'downgrade_to_warning'; readonly reason: ReasonV1; readonly rationale: string };

/**
 * Reason categories that are NEVER downgradable regardless of risk policy.
 *
 * Lock: §4 "disallowed: bypassing contracts/capabilities, … redefining user-only deps"
 *
 * These form the invariant boundary — no risk policy can weaken these.
 */
function isNeverDowngradable(reason: ReasonV1): boolean {
  switch (reason.kind) {
    // Contract violations: lock says "disallowed: bypassing contracts"
    case 'missing_required_output':
    case 'invalid_required_output':
    case 'missing_notes':
      return true;
    // User-only deps: lock says "disallowed: redefining user-only deps"
    case 'user_only_dependency':
      return true;
    // System invariants: always fatal
    case 'invariant_violation':
    case 'storage_corruption_detected':
    case 'evaluation_error':
      return true;
    // Context issues: system invariants (not policy-adjustable)
    case 'missing_context_key':
    case 'context_budget_exceeded':
      return true;
    // Capability issues: policy-adjustable (see below)
    case 'required_capability_unknown':
    case 'required_capability_unavailable':
      return false;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * Apply risk policy guardrails to a single blocking reason.
 *
 * Pure function. Table-driven by policy × reason category.
 *
 * Lock: §4 riskPolicy guardrails
 * - conservative: all reasons remain as blocking
 * - balanced: capability_unknown → downgrade to warning; capability_unavailable remains blocking
 * - aggressive: all capability_missing → downgrade to warning
 *
 * Never downgradable (invariant, all policies):
 * - contract_violation (missing_required_output, invalid_required_output)
 * - user_only_dependency
 * - unexpected (invariant_violation, storage_corruption_detected, evaluation_error)
 * - context issues (missing_context_key, context_budget_exceeded)
 */
export function applyGuardrail(policy: RiskPolicyV2, reason: ReasonV1): GuardrailOutcome {
  // Invariant boundary: these never change regardless of policy
  if (isNeverDowngradable(reason)) {
    return { disposition: 'block', reason };
  }

  // Policy-adjustable reasons (only capability_missing category reaches here)
  switch (policy) {
    case 'conservative':
      // Conservative: everything blocks
      return { disposition: 'block', reason };

    case 'balanced':
      // Balanced: unknown capability → warning (give agent a chance); unavailable still blocks
      if (reason.kind === 'required_capability_unknown') {
        return {
          disposition: 'downgrade_to_warning',
          reason,
          rationale: `riskPolicy=balanced: capability '${reason.capability}' status unknown — proceeding with warning`,
        };
      }
      return { disposition: 'block', reason };

    case 'aggressive':
      // Aggressive: all capability issues → warning
      // Type narrowing: only capability reasons reach here (isNeverDowngradable filters the rest)
      if (reason.kind === 'required_capability_unknown' || reason.kind === 'required_capability_unavailable') {
        return {
          disposition: 'downgrade_to_warning',
          reason,
          rationale: `riskPolicy=aggressive: capability '${reason.capability}' issue downgraded to warning`,
        };
      }
      // Unreachable: all non-capability reasons are never-downgradable.
      // Defensive return for type-safety (should not happen).
      return { disposition: 'block', reason };

    default: {
      const _exhaustive: never = policy;
      return _exhaustive;
    }
  }
}

/**
 * Apply risk policy guardrails to all blocking reasons.
 *
 * Returns partitioned results: reasons that still block, and reasons downgraded to warnings.
 * Deterministic ordering: preserves input order within each partition.
 *
 * This is the composition point: detectBlockingReasonsV1 → applyGuardrails → shouldBlock.
 */
export function applyGuardrails(
  policy: RiskPolicyV2,
  reasons: readonly ReasonV1[],
): {
  readonly blocking: readonly ReasonV1[];
  readonly downgraded: readonly GuardrailOutcome[];
} {
  const blocking: ReasonV1[] = [];
  const downgraded: GuardrailOutcome[] = [];

  for (const reason of reasons) {
    const outcome = applyGuardrail(policy, reason);
    switch (outcome.disposition) {
      case 'block':
        blocking.push(outcome.reason);
        break;
      case 'downgrade_to_warning':
        downgraded.push(outcome);
        break;
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  }

  return { blocking, downgraded };
}
