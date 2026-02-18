import { describe, expect, it } from 'vitest';
import { detectBlockingReasonsV1 } from '../../../src/v2/durable-core/domain/blocking-decision.js';
import { buildBlockerReport, shouldBlock, type ReasonV1 } from '../../../src/v2/durable-core/domain/reason-model.js';

describe('blocking-decision', () => {
  it('detects missing context keys and output missing', () => {
    const res = detectBlockingReasonsV1({
      missingContextKeys: ['slices'],
      outputRequirement: { kind: 'missing', contractRef: 'wr.validationCriteria' },
    });

    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toEqual([
      { kind: 'missing_context_key', key: 'slices' },
      { kind: 'missing_required_output', contractRef: 'wr.validationCriteria' },
    ]);
  });

  it('fails fast on non-delimiter-safe context keys', () => {
    const res = detectBlockingReasonsV1({ missingContextKeys: ['NotSafe'] });
    expect(res.isErr()).toBe(true);
  });

  it('shouldBlock only depends on autonomy + presence of reasons', () => {
    const reasons: ReasonV1[] = [{ kind: 'missing_context_key', key: 'slices' }];

    expect(shouldBlock('guided', reasons)).toBe(true);
    expect(shouldBlock('full_auto_stop_on_user_deps', reasons)).toBe(true);
    expect(shouldBlock('full_auto_never_stop', reasons)).toBe(false);
    expect(shouldBlock('guided', [])).toBe(false);
  });

  it('emits missing_notes when missingNotes is provided', () => {
    const res = detectBlockingReasonsV1({
      missingNotes: { stepId: 'phase-2-execute' },
    });
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toEqual([
      { kind: 'missing_notes', stepId: 'phase-2-execute' },
    ]);
  });

  it('does NOT emit missing_notes when missingNotes is absent', () => {
    const res = detectBlockingReasonsV1({});
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toEqual([]);
  });

  it('fails fast on non-delimiter-safe missingNotes stepId', () => {
    const res = detectBlockingReasonsV1({ missingNotes: { stepId: 'NotSafe/Step' } });
    expect(res.isErr()).toBe(true);
  });

  it('combines missing_notes with other reasons', () => {
    const res = detectBlockingReasonsV1({
      missingNotes: { stepId: 'phase-3-report' },
      outputRequirement: { kind: 'missing', contractRef: 'wr.validationCriteria' },
    });
    expect(res.isOk()).toBe(true);
    const reasons = res._unsafeUnwrap();
    expect(reasons).toHaveLength(2);
    expect(reasons.some(r => r.kind === 'missing_required_output')).toBe(true);
    expect(reasons.some(r => r.kind === 'missing_notes')).toBe(true);
  });

  it('buildBlockerReport is bounded to MAX_BLOCKERS', () => {
    const reasons: ReasonV1[] = [];
    for (let i = 0; i < 25; i++) {
      reasons.push({ kind: 'missing_context_key', key: `k_${i}` });
    }

    const report = buildBlockerReport(reasons);
    expect(report.isOk()).toBe(true);
    expect(report._unsafeUnwrap().blockers.length).toBeLessThanOrEqual(10);
  });
});
