/**
 * Tests for src/trigger/trigger-router.ts and src/trigger/trigger-listener.ts
 *
 * Covers:
 * - HMAC validation (valid, invalid, missing)
 * - contextMapping: dot-path extraction, missing key, array path warning
 * - Trigger not found (unknown triggerId)
 * - Open trigger (no HMAC configured)
 * - runWorkflow() called with correct workflowId, goal, workspacePath, context
 * - goalTemplate interpolation, fallback, warn on missing token
 * - referenceUrls forwarding to WorkflowTrigger
 * - Feature flag gate in startTriggerListener()
 * - Port conflict handling
 * - triggers.yml file-not-found handling (empty config)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TriggerRouter, interpolateGoalTemplate } from '../../src/trigger/trigger-router.js';
import type { AdaptiveCoordinatorDeps, ModeExecutors, PipelineOutcome } from '../../src/coordinators/adaptive-pipeline.js';
import { createTriggerApp, startTriggerListener } from '../../src/trigger/trigger-listener.js';
import type { RunWorkflowFn } from '../../src/trigger/trigger-router.js';
import type { ExecFn } from '../../src/trigger/delivery-action.js';
import type { TriggerDefinition, WebhookEvent } from '../../src/trigger/types.js';
import { asTriggerId } from '../../src/trigger/types.js';
import type { V2ToolContext } from '../../src/mcp/types.js';
import type { NotificationService } from '../../src/trigger/notification-service.js';
import type { SessionSource, AllocatedSession } from '../../src/daemon/types.js';
import { tmpPath } from '../helpers/platform.js';

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

/** Minimal fake V2ToolContext -- the trigger module only passes it through to runWorkflow(). */
const FAKE_CTX = {} as V2ToolContext;
const FAKE_API_KEY = 'test-api-key';

function makeTrigger(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
  return {
    id: asTriggerId('test-trigger'),
    provider: 'generic',
    workflowId: 'wr.coding-task',
    workspacePath: '/workspace',
    goal: 'Review this MR',
    concurrencyMode: 'serial',
    ...overrides,
  };
}

function makeIndex(
  trigger: TriggerDefinition,
): ReadonlyMap<string, TriggerDefinition> {
  return new Map([[trigger.id, trigger]]);
}

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  const payload = overrides.payload ?? { pull_request: { html_url: 'https://example.com/mr/1', title: 'My MR' } };
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    triggerId: asTriggerId('test-trigger'),
    rawBody,
    payload,
    ...overrides,
  };
}

function computeHmac(secret: string, rawBody: Buffer): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function makeFakeRunWorkflow(lastStepNotes?: string): {
  fn: RunWorkflowFn;
  calls: Parameters<RunWorkflowFn>[0][];
} {
  const calls: Parameters<RunWorkflowFn>[0][] = [];
  const fn: RunWorkflowFn = async (trigger) => {
    calls.push(trigger);
    return {
      _tag: 'success',
      workflowId: trigger.workflowId,
      stopReason: 'stop',
      ...(lastStepNotes !== undefined ? { lastStepNotes } : {}),
    };
  };
  return { fn, calls };
}

/**
 * A valid JSON handoff block that passes parseHandoffArtifact + assembleArtifact validation.
 * Used to test the delivery wiring: maybeRunDelivery reaches execFn when autoCommit is true.
 *
 * Critical: must include all required fields and a non-empty filesChanged array.
 * Missing any field causes maybeRunDelivery to warn and return without calling execFn.
 */
const VALID_HANDOFF_NOTES = `
\`\`\`json
{
  "commitType": "feat",
  "commitScope": "mcp",
  "commitSubject": "feat(mcp): add auto-commit support",
  "prTitle": "feat(mcp): add auto-commit support",
  "prBody": "## Summary\\n- Added auto-commit\\n\\n## Test plan\\n- [ ] Tests pass",
  "filesChanged": ["src/trigger/delivery-action.ts"],
  "followUpTickets": []
}
\`\`\`
`;

// ---------------------------------------------------------------------------
// TriggerRouter: HMAC validation
// ---------------------------------------------------------------------------

