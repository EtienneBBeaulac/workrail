/**
 * WorkRail Auto: Trigger Router
 *
 * Routes incoming webhook events to runWorkflow() calls.
 *
 * Responsibilities:
 * 1. Look up the trigger definition by ID from the store index.
 * 2. Validate HMAC-SHA256 signature (if hmacSecret is configured).
 * 3. Apply contextMapping: extract fields from payload using dot-path traversal.
 * 4. Enqueue a runWorkflow() call via KeyedAsyncQueue (fire-and-forget).
 * 5. Log results to stdout (MVP delivery system).
 *
 * Design notes:
 * - HMAC uses crypto.timingSafeEqual (timing-safe). Length difference short-circuits
 *   before the call -- this is safe because HMAC-SHA256 digest length is constant (32 bytes).
 * - KeyedAsyncQueue key strategy: serial mode uses triggerId (same-trigger fires are serialized
 *   FIFO); parallel mode uses triggerId:UUID (each fire gets its own queue slot and runs
 *   concurrently). Webhooks for different triggers always run concurrently.
 * - runWorkflow() is called AFTER the 202 response is sent. The caller (listener) fires
 *   the route call as a background task; the result is logged, not returned.
 * - contextMapping dot-path: "$.pull_request.html_url" -> payload.pull_request.html_url.
 *   Leading "$." is stripped. Array indexing (e.g. "[0]") logs a warning and returns undefined.
 */

import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkflowTrigger, WorkflowRunResult, WorkflowDeliveryFailed, SteerRegistry } from '../daemon/workflow-runner.js';
import { assertNever } from '../runtime/assert-never.js';
import type { V2ToolContext } from '../mcp/types.js';
import { KeyedAsyncQueue } from '../v2/infra/in-memory/keyed-async-queue/index.js';
import { post as deliveryPost } from './delivery-client.js';
import type {
  TriggerDefinition,
  WebhookEvent,
  ContextMappingEntry,
} from './types.js';
import { parseHandoffArtifact, runDelivery } from './delivery-action.js';
import type { ExecFn } from './delivery-action.js';
import type { DaemonEventEmitter } from '../daemon/daemon-events.js';
import type { NotificationService } from './notification-service.js';
import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts, ModeExecutors } from '../coordinators/adaptive-pipeline.js';
import { runAdaptivePipeline } from '../coordinators/adaptive-pipeline.js';

/**
 * Default production exec function: promisify(execFile).
 *
 * WHY execFile over exec: execFile does NOT invoke /bin/sh. User-controlled content
 * (commit messages, PR titles, file paths) is passed as discrete args and is never
 * interpolated into a shell string. Shell metacharacters have no effect.
 */
const execFileAsync = promisify(execFile) as ExecFn;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouteError =
  | { readonly kind: 'not_found'; readonly triggerId: string }
  | { readonly kind: 'hmac_invalid' }
  | { readonly kind: 'payload_error'; readonly message: string };

export type RouteResult =
  | { readonly _tag: 'enqueued'; readonly triggerId: string }
  | { readonly _tag: 'error'; readonly error: RouteError };

/**
 * Function signature for running a workflow.
 * Injected to allow testing without a real V2ToolContext and Anthropic API key.
 */
export type RunWorkflowFn = (
  trigger: WorkflowTrigger,
  ctx: V2ToolContext,
  apiKey: string,
  daemonRegistry?: import('../v2/infra/in-memory/daemon-registry/index.js').DaemonRegistry,
  emitter?: DaemonEventEmitter,
  steerRegistry?: SteerRegistry,
) => Promise<WorkflowRunResult>;

// ---------------------------------------------------------------------------
// Goal template interpolation
// ---------------------------------------------------------------------------

/**
 * Interpolate a goalTemplate string by replacing `{{$.dot.path}}` tokens
 * with values extracted from the webhook payload.
 *
 * Falls back to the static `goal` string if:
 * - The template is absent or empty.
 * - ANY token resolves to undefined (partial interpolation would produce
 *   a broken goal string, so we fall back entirely).
 *
 * When a token is missing, emits a `console.warn` with the missing token name
 * and the triggerId (R2 from design review -- helps operators debug misconfigured
 * templates without requiring them to monitor session titles).
 *
 * Token syntax: `{{$.dot.path}}` or `{{dot.path}}` (leading "$." optional).
 * The same dot-path extraction rules apply as for contextMapping.
 *
 * @param template - The goal template string (e.g. "Review {{$.pull_request.title}}")
 * @param staticGoal - The static fallback goal from the trigger definition
 * @param payload - The parsed webhook payload
 * @param triggerId - Trigger ID for diagnostic warning
 * @returns The interpolated goal, or staticGoal if any token is missing
 */
