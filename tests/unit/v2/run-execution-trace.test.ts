import { describe, expect, it } from 'vitest';
import { projectRunExecutionTraceV2 } from '../../../src/v2/projections/run-execution-trace.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('projectRunExecutionTraceV2', () => {
  it('returns empty projection when no explainability events exist', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'session_created',
        dedupeKey: 'session_created:sess_1',
        data: {},
      } as DomainEventV1,
    ];

    const result = projectRunExecutionTraceV2(events);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.byRunId).toEqual({});
    }
  });

  it('projects decision trace entries, divergence, and selected context facts by run', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_1:ctx_1',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_1',
          context: { taskComplexity: 'Small', ignored: 'value' },
          source: 'initial',
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'decision_trace_appended',
        dedupeKey: 'decision_trace_appended:sess_1:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          traceId: 'trace_1',
          entries: [
            {
              kind: 'selected_next_step',
              summary: "Selected next step 'step-plan'.",
              refs: [{ kind: 'step_id', stepId: 'step-plan' }],
            },
            {
              kind: 'evaluated_condition',
              summary: "Evaluated condition for loop 'plan-loop': continue.",
              refs: [{ kind: 'loop_id', loopId: 'plan-loop' }],
            },
          ],
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_2',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'divergence_recorded',
        dedupeKey: 'divergence_recorded:sess_1:div_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          divergenceId: 'div_1',
          reason: 'efficiency_skip',
          summary: 'Skipped broad planning path after small-task fast path.',
          relatedStepId: 'step-implement',
        },
      } as DomainEventV1,
    ];

    const result = projectRunExecutionTraceV2(events);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.byRunId['run_1']).toEqual({
        items: [
          {
            kind: 'selected_next_step',
            summary: "Selected next step 'step-plan'.",
            recordedAtEventIndex: 1,
            refs: [
              { kind: 'node_id', value: 'node_1' },
              { kind: 'step_id', value: 'step-plan' },
            ],
          },
          {
            kind: 'evaluated_condition',
            summary: "Evaluated condition for loop 'plan-loop': continue.",
            recordedAtEventIndex: 1,
            refs: [
              { kind: 'node_id', value: 'node_1' },
              { kind: 'loop_id', value: 'plan-loop' },
            ],
          },
          {
            kind: 'divergence',
            summary: 'Skipped broad planning path after small-task fast path.',
            recordedAtEventIndex: 2,
            refs: [
              { kind: 'node_id', value: 'node_1' },
              { kind: 'step_id', value: 'step-implement' },
            ],
          },
        ],
        contextFacts: [{ key: 'taskComplexity', value: 'Small' }],
      });
    }
  });

  it('keeps only the latest selected context facts for a run', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_1:ctx_1',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_1',
          context: { taskComplexity: 'Medium' },
          source: 'initial',
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_1:ctx_2',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_2',
          context: { taskComplexity: 'Small' },
          source: 'agent_delta',
        },
      } as DomainEventV1,
    ];

    const result = projectRunExecutionTraceV2(events);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.byRunId['run_1']?.contextFacts).toEqual([
        { key: 'taskComplexity', value: 'Small' },
      ]);
    }
  });

  it('rejects unsorted events', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_1:ctx_1',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_1',
          context: { taskComplexity: 'Small' },
          source: 'initial',
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'session_created',
        dedupeKey: 'session_created:sess_1',
        data: {},
      } as DomainEventV1,
    ];

    const result = projectRunExecutionTraceV2(events);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('PROJECTION_INVARIANT_VIOLATION');
    }
  });

  it('rejects invalid context type', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_1:ctx_1',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_1',
          context: null as any,
          source: 'initial',
        },
      } as DomainEventV1,
    ];

    const result = projectRunExecutionTraceV2(events);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('PROJECTION_CORRUPTION_DETECTED');
    }
  });
});
