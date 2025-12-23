import { describe, it, expect } from 'vitest';
import { projectPreferencesV2 } from '../../../src/v2/projections/preferences.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('v2 preferences projection', () => {
  it('propagates effective prefs down the ancestry chain', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_prefs_root',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'preferences_changed',
        dedupeKey: 'preferences_changed:sess_1:pref_1',
        scope: { runId: 'run_1', nodeId: 'root' },
        data: {
          changeId: 'pref_1',
          source: 'user',
          delta: [{ key: 'autonomy', value: 'full_auto_never_stop' }],
          effective: { autonomy: 'full_auto_never_stop', riskPolicy: 'conservative' },
        },
      },
      {
        v: 1,
        eventId: 'evt_prefs_child',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'preferences_changed',
        dedupeKey: 'preferences_changed:sess_1:pref_2',
        scope: { runId: 'run_1', nodeId: 'child' },
        data: {
          changeId: 'pref_2',
          source: 'workflow_recommendation',
          delta: [{ key: 'riskPolicy', value: 'balanced' }],
          effective: { autonomy: 'full_auto_never_stop', riskPolicy: 'balanced' },
        },
      },
    ];

    const parentMap = { root: null, child: 'root', grandchild: 'child' };
    const res = projectPreferencesV2(events, parentMap);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();

    expect(projected.byNodeId['root']!.effective.autonomy).toBe('full_auto_never_stop');
    expect(projected.byNodeId['child']!.effective.riskPolicy).toBe('balanced');
    expect(projected.byNodeId['grandchild']!.effective).toEqual({ autonomy: 'full_auto_never_stop', riskPolicy: 'balanced' });
  });
});