export function interpolateGoalTemplate(
  template: string,
  staticGoal: string,
  payload: Readonly<Record<string, unknown>>,
  triggerId: string,
): string {
  // Find all {{...}} tokens
  const TOKEN_RE = /\{\{([^}]+)\}\}/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(template)) !== null) {
    if (match[1] !== undefined) tokens.push(match[1]);
  }

  // If no tokens, return template as-is (it's effectively a static string)
  if (tokens.length === 0) return template;

  // Extract all token values first; bail on any missing value
  const resolved = new Map<string, string>();
  for (const token of tokens) {
    const value = extractDotPath(payload, token);
    if (value === undefined || value === null) {
      // Any missing token: warn and fall back to static goal (no partial interpolation)
      console.warn(
        `[TriggerRouter] goalTemplate variable '${token}' not found in payload ` +
        `for trigger '${triggerId}' (template: '${template}'). Falling back to static goal.`,
      );
      return staticGoal;
    }
    resolved.set(token, String(value));
  }

  // Replace all tokens with their resolved values
  return template.replace(TOKEN_RE, (_, token: string) => resolved.get(token) ?? staticGoal);
}

// ---------------------------------------------------------------------------
// Context mapping: dot-path extraction
// ---------------------------------------------------------------------------

/**
 * Traverse an object using a dot-path string.
 *
 * Examples:
 *   "$.pull_request.html_url" -> obj.pull_request.html_url
 *   "pull_request.html_url"   -> obj.pull_request.html_url (leading "$." optional)
 *   "$.labels[0]"             -> logs warning, returns undefined (array indexing unsupported)
 *
 * @returns The extracted value, or undefined if the path does not exist or is invalid.
 */
function extractDotPath(
  obj: Readonly<Record<string, unknown>>,
  rawPath: string,
): unknown {
  // Strip optional leading "$." or "$"
  let path = rawPath.trim();
  if (path.startsWith('$.')) path = path.slice(2);
  else if (path.startsWith('$')) path = path.slice(1);

  const segments = path.split('.');

  let current: unknown = obj;
  for (const segment of segments) {
    if (segment.includes('[')) {
      // Array indexing not supported in MVP
      console.warn(
        `[TriggerRouter] contextMapping path "${rawPath}" contains array indexing ` +
        `(segment: "${segment}"). Array indexing is not supported in MVP. ` +
        `The extracted value will be undefined.`,
      );
      return undefined;
    }

    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Apply a contextMapping to a webhook payload.
 * Returns a Record of workflow context variables.
 * Missing required keys log a warning; undefined values are omitted.
 */
function applyContextMapping(
  payload: Readonly<Record<string, unknown>>,
  entries: readonly ContextMappingEntry[],
): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  for (const entry of entries) {
    const value = extractDotPath(payload, entry.payloadPath);

    if (value === undefined) {
      if (entry.required) {
        console.warn(
          `[TriggerRouter] Required contextMapping key "${entry.workflowContextKey}" ` +
          `(path: "${entry.payloadPath}") resolved to undefined. ` +
          `The workflow context will be missing this variable.`,
        );
      }
      // Omit undefined values from context
      continue;
    }

    context[entry.workflowContextKey] = value;
  }

  return context;
}

// ---------------------------------------------------------------------------
// HMAC validation
// ---------------------------------------------------------------------------

/**
 * Validate X-WorkRail-Signature HMAC-SHA256 signature.
 *
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 * Short-circuits on length difference (safe: HMAC-SHA256 digest length is constant).
 *
 * @param rawBody - Raw request body bytes (must match what the sender hashed)
 * @param secret - HMAC secret (already resolved from env)
 * @param headerValue - The X-WorkRail-Signature header value from the request
 * @returns true if the signature is valid, false otherwise
 */
function validateHmac(rawBody: Buffer, secret: string, headerValue: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Normalize header: strip optional "sha256=" prefix (GitHub-style)
  const received = headerValue.startsWith('sha256=')
    ? headerValue.slice(7)
    : headerValue;

  // Different lengths = not equal (safe early exit; length is not secret for hex digest)
  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(received, 'utf8'),
  );
}

// ---------------------------------------------------------------------------
// Delivery helper
// ---------------------------------------------------------------------------

/**
 * Run post-workflow delivery if autoCommit is enabled for this trigger.
 *
 * Parses the structured handoff artifact from lastStepNotes and calls runDelivery().
 * All errors are logged and discarded -- delivery is best-effort and must never affect
 * the workflow's success/failure state.
 *
 * WHY module-level function (not class method): pure helper shared by route() and
 * dispatch() without coupling to TriggerRouter's private state. Delivery logic
 * belongs in delivery-action.ts; this is just the wiring.
 *
 * @param triggerId - Used in log messages for traceability
 * @param trigger - Source of workspacePath, autoCommit, autoOpenPR flags
 * @param result - WorkflowRunResult; only called when _tag === 'success'
 * @param execFn - Injectable exec function (production: execFileAsync; tests: fake)
 */
