import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND } from '../durable-core/constants.js';
import type { JsonObject } from '../durable-core/canonical/json-types.js';
import type { ProjectionError } from './projection-error.js';
import type {
  ConsoleExecutionTraceFact,
  ConsoleExecutionTraceItem,
  ConsoleExecutionTraceItemKind,
  ConsoleExecutionTraceRef,
  ConsoleExecutionTraceSummary,
} from '../usecases/console-types.js';

export interface RunExecutionTraceProjectionV2 {
  readonly byRunId: Readonly<Record<string, ConsoleExecutionTraceSummary>>;
}

const CONTEXT_KEYS_TO_ELEVATE = ['taskComplexity'] as const;

export function projectRunExecutionTraceV2(
  events: readonly DomainEventV1[],
): Result<RunExecutionTraceProjectionV2, ProjectionError> {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({
        code: 'PROJECTION_INVARIANT_VIOLATION',
        message: 'Events must be sorted by eventIndex ascending',
      });
    }
  }

  const itemsByRunId: Record<string, ConsoleExecutionTraceItem[]> = {};
  const contextFactsByRunId: Record<string, ConsoleExecutionTraceFact[]> = {};

  const pushItem = (runId: string, item: ConsoleExecutionTraceItem): void => {
    const existing = itemsByRunId[runId] ?? [];
    existing.push(item);
    itemsByRunId[runId] = existing;
  };

  for (const event of events) {
    switch (event.kind) {
      case EVENT_KIND.DECISION_TRACE_APPENDED: {
        const runId = event.scope.runId;
        const nodeRef: ConsoleExecutionTraceRef = { kind: 'node_id', value: event.scope.nodeId };

        for (const entry of event.data.entries) {
          pushItem(runId, {
            kind: entry.kind as ConsoleExecutionTraceItemKind,
            summary: entry.summary,
            recordedAtEventIndex: event.eventIndex,
            refs: [nodeRef, ...mapDecisionTraceRefs(entry.refs)],
          });
        }
        break;
      }

      case EVENT_KIND.DIVERGENCE_RECORDED: {
        const runId = event.scope.runId;
        const refs: ConsoleExecutionTraceRef[] = [
          { kind: 'node_id', value: event.scope.nodeId },
        ];
        if (event.data.relatedStepId) {
          refs.push({ kind: 'step_id', value: event.data.relatedStepId });
        }

        pushItem(runId, {
          kind: 'divergence',
          summary: event.data.summary,
          recordedAtEventIndex: event.eventIndex,
          refs,
        });
        break;
      }

      case EVENT_KIND.CONTEXT_SET: {
        const context = event.data.context;
        if (!context || typeof context !== 'object' || Array.isArray(context)) {
          return err({
            code: 'PROJECTION_CORRUPTION_DETECTED',
            message: `context_set event has invalid context type (runId=${event.scope.runId}, eventId=${event.eventId})`,
          });
        }

        const contextObj = context as JsonObject;
        const facts = CONTEXT_KEYS_TO_ELEVATE.flatMap((key) => {
          const value = contextObj[key];
          if (value === undefined || value === null) return [];
          return [{ key, value: stringifyContextValue(value) }] as const;
        });

        if (facts.length > 0) {
          contextFactsByRunId[event.scope.runId] = facts;
        }
        break;
      }

      default:
        break;
    }
  }

  const runIds = new Set([
    ...Object.keys(itemsByRunId),
    ...Object.keys(contextFactsByRunId),
  ]);

  const byRunId: Record<string, ConsoleExecutionTraceSummary> = {};
  for (const runId of runIds) {
    byRunId[runId] = {
      items: itemsByRunId[runId] ?? [],
      contextFacts: contextFactsByRunId[runId] ?? [],
    };
  }

  return ok({ byRunId });
}

function mapDecisionTraceRefs(
  refs: readonly { readonly kind: string; readonly stepId?: string; readonly loopId?: string; readonly conditionId?: string }[] | undefined,
): readonly ConsoleExecutionTraceRef[] {
  if (!refs || refs.length === 0) return [];

  const mapped: ConsoleExecutionTraceRef[] = [];
  for (const ref of refs) {
    switch (ref.kind) {
      case 'step_id':
        if (ref.stepId) {
          mapped.push({ kind: 'step_id', value: ref.stepId });
        }
        break;
      case 'loop_id':
        if (ref.loopId) {
          mapped.push({ kind: 'loop_id', value: ref.loopId });
        }
        break;
      case 'condition_id':
        if (ref.conditionId) {
          mapped.push({ kind: 'condition_id', value: ref.conditionId });
        }
        break;
      default:
        break;
    }
  }

  return mapped;
}

function stringifyContextValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