describe('TriggerRouter.route', () => {
  describe('HMAC validation', () => {
    it('accepts a valid HMAC signature', async () => {
      const secret = 'my-secret-123';
      const trigger = makeTrigger({ hmacSecret: secret });
      const { fn, calls } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      const event = makeEvent();
      const sig = computeHmac(secret, event.rawBody);
      const result = router.route({ ...event, signature: sig });

      expect(result._tag).toBe('enqueued');
      // Wait for async queue to process
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toHaveLength(1);
    });

    it('accepts sha256= prefixed HMAC signature (GitHub style)', async () => {
      const secret = 'my-secret-123';
      const trigger = makeTrigger({ hmacSecret: secret });
      const { fn, calls } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      const event = makeEvent();
      const sig = 'sha256=' + computeHmac(secret, event.rawBody);
      const result = router.route({ ...event, signature: sig });

      expect(result._tag).toBe('enqueued');
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toHaveLength(1);
    });

    it('rejects a wrong HMAC signature', () => {
      const trigger = makeTrigger({ hmacSecret: 'correct-secret' });
      const { fn } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      const event = makeEvent();
      const result = router.route({ ...event, signature: 'wrong-sig' });

      expect(result._tag).toBe('error');
      if (result._tag !== 'error') return;
      expect(result.error.kind).toBe('hmac_invalid');
    });

    it('rejects a missing signature when hmacSecret is configured', () => {
      const trigger = makeTrigger({ hmacSecret: 'secret' });
      const { fn } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      const event = makeEvent();
      // No signature field
      const result = router.route({ ...event, signature: undefined });

      expect(result._tag).toBe('error');
      if (result._tag !== 'error') return;
      expect(result.error.kind).toBe('hmac_invalid');
    });

    it('accepts a trigger with no hmacSecret (open trigger)', async () => {
      const trigger = makeTrigger({ hmacSecret: undefined });
      const { fn, calls } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      const event = makeEvent();
      const result = router.route(event);

      expect(result._tag).toBe('enqueued');
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toHaveLength(1);
    });
  });

  describe('trigger lookup', () => {
    it('returns not_found for unknown triggerId', () => {
      const trigger = makeTrigger();
      const { fn } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      const event = makeEvent({ triggerId: asTriggerId('unknown-trigger') });
      const result = router.route(event);

      expect(result._tag).toBe('error');
      if (result._tag !== 'error') return;
      expect(result.error.kind).toBe('not_found');
    });
  });

  describe('contextMapping', () => {
    it('applies dot-path contextMapping to payload', async () => {
      const trigger = makeTrigger({
        contextMapping: {
          mappings: [
            { workflowContextKey: 'mrUrl', payloadPath: '$.pull_request.html_url' },
            { workflowContextKey: 'mrTitle', payloadPath: '$.pull_request.title' },
          ],
        },
      });
      const { fn, calls } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      const payload = { pull_request: { html_url: 'https://example.com/mr/1', title: 'My MR' } };
      const event = makeEvent({ payload, rawBody: Buffer.from(JSON.stringify(payload)) });
      router.route(event);

      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.context?.['mrUrl']).toBe('https://example.com/mr/1');
      expect(calls[0]?.context?.['mrTitle']).toBe('My MR');
    });

    it('uses raw payload as context.payload when no contextMapping is configured', async () => {
      const trigger = makeTrigger({ contextMapping: undefined });
      const { fn, calls } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      const payload = { action: 'opened', number: 42 };
      const event = makeEvent({ payload, rawBody: Buffer.from(JSON.stringify(payload)) });
      router.route(event);

      await new Promise((r) => setTimeout(r, 10));
      expect(calls[0]?.context?.['payload']).toEqual(payload);
    });

    it('omits context key when path does not exist in payload', async () => {
      const trigger = makeTrigger({
        contextMapping: {
          mappings: [
            { workflowContextKey: 'missingKey', payloadPath: '$.nonexistent.field' },
          ],
        },
      });
      const { fn, calls } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      const payload = { pull_request: { html_url: 'https://example.com' } };
      const event = makeEvent({ payload, rawBody: Buffer.from(JSON.stringify(payload)) });
      router.route(event);

      await new Promise((r) => setTimeout(r, 10));
      expect(calls[0]?.context?.['missingKey']).toBeUndefined();
    });

    it('logs warning and returns undefined for array path segments', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const trigger = makeTrigger({
        contextMapping: {
          mappings: [
            { workflowContextKey: 'label', payloadPath: '$.labels[0]' },
          ],
        },
      });
      const { fn, calls } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      const payload = { labels: ['bug', 'enhancement'] };
      const event = makeEvent({ payload, rawBody: Buffer.from(JSON.stringify(payload)) });
      router.route(event);

      await new Promise((r) => setTimeout(r, 10));
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Array indexing is not supported'),
      );
      expect(calls[0]?.context?.['label']).toBeUndefined();
      warnSpy.mockRestore();
    });
  });

  describe('runWorkflow() arguments', () => {
    it('calls runWorkflow() with correct workflowId, goal, workspacePath', async () => {
      const trigger = makeTrigger({
        workflowId: 'wr.mr-review',
        goal: 'Review this MR carefully',
        workspacePath: '/my/workspace',
      });
      const { fn, calls } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      router.route(makeEvent());
      await new Promise((r) => setTimeout(r, 10));

      expect(calls[0]?.workflowId).toBe('wr.mr-review');
      expect(calls[0]?.goal).toBe('Review this MR carefully');
      expect(calls[0]?.workspacePath).toBe('/my/workspace');
    });
  });

  describe('concurrencyMode', () => {
    /**
     * Helper: creates a runWorkflowFn that blocks until the returned release() is called.
     * Tracks how many calls are currently in-flight (started but not yet released).
     */
    function makeLatchedRunWorkflow(): {
      fn: RunWorkflowFn;
      inFlight: () => number;
      releaseAll: () => void;
    } {
      let inFlightCount = 0;
      const releaseFns: Array<() => void> = [];

      const fn: RunWorkflowFn = async (trigger) => {
        inFlightCount++;
        await new Promise<void>((resolve) => {
          releaseFns.push(resolve);
        });
        inFlightCount--;
        return { _tag: 'success', workflowId: trigger.workflowId, stopReason: 'stop' };
      };

      return {
        fn,
        inFlight: () => inFlightCount,
        releaseAll: () => releaseFns.forEach((r) => r()),
      };
    }

    /**
     * Make events with unique goals so the 30s dedup window does not suppress them.
     * Concurrency tests verify queue serialization/parallelism for distinct tasks --
     * they are not testing dedup behavior.
     */
    function makeUniqueEvents(count: number): ReturnType<typeof makeEvent>[] {
      return Array.from({ length: count }, (_, i) => {
        const payload = { pull_request: { html_url: `https://example.com/mr/${i}`, title: `MR ${i}` } };
        return makeEvent({ payload, rawBody: Buffer.from(JSON.stringify(payload)) });
      });
    }

    it('serial trigger: second call does not start until first completes (same queue key)', async () => {
      // Proves the serial ternary: queueKey = trigger.id (not trigger.id:UUID).
      // If the ternary were inverted to 'parallel', BOTH calls would be in-flight
      // after the first flush and this test would fail.
      //
      // WHY unique goals: the 30s dedup window suppresses duplicate goal+workspace dispatches.
      // Concurrency tests verify queue serialization for distinct tasks, not dedup behavior.
      const trigger = makeTrigger({
        concurrencyMode: 'serial',
        goalTemplate: '{{$.pull_request.title}}',
      });
      const { fn, inFlight, releaseAll } = makeLatchedRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      // Fire two events with unique goals -- the queue processes them serially.
      const [event1, event2] = makeUniqueEvents(2);
      router.route(event1!);
      router.route(event2!);

      // Drain the microtask queue so KeyedAsyncQueue has had a chance to start
      // the first call (and NOT start the second, since they share the same key).
      await new Promise<void>((r) => setImmediate(r));

      // Only the first call should be in-flight; second is queued, not started.
      expect(inFlight()).toBe(1);

      // Release the first call and drain again -- second should now start.
      releaseAll();
      await new Promise<void>((r) => setImmediate(r));
      expect(inFlight()).toBe(1); // second call is now running

      // Release the second call and confirm everything completes.
      releaseAll();
      await new Promise<void>((r) => setImmediate(r));
      expect(inFlight()).toBe(0);
    });

    it('parallel trigger: both calls start simultaneously (different queue keys per invocation)', async () => {
      // Proves the parallel ternary: queueKey = trigger.id:UUID (unique per fire).
      // If the ternary were inverted to 'serial', only one call would be in-flight
      // after the flush and this test would fail.
      //
      // WHY unique goals: the 30s dedup window suppresses duplicate goal+workspace dispatches.
      // Concurrency tests verify queue parallelism for distinct tasks, not dedup behavior.
      const trigger = makeTrigger({
        concurrencyMode: 'parallel',
        goalTemplate: '{{$.pull_request.title}}',
      });
      const { fn, inFlight, releaseAll } = makeLatchedRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      // Fire two events with unique goals -- each gets its own queue key, so both
      // start concurrently without waiting for the other.
      const [event1, event2] = makeUniqueEvents(2);
      router.route(event1!);
      router.route(event2!);

      // Drain the microtask queue -- both calls should now be in-flight.
      await new Promise<void>((r) => setImmediate(r));

      // Both calls must be in-flight simultaneously, proving unique queue keys.
      expect(inFlight()).toBe(2);

      // Release both and confirm completion.
      releaseAll();
      await new Promise<void>((r) => setImmediate(r));
      expect(inFlight()).toBe(0);
    });
  });

  describe('delivery wiring (autoCommit)', () => {
    it('calls execFn when trigger has autoCommit:true and workflow succeeds with lastStepNotes', async () => {
      // Verifies end-to-end wiring: TriggerRouter.route() -> runWorkflow() ->
      // maybeRunDelivery() -> execFn. Injectable execFn avoids forking real child processes.
      //
      // Critical: runWorkflowFn must return lastStepNotes with a valid JSON handoff block.
      // Without lastStepNotes, maybeRunDelivery returns early (trigger-router.ts ~line 259).
      const fakeExec: ExecFn = vi.fn().mockResolvedValue({ stdout: '[main abc1234] feat(mcp): auto-commit\n', stderr: '' });

      const trigger = makeTrigger({ autoCommit: true });
      const { fn } = makeFakeRunWorkflow(VALID_HANDOFF_NOTES);
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn, fakeExec);

      router.route(makeEvent());

      // Wait for the async queue to process (runWorkflow + maybeRunDelivery)
      await new Promise<void>((r) => setTimeout(r, 50));

      // execFn must have been called at least once (git add is the first call)
      expect(fakeExec).toHaveBeenCalled();

      // Verify the first call is git add (file='git', args[0]='add')
      const firstCall = (fakeExec as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], unknown];
      expect(firstCall[0]).toBe('git');
      expect(firstCall[1][0]).toBe('add');
    });

    it('does NOT call execFn when autoCommit is false', async () => {
      // Delivery opt-in gate: autoCommit must be explicitly true.
      const fakeExec: ExecFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

      const trigger = makeTrigger({ autoCommit: false });
      const { fn } = makeFakeRunWorkflow(VALID_HANDOFF_NOTES);
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn, fakeExec);

      router.route(makeEvent());
      await new Promise<void>((r) => setTimeout(r, 50));

      // execFn must NOT be called -- autoCommit is false (opt-in semantics)
      expect(fakeExec).not.toHaveBeenCalled();
    });

    it('uses sessionWorkspacePath as cwd for delivery when runWorkflow returns a worktree session', async () => {
      // Regression guard for the CRITICAL bug: delivery (git add, commit, push, gh pr create)
      // must run inside the worktree, not trigger.workspacePath. This test closes the gap that
      // let the bug go undetected.
      //
      // Setup: trigger with branchStrategy:'worktree' and autoCommit:true.
      // runWorkflowFn returns a WorkflowRunSuccess with sessionWorkspacePath pointing to a
      // (fake) worktree directory. The test verifies that execFn is called with the worktree
      // path as the cwd -- NOT trigger.workspacePath ('/workspace').
      const SESSION_ID = 'test-session-abc123';
      const WORKTREE_PATH = `/worktrees/${SESSION_ID}`;
      const BRANCH_PREFIX = 'worktrain/';
      // fakeExec returns different values per command:
      // - git rev-parse (HEAD branch check) must return the expected branch name
      // - git add / git commit return a standard commit line
      // - git worktree remove returns empty (cleanup after delivery)
      const fakeExec: ExecFn = vi.fn().mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'rev-parse') {
          return Promise.resolve({ stdout: `${BRANCH_PREFIX}${SESSION_ID}\n`, stderr: '' });
        }
        return Promise.resolve({ stdout: '[main abc1234] feat: test\n', stderr: '' });
      });

      const trigger = makeTrigger({
        autoCommit: true,
        branchStrategy: 'worktree',
        workspacePath: '/workspace',
        branchPrefix: BRANCH_PREFIX,
      });

      const fn: RunWorkflowFn = async (t) => ({
        _tag: 'success',
        workflowId: t.workflowId,
        stopReason: 'stop',
        lastStepNotes: VALID_HANDOFF_NOTES,
        sessionWorkspacePath: WORKTREE_PATH,
        sessionId: SESSION_ID,
      });

      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn, fakeExec);

      router.route(makeEvent());

      // Wait for the async queue to process (runWorkflow + maybeRunDelivery)
      await new Promise<void>((r) => setTimeout(r, 50));

      // execFn must have been called
      expect(fakeExec).toHaveBeenCalled();

      // Every git call that involves file operations (add, commit) must use the worktree path.
      // The first call is git add -- verify cwd is the worktree path, NOT trigger.workspacePath.
      const allCalls = (fakeExec as ReturnType<typeof vi.fn>).mock.calls as [string, string[], { cwd?: string }][];
      const addCall = allCalls.find(([, args]) => args[0] === 'add');
      expect(addCall).toBeDefined();
      if (addCall !== undefined) {
        const opts = addCall[2];
        expect(opts?.cwd).toBe(WORKTREE_PATH);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Feature flag gate
// ---------------------------------------------------------------------------

describe('startTriggerListener feature flag', () => {
  it('returns null when WORKRAIL_TRIGGERS_ENABLED is not set', async () => {
    const result = await startTriggerListener(FAKE_CTX, {
      workspacePath: '/tmp',
      apiKey: 'key',
      env: {}, // no WORKRAIL_TRIGGERS_ENABLED
    });
    expect(result).toBeNull();
  });

  it('returns null when WORKRAIL_TRIGGERS_ENABLED is "false"', async () => {
    const result = await startTriggerListener(FAKE_CTX, {
      workspacePath: '/tmp',
      apiKey: 'key',
      env: { WORKRAIL_TRIGGERS_ENABLED: 'false' },
    });
    expect(result).toBeNull();
  });

  it('returns feature_disabled when flag is missing (null is returned, not err)', async () => {
    const result = await startTriggerListener(FAKE_CTX, {
      workspacePath: '/tmp',
      apiKey: 'key',
      env: {},
    });
    expect(result).toBeNull();
  });

  it('returns missing_api_key error when API key is absent and flag is enabled', async () => {
    const result = await startTriggerListener(FAKE_CTX, {
      workspacePath: '/nonexistent',
      // no apiKey
      env: { WORKRAIL_TRIGGERS_ENABLED: 'true' },
      runWorkflowFn: vi.fn(),
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    expect('_kind' in result).toBe(true);
    if (!('_kind' in result)) return;
    expect((result as { _kind: string; error: { kind: string } }).error.kind).toBe('missing_api_key');
  });

  it('starts with empty config when triggers.yml is missing', async () => {
    const { fn } = makeFakeRunWorkflow();
    const result = await startTriggerListener(FAKE_CTX, {
      workspacePath: tmpPath('nonexistent-workspace-xyz'),
      apiKey: 'test-key',
      env: { WORKRAIL_TRIGGERS_ENABLED: 'true' },
      runWorkflowFn: fn,
      port: 0, // OS assigns a free port
    });

    // Should succeed (empty config, not an error)
    expect(result).not.toBeNull();
    if (result === null) return;
    if ('_kind' in result) {
      // Should not be an error for missing file
      expect((result as { _kind: string; error: { kind: string } }).error.kind).not.toBe('file_not_found');
      return;
    }
    expect(result.port).toBeGreaterThan(0);
    await result.stop();
  });
});

// ---------------------------------------------------------------------------
// startTriggerListener: workflowId validation
//
// Verifies that triggers with unknown workflowIds are warned and skipped at
// startup, and that triggers with valid workflowIds are kept in the index.
// ---------------------------------------------------------------------------

describe('startTriggerListener workflowId validation', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-wfid-validation-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Write a triggers.yml with one or more triggers to tempDir. */
  async function writeTriggers(yaml: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(tempDir, 'ws-'));
    await fs.writeFile(path.join(dir, 'triggers.yml'), yaml, 'utf8');
    return dir;
  }

  function makeTriggerYaml(id: string, workflowId: string): string {
    return [
      'triggers:',
      `  - id: ${id}`,
      `    provider: generic`,
      `    workflowId: ${workflowId}`,
      `    workspacePath: /workspace`,
      `    goal: "Test goal"`,
    ].join('\n') + '\n';
  }

  it('skips trigger with unknown workflowId and logs a warning', async () => {
    const wsDir = await writeTriggers(makeTriggerYaml('bad-trigger', 'nonexistent-workflow'));
    const { fn: runWorkflowFn } = makeFakeRunWorkflow();

    // Resolver: no workflows known
    const getWorkflowByIdFn = vi.fn().mockResolvedValue(false);

    const result = await startTriggerListener(FAKE_CTX, {
      workspacePath: wsDir,
      apiKey: 'test-key',
      env: { WORKRAIL_TRIGGERS_ENABLED: 'true' },
      runWorkflowFn,
      workspaces: {},
      port: 0,
      getWorkflowByIdFn,
    });

    expect(result).not.toBeNull();
    if (result === null || '_kind' in result) {
      expect.fail('Expected a successful listener handle');
      return;
    }

    // The bad trigger was validated
    expect(getWorkflowByIdFn).toHaveBeenCalledWith('nonexistent-workflow');

    // The router has no triggers (bad trigger was removed)
    const triggers = result.router.listTriggers();
    expect(triggers).toHaveLength(0);

    await result.stop();
  });

  it('keeps trigger with valid workflowId', async () => {
    const wsDir = await writeTriggers(makeTriggerYaml('good-trigger', 'wr.coding-task'));
    const { fn: runWorkflowFn } = makeFakeRunWorkflow();

    // Resolver: this workflow is known
    const getWorkflowByIdFn = vi.fn().mockResolvedValue(true);

    const result = await startTriggerListener(FAKE_CTX, {
      workspacePath: wsDir,
      apiKey: 'test-key',
      env: { WORKRAIL_TRIGGERS_ENABLED: 'true' },
      runWorkflowFn,
      workspaces: {},
      port: 0,
      getWorkflowByIdFn,
    });

    expect(result).not.toBeNull();
    if (result === null || '_kind' in result) {
      expect.fail('Expected a successful listener handle');
      return;
    }

    expect(getWorkflowByIdFn).toHaveBeenCalledWith('wr.coding-task');

    const triggers = result.router.listTriggers();
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.workflowId).toBe('wr.coding-task');

    await result.stop();
  });

  it('skips bad triggers and keeps good ones in a mixed config', async () => {
    const yaml = [
      'triggers:',
      '  - id: good-trigger',
      '    provider: generic',
      '    workflowId: wr.coding-task',
      '    workspacePath: /workspace',
      '    goal: "Good trigger"',
      '  - id: bad-trigger',
      '    provider: generic',
      '    workflowId: nonexistent-workflow.v2',
      '    workspacePath: /workspace',
      '    goal: "Bad trigger"',
    ].join('\n') + '\n';
    const wsDir = await writeTriggers(yaml);
    const { fn: runWorkflowFn } = makeFakeRunWorkflow();

    const getWorkflowByIdFn = vi.fn().mockImplementation(async (id: string) =>
      id === 'wr.coding-task',
    );

    const result = await startTriggerListener(FAKE_CTX, {
      workspacePath: wsDir,
      apiKey: 'test-key',
      env: { WORKRAIL_TRIGGERS_ENABLED: 'true' },
      runWorkflowFn,
      workspaces: {},
      port: 0,
      getWorkflowByIdFn,
    });

    expect(result).not.toBeNull();
    if (result === null || '_kind' in result) {
      expect.fail('Expected a successful listener handle');
      return;
    }

    const triggers = result.router.listTriggers();
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.id).toBe('good-trigger');

    await result.stop();
  });

  it('skips validation entirely and keeps all triggers when getWorkflowByIdFn is not provided', async () => {
    const wsDir = await writeTriggers(makeTriggerYaml('any-trigger', 'nonexistent-workflow'));
    const { fn: runWorkflowFn } = makeFakeRunWorkflow();

    // No getWorkflowByIdFn -- validation should be skipped
    const result = await startTriggerListener(FAKE_CTX, {
      workspacePath: wsDir,
      apiKey: 'test-key',
      env: { WORKRAIL_TRIGGERS_ENABLED: 'true' },
      runWorkflowFn,
      workspaces: {},
      port: 0,
      // no getWorkflowByIdFn
    });

    expect(result).not.toBeNull();
    if (result === null || '_kind' in result) {
      expect.fail('Expected a successful listener handle');
      return;
    }

    // Trigger is present because validation was skipped
    const triggers = result.router.listTriggers();
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.id).toBe('any-trigger');

    await result.stop();
  });

  it('skips trigger when getWorkflowByIdFn rejects (does not crash the daemon)', async () => {
    const wsDir = await writeTriggers(makeTriggerYaml('error-trigger', 'some-workflow'));
    const { fn: runWorkflowFn } = makeFakeRunWorkflow();

    // Resolver throws an error
    const getWorkflowByIdFn = vi.fn().mockRejectedValue(new Error('Storage I/O error'));

    const result = await startTriggerListener(FAKE_CTX, {
      workspacePath: wsDir,
      apiKey: 'test-key',
      env: { WORKRAIL_TRIGGERS_ENABLED: 'true' },
      runWorkflowFn,
      workspaces: {},
      port: 0,
      getWorkflowByIdFn,
    });

    // Daemon should still start (no crash)
    expect(result).not.toBeNull();
    if (result === null || '_kind' in result) {
      expect.fail('Expected a successful listener handle (resolver errors do not crash the daemon)');
      return;
    }

    // Trigger is skipped because resolver rejected
    const triggers = result.router.listTriggers();
    expect(triggers).toHaveLength(0);

    await result.stop();
  });
});

