import { describe, expect, it } from 'vitest';
import { DomainEventV1Schema } from '../../../src/v2/durable-core/schemas/session/index.js';
import { buildGapRecordedEventV1 } from '../../../src/v2/durable-core/domain/gap-builder.js';
import {
  blockerSortKey,
  buildBlockerReport,
  reasonToBlocker,
  reasonToGap,
  type ReasonV1,
} from '../../../src/v2/durable-core/domain/reason-model.js';

describe('reason-model (table-driven mapping)', () => {
  const cases: ReadonlyArray<{ reason: ReasonV1; expectBlockerCode: string; expectPointerKind: string }> = [
    {
      reason: { kind: 'missing_context_key', key: 'slices' },
      expectBlockerCode: 'MISSING_CONTEXT_KEY',
      expectPointerKind: 'context_key',
    },
    {
      reason: { kind: 'context_budget_exceeded' },
      expectBlockerCode: 'CONTEXT_BUDGET_EXCEEDED',
      expectPointerKind: 'context_budget',
    },
    {
      reason: { kind: 'missing_required_output', contractRef: 'wr.validationCriteria' },
      expectBlockerCode: 'MISSING_REQUIRED_OUTPUT',
      expectPointerKind: 'output_contract',
    },
    {
      reason: { kind: 'invalid_required_output', contractRef: 'wr.validationCriteria' },
      expectBlockerCode: 'INVALID_REQUIRED_OUTPUT',
      expectPointerKind: 'output_contract',
    },
    {
      reason: { kind: 'required_capability_unknown', capability: 'web_browsing' },
      expectBlockerCode: 'REQUIRED_CAPABILITY_UNKNOWN',
      expectPointerKind: 'capability',
    },
    {
      reason: { kind: 'required_capability_unavailable', capability: 'delegation' },
      expectBlockerCode: 'REQUIRED_CAPABILITY_UNAVAILABLE',
      expectPointerKind: 'capability',
    },
    {
      reason: { kind: 'user_only_dependency', detail: 'needs_user_approval', stepId: 'phase_planning' },
      expectBlockerCode: 'USER_ONLY_DEPENDENCY',
      expectPointerKind: 'workflow_step',
    },
    {
      reason: { kind: 'storage_corruption_detected' },
      expectBlockerCode: 'STORAGE_CORRUPTION_DETECTED',
      expectPointerKind: 'context_budget',
    },
    {
      reason: { kind: 'missing_notes', stepId: 'phase-1-explore' },
      expectBlockerCode: 'MISSING_REQUIRED_NOTES',
      expectPointerKind: 'workflow_step',
    },
  ];

  for (const c of cases) {
    it(`maps ${c.reason.kind} -> blocker(${c.expectBlockerCode}, ${c.expectPointerKind})`, () => {
      const blocker = reasonToBlocker(c.reason);
      expect(blocker.isOk()).toBe(true);
      expect(blocker._unsafeUnwrap().code).toBe(c.expectBlockerCode);
      expect(blocker._unsafeUnwrap().pointer.kind).toBe(c.expectPointerKind);
    });

    it(`maps ${c.reason.kind} -> gap(critical, closed-set reason)`, () => {
      const g = reasonToGap(c.reason);
      expect(g.severity).toBe('critical');
      expect(g.summary.length).toBeGreaterThan(0);
    });

    it(`gap_recorded event built from ${c.reason.kind} passes DomainEventV1Schema`, () => {
      const ev = buildGapRecordedEventV1({
        eventId: 'evt_01jh_test',
        eventIndex: 10,
        sessionId: 'sess_01jh_test',
        runId: 'run_01jh_test',
        nodeId: 'node_01jh_test',
        gapId: 'gap_01jh_test',
        reason: c.reason,
      });

      expect(() => DomainEventV1Schema.parse(ev)).not.toThrow();
    });
  }

  it('buildBlockerReport sorts deterministically by (code, pointer.kind, pointer.*)', () => {
    const reasons: ReasonV1[] = [
      { kind: 'missing_required_output', contractRef: 'wr.validationCriteria' },
      { kind: 'missing_context_key', key: 'slices' },
      { kind: 'required_capability_unknown', capability: 'web_browsing' },
    ];

    const report = buildBlockerReport(reasons);
    expect(report.isOk()).toBe(true);

    const blockers = report._unsafeUnwrap().blockers;
    for (let i = 1; i < blockers.length; i++) {
      expect(blockerSortKey(blockers[i - 1]!).localeCompare(blockerSortKey(blockers[i]!))).toBeLessThanOrEqual(0);
    }
  });
});
