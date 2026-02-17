/**
 * Risk policy guardrails tests.
 *
 * Table-driven: each policy × each reason category → expected disposition.
 * Lock: §4 riskPolicy guardrails
 */

import { describe, it, expect } from 'vitest';
import {
  applyGuardrail,
  applyGuardrails,
  type GuardrailOutcome,
} from '../../../src/v2/durable-core/domain/risk-policy-guardrails.js';
import type { RiskPolicyV2 } from '../../../src/v2/durable-core/schemas/session/preferences.js';
import type { ReasonV1 } from '../../../src/v2/durable-core/domain/reason-model.js';

// -- Test fixtures (every reason kind) --

const NEVER_DOWNGRADABLE_REASONS: readonly ReasonV1[] = [
  { kind: 'missing_required_output', contractRef: 'wr.contracts.loop_control' },
  { kind: 'invalid_required_output', contractRef: 'wr.contracts.loop_control' },
  { kind: 'user_only_dependency', detail: 'needs_user_approval', stepId: 'step-1' },
  { kind: 'invariant_violation' },
  { kind: 'storage_corruption_detected' },
  { kind: 'evaluation_error' },
  { kind: 'missing_context_key', key: 'ticket-id' },
  { kind: 'context_budget_exceeded' },
];

const CAPABILITY_REASONS: readonly ReasonV1[] = [
  { kind: 'required_capability_unknown', capability: 'delegation' },
  { kind: 'required_capability_unavailable', capability: 'web_browsing' },
];

const ALL_POLICIES: readonly RiskPolicyV2[] = ['conservative', 'balanced', 'aggressive'];

describe('applyGuardrail (single reason)', () => {
  describe('never-downgradable reasons block under ALL policies', () => {
    for (const reason of NEVER_DOWNGRADABLE_REASONS) {
      for (const policy of ALL_POLICIES) {
        it(`${reason.kind} blocks under ${policy}`, () => {
          const outcome = applyGuardrail(policy, reason);
          expect(outcome.disposition).toBe('block');
          expect(outcome.reason).toBe(reason);
        });
      }
    }
  });

  describe('conservative: everything blocks', () => {
    for (const reason of CAPABILITY_REASONS) {
      it(`${reason.kind} blocks under conservative`, () => {
        const outcome = applyGuardrail('conservative', reason);
        expect(outcome.disposition).toBe('block');
      });
    }
  });

  describe('balanced: capability_unknown → warning, unavailable → block', () => {
    it('required_capability_unknown → downgrade_to_warning', () => {
      const reason: ReasonV1 = { kind: 'required_capability_unknown', capability: 'delegation' };
      const outcome = applyGuardrail('balanced', reason);
      expect(outcome.disposition).toBe('downgrade_to_warning');
      if (outcome.disposition === 'downgrade_to_warning') {
        expect(outcome.rationale).toContain('balanced');
        expect(outcome.rationale).toContain('delegation');
      }
    });

    it('required_capability_unavailable → block', () => {
      const reason: ReasonV1 = { kind: 'required_capability_unavailable', capability: 'web_browsing' };
      const outcome = applyGuardrail('balanced', reason);
      expect(outcome.disposition).toBe('block');
    });
  });

  describe('aggressive: all capability issues → warning', () => {
    for (const reason of CAPABILITY_REASONS) {
      it(`${reason.kind} → downgrade_to_warning under aggressive`, () => {
        const outcome = applyGuardrail('aggressive', reason);
        expect(outcome.disposition).toBe('downgrade_to_warning');
        if (outcome.disposition === 'downgrade_to_warning') {
          expect(outcome.rationale).toContain('aggressive');
        }
      });
    }
  });
});

describe('applyGuardrails (batch)', () => {
  it('partitions reasons into blocking and downgraded', () => {
    const reasons: readonly ReasonV1[] = [
      { kind: 'missing_required_output', contractRef: 'wr.contracts.loop_control' },
      { kind: 'required_capability_unknown', capability: 'delegation' },
      { kind: 'required_capability_unavailable', capability: 'web_browsing' },
    ];

    const result = applyGuardrails('aggressive', reasons);

    // Contract violation always blocks (even under aggressive)
    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]!.kind).toBe('missing_required_output');

    // Both capability reasons downgraded under aggressive
    expect(result.downgraded).toHaveLength(2);
    expect(result.downgraded.every((d) => d.disposition === 'downgrade_to_warning')).toBe(true);
  });

  it('preserves input order within partitions', () => {
    const reasons: readonly ReasonV1[] = [
      { kind: 'required_capability_unknown', capability: 'delegation' },
      { kind: 'invariant_violation' },
      { kind: 'required_capability_unavailable', capability: 'web_browsing' },
    ];

    const result = applyGuardrails('aggressive', reasons);

    // invariant_violation blocks
    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]!.kind).toBe('invariant_violation');

    // capability reasons downgraded, in original order
    expect(result.downgraded).toHaveLength(2);
    expect(result.downgraded[0]!.reason.kind).toBe('required_capability_unknown');
    expect(result.downgraded[1]!.reason.kind).toBe('required_capability_unavailable');
  });

  it('returns empty partitions when no reasons', () => {
    const result = applyGuardrails('aggressive', []);
    expect(result.blocking).toHaveLength(0);
    expect(result.downgraded).toHaveLength(0);
  });

  it('conservative: all reasons stay blocking', () => {
    const reasons: readonly ReasonV1[] = [
      { kind: 'required_capability_unknown', capability: 'delegation' },
      { kind: 'required_capability_unavailable', capability: 'web_browsing' },
    ];

    const result = applyGuardrails('conservative', reasons);
    expect(result.blocking).toHaveLength(2);
    expect(result.downgraded).toHaveLength(0);
  });
});
