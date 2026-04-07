/**
 * Tests for the in-process session summary cache in ConsoleService.
 *
 * Design: ConsoleService caches ConsoleSessionSummary results keyed by
 * sessionId with the session's mtime stored alongside. On subsequent calls,
 * if the mtime matches the cached entry the store is not consulted again.
 * When the mtime changes the entry is replaced (cache invalidation).
 *
 * These tests intentionally use the real ConsoleService (not a test double)
 * so they validate end-to-end behavior including the cache and projection
 * chain, following the repo's "prefer fakes over mocks" principle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { okAsync, errAsync } from 'neverthrow';
import { ConsoleService } from '../../../src/v2/usecases/console-service.js';
import type { DirectoryListingPortV2, DirEntryWithMtime } from '../../../src/v2/ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../../src/v2/ports/data-dir.port.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../../../src/v2/ports/session-event-log-store.port.js';
import type { SnapshotStorePortV2 } from '../../../src/v2/ports/snapshot-store.port.js';
import type { PinnedWorkflowStorePortV2 } from '../../../src/v2/ports/pinned-workflow-store.port.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';
import * as os from 'os';
import * as path from 'path';

const tmp = os.tmpdir();

// ---------------------------------------------------------------------------
// Minimal event fixture -- produces a valid DAG (session + run + node)
// ---------------------------------------------------------------------------

function makeMinimalEvents(sessionId: string): DomainEventV1[] {
  return [
    {
      v: 1,
      eventId: `evt_session_${sessionId}`,
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: `session_created:${sessionId}`,
      data: {},
    } as DomainEventV1,
    {
      v: 1,
      eventId: `evt_run_${sessionId}`,
      eventIndex: 1,
      sessionId,
      kind: 'run_started',
      dedupeKey: `run_started:${sessionId}:run_1`,
      scope: { runId: 'run_1' },
      data: {
        workflowId: 'project.example',
        workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        workflowSourceKind: 'project',
        workflowSourceRef: 'workflows/example.json',
      },
    } as DomainEventV1,
    {
      v: 1,
      eventId: `evt_node_${sessionId}`,
      eventIndex: 2,
      sessionId,
      kind: 'node_created',
      dedupeKey: `node_created:${sessionId}:run_1:node_1`,
      scope: { runId: 'run_1', nodeId: 'node_1' },
      data: {
        nodeKind: 'step',
        parentNodeId: null,
        workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        snapshotRef: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
      },
    } as DomainEventV1,
  ];
}

// ---------------------------------------------------------------------------
// Fake port builders
// ---------------------------------------------------------------------------

function makeDataDir(): DataDirPortV2 {
  return {
    rememberedRootsPath: () => path.join(tmp, 'roots.json'),
    rememberedRootsLockPath: () => path.join(tmp, 'roots.lock'),
    pinnedWorkflowsDir: () => path.join(tmp, 'workflows'),
    pinnedWorkflowPath: () => path.join(tmp, 'workflow.json'),
    snapshotsDir: () => path.join(tmp, 'snapshots'),
    snapshotPath: () => path.join(tmp, 'snapshot.json'),
    keysDir: () => path.join(tmp, 'keys'),
    keyringPath: () => path.join(tmp, 'keyring.json'),
    sessionsDir: () => path.join(tmp, 'sessions'),
    sessionDir: () => path.join(tmp, 'session'),
    sessionEventsDir: () => path.join(tmp, 'session/events'),
    sessionManifestPath: () => path.join(tmp, 'session/manifest.jsonl'),
    sessionLockPath: () => path.join(tmp, 'session/lock'),
    tokenIndexPath: () => path.join(tmp, 'token-index.json'),
  };
}

function makeSnapshotStore(): SnapshotStorePortV2 {
  return {
    putExecutionSnapshotV1: () => { throw new Error('not used'); },
    getExecutionSnapshotV1: () => okAsync(null),
  };
}

function makePinnedWorkflowStore(): PinnedWorkflowStorePortV2 {
  return {
    get: () => okAsync(null),
    put: () => okAsync(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsoleService session summary cache', () => {
  const SESSION_ID = 'sess_cache_test_abc123';
  const MTIME_V1 = 1_700_000_000_000;
  const MTIME_V2 = 1_700_000_001_000; // 1 second later

  const singleSessionEntry: DirEntryWithMtime[] = [
    { name: SESSION_ID, mtimeMs: MTIME_V1 },
  ];

  it('cache miss: first call always loads from the session store', async () => {
    const events = makeMinimalEvents(SESSION_ID);
    let loadCallCount = 0;

    const sessionStore: SessionEventLogReadonlyStorePortV2 = {
      load: () => {
        loadCallCount++;
        return okAsync({ events, manifest: [] });
      },
      loadValidatedPrefix: () => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
    };

    const directoryListing: DirectoryListingPortV2 = {
      readdir: () => okAsync([]),
      readdirWithMtime: () => okAsync(singleSessionEntry),
    };

    const service = new ConsoleService({
      directoryListing,
      dataDir: makeDataDir(),
      sessionStore,
      snapshotStore: makeSnapshotStore(),
      pinnedWorkflowStore: makePinnedWorkflowStore(),
    });

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);
    expect(loadCallCount).toBe(1);
  });

  it('cache hit: second call with same mtime does not reload from the store', async () => {
    const events = makeMinimalEvents(SESSION_ID);
    let loadCallCount = 0;

    const sessionStore: SessionEventLogReadonlyStorePortV2 = {
      load: () => {
        loadCallCount++;
        return okAsync({ events, manifest: [] });
      },
      loadValidatedPrefix: () => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
    };

    const directoryListing: DirectoryListingPortV2 = {
      readdir: () => okAsync([]),
      readdirWithMtime: () => okAsync(singleSessionEntry),
    };

    const service = new ConsoleService({
      directoryListing,
      dataDir: makeDataDir(),
      sessionStore,
      snapshotStore: makeSnapshotStore(),
      pinnedWorkflowStore: makePinnedWorkflowStore(),
    });

    // First call -- cache miss
    const first = await service.getSessionList();
    expect(first.isOk()).toBe(true);
    expect(loadCallCount).toBe(1);

    // Second call with same mtime -- should hit cache
    const second = await service.getSessionList();
    expect(second.isOk()).toBe(true);
    expect(loadCallCount).toBe(1); // store NOT called again
  });

  it('cache invalidation: changed mtime re-projects and updates cache', async () => {
    const events = makeMinimalEvents(SESSION_ID);
    let loadCallCount = 0;

    const sessionStore: SessionEventLogReadonlyStorePortV2 = {
      load: () => {
        loadCallCount++;
        return okAsync({ events, manifest: [] });
      },
      loadValidatedPrefix: () => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
    };

    // Start with MTIME_V1, then switch to MTIME_V2
    let currentMtime = MTIME_V1;
    const directoryListing: DirectoryListingPortV2 = {
      readdir: () => okAsync([]),
      readdirWithMtime: () => okAsync([{ name: SESSION_ID, mtimeMs: currentMtime }]),
    };

    const service = new ConsoleService({
      directoryListing,
      dataDir: makeDataDir(),
      sessionStore,
      snapshotStore: makeSnapshotStore(),
      pinnedWorkflowStore: makePinnedWorkflowStore(),
    });

    // First call at MTIME_V1
    const first = await service.getSessionList();
    expect(first.isOk()).toBe(true);
    expect(loadCallCount).toBe(1);

    // Simulate session update: mtime advances
    currentMtime = MTIME_V2;

    // Third call at MTIME_V2 -- cache entry is stale, must re-project
    const second = await service.getSessionList();
    expect(second.isOk()).toBe(true);
    expect(loadCallCount).toBe(2); // store called again because mtime changed
  });

  it('correctness parity: cached result equals what fresh projection returns', async () => {
    const events = makeMinimalEvents(SESSION_ID);

    const sessionStore: SessionEventLogReadonlyStorePortV2 = {
      load: () => okAsync({ events, manifest: [] }),
      loadValidatedPrefix: () => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
    };

    const directoryListing: DirectoryListingPortV2 = {
      readdir: () => okAsync([]),
      readdirWithMtime: () => okAsync(singleSessionEntry),
    };

    const service = new ConsoleService({
      directoryListing,
      dataDir: makeDataDir(),
      sessionStore,
      snapshotStore: makeSnapshotStore(),
      pinnedWorkflowStore: makePinnedWorkflowStore(),
    });

    // First call -- fresh projection
    const first = await service.getSessionList();
    expect(first.isOk()).toBe(true);
    const freshSessions = first.isOk() ? first.value.sessions : [];

    // Second call -- from cache
    const second = await service.getSessionList();
    expect(second.isOk()).toBe(true);
    const cachedSessions = second.isOk() ? second.value.sessions : [];

    // Results must be deeply equal
    expect(cachedSessions).toEqual(freshSessions);
    expect(cachedSessions).toHaveLength(1);
    expect(cachedSessions[0]?.sessionId).toBe(SESSION_ID);
  });

  it('null results (load errors) are not cached and do not appear in sessions list', async () => {
    let loadCallCount = 0;

    const sessionStore: SessionEventLogReadonlyStorePortV2 = {
      load: () => {
        loadCallCount++;
        // Simulate a load failure
        return errAsync(new Error('disk read failed'));
      },
      loadValidatedPrefix: () => okAsync({ kind: 'complete', truth: { events: [], manifest: [] } }),
    };

    const directoryListing: DirectoryListingPortV2 = {
      readdir: () => okAsync([]),
      readdirWithMtime: () => okAsync(singleSessionEntry),
    };

    const service = new ConsoleService({
      directoryListing,
      dataDir: makeDataDir(),
      sessionStore,
      snapshotStore: makeSnapshotStore(),
      pinnedWorkflowStore: makePinnedWorkflowStore(),
    });

    // First call -- load fails, session should be absent from list
    const first = await service.getSessionList();
    expect(first.isOk()).toBe(true);
    const firstSessions = first.isOk() ? first.value.sessions : ['unexpected'];
    expect(firstSessions).toHaveLength(0);
    expect(loadCallCount).toBe(1);

    // Second call -- error is NOT cached, store is called again
    const second = await service.getSessionList();
    expect(second.isOk()).toBe(true);
    const secondSessions = second.isOk() ? second.value.sessions : ['unexpected'];
    expect(secondSessions).toHaveLength(0);
    expect(loadCallCount).toBe(2); // retried, not cached
  });
});
