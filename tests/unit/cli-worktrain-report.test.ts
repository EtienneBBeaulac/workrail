/**
 * Unit tests for executeWorktrainReportCommand
 *
 * Tests cover:
 * - Empty session store -> valid JSON with empty sessions array and zeroed summary
 * - Date window filtering (sessions outside window excluded)
 * - --out option: writeFile called, writeOutput not called
 * - Summary aggregation (token totals, outcome breakdown, workflow breakdown, language breakdown)
 * - All progress goes to stderr, nothing extra to stdout
 * - Session with metrics: null is counted in totalSessions but not metric totals
 * - completedSessions counted by status ('complete'|'complete_with_gaps'), not metrics presence
 * - 500-session truncation warning
 * - Invalid date inputs
 *
 * Uses fake deps (in-memory ConsoleService fake). No vi.mock() -- follows the
 * repo pattern of "prefer fakes over mocks".
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  executeWorktrainReportCommand,
  type WorktrainReportCommandDeps,
  type WorktrainReportCommandOpts,
  type ReportOutput,
} from '../../src/cli/commands/worktrain-report.js';
import type { ConsoleService } from '../../src/v2/usecases/console-service.js';
import type {
  ConsoleSessionSummary,
  ConsoleSessionListResponse,
  SessionMetricsV2,
} from '../../src/v2/usecases/console-types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const NOW_MS = new Date('2026-05-30T12:00:00.000Z').getTime();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Build a minimal SessionMetricsV2 stub. */
function makeMetrics(
  overrides: Partial<SessionMetricsV2> = {},
): SessionMetricsV2 {
  return {
    startGitSha: null,
    endGitSha: null,
    gitBranch: null,
    agentCommitShas: [],
    captureConfidence: 'none',
    durationMs: undefined,
    outcome: null,
    prNumbers: [],
    filesChanged: null,
    linesAdded: null,
    linesRemoved: null,
    usageEvents: [],
    tokenDelta: null,
    gitEvidence: null,
    stepsCompleted: 0,
    retriesCount: 0,
    ...overrides,
  };
}

/** Build a minimal ConsoleSessionSummary stub. */
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
    status: 'complete',
    health: 'healthy',
    nodeCount: 3,
    edgeCount: 2,
    tipCount: 1,
    hasUnresolvedGaps: false,
    recapSnippet: null,
    gitBranch: null,
    repoRoot: '/Users/test/project',
    lastModifiedMs: NOW_MS - ONE_DAY_MS, // 1 day ago (within 30-day default window)
    isAutonomous: false,
    isLive: false,
    triggerSource: 'mcp',
    parentSessionId: null,
    metrics: makeMetrics({ outcome: 'success' }),
  };
  return { ...defaults, ...overrides };
}

/** Build a fake ConsoleService that returns a fixed session list. */
function makeFakeConsoleService(
  sessions: ConsoleSessionSummary[],
  totalCountOverride?: number,
): ConsoleService {
  const totalCount = totalCountOverride ?? sessions.length;
  return {
    getSessionList: () => ({
      isOk: () => true,
      isErr: () => false,
      value: { sessions, totalCount } as ConsoleSessionListResponse,
      error: undefined,
      match: (onOk: (v: ConsoleSessionListResponse) => void) =>
        onOk({ sessions, totalCount }),
    }),
    getSessionsDir: () => '/fake/sessions',
    getSessionDetail: () => { throw new Error('not used in report tests'); },
    getNodeDetail: () => { throw new Error('not used in report tests'); },
  } as unknown as ConsoleService;
}

/** Build a fake ConsoleService that returns an error. */
function makeErrorConsoleService(): ConsoleService {
  return {
    getSessionList: () => ({
      isOk: () => false,
      isErr: () => true,
      error: { code: 'ENUMERATION_FAILED', message: 'sessions dir not found' },
      value: undefined,
      match: (_onOk: unknown, onErr: (e: { code: string; message: string }) => void) =>
        onErr({ code: 'ENUMERATION_FAILED', message: 'sessions dir not found' }),
    }),
    getSessionsDir: () => '/fake/sessions',
    getSessionDetail: () => { throw new Error('not used in report tests'); },
    getNodeDetail: () => { throw new Error('not used in report tests'); },
  } as unknown as ConsoleService;
}

