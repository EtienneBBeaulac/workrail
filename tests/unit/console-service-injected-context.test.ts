/**
 * Unit tests for ConsoleSessionDetail.injectedContext.
 *
 * injectedContext.assembledContextSummary: derived from the context_set event
 * written by coordinators at session dispatch time. Surfaces the coordinator-
 * assembled phase handoff context that was injected into the agent's system prompt.
 */

import { describe, it, expect } from 'vitest';
import { okAsync } from 'neverthrow';
import { ConsoleService } from '../../src/v2/usecases/console-service.js';
import {
  InMemorySnapshotStore,
  InMemoryPinnedWorkflowStore,
} from '../fakes/v2/index.js';
import type { DirectoryListingPortV2, DirEntryWithMtime } from '../../src/v2/ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../src/v2/ports/data-dir.port.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../../src/v2/ports/session-event-log-store.port.js';
import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';
import type { SessionId, WorkflowHash } from '../../src/v2/durable-core/ids/index.js';

function makeDirectoryListing(sessionId: string): DirectoryListingPortV2 {
  return {
    readdir: () => okAsync([]),
    readdirWithMtime: () => okAsync([{ name: sessionId, mtimeMs: Date.now() }]),
  };
}

const stubDataDir = { sessionsDir: () => '/fake/sessions' } as unknown as DataDirPortV2;

function makeService(sessionId: string, events: DomainEventV1[]): ConsoleService {
  const mockStore: SessionEventLogReadonlyStorePortV2 = {
    load: (_id) => okAsync({ events, manifest: [] }),
    loadValidatedPrefix: (_id) => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
  };
  return new ConsoleService({
    directoryListing: makeDirectoryListing(sessionId),
    dataDir: stubDataDir,
    sessionStore: mockStore,
    snapshotStore: new InMemorySnapshotStore(),
    pinnedWorkflowStore: new InMemoryPinnedWorkflowStore(),
  });
}

function makeRunStartedEvent(sessionId: string, runId: string, idx: number): DomainEventV1 {
  return {
    v: 1, eventId: `evt_run_${idx}`, eventIndex: idx,
    sessionId: sessionId as SessionId,
    kind: 'run_started',
    scope: { runId },
    data: {
      workflowId: 'wr.coding-task',
      workflowHash: 'hash123' as WorkflowHash,
      workflowSourceKind: 'bundled',
      workflowSourceRef: 'bundled:wr.coding-task',
    },
  } as DomainEventV1;
}

function makeContextSetEvent(
  sessionId: string,
  runId: string,
  context: Record<string, unknown>,
  idx: number,
): DomainEventV1 {
  return {
    v: 1, eventId: `evt_ctx_${idx}`, eventIndex: idx,
    sessionId: sessionId as SessionId,
    kind: 'context_set',
    dedupeKey: `context_set:${sessionId}:${runId}:${idx}`,
    scope: { runId },
    data: { contextId: `ctx_${idx}`, context, source: 'initial' },
  } as DomainEventV1;
}

const SESSION_ID = 'sess_inj00000000000000000000';
const RUN_ID = 'run_inj000000000000000000';
const SUMMARY = 'Selected direction: discriminated unions.\nConstraint: no breaking changes.';

describe('ConsoleService injectedContext', () => {
  it('is undefined when no context_set event exists', async () => {
    const service = makeService(SESSION_ID, [makeRunStartedEvent(SESSION_ID, RUN_ID, 0)]);
    const result = await service.getSessionDetail(SESSION_ID);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().injectedContext).toBeUndefined();
  });

  it('is undefined when context_set has no assembledContextSummary key', async () => {
    const service = makeService(SESSION_ID, [
      makeRunStartedEvent(SESSION_ID, RUN_ID, 0),
      makeContextSetEvent(SESSION_ID, RUN_ID, { goal: 'implement feature', is_autonomous: 'true' }, 1),
    ]);
    const result = await service.getSessionDetail(SESSION_ID);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().injectedContext).toBeUndefined();
  });

  it('is undefined when assembledContextSummary is whitespace-only', async () => {
    const service = makeService(SESSION_ID, [
      makeRunStartedEvent(SESSION_ID, RUN_ID, 0),
      makeContextSetEvent(SESSION_ID, RUN_ID, { assembledContextSummary: '   ' }, 1),
    ]);
    const result = await service.getSessionDetail(SESSION_ID);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().injectedContext).toBeUndefined();
  });

  it('surfaces assembledContextSummary when present', async () => {
    const service = makeService(SESSION_ID, [
      makeRunStartedEvent(SESSION_ID, RUN_ID, 0),
      makeContextSetEvent(SESSION_ID, RUN_ID, { assembledContextSummary: SUMMARY, goal: 'implement feature' }, 1),
    ]);
    const result = await service.getSessionDetail(SESSION_ID);
    expect(result.isOk()).toBe(true);
    const detail = result._unsafeUnwrap();
    expect(detail.injectedContext?.assembledContextSummary).toBe(SUMMARY);
  });

  it('is undefined when assembledContextSummary is not a string', async () => {
    const service = makeService(SESSION_ID, [
      makeRunStartedEvent(SESSION_ID, RUN_ID, 0),
      makeContextSetEvent(SESSION_ID, RUN_ID, { assembledContextSummary: 42 }, 1),
    ]);
    const result = await service.getSessionDetail(SESSION_ID);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().injectedContext).toBeUndefined();
  });
});
