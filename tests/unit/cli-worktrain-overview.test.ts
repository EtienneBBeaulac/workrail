/**
 * Unit tests for executeWorktrainOverviewCommand
 *
 * Tests cover:
 * - Active sessions (in-progress within 2h threshold)
 * - Recent sessions (completed within 24h)
 * - Empty state (no sessions)
 * - JSON output flag
 * - Session title fallback logic
 * - Threshold boundary conditions
 *
 * Uses fake deps (in-memory ConsoleService fake). No vi.mock() -- follows the
 * repo pattern of "prefer fakes over mocks".
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import {
  executeWorktrainOverviewCommand,
  type WorktrainOverviewCommandDeps,
  type WorktrainOverviewCommandOpts,
  type StatusDataPacket,
} from '../../src/cli/commands/worktrain-overview.js';
import type { ConsoleService } from '../../src/v2/usecases/console-service.js';
import type { ConsoleSessionSummary, ConsoleSessionListResponse } from '../../src/v2/usecases/console-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ConsoleSessionSummary stub for testing.
 *
 * Fields that are explicitly provided in `overrides` (including null) win over
 * the defaults. Only truly absent keys fall back to their defaults.
 * This lets tests set workflowId or workflowName to null explicitly.
 */
function makeSession(
  overrides: Partial<ConsoleSessionSummary> & { sessionId: string },
): ConsoleSessionSummary {
  const defaults: ConsoleSessionSummary = {
    sessionId: overrides.sessionId,
    sessionTitle: null,
    workflowId: 'wr.coding-task',
    workflowName: null,
    workflowHash: null,
    runId: 'run-1',
    status: 'in_progress',
    health: 'healthy',
    nodeCount: 3,
    edgeCount: 2,
    tipCount: 1,
    hasUnresolvedGaps: false,
    recapSnippet: null,
    gitBranch: null,
    repoRoot: null,
    lastModifiedMs: Date.now(),
    isAutonomous: true,
    isLive: false,
  };
  // Spread overrides on top of defaults so explicit null values win.
  return { ...defaults, ...overrides };
}

/** Build a fake ConsoleService that returns a fixed session list. */
function makeFakeConsoleService(sessions: ConsoleSessionSummary[]): ConsoleService {
  return {
    getSessionList: async () => ({
      isOk: () => true,
      value: { sessions, totalCount: sessions.length } as ConsoleSessionListResponse,
      match: (onOk: (v: ConsoleSessionListResponse) => void) => onOk({ sessions, totalCount: sessions.length }),
    }),
    getSessionsDir: () => '/fake/sessions',
    getSessionDetail: async () => { throw new Error('not used in overview tests'); },
    getNodeDetail: async () => { throw new Error('not used in overview tests'); },
  } as unknown as ConsoleService;
}

/** Build a fake ConsoleService that returns an error. */
function makeErrorConsoleService(): ConsoleService {
  return {
    getSessionList: async () => ({
      isOk: () => false,
      isErr: () => true,
      error: { code: 'ENUMERATION_FAILED', message: 'sessions dir not found' },
      match: (_onOk: unknown, onErr: (e: { code: string; message: string }) => void) =>
        onErr({ code: 'ENUMERATION_FAILED', message: 'sessions dir not found' }),
    }),
    getSessionsDir: () => '/fake/sessions',
    getSessionDetail: async () => { throw new Error('not used'); },
    getNodeDetail: async () => { throw new Error('not used'); },
  } as unknown as ConsoleService;
}

/** Fixed "now" timestamp for deterministic tests: 2026-04-18T14:32:00.000Z */
const NOW_MS = new Date('2026-04-18T14:32:00.000Z').getTime();