/** Build a standard deps object backed by the given ConsoleService. */
function makeDeps(
  consoleService: ConsoleService,
  overrides: Partial<WorktrainReportCommandDeps> = {},
): { deps: WorktrainReportCommandDeps; outputLines: string[]; stderrLines: string[]; writtenFiles: Array<{ path: string; content: string }> } {
  const outputLines: string[] = [];
  const stderrLines: string[] = [];
  const writtenFiles: Array<{ path: string; content: string }> = [];

  const deps: WorktrainReportCommandDeps = {
    now: () => NOW_MS,
    buildConsoleService: () => consoleService,
    homedir: () => '/Users/test',
    joinPath: path.join,
    writeOutput: (json: string) => { outputLines.push(json); },
    writeStderr: (line: string) => { stderrLines.push(line); },
    writeFile: async (filePath: string, content: string) => { writtenFiles.push({ path: filePath, content }); },
    getDataDirEnv: () => undefined,
    ...overrides,
  };

  return { deps, outputLines, stderrLines, writtenFiles };
}

/**
 * Parse --format json output (single blob). Use for tests that explicitly
 * pass format: 'json' so they are not affected by the default ndjson change.
 */
function parseJsonOutput(outputLines: string[]): ReportOutput {
  expect(outputLines).toHaveLength(1);
  return JSON.parse(outputLines[0]!) as ReportOutput;
}

/**
 * Parse --format ndjson output (one object per line).
 * Returns { sessions, summary } extracted from the NDJSON lines.
 */
function parseNdjsonOutput(outputLines: string[]): { sessions: unknown[]; summary: unknown } {
  expect(outputLines).toHaveLength(1);
  const lines = outputLines[0]!.split('\n').filter((l) => l.trim().length > 0);
  expect(lines.length).toBeGreaterThan(0);
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const summaryLine = parsed.find((p) => p['_summary'] === true);
  const sessions = parsed.filter((p) => p['_summary'] !== true);
  expect(summaryLine).toBeDefined();
  return { sessions, summary: summaryLine };
}

