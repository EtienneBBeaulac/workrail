/**
 * WorkRail Auto: Trigger Listener
 *
 * Express HTTP server on port 3200 (or WORKRAIL_TRIGGER_PORT) that receives
 * webhook events and dispatches them to TriggerRouter.
 *
 * Routes:
 *   POST /webhook/:triggerId  -- Accepts incoming webhook, returns 202 immediately
 *   GET  /health              -- Health check, returns 200 { status: "ok" }
 *
 * Design notes:
 * - Feature flag WORKRAIL_TRIGGERS_ENABLED=true must be set for the listener to start.
 * - triggers.yml is loaded from workspacePath at startup. If missing, the listener
 *   starts with 0 triggers and logs a warning (first-run scenario).
 * - Raw body is captured before JSON parsing so HMAC validation has access to the
 *   original bytes. express.raw() captures the buffer; JSON.parse() produces the object.
 * - Port conflicts (EADDRINUSE) are caught and returned as an Err result.
 */

import 'reflect-metadata';
import express from 'express';
import * as http from 'node:http';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';
import type { V2ToolContext } from '../mcp/types.js';
import { loadTriggerConfigFromFile, buildTriggerIndex } from './trigger-store.js';
import type { TriggerStoreError } from './trigger-store.js';
import { TriggerRouter, type RunWorkflowFn } from './trigger-router.js';
import { runWorkflow } from '../daemon/workflow-runner.js';
import type { WebhookEvent } from './types.js';
import { asTriggerId } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TRIGGER_PORT = 3200;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TriggerListenerError =
  | TriggerStoreError
  | { readonly kind: 'port_conflict'; readonly port: number }
  | { readonly kind: 'feature_disabled' }
  | { readonly kind: 'missing_api_key' };

export interface TriggerListenerHandle {
  readonly port: number;
  stop(): Promise<void>;
}

export interface StartTriggerListenerOptions {
  /** Absolute path to the workspace that contains triggers.yml */
  readonly workspacePath: string;
  /** Anthropic API key for runWorkflow(). Required when feature is enabled. */
  readonly apiKey?: string;
  /** Override the default port (3200 or WORKRAIL_TRIGGER_PORT). */
  readonly port?: number;
  /** Override process.env for testing. */
  readonly env?: Record<string, string | undefined>;
  /** Override runWorkflow() for testing. */
  readonly runWorkflowFn?: RunWorkflowFn;
}

// ---------------------------------------------------------------------------
// Express app factory (pure: no I/O, fully testable)
// ---------------------------------------------------------------------------

/**
 * Create the Express application with all routes registered.
 * No I/O is performed -- the router is fully injected.
 */
export function createTriggerApp(router: TriggerRouter): express.Application {
  const app = express();

  // Capture raw body BEFORE JSON parsing so HMAC validation has the original bytes.
  // express.raw() stores the buffer in req.body.
  app.use(
    '/webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
  );

  // Health check
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Webhook endpoint
  app.post('/webhook/:triggerId', (req, res) => {
    const triggerId = asTriggerId(req.params['triggerId'] ?? '');

    if (!triggerId) {
      res.status(400).json({ error: 'Missing triggerId' });
      return;
    }

    // Parse raw body
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    let payload: Record<string, unknown>;
    try {
      const bodyStr = rawBody.toString('utf8');
      if (bodyStr) {
        payload = JSON.parse(bodyStr) as Record<string, unknown>;
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          res.status(400).json({ error: 'Payload must be a JSON object' });
          return;
        }
      } else {
        payload = {};
      }
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }

    const signature = req.headers['x-workrail-signature'] as string | undefined;

    const event: WebhookEvent = {
      triggerId,
      rawBody,
      payload,
      ...(signature !== undefined ? { signature } : {}),
    };

    const result = router.route(event);

    if (result._tag === 'error') {
      switch (result.error.kind) {
        case 'not_found':
          res.status(404).json({ error: `Unknown trigger: ${result.error.triggerId}` });
          return;
        case 'hmac_invalid':
          res.status(401).json({ error: 'Invalid signature' });
          return;
        case 'payload_error':
          res.status(400).json({ error: result.error.message });
          return;
      }
    }

    // 202 Accepted: enqueued for background processing
    res.status(202).json({ status: 'accepted', triggerId });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Listener startup
// ---------------------------------------------------------------------------

/**
 * Start the trigger webhook listener.
 *
 * Returns:
 * - null if WORKRAIL_TRIGGERS_ENABLED is not "true" (feature disabled, not an error)
 * - ok(TriggerListenerHandle) on successful startup
 * - err(TriggerListenerError) on startup failure (port conflict, parse error, etc.)
 */
export async function startTriggerListener(
  ctx: V2ToolContext,
  options: StartTriggerListenerOptions,
): Promise<TriggerListenerHandle | null | { readonly _kind: 'err'; readonly error: TriggerListenerError }> {
  const env = options.env ?? process.env;

  // Feature flag check: must be first
  if (env['WORKRAIL_TRIGGERS_ENABLED'] !== 'true') {
    return null;
  }

  // Resolve API key
  const apiKey = options.apiKey ?? env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return { _kind: 'err', error: { kind: 'missing_api_key' } };
  }

  // Load triggers.yml
  const configResult = await loadTriggerConfigFromFile(options.workspacePath, env);

  let triggerIndex: Map<string, import('./types.js').TriggerDefinition>;

  if (configResult.kind === 'err') {
    if (configResult.error.kind === 'file_not_found') {
      // First-run scenario: no triggers.yml is fine, start with empty config
      console.warn(
        `[TriggerListener] triggers.yml not found at ${options.workspacePath}. ` +
        `Listener will start with 0 triggers. ` +
        `Create triggers.yml in that directory to configure triggers.`,
      );
      triggerIndex = new Map();
    } else {
      return { _kind: 'err', error: configResult.error };
    }
  } else {
    triggerIndex = buildTriggerIndex(configResult.value);
    console.log(
      `[TriggerListener] Loaded ${configResult.value.triggers.length} trigger(s) from triggers.yml`,
    );
  }

  // Create router and Express app
  const runWorkflowFn: RunWorkflowFn = options.runWorkflowFn ?? runWorkflow;
  const router = new TriggerRouter(triggerIndex, ctx, apiKey, runWorkflowFn);
  const app = createTriggerApp(router);

  // Determine port
  const portEnv = env['WORKRAIL_TRIGGER_PORT'];
  const port = options.port ?? (portEnv ? parseInt(portEnv, 10) : DEFAULT_TRIGGER_PORT);

  // Start the HTTP server
  return new Promise((resolve) => {
    const server = http.createServer(app);

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve({ _kind: 'err', error: { kind: 'port_conflict', port } });
      } else {
        resolve({ _kind: 'err', error: { kind: 'io_error', message: error.message } });
      }
    });

    server.listen(port, () => {
      // Use the actual assigned port (important when port=0 lets the OS pick)
      const addr = server.address();
      const actualPort = (addr && typeof addr === 'object') ? addr.port : port;
      console.log(`[TriggerListener] Webhook server listening on port ${actualPort}`);
      resolve({
        port: actualPort,
        stop: () =>
          new Promise<void>((res, rej) => {
            server.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
  });
}