// ---------------------------------------------------------------------------
// Express app: route responses
// ---------------------------------------------------------------------------

describe('createTriggerApp routes', () => {
  it('GET /health returns 200 { status: "ok" }', async () => {
    const trigger = makeTrigger();
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);
    const app = createTriggerApp(router);

    // Use supertest-like approach with http
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('ok');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('POST /webhook/:triggerId returns 202 for valid open trigger', async () => {
    const trigger = makeTrigger({ hmacSecret: undefined });
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);
    const app = createTriggerApp(router);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const payload = { action: 'opened' };
      const res = await fetch(`http://localhost:${port}/webhook/test-trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(202);
      const body = await res.json() as { status: string; triggerId: string };
      expect(body.status).toBe('accepted');
      expect(body.triggerId).toBe('test-trigger');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('POST /webhook/:triggerId returns 404 for unknown triggerId', async () => {
    const trigger = makeTrigger();
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);
    const app = createTriggerApp(router);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://localhost:${port}/webhook/unknown-trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('POST /webhook/:triggerId returns 401 for wrong HMAC', async () => {
    const trigger = makeTrigger({ hmacSecret: 'correct-secret' });
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);
    const app = createTriggerApp(router);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://localhost:${port}/webhook/test-trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-workrail-signature': 'wrong-signature',
        },
        body: '{"action":"opened"}',
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('POST /webhook/:triggerId returns 400 for invalid JSON body', async () => {
    const trigger = makeTrigger();
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);
    const app = createTriggerApp(router);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://localhost:${port}/webhook/test-trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-valid-json',
      });
      expect(res.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// interpolateGoalTemplate: unit tests
// ---------------------------------------------------------------------------

describe('interpolateGoalTemplate', () => {
  it('interpolates all tokens from payload', () => {
    const result = interpolateGoalTemplate(
      'Review MR: {{$.pull_request.title}} by {{$.user.login}}',
      'Review this MR',
      { pull_request: { title: 'Fix bug' }, user: { login: 'alice' } },
      'test-trigger',
    );
    expect(result).toBe('Review MR: Fix bug by alice');
  });

  it('falls back to staticGoal and warns when a token is missing from payload', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = interpolateGoalTemplate(
      'Review MR: {{$.pull_request.title}}',
      'Review this MR',
      { pull_request: {} }, // title is missing
      'my-trigger',
    );
    expect(result).toBe('Review this MR');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('$.pull_request.title'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('my-trigger'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Review MR: {{$.pull_request.title}}'),
    );
    warnSpy.mockRestore();
  });

  it('returns template as-is when no tokens are present', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = interpolateGoalTemplate(
      'Review this PR',
      'Fallback goal',
      { pull_request: { title: 'irrelevant' } },
      'test-trigger',
    );
    expect(result).toBe('Review this PR');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('handles token path without leading $. prefix', () => {
    const result = interpolateGoalTemplate(
      'Review MR: {{pull_request.title}}',
      'Review this MR',
      { pull_request: { title: 'My Feature' } },
      'test-trigger',
    );
    expect(result).toBe('Review MR: My Feature');
  });

  it('includes triggerId in warn message', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    interpolateGoalTemplate(
      'Review: {{$.missing.token}}',
      'Fallback',
      {},
      'test-trigger',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('test-trigger'),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// TriggerRouter.route: referenceUrls forwarding
// ---------------------------------------------------------------------------

describe('TriggerRouter.route referenceUrls forwarding', () => {
  it('forwards referenceUrls to runWorkflow when present', async () => {
    const trigger = makeTrigger({
      referenceUrls: ['https://doc1.example.com', 'https://doc2.example.com'],
    });
    const { fn, calls } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    router.route(makeEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(calls[0]?.referenceUrls).toEqual([
      'https://doc1.example.com',
      'https://doc2.example.com',
    ]);
  });

  it('omits referenceUrls from workflowTrigger when absent', async () => {
    const trigger = makeTrigger({ referenceUrls: undefined });
    const { fn, calls } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    router.route(makeEvent());
    await new Promise((r) => setTimeout(r, 10));

    expect(calls[0]?.referenceUrls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TriggerRouter.route: callbackUrl delivery
// ---------------------------------------------------------------------------

describe('TriggerRouter.route callbackUrl delivery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delivers workflow result to callbackUrl when workflow succeeds and delivery succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
    }));

    const trigger = makeTrigger({ callbackUrl: 'https://example.com/callback' });
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const result = router.route(makeEvent());

    expect(result._tag).toBe('enqueued');
    // Wait for async queue to process
    await new Promise((r) => setTimeout(r, 20));

    // fetch was called: once for the delivery POST
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/callback');
    expect(init.method).toBe('POST');
  });

  it('logs delivery_failed when callbackUrl is set, workflow succeeds, but delivery fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const trigger = makeTrigger({ callbackUrl: 'https://example.com/callback' });
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    router.route(makeEvent());

    // Wait for async queue to process
    await new Promise((r) => setTimeout(r, 20));

    // Should log a delivery failure error
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Delivery failed'),
    );
    // Should log the outcome with the correct "succeeded but delivery failed" message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Workflow succeeded but delivery failed'),
    );

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// maxConcurrentSessions: global semaphore
// ---------------------------------------------------------------------------

describe('TriggerRouter maxConcurrentSessions semaphore', () => {
  /**
   * Helper: creates a RunWorkflowFn that blocks until release() is called per call.
   * Each call increments inFlightCount on start and decrements on release.
   * releaseNext() resolves the oldest pending call.
   * releaseAll() resolves all pending calls.
   */
  function makeLatchedRunWorkflow(): {
    fn: RunWorkflowFn;
    inFlight: () => number;
    releaseNext: () => void;
    releaseAll: () => void;
  } {
    let inFlightCount = 0;
    const releaseFns: Array<() => void> = [];

    const fn: RunWorkflowFn = async (trigger) => {
      inFlightCount++;
      await new Promise<void>((resolve) => {
        releaseFns.push(resolve);
      });
      inFlightCount--;
      return { _tag: 'success', workflowId: trigger.workflowId, stopReason: 'stop' };
    };

    return {
      fn,
      inFlight: () => inFlightCount,
      releaseNext: () => { releaseFns.shift()?.(); },
      releaseAll: () => { releaseFns.splice(0).forEach((r) => r()); },
    };
  }

  /**
   * Make N events with unique goals for semaphore/concurrency tests.
   * Each event carries a unique pull_request.title which is used as the goal
   * via goalTemplate='{{$.pull_request.title}}', so the 30s dedup window treats
   * them as distinct tasks and does not suppress any of them.
   */
  function makeUniqueEvents(count: number): ReturnType<typeof makeEvent>[] {
    return Array.from({ length: count }, (_, i) => {
      const payload = { pull_request: { html_url: `https://example.com/mr/${i}`, title: `Semaphore task ${i}` } };
      return makeEvent({ payload, rawBody: Buffer.from(JSON.stringify(payload)) });
    });
  }

  it('limits concurrent runWorkflow() calls to maxConcurrentSessions', async () => {
    // Proves the semaphore caps at the configured limit.
    // With cap=2 and 3 fires: first two should start, third should be queued.
    //
    // WHY unique goals (goalTemplate): the 30s dedup window suppresses duplicate
    // goal+workspace dispatches. Semaphore tests use distinct tasks -- each event
    // gets a unique title-based goal so the dedup does not interfere.
    const trigger = makeTrigger({ concurrencyMode: 'parallel', goalTemplate: '{{$.pull_request.title}}' });
    const { fn, inFlight, releaseAll } = makeLatchedRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn, undefined, 2);

    const [e1, e2, e3] = makeUniqueEvents(3);
    router.route(e1!);
    router.route(e2!);
    router.route(e3!);

    // Drain: give semaphore time to start the first two (third is blocked, waiting for slot).
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(inFlight()).toBe(2);
    expect(router.activeSessions).toBe(2);
    expect(router.maxConcurrentSessions).toBe(2);

    releaseAll();
    // Multiple drains needed: releaseAll() unblocks latches, but the third dispatch
    // still needs to acquire the semaphore and run -- give it time.
    await new Promise<void>((r) => setTimeout(r, 20));
    releaseAll(); // release the third dispatch (which started after first two completed)
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(inFlight()).toBe(0);
  });

  it('queue-and-wait: third dispatch proceeds after one of the first two completes', async () => {
    // Proves that queued dispatches are not dropped -- they execute once a slot opens.
    //
    // WHY unique goals (goalTemplate): dedup window would suppress identical goal+workspace
    // calls. These tests verify semaphore behavior for distinct tasks.
    const trigger = makeTrigger({ concurrencyMode: 'parallel', goalTemplate: '{{$.pull_request.title}}' });
    const { fn, inFlight, releaseNext, releaseAll } = makeLatchedRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn, undefined, 2);

    const [e1, e2, e3] = makeUniqueEvents(3);
    router.route(e1!);
    router.route(e2!);
    router.route(e3!);

    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // First two in-flight, third queued
    expect(inFlight()).toBe(2);

    // Release one slot -- third should start
    releaseNext();
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // Second original + third should now be in-flight
    expect(inFlight()).toBe(2);

    releaseAll();
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    expect(inFlight()).toBe(0);
  });

  it('releases semaphore slot when runWorkflowFn returns error result (finally block)', async () => {
    // ORANGE-1: proves the finally block releases the slot even when runWorkflowFn
    // returns an error result (workflow failed but slot must still be freed).
    // Without the finally block, a failing workflow would permanently consume a slot.
    //
    // WHY unique goals (goalTemplate): dedup window would suppress the second call.
    const trigger = makeTrigger({ concurrencyMode: 'parallel', goalTemplate: '{{$.pull_request.title}}' });
    let firstCallUnblock!: () => void;
    let secondCallResolved = false;

    const fn: RunWorkflowFn = async (t) => {
      if (!firstCallUnblock) {
        // First call: block until explicitly unblocked, then return error result
        await new Promise<void>((resolve) => { firstCallUnblock = resolve; });
        return { _tag: 'error', workflowId: t.workflowId, message: 'simulated failure', stopReason: 'stop' };
      }
      // Second call: resolves immediately -- proves slot was released after first finished
      secondCallResolved = true;
      return { _tag: 'success', workflowId: t.workflowId, stopReason: 'stop' };
    };

    // cap=1 so second dispatch can only run after first releases the semaphore slot
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn, undefined, 1);

    const [e1, e2] = makeUniqueEvents(2);
    router.route(e1!);
    await new Promise<void>((r) => setImmediate(r));

    // First call is running -- second is queued (cap=1)
    router.route(e2!);
    expect(secondCallResolved).toBe(false);

    // Unblock the first call (returns error) -- finally MUST release the slot
    firstCallUnblock();
    await new Promise<void>((r) => setTimeout(r, 20));

    // Second call must have run (slot was released by finally even though first returned error)
    expect(secondCallResolved).toBe(true);
  });

  it('defaults to 3 concurrent sessions when maxConcurrentSessions is not specified', async () => {
    // Proves the default is 3, not unlimited.
    //
    // WHY unique goals (goalTemplate): dedup window would suppress calls 2-4 with the
    // same goal+workspace. Use unique events to test the semaphore cap independently.
    const trigger = makeTrigger({ concurrencyMode: 'parallel', goalTemplate: '{{$.pull_request.title}}' });
    const { fn, inFlight, releaseAll } = makeLatchedRunWorkflow();
    // No maxConcurrentSessions argument -- should default to 3
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    expect(router.maxConcurrentSessions).toBe(3);

    // Fire 4 dispatches with unique goals -- only 3 should be in-flight simultaneously
    const [e1, e2, e3, e4] = makeUniqueEvents(4);
    router.route(e1!);
    router.route(e2!);
    router.route(e3!);
    router.route(e4!);

    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    expect(inFlight()).toBe(3);

    releaseAll();
    // Fourth dispatch was queued -- now it starts. Release it too.
    await new Promise<void>((r) => setTimeout(r, 20));
    releaseAll();
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(inFlight()).toBe(0);
  });

  it('clamps maxConcurrentSessions=0 to 1 and warns', () => {
    // Proves the illegal-state invariant: 0 or negative is clamped to 1.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const trigger = makeTrigger({ concurrencyMode: 'serial' });
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn, undefined, 0);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('clamping to 1'));
    expect(router.maxConcurrentSessions).toBe(1);

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// TriggerRouter: notify() wiring
//
// Verifies that TriggerRouter calls notificationService.notify() after each
// workflow session completes, and that it passes the FINAL result (post
// callbackUrl delivery reassignment) to notify().
// ---------------------------------------------------------------------------

