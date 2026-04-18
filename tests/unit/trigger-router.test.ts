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
import { createTriggerApp, startTriggerListener } from '../../src/trigger/trigger-listener.js';
import type { RunWorkflowFn } from '../../src/trigger/trigger-router.js';
import type { ExecFn } from '../../src/trigger/delivery-action.js';
import type { TriggerDefinition, WebhookEvent } from '../../src/trigger/types.js';
import { asTriggerId } from '../../src/trigger/types.js';
import type { V2ToolContext } from '../../src/mcp/types.js';
import type { NotificationService } from '../../src/trigger/notification-service.js';
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
    workflowId: 'coding-task-workflow-agentic',
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
        workflowId: 'mr-review-workflow-agentic',
        goal: 'Review this MR carefully',
        workspacePath: '/my/workspace',
      });
      const { fn, calls } = makeFakeRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      router.route(makeEvent());
      await new Promise((r) => setTimeout(r, 10));

      expect(calls[0]?.workflowId).toBe('mr-review-workflow-agentic');
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

    it('serial trigger: second call does not start until first completes (same queue key)', async () => {
      // Proves the serial ternary: queueKey = trigger.id (not trigger.id:UUID).
      // If the ternary were inverted to 'parallel', BOTH calls would be in-flight
      // after the first flush and this test would fail.
      const trigger = makeTrigger({ concurrencyMode: 'serial' });
      const { fn, inFlight, releaseAll } = makeLatchedRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      // Fire two events without awaiting -- the queue processes them serially.
      router.route(makeEvent());
      router.route(makeEvent());

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
      const trigger = makeTrigger({ concurrencyMode: 'parallel' });
      const { fn, inFlight, releaseAll } = makeLatchedRunWorkflow();
      const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

      // Fire two events without awaiting -- each gets its own queue key, so both
      // start concurrently without waiting for the other.
      router.route(makeEvent());
      router.route(makeEvent());

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
    const wsDir = await writeTriggers(makeTriggerYaml('good-trigger', 'coding-task-workflow-agentic'));
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

    expect(getWorkflowByIdFn).toHaveBeenCalledWith('coding-task-workflow-agentic');

    const triggers = result.router.listTriggers();
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.workflowId).toBe('coding-task-workflow-agentic');

    await result.stop();
  });

  it('skips bad triggers and keeps good ones in a mixed config', async () => {
    const yaml = [
      'triggers:',
      '  - id: good-trigger',
      '    provider: generic',
      '    workflowId: coding-task-workflow-agentic',
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
      id === 'coding-task-workflow-agentic',
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

  it('limits concurrent runWorkflow() calls to maxConcurrentSessions', async () => {
    // Proves the semaphore caps at the configured limit.
    // With cap=2 and 3 fires: first two should start, third should be queued.
    const trigger = makeTrigger({ concurrencyMode: 'parallel' });
    const { fn, inFlight, releaseAll } = makeLatchedRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn, undefined, 2);

    router.route(makeEvent());
    router.route(makeEvent());
    router.route(makeEvent());

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
    const trigger = makeTrigger({ concurrencyMode: 'parallel' });
    const { fn, inFlight, releaseNext, releaseAll } = makeLatchedRunWorkflow();
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn, undefined, 2);

    router.route(makeEvent());
    router.route(makeEvent());
    router.route(makeEvent());

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
    const trigger = makeTrigger({ concurrencyMode: 'parallel' });
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

    router.route(makeEvent());
    await new Promise<void>((r) => setImmediate(r));

    // First call is running -- second is queued (cap=1)
    router.route(makeEvent());
    expect(secondCallResolved).toBe(false);

    // Unblock the first call (returns error) -- finally MUST release the slot
    firstCallUnblock();
    await new Promise<void>((r) => setTimeout(r, 20));

    // Second call must have run (slot was released by finally even though first returned error)
    expect(secondCallResolved).toBe(true);
  });

  it('defaults to 3 concurrent sessions when maxConcurrentSessions is not specified', async () => {
    // Proves the default is 3, not unlimited.
    const trigger = makeTrigger({ concurrencyMode: 'parallel' });
    const { fn, inFlight, releaseAll } = makeLatchedRunWorkflow();
    // No maxConcurrentSessions argument -- should default to 3
    const router = new TriggerRouter(makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn);

    expect(router.maxConcurrentSessions).toBe(3);

    // Fire 4 dispatches -- only 3 should be in-flight simultaneously
    router.route(makeEvent());
    router.route(makeEvent());
    router.route(makeEvent());
    router.route(makeEvent());

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
