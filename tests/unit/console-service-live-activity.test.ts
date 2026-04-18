/**
 * Tests for liveActivity and isSessionLiveFromEventLog in ConsoleService.getSessionDetail().
 *
 * isLive is now derived from the daemon event log:
 * - session_started event present for workrailSessionId AND session_completed absent => isLive=true
 * - session_completed present => isLive=false
 * - log unreadable (ENOENT, etc.) => isLive=false (safe default)
 *
 * liveActivity is populated when isLive=true and readLiveActivity returns entries.
 * Returns [] when the log is readable but has no matching tool_called events.
 * Returns null when the log file cannot be read (ENOENT, permission error, etc.).
 *
 * Test strategy:
 * - Mock node:fs/promises stat + readFile to control what isSessionLiveFromEventLog
 *   and readLiveActivity read
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

/** Build a ConsoleService with injected session store (no DaemonRegistry). */
function makeService(
  sessionId: string,
  events: DomainEventV1[],
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
    // daemonRegistry intentionally omitted -- isLive now comes from event log
  });
}

/** The path that isSessionLiveFromEventLog / readLiveActivity look for today's log file. */
function todayLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(os.homedir(), '.workrail', 'events', 'daemon', `${date}.jsonl`);
}

/**
 * Build a JSONL log with session lifecycle events and optional tool_called entries.
 *
 * @param sessionId - The workrailSessionId to use in events.
 * @param started - Whether to include a session_started event.
 * @param completed - Whether to include a session_completed event.
 * @param toolNames - Tool names for additional tool_called events.
 */