describe('TriggerRouter notify() wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('route(): calls notify() with the workflow result when session completes successfully', async () => {
    // WHY: proves the wiring in route() -- after runWorkflowFn returns a success result,
    // notificationService.notify() must be called with that result and the goal string.
    const fakeNotify = { notify: vi.fn() };
    const trigger = makeTrigger();
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(
      makeIndex(trigger),
      FAKE_CTX,
      FAKE_API_KEY,
      fn,
      undefined,  // execFn
      undefined,  // maxConcurrentSessions
      undefined,  // emitter
      fakeNotify as unknown as NotificationService,
    );

    router.route(makeEvent());
    await new Promise((r) => setTimeout(r, 20));

    expect(fakeNotify.notify).toHaveBeenCalledOnce();
    const [result, goal] = fakeNotify.notify.mock.calls[0] as [{ _tag: string }, string];
    expect(result._tag).toBe('success');
    expect(goal).toBe(trigger.goal);
  });

  it('dispatch(): calls notify() with the workflow result when session fails', async () => {
    // WHY: proves the wiring in dispatch() -- when runWorkflowFn returns an error result,
    // notificationService.notify() must be called with that error result.
    const fakeNotify = { notify: vi.fn() };
    const trigger = makeTrigger();

    // Custom runWorkflowFn that returns an error result
    const errorFn: RunWorkflowFn = async (t) => ({
      _tag: 'error' as const,
      workflowId: t.workflowId,
      message: 'simulated agent error',
      stopReason: 'stop',
    });

    const router = new TriggerRouter(
      makeIndex(trigger),
      FAKE_CTX,
      FAKE_API_KEY,
      errorFn,
      undefined,  // execFn
      undefined,  // maxConcurrentSessions
      undefined,  // emitter
      fakeNotify as unknown as NotificationService,
    );

    const workflowTrigger = {
      workflowId: trigger.workflowId,
      goal: trigger.goal,
      workspacePath: trigger.workspacePath,
      context: {},
    };
    router.dispatch(workflowTrigger);
    await new Promise((r) => setTimeout(r, 20));

    expect(fakeNotify.notify).toHaveBeenCalledOnce();
    const [result] = fakeNotify.notify.mock.calls[0] as [{ _tag: string }, string];
    expect(result._tag).toBe('error');
  });

  it('route(): notify() receives delivery_failed (not success) when callbackUrl POST fails', async () => {
    // WHY: proves the ordering invariant -- route() reassigns result to delivery_failed
    // BEFORE calling notify(). If this fails, notify() would receive 'success' and the
    // user notification would not reflect the actual outcome.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }));

    const fakeNotify = { notify: vi.fn() };
    const trigger = makeTrigger({ callbackUrl: 'https://example.com/callback' });
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(
      makeIndex(trigger),
      FAKE_CTX,
      FAKE_API_KEY,
      fn,
      undefined,  // execFn
      undefined,  // maxConcurrentSessions
      undefined,  // emitter
      fakeNotify as unknown as NotificationService,
    );

    router.route(makeEvent());
    await new Promise((r) => setTimeout(r, 50));

    // notify() must have been called with the post-reassignment result
    expect(fakeNotify.notify).toHaveBeenCalledOnce();
    const [result] = fakeNotify.notify.mock.calls[0] as [{ _tag: string }, string];
    // Critical: must be 'delivery_failed', not 'success' -- proves result was reassigned
    // before notify() was called (trigger-router.ts lines 578-629).
    expect(result._tag).toBe('delivery_failed');
  });
});

