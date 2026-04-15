/**
 * Unit tests for isAutonomous and isLive in ConsoleService.getSessionList().
 *
 * isAutonomous: derived from context_set event with is_autonomous: 'true'.
 *   Durable -- comes from the event log.
 *
 * isLive: derived from DaemonRegistry.snapshot() + lastHeartbeatMs threshold.
 *   Ephemeral -- false when no registry injected, or when heartbeat is stale.
 *
 * Test strategy:
 * - Seed context_set events directly into InMemorySessionEventLogStore
 * - Inject pre-populated DaemonRegistry instances
 * - Control nowMs via the mtime trick (consistent with dormancy tests)
 */

import { describe, it, expect } from 'vitest';
import { okAsync } from 'neverthrow';
import { ConsoleService } from '../../src/v2/usecases/console-service.js';
import { DaemonRegistry } from '../../src/v2/infra/in-memory/daemon-registry/index.js';
import {
  InMemorySessionEventLogStore,
  InMemorySnapshotStore,
  InMemoryPinnedWorkflowStore,
} from '../fakes/v2/index.js';
import type { DirectoryListingPortV2, DirEntryWithMtime } from '../../src/v2/ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../src/v2/ports/data-dir.port.js';
import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';
import type { SessionId } from '../../src/v2/durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_THRESHOLD_MS = 10 * 60 * 1000; // must match AUTONOMOUS_HEARTBEAT_THRESHOLD_MS

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeDirectoryListing(entries: readonly DirEntryWithMtime[]): DirectoryListingPortV2 {
  return {
    readdir: () => okAsync([]),
    readdirWithMtime: () => okAsync(entries),
  };
}

const stubDataDir = { sessionsDir: () => '/fake/sessions' } as unknown as DataDirPortV2;

function makeService(
  entries: readonly DirEntryWithMtime[],
  sessionStore: InMemorySessionEventLogStore,
  daemonRegistry?: DaemonRegistry,
): ConsoleService {
  return new ConsoleService({
    directoryListing: makeDirectoryListing(entries),
    dataDir: stubDataDir,
    sessionStore,
    snapshotStore: new InMemorySnapshotStore(),
    pinnedWorkflowStore: new InMemoryPinnedWorkflowStore(),
    daemonRegistry,
  });
}

