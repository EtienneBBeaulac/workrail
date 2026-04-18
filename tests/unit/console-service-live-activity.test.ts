/**
 * Tests for liveActivity in ConsoleService.getSessionDetail().
 *
 * liveActivity is populated when:
 * 1. DaemonRegistry has a live entry for the session (recent heartbeat)
 * 2. readLiveActivity successfully reads today's daemon event log file
 *
 * Returns [] when the log is readable but has no matching tool_called events.
 * Returns null when the log file cannot be read (ENOENT, permission error, etc.).
 *
 * Test strategy:
 * - Inject a DaemonRegistry with a live or absent entry
 * - Mock node:fs/promises stat + readFile to control what readLiveActivity reads
 * - Provide minimal event log (session_created + run_started + node_created)
 *   so getSessionDetail produces a valid ConsoleSessionDetail
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { okAsync } from 'neverthrow';

// ---------------------------------------------------------------------------
// Mock node:fs/promises before any module imports that use it.
//
// WHY vi.hoisted + vi.mock: node:fs/promises is an ESM module with non-configurable
// exports. vi.spyOn cannot patch it at runtime. vi.mock() with vi.hoisted() is the
// only supported way to intercept these calls in vitest ESM mode.
// ---------------------------------------------------------------------------

const { mockStat, mockReadFile, mockOpen } = vi.hoisted(() => ({
  mockStat: vi.fn(),
  mockReadFile: vi.fn(),
  mockOpen: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: mockStat,
    readFile: mockReadFile,
    open: mockOpen,
  };
});

// Import after mock setup -- these will use the mocked fs.
import { ConsoleService } from '../../src/v2/usecases/console-service.js';
import { DaemonRegistry } from '../../src/v2/infra/in-memory/daemon-registry/index.js';
import {
  InMemorySnapshotStore,
  InMemoryPinnedWorkflowStore,
} from '../fakes/v2/index.js';
import type { DirectoryListingPortV2 } from '../../src/v2/ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../src/v2/ports/data-dir.port.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../../src/v2/ports/session-event-log-store.port.js';
import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const stubDirectoryListing: DirectoryListingPortV2 = {
  readdir: () => okAsync([]),
  readdirWithMtime: () => okAsync([]),
};

const stubDataDir: DataDirPortV2 = {
  rememberedRootsPath: () => '/fake/roots.json',
  rememberedRootsLockPath: () => '/fake/roots.lock',
  pinnedWorkflowsDir: () => '/fake/workflows',
  pinnedWorkflowPath: () => '/fake/workflow.json',
  snapshotsDir: () => '/fake/snapshots',
  snapshotPath: () => '/fake/snapshot.json',
  keysDir: () => '/fake/keys',
  keyringPath: () => '/fake/keyring.json',
  sessionsDir: () => '/fake/sessions',
  sessionDir: () => '/fake/session',
  sessionEventsDir: () => '/fake/session/events',
  sessionManifestPath: () => '/fake/session/manifest.jsonl',
  sessionLockPath: () => '/fake/session/lock',
  tokenIndexPath: () => '/fake/token-index.json',
} as unknown as DataDirPortV2;

// ---------------------------------------------------------------------------
// Event log helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex digest placeholder (matches what node_created events require). */
const FAKE_HASH = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';

/** Minimal valid events so ConsoleService can project a session detail. */
function makeMinimalEvents(sessionId: string): DomainEventV1[] {
  return [
    {
      v: 1,
      eventId: 'evt_session',
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: `session_created:${sessionId}`,
      data: {},
    } as DomainEventV1,
    {
      v: 1,
      eventId: 'evt_run',
      eventIndex: 1,
      sessionId,
      kind: 'run_started',
      dedupeKey: `run_started:${sessionId}:run_1`,
      scope: { runId: 'run_1' },
      data: {
        workflowId: 'test-workflow',
        workflowHash: FAKE_HASH,
        workflowSourceKind: 'project',
        workflowSourceRef: 'workflows/test.json',
      },
    } as DomainEventV1,
    {
      v: 1,
      eventId: 'evt_node',
      eventIndex: 2,
      sessionId,
      kind: 'node_created',
      dedupeKey: `node_created:${sessionId}:run_1:node_1`,
      scope: { runId: 'run_1', nodeId: 'node_1' },
      data: {
        nodeKind: 'step',
        parentNodeId: null,
        workflowHash: FAKE_HASH,
        snapshotRef: FAKE_HASH,
      },
    } as DomainEventV1,
  ];
}

/** Build a DaemonRegistry stub with a live entry for the given session. */
function makeLiveRegistry(sessionId: string): DaemonRegistry {
  return {
    register: () => {},
    heartbeat: () => {},
    unregister: () => {},
    snapshot: () => new Map([
      [sessionId, {
        sessionId,
        workflowId: 'test-workflow',
        startedAtMs: Date.now() - 1000,
        lastHeartbeatMs: Date.now() - 1000, // 1 second ago -- well within 10m threshold
        status: 'running' as const,
      }],
    ]),
  } as unknown as DaemonRegistry;
}

