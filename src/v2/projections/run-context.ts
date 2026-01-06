import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import type { JsonObject } from '../durable-core/canonical/json-types.js';
import type { RunId } from '../durable-core/ids/index.js';
import { asRunId } from '../durable-core/ids/index.js';

export type ProjectionError =
  | { readonly code: 'PROJECTION_INVARIANT_VIOLATION'; readonly message: string }
  | { readonly code: 'PROJECTION_CORRUPTION_DETECTED'; readonly message: string };

type ContextSetEventV1 = Extract<DomainEventV1, { kind: 'context_set' }>;

export interface RunContextV2 {
  readonly runId: RunId;
  readonly context: JsonObject;
  readonly contextId: string;
  readonly source: 'initial' | 'agent_delta';
  readonly setAtEventIndex: number;
}

export interface RunContextProjectionV2 {
  readonly byRunId: Readonly<Record<string, RunContextV2>>;
}

/**
 * Pure projection: derive effective context per run from context_set events.
 *
 * Lock intent (§18.2):
 * - Latest context_set event for a runId defines current context
 * - Run-scoped (not node-scoped)
 * - Context is a snapshot (not incremental deltas)
 */
export function projectRunContextV2(events: readonly DomainEventV1[]): Result<RunContextProjectionV2, ProjectionError> {
  // Enforce sorted events
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({ code: 'PROJECTION_INVARIANT_VIOLATION', message: 'Events must be sorted by eventIndex ascending' });
    }
  }

  const byRunId: Record<string, RunContextV2> = {};

  for (const e of events) {
    if (e.kind !== 'context_set') continue;

    const runId = e.scope.runId;
    const context = e.data.context;

    // Validate context is a plain object (not null/array/primitive)
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
      return err({
        code: 'PROJECTION_CORRUPTION_DETECTED',
        message: `context_set event has invalid context type (runId=${runId}, eventId=${e.eventId})`,
      });
    }

    // Latest event wins (overwrite previous)
    byRunId[runId] = {
      runId: asRunId(runId),
      context: context as JsonObject,
      contextId: e.data.contextId,
      source: e.data.source,
      setAtEventIndex: e.eventIndex,
    };
  }

  return ok({ byRunId });
}
