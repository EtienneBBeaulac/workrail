import { describe, expect, it } from 'vitest';
import { DomainEventV1Schema } from '../../../src/v2/durable-core/schemas/session/index.js';
import { buildGapRecordedEventV1 } from '../../../src/v2/durable-core/domain/gap-builder.js';

describe('gap-builder', () => {
  it('builds a gap_recorded event with locked dedupeKey recipe', () => {
    const ev = buildGapRecordedEventV1({
      eventId: 'evt_01jh_test',
      eventIndex: 5,
      sessionId: 'sess_01jh_test',
      runId: 'run_01jh_test',
      nodeId: 'node_01jh_test',
      gapId: 'gap_01jh_test',
      reason: { kind: 'missing_required_output', contractRef: 'wr.validationCriteria' },
    });

    expect(ev.kind).toBe('gap_recorded');
    expect(ev.dedupeKey).toBe('gap_recorded:sess_01jh_test:gap_01jh_test');
    expect(() => DomainEventV1Schema.parse(ev)).not.toThrow();
  });
});
