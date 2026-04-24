/**
 * Unit tests for makeReportIssueTool() in workflow-runner.ts.
 *
 * Strategy: use issuesDirOverride to write to a temp directory, avoiding any
 * writes to ~/.workrail. The appendIssueAsync fire-and-forget write is tested
 * via flushAsync() -- same approach as daemon-events.test.ts.
 *
 * WHY no fs mocking: the issuesDirOverride parameter makes the test hermetic
 * without requiring mocks. This follows the "prefer fakes over mocks" principle.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeReportIssueTool } from '../../src/daemon/workflow-runner.js';
import { DaemonEventEmitter } from '../../src/daemon/daemon-events.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory for each test. */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-report-issue-test-'));
}

/**
 * Read all JSONL lines from a file, parsed as objects.
 * Returns an empty array if the file does not exist.
 */
async function readJsonlLines(filePath: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Wait for all pending async I/O to flush (same pattern as daemon-events.test.ts). */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeReportIssueTool()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('tool shape', () => {
    it('returns a tool with name report_issue', () => {
      const tool = makeReportIssueTool('sess-1', undefined, undefined, tmpDir);
      expect(tool.name).toBe('report_issue');
    });

    it('description mentions the auto-fix coordinator', () => {
      const tool = makeReportIssueTool('sess-1', undefined, undefined, tmpDir);
      expect(tool.description).toContain('auto-fix coordinator');
    });

    it('input schema requires kind, severity, and summary', () => {
      const tool = makeReportIssueTool('sess-1', undefined, undefined, tmpDir);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const schema = tool.inputSchema as any;
      expect(schema.required).toContain('kind');
      expect(schema.required).toContain('severity');
      expect(schema.required).toContain('summary');
    });
  });

  describe('return values', () => {
    it('returns non-fatal confirmation for info severity', async () => {
      const tool = makeReportIssueTool('sess-1', undefined, undefined, tmpDir);
      const result = await tool.execute('call-1', {
        kind: 'tool_failure',
        severity: 'info',
        summary: 'Bash exit code 1 with empty stderr',
      });
      expect(result.content[0]?.text).toContain('Issue recorded (severity=info)');
      expect(result.content[0]?.text).not.toContain('FATAL');
    });

    it('returns non-fatal confirmation for warn severity', async () => {
      const tool = makeReportIssueTool('sess-1', undefined, undefined, tmpDir);
      const result = await tool.execute('call-1', {
        kind: 'blocked',
        severity: 'warn',
        summary: 'Could not find expected file',
      });
      expect(result.content[0]?.text).toContain('severity=warn');
    });

    it('returns non-fatal confirmation for error severity', async () => {
      const tool = makeReportIssueTool('sess-1', undefined, undefined, tmpDir);
      const result = await tool.execute('call-1', {
        kind: 'unexpected_behavior',
        severity: 'error',
        summary: 'Test suite returned exit code 2',
      });
      expect(result.content[0]?.text).toContain('severity=error');
    });

    it('returns FATAL message for fatal severity', async () => {
      const tool = makeReportIssueTool('sess-1', undefined, undefined, tmpDir);
      const result = await tool.execute('call-1', {
        kind: 'needs_human',
        severity: 'fatal',
        summary: 'Cannot proceed without human decision',
      });
      expect(result.content[0]?.text).toContain('FATAL issue recorded');
      expect(result.content[0]?.text).toContain('continue_workflow');
    });
  });

  describe('JSONL write', () => {
    it('writes a JSON line to <issuesDirOverride>/<sessionId>.jsonl', async () => {
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, tmpDir);
      await tool.execute('call-1', {
        kind: 'tool_failure',
        severity: 'error',
        summary: 'npm run build failed',
      });

      await flushAsync();

      const filePath = path.join(tmpDir, 'sess-abc.jsonl');
      const lines = await readJsonlLines(filePath);
      expect(lines).toHaveLength(1);
    });

    it('written JSON contains kind, severity, summary, sessionId, and ts', async () => {
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, tmpDir);
      await tool.execute('call-1', {
        kind: 'blocked',
        severity: 'warn',
        summary: 'Could not clone repo',
      });

      await flushAsync();

      const filePath = path.join(tmpDir, 'sess-abc.jsonl');
      const lines = await readJsonlLines(filePath);
      const record = lines[0]!;

      expect(record['kind']).toBe('blocked');
      expect(record['severity']).toBe('warn');
      expect(record['summary']).toBe('Could not clone repo');
      expect(record['sessionId']).toBe('sess-abc');
      expect(typeof record['ts']).toBe('number');
    });

    it('includes optional fields when provided', async () => {
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, tmpDir);
      await tool.execute('call-1', {
        kind: 'tool_failure',
        severity: 'error',
        summary: 'Bash failed',
        context: 'Running npm run test',
        toolName: 'Bash',
        command: 'npm run test',
        suggestedFix: 'Check if node_modules is installed',
        continueToken: 'ct_abc123',
      });

      await flushAsync();

      const filePath = path.join(tmpDir, 'sess-abc.jsonl');
      const lines = await readJsonlLines(filePath);
      const record = lines[0]!;

      expect(record['context']).toBe('Running npm run test');
      expect(record['toolName']).toBe('Bash');
      expect(record['command']).toBe('npm run test');
      expect(record['suggestedFix']).toBe('Check if node_modules is installed');
      expect(record['continueToken']).toBe('ct_abc123');
    });

    it('creates directory if it does not exist', async () => {
      const nestedDir = path.join(tmpDir, 'issues', 'nested');
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, nestedDir);
      await tool.execute('call-1', {
        kind: 'self_correction',
        severity: 'info',
        summary: 'Made a reasoned decision without oracle guidance',
      });

      await flushAsync();

      const files = await fs.readdir(nestedDir);
      expect(files).toContain('sess-abc.jsonl');
    });

    it('does not throw when the write fails (fire-and-forget)', async () => {
      // Use a path where writes will fail: a non-writable location.
      // We simulate failure by pointing to /dev/null as the directory -- mkdir
      // on /dev/null will fail because it is not a directory.
      const badDir = '/dev/null/impossible-path';
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, badDir);

      // Must not throw -- fire-and-forget swallows all write errors.
      await expect(
        tool.execute('call-1', {
          kind: 'tool_failure',
          severity: 'error',
          summary: 'Test error',
        }),
      ).resolves.not.toThrow();
    });

    it('truncates summary longer than 200 chars to exactly 200 chars', async () => {
      const longSummary = 'a'.repeat(201);
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, tmpDir);
      await tool.execute('call-1', {
        kind: 'tool_failure',
        severity: 'error',
        summary: longSummary,
      });

      await flushAsync();

      const filePath = path.join(tmpDir, 'sess-abc.jsonl');
      const lines = await readJsonlLines(filePath);
      expect(lines[0]!['summary']).toBe('a'.repeat(200));
    });
  });

  describe('onIssueSummary callback', () => {
    it('invokes onIssueSummary synchronously with the truncated summary after execute()', async () => {
      // This is the injection point that runWorkflow() uses to accumulate issue summaries
      // for the WORKTRAIN_STUCK marker (state.issueSummaries) without async file I/O.
      // WHY synchronous: execute() is called from the agent loop turn; the push must
      // complete before the turn_end subscriber reads state.issueSummaries.
      const collected: string[] = [];
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, tmpDir, (s) => collected.push(s));

      await tool.execute('call-1', {
        kind: 'tool_failure',
        severity: 'error',
        summary: 'npm run build failed with exit 1',
      });

      expect(collected).toHaveLength(1);
      expect(collected[0]).toBe('npm run build failed with exit 1');
    });

    it('invokes onIssueSummary with the 200-char truncated form when summary is long', async () => {
      const longSummary = 'x'.repeat(250);
      const collected: string[] = [];
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, tmpDir, (s) => collected.push(s));

      await tool.execute('call-1', {
        kind: 'unexpected_behavior',
        severity: 'warn',
        summary: longSummary,
      });

      // Summary is truncated to 200 chars before the callback is invoked.
      expect(collected).toHaveLength(1);
      expect(collected[0]).toBe('x'.repeat(200));
    });

    it('accumulates multiple summaries into the caller-provided list', async () => {
      // This mirrors how runWorkflow() uses onIssueSummary to build state.issueSummaries.
      // When a stuck signal fires, state.issueSummaries is forwarded to writeStuckOutboxEntry
      // and included in the WorkflowRunStuck result.
      const collected: string[] = [];
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, tmpDir, (s) => collected.push(s));

      await tool.execute('call-1', { kind: 'blocked', severity: 'warn', summary: 'First issue' });
      await tool.execute('call-2', { kind: 'tool_failure', severity: 'error', summary: 'Second issue' });
      await tool.execute('call-3', { kind: 'self_correction', severity: 'info', summary: 'Third issue' });

      expect(collected).toEqual(['First issue', 'Second issue', 'Third issue']);
    });

    it('does not invoke onIssueSummary when not provided', async () => {
      // Defensive: no callback means no push, no error.
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, tmpDir);

      await expect(
        tool.execute('call-1', { kind: 'blocked', severity: 'info', summary: 'Nothing to collect' }),
      ).resolves.toBeDefined();
    });
  });

  describe('event emission', () => {
    it('emits an issue_reported event via the emitter', async () => {
      const emitter = new DaemonEventEmitter(tmpDir);
      const emittedEvents: unknown[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const origEmit = emitter.emit.bind(emitter);
      vi.spyOn(emitter, 'emit').mockImplementation((event) => {
        emittedEvents.push(event);
        origEmit(event);
      });

      const tool = makeReportIssueTool('sess-abc', emitter, undefined, tmpDir);
      await tool.execute('call-1', {
        kind: 'unexpected_behavior',
        severity: 'warn',
        summary: 'Unexpected output from git status',
      });

      expect(emittedEvents).toHaveLength(1);
      const event = emittedEvents[0] as Record<string, unknown>;
      expect(event['kind']).toBe('issue_reported');
      expect(event['sessionId']).toBe('sess-abc');
      expect(event['issueKind']).toBe('unexpected_behavior');
      expect(event['severity']).toBe('warn');
      expect(event['summary']).toBe('Unexpected output from git status');
    });

    it('does not emit an event when no emitter is provided', async () => {
      // If no emitter, no event -- no error should occur.
      const tool = makeReportIssueTool('sess-abc', undefined, undefined, tmpDir);
      await expect(
        tool.execute('call-1', {
          kind: 'self_correction',
          severity: 'info',
          summary: 'Made a decision',
        }),
      ).resolves.toBeDefined();
    });
  });
});