async function maybeRunDelivery(
  triggerId: string,
  trigger: TriggerDefinition,
  result: WorkflowRunResult,
  execFn: ExecFn,
): Promise<void> {
  // Only deliver on success with autoCommit enabled
  if (result._tag !== 'success') return;
  if (result.lastStepNotes === undefined) {
    if (trigger.autoCommit === true) {
      console.warn(
        `[TriggerRouter] Delivery skipped: triggerId=${triggerId} -- ` +
        `lastStepNotes is absent (agent did not provide notes on the final step). ` +
        `Ensure the workflow produces a JSON handoff block in its final step notes.`,
      );
    }
    return;
  }
  if (trigger.autoCommit !== true) return;

  // Parse the structured handoff artifact from the agent's final step notes
  const parseResult = parseHandoffArtifact(result.lastStepNotes);
  if (parseResult.kind === 'err') {
    console.warn(
      `[TriggerRouter] Delivery skipped: triggerId=${triggerId} -- ` +
      `handoff artifact not parseable: ${parseResult.error}. ` +
      `Ensure the workflow's final step produces a JSON block with commitType, filesChanged, etc.`,
    );
    return;
  }

  // Use sessionWorkspacePath when available (worktree sessions must commit from the worktree,
  // not from the main checkout). Fall back to trigger.workspacePath for 'none' sessions.
  // WHY: the agent's changes live in the worktree. git add/commit/push must run there.
  const deliveryCwd = result.sessionWorkspacePath ?? trigger.workspacePath;

  const deliveryResult = await runDelivery(
    parseResult.value,
    deliveryCwd,
    {
      autoCommit: trigger.autoCommit,
      autoOpenPR: trigger.autoOpenPR,
      // secretScan: pass trigger value (undefined = use default true in runDelivery).
      // WHY ?? true not needed here: runDelivery checks flags.secretScan !== false,
      // so undefined is equivalent to true. Passing trigger.secretScan preserves the
      // explicit false from triggers.yml without needing a default here.
      secretScan: trigger.secretScan ?? true,
      // Attribution: triggerId and workflowId are used in the PR body footer so operators
      // can trace the PR back to the trigger and workflow that produced it.
      triggerId,
      workflowId: trigger.workflowId,
      // Per-command git identity: threaded from WorkflowRunSuccess.botIdentity (which was
      // set from trigger.botIdentity in runWorkflow). Avoids writing to the shared .git/config.
      ...(result.botIdentity !== undefined ? { botIdentity: result.botIdentity } : {}),
      // Branch assertion: verify HEAD matches expected branch before git push.
      // Only meaningful for worktree sessions -- 'none' sessions use trigger.workspacePath.
      // WHY result.sessionId (not split from path): sessionId is threaded directly through
      // WorkflowRunSuccess to avoid fragile path-parsing that couples branch naming convention
      // to the calling code. See WorkflowRunSuccess.sessionId for the full rationale.
      ...(trigger.branchStrategy === 'worktree' && result.sessionWorkspacePath
        ? {
            sessionId: result.sessionId ?? '',
            branchPrefix: trigger.branchPrefix ?? 'worktrain/',
          }
        : {}),
    },
    execFn,
  );

  switch (deliveryResult._tag) {
    case 'committed':
      console.log(
        `[TriggerRouter] Delivery committed: triggerId=${triggerId} sha=${deliveryResult.sha}`,
      );
      break;
    case 'pr_opened':
      console.log(
        `[TriggerRouter] Delivery PR opened: triggerId=${triggerId} url=${deliveryResult.url}`,
      );
      break;
    case 'skipped':
      console.log(
        `[TriggerRouter] Delivery skipped: triggerId=${triggerId} reason=${deliveryResult.reason}`,
      );
      break;
    case 'error':
      console.warn(
        `[TriggerRouter] Delivery error: triggerId=${triggerId} phase=${deliveryResult.phase} ` +
        `details=${deliveryResult.details}`,
      );
      break;
  }

  // Worktree cleanup on success: remove the isolated worktree after delivery completes.
  //
  // WHY here (not in runWorkflow()): delivery (git add, commit, push, gh pr create) all
  // run inside the worktree. The worktree must exist until delivery finishes. Removing it
  // inside runWorkflow() before delivery would break the delivery path.
  //
  // WHY after delivery regardless of deliveryResult._tag: the worktree's purpose is to
  // serve the session. Once delivery has been attempted (success or error), the worktree
  // has served its purpose and should be cleaned up to avoid disk accumulation.
  //
  // WHY best-effort (catch + log): cleanup failure must never affect the workflow result.
  // A non-removable worktree will be reaped by runStartupRecovery() after 24h.
  if (trigger.branchStrategy === 'worktree' && result.sessionWorkspacePath) {
    try {
      await execFn('git', ['-C', trigger.workspacePath, 'worktree', 'remove', '--force', result.sessionWorkspacePath], { cwd: trigger.workspacePath, timeout: 60_000 });
      console.log(
        `[TriggerRouter] Worktree removed: triggerId=${triggerId} path=${result.sessionWorkspacePath}`,
      );
    } catch (err: unknown) {
      console.warn(
        `[TriggerRouter] Could not remove worktree: triggerId=${triggerId} ` +
        `path=${result.sessionWorkspacePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}


// ---------------------------------------------------------------------------
// Semaphore: global concurrency cap for runWorkflow() calls
// ---------------------------------------------------------------------------

/**
 * Promise-based counting semaphore.
 *
 * WHY a semaphore instead of a simple counter:
 * A plain counter with "if at capacity, drop" would silently lose dispatches after
 * the caller has already received a 202 Accepted response. Queue-and-wait is required
 * so every accepted dispatch eventually executes.
 *
 * WHY acquire() is called INSIDE the queue callback (not before enqueue()):
 * route() and dispatch() must return immediately -- the 202 response is sent before
 * enqueue(). Acquiring the semaphore before enqueue() would block route()/dispatch()
 * until a slot is free, breaking the fire-and-forget contract.
 * Instead, the semaphore is acquired inside the async queue callback, where blocking
 * is safe: the callback is already running on the promise chain, not on the hot path.
 *
 * WHY default max = 3:
 * A conservative default prevents resource exhaustion for concurrencyMode:'parallel'
 * triggers without requiring any user configuration. Configurable via
 * maxConcurrentSessions in ~/.workrail/config.json.
 *
 * Invariants:
 * - acquire() returns a Promise that resolves when a slot is available (FIFO order).
 * - release() must be called in a finally block -- never conditional.
 * - max is always >= 1 (enforced by TriggerRouter constructor).
 */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly max: number) {}

  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    // At capacity: enqueue a waiter that resolves when a slot opens.
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      // Hand the slot directly to the next waiter (active count stays the same).
      next();
    } else {
      this.active--;
    }
  }

  /** Current count of active (running) sessions. */
  get activeCount(): number {
    return this.active;
  }
}

// ---------------------------------------------------------------------------
// TriggerRouter class
// ---------------------------------------------------------------------------

/** Default maximum concurrent runWorkflow() calls across all triggers. */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

export class TriggerRouter {
  private readonly queue = new KeyedAsyncQueue();
  private readonly execFn: ExecFn;
  private readonly semaphore: Semaphore;
  private readonly _maxConcurrentSessions: number;
  private readonly emitter: DaemonEventEmitter | undefined;
  private readonly notificationService: NotificationService | undefined;
  private readonly steerRegistry: SteerRegistry | undefined;
  private readonly _coordinatorDeps: AdaptiveCoordinatorDeps | undefined;
  private readonly _modeExecutors: ModeExecutors | undefined;

  /**
   * Recent adaptive dispatch timestamps keyed by `${goal}::${workspace}`.
   *
   * WHY Map<string, number> (not a Set): we need the timestamp to implement
   * a TTL-based sliding window. A Set can only answer "was this dispatched?",
   * not "was this dispatched within the last N milliseconds?".
   *
   * WHY cleanup-on-entry (not a background timer): a timer would introduce
   * async state that conflicts with the determinism principle and complicates
   * testing. Cleanup-on-entry is O(n) per dispatch call, bounded by the
   * number of unique goal+workspace pairs dispatched in the last 30s -- always
   * a small number in practice.
   *
   * @see dispatchAdaptivePipeline
   * @see ADAPTIVE_DEDUPE_TTL_MS
   */
  private readonly _recentAdaptiveDispatches = new Map<string, number>();

  /**
   * TTL for adaptive dispatch deduplication: 30 seconds.
   *
   * A second dispatch for the same goal+workspace within this window is
   * silently skipped to prevent duplicate pipeline sessions from webhook
   * retries or rapid-fire test triggers.
   */
  private static readonly ADAPTIVE_DEDUPE_TTL_MS = 30_000;

  constructor(
    private readonly index: ReadonlyMap<string, TriggerDefinition>,
    private readonly ctx: V2ToolContext,
    private readonly apiKey: string,
    private readonly runWorkflowFn: RunWorkflowFn,
    /**
     * Injectable exec function for post-workflow delivery.
     * Defaults to promisify(execFile) in production.
     * Override in tests to use a fake without calling child_process.
     */
    execFn?: ExecFn,
    maxConcurrentSessions?: number,
    /**
     * Optional event emitter for structured daemon lifecycle events.
     * When provided, emits trigger_fired and session_queued events.
     * When absent, no events are emitted (zero overhead).
     */
    emitter?: DaemonEventEmitter,
    /**
     * Optional notification service for user-facing notifications.
     * When provided, fires macOS/webhook notifications after each session completes.
     * When absent, no notifications are fired (zero overhead).
     *
     * WHY optional injection (not a direct config): follows the DaemonEventEmitter
     * pattern -- the caller constructs the service and injects it. This keeps
     * TriggerRouter free of notification config knowledge and makes both sides
     * independently testable.
     */
    notificationService?: NotificationService,
    /**
     * Optional steer registry for coordinator injection via POST /sessions/:id/steer.
     * When provided, daemon sessions register a steer callback on start and deregister
     * on completion. The HTTP endpoint dispatches to the registered callback.
     * When absent, the steer endpoint returns 404 for all sessions handled by this router.
     */
    steerRegistry?: SteerRegistry,
    /**
     * Optional adaptive coordinator dependencies for in-process pipeline dispatch.
     * When provided, dispatchAdaptivePipeline() uses these as default deps.
     * When absent, dispatchAdaptivePipeline() logs a warning and returns an escalated outcome.
     *
     * WHY optional injection: follows the same DI pattern as execFn, emitter, etc.
     * Production wiring is done in trigger-listener.ts (bootstrap level).
     * Tests that do not need adaptive dispatch omit this parameter.
     *
     * @see dispatchAdaptivePipeline
     */
    coordinatorDeps?: AdaptiveCoordinatorDeps,
    /**
     * Optional mode executors for the adaptive pipeline coordinator.
     * Must be provided alongside coordinatorDeps for adaptive dispatch to activate.
     * When absent (or when coordinatorDeps is absent), dispatchAdaptivePipeline falls back
     * to logging a warning and returning an escalated outcome.
     *
     * @see dispatchAdaptivePipeline
     */
    modeExecutors?: ModeExecutors,
  ) {
    this.execFn = execFn ?? execFileAsync;
    this.emitter = emitter;
    this.notificationService = notificationService;
    this.steerRegistry = steerRegistry;
    this._coordinatorDeps = coordinatorDeps;
    this._modeExecutors = modeExecutors;
    // Validate and clamp: maxConcurrentSessions must be >= 1.
    // A value of 0 or negative would deadlock all dispatches -- make it impossible.
    const requested = maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    // WHY: ?? does not catch NaN (NaN is type number, not null/undefined). If NaN reaches
    // Semaphore(), acquire() deadlocks silently because 0 < NaN is false.
    const cap = Number.isNaN(requested) ? DEFAULT_MAX_CONCURRENT_SESSIONS : requested;
    if (cap < 1) {
      console.warn(
        `[TriggerRouter] maxConcurrentSessions must be >= 1; received ${cap}, clamping to 1.`,
      );
      this._maxConcurrentSessions = 1;
    } else {
      this._maxConcurrentSessions = cap;
    }
    this.semaphore = new Semaphore(this._maxConcurrentSessions);
    console.log(`[TriggerRouter] maxConcurrentSessions=${this._maxConcurrentSessions}`);
  }

  /** Current count of active (running) runWorkflow() calls. */
  get activeSessions(): number {
    return this.semaphore.activeCount;
  }

  /** Configured maximum concurrent runWorkflow() calls. */
  get maxConcurrentSessions(): number {
    return this._maxConcurrentSessions;
  }

  /**
   * Route an incoming webhook event.
   *
   * Returns immediately with a RouteResult. The actual runWorkflow() call is
   * enqueued asynchronously -- the caller must NOT await the workflow run.
   *
   * The returned `_tag: 'enqueued'` result means the event was accepted and
   * queued for processing. It does NOT mean the workflow completed successfully.
   */
  route(event: WebhookEvent): RouteResult {
    const trigger = this.index.get(event.triggerId);
    if (!trigger) {
      return {
        _tag: 'error',
        error: { kind: 'not_found', triggerId: event.triggerId },
      };
    }

    // HMAC validation (only if hmacSecret is configured)
    if (trigger.hmacSecret) {
      const signature = event.signature;
      if (!signature) {
        return { _tag: 'error', error: { kind: 'hmac_invalid' } };
      }
      if (!validateHmac(event.rawBody, trigger.hmacSecret, signature)) {
        return { _tag: 'error', error: { kind: 'hmac_invalid' } };
      }
    }

    // Check dispatchCondition (if configured): gate dispatch on a payload value.
    // Runs AFTER HMAC validation (payload is authentic) and BEFORE context mapping.
    // WHY: filter early so unauthenticated payloads never reach this check (HMAC first),
    // and so skipped dispatches never build context (avoid wasted work).
    //
    // Silent skip: returns { _tag: 'enqueued' } without calling runWorkflowFn.
    // The 202 response was already sent before route() is called -- the HTTP contract
    // is 'accepted for processing', not 'guaranteed to dispatch'. A debug log provides
    // the only observability when a dispatch is skipped by this condition.
    if (trigger.dispatchCondition) {
      const { payloadPath, equals } = trigger.dispatchCondition;
      const extracted = extractDotPath(event.payload, payloadPath);
      // Strict identity check (no type coercion): string '42' does NOT match number 42.
      if (extracted !== equals) {
        const actual = extracted === undefined ? 'undefined' : String(extracted);
        console.log(
          `[TriggerRouter] dispatch skipped: condition not met ` +
          `(${payloadPath}=${actual} !== ${equals}) for triggerId=${trigger.id}`,
        );
        return { _tag: 'enqueued', triggerId: trigger.id };
      }
    }

    // Build workflow context from contextMapping + raw payload fallback
    let workflowContext: Record<string, unknown>;
    if (trigger.contextMapping?.mappings.length) {
      workflowContext = applyContextMapping(event.payload, trigger.contextMapping.mappings);
    } else {
      // No contextMapping: pass raw payload as context.payload
      workflowContext = { payload: event.payload };
    }

    // Interpolate goal from template if configured; fall back to static goal
    const goal = trigger.goalTemplate
      ? interpolateGoalTemplate(trigger.goalTemplate, trigger.goal, event.payload, trigger.id)
      : trigger.goal;

    const workflowTrigger: WorkflowTrigger = {
      workflowId: trigger.workflowId,
      goal,
      workspacePath: trigger.workspacePath,
      context: workflowContext,
      ...(trigger.referenceUrls !== undefined ? { referenceUrls: trigger.referenceUrls } : {}),
      ...(trigger.agentConfig !== undefined ? { agentConfig: trigger.agentConfig } : {}),
      // soulFile is cascade-resolved in trigger-store.ts (trigger -> workspace -> undefined).
      ...(trigger.soulFile !== undefined ? { soulFile: trigger.soulFile } : {}),
      // Worktree isolation fields (Issue #627). Forwarded from TriggerDefinition so
      // runWorkflow() can create an isolated git worktree when branchStrategy === 'worktree'.
      // Follows the soulFile forwarding pattern.
      ...(trigger.branchStrategy !== undefined ? { branchStrategy: trigger.branchStrategy } : {}),
      ...(trigger.baseBranch !== undefined ? { baseBranch: trigger.baseBranch } : {}),
      ...(trigger.branchPrefix !== undefined ? { branchPrefix: trigger.branchPrefix } : {}),
    };

    // Emit trigger_fired: the webhook was accepted and validated.
    this.emitter?.emit({ kind: 'trigger_fired', triggerId: trigger.id, workflowId: trigger.workflowId });

    // Enqueue asynchronously.
    // Queue key strategy:
    // - 'serial' (default): use trigger.id as the key so concurrent webhook fires for
    //   the same trigger are serialized. serial-per-trigger is intentional for MVP --
    //   it prevents token corruption when two webhooks fire for the same trigger
    //   concurrently. This is the safe default and should not be changed without
    //   understanding the concurrency invariants in the agent session layer.
    // - 'parallel': use a unique key per invocation so each fire gets its own queue
    //   slot. Use only when concurrent runs for this trigger are intentional and safe.
    const queueKey = trigger.concurrencyMode === 'parallel'
      ? `${trigger.id}:${crypto.randomUUID()}`
      : trigger.id;
    void this.queue.enqueue(queueKey, async () => {
      // Emit session_queued: the run entered the queue (may wait for a semaphore slot).
      this.emitter?.emit({ kind: 'session_queued', triggerId: trigger.id, workflowId: trigger.workflowId });

      // Acquire the global semaphore before starting runWorkflowFn().
      // WHY inside the callback (not before enqueue): route() must return immediately.
      // Blocking here is safe; blocking before enqueue() would break the 202 contract.
      if (this.semaphore.activeCount >= this._maxConcurrentSessions) {
        console.warn(
          `[TriggerRouter] Concurrency limit reached ` +
          `(${this.semaphore.activeCount}/${this._maxConcurrentSessions} active): ` +
          `queuing dispatch for triggerId=${trigger.id}`,
        );
      }
      await this.semaphore.acquire();
      let result: WorkflowRunResult;
      try {
        result = await this.runWorkflowFn(workflowTrigger, this.ctx, this.apiKey, undefined, this.emitter, this.steerRegistry);
      } finally {
        this.semaphore.release();
      }

      // POST result to callbackUrl if configured (GAP-3: deliveryContext).
      // WHY: bind delivery target at trigger-config time, post result at completion time.
      // A failed POST produces a 'delivery_failed' result so the failure is never silent.
      // TODO(follow-up): add retry, auth headers, $ENV_VAR_NAME resolution for callbackUrl.
      // Capture both _tag and original result before potential reassignment.
      // WHY originalResult: maybeRunDelivery gates on result._tag === 'success'. If callbackUrl
      // fails and result is reassigned to delivery_failed, the gate would incorrectly skip
      // autoCommit even though the workflow succeeded. callbackUrl and autoCommit are independent
      // delivery systems and must not affect each other.
      const originalTag = result._tag;
      const originalResult = result;
      if (trigger.callbackUrl) {
        const deliveryResult = await deliveryPost(trigger.callbackUrl, result, this.emitter);
        if (deliveryResult.kind === 'err') {
          const deliveryError =
            deliveryResult.error.kind === 'http_error'
              ? `HTTP ${deliveryResult.error.status}: ${deliveryResult.error.body}`
              : deliveryResult.error.message;
          console.error(
            `[TriggerRouter] Delivery failed: triggerId=${trigger.id} ` +
              `callbackUrl=${trigger.callbackUrl} error=${deliveryError}`,
          );
          const deliveryFailed: WorkflowDeliveryFailed = {
            _tag: 'delivery_failed',
            workflowId: trigger.workflowId,
            stopReason: result.stopReason,
            deliveryError,
          };
          result = deliveryFailed;
        }
      }

      if (result._tag === 'success') {
        console.log(
          `[TriggerRouter] Workflow completed: triggerId=${trigger.id} ` +
            `workflowId=${trigger.workflowId} stopReason=${result.stopReason}`,
        );
      } else if (result._tag === 'delivery_failed') {
        // Delivery error already logged above; this log is for correlation.
        // Use originalTag to distinguish whether the workflow itself succeeded or failed.
        const outcomeLabel = originalTag === 'success'
          ? 'Workflow succeeded but delivery failed'
          : 'Workflow failed and delivery also failed';
        console.log(
          `[TriggerRouter] ${outcomeLabel}: triggerId=${trigger.id} ` +
            `workflowId=${trigger.workflowId} stopReason=${result.stopReason}`,
        );
      } else if (result._tag === 'timeout') {
        console.log(
          `[TriggerRouter] Workflow timed out: triggerId=${trigger.id} ` +
          `workflowId=${trigger.workflowId} reason=${result.reason} message=${result.message}`,
        );
      } else if (result._tag === 'error') {
        console.log(
          `[TriggerRouter] Workflow failed: triggerId=${trigger.id} ` +
            `workflowId=${trigger.workflowId} error=${result.message} stopReason=${result.stopReason}`,
        );
      } else if (result._tag === 'stuck') {
        console.log(
          `[TriggerRouter] Workflow stuck: triggerId=${trigger.id} ` +
          `workflowId=${trigger.workflowId} reason=${result.reason} message=${result.message}`,
          // TODO(follow-up): add onStuck: trigger hook support here
        );
      } else {
        // Compile-time exhaustiveness guard. If WorkflowRunResult gains a new variant
        // this will fail to compile, forcing the developer to handle the new case.
        // At runtime this is unreachable -- all current variants are handled above.
        assertNever(result);
      }
      // User notifications: fire after logging, before delivery.
      // Fire-and-forget -- notify() returns void and swallows all errors.
      // Uses the final `result` (post-delivery_failed reassignment) so the
      // notification reflects the actual outcome the user cares about.
      this.notificationService?.notify(result, workflowTrigger.goal);

      // Post-workflow delivery: runs after the workflow result is logged.
      // Best-effort -- errors are logged and discarded, never change the workflow result.
      // Use originalResult (not result) so callbackUrl failure does not skip autoCommit.
      await maybeRunDelivery(trigger.id, trigger, originalResult, this.execFn);
    });

    return { _tag: 'enqueued', triggerId: trigger.id };
  }

  /**
   * Dispatch a workflow run directly (without a webhook event).
   *
   * Used by the console AUTO dispatch endpoint (POST /api/v2/auto/dispatch).
   * Unlike route(), this bypasses HMAC validation and trigger lookup -- the
   * caller provides a fully-formed WorkflowTrigger directly.
   *
   * Fires and forgets via KeyedAsyncQueue (same serialization semantics as route()).
   * Uses workflowId as the queue key to serialize concurrent dispatches for the same workflow.
   *
   * NOTE: dispatch() does not support callbackUrl. WorkflowTrigger does not carry
   * delivery routing info -- only TriggerDefinition (used by route()) does.
   * TODO(follow-up): add callbackUrl to WorkflowTrigger if dispatch callers need delivery.
   *
   * @returns The workflowId that was dispatched.
   */
  dispatch(workflowTrigger: WorkflowTrigger): string {
    void this.queue.enqueue(workflowTrigger.workflowId, async () => {
      // Same semaphore pattern as route(): acquire inside the callback so dispatch()
      // returns immediately, then wait for a slot before calling runWorkflowFn().
      if (this.semaphore.activeCount >= this._maxConcurrentSessions) {
        console.warn(
          `[TriggerRouter] Concurrency limit reached ` +
          `(${this.semaphore.activeCount}/${this._maxConcurrentSessions} active): ` +
          `queuing dispatch for workflowId=${workflowTrigger.workflowId}`,
        );
      }
      await this.semaphore.acquire();
      let result: WorkflowRunResult;
      try {
        result = await this.runWorkflowFn(workflowTrigger, this.ctx, this.apiKey, undefined, this.emitter, this.steerRegistry);
      } finally {
        this.semaphore.release();
      }
      if (result._tag === 'success') {
        console.log(
          `[TriggerRouter] Dispatch completed: workflowId=${workflowTrigger.workflowId} ` +
            `stopReason=${result.stopReason}`,
        );
      } else if (result._tag === 'delivery_failed') {
        // delivery_failed not expected from dispatch() -- WorkflowTrigger has no callbackUrl.
        // Handled here to keep the union exhaustive after WorkflowRunResult was widened (GAP-3).
        // WHY soft handling (log-only, not assertNever): dispatch() is fire-and-forget and this
        // result is observed only in logs; there is no parent LLM that acts on it. Contrast with
        // makeSpawnAgentTool, which uses assertNever because delivery_failed would otherwise
        // silently corrupt the parent session's outcome if it ever reached that boundary.
        console.log(
          `[TriggerRouter] Dispatch delivery failed: workflowId=${workflowTrigger.workflowId} ` +
            `stopReason=${result.stopReason} deliveryError=${result.deliveryError}`,
        );
      } else if (result._tag === 'timeout') {
        console.log(
          `[TriggerRouter] Dispatch timed out: workflowId=${workflowTrigger.workflowId} ` +
          `reason=${result.reason} message=${result.message}`,
        );
      } else if (result._tag === 'error') {
        console.log(
          `[TriggerRouter] Dispatch failed: workflowId=${workflowTrigger.workflowId} ` +
            `error=${result.message} stopReason=${result.stopReason}`,
        );
      } else if (result._tag === 'stuck') {
        console.log(
          `[TriggerRouter] Dispatch stuck: workflowId=${workflowTrigger.workflowId} ` +
          `reason=${result.reason} message=${result.message}`,
          // TODO(follow-up): add onStuck: trigger hook support here
        );
      } else {
        // Compile-time exhaustiveness guard. If WorkflowRunResult gains a new variant
        // this will fail to compile, forcing the developer to handle the new case.
        // At runtime this is unreachable -- all current variants are handled above.
        assertNever(result);
      }
      // User notifications: fire after logging.
      // Fire-and-forget -- notify() returns void and swallows all errors.
      this.notificationService?.notify(result, workflowTrigger.goal);

      // NOTE: delivery is not run for console-dispatched workflows because WorkflowTrigger
      // does not carry autoCommit/autoOpenPR flags (those live on TriggerDefinition, keyed
      // by triggerId). The dispatch() path does not have a triggerId to look up the definition.
      // TODO(follow-up): accept an optional triggerId in dispatch() to enable delivery here.
    });
    return workflowTrigger.workflowId;
  }

  /**
   * List all triggers currently loaded in the router index.
   *
   * Used by the console AUTO triggers endpoint (GET /api/v2/triggers).
   * Returns a snapshot of the trigger index at call time -- does not reflect
   * any in-flight reloads (triggers don't reload in MVP).
   */
  listTriggers(): readonly TriggerDefinition[] {
    return [...this.index.values()];
  }

  /**
   * Dispatch the adaptive pipeline coordinator in-process (Option B).
   *
   * Called by the GitHub issue queue poller when a task candidate arrives.
   * Calls runAdaptivePipeline() directly as a function call in the same process.
   * No separate workflow session is spawned for routing.
   *
   * WHY Option B (in-process) over Option A (dispatch session):
   * - The coordinator is a TypeScript script, not a workflow session definition.
   * - In-process call avoids the session indirection and is directly testable.
   * - Same approach as the CLI entry point (both call runAdaptivePipeline directly).
   * (Pitch invariant 9: "The poller owns the process; the coordinator is a function call.")
   *
   * Deps precedence: caller-provided params (3rd/4th positional args) override the stored
   * constructor-injected fields. When neither is present, logs a warning and returns an
   * escalated outcome (does NOT throw).
   *
   * @param goal - The task goal string from the incoming queue event
   * @param workspace - Absolute path to the workspace
   * @param context - Optional task context (taskCandidate from queue poller)
   * @param coordinatorDeps - Optional caller override; falls back to constructor-injected deps
   * @param modeExecutors - Optional caller override; falls back to constructor-injected executors
   * @returns The PipelineOutcome (merged, escalated, or dry_run)
   */
  async dispatchAdaptivePipeline(
    goal: string,
    workspace: string,
    context?: Readonly<Record<string, unknown>>,
    coordinatorDeps?: AdaptiveCoordinatorDeps,
    modeExecutors?: ModeExecutors,
  ): ReturnType<typeof runAdaptivePipeline> {
    // Resolve effective deps: caller-provided overrides stored fields.
    const effectiveDeps = coordinatorDeps ?? this._coordinatorDeps;
    const effectiveExecutors = modeExecutors ?? this._modeExecutors;

    if (effectiveDeps === undefined || effectiveExecutors === undefined) {
      console.warn(
        '[TriggerRouter] dispatchAdaptivePipeline called but coordinatorDeps not injected -- ' +
        'adaptive dispatch disabled. Inject coordinatorDeps and modeExecutors in the ' +
        'TriggerRouter constructor to activate. Returning escalated outcome.',
      );
      return {
        kind: 'escalated',
        escalationReason: {
          phase: 'dispatch',
          reason: 'coordinatorDeps or modeExecutors not injected into TriggerRouter',
        },
      };
    }

    // Deduplication guard: prevent duplicate adaptive pipeline sessions from
    // rapid-fire webhook retries or daemon restarts.
    //
    // WHY here (after deps check, not before): we only want to record timestamps
    // for calls that would actually dispatch -- calls that fail the deps check are
    // already guarded above and should not consume a deduplication window slot.
    //
    // WHY 'escalated' as the return kind: PipelineOutcome has no 'skipped' variant.
    // Using 'escalated' is slightly semantically impure, but it is the established
    // early-exit pattern in this method (see deps guard above). Callers are
    // fire-and-forget and do not branch on outcome.kind, so the impurity is harmless.
    // A 'skipped' variant would require widening PipelineOutcome, which is scope creep.
    const dedupeKey = `${goal}::${workspace}`;
    const now = Date.now();

    // Cleanup-on-entry: purge stale entries before checking/inserting.
    // WHY cleanup-on-entry (not a background timer): avoids async state, keeps the
    // implementation deterministic and trivially testable with vi.useFakeTimers().
    for (const [key, ts] of this._recentAdaptiveDispatches) {
      if (now - ts >= TriggerRouter.ADAPTIVE_DEDUPE_TTL_MS) {
        this._recentAdaptiveDispatches.delete(key);
      }
    }

    const lastDispatch = this._recentAdaptiveDispatches.get(dedupeKey);
    if (lastDispatch !== undefined && now - lastDispatch < TriggerRouter.ADAPTIVE_DEDUPE_TTL_MS) {
      console.log(
        `[TriggerRouter] Skipping duplicate adaptive dispatch: goal="${goal.slice(0, 60)}" ` +
        `(already dispatched within 30s)`,
      );
      return {
        kind: 'escalated',
        escalationReason: {
          phase: 'dispatch',
          reason: 'duplicate adaptive dispatch within 30s window',
        },
      };
    }

    this._recentAdaptiveDispatches.set(dedupeKey, now);

    const opts: AdaptivePipelineOpts = {
      goal,
      workspace,
      taskCandidate: context,
    };

    return runAdaptivePipeline(effectiveDeps, opts, effectiveExecutors);
  }
}
