import { describe, expect, it } from 'vitest';
import {
  ExecutionSnapshotFileV1Schema,
} from '../../../src/v2/durable-core/schemas/execution-snapshot/index.js';
import {
  StepInstanceKeyV1Schema,
  parseStepInstanceKeyV1,
} from '../../../src/v2/durable-core/schemas/execution-snapshot/step-instance-key.js';

describe('execution snapshot expanded step IDs', () => {
  it('accepts dotted expanded step IDs in step instance keys', () => {
    expect(() =>
      StepInstanceKeyV1Schema.parse('phase-1b-design-deep.step-discover-philosophy')
    ).not.toThrow();
    expect(
      parseStepInstanceKeyV1('phase-1b-design-deep.step-discover-philosophy').isOk()
    ).toBe(true);
  });

  it('accepts dotted expanded step IDs in pending snapshots', () => {
    expect(() =>
      ExecutionSnapshotFileV1Schema.parse({
        v: 1,
        kind: 'execution_snapshot',
        enginePayload: {
          v: 1,
          engineState: {
            kind: 'running',
            completed: {
              kind: 'set',
              values: [
                'phase-0-understand-and-classify',
                'phase-1a-hypothesis',
              ],
            },
            loopStack: [],
            pending: {
              kind: 'some',
              step: {
                stepId: 'phase-1b-design-deep.step-discover-philosophy',
                loopPath: [],
              },
            },
          },
        },
      })
    ).not.toThrow();
  });
});