// ---------------------------------------------------------------------------
// Late-bound goals: {{$.goal}} dispatches correctly via TriggerRouter.route()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TriggerRouter.route: dispatchCondition filter
// ---------------------------------------------------------------------------

describe('TriggerRouter.route dispatchCondition', () => {
  it('dispatches when dispatchCondition is met (extracted value strictly equals condition.equals)', async () => {
    // Proves the pass-through path: when condition is met, runWorkflow is called normally.
    const trigger = makeTrigger({
      dispatchCondition: {
        payloadPath: '$.assignee.login',
        equals: 'worktrain-etienneb',
      },
    });
    const { fn, calls } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const payload = { assignee: { login: 'worktrain-etienneb' } };
    router.route(makeEvent({ payload, rawBody: Buffer.from(JSON.stringify(payload)) }));
    await new Promise((r) => setTimeout(r, 20));

    // Condition met: dispatch proceeds, runWorkflow called
    expect(calls).toHaveLength(1);
  });

  it('skips dispatch when dispatchCondition not met (wrong value)', async () => {
    // Proves the skip path: when condition not met, runWorkflow is NOT called.
    // route() still returns { _tag: 'enqueued' } -- silent skip.
    const trigger = makeTrigger({
      dispatchCondition: {
        payloadPath: '$.assignee.login',
        equals: 'worktrain-etienneb',
      },
    });
    const { fn, calls } = makeFakeRunWorkflow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const payload = { assignee: { login: 'other-user' } };
    const result = router.route(makeEvent({ payload, rawBody: Buffer.from(JSON.stringify(payload)) }));
    await new Promise((r) => setTimeout(r, 20));

    // route() returns enqueued (silent -- 202 was already sent)
    expect(result._tag).toBe('enqueued');
    // runWorkflow NOT called (dispatch skipped)
    expect(calls).toHaveLength(0);
    // Debug log line emitted
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dispatch skipped: condition not met'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('other-user'));

    logSpy.mockRestore();
  });

  it('skips dispatch when dispatchCondition path not found in payload (undefined !== equals)', async () => {
    // Proves that a missing path also counts as condition not met.
    // undefined !== 'worktrain-etienneb' -> skip.
    const trigger = makeTrigger({
      dispatchCondition: {
        payloadPath: '$.nonexistent.field',
        equals: 'worktrain-etienneb',
      },
    });
    const { fn, calls } = makeFakeRunWorkflow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const payload = { action: 'opened' }; // no assignee field
    const result = router.route(makeEvent({ payload, rawBody: Buffer.from(JSON.stringify(payload)) }));
    await new Promise((r) => setTimeout(r, 20));

    expect(result._tag).toBe('enqueued');
    expect(calls).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dispatch skipped: condition not met'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('undefined'));

    logSpy.mockRestore();
  });

  it('dispatches normally when dispatchCondition is absent (no filter configured)', async () => {
    // Proves backward compatibility: triggers without dispatchCondition always dispatch.
    const trigger = makeTrigger({ dispatchCondition: undefined });
    const { fn, calls } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const payload = { action: 'opened' };
    router.route(makeEvent({ payload, rawBody: Buffer.from(JSON.stringify(payload)) }));
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Late-bound goals
// ---------------------------------------------------------------------------

describe('late-bound goals integration', () => {
  it('dispatches with payload goal when trigger has goalTemplate={{$.goal}}', async () => {
    const { fn, calls } = makeFakeRunWorkflow();
    const trigger = makeTrigger({
      goal: 'Autonomous task',
      goalTemplate: '{{$.goal}}',
    });
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const payload = { goal: 'review PR #42' };
    const rawBody = Buffer.from(JSON.stringify(payload));
    router.route({
      triggerId: asTriggerId('test-trigger'),
      rawBody,
      payload,
    });

    // Wait for the async queue to drain
    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.goal).toBe('review PR #42');
  });

  it('falls back to sentinel when payload has no goal field', async () => {
    const { fn, calls } = makeFakeRunWorkflow();
    const trigger = makeTrigger({
      goal: 'Autonomous task',
      goalTemplate: '{{$.goal}}',
    });
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payload = { pull_request: { title: 'My PR' } }; // no $.goal field
    const rawBody = Buffer.from(JSON.stringify(payload));
    router.route({
      triggerId: asTriggerId('test-trigger'),
      rawBody,
      payload,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.goal).toBe('Autonomous task');
    // interpolateGoalTemplate should have warned about the missing token
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("goalTemplate variable '$.goal' not found"));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// TriggerRouter.route and dispatch: deduplication within 30s window
//
// Verifies that rapid-fire webhook events and direct dispatches for the same
// goal+workspace are deduplicated within the 30-second TTL window, preventing
// duplicate pipeline sessions from webhook retries.
// ---------------------------------------------------------------------------

describe('TriggerRouter.route and dispatch deduplication', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('route(): second dispatch for the same goal+workspace within 30s is blocked', async () => {
    // WHY: proves that rapid-fire webhook retries for the same trigger do not
    // spawn duplicate pipeline sessions within the TTL window.
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const trigger = makeTrigger();
    const { fn, calls } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    // First route() call -- should proceed
    router.route(makeEvent());

    // Advance time by 10s (within 30s window)
    vi.advanceTimersByTime(10_000);

    // Second route() call -- same goal+workspace, within TTL, should be blocked
    const secondResult = router.route(makeEvent());

    // Flush the async queue
    await Promise.resolve();

    // Only the first dispatch should have reached runWorkflowFn
    expect(calls.length).toBeLessThanOrEqual(1);

    // route() still returns 'enqueued' (silent skip -- 202 was already sent)
    expect(secondResult._tag).toBe('enqueued');

    // Skip log was emitted for the blocked dispatch
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate route dispatch'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('already dispatched within 30s'),
    );

    logSpy.mockRestore();
  });

  it('dispatch(): second dispatch for the same goal+workspace within 30s is blocked', async () => {
    // WHY: proves the console AUTO dispatch path also deduplicates within the TTL window.
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const trigger = makeTrigger();
    const { fn, calls } = makeFakeRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const workflowTrigger = {
      workflowId: trigger.workflowId,
      goal: trigger.goal,
      workspacePath: trigger.workspacePath,
      context: {},
    };

    // First dispatch -- should proceed
    router.dispatch(workflowTrigger);

    // Advance time by 10s (within 30s window)
    vi.advanceTimersByTime(10_000);

    // Second dispatch -- same goal+workspace, within TTL, should be blocked
    router.dispatch(workflowTrigger);

    // Flush
    await Promise.resolve();

    // Only the first dispatch should have reached runWorkflowFn
    expect(calls.length).toBeLessThanOrEqual(1);

    // Skip log was emitted
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate dispatch'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('already dispatched within 30s'),
    );

    logSpy.mockRestore();
  });

  it('different goals on the same workspace within 30s are both dispatched', async () => {
    // WHY: proves the deduplication key is goal+workspace (not workspace-only).
    // Different tasks arriving for the same repo within 30s must all dispatch.
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const trigger1 = makeTrigger({ id: asTriggerId('trigger-a'), goal: 'review PR #42' });
    const trigger2 = makeTrigger({ id: asTriggerId('trigger-b'), goal: 'review PR #43' });
    const { fn: fn1, calls: calls1 } = makeFakeRunWorkflow();
    const { fn: fn2, calls: calls2 } = makeFakeRunWorkflow();
    const router1 = new TriggerRouter(makeIndex(trigger1), FAKE_CTX, FAKE_API_KEY, fn1);
    const router2 = new TriggerRouter(makeIndex(trigger2), FAKE_CTX, FAKE_API_KEY, fn2);

    const event1 = makeEvent({ triggerId: asTriggerId('trigger-a') });
    const event2 = makeEvent({ triggerId: asTriggerId('trigger-b') });

    router1.route(event1);
    vi.advanceTimersByTime(5_000);
    router2.route(event2);

    // Flush: advance fake timers to allow setTimeout(r, 20) inside the queue to resolve
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();

    // Both dispatches should have reached runWorkflowFn (different goals = different keys)
    expect(calls1).toHaveLength(1);
    expect(calls2).toHaveLength(1);

    // No skip log emitted for either dispatch
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate'),
    );

    logSpy.mockRestore();
  });

  it('same goal+workspace but different workflowIds are NOT deduplicated', async () => {
    // WHY: proves that the dedup key includes workflowId. Two triggers with the same
    // goal and workspacePath but different workflowIds must both dispatch -- they are
    // genuinely distinct work. Without workflowId in the key, the second dispatch is
    // silently suppressed even though it targets a different workflow.
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const trigger1 = makeTrigger({ id: asTriggerId('trigger-a'), workflowId: 'wr.coding-task' });
    const trigger2 = makeTrigger({ id: asTriggerId('trigger-b'), workflowId: 'wr.bug-investigation' });
    const { fn, calls } = makeFakeRunWorkflow();
    // Use a single router with both triggers so they share the same _recentAdaptiveDispatches map
    const index = new Map([
      [trigger1.id, trigger1],
      [trigger2.id, trigger2],
    ]) as ReadonlyMap<string, TriggerDefinition>;
    const router = new TriggerRouter(index, FAKE_CTX, FAKE_API_KEY, fn);

    const event1 = makeEvent({ triggerId: asTriggerId('trigger-a') });
    const event2 = makeEvent({ triggerId: asTriggerId('trigger-b') });

    // First dispatch for workflowId 'wr.coding-task'
    router.route(event1);

    // Within the 30s window, dispatch for a DIFFERENT workflowId with the same goal+workspace
    vi.advanceTimersByTime(5_000);
    router.route(event2);

    // Flush: allow async queue callbacks to run
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();

    // Both dispatches must reach runWorkflowFn -- different workflowId = different dedup key
    expect(calls).toHaveLength(2);

    // No skip log emitted for either dispatch
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate'),
    );

    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// TriggerRouter.dispatchAdaptivePipeline: deduplication within 30s window
//
// Verifies that rapid-fire calls for the same goal+workspace are deduplicated
// within a 30-second TTL window, preventing duplicate adaptive pipeline sessions
// from webhook retries or daemon restarts.
// ---------------------------------------------------------------------------

describe('TriggerRouter.dispatchAdaptivePipeline deduplication', () => {
  /**
   * Build a minimal fake AdaptiveCoordinatorDeps that satisfies the type.
   *
   * runAdaptivePipeline calls deps.now() and deps.nowIso() BEFORE dispatching
   * to executors (for timing and log-file naming). Both must be provided.
   * deps.writeFile and deps.mkdir are needed for the pipeline-run log write
   * that also happens before executor dispatch. deps.stderr is called for
   * routing progress messages.
   *
   * All other fields are cast to satisfy TypeScript -- they are never reached
   * because the fake ModeExecutors short-circuit before any other dep call.
   */
  const FAKE_DEPS = {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    writeFile: async () => {},
    mkdir: async () => undefined,
    stderr: () => {},
    port: 0,
  } as unknown as AdaptiveCoordinatorDeps;

  /**
   * Build a ModeExecutors fake whose execute function records each call and
   * resolves immediately. Returns the call-count accessor alongside the fake.
   *
   * WHY fake ModeExecutors instead of mocking runAdaptivePipeline directly:
   * dispatchAdaptivePipeline calls runAdaptivePipeline(deps, opts, executors).
   * We inject coordinatorDeps + modeExecutors through the constructor, so the
   * injected executors are what actually gets invoked.
   */
  function makeFakeModeExecutors(): { executors: ModeExecutors; callCount: () => number } {
    let count = 0;
    const outcome: PipelineOutcome = { kind: 'merged', prUrl: null };
    const executor = async () => {
      count++;
      return outcome;
    };
    const executors: ModeExecutors = {
      runQuickReview: executor,
      runReviewOnly: executor,
      runImplement: executor,
      runFull: executor,
    };
    return { executors, callCount: () => count };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks the second dispatch for the same goal+workspace within 30s', async () => {
    // WHY: proves that rapid-fire webhook retries for the same goal+workspace
    // do not spawn duplicate adaptive pipeline sessions within the TTL window.
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { executors, callCount } = makeFakeModeExecutors();
    const trigger = makeTrigger();
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(
      makeIndex(trigger),
      FAKE_CTX,
      FAKE_API_KEY,
      fn,
      undefined, // execFn
      undefined, // maxConcurrentSessions
      undefined, // emitter
      undefined, // notificationService
      undefined, // activeSessionSet
      FAKE_DEPS,
      executors,
    );

    const goal = 'review PR #42';
    const workspace = '/workspace';

    // First dispatch: should proceed
    await router.dispatchAdaptivePipeline(goal, workspace);

    // Advance time by 10 seconds (within 30s window)
    vi.advanceTimersByTime(10_000);

    // Second dispatch: same goal+workspace, within TTL -- should be blocked
    const secondResult = await router.dispatchAdaptivePipeline(goal, workspace);

    // Pipeline called only once (second dispatch was blocked)
    expect(callCount()).toBe(1);

    // Skip log message emitted for the blocked dispatch
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate adaptive dispatch'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('already dispatched within 30s'),
    );

    // Blocked dispatch returns escalated outcome
    expect(secondResult.kind).toBe('escalated');

    logSpy.mockRestore();
  });

  it('allows the second dispatch for the same goal+workspace after 30s', async () => {
    // WHY: proves that after the TTL expires, the same goal+workspace can dispatch again.
    // This covers the legitimate refire case (e.g. a corrective retry after failure).
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { executors, callCount } = makeFakeModeExecutors();
    const trigger = makeTrigger();
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(
      makeIndex(trigger),
      FAKE_CTX,
      FAKE_API_KEY,
      fn,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // activeSessionSet
      FAKE_DEPS,
      executors,
    );

    const goal = 'review PR #42';
    const workspace = '/workspace';

    // First dispatch at t=0
    await router.dispatchAdaptivePipeline(goal, workspace);

    // Advance time by 31 seconds (TTL has expired)
    vi.advanceTimersByTime(31_000);

    // Second dispatch: same goal+workspace, after TTL -- should proceed
    const secondResult = await router.dispatchAdaptivePipeline(goal, workspace);

    // Both dispatches proceeded
    expect(callCount()).toBe(2);

    // Skip log NOT emitted for the second dispatch
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate adaptive dispatch'),
    );

    // Second dispatch returned a real pipeline outcome (not escalated-for-skip)
    expect(secondResult.kind).toBe('merged');

    logSpy.mockRestore();
  });

  it('does not block dispatches for different goals on the same workspace within 30s', async () => {
    // WHY: proves the deduplication key is goal+workspace (not workspace-only).
    // Different tasks arriving for the same repo within 30s must all dispatch.
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { executors, callCount } = makeFakeModeExecutors();
    const trigger = makeTrigger();
    const { fn } = makeFakeRunWorkflow();
    const router = new TriggerRouter(
      makeIndex(trigger),
      FAKE_CTX,
      FAKE_API_KEY,
      fn,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // activeSessionSet
      FAKE_DEPS,
      executors,
    );

    const workspace = '/workspace';

    // Two different goals on the same workspace within 5 seconds
    await router.dispatchAdaptivePipeline('review PR #42', workspace);
    vi.advanceTimersByTime(5_000);
    await router.dispatchAdaptivePipeline('review PR #43', workspace);

    // Both dispatches proceeded (different goals = different deduplication keys)
    expect(callCount()).toBe(2);

    // Skip log NOT emitted for either dispatch
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate adaptive dispatch'),
    );

    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// TriggerRouter.dispatch: pre_allocated SessionSource dedup bypass
//
// Verifies that dispatch() with a pre_allocated SessionSource bypasses the
// 30s dedup window and calls runWorkflowFn, even when the same goal+workspace
// was recently dispatched via dispatchAdaptivePipeline().
//
// This is the regression guard for the zombie-session bug:
// dispatchAdaptivePipeline() primes _recentAdaptiveDispatches with the same
// goal::workspace key. Without the bypass, dispatch() returns early and the
// pre-allocated session zombies in the store forever.
//
// A9 migration: source is now passed as second arg to dispatch() rather than
// as WorkflowTrigger._preAllocatedStartResponse (field removed).
// ---------------------------------------------------------------------------

describe('TriggerRouter.dispatch pre_allocated SessionSource bypass', () => {
  /**
   * Minimal fake AdaptiveCoordinatorDeps for priming the dedup map via
   * dispatchAdaptivePipeline(). Only the fields called before executor dispatch
   * need to be present. All others are cast.
   */
  const FAKE_DEPS_FOR_BYPASS = {
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    writeFile: async () => {},
    mkdir: async () => undefined,
    stderr: () => {},
    port: 0,
    // fileExists: required by routeTask() for pitch.md detection (Rule 3).
    // Returns false so routeTask() falls through to FULL mode.
    fileExists: () => false,
  } as unknown as AdaptiveCoordinatorDeps;

  function makeFakeModeExecutorsForBypass(): ModeExecutors {
    const outcome: PipelineOutcome = { kind: 'merged', prUrl: null };
    const executor = async () => outcome;
    return {
      runQuickReview: executor,
      runReviewOnly: executor,
      runImplement: executor,
      runFull: executor,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatch() with pre_allocated SessionSource bypasses dedup and calls runWorkflowFn', async () => {
    // WHY: proves the fix for the zombie-session bug. The dedup map contains goal::workspace
    // from a prior dispatch. dispatch() with a pre_allocated SessionSource must bypass the dedup
    // check and call runWorkflowFn. Without the fix, runWorkflowFn is never called (dedup fires)
    // and the pre-allocated session zombies in the store.
    //
    // Scenario:
    // 1. First dispatch() (no source) -- primes _recentAdaptiveDispatches['goal::workspace']
    // 2. Second dispatch() (with pre_allocated source) -- must bypass dedup and call runWorkflowFn
    //
    // NOTE: We prime the dedup map via dispatch() rather than dispatchAdaptivePipeline()
    // to avoid async complexity with fake timers. The bug fires whenever the map has the key,
    // regardless of how it was set. Real timers are used so the queue drains normally.
    const { fn, calls } = makeFakeRunWorkflow();
    const trigger = makeTrigger();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const goal = trigger.goal;
    const workspace = trigger.workspacePath;

    // Step 1: First dispatch (no source) -- primes the dedup map AND calls runWorkflowFn (1st call)
    router.dispatch({ workflowId: trigger.workflowId, goal, workspacePath: workspace, context: {} });

    // Step 2: Second dispatch WITH pre_allocated SessionSource -- must bypass dedup (2nd call)
    const preAllocTrigger = { workflowId: trigger.workflowId, goal, workspacePath: workspace, context: {} };
    const allocatedSession: AllocatedSession = {
      continueToken: 'ct_test',
      checkpointToken: undefined,
      firstStepPrompt: '',
      isComplete: false,
      triggerSource: 'daemon',
    };
    const source: SessionSource = { kind: 'pre_allocated', trigger: preAllocTrigger, session: allocatedSession };
    router.dispatch(preAllocTrigger, source);

    // Wait for the async queue to drain
    await new Promise<void>((r) => setTimeout(r, 20));

    // Both dispatches must have reached runWorkflowFn:
    // - dispatch 1 (no source, first in window): primed map, called runWorkflowFn
    // - dispatch 2 (with pre_allocated source): bypassed dedup map, called runWorkflowFn
    // Total: exactly 2 calls
    expect(calls).toHaveLength(2);
    expect(calls[0]?.goal).toBe(goal);
    expect(calls[1]?.goal).toBe(goal);
  });

  it('dispatch() without a pre_allocated source is NOT suppressed by a prior dispatchAdaptivePipeline', async () => {
    // WHY: since the dedup key for dispatch() now includes workflowId
    // (`${workflowId}::${goal}::${workspace}`) while dispatchAdaptivePipeline() uses
    // `${goal}::${workspace}`, the two paths no longer share dedup keys.
    // A dispatch() call must NOT be suppressed by a prior adaptive pipeline dispatch
    // for the same goal+workspace -- they are different kinds of operations.
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { fn, calls } = makeFakeRunWorkflow();
    const trigger = makeTrigger();
    const executors = makeFakeModeExecutorsForBypass();

    const router = new TriggerRouter(
      makeIndex(trigger),
      FAKE_CTX,
      FAKE_API_KEY,
      fn,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // activeSessionSet
      FAKE_DEPS_FOR_BYPASS,
      executors,
    );

    const goal = trigger.goal;
    const workspace = trigger.workspacePath;

    // Prime the dedup map via adaptive pipeline (sets key: `${goal}::${workspace}`)
    await router.dispatchAdaptivePipeline(goal, workspace);

    // Advance by 10s (within 30s TTL)
    vi.advanceTimersByTime(10_000);

    // dispatch() without pre_allocated source -- must NOT be suppressed because
    // dispatch() uses `${workflowId}::${goal}::${workspace}` as its dedup key
    router.dispatch({
      workflowId: trigger.workflowId,
      goal,
      workspacePath: workspace,
      context: {},
    });

    // Flush: advance fake timers to allow the internal queue's setTimeout to resolve
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();

    // runWorkflowFn MUST have been called (different dedup key namespace)
    expect(calls).toHaveLength(1);

    // No skip log emitted for the dispatch
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate dispatch'),
    );

    logSpy.mockRestore();
  });

  it('dispatch() without pre_allocated source deduplicates a repeat dispatch() within 30s', async () => {
    // WHY: proves the dedup check still fires for normal dispatch() calls (without
    // a pre_allocated source) when a prior dispatch() has the same workflowId+goal+workspace.
    // This ensures the bypass only applies to pre-allocated sessions, not all dispatch()s.
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { fn, calls } = makeFakeRunWorkflow();
    const trigger = makeTrigger();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    const goal = trigger.goal;
    const workspace = trigger.workspacePath;

    // First dispatch (no preAlloc) -- primes the dedup map
    router.dispatch({ workflowId: trigger.workflowId, goal, workspacePath: workspace, context: {} });

    // Advance by 10s (within 30s TTL)
    vi.advanceTimersByTime(10_000);

    // Second dispatch() without pre_allocated source -- dedup must fire
    router.dispatch({
      workflowId: trigger.workflowId,
      goal,
      workspacePath: workspace,
      context: {},
    });

    // Flush: advance fake timers to allow the internal queue's setTimeout to resolve
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await Promise.resolve();

    // At most one dispatch should have reached runWorkflowFn (dedup blocked the second)
    expect(calls).toHaveLength(1);

    // Skip log must have been emitted
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipping duplicate dispatch'),
    );

    logSpy.mockRestore();
  });
});

