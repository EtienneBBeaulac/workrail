import { describe, it, expect } from 'vitest';
import type { EngineStateV1 } from '../../../src/v2/durable-core/schemas/execution-snapshot/index.js';
import { deriveIsComplete, derivePendingStep } from '../../../src/v2/durable-core/projections/snapshot-state.js';

describe('v2 snapshot-state helpers (Slice 3 prereq)', () => {
  it('deriveIsComplete is true only when state.kind=complete', () => {
    const init: EngineStateV1 = { kind: 'init' };
    const complete: EngineStateV1 = { kind: 'complete' };

    expect(deriveIsComplete(init)).toBe(false);
    expect(deriveIsComplete(complete)).toBe(true);
  });

  it('derivePendingStep returns the pending step only in running/some', () => {
    const init: EngineStateV1 = { kind: 'init' };
    expect(derivePendingStep(init)).toBeNull();

    const runningNone: EngineStateV1 = {
      kind: 'running',
      completed: { kind: 'set', values: [] },
      loopStack: [],
      pending: { kind: 'none' },
    };
    expect(derivePendingStep(runningNone)).toBeNull();

    const runningSome: EngineStateV1 = {
      kind: 'running',
      completed: { kind: 'set', values: [] },
      loopStack: [],
      pending: { kind: 'some', step: { stepId: 'triage', loopPath: [] } },
    };
    expect(derivePendingStep(runningSome)).toEqual({ stepId: 'triage', loopPath: [] });
  });
});
