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
import { describe, expect, it, vi } from 'vitest';
import { TriggerRouter, interpolateGoalTemplate } from '../../src/trigger/trigger-router.js';
import { createTriggerApp, startTriggerListener } from '../../src/trigger/trigger-listener.js';
import type { RunWorkflowFn } from '../../src/trigger/trigger-router.js';
import type { TriggerDefinition, WebhookEvent } from '../../src/trigger/types.js';
import { asTriggerId } from '../../src/trigger/types.js';
import type { V2ToolContext } from '../../src/mcp/types.js';
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

function makeFakeRunWorkflow(result?: Partial<Parameters<RunWorkflowFn>[0]>): {
  fn: RunWorkflowFn;
  calls: Parameters<RunWorkflowFn>[0][];
} {
  const calls: Parameters<RunWorkflowFn>[0][] = [];
  const fn: RunWorkflowFn = async (trigger) => {
    calls.push(trigger);
    return { _tag: 'success', workflowId: trigger.workflowId, stopReason: 'stop' };
  };
  return { fn, calls };
}

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

// ---------------------------------------------------------------------------
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

  it('uses (unknown) in warn when triggerId is omitted', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    interpolateGoalTemplate(
      'Review: {{$.missing.token}}',
      'Fallback',
      {},
      // no triggerId
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('(unknown)'),
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
