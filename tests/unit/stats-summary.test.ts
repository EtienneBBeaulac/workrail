/**
 * Unit tests for src/daemon/stats-summary.ts.
 *
 * All tests use a temp directory and clean up in afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { writeStatsSummary } from '../../src/daemon/stats-summary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-stats-test-'));
}

function makeRecord(overrides: Partial<{
  sessionId: string;
  workflowId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  outcome: string;
  stepCount: number;
  ts: string;
}> = {}): string {
  return JSON.stringify({
    sessionId: 'sess-001',
    workflowId: 'workflow-a',
    startMs: 1000,
    endMs: 6000,
    durationMs: 5000,
    outcome: 'success',
    stepCount: 3,
    ts: '2026-04-01T10:00:00.000Z',
    ...overrides,
  });
}

async function writeJsonl(dir: string, lines: string[]): Promise<void> {
  await fs.writeFile(path.join(dir, 'execution-stats.jsonl'), lines.join('\n') + '\n', 'utf8');
}

async function readSummary(dir: string): Promise<unknown> {
  const content = await fs.readFile(path.join(dir, 'stats-summary.json'), 'utf8');
  return JSON.parse(content);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('writeStatsSummary', () => {
  it('produces sessionCount:0 summary when execution-stats.jsonl is absent (fresh install)', async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);

    await writeStatsSummary(dir);

    const summary = await readSummary(dir) as Record<string, unknown>;
    expect(summary['version']).toBe(1);
    expect(summary['sessionCount']).toBe(0);
    expect(summary['malformedLineCount']).toBe(0);
    expect(summary['outcomeBreakdown']).toEqual({});
    expect((summary['durationMs'] as Record<string, number>)['avg']).toBe(0);
    expect(summary['byWorkflow']).toEqual({});
    expect(summary['oldestSessionTs']).toBeNull();
    expect(summary['newestSessionTs']).toBeNull();
  });

  it('aggregates a single session correctly (p50 = p95 = the single duration)', async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);

    await writeJsonl(dir, [
      makeRecord({ durationMs: 10000, outcome: 'success', stepCount: 5 }),
    ]);

    await writeStatsSummary(dir);

    const summary = await readSummary(dir) as Record<string, unknown>;
    expect(summary['version']).toBe(1);
    expect(summary['sessionCount']).toBe(1);
    expect(summary['malformedLineCount']).toBe(0);

    const dm = summary['durationMs'] as Record<string, number>;
    expect(dm['avg']).toBe(10000);
    expect(dm['min']).toBe(10000);
    expect(dm['max']).toBe(10000);
    expect(dm['p50']).toBe(10000);
    expect(dm['p95']).toBe(10000);

    const sm = summary['stepCount'] as Record<string, number>;
    expect(sm['avg']).toBe(5);
    expect(sm['min']).toBe(5);
    expect(sm['max']).toBe(5);

    const ob = summary['outcomeBreakdown'] as Record<string, number>;
    expect(ob['success']).toBe(1);

    const bw = summary['byWorkflow'] as Record<string, Record<string, number>>;
    expect(bw['workflow-a']['count']).toBe(1);
    expect(bw['workflow-a']['successCount']).toBe(1);
  });

  it('aggregates multiple sessions with mixed outcomes correctly', async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);

    await writeJsonl(dir, [
      makeRecord({ sessionId: 's1', durationMs: 1000, outcome: 'success', stepCount: 2, ts: '2026-04-01T10:00:00.000Z' }),
      makeRecord({ sessionId: 's2', durationMs: 3000, outcome: 'error', stepCount: 1, ts: '2026-04-01T11:00:00.000Z' }),
      makeRecord({ sessionId: 's3', durationMs: 5000, outcome: 'timeout', stepCount: 4, ts: '2026-04-02T10:00:00.000Z' }),
    ]);

    await writeStatsSummary(dir);

    const summary = await readSummary(dir) as Record<string, unknown>;
    expect(summary['sessionCount']).toBe(3);

    const ob = summary['outcomeBreakdown'] as Record<string, number>;
    expect(ob['success']).toBe(1);
    expect(ob['error']).toBe(1);
    expect(ob['timeout']).toBe(1);

    const dm = summary['durationMs'] as Record<string, number>;
    expect(dm['min']).toBe(1000);
    expect(dm['max']).toBe(5000);
    expect(dm['avg']).toBe(3000);
    // sorted: [1000, 3000, 5000]
    // p50: ceil(0.5 * 3) - 1 = idx 0 -> 1000... wait: ceil(0.5*3)=2, idx=1 -> 3000
    expect(dm['p50']).toBe(3000);
    // p95: ceil(0.95*3)-1 = ceil(2.85)-1 = 3-1 = 2 -> 5000
    expect(dm['p95']).toBe(5000);

    expect(summary['oldestSessionTs']).toBe('2026-04-01T10:00:00.000Z');
    expect(summary['newestSessionTs']).toBe('2026-04-02T10:00:00.000Z');
  });

  it('counts malformed lines and aggregates from valid lines only', async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);

    await writeJsonl(dir, [
      makeRecord({ sessionId: 's1', durationMs: 2000, outcome: 'success', stepCount: 2 }),
      'not valid json',
      '{"incomplete": true}', // valid JSON but fails schema (missing required fields)
    ]);

    await writeStatsSummary(dir);

    const summary = await readSummary(dir) as Record<string, unknown>;
    expect(summary['sessionCount']).toBe(1);
    expect(summary['malformedLineCount']).toBe(2);
  });

  it('writes stats-summary.json atomically (no tmp file left behind)', async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);

    await writeJsonl(dir, [makeRecord()]);
    await writeStatsSummary(dir);

    const files = await fs.readdir(dir);
    expect(files).toContain('stats-summary.json');
    expect(files).not.toContain('stats-summary.json.tmp');
  });

  it('aggregates byWorkflow with two different workflows', async () => {
    const dir = await makeTmpDir();
    tmpDirs.push(dir);

    await writeJsonl(dir, [
      makeRecord({ sessionId: 's1', workflowId: 'workflow-a', durationMs: 4000, outcome: 'success', stepCount: 3 }),
      makeRecord({ sessionId: 's2', workflowId: 'workflow-b', durationMs: 6000, outcome: 'error', stepCount: 1 }),
      makeRecord({ sessionId: 's3', workflowId: 'workflow-a', durationMs: 8000, outcome: 'success', stepCount: 5 }),
    ]);

    await writeStatsSummary(dir);

    const summary = await readSummary(dir) as Record<string, unknown>;
    const bw = summary['byWorkflow'] as Record<string, Record<string, number>>;

    expect(Object.keys(bw)).toHaveLength(2);

    expect(bw['workflow-a']['count']).toBe(2);
    expect(bw['workflow-a']['successCount']).toBe(2);
    expect(bw['workflow-a']['avgDurationMs']).toBe(6000);

    expect(bw['workflow-b']['count']).toBe(1);
    expect(bw['workflow-b']['successCount']).toBe(0);
    expect(bw['workflow-b']['avgDurationMs']).toBe(6000);
  });
});