function makeEventLogJSONL(
  sessionId: string,
  opts: {
    started?: boolean;
    completed?: boolean;
    toolNames?: string[];
  } = {},
): string {
  const lines: string[] = [];
  const { started = false, completed = false, toolNames = [] } = opts;

  if (started) {
    lines.push(JSON.stringify({
      kind: 'session_started',
      workrailSessionId: sessionId,
      sessionId: 'internal-daemon-id',
      workflowId: 'test-workflow',
      workspacePath: '/tmp/test',
      ts: 1_700_000_000_000,
    }));
  }

  toolNames.forEach((toolName, i) => {
    lines.push(JSON.stringify({
      kind: 'tool_called',
      workrailSessionId: sessionId,
      toolName,
      summary: `summary ${i}`,
      ts: 1_700_000_001_000 + i,
    }));
  });

  if (completed) {
    lines.push(JSON.stringify({
      kind: 'session_completed',
      workrailSessionId: sessionId,
      sessionId: 'internal-daemon-id',
      workflowId: 'test-workflow',
      outcome: 'success',
      ts: 1_700_000_002_000,
    }));
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Tests: isSessionLiveFromEventLog (via getSessionDetail)
// ---------------------------------------------------------------------------

describe('ConsoleService isSessionLiveFromEventLog', () => {
  it('isLive=false and liveActivity=null when log file does not exist (ENOENT)', async () => {
    const sessionId = 'sess_live001aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);

    mockStat.mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });

    const service = makeService(sessionId, events);
    const result = await service.getSessionDetail(sessionId);

    expect(result.isOk()).toBe(true);
    const detail = result._unsafeUnwrap();
    expect(detail.liveActivity).toBeNull();
  });

  it('isLive=false and liveActivity=null when log contains no session_started for this session', async () => {
    const sessionId = 'sess_live002aaaaaaaaaaaaaaaa';
    const differentSessionId = 'sess_other00aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);

    // Log has events for a different session only.
    const jsonlContent = makeEventLogJSONL(differentSessionId, { started: true, toolNames: ['Bash'] });
    const logPath = todayLogPath();

    mockStat.mockImplementation(async (p: unknown) => {
      if (p === logPath) return { size: Buffer.byteLength(jsonlContent) };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (p === logPath) return jsonlContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const service = makeService(sessionId, events);
    const result = await service.getSessionDetail(sessionId);

    expect(result.isOk()).toBe(true);
    const detail = result._unsafeUnwrap();
    expect(detail.liveActivity).toBeNull();
  });

  it('isLive=false and liveActivity=null when session_completed follows session_started', async () => {
    const sessionId = 'sess_live003aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);

    // Both started and completed -- session is not live.
    const jsonlContent = makeEventLogJSONL(sessionId, {
      started: true,
      completed: true,
      toolNames: ['Bash'],
    });
    const logPath = todayLogPath();

    mockStat.mockImplementation(async (p: unknown) => {
      if (p === logPath) return { size: Buffer.byteLength(jsonlContent) };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (p === logPath) return jsonlContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const service = makeService(sessionId, events);
    const result = await service.getSessionDetail(sessionId);

    expect(result.isOk()).toBe(true);
    const detail = result._unsafeUnwrap();
    // session_completed present => isLive=false => liveActivity=null
    expect(detail.liveActivity).toBeNull();
  });

  it('isLive=true and liveActivity populated when session_started exists without session_completed', async () => {
    const sessionId = 'sess_live004aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);

    const toolNames = ['Bash', 'Read', 'Write'];
    const jsonlContent = makeEventLogJSONL(sessionId, { started: true, toolNames });
    const logPath = todayLogPath();

    mockStat.mockImplementation(async (p: unknown) => {
      if (p === logPath) return { size: Buffer.byteLength(jsonlContent) };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (p === logPath) return jsonlContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const service = makeService(sessionId, events);
    const result = await service.getSessionDetail(sessionId);

    expect(result.isOk()).toBe(true);
    const detail = result._unsafeUnwrap();
    expect(detail.liveActivity).not.toBeNull();
    expect(detail.liveActivity).toHaveLength(3);
    const names = detail.liveActivity!.map((a) => a.toolName);
    expect(names).toEqual(['Bash', 'Read', 'Write']);
  });

  it('returns last 5 tool_called events when session is live with more than 5 events', async () => {
    const sessionId = 'sess_live005aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);

    // 7 tool events -- expect only the last 5 (slice(-5)).
    const toolNames = ['Bash', 'Read', 'Write', 'Bash', 'Read', 'continue_workflow', 'Bash'];
    const jsonlContent = makeEventLogJSONL(sessionId, { started: true, toolNames });
    const logPath = todayLogPath();

    mockStat.mockImplementation(async (p: unknown) => {
      if (p === logPath) return { size: Buffer.byteLength(jsonlContent) };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (p === logPath) return jsonlContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const service = makeService(sessionId, events);
    const result = await service.getSessionDetail(sessionId);

    expect(result.isOk()).toBe(true);
    const detail = result._unsafeUnwrap();
    expect(detail.liveActivity).not.toBeNull();
    // Last 5 of 7: indices 2-6 => ['Write', 'Bash', 'Read', 'continue_workflow', 'Bash']
    expect(detail.liveActivity).toHaveLength(5);
    const names = detail.liveActivity!.map((a) => a.toolName);
    expect(names).toEqual(['Write', 'Bash', 'Read', 'continue_workflow', 'Bash']);
  });

  it('returns liveActivity: [] when session is live but no tool_called events in log', async () => {
    const sessionId = 'sess_live006aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);

    // session_started but no tool_called events yet.
    const jsonlContent = makeEventLogJSONL(sessionId, { started: true, toolNames: [] });
    const logPath = todayLogPath();

    mockStat.mockImplementation(async (p: unknown) => {
      if (p === logPath) return { size: Buffer.byteLength(jsonlContent) };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (p === logPath) return jsonlContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const service = makeService(sessionId, events);
    const result = await service.getSessionDetail(sessionId);

    expect(result.isOk()).toBe(true);
    const detail = result._unsafeUnwrap();
    // [] means isLive=true but no tool_called events found yet.
    expect(detail.liveActivity).toEqual([]);
  });

  it('isLive=true survives console restart (no DaemonRegistry needed)', async () => {
    // This test verifies the key behavioral fix: a session with session_started but
    // no session_completed is correctly identified as live even without DaemonRegistry.
    // Previously, a console restart would clear DaemonRegistry and show isLive=null.
    const sessionId = 'sess_live007aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);

    const jsonlContent = makeEventLogJSONL(sessionId, { started: true, toolNames: ['Bash'] });
    const logPath = todayLogPath();

    mockStat.mockImplementation(async (p: unknown) => {
      if (p === logPath) return { size: Buffer.byteLength(jsonlContent) };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (p === logPath) return jsonlContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    // No DaemonRegistry injected -- simulates standalone console after restart.
    const service = makeService(sessionId, events);
    const result = await service.getSessionDetail(sessionId);

    expect(result.isOk()).toBe(true);
    const detail = result._unsafeUnwrap();
    // Must show liveActivity (isLive=true), not null, even without DaemonRegistry.
    expect(detail.liveActivity).not.toBeNull();
    expect(detail.liveActivity).toHaveLength(1);
    expect(detail.liveActivity![0]!.toolName).toBe('Bash');
  });

  it('isLive=false when log contains only events for a different session', async () => {
    const sessionId = 'sess_live008aaaaaaaaaaaaaaaa';
    const otherSessionId = 'sess_other01aaaaaaaaaaaaaaaa';
    const events = makeMinimalEvents(sessionId);

    // Other session is live, but not ours.
    const jsonlContent = makeEventLogJSONL(otherSessionId, { started: true, toolNames: ['Bash'] });
    const logPath = todayLogPath();

    mockStat.mockImplementation(async (p: unknown) => {
      if (p === logPath) return { size: Buffer.byteLength(jsonlContent) };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (p === logPath) return jsonlContent;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const service = makeService(sessionId, events);
    const result = await service.getSessionDetail(sessionId);

    expect(result.isOk()).toBe(true);
    const detail = result._unsafeUnwrap();
    expect(detail.liveActivity).toBeNull();
  });
});
