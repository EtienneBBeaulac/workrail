/**
 * @enforces risk-policy-guardrails
 */
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

  describe('riskPolicy guardrails (conservative/balanced/aggressive)', () => {
    it('accepts all three riskPolicy values (closed set)', () => {
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
      ];

      // Test conservative
      const conservativeEvents: DomainEventV1[] = [
        ...events,
        {
          v: 1,
          eventId: 'evt_prefs_conservative',
          eventIndex: 2,
          sessionId: 'sess_1',
          kind: 'preferences_changed',
          dedupeKey: 'preferences_changed:sess_1:pref_conservative',
          scope: { runId: 'run_1', nodeId: 'node_a' },
          data: {
            changeId: 'pref_conservative',
            source: 'user',
            delta: [{ key: 'riskPolicy', value: 'conservative' }],
            effective: { autonomy: 'guided', riskPolicy: 'conservative' },
          },
        },
      ];
      const resConservative = projectRunStatusSignalsV2(conservativeEvents);
      expect(resConservative.isOk()).toBe(true);
      expect(resConservative._unsafeUnwrap().byRunId['run_1']?.effectivePreferencesAtTip.riskPolicy).toBe('conservative');

      // Test balanced
      const balancedEvents: DomainEventV1[] = [
        ...events,
        {
          v: 1,
          eventId: 'evt_prefs_balanced',
          eventIndex: 2,
          sessionId: 'sess_1',
          kind: 'preferences_changed',
          dedupeKey: 'preferences_changed:sess_1:pref_balanced',
          scope: { runId: 'run_1', nodeId: 'node_a' },
          data: {
            changeId: 'pref_balanced',
            source: 'user',
            delta: [{ key: 'riskPolicy', value: 'balanced' }],
            effective: { autonomy: 'guided', riskPolicy: 'balanced' },
          },
        },
      ];
      const resBalanced = projectRunStatusSignalsV2(balancedEvents);
      expect(resBalanced.isOk()).toBe(true);
      expect(resBalanced._unsafeUnwrap().byRunId['run_1']?.effectivePreferencesAtTip.riskPolicy).toBe('balanced');

      // Test aggressive
      const aggressiveEvents: DomainEventV1[] = [
        ...events,
        {
          v: 1,
          eventId: 'evt_prefs_aggressive',
          eventIndex: 2,
          sessionId: 'sess_1',
          kind: 'preferences_changed',
          dedupeKey: 'preferences_changed:sess_1:pref_aggressive',
          scope: { runId: 'run_1', nodeId: 'node_a' },
          data: {
            changeId: 'pref_aggressive',
            source: 'user',
            delta: [{ key: 'riskPolicy', value: 'aggressive' }],
            effective: { autonomy: 'guided', riskPolicy: 'aggressive' },
          },
        },
      ];
      const resAggressive = projectRunStatusSignalsV2(aggressiveEvents);
      expect(resAggressive.isOk()).toBe(true);
      expect(resAggressive._unsafeUnwrap().byRunId['run_1']?.effectivePreferencesAtTip.riskPolicy).toBe('aggressive');
    });

    it('does NOT use riskPolicy to bypass contract blocking (gaps still record and block regardless of riskPolicy)', () => {
      // Lock: riskPolicy cannot bypass contracts/capabilities or suppress disclosure.
      // This test documents that gaps are ALWAYS recorded and ALWAYS visible,
      // regardless of riskPolicy setting.
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
          eventId: 'evt_prefs_aggressive',
          eventIndex: 2,
          sessionId: 'sess_1',
          kind: 'preferences_changed',
          dedupeKey: 'preferences_changed:sess_1:pref_aggressive',
          scope: { runId: 'run_1', nodeId: 'node_a' },
          data: {
            changeId: 'pref_aggressive',
            source: 'user',
            delta: [{ key: 'riskPolicy', value: 'aggressive' }],
            effective: { autonomy: 'guided', riskPolicy: 'aggressive' },
          },
        },
        {
          v: 1,
          eventId: 'evt_gap_contract_violation',
          eventIndex: 3,
          sessionId: 'sess_1',
          kind: 'gap_recorded',
          dedupeKey: 'gap_recorded:sess_1:gap_contract',
          scope: { runId: 'run_1', nodeId: 'node_a' },
          data: {
            gapId: 'gap_contract',
            severity: 'critical',
            reason: { category: 'contract_violation', detail: 'missing_required_output' },
            summary: 'Contract violation: required output missing',
            resolution: { kind: 'unresolved' },
          },
        },
      ];

      const res = projectRunStatusSignalsV2(events);
      expect(res.isOk()).toBe(true);
      const projected = res._unsafeUnwrap().byRunId['run_1']!;

      // Guardrail: gap is STILL VISIBLE despite riskPolicy='aggressive'
      expect(projected.hasUnresolvedCriticalGaps).toBe(true);
      // Guardrail: gap STILL BLOCKS despite riskPolicy='aggressive' (in guided/balanced mode)
      expect(projected.isBlocked).toBe(true);
      // Guardrail: riskPolicy is just a preference, not a bypass mechanism
      expect(projected.effectivePreferencesAtTip.riskPolicy).toBe('aggressive');
    });

    it('does NOT use riskPolicy to suppress capability requirement disclosure', () => {
      // Lock: riskPolicy cannot suppress disclosure
      // Test that hasUnresolvedCriticalGaps is truthful even with aggressive riskPolicy
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
          eventId: 'evt_prefs_aggressive',
          eventIndex: 2,
          sessionId: 'sess_1',
          kind: 'preferences_changed',
          dedupeKey: 'preferences_changed:sess_1:pref_aggressive',
          scope: { runId: 'run_1', nodeId: 'node_a' },
          data: {
            changeId: 'pref_aggressive',
            source: 'user',
            delta: [{ key: 'riskPolicy', value: 'aggressive' }],
            effective: { autonomy: 'guided', riskPolicy: 'aggressive' },
          },
        },
        {
          v: 1,
          eventId: 'evt_gap_capability',
          eventIndex: 3,
          sessionId: 'sess_1',
          kind: 'gap_recorded',
          dedupeKey: 'gap_recorded:sess_1:gap_capability',
          scope: { runId: 'run_1', nodeId: 'node_a' },
          data: {
            gapId: 'gap_capability',
            severity: 'critical',
            reason: { category: 'capability_missing', detail: 'required_capability_not_available' },
            summary: 'Required capability unavailable: file_read',
            resolution: { kind: 'unresolved' },
          },
        },
      ];

      const res = projectRunStatusSignalsV2(events);
      expect(res.isOk()).toBe(true);
      const projected = res._unsafeUnwrap().byRunId['run_1']!;

      // Guardrail: capability gap MUST be visible and reported
      expect(projected.hasUnresolvedCriticalGaps).toBe(true);
      // Even with aggressive riskPolicy, capability gaps cause blocking (in non-never-stop mode)
      expect(projected.isBlocked).toBe(true);
    });
  });
});
