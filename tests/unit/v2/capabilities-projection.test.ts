import { describe, it, expect } from 'vitest';
import { projectCapabilitiesV2 } from '../../../src/v2/projections/capabilities.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('v2 capabilities projection', () => {
  it('uses latest-wins by eventIndex for a node+capability', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_cap_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'capability_observed',
        dedupeKey: 'capability_observed:sess_1:capobs_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          capObsId: 'capobs_1',
          capability: 'web_browsing',
          status: 'unavailable',
          provenance: {
            kind: 'probe_step',
            enforcementGrade: 'strong',
            detail: { probeTemplateId: 'wr.templates.capability_probe', probeStepId: 'probe_web', result: 'failure' },
          },
        },
      },
      {
        v: 1,
        eventId: 'evt_cap_2',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'capability_observed',
        dedupeKey: 'capability_observed:sess_1:capobs_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          capObsId: 'capobs_2',
          capability: 'web_browsing',
          status: 'available',
          provenance: {
            kind: 'probe_step',
            enforcementGrade: 'strong',
            detail: { probeTemplateId: 'wr.templates.capability_probe', probeStepId: 'probe_web', result: 'success' },
          },
        },
      },
    ];

    const res = projectCapabilitiesV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    const node = projected.nodesById['node_1']!;
    expect(node.byCapability.web_browsing?.status).toBe('available');
  });
});
