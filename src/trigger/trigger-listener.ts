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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';
import type { V2ToolContext } from '../mcp/types.js';
import { loadTriggerConfigFromFile, buildTriggerIndex } from './trigger-store.js';
import type { TriggerStoreError } from './trigger-store.js';
import { TriggerRouter, type RunWorkflowFn } from './trigger-router.js';
import type { SteerRegistry } from '../daemon/workflow-runner.js';
import { loadWorkrailConfigFile, loadWorkspacesFromConfigFile } from '../config/config-file.js';
import { NotificationService } from './notification-service.js';
import { runWorkflow, runStartupRecovery } from '../daemon/workflow-runner.js';
import type { WebhookEvent, WorkspaceConfig } from './types.js';
import { asTriggerId } from './types.js';
import type { DaemonEventEmitter } from '../daemon/daemon-events.js';
import { PollingScheduler } from './polling-scheduler.js';
import { PolledEventStore } from './polled-event-store.js';
import type { FetchFn } from './adapters/gitlab-poller.js';
import { createContextAssembler } from '../context-assembly/index.js';
import { createListRecentSessions } from '../context-assembly/infra.js';
import type { AdaptiveCoordinatorDeps, ModeExecutors } from '../coordinators/adaptive-pipeline.js';
import { runQuickReviewPipeline } from '../coordinators/modes/quick-review.js';
import { runReviewOnlyPipeline } from '../coordinators/modes/review-only.js';
import { runImplementPipeline } from '../coordinators/modes/implement.js';
import { runFullPipeline } from '../coordinators/modes/full-pipeline.js';
import { executeStartWorkflow } from '../mcp/handlers/v2-execution/start.js';
import { parseContinueTokenOrFail } from '../mcp/handlers/v2-token-ops.js';

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
   * The steer registry shared with TriggerRouter.
   * Pass to startDaemonConsole() so POST /sessions/:id/steer can dispatch steers
   * to sessions running inside TriggerRouter's dispatch queue.
   */
  readonly steerRegistry: SteerRegistry;
  /**
   * The PollingScheduler instance created by this listener.
   * Exposed so the daemon console can wire POST /api/v2/triggers/:id/poll
   * to forcePoll() without re-creating the scheduler.
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
  // WHY created here (not in TriggerRouter): trigger-listener.ts is the composition root
  // that wires TriggerRouter and DaemonConsole together. Both need the SAME registry instance
  // so the HTTP endpoint dispatches to callbacks registered by TriggerRouter's sessions.
  const steerRegistry: SteerRegistry = new Map();

  // ---------------------------------------------------------------------------
  // Adaptive coordinator deps: wire real implementations for dispatchAdaptivePipeline.
  //
  // WHY here (not in TriggerRouter): trigger-listener.ts is the composition root.
  // TriggerRouter receives deps as optional injection -- it does not know about
  // fs/exec/HTTP implementations. This pattern mirrors the pr-review command in
  // cli-worktrain.ts (lines 958-1244), which uses the same deps interface.
  //
  // WHY port=3456 (DAEMON_CONSOLE_PORT): still used by awaitSessions and getAgentResult
  // which poll the console HTTP API. This constant is kept for those paths.
  //
  // WHY let routerRef (forward reference): coordinatorDeps must be constructed before
  // TriggerRouter (it is a constructor argument). spawnSession needs the router to
  // call router.dispatch() in-process. The forward-ref is assigned exactly once,
  // immediately after new TriggerRouter(), and never mutated again.
  // ---------------------------------------------------------------------------
  const DAEMON_CONSOLE_PORT = 3456;
  const execFileAsync = promisify(execFile);

  // Forward reference for in-process dispatch. Assigned after router construction.
  // WHY let (not const): construction order requires coordinatorDeps before router.
  // Assigned exactly once; never mutated after assignment.
  let routerRef: TriggerRouter | undefined;

  const coordinatorDeps: AdaptiveCoordinatorDeps = {
    spawnSession: async (
      workflowId: string,
      goal: string,
      workspace: string,
      context?: Readonly<Record<string, unknown>>,
    ) => {
      // WHY in-process (not HTTP): the coordinator runs inside the daemon process.
      // POSTing to /api/v2/auto/dispatch would go out-of-process to itself, hitting
      // the HTTP handler's LLM credential check which can fail even when the daemon
      // is running correctly (the daemon already validated credentials at startup).
      // Calling executeStartWorkflow + router.dispatch() directly bypasses the
      // redundant credential check and eliminates the HTTP roundtrip.
      // This mirrors the pattern used in console-routes.ts:810-863 (the HTTP handler
      // uses this same flow: executeStartWorkflow -> _preAllocatedStartResponse -> dispatch).
      if (routerRef === undefined) {
        return { kind: 'err' as const, error: 'in-process router not initialized -- coordinator deps not ready' };
      }

      // Step 1: Allocate a session in the store synchronously.
      // WHY _preAllocatedStartResponse: runWorkflow() skips its own executeStartWorkflow()
      // call when this field is set, preventing double session creation.
      const startResult = await executeStartWorkflow(
        { workflowId, workspacePath: workspace, goal },
        ctx,
        { is_autonomous: 'true', workspacePath: workspace },
      );
      if (startResult.isErr()) {
        const detail = `${startResult.error.kind}${'message' in startResult.error ? ': ' + (startResult.error as { message: string }).message : ''}`;
        return { kind: 'err' as const, error: `Session creation failed: ${detail}` };
      }

      const startContinueToken = startResult.value.response.continueToken;
      if (!startContinueToken) {
        // Workflow completed immediately (single-step); no agent loop session needed.
        // Use workflowId as fallback handle (matches console-routes.ts:854-856 behavior).
        return { kind: 'ok' as const, value: workflowId };
      }

      // Step 2: Decode the session ID from the continueToken.
      // WHY parseContinueTokenOrFail: V2StartWorkflowOutputSchema does not expose sessionId
      // directly (to avoid a breaking schema change). Same approach as console-routes.ts:837-851.
      const tokenResult = await parseContinueTokenOrFail(
        startContinueToken,
        ctx.v2.tokenCodecPorts,
        ctx.v2.tokenAliasStore,
      );
      if (tokenResult.isErr()) {
        process.stderr.write(
          `[ERROR trigger-listener:spawnSession] Failed to decode session handle from new session: ${tokenResult.error.message}\n`,
        );
        return { kind: 'err' as const, error: 'Internal error: could not extract session handle from new session' };
      }
      const sessionHandle = tokenResult.value.sessionId;

      // Step 3: Enqueue the agent loop via TriggerRouter's queue and semaphore.
      // Pass _preAllocatedStartResponse so runWorkflow() skips executeStartWorkflow().
      routerRef.dispatch({
        workflowId,
        goal,
        workspacePath: workspace,
        context,
        _preAllocatedStartResponse: startResult.value.response,
      });

      return { kind: 'ok' as const, value: sessionHandle };
    },

    contextAssembler: createContextAssembler({
      execGit: async (args: readonly string[], cwd: string) => {
        try {
          const { stdout } = await execFileAsync('git', [...args], { cwd });
          return { kind: 'ok' as const, value: stdout };
        } catch (e) {
          return { kind: 'err' as const, error: e instanceof Error ? e.message : String(e) };
        }
      },
      execGh: async (args: readonly string[], cwd: string) => {
        try {
          const { stdout } = await execFileAsync('gh', [...args], { cwd });
          return { kind: 'ok' as const, value: stdout };
        } catch (e) {
          return { kind: 'err' as const, error: e instanceof Error ? e.message : String(e) };
        }
      },
      listRecentSessions: createListRecentSessions(),
      nowIso: () => new Date().toISOString(),
    }),

    awaitSessions: async (handles: readonly string[], timeoutMs: number) => {
      const { executeWorktrainAwaitCommand } = await import('../cli/commands/worktrain-await.js');
      let resolvedResult: import('../cli/commands/worktrain-await.js').AwaitResult | null = null;

      await executeWorktrainAwaitCommand(
        {
          fetch: (url: string) => globalThis.fetch(url),
          readFile: (p: string) => fs.promises.readFile(p, 'utf-8'),
          stdout: (line: string) => {
            try {
              resolvedResult = JSON.parse(line) as import('../cli/commands/worktrain-await.js').AwaitResult;
            } catch { /* ignore */ }
          },
          stderr: (line: string) => process.stderr.write(line + '\n'),
          homedir: os.homedir,
          joinPath: path.join,
          sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
        },
        {
          sessions: [...handles].join(','),
          mode: 'all',
          timeout: `${Math.round(timeoutMs / 1000)}s`,
          port: DAEMON_CONSOLE_PORT,
        },
      );

      if (resolvedResult === null) {
        process.stderr.write(
          `[WARN coord:reason=await_failed] awaitSessions: could not get session results -- daemon may be unreachable or timed out. Returning all ${handles.length} session(s) as failed.\n`,
        );
      }
      return resolvedResult ?? {
        results: [...handles].map((h) => ({
          handle: h,
          outcome: 'failed' as const,
          status: null,
          durationMs: 0,
        })),
        allSucceeded: false,
      };
    },

    getAgentResult: async (sessionHandle: string): Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }> => {
      const emptyResult = { recapMarkdown: null, artifacts: [] as readonly unknown[] };
      try {
        const sessionUrl = `http://127.0.0.1:${DAEMON_CONSOLE_PORT}/api/v2/sessions/${encodeURIComponent(sessionHandle)}`;
        const sessionRes = await globalThis.fetch(sessionUrl, { signal: AbortSignal.timeout(30_000) });
        if (!sessionRes.ok) {
          process.stderr.write(`[WARN coord:reason=http_error status=${sessionRes.status} handle=${sessionHandle.slice(0, 16)}] getAgentResult: session fetch returned HTTP ${sessionRes.status}\n`);
          return emptyResult;
        }
        const sessionBody = await sessionRes.json() as Record<string, unknown>;
        if (sessionBody['success'] !== true) {
          return emptyResult;
        }
        const data = sessionBody['data'] as Record<string, unknown> | undefined;
        if (!data) return emptyResult;
        const runs = data['runs'] as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(runs) || runs.length === 0) return emptyResult;

        const firstRun = runs[0] as Record<string, unknown>;
        const tipNodeId = typeof firstRun['preferredTipNodeId'] === 'string'
          ? firstRun['preferredTipNodeId']
          : null;
        if (!tipNodeId) return emptyResult;

        const allNodes = Array.isArray(firstRun['nodes'])
          ? (firstRun['nodes'] as Array<Record<string, unknown>>)
          : [];
        const allNodeIds = allNodes
          .map((n) => (typeof n['nodeId'] === 'string' ? n['nodeId'] : null))
          .filter((id): id is string => id !== null);
        const nodeIdsToFetch = allNodeIds.length > 0 ? allNodeIds : [tipNodeId];

        const baseNodeUrl = `http://127.0.0.1:${DAEMON_CONSOLE_PORT}/api/v2/sessions/${encodeURIComponent(sessionHandle)}/nodes/`;
        let recap: string | null = null;
        const collectedArtifacts: unknown[] = [];

        for (const nodeId of nodeIdsToFetch) {
          try {
            const nodeRes = await globalThis.fetch(
              baseNodeUrl + encodeURIComponent(nodeId),
              { signal: AbortSignal.timeout(30_000) },
            );
            if (!nodeRes.ok) continue;
            const nodeBody = await nodeRes.json() as Record<string, unknown>;
            if (nodeBody['success'] !== true) continue;
            const nodeData = nodeBody['data'] as Record<string, unknown> | undefined;
            if (!nodeData) continue;

            if (nodeId === tipNodeId) {
              recap = typeof nodeData['recapMarkdown'] === 'string' ? nodeData['recapMarkdown'] : null;
            }
            const nodeArtifacts = nodeData['artifacts'];
            if (Array.isArray(nodeArtifacts) && nodeArtifacts.length > 0) {
              collectedArtifacts.push(...nodeArtifacts);
            }
          } catch (nodeErr) {
            const msg = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
            process.stderr.write(`[WARN coord:reason=node_exception handle=${sessionHandle.slice(0, 16)} node=${nodeId.slice(0, 16)}] getAgentResult: ${msg}\n`);
          }
        }

        return { recapMarkdown: recap, artifacts: collectedArtifacts };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[WARN coord:reason=exception handle=${sessionHandle.slice(0, 16)}] getAgentResult: ${msg}\n`);
        return emptyResult;
      }
    },

    listOpenPRs: async (workspace: string) => {
      try {
        const { stdout } = await execFileAsync('gh', ['pr', 'list', '--json', 'number,title,headRefName'], {
          cwd: workspace,
          timeout: 30_000,
        });
        const parsed = JSON.parse(stdout) as Array<{ number: number; title: string; headRefName: string }>;
        return parsed.map((p) => ({ number: p.number, title: p.title, headRef: p.headRefName }));
      } catch {
        return [];
      }
    },

    mergePR: async (prNumber: number, workspace: string) => {
      try {
        await execFileAsync('gh', ['pr', 'merge', String(prNumber), '--squash', '--auto'], {
          cwd: workspace,
          timeout: 60_000,
        });
        return { kind: 'ok' as const, value: undefined };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { kind: 'err' as const, error: msg };
      }
    },

    writeFile: async (filePath: string, content: string) => {
      await fs.promises.writeFile(filePath, content, 'utf-8');
    },

    readFile: (filePath: string) => fs.promises.readFile(filePath, 'utf-8'),

    appendFile: (filePath: string, content: string) =>
      fs.promises.appendFile(filePath, content, 'utf-8'),

    mkdir: (dirPath: string, opts: { recursive: boolean }) =>
      fs.promises.mkdir(dirPath, opts),

    homedir: os.homedir,
    joinPath: path.join,
    nowIso: () => new Date().toISOString(),
    generateId: () => randomUUID(),

    stderr: (line: string) => process.stderr.write(line + '\n'),
    now: () => Date.now(),
    port: DAEMON_CONSOLE_PORT,

    // AdaptiveCoordinatorDeps extensions (beyond CoordinatorDeps)

    fileExists: (p: string): boolean => fs.existsSync(p),

    archiveFile: (src: string, dest: string): Promise<void> =>
      fs.promises.rename(src, dest),

    pollForPR: async (branchPattern: string, timeoutMs: number): Promise<string | null> => {
      // Poll `gh pr list --head <branchPattern>` every 30 seconds until a PR is found
      // or the timeout elapses. Returns the PR URL or null.
      const pollIntervalMs = 30_000;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        try {
          const { stdout } = await execFileAsync(
            'gh',
            ['pr', 'list', '--head', branchPattern, '--json', 'url', '--limit', '1'],
            { timeout: 30_000 },
          );
          const parsed = JSON.parse(stdout) as Array<{ url: string }>;
          if (parsed.length > 0 && parsed[0] && parsed[0].url) {
            return parsed[0].url;
          }
        } catch {
          // gh command failed -- continue polling (PR may not exist yet)
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
        );
      }
      return null;
    },

    postToOutbox: async (message: string, metadata: Readonly<Record<string, unknown>>): Promise<void> => {
      const workrailDir = path.join(os.homedir(), '.workrail');
      const outboxPath = path.join(workrailDir, 'outbox.jsonl');
      await fs.promises.mkdir(workrailDir, { recursive: true });
      const entry = JSON.stringify({
        id: randomUUID(),
        message,
        metadata,
        timestamp: new Date().toISOString(),
      });
      await fs.promises.appendFile(outboxPath, entry + '\n', 'utf-8');
    },

    pollOutboxAck: async (requestId: string, timeoutMs: number): Promise<'acked' | 'timeout'> => {
      // Poll ~/.workrail/inbox-cursor.json every 5 minutes.
      // The human acknowledges by running `worktrain inbox`, which advances the cursor.
      // Resolve 'acked' when the cursor has advanced past the snapshot line count.
      //
      // WHY snapshot approach: postToOutbox appends a line to outbox.jsonl. The inbox
      // command sets lastReadCount = total valid lines in outbox.jsonl. When the cursor
      // advances beyond the snapshot count, the human has read the notification.
      const pollIntervalMs = 5 * 60 * 1000; // 5 minutes
      const workrailDir = path.join(os.homedir(), '.workrail');
      const outboxPath = path.join(workrailDir, 'outbox.jsonl');
      const cursorPath = path.join(workrailDir, 'inbox-cursor.json');

      // Take snapshot of current outbox line count
      let snapshotCount = 0;
      try {
        const outboxContent = await fs.promises.readFile(outboxPath, 'utf-8');
        snapshotCount = outboxContent.split('\n').filter((l) => l.trim() !== '').length;
      } catch {
        // outbox.jsonl doesn't exist yet -- snapshot is 0
      }

      // Suppress unused parameter warning: requestId is for traceability in logs
      void requestId;

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
        );

        try {
          const cursorContent = await fs.promises.readFile(cursorPath, 'utf-8');
          const cursor = JSON.parse(cursorContent) as { lastReadCount?: number };
          if (typeof cursor.lastReadCount === 'number' && cursor.lastReadCount > snapshotCount) {
            return 'acked';
          }
        } catch {
          // cursor file missing or malformed -- not yet acked, continue polling
        }
      }
      return 'timeout';
    },
  };

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
  const router = new TriggerRouter(triggerIndex, ctx, apiKey, runWorkflowFn, undefined, maxConcurrentSessions, options.emitter, notificationService, steerRegistry, coordinatorDeps, modeExecutors);
  // Populate the forward reference so spawnSession can dispatch in-process.
  // WHY here (not before construction): routerRef is a forward-ref needed because
  // coordinatorDeps must be constructed before TriggerRouter (it's a constructor arg).
  // Assigned exactly once, immediately after construction.
  routerRef = router;
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
  await runStartupRecovery().catch((err: unknown) => {
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
        steerRegistry,
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
