import { describe, it, expect } from 'vitest';
import { projectRunStatusSignalsV2 } from '../../../src/v2/projections/run-status-signals.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('v2 run status signals projection', () => {
  it('marks blocked in guided mode when there is an unresolved critical gap', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: {
          workflowId: 'project.example',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          workflowSourceKind: 'project',
          workflowSourceRef: 'workflows/example.json',
        },
      },
      {
        v: 1,
        eventId: 'evt_node_a',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_a',
        scope: { runId: 'run_1', nodeId: 'node_a' },
        data: {
          nodeKind: 'step',
          parentNodeId: null,
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          snapshotRef: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_1',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_1',
        scope: { runId: 'run_1', nodeId: 'node_a' },
        data: {
          gapId: 'gap_1',
          severity: 'critical',
          reason: { category: 'contract_violation', detail: 'missing_required_output' },
          summary: 'Missing required output',
          resolution: { kind: 'unresolved' },
        },
      },
    ];

    const res = projectRunStatusSignalsV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap().byRunId['run_1']!;
    expect(projected.isBlocked).toBe(true);
    expect(projected.effectivePreferencesAtTip.autonomy).toBe('guided');
  });

  it('does not block in full_auto_never_stop mode even with blocking-category gaps', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: {
          workflowId: 'project.example',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          workflowSourceKind: 'project',
          workflowSourceRef: 'workflows/example.json',
        },
      },
      {
        v: 1,
        eventId: 'evt_node_a',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_a',
        scope: { runId: 'run_1', nodeId: 'node_a' },
        data: {
          nodeKind: 'step',
          parentNodeId: null,
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          snapshotRef: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        },
      },
      {
        v: 1,
        eventId: 'evt_prefs',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'preferences_changed',
        dedupeKey: 'preferences_changed:sess_1:pref_1',
        scope: { runId: 'run_1', nodeId: 'node_a' },
        data: {
          changeId: 'pref_1',
          source: 'user',
          delta: [{ key: 'autonomy', value: 'full_auto_never_stop' }],
          effective: { autonomy: 'full_auto_never_stop', riskPolicy: 'conservative' },
        },
      },
      {
        v: 1,
        eventId: 'evt_gap_1',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_1',
        scope: { runId: 'run_1', nodeId: 'node_a' },
        data: {
          gapId: 'gap_1',
          severity: 'critical',
          reason: { category: 'user_only_dependency', detail: 'needs_user_choice' },
          summary: 'Need user choice',
          resolution: { kind: 'unresolved' },
        },
      },
    ];

    const res = projectRunStatusSignalsV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap().byRunId['run_1']!;
    expect(projected.isBlocked).toBe(false);
    expect(projected.effectivePreferencesAtTip.autonomy).toBe('full_auto_never_stop');
  });
});