/** 1 hour in milliseconds. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Build a standard deps object backed by the given ConsoleService. */
function makeDeps(
  consoleService: ConsoleService,
  overrides: Partial<WorktrainOverviewCommandDeps> = {},
): { deps: WorktrainOverviewCommandDeps; lines: string[] } {
  const lines: string[] = [];
  const deps: WorktrainOverviewCommandDeps = {
    now: () => NOW_MS,
    buildConsoleService: () => consoleService,
    homedir: () => '/home/testuser',
    joinPath: path.join,
    print: (line: string) => lines.push(line),
    getDataDirEnv: () => undefined,
    // Default: no events today. Tests that need specific daemon status pass their
    // own readEventLog via overrides.
    readEventLog: () => Promise.resolve(''),
    ...overrides,
  };
  return { deps, lines };
}

// ---------------------------------------------------------------------------
// Tests: empty state
// ---------------------------------------------------------------------------

describe('executeWorktrainOverviewCommand -- empty state', () => {
  it('prints "No recent sessions" when no sessions exist', async () => {
    const { deps, lines } = makeDeps(makeFakeConsoleService([]));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('No recent sessions'))).toBe(true);
  });

  it('prints "worktrain daemon" hint in empty state', async () => {
    const { deps, lines } = makeDeps(makeFakeConsoleService([]));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('worktrain daemon'))).toBe(true);
  });

  it('gracefully handles ConsoleService enumeration error (shows empty)', async () => {
    const { deps, lines } = makeDeps(makeErrorConsoleService());
    // Should not throw -- should degrade gracefully.
    await expect(executeWorktrainOverviewCommand(deps)).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('No recent sessions'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: active sessions
// ---------------------------------------------------------------------------

describe('executeWorktrainOverviewCommand -- active sessions', () => {
  it('shows in_progress session modified 30m ago as ACTIVE', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_active1',
        sessionTitle: 'Implementing GitHub polling adapter',
        status: 'in_progress',
        lastModifiedMs: NOW_MS - 30 * 60_000, // 30 minutes ago
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('ACTIVE'))).toBe(true);
    expect(lines.some((l) => l.includes('Implementing GitHub polling adapter'))).toBe(true);
    expect(lines.some((l) => l.includes('in_progress'))).toBe(true);
  });

  it('shows running time for active session', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_active2',
        sessionTitle: 'Some task',
        status: 'in_progress',
        lastModifiedMs: NOW_MS - 22 * 60_000, // 22 minutes ago
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('22m'))).toBe(true);
  });

  it('does NOT show active session modified more than 2h ago by default', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_old_active',
        sessionTitle: 'Old in-progress task',
        status: 'in_progress',
        lastModifiedMs: NOW_MS - 3 * ONE_HOUR_MS, // 3 hours ago -- outside 2h threshold
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('Old in-progress task'))).toBe(false);
  });

  it('shows blocked session within threshold as active', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_blocked',
        sessionTitle: 'Blocked on approval',
        status: 'blocked',
        lastModifiedMs: NOW_MS - 10 * 60_000,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('Blocked on approval'))).toBe(true);
    expect(lines.some((l) => l.includes('ACTIVE'))).toBe(true);
    expect(lines.some((l) => l.includes('blocked'))).toBe(true);
  });

  it('shows dormant session within threshold as active', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_dormant',
        sessionTitle: 'Dormant task',
        status: 'dormant',
        lastModifiedMs: NOW_MS - 45 * 60_000,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('Dormant task'))).toBe(true);
    expect(lines.some((l) => l.includes('dormant'))).toBe(true);
  });

  it('shows count in ACTIVE header', async () => {
    const sessions = [
      makeSession({ sessionId: 'sess_a1', status: 'in_progress', lastModifiedMs: NOW_MS - 10 * 60_000 }),
      makeSession({ sessionId: 'sess_a2', status: 'in_progress', lastModifiedMs: NOW_MS - 20 * 60_000 }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('ACTIVE (2 sessions)'))).toBe(true);
  });

  it('uses singular "session" in ACTIVE header for count of 1', async () => {
    const sessions = [
      makeSession({ sessionId: 'sess_a1', status: 'in_progress', lastModifiedMs: NOW_MS - 10 * 60_000 }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('ACTIVE (1 session)'))).toBe(true);
    expect(lines.some((l) => l.includes('ACTIVE (1 sessions)'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: recent sessions
// ---------------------------------------------------------------------------

describe('executeWorktrainOverviewCommand -- recent sessions', () => {
  it('shows completed session from 3h ago in RECENT', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_done1',
        sessionTitle: 'worktrain init onboarding command',
        status: 'complete',
        lastModifiedMs: NOW_MS - 3 * ONE_HOUR_MS,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('RECENT'))).toBe(true);
    expect(lines.some((l) => l.includes('worktrain init onboarding command'))).toBe(true);
    expect(lines.some((l) => l.includes('done'))).toBe(true);
    expect(lines.some((l) => l.includes('3h ago'))).toBe(true);
  });

  it('shows complete_with_gaps session in RECENT', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_gaps',
        sessionTitle: 'Task with gaps',
        status: 'complete_with_gaps',
        lastModifiedMs: NOW_MS - 2 * ONE_HOUR_MS,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('Task with gaps'))).toBe(true);
    expect(lines.some((l) => l.includes('RECENT'))).toBe(true);
  });

  it('does NOT show completed session older than 24h', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_old',
        sessionTitle: 'Very old task',
        status: 'complete',
        lastModifiedMs: NOW_MS - 25 * ONE_HOUR_MS, // 25 hours ago
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('Very old task'))).toBe(false);
  });

  it('shows RECENT count in header', async () => {
    const sessions = [
      makeSession({ sessionId: 'sess_d1', status: 'complete', lastModifiedMs: NOW_MS - ONE_HOUR_MS }),
      makeSession({ sessionId: 'sess_d2', status: 'complete', lastModifiedMs: NOW_MS - 2 * ONE_HOUR_MS }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('RECENT') && l.includes('2 completed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: title fallback chain
// ---------------------------------------------------------------------------

describe('executeWorktrainOverviewCommand -- title resolution', () => {
  it('uses sessionTitle when available', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_t1',
        sessionTitle: 'My explicit session title',
        status: 'in_progress',
        lastModifiedMs: NOW_MS - 5 * 60_000,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('My explicit session title'))).toBe(true);
  });

  it('falls back to workflowName when sessionTitle is null', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_t2',
        sessionTitle: null,
        workflowName: 'Agentic Coding Task',
        status: 'in_progress',
        lastModifiedMs: NOW_MS - 5 * 60_000,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('Agentic Coding Task'))).toBe(true);
  });

  it('falls back to workflowId when sessionTitle and workflowName are null', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_t3',
        sessionTitle: null,
        workflowName: null,
        workflowId: 'wr.coding-task',
        status: 'in_progress',
        lastModifiedMs: NOW_MS - 5 * 60_000,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('wr.coding-task'))).toBe(true);
  });

  it('falls back to truncated sessionId when all title fields are null', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_s5o2ieem4mwypoqnn6ztzyyag4',
        sessionTitle: null,
        workflowName: null,
        workflowId: null,
        status: 'in_progress',
        lastModifiedMs: NOW_MS - 5 * 60_000,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    // Should show a truncated form of the session ID (first 20 chars + '...')
    // 'sess_s5o2ieem4mwypoqnn6ztzyyag4'.slice(0, 20) === 'sess_s5o2ieem4mwypoq'
    expect(lines.some((l) => l.includes('sess_s5o2ieem4mwypoq...'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: --json output
// ---------------------------------------------------------------------------

describe('executeWorktrainOverviewCommand -- --json output', () => {
  it('outputs a valid JSON StatusDataPacket', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_active_json',
        sessionTitle: 'Active task for JSON test',
        status: 'in_progress',
        lastModifiedMs: NOW_MS - 30 * 60_000,
      }),
      makeSession({
        sessionId: 'sess_done_json',
        sessionTitle: 'Completed task for JSON test',
        status: 'complete',
        lastModifiedMs: NOW_MS - 5 * ONE_HOUR_MS,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps, { json: true });

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as StatusDataPacket;
    expect(parsed.isDaemonless).toBe(true);
    expect(parsed.asOfMs).toBe(NOW_MS);
    expect(parsed.activeSessions).toHaveLength(1);
    expect(parsed.recentSessions).toHaveLength(1);
    expect(parsed.activeSessions[0].title).toBe('Active task for JSON test');
    expect(parsed.recentSessions[0].title).toBe('Completed task for JSON test');
  });

  it('JSON output contains session status field', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_j1',
        status: 'in_progress',
        lastModifiedMs: NOW_MS - 10 * 60_000,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps, { json: true });

    const parsed = JSON.parse(lines[0]) as StatusDataPacket;
    expect(parsed.activeSessions[0].status).toBe('active');
    expect(parsed.activeSessions[0].isComplete).toBe(false);
  });

  it('JSON output for recent sessions marks isComplete=true', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_j2',
        status: 'complete',
        lastModifiedMs: NOW_MS - 3 * ONE_HOUR_MS,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps, { json: true });

    const parsed = JSON.parse(lines[0]) as StatusDataPacket;
    expect(parsed.recentSessions[0].status).toBe('recent');
    expect(parsed.recentSessions[0].isComplete).toBe(true);
  });

  it('JSON output is empty when no sessions match', async () => {
    const { deps, lines } = makeDeps(makeFakeConsoleService([]));
    await executeWorktrainOverviewCommand(deps, { json: true });

    const parsed = JSON.parse(lines[0]) as StatusDataPacket;
    expect(parsed.activeSessions).toHaveLength(0);
    expect(parsed.recentSessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: human-readable output header
// ---------------------------------------------------------------------------

describe('executeWorktrainOverviewCommand -- header and footer', () => {
  it('always prints WorkTrain header with timestamp', async () => {
    const { deps, lines } = makeDeps(makeFakeConsoleService([]));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.startsWith('WorkTrain'))).toBe(true);
  });

  it('always prints daemon note', async () => {
    const { deps, lines } = makeDeps(makeFakeConsoleService([]));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('last-known state'))).toBe(true);
  });

  it('prints "Run worktrain console" footer when sessions exist', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_footer',
        status: 'complete',
        lastModifiedMs: NOW_MS - ONE_HOUR_MS,
      }),
    ];
    const { deps, lines } = makeDeps(makeFakeConsoleService(sessions));
    await executeWorktrainOverviewCommand(deps);

    expect(lines.some((l) => l.includes('worktrain console'))).toBe(true);
  });

  it('does NOT print "Run worktrain console" footer when no sessions', async () => {
    const { deps, lines } = makeDeps(makeFakeConsoleService([]));
    await executeWorktrainOverviewCommand(deps);

    // The only console reference in empty state is the "worktrain daemon" suggestion.
    // The "worktrain console" footer should not appear.
    const consoleFooterLines = lines.filter((l) => l.includes('worktrain console'));
    expect(consoleFooterLines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: custom thresholds
// ---------------------------------------------------------------------------

describe('executeWorktrainOverviewCommand -- custom thresholds', () => {
  it('respects custom activeThresholdMs', async () => {
    // Session modified 90 minutes ago.
    const sessions = [
      makeSession({
        sessionId: 'sess_threshold',
        sessionTitle: 'Near-threshold task',
        status: 'in_progress',
        lastModifiedMs: NOW_MS - 90 * 60_000,
      }),
    ];
    const { deps, lines: linesDefault } = makeDeps(makeFakeConsoleService(sessions));
    const { deps: deps2, lines: linesCustom } = makeDeps(makeFakeConsoleService(sessions));

    // Default threshold (2h = 120 min): session at 90m should show.
    await executeWorktrainOverviewCommand(deps);
    expect(linesDefault.some((l) => l.includes('Near-threshold task'))).toBe(true);

    // Custom threshold (60 min): session at 90m should NOT show.
    await executeWorktrainOverviewCommand(deps2, { activeThresholdMs: 60 * 60_000 });
    expect(linesCustom.some((l) => l.includes('Near-threshold task'))).toBe(false);
  });

  it('respects custom recentWindowMs', async () => {
    const sessions = [
      makeSession({
        sessionId: 'sess_recent_custom',
        sessionTitle: 'Completed 12h ago',
        status: 'complete',
        lastModifiedMs: NOW_MS - 12 * ONE_HOUR_MS,
      }),
    ];
    const { deps, lines: linesDefault } = makeDeps(makeFakeConsoleService(sessions));
    const { deps: deps2, lines: linesCustom } = makeDeps(makeFakeConsoleService(sessions));

    // Default window (24h): 12h-old completed session should show.
    await executeWorktrainOverviewCommand(deps);
    expect(linesDefault.some((l) => l.includes('Completed 12h ago'))).toBe(true);

    // Custom window (6h): 12h-old session should NOT show.
    await executeWorktrainOverviewCommand(deps2, { recentWindowMs: 6 * ONE_HOUR_MS });
    expect(linesCustom.some((l) => l.includes('Completed 12h ago'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: daemon status line
// ---------------------------------------------------------------------------

describe('executeWorktrainOverviewCommand -- daemon status line', () => {
  /**
   * Build a JSONL string with a single daemon event.
   * ts is relative to NOW_MS so tests are deterministic.
   */
  function makeEventLog(...events: Array<Record<string, unknown>>): string {
    return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  it('shows "running" when recent daemon_heartbeat exists (< 90s ago)', async () => {
    // Heartbeat 30 seconds ago.
    const heartbeatTs = NOW_MS - 30_000;
    const eventLog = makeEventLog({ kind: 'daemon_heartbeat', activeSessions: 2, ts: heartbeatTs });

    const { deps, lines } = makeDeps(makeFakeConsoleService([]), {
      readEventLog: () => Promise.resolve(eventLog),
    });
    await executeWorktrainOverviewCommand(deps);

    const daemonLine = lines.find((l) => l.startsWith('Daemon:'));
    expect(daemonLine).toBeDefined();
    expect(daemonLine).toContain('running');
    expect(daemonLine).toContain('30s ago');
    expect(daemonLine).toContain('2 active sessions');
  });

  it('shows "may have crashed" when heartbeat is stale (>= 90s ago)', async () => {
    // Heartbeat 4 hours ago (stale).
    const heartbeatTs = NOW_MS - 4 * ONE_HOUR_MS;
    const eventLog = makeEventLog({ kind: 'daemon_heartbeat', activeSessions: 0, ts: heartbeatTs });

    const { deps, lines } = makeDeps(makeFakeConsoleService([]), {
      readEventLog: () => Promise.resolve(eventLog),
    });
    await executeWorktrainOverviewCommand(deps);

    const daemonLine = lines.find((l) => l.startsWith('Daemon:'));
    expect(daemonLine).toBeDefined();
    expect(daemonLine).toContain('may have crashed');
    expect(daemonLine).toContain('4h ago');
  });

  it('shows "stopped gracefully" when daemon_stopped (graceful) is the most recent event', async () => {
    // Stopped event is more recent than the last heartbeat.
    const heartbeatTs = NOW_MS - 120_000; // 2 minutes ago
    const stoppedTs = NOW_MS - 60_000;   // 1 minute ago (more recent)
    const eventLog = makeEventLog(
      { kind: 'daemon_heartbeat', activeSessions: 1, ts: heartbeatTs },
      { kind: 'daemon_stopped', reason: 'graceful', ts: stoppedTs },
    );

    const { deps, lines } = makeDeps(makeFakeConsoleService([]), {
      readEventLog: () => Promise.resolve(eventLog),
    });
    await executeWorktrainOverviewCommand(deps);

    const daemonLine = lines.find((l) => l.startsWith('Daemon:'));
    expect(daemonLine).toBeDefined();
    expect(daemonLine).toContain('stopped gracefully');
  });

  it('shows "no events today" when event log is empty', async () => {
    const { deps, lines } = makeDeps(makeFakeConsoleService([]), {
      readEventLog: () => Promise.resolve(''),
    });
    await executeWorktrainOverviewCommand(deps);

    const daemonLine = lines.find((l) => l.startsWith('Daemon:'));
    expect(daemonLine).toBeDefined();
    expect(daemonLine).toContain('no events today');
  });
});
