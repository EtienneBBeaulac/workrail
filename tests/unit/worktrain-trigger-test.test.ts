/**
 * Unit tests for executeWorktrainTriggerTestCommand
 *
 * Uses fake deps (in-memory, no real I/O). No vi.mock() -- follows repo pattern
 * of "prefer fakes over mocks".
 *
 * Test cases:
 * 1. Non-queue trigger returns error
 * 2. Clean run prints dispatch for ready issue
 * 3. Skips issue with active session
 * 4. Skips idea-maturity issue
 * 5. Concurrency cap causes all-skip
 */

import { describe, it, expect } from 'vitest';
import {
  executeWorktrainTriggerTestCommand,
  type WorktrainTriggerTestDeps,
} from '../../src/cli/commands/worktrain-trigger-test.js';
import type { TriggerDefinition } from '../../src/trigger/types.js';
import type { GitHubQueueConfig } from '../../src/trigger/github-queue-config.js';
import type { GitHubQueueIssue } from '../../src/trigger/adapters/github-queue-poller.js';

// ═══════════════════════════════════════════════════════════════════════════
// TEST FIXTURES
// ═══════════════════════════════════════════════════════════════════════════

const QUEUE_POLL_TRIGGER: TriggerDefinition = {
  id: 'self-improvement' as TriggerDefinition['id'],
  provider: 'github_queue_poll',
  workflowId: 'coding-task-workflow-agentic',
  workspacePath: '/workspace',
  goal: 'Autonomous task',
  concurrencyMode: 'serial',
  pollingSource: {
    provider: 'github_queue_poll',
    repo: 'EtienneBBeaulac/workrail',
    token: 'ghp_fake',
    pollIntervalSeconds: 300,
  },
};

const GENERIC_TRIGGER: TriggerDefinition = {
  id: 'webhook-trigger' as TriggerDefinition['id'],
  provider: 'generic',
  workflowId: 'coding-task-workflow-agentic',
  workspacePath: '/workspace',
  goal: 'Handle webhook',
  concurrencyMode: 'serial',
};

const QUEUE_CONFIG: GitHubQueueConfig = {
  type: 'label',
  queueLabel: 'worktrain:ready',
  repo: 'EtienneBBeaulac/workrail',
  token: 'ghp_fake',
  pollIntervalSeconds: 300,
  maxTotalConcurrentSessions: 1,
  excludeLabels: [],
};

function makeIssue(overrides: Partial<GitHubQueueIssue> = {}): GitHubQueueIssue {
  return {
    id: 127,
    number: 127,
    title: 'Add findingCategory to review-verdict schema',
    body: 'upstream_spec: https://example.com/spec/review-verdict',
    url: 'https://github.com/EtienneBBeaulac/workrail/issues/127',
    labels: [],
    createdAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function makeBaseDeps(overrides: Partial<WorktrainTriggerTestDeps> = {}): {
  deps: WorktrainTriggerTestDeps;
  printLines: string[];
  stderrLines: string[];
} {
  const printLines: string[] = [];
  const stderrLines: string[] = [];

  const triggerIndex = new Map<string, TriggerDefinition>([
    ['self-improvement', QUEUE_POLL_TRIGGER],
    ['webhook-trigger', GENERIC_TRIGGER],
  ]);

  const deps: WorktrainTriggerTestDeps = {
    loadTriggerConfig: async () => ({ kind: 'ok', value: triggerIndex }),
    loadQueueConfig: async () => ({ kind: 'ok', value: QUEUE_CONFIG }),
    pollGitHubQueueIssues: async () => ({ kind: 'ok', value: [makeIssue()] }),
    countActiveSessions: async () => 0,
    checkIdempotency: async () => 'clear',
    inferMaturity: () => 'ready',
    print: (line) => printLines.push(line),
    stderr: (line) => stderrLines.push(line),
    ...overrides,
  };

  return { deps, printLines, stderrLines };
}

const VALID_OPTS = { triggerId: 'self-improvement' };

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('executeWorktrainTriggerTestCommand', () => {
  it('1. Non-queue trigger returns error with specified message', async () => {
    const { deps, stderrLines } = makeBaseDeps();

    const result = await executeWorktrainTriggerTestCommand(deps, { triggerId: 'webhook-trigger' });

    expect(result.kind).toBe('failure');
    // The spec requires a specific error message
    const errorMessage = stderrLines.join('\n');
    expect(errorMessage).toContain('webhook-trigger');
    expect(errorMessage).toContain('not a queue poll trigger');
    expect(errorMessage).toContain('only github_queue_poll triggers can be tested with this command');
  });

  it('2. Clean run: prints WOULD DISPATCH for ready issue and exits 0', async () => {
    const issue = makeIssue({
      number: 127,
      title: 'Add findingCategory to review-verdict schema',
      body: 'upstream_spec: https://example.com/spec/review-verdict',
    });

    const { deps, printLines } = makeBaseDeps({
      pollGitHubQueueIssues: async () => ({ kind: 'ok', value: [issue] }),
      inferMaturity: () => 'ready',
    });

    const result = await executeWorktrainTriggerTestCommand(deps, VALID_OPTS);

    expect(result.kind).toBe('success');
    const output = printLines.join('\n');
    expect(output).toContain('[DryRun] Trigger: self-improvement (github_queue_poll)');
    expect(output).toContain('#127');
    expect(output).toContain('WOULD DISPATCH');
    expect(output).toContain('maturity: ready');
    expect(output).toContain('1 would dispatch');
  });

  it('3. Skips issue with active session (reason: active_session)', async () => {
    const issue = makeIssue({ number: 119, title: 'Stuck detection escalation' });

    const { deps, printLines } = makeBaseDeps({
      pollGitHubQueueIssues: async () => ({ kind: 'ok', value: [issue] }),
      checkIdempotency: async () => 'active',
    });

    const result = await executeWorktrainTriggerTestCommand(deps, VALID_OPTS);

    // WHY failure: exit 1 when no issues would dispatch (scripting convention)
    expect(result.kind).toBe('failure');
    const output = printLines.join('\n');
    expect(output).toContain('#119');
    expect(output).toContain('WOULD SKIP');
    expect(output).toContain('active_session');
    expect(output).toContain('0 would dispatch');
  });

  it('4. Skips idea-maturity issue (reason: maturity=idea)', async () => {
    const issue = makeIssue({ number: 103, title: 'Jira polling trigger', body: 'No spec here.' });

    const { deps, printLines } = makeBaseDeps({
      pollGitHubQueueIssues: async () => ({ kind: 'ok', value: [issue] }),
      inferMaturity: () => 'idea',
    });

    const result = await executeWorktrainTriggerTestCommand(deps, VALID_OPTS);

    expect(result.kind).toBe('failure');
    const output = printLines.join('\n');
    expect(output).toContain('#103');
    expect(output).toContain('WOULD SKIP');
    expect(output).toContain('maturity=idea');
    expect(output).toContain('0 would dispatch');
  });

  it('5. Concurrency cap: all-skip when activeSessions >= maxTotalConcurrentSessions', async () => {
    const { deps, printLines } = makeBaseDeps({
      // Active sessions already at the cap
      countActiveSessions: async () => 1,
      // QUEUE_CONFIG.maxTotalConcurrentSessions = 1, so 1 >= 1 = skip
    });

    const result = await executeWorktrainTriggerTestCommand(deps, VALID_OPTS);

    expect(result.kind).toBe('failure');
    const output = printLines.join('\n');
    expect(output).toContain('Concurrency cap reached');
    expect(output).toContain('0 would dispatch');
  });
});
