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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { V2ToolContext } from '../mcp/types.js';
import { loadTriggerConfigFromFile, buildTriggerIndex } from './trigger-store.js';
import type { TriggerStoreError } from './trigger-store.js';
import { TriggerRouter, type RunWorkflowFn } from './trigger-router.js';
import { ActiveSessionSet } from '../daemon/active-sessions.js';
import { loadWorkrailConfigFile, loadWorkspacesFromConfigFile } from '../config/config-file.js';
import { NotificationService } from './notification-service.js';
import { runWorkflow, runStartupRecovery } from '../daemon/workflow-runner.js';
import type { WebhookEvent, WorkspaceConfig } from './types.js';
import { asTriggerId } from './types.js';
import type { DaemonEventEmitter } from '../daemon/daemon-events.js';
import { PollingScheduler } from './polling-scheduler.js';
import { PolledEventStore } from './polled-event-store.js';
import type { FetchFn } from './adapters/gitlab-poller.js';
import type { ModeExecutors } from '../coordinators/adaptive-pipeline.js';
import { runQuickReviewPipeline } from '../coordinators/modes/quick-review.js';
import { runReviewOnlyPipeline } from '../coordinators/modes/review-only.js';
import { runImplementPipeline } from '../coordinators/modes/implement.js';
import { runFullPipeline } from '../coordinators/modes/full-pipeline.js';
import { createCoordinatorDeps } from './coordinator-deps.js';

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
  /**
   * The TriggerRouter instance created by this listener.
   * Exposed so callers (e.g. console API routes) can access dispatch() and
   * listTriggers() without re-creating the router or duplicating dependencies.
   */
  readonly router: TriggerRouter;
  /**
   * The active session set shared with TriggerRouter.
   * Used during daemon shutdown to emit session_aborted events and abort all in-flight sessions.
   */
  readonly activeSessionSet: ActiveSessionSet;
  /**
   * The PollingScheduler instance created by this listener.
   * Used to manage the polling loop lifecycle (start/stop).
   */
  readonly scheduler: PollingScheduler;
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
  /**
   * Optional workspace map for workspace namespacing (Phase 1).
   * When provided, trigger workspaceName fields are resolved against this map.
   * When absent, loadWorkspacesFromConfigFile() is called to load from config.json.
   * Pass {} to explicitly disable workspace namespacing (e.g. in tests).
   */
  readonly workspaces?: Readonly<Record<string, WorkspaceConfig>>;
  /**
   * Optional event emitter for structured daemon lifecycle events.
   * When provided, emits daemon_started after the server starts listening.
   * When absent, no events are emitted (zero overhead).
   */
  readonly emitter?: DaemonEventEmitter;
  /**
   * Override the fetch function for polling adapters (for testing).
   * When absent, globalThis.fetch is used.
   */
  readonly fetchFn?: FetchFn;
  /**
   * Optional resolver to validate that trigger workflowIds exist before starting.
   *
   * WHY: a trigger with a typo'd workflowId (e.g. "my-workflow.v2" instead of "my-workflow")
   * would silently fail at every dispatch with workflow_not_found. Validating at startup
   * catches the misconfiguration immediately and removes the broken trigger from the index.
   *
   * Policy: warn+skip (consistent with loadTriggerConfig's treatment of invalid triggers).
   * Not hard-fail: a bad workflowId should not block other valid triggers from running.
   *
   * When absent, workflowId validation is skipped entirely (backward compat for test callers
   * that do not inject a resolver). In production, ctx.workflowService is used as the default.
   *
   * Note: only the primary trigger.workflowId is validated here. onComplete.workflowId
   * (secondary completion hook) is out of scope for this validation pass.
   */
  readonly getWorkflowByIdFn?: (id: string) => Promise<boolean>;
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
        case 'queue_full':
          // WHY Retry-After: the value comes from route() which has access to the trigger's
          // maxSessionMinutes. It is an approximation of the worst-case drain time for one slot.
          res.status(429)
            .set('Retry-After', String(result.error.retryAfterSeconds))
            .json({
              error: 'Trigger queue is full',
              queueDepth: result.error.queueDepth,
              maxQueueDepth: result.error.maxQueueDepth,
            });
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

  // Load workspace namespacing map (Phase 1).
  // If workspaces is explicitly provided (e.g. in tests), use it directly.
  // Otherwise load from ~/.workrail/config.json.
  // loadWorkspacesFromConfigFile() never errors (error type is `never`), so the kind
  // is always 'ok'. The discriminant check satisfies TypeScript's narrowing requirement.
  const workspaceResult = loadWorkspacesFromConfigFile();
  const loadedWorkspaces = workspaceResult.kind === 'ok' ? workspaceResult.value : {};
  const workspaces = options.workspaces ?? loadedWorkspaces;

  // Load triggers.yml
  const configResult = await loadTriggerConfigFromFile(options.workspacePath, env, workspaces);

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
    const indexResult = buildTriggerIndex(configResult.value);
    if (indexResult.kind === 'err') {
      return { _kind: 'err', error: indexResult.error };
    }
    triggerIndex = indexResult.value;
    console.log(
      `[TriggerListener] Loaded ${configResult.value.triggers.length} trigger(s) from triggers.yml`,
    );
  }

  // ---------------------------------------------------------------------------
  // Validate workflowId values against the live workflow store.
  //
  // WHY: a trigger with a typo'd workflowId (e.g. "my-workflow.v2" instead of
  // "my-workflow") silently fails at every webhook dispatch with workflow_not_found.
  // The error only surfaces in logs during an actual event -- never at startup.
  // Validating here catches the misconfiguration immediately so the operator
  // sees a clear warning before traffic starts.
  //
  // Policy: warn+skip, consistent with loadTriggerConfig's treatment of invalid
  // triggers. One broken trigger should not block all valid triggers from running.
  //
  // When getWorkflowByIdFn is not provided (e.g. existing tests that do not inject
  // a resolver), validation is skipped entirely for backward compatibility.
  // In production, ctx.workflowService provides the default resolver.
  // ---------------------------------------------------------------------------
  const getWorkflowByIdFn = options.getWorkflowByIdFn
    ?? (ctx.workflowService
      ? async (id: string): Promise<boolean> => (await ctx.workflowService.getWorkflowById(id)) !== null
      : undefined);

  if (getWorkflowByIdFn) {
    // First pass: collect trigger IDs with unknown workflowIds.
    // WHY two passes: do not mutate the Map while iterating it.
    const unknownTriggerIds: string[] = [];
    for (const [triggerId, trigger] of triggerIndex) {
      // github_queue_poll triggers have no workflowId -- the adaptive coordinator
      // decides the pipeline based on task content. Skip workflowId validation for
      // these triggers; the sentinel '' would always fail the resolver lookup.
      if (trigger.provider === 'github_queue_poll') {
        continue;
      }
      let found: boolean;
      try {
        found = await getWorkflowByIdFn(trigger.workflowId);
      } catch (e) {
        // Treat resolver errors as "not found" so the daemon can still start.
        // The operator can fix the workflow and restart.
        found = false;
        console.warn(
          `[TriggerListener] Error validating workflowId '${trigger.workflowId}' for trigger '${triggerId}': ` +
          (e instanceof Error ? e.message : String(e)),
        );
      }
      if (!found) {
        unknownTriggerIds.push(triggerId);
        console.warn(
          `[TriggerListener] Skipping trigger '${triggerId}': workflowId '${trigger.workflowId}' was not found. ` +
          `Fix the workflowId in triggers.yml and restart the daemon.`,
        );
      }
    }
    // Second pass: remove skipped triggers from the index.
    for (const id of unknownTriggerIds) {
      triggerIndex.delete(id);
    }
    if (unknownTriggerIds.length > 0) {
      console.warn(
        `[TriggerListener] Skipped ${unknownTriggerIds.length} trigger(s) with unknown workflowId(s). ` +
        `${triggerIndex.size} trigger(s) will be active.`,
      );
    }
  } else {
    console.log(
      `[TriggerListener] workflowId validation skipped (no resolver provided).`,
    );
  }

  // Read maxConcurrentSessions from ~/.workrail/config.json.
  // The config-file loader returns a flat Record<string, string>; the value is a
  // string (schema constraint) and must be parsed to an integer here.
  // A missing or non-numeric value falls back to TriggerRouter's default (3).
  const workrailConfig = loadWorkrailConfigFile();
  const maxConcurrencyRaw = workrailConfig.kind === 'ok'
    ? workrailConfig.value['maxConcurrentSessions']
    : undefined;
  const parsed = parseInt(maxConcurrencyRaw ?? '', 10);
  const maxConcurrentSessions = !isNaN(parsed) ? parsed : undefined;

  // Construct NotificationService if either notification channel is configured.
  // WHY constructed here (not in TriggerRouter): trigger-listener.ts owns config loading.
  // TriggerRouter receives the service as an optional injection -- it does not know about
  // config.json keys. This keeps TriggerRouter free of config knowledge.
  const notifyMacOs = (workrailConfig.kind === 'ok' && workrailConfig.value['WORKTRAIN_NOTIFY_MACOS'] === 'true');
  const notifyWebhook = workrailConfig.kind === 'ok' ? workrailConfig.value['WORKTRAIN_NOTIFY_WEBHOOK'] : undefined;
  const notificationService = (notifyMacOs || (notifyWebhook !== undefined && notifyWebhook !== ''))
    ? new NotificationService({ macOs: notifyMacOs, webhookUrl: notifyWebhook })
    : undefined;

  // Create the steer registry for coordinator injection via POST /sessions/:id/steer.
  // WHY created here (not in TriggerRouter): trigger-listener.ts is the composition root.
  // Both TriggerRouter and the console route layer (steer HTTP endpoint) need the SAME instance.
  const activeSessionSet = new ActiveSessionSet();

  // ---------------------------------------------------------------------------
  // Adaptive coordinator deps: wire real implementations for dispatchAdaptivePipeline.
  //
  // WHY here (not in TriggerRouter): trigger-listener.ts is the composition root.
  // TriggerRouter receives deps as optional injection -- it does not know about
  // fs/exec/HTTP implementations. This pattern mirrors the pr-review command in
  // cli-worktrain.ts (lines 958-1244), which uses the same deps interface.
  //
  // WHY createCoordinatorDeps + setDispatch (not inline): the method implementations
  // are extracted into coordinator-deps.ts to reduce this function's line count.
  // The circular construction order (coordinatorDeps before TriggerRouter, but spawnSession
  // needs router.dispatch) is resolved via setDispatch() -- called once, immediately after
  // router construction. See coordinator-deps.ts for the WHY comment.
  // ---------------------------------------------------------------------------
  const execFileAsync = promisify(execFile);

  // WHY in-process ConsoleService (not HTTP): awaitSessions and getAgentResult previously
  // made HTTP calls to http://127.0.0.1:3456 (the daemon's own console API) from inside
  // the daemon process. This caused silent all-failed returns on ECONNREFUSED and a
  // race condition where sessions created in-process by spawnSession() were not yet
  // visible via HTTP when the first poll fired. ConsoleService provides the same data
  // via direct store access, eliminating both failure modes.
  //
  // A second ConsoleService instance has no correctness issue -- the summary cache
  // is instance-scoped and mtime-invalidated. The instance is cheap to construct.
  //
  // WHY lazy import: avoids circular dependency at module load time.
  const { ConsoleService } = await import('../v2/usecases/console-service.js');
  let consoleService: InstanceType<typeof ConsoleService> | null = null;
  if (!ctx.v2?.dataDir || !ctx.v2?.directoryListing) {
    process.stderr.write(
      '[CRITICAL trigger-listener:reason=consoleService_unavailable] ctx.v2.dataDir or ctx.v2.directoryListing not available -- awaitSessions and getAgentResult will degrade to all-failed / empty results\n',
    );
  } else {
    consoleService = new ConsoleService({
      directoryListing: ctx.v2.directoryListing,
      dataDir: ctx.v2.dataDir,
      sessionStore: ctx.v2.sessionStore,
      snapshotStore: ctx.v2.snapshotStore,
      pinnedWorkflowStore: ctx.v2.pinnedStore,
    });
  }

  const coordinatorDeps = createCoordinatorDeps({ ctx, execFileAsync, consoleService });

  // Mode executors: map the pipeline function names to the ModeExecutors interface.
  // WHY these names: the ModeExecutors interface uses short names (runQuickReview, etc.)
  // while the mode module exports use the longer Pipeline suffix. This mapping follows
  // the same pattern as src/cli/commands/worktrain-pipeline.ts.
  const modeExecutors: ModeExecutors = {
    runQuickReview: runQuickReviewPipeline,
    runReviewOnly: runReviewOnlyPipeline,
    runImplement: runImplementPipeline,
    runFull: runFullPipeline,
  };

  // Create router and Express app
  const runWorkflowFn: RunWorkflowFn = options.runWorkflowFn ?? runWorkflow;
  const router = new TriggerRouter(triggerIndex, ctx, apiKey, runWorkflowFn, undefined, maxConcurrentSessions, options.emitter, notificationService, activeSessionSet, coordinatorDeps, modeExecutors);
  // Bind the router's dispatch function so spawnSession can dispatch in-process.
  // WHY after construction: coordinatorDeps must be created before TriggerRouter (it's
  // a constructor arg), so dispatch can only be bound after the router exists.
  // setDispatch() is called exactly once here; see coordinator-deps.ts for the WHY.
  coordinatorDeps.setDispatch(router.dispatch.bind(router));
  const app = createTriggerApp(router);

  // Create and start the polling scheduler.
  // The scheduler manages polling loops for all gitlab_poll triggers.
  // It filters the trigger index internally to only start loops for
  // triggers with pollingSource configured.
  //
  // Ordering: start scheduler BEFORE the HTTP server. This ensures all
  // polling triggers are active from the first moment the daemon is ready.
  // The scheduler uses the same TriggerRouter as the webhook server, so
  // dispatched events go through the same KeyedAsyncQueue.
  const allTriggers = [...triggerIndex.values()];
  const polledEventStore = new PolledEventStore(env);
  const pollingScheduler = new PollingScheduler(
    allTriggers,
    router,
    polledEventStore,
    options.fetchFn,
  );
  pollingScheduler.start();

  // Startup crash recovery: detect and clear any orphaned session files left by a
  // previous daemon crash. Run BEFORE server.listen() so no new webhooks can arrive
  // while recovery is in progress.
  // WHY: runStartupRecovery() is non-fatal -- any error is caught internally and the
  // daemon starts regardless. The additional catch here defends against unexpected
  // throws from the function's own error-handling path.
  // WHY pass ctx: enables resume-path logic (decode token, count step advances,
  // call executeContinueWorkflow with intent: 'rehydrate' for sessions with progress).
  await runStartupRecovery(undefined, undefined, ctx, undefined, undefined, undefined, apiKey).catch((err: unknown) => {
    console.warn(
      '[TriggerListener] Startup recovery encountered an unexpected error:',
      err instanceof Error ? err.message : String(err),
    );
  });

  // Determine port
  const portEnv = env['WORKRAIL_TRIGGER_PORT'];
  const port = options.port ?? (portEnv ? parseInt(portEnv, 10) : DEFAULT_TRIGGER_PORT);

  // Start the HTTP server
  return new Promise((resolve) => {
    const server = http.createServer(app);

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        // Stop the polling scheduler before returning the error
        pollingScheduler.stop();
        resolve({ _kind: 'err', error: { kind: 'port_conflict', port } });
      } else {
        pollingScheduler.stop();
        resolve({ _kind: 'err', error: { kind: 'io_error', message: error.message } });
      }
    });

    server.listen(port, '127.0.0.1', () => {
      // Use the actual assigned port (important when port=0 lets the OS pick)
      const addr = server.address();
      const actualPort = (addr && typeof addr === 'object') ? addr.port : port;
      console.log(`[TriggerListener] Webhook server listening on port ${actualPort}`);

      // Emit daemon_started event after the server is confirmed listening.
      options.emitter?.emit({
        kind: 'daemon_started',
        port: actualPort,
        workspacePath: options.workspacePath,
      });

      resolve({
        port: actualPort,
        router,
        activeSessionSet,
        scheduler: pollingScheduler,
        stop: async () => {
          // Stop polling BEFORE closing the HTTP server to prevent dispatch()
          // calls after the router's queue has been drained.
          pollingScheduler.stop();
          return new Promise<void>((res, rej) => {
            server.close((e) => (e ? rej(e) : res()));
          });
        },
      });
    });
  });
}