// parseJsonOutput is the canonical helper; no alias needed.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeWorktrainReportCommand', () => {
  describe('empty session store', () => {
    it('emits valid JSON with empty sessions array and zeroed summary', async () => {
      const { deps, outputLines, stderrLines } = makeDeps(makeFakeConsoleService([]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.version).toBe(1);
      expect(report.sessions).toHaveLength(0);
      expect(report.summary.totalSessions).toBe(0);
      expect(report.summary.completedSessions).toBe(0);
      expect(report.summary.totalInputTokens).toBe(0);
      expect(report.summary.totalOutputTokens).toBe(0);
      expect(report.summary.totalLinesAdded).toBe(0);
      expect(report.summary.outcomeBreakdown).toEqual({});
      expect(report.summary.workflowBreakdown).toEqual({});
      expect(report.summary.languageBreakdown).toEqual({});
      // Progress goes to stderr
      expect(stderrLines.length).toBeGreaterThan(0);
    });

    it('output JSON is parseable and has correct shape', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([]));
      await executeWorktrainReportCommand(deps, { days: 7, format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report).toHaveProperty('version', 1);
      expect(report).toHaveProperty('generatedAt');
      expect(report).toHaveProperty('dateRange');
      expect(report.dateRange).toHaveProperty('since');
      expect(report.dateRange).toHaveProperty('until');
    });
  });

  describe('date window filtering', () => {
    it('includes sessions within the window and excludes those outside', async () => {
      const insideSession = makeSession({
        sessionId: 'sess_inside',
        lastModifiedMs: NOW_MS - 5 * ONE_DAY_MS, // 5 days ago
      });
      const outsideSession = makeSession({
        sessionId: 'sess_outside',
        lastModifiedMs: NOW_MS - 35 * ONE_DAY_MS, // 35 days ago
      });

      const { deps, outputLines } = makeDeps(
        makeFakeConsoleService([insideSession, outsideSession]),
      );
      await executeWorktrainReportCommand(deps, { days: 30, format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.sessions).toHaveLength(1);
      expect(report.sessions[0]!.sessionId).toBe('sess_inside');
    });

    it('respects --since and --until options', async () => {
      const insideSession = makeSession({
        sessionId: 'sess_inside',
        lastModifiedMs: new Date('2026-05-15T12:00:00Z').getTime(),
      });
      const outsideSession = makeSession({
        sessionId: 'sess_outside',
        lastModifiedMs: new Date('2026-04-01T12:00:00Z').getTime(),
      });

      const { deps, outputLines } = makeDeps(
        makeFakeConsoleService([insideSession, outsideSession]),
      );
      await executeWorktrainReportCommand(deps, {
        since: '2026-05-01',
        until: '2026-05-31',
        format: 'json',
      });

      const report = parseJsonOutput(outputLines);
      expect(report.sessions).toHaveLength(1);
      expect(report.sessions[0]!.sessionId).toBe('sess_inside');
    });

    it('empty result when no sessions in window', async () => {
      const outsideSession = makeSession({
        sessionId: 'sess_outside',
        lastModifiedMs: NOW_MS - 60 * ONE_DAY_MS,
      });

      const { deps, outputLines } = makeDeps(makeFakeConsoleService([outsideSession]));
      await executeWorktrainReportCommand(deps, { days: 7, format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.sessions).toHaveLength(0);
    });
  });

  describe('--out file option', () => {
    it('writes JSON to file and does not write to stdout', async () => {
      const { deps, outputLines, writtenFiles } = makeDeps(makeFakeConsoleService([]));
      await executeWorktrainReportCommand(deps, { out: path.join(os.tmpdir(), 'report.json'), format: 'json' });

      expect(outputLines).toHaveLength(0);
      expect(writtenFiles).toHaveLength(1);
      expect(writtenFiles[0]!.path).toBe(path.join(os.tmpdir(), 'report.json'));
      const written = JSON.parse(writtenFiles[0]!.content) as ReportOutput;
      expect(written.version).toBe(1);
    });

    it('emits stderr confirmation when writing to file', async () => {
      const { deps, stderrLines } = makeDeps(makeFakeConsoleService([]));
      await executeWorktrainReportCommand(deps, { out: path.join(os.tmpdir(), 'report.json'), format: 'json' });

      const hasConfirmation = stderrLines.some((l) => l.includes(path.join(os.tmpdir(), 'report.json')));
      expect(hasConfirmation).toBe(true);
    });
  });

  describe('summary aggregation', () => {
    it('correctly sums token totals across sessions', async () => {
      const session1 = makeSession({
        sessionId: 'sess_1',
        metrics: makeMetrics({
          outcome: 'success',
          usageEvents: [
            { client: 'claude-code', model: null, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 100, turns: 3 },
          ],
        }),
      });
      const session2 = makeSession({
        sessionId: 'sess_2',
        metrics: makeMetrics({
          outcome: 'success',
          usageEvents: [
            { client: 'claude-code', model: null, inputTokens: 2000, outputTokens: 400, cacheReadTokens: 100, cacheWriteTokens: 200, turns: 5 },
          ],
        }),
      });

      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session1, session2]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.summary.totalInputTokens).toBe(3000);
      expect(report.summary.totalOutputTokens).toBe(600);
      expect(report.summary.totalCacheReadTokens).toBe(150);
      expect(report.summary.totalCacheWriteTokens).toBe(300);
    });

    it('correctly counts outcome breakdown', async () => {
      const s1 = makeSession({ sessionId: 'sess_1', metrics: makeMetrics({ outcome: 'success' }) });
      const s2 = makeSession({ sessionId: 'sess_2', metrics: makeMetrics({ outcome: 'success' }) });
      const s3 = makeSession({ sessionId: 'sess_3', metrics: makeMetrics({ outcome: 'error' }) });
      const s4 = makeSession({ sessionId: 'sess_4', metrics: makeMetrics({ outcome: null }) });
      const s5 = makeSession({ sessionId: 'sess_5', metrics: null });

      const { deps, outputLines } = makeDeps(makeFakeConsoleService([s1, s2, s3, s4, s5]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.summary.outcomeBreakdown['success']).toBe(2);
      expect(report.summary.outcomeBreakdown['error']).toBe(1);
      // null outcome (from metrics) and null metrics both count as 'unknown'
      expect(report.summary.outcomeBreakdown['unknown']).toBe(2);
    });

    it('counts workflow breakdown by workflowId', async () => {
      const s1 = makeSession({ sessionId: 'sess_1', workflowId: 'wr.coding-task' });
      const s2 = makeSession({ sessionId: 'sess_2', workflowId: 'wr.coding-task' });
      const s3 = makeSession({ sessionId: 'sess_3', workflowId: 'wr.mr-review' });
      const s4 = makeSession({ sessionId: 'sess_4', workflowId: null });

      const { deps, outputLines } = makeDeps(makeFakeConsoleService([s1, s2, s3, s4]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.summary.workflowBreakdown['wr.coding-task']).toBe(2);
      expect(report.summary.workflowBreakdown['wr.mr-review']).toBe(1);
      expect(report.summary.workflowBreakdown['__unknown__']).toBe(1);
    });

    it('aggregates language breakdown from gitEvidence', async () => {
      const s1 = makeSession({
        sessionId: 'sess_1',
        metrics: makeMetrics({
          gitEvidence: {
            startSha: null,
            endSha: null,
            commitShas: [],
            prRefs: [],
            captureConfidence: 'high',
            churnSignal: null,
            workingTree: null,
            committedDiff: {
              filesChanged: 5,
              linesAdded: 100,
              linesRemoved: 20,
              truncated: false,
              changedFilePaths: [],
              languageBreakdown: { '.ts': 80, '.json': 20 },
            },
          },
        }),
      });
      const s2 = makeSession({
        sessionId: 'sess_2',
        metrics: makeMetrics({
          gitEvidence: {
            startSha: null,
            endSha: null,
            commitShas: [],
            prRefs: [],
            captureConfidence: 'high',
            churnSignal: null,
            workingTree: null,
            committedDiff: {
              filesChanged: 3,
              linesAdded: 50,
              linesRemoved: 10,
              truncated: false,
              changedFilePaths: [],
              languageBreakdown: { '.ts': 40, '.md': 10 },
            },
          },
        }),
      });

      const { deps, outputLines } = makeDeps(makeFakeConsoleService([s1, s2]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.summary.languageBreakdown['.ts']).toBe(120);
      expect(report.summary.languageBreakdown['.json']).toBe(20);
      expect(report.summary.languageBreakdown['.md']).toBe(10);
      expect(report.summary.totalLinesAdded).toBe(150);
      expect(report.summary.totalLinesRemoved).toBe(30);
      expect(report.summary.totalFilesChanged).toBe(8);
    });

    it('falls back to legacy fields when gitEvidence is null', async () => {
      const session = makeSession({
        sessionId: 'sess_1',
        metrics: makeMetrics({
          gitEvidence: null,
          linesAdded: 50,
          linesRemoved: 10,
          filesChanged: 3,
        }),
      });

      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.summary.totalLinesAdded).toBe(50);
      expect(report.summary.totalLinesRemoved).toBe(10);
      expect(report.summary.totalFilesChanged).toBe(3);
    });

    it('correctly counts completedSessions by status', async () => {
      const complete = makeSession({ sessionId: 'sess_1', status: 'complete' });
      const completeWithGaps = makeSession({ sessionId: 'sess_2', status: 'complete_with_gaps' });
      const inProgress = makeSession({ sessionId: 'sess_3', status: 'in_progress', metrics: makeMetrics() }); // has metrics but is in_progress
      const blocked = makeSession({ sessionId: 'sess_4', status: 'blocked' });

      const { deps, outputLines } = makeDeps(
        makeFakeConsoleService([complete, completeWithGaps, inProgress, blocked]),
      );
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.summary.totalSessions).toBe(4);
      expect(report.summary.completedSessions).toBe(2);
    });

    it('session with metrics null does not contribute to metric totals', async () => {
      const withMetrics = makeSession({
        sessionId: 'sess_1',
        metrics: makeMetrics({
          durationMs: 60000,
          stepsCompleted: 5,
          retriesCount: 1,
          usageEvents: [{ client: 'c', model: null, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 20, turns: 2 }],
        }),
      });
      const withoutMetrics = makeSession({ sessionId: 'sess_2', metrics: null });

      const { deps, outputLines } = makeDeps(makeFakeConsoleService([withMetrics, withoutMetrics]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.summary.totalSessions).toBe(2);
      expect(report.summary.totalDurationMs).toBe(60000);
      expect(report.summary.totalStepsCompleted).toBe(5);
      expect(report.summary.totalRetriesCount).toBe(1);
      expect(report.summary.totalInputTokens).toBe(100);
    });
  });

  describe('stderr and stdout separation', () => {
    it('all progress goes to stderr, stdout contains only the JSON blob', async () => {
      const { deps, outputLines, stderrLines } = makeDeps(makeFakeConsoleService([]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      expect(outputLines).toHaveLength(1);
      // Verify the single stdout line is valid JSON
      expect(() => JSON.parse(outputLines[0]!)).not.toThrow();
      // stderr should have progress lines
      expect(stderrLines.length).toBeGreaterThan(0);
      // None of the stderr lines should appear in stdout
      for (const stderrLine of stderrLines) {
        expect(outputLines[0]).not.toContain(stderrLine);
      }
    });
  });

  describe('session store error graceful degradation', () => {
    it('emits empty report with warning when session store fails', async () => {
      const { deps, outputLines, stderrLines } = makeDeps(makeErrorConsoleService());
      await executeWorktrainReportCommand(deps, { format: 'json' });

      // Should still emit valid JSON
      const report = parseJsonOutput(outputLines);
      expect(report.sessions).toHaveLength(0);
      // Should have warning in stderr
      const hasWarning = stderrLines.some((l) => l.toLowerCase().includes('warning') || l.includes('could not'));
      expect(hasWarning).toBe(true);
    });
  });

  describe('session list truncation warning', () => {
    it('emits a warning to stderr when totalCount > sessions.length', async () => {
      const sessions = [makeSession({ sessionId: 'sess_1' })];
      const { deps, stderrLines } = makeDeps(
        makeFakeConsoleService(sessions, 600), // pretend 600 total, only 1 returned
      );
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const hasTruncationWarning = stderrLines.some(
        (l) => l.includes('600') && l.includes('1'),
      );
      expect(hasTruncationWarning).toBe(true);
    });

    it('does not emit truncation warning when all sessions fit', async () => {
      const sessions = [makeSession({ sessionId: 'sess_1' })];
      const { deps, stderrLines } = makeDeps(
        makeFakeConsoleService(sessions, 1),
      );
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const hasTruncationWarning = stderrLines.some(
        (l) => l.toLowerCase().includes('only') && l.toLowerCase().includes('loaded'),
      );
      expect(hasTruncationWarning).toBe(false);
    });
  });

  describe('session fields in output', () => {
    it('maps sessionTitle to goal in output', async () => {
      const session = makeSession({
        sessionId: 'sess_1',
        sessionTitle: 'Implement the foo feature',
      });

      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.sessions[0]!.goal).toBe('Implement the foo feature');
    });

    it('maps triggerSource correctly', async () => {
      const mcp = makeSession({ sessionId: 'sess_mcp', triggerSource: 'mcp' });
      const daemon = makeSession({ sessionId: 'sess_daemon', triggerSource: 'daemon' });

      const { deps, outputLines } = makeDeps(makeFakeConsoleService([mcp, daemon]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      const mcpSession = report.sessions.find((s) => s.sessionId === 'sess_mcp');
      const daemonSession = report.sessions.find((s) => s.sessionId === 'sess_daemon');
      expect(mcpSession?.triggerSource).toBe('mcp');
      expect(daemonSession?.triggerSource).toBe('daemon');
    });

    it('formats date as YYYY-MM-DD from lastModifiedMs', async () => {
      const session = makeSession({
        sessionId: 'sess_1',
        lastModifiedMs: new Date('2026-05-15T18:30:00Z').getTime(),
      });

      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps, {
        since: '2026-05-01',
        until: '2026-05-31',
        format: 'json',
      });

      const report = parseJsonOutput(outputLines);
      expect(report.sessions[0]!.date).toBe('2026-05-15');
    });
  });

  describe('date range in output', () => {
    it('reflects the correct since/until in dateRange', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([]));
      await executeWorktrainReportCommand(deps, {
        since: '2026-05-01',
        until: '2026-05-30',
        format: 'json',
      });

      const report = parseJsonOutput(outputLines);
      expect(report.dateRange.since).toBe('2026-05-01');
      expect(report.dateRange.until).toBe('2026-05-30');
    });

    it('computes since from --days when no --since provided', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([]), {
        now: () => new Date('2026-05-30T12:00:00.000Z').getTime(),
      });
      await executeWorktrainReportCommand(deps, { days: 7, format: 'json' });

      const report = parseJsonOutput(outputLines);
      // since should be 2026-05-24 (7 days back, inclusive)
      expect(report.dateRange.since).toBe('2026-05-24');
      expect(report.dateRange.until).toBe('2026-05-30');
    });
  });

  describe('invalid date inputs', () => {
    it('writes error to stderr and returns without stdout when --since is invalid', async () => {
      const { deps, outputLines, stderrLines } = makeDeps(makeFakeConsoleService([]));
      await executeWorktrainReportCommand(deps, { since: 'not-a-date', format: 'json' });

      expect(outputLines).toHaveLength(0);
      const hasError = stderrLines.some((l) => l.includes('not-a-date'));
      expect(hasError).toBe(true);
    });

    it('writes error to stderr and returns without stdout when --until is invalid', async () => {
      const { deps, outputLines, stderrLines } = makeDeps(makeFakeConsoleService([]));
      await executeWorktrainReportCommand(deps, { until: 'invalid', format: 'json' });

      expect(outputLines).toHaveLength(0);
      const hasError = stderrLines.some((l) => l.includes('invalid'));
      expect(hasError).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Format-specific tests
// ---------------------------------------------------------------------------

describe('output formats', () => {
  const session = makeSession({
    sessionId: 'sess_fmt',
    metrics: makeMetrics({
      outcome: 'success',
      stepsCompleted: 3,
      retriesCount: 1,
      durationMs: 12000,
      linesAdded: 42,
      linesRemoved: 7,
      filesChanged: 5,
      gitEvidence: {
        startSha: 'abc',
        endSha: 'def',
        commitShas: ['def'],
        prRefs: [99],
        committedDiff: {
          filesChanged: 5,
          linesAdded: 42,
          linesRemoved: 7,
          truncated: false,
          changedFilePaths: ['src/foo.ts', 'src/bar.ts'],
          languageBreakdown: { '.ts': 2 },
        },
        workingTree: null,
        captureConfidence: 'high',
        churnSignal: { filesRemodified: 1, windowDays: 7 },
      },
    }),
  });

  describe('ndjson (default)', () => {
    it('emits one JSON object per session + one summary line', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps); // default format

      const { sessions, summary } = parseNdjsonOutput(outputLines);
      expect(sessions).toHaveLength(1);
      expect((sessions[0] as Record<string, unknown>)['sessionId']).toBe('sess_fmt');
      expect((summary as Record<string, unknown>)['_summary']).toBe(true);
      expect((summary as Record<string, unknown>)['totalSessions']).toBe(1);
    });

    it('never includes changedFilePaths in ndjson output', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps);

      expect(outputLines[0]).not.toContain('changedFilePaths');
    });

    it('each session line is valid standalone JSON', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps);

      const lines = outputLines[0]!.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe('json format', () => {
    it('emits a single pretty-printed blob with sessions array and summary', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      const report = parseJsonOutput(outputLines);
      expect(report.version).toBe(1);
      expect(report.sessions).toHaveLength(1);
      expect(report.summary.totalSessions).toBe(1);
    });

    it('never includes changedFilePaths in json output', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps, { format: 'json' });

      expect(outputLines[0]).not.toContain('changedFilePaths');
    });
  });

  describe('summary format', () => {
    it('emits only the summary object -- no sessions array', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps, { format: 'summary' });

      const parsed = JSON.parse(outputLines[0]!) as Record<string, unknown>;
      expect(parsed['sessions']).toBeUndefined();
      expect(parsed['summary']).toBeDefined();
      expect((parsed['summary'] as Record<string, unknown>)['totalSessions']).toBe(1);
    });

    it('includes version, generatedAt, and dateRange', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([]));
      await executeWorktrainReportCommand(deps, { format: 'summary' });

      const parsed = JSON.parse(outputLines[0]!) as Record<string, unknown>;
      expect(parsed['version']).toBe(1);
      expect(typeof parsed['generatedAt']).toBe('string');
      expect(parsed['dateRange']).toBeDefined();
    });
  });

  describe('csv format', () => {
    it('emits a header row followed by one data row per session', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps, { format: 'csv' });

      const lines = outputLines[0]!.split('\n');
      expect(lines).toHaveLength(2); // header + 1 session
      expect(lines[0]).toContain('sessionId');
      expect(lines[0]).toContain('outcome');
      expect(lines[0]).toContain('linesAdded');
      expect(lines[1]).toContain('sess_fmt');
    });

    it('never includes changedFilePaths in csv output', async () => {
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
      await executeWorktrainReportCommand(deps, { format: 'csv' });

      expect(outputLines[0]).not.toContain('changedFilePaths');
    });

    it('escapes goal strings containing commas', async () => {
      const sessionWithComma = makeSession({
        sessionId: 'sess_csv_escape',
        sessionTitle: 'Implement foo, bar, and baz',
        metrics: null,
      });
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([sessionWithComma]));
      await executeWorktrainReportCommand(deps, { format: 'csv' });

      const lines = outputLines[0]!.split('\n');
      expect(lines[1]).toContain('"Implement foo, bar, and baz"');
    });

    it('outputs empty string for null metric fields', async () => {
      const sessionNoMetrics = makeSession({ sessionId: 'sess_no_metrics', metrics: null });
      const { deps, outputLines } = makeDeps(makeFakeConsoleService([sessionNoMetrics]));
      await executeWorktrainReportCommand(deps, { format: 'csv' });

      const lines = outputLines[0]!.split('\n');
      // Row should exist with empty metric columns, not throw
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('sess_no_metrics');
    });
  });

  describe('changedFilePaths stripping (all formats)', () => {
    it('changedFilePaths is not present in any of the four formats', async () => {
      for (const format of ['ndjson', 'json', 'summary', 'csv'] as const) {
        const { deps, outputLines } = makeDeps(makeFakeConsoleService([session]));
        await executeWorktrainReportCommand(deps, { format });
        expect(outputLines[0], `format=${format}`).not.toContain('changedFilePaths');
      }
    });
  });
});