/** Build a ConsoleService with injected session store and optional registry. */
function makeService(
  sessionId: string,
  events: DomainEventV1[],
  daemonRegistry?: DaemonRegistry,
): ConsoleService {
  const sessionStore: SessionEventLogReadonlyStorePortV2 = {
    load: (_id) => okAsync({ events, manifest: [] }),
    loadValidatedPrefix: (_id) => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
  };

  return new ConsoleService({
    directoryListing: stubDirectoryListing,
    dataDir: stubDataDir,
    sessionStore,
    snapshotStore: new InMemorySnapshotStore(),
    pinnedWorkflowStore: new InMemoryPinnedWorkflowStore(),
    daemonRegistry,
  });
}

/** The path that readLiveActivity looks for today's log file. */
function todayLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(os.homedir(), '.workrail', 'events', 'daemon', `${date}.jsonl`);
}

/** Build JSONL content with tool_called events for the given session. */
function makeToolCalledJSONL(sessionId: string, toolNames: string[]): string {
  return toolNames
    .map((toolName, i) =>
      JSON.stringify({
        kind: 'tool_called',
        workrailSessionId: sessionId,
        toolName,
        summary: `summary ${i}`,
        ts: 1_700_000_000_000 + i,
      })
    )
    .join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Tests (F2)
// ---------------------------------------------------------------------------

describe('ConsoleService liveActivity', () => {
  it('liveActivity is null when session is not in the registry', async () => {
    const sessionId = 'sess_live001aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);

    // Empty registry -- session is not live, readLiveActivity is never called.
    const service = makeService(sessionId, events, new DaemonRegistry());

    const result = await service.getSessionDetail(sessionId);
    expect(result.isOk()).toBe(true);
    const detail = result._unsafeUnwrap();
    expect(detail.liveActivity).toBeNull();
  });

  it('populates liveActivity with last 5 tool_called events when session is live', async () => {
    const sessionId = 'sess_live002aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);
    const registry = makeLiveRegistry(sessionId);

    // 7 events in the log -- expect only the last 5 (slice(-5)).
    const toolNames = ['Bash', 'Read', 'Write', 'Bash', 'Read', 'continue_workflow', 'Bash'];
    const jsonlContent = makeToolCalledJSONL(sessionId, toolNames);
    const logPath = todayLogPath();

    mockStat.mockImplementation(async (p: unknown) => {
      if (p === logPath) return { size: Buffer.byteLength(jsonlContent) };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (p === logPath) return jsonlContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const service = makeService(sessionId, events, registry);
    const result = await service.getSessionDetail(sessionId);
    expect(result.isOk()).toBe(true);

    const detail = result._unsafeUnwrap();
    expect(detail.liveActivity).not.toBeNull();
    // Last 5 of 7: indices 2-6 → ['Write', 'Bash', 'Read', 'continue_workflow', 'Bash']
    expect(detail.liveActivity).toHaveLength(5);
    const names = detail.liveActivity!.map((a) => a.toolName);
    expect(names).toEqual(['Write', 'Bash', 'Read', 'continue_workflow', 'Bash']);
  });

  it('returns liveActivity: null when the log file cannot be read (missing file)', async () => {
    const sessionId = 'sess_live003aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);
    const registry = makeLiveRegistry(sessionId);

    // stat throws ENOENT -- log file does not exist.
    mockStat.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });

    const service = makeService(sessionId, events, registry);
    const result = await service.getSessionDetail(sessionId);
    expect(result.isOk()).toBe(true);

    const detail = result._unsafeUnwrap();
    // null means the log file could not be read.
    expect(detail.liveActivity).toBeNull();
  });

  it('returns liveActivity: [] when log is readable but no events match workrailSessionId', async () => {
    const sessionId = 'sess_live004aaaaaaaaaaaaaaaa';
    const differentSessionId = 'sess_other00aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);
    const registry = makeLiveRegistry(sessionId);

    // Log contains events for a different session -- none match sessionId.
    const jsonlContent = makeToolCalledJSONL(differentSessionId, ['Bash', 'Read']);
    const logPath = todayLogPath();

    mockStat.mockImplementation(async (p: unknown) => {
      if (p === logPath) return { size: Buffer.byteLength(jsonlContent) };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (p === logPath) return jsonlContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const service = makeService(sessionId, events, registry);
    const result = await service.getSessionDetail(sessionId);
    expect(result.isOk()).toBe(true);

    const detail = result._unsafeUnwrap();
    // [] means log was readable but no tool_called events matched this session.
    expect(detail.liveActivity).toEqual([]);
  });
});