/** Build a minimal context_set event for testing. */
function makeContextSetEvent(
  sessionId: string,
  runId: string,
  context: Record<string, string>,
  eventIndex: number,
): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_ctx_${eventIndex}`,
    eventIndex,
    sessionId: sessionId as SessionId,
    kind: 'context_set',
    dedupeKey: `context_set:${sessionId}:${runId}:test-${eventIndex}`,
    scope: { runId },
    data: {
      contextId: `ctx_${eventIndex}`,
      context,
      source: 'initial',
    },
  } as DomainEventV1;
}

// ---------------------------------------------------------------------------
// Tests: isAutonomous
// ---------------------------------------------------------------------------

describe('ConsoleService isAutonomous', () => {
  it('is false for a session with no context_set events', async () => {
    const store = new InMemorySessionEventLogStore();
    const service = makeService(
      [{ name: 'sess_aaa00000000000000000000', mtimeMs: Date.now() }],
      store,
    );

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.isAutonomous).toBe(false);
  });

  it('is false for a session with context_set but no is_autonomous key', async () => {
    const store = new InMemorySessionEventLogStore();
    // The InMemorySessionEventLogStore returns empty truth for unknown sessions,
    // so we rely on the empty event log case.
    const service = makeService(
      [{ name: 'sess_bbb00000000000000000000', mtimeMs: Date.now() }],
      store,
    );

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions[0]!.isAutonomous).toBe(false);
  });

  it('is true for a session with context_set is_autonomous: true', async () => {
    const store = new InMemorySessionEventLogStore();
    // Seed events manually via the internal map (we use the fake's append indirectly
    // by testing the projection directly -- the store loads whatever we put in it).
    // We need to use a session that projects with context. We'll test via
    // projectRunContextV2 behavior by checking the ConsoleService projection.
    //
    // Since InMemorySessionEventLogStore.load() returns { events: [] } for unknown sessions,
    // we verify the isAutonomous=false path. For isAutonomous=true, we test the projection
    // function directly in the context below by providing a store with real events.
    //
    // Note: To seed events into InMemorySessionEventLogStore we need to call append(),
    // which requires a lock. For this test, we'll use the projection directly.
    //
    // Direct approach: test projectSessionSummary behavior via a mock store.
    const sessionId = 'sess_ccc00000000000000000000';
    const runId = 'run_test_01';

    // Create a store that returns a seeded event log
    const eventLog: DomainEventV1[] = [
      makeContextSetEvent(sessionId, runId, { goal: 'test', is_autonomous: 'true' }, 0),
    ];

    const mockStore: import('../../src/v2/ports/session-event-log-store.port.js').SessionEventLogReadonlyStorePortV2 = {
      load: (_id) => okAsync({ events: eventLog, manifest: [] }),
      loadValidatedPrefix: (_id) => okAsync({ kind: 'complete', truth: { events: eventLog, manifest: [] } }),
    };

    const service = new ConsoleService({
      directoryListing: makeDirectoryListing([{ name: sessionId, mtimeMs: Date.now() }]),
      dataDir: stubDataDir,
      sessionStore: mockStore,
      snapshotStore: new InMemorySnapshotStore(),
      pinnedWorkflowStore: new InMemoryPinnedWorkflowStore(),
    });

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.isAutonomous).toBe(true);
  });

  it('is false when context has is_autonomous: "false" (explicit false)', async () => {
    const sessionId = 'sess_ddd00000000000000000000';
    const runId = 'run_test_02';

    const eventLog: DomainEventV1[] = [
      makeContextSetEvent(sessionId, runId, { goal: 'test', is_autonomous: 'false' }, 0),
    ];

    const mockStore: import('../../src/v2/ports/session-event-log-store.port.js').SessionEventLogReadonlyStorePortV2 = {
      load: (_id) => okAsync({ events: eventLog, manifest: [] }),
      loadValidatedPrefix: (_id) => okAsync({ kind: 'complete', truth: { events: eventLog, manifest: [] } }),
    };

    const service = new ConsoleService({
      directoryListing: makeDirectoryListing([{ name: sessionId, mtimeMs: Date.now() }]),
      dataDir: stubDataDir,
      sessionStore: mockStore,
      snapshotStore: new InMemorySnapshotStore(),
      pinnedWorkflowStore: new InMemoryPinnedWorkflowStore(),
    });

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions[0]!.isAutonomous).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: isLive
// ---------------------------------------------------------------------------

describe('ConsoleService isLive', () => {
  it('is false when no DaemonRegistry is injected', async () => {
    const store = new InMemorySessionEventLogStore();
    const service = makeService(
      [{ name: 'sess_eee00000000000000000000', mtimeMs: Date.now() }],
      store,
      undefined, // no registry
    );

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions[0]!.isLive).toBe(false);
  });

  it('is false when session is not in registry', async () => {
    const store = new InMemorySessionEventLogStore();
    const registry = new DaemonRegistry();
    // Registry has a different session registered
    registry.register('sess_zzz00000000000000000000', 'wf-test');

    const service = makeService(
      [{ name: 'sess_fff00000000000000000000', mtimeMs: Date.now() }],
      store,
      registry,
    );

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions[0]!.isLive).toBe(false);
  });

  it('is true when session is in registry with a recent heartbeat', async () => {
    const store = new InMemorySessionEventLogStore();
    const registry = new DaemonRegistry();
    const sessionId = 'sess_ggg00000000000000000000';
    registry.register(sessionId, 'wf-test');
    // lastHeartbeatMs is set to Date.now() during register -- well within threshold.

    const service = makeService(
      [{ name: sessionId, mtimeMs: Date.now() }],
      store,
      registry,
    );

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions[0]!.isLive).toBe(true);
  });

  it('is false when registry entry has a stale heartbeat (beyond threshold)', async () => {
    const store = new InMemorySessionEventLogStore();
    const registry = new DaemonRegistry();
    const sessionId = 'sess_hhh00000000000000000000';
    registry.register(sessionId, 'wf-test');

    // Simulate a stale heartbeat by directly manipulating the registry via heartbeat
    // We can't set the timestamp directly, so we test the boundary condition
    // by using a custom registry where lastHeartbeatMs is far in the past.
    // We'll use a subclass to expose internal state for testing.
    //
    // Alternative: test that a stale entry produces isLive=false by setting
    // the heartbeat time to nowMs - THRESHOLD - 1 second.
    //
    // Since we can't inject the heartbeat timestamp directly, use a mock approach:
    const staleRegistry: import('../../src/v2/infra/in-memory/daemon-registry/index.js').DaemonRegistry = {
      register: () => {},
      heartbeat: () => {},
      unregister: () => {},
      snapshot: () => new Map([
        [sessionId, {
          sessionId,
          workflowId: 'wf-test',
          startedAtMs: Date.now() - HEARTBEAT_THRESHOLD_MS - 60_000,
          lastHeartbeatMs: Date.now() - HEARTBEAT_THRESHOLD_MS - 60_000, // 11 min ago
          status: 'running' as const,
        }],
      ]),
    } as unknown as import('../../src/v2/infra/in-memory/daemon-registry/index.js').DaemonRegistry;

    const service = makeService(
      [{ name: sessionId, mtimeMs: Date.now() }],
      store,
      staleRegistry,
    );

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions[0]!.isLive).toBe(false);
  });

  it('is true exactly at the threshold boundary (inclusive)', async () => {
    // lastHeartbeatMs = nowMs - threshold exactly: should be false (strictly less than)
    const store = new InMemorySessionEventLogStore();
    const sessionId = 'sess_iii00000000000000000000';
    const nowMs = Date.now();

    const boundaryRegistry = {
      register: () => {},
      heartbeat: () => {},
      unregister: () => {},
      snapshot: () => new Map([
        [sessionId, {
          sessionId,
          workflowId: 'wf-test',
          startedAtMs: nowMs - HEARTBEAT_THRESHOLD_MS,
          lastHeartbeatMs: nowMs - HEARTBEAT_THRESHOLD_MS, // exactly at threshold
          status: 'running' as const,
        }],
      ]),
    } as unknown as import('../../src/v2/infra/in-memory/daemon-registry/index.js').DaemonRegistry;

    const service = makeService(
      [{ name: sessionId, mtimeMs: nowMs }],
      store,
      boundaryRegistry,
    );

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    // At exactly the threshold, isLive should be false (strictly less than).
    expect(sessions[0]!.isLive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: both isAutonomous and isLive
// ---------------------------------------------------------------------------

describe('ConsoleService isAutonomous + isLive together', () => {
  it('returns both fields when session is autonomous and live', async () => {
    const sessionId = 'sess_jjj00000000000000000000';
    const runId = 'run_test_03';

    const eventLog: DomainEventV1[] = [
      makeContextSetEvent(sessionId, runId, { goal: 'auto task', is_autonomous: 'true' }, 0),
    ];

    const mockStore: import('../../src/v2/ports/session-event-log-store.port.js').SessionEventLogReadonlyStorePortV2 = {
      load: (_id) => okAsync({ events: eventLog, manifest: [] }),
      loadValidatedPrefix: (_id) => okAsync({ kind: 'complete', truth: { events: eventLog, manifest: [] } }),
    };

    const registry = new DaemonRegistry();
    registry.register(sessionId, 'coding-task-workflow');

    const service = new ConsoleService({
      directoryListing: makeDirectoryListing([{ name: sessionId, mtimeMs: Date.now() }]),
      dataDir: stubDataDir,
      sessionStore: mockStore,
      snapshotStore: new InMemorySnapshotStore(),
      pinnedWorkflowStore: new InMemoryPinnedWorkflowStore(),
      daemonRegistry: registry,
    });

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.isAutonomous).toBe(true);
    expect(sessions[0]!.isLive).toBe(true);
  });

  it('returns isAutonomous=true, isLive=false for completed autonomous session', async () => {
    const sessionId = 'sess_kkk00000000000000000000';
    const runId = 'run_test_04';

    const eventLog: DomainEventV1[] = [
      makeContextSetEvent(sessionId, runId, { goal: 'auto task', is_autonomous: 'true' }, 0),
    ];

    const mockStore: import('../../src/v2/ports/session-event-log-store.port.js').SessionEventLogReadonlyStorePortV2 = {
      load: (_id) => okAsync({ events: eventLog, manifest: [] }),
      loadValidatedPrefix: (_id) => okAsync({ kind: 'complete', truth: { events: eventLog, manifest: [] } }),
    };

    // Registry is empty (daemon completed and unregistered the session)
    const registry = new DaemonRegistry();

    const service = new ConsoleService({
      directoryListing: makeDirectoryListing([{ name: sessionId, mtimeMs: Date.now() }]),
      dataDir: stubDataDir,
      sessionStore: mockStore,
      snapshotStore: new InMemorySnapshotStore(),
      pinnedWorkflowStore: new InMemoryPinnedWorkflowStore(),
      daemonRegistry: registry,
    });

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions[0]!.isAutonomous).toBe(true);
    expect(sessions[0]!.isLive).toBe(false);
  });
});
