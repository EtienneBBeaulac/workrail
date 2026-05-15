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
import type { WorkflowTrigger, WorkflowRunResult, WorkflowDeliveryFailed, SessionSource } from '../daemon/types.js';
import type { ActiveSessionSet } from '../daemon/active-sessions.js';
import { assertNever } from '../runtime/assert-never.js';
import type { V2ToolContext } from '../mcp/types.js';
import { KeyedAsyncQueue } from '../v2/infra/in-memory/keyed-async-queue/index.js';
import { post as deliveryPost } from './delivery-client.js';
import type {
  TriggerDefinition,
  WebhookEvent,
  ContextMappingEntry,
} from './types.js';
import type { ExecFn } from './delivery-action.js';
import { runDeliveryPipeline, DEFAULT_DELIVERY_PIPELINE } from './delivery-pipeline.js';
import type { DaemonEventEmitter } from '../daemon/daemon-events.js';
import type { NotificationService } from './notification-service.js';
import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts, ModeExecutors } from '../coordinators/adaptive-pipeline.js';
import { runAdaptivePipeline } from '../coordinators/adaptive-pipeline.js';
import { DispatchDeduplicator } from './dispatch-deduplicator.js';
import { evaluateGate, DEFAULT_GATE_EVAL_TIMEOUT_MS, DEFAULT_GATE_EVALUATOR_WORKFLOW_ID } from '../coordinators/gate-evaluator-dispatcher.js';
import { resumeFromGate } from '../daemon/gate-resume.js';
import type { ReviewApprovalAdapter } from './review-approval-adapter.js';
import { GitHubReviewApprovalAdapter } from './review-approval-adapter.js';
import { parseReviewVerdictArtifact } from '../v2/durable-core/schemas/artifacts/review-verdict.js';
import { PendingDraftReviewPoller, writePendingDraftSidecar } from './pending-draft-review-poller.js';
import { randomUUID } from 'node:crypto';

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
  | { readonly kind: 'payload_error'; readonly message: string }
  | {
      readonly kind: 'queue_full';
      readonly triggerId: string;
      readonly queueDepth: number;
      readonly maxQueueDepth: number;
      /**
       * Suggested Retry-After value in seconds.
       *
       * WHY computed in route() (not in the listener): route() has access to the
       * trigger definition where maxSessionMinutes lives. The listener only receives
       * the RouteResult -- it does not re-look up the trigger.
       *
       * Value: (agentConfig.maxSessionMinutes ?? 30) * 60. This is an approximation
       * of the worst-case drain time for a single session slot. It is advisory only.
       */
      readonly retryAfterSeconds: number;
    };

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
  activeSessionSet?: ActiveSessionSet,
  _statsDir?: string,
  _sessionsDir?: string,
  source?: SessionSource,
  enricherDeps?: import('../daemon/workflow-enricher.js').WorkflowEnricherDeps,
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
 * Delegates to runDeliveryPipeline() with DEFAULT_DELIVERY_PIPELINE after validating
 * the three preconditions that must hold for delivery to proceed.
 *
 * All errors are logged and discarded -- delivery is best-effort and must never affect
 * the workflow's success/failure state.
 *
 * WHY module-level function (not class method): pure helper shared by route() and
 * dispatch() without coupling to TriggerRouter's private state. Delivery logic
 * belongs in delivery-pipeline.ts; this is just the wiring.
 *
 * @param triggerId - Used in log messages for traceability
 * @param trigger - Source of workspacePath, autoCommit, autoOpenPR flags
 * @param result - WorkflowRunResult; only called when _tag === 'success'
 * @param execFn - Injectable exec function (production: execFileAsync; tests: fake)
 */
/**
 * Run post-workflow review actions when reviewerIdentity is configured.
 *
 * Fires only on success with a valid wr.review_verdict artifact.
 * Creates a PENDING GitHub/GitLab draft review under the operator's identity.
 * The PendingDraftReviewPoller (PR3) is wired in here once implemented.
 *
 * WHY separate from maybeRunDelivery: different gate conditions (no autoCommit
 * required, different artifact source), different side effects (GitHub API call,
 * not git commit). These are independent post-workflow action pathways.
 *
 * WHY receives originalResult: same as maybeRunDelivery -- prevents callbackUrl
 * delivery_failed reassignment from suppressing review posting on a succeeded session.
 *
 * WHY fire-and-forget for the poller (future PR3): the poller is long-running
 * (polls until operator publishes, could take hours). Awaiting it would hold the
 * queue slot. Same pattern as gate evaluation: void (async () => { ... })().
 */
async function maybeRunPostWorkflowActions(
  workflowTrigger: WorkflowTrigger,
  originalResult: WorkflowRunResult,
  reviewApprovalAdapter: ReviewApprovalAdapter,
  notificationService?: NotificationService,
  ctx?: V2ToolContext,
  triggerId?: string,
): Promise<void> {
  if (originalResult._tag !== 'success') return;
  if (!workflowTrigger.reviewerIdentity) return;

  const { reviewerIdentity } = workflowTrigger;

  // Find wr.review_verdict artifact.
  const artifacts = originalResult.lastStepArtifacts;
  if (!artifacts || artifacts.length === 0) {
    console.warn(
      `[TriggerRouter] Post-workflow review action skipped: workflowId=${workflowTrigger.workflowId} -- ` +
      `lastStepArtifacts is absent or empty. Ensure wr.mr-review emits wr.review_verdict on the final step.`,
    );
    return;
  }

  let reviewVerdict: ReturnType<typeof parseReviewVerdictArtifact> = null;
  for (const artifact of artifacts) {
    reviewVerdict = parseReviewVerdictArtifact(artifact);
    if (reviewVerdict !== null) break;
  }

  if (reviewVerdict === null) {
    console.warn(
      `[TriggerRouter] Post-workflow review action skipped: workflowId=${workflowTrigger.workflowId} -- ` +
      `lastStepArtifacts present but no valid wr.review_verdict found. ` +
      `Artifacts: ${artifacts.map((a) => (typeof a === 'object' && a !== null ? (a as Record<string, unknown>)['kind'] : 'unknown')).join(', ')}`,
    );
    return;
  }

  // Extract PR number and repo from context (injected by github_prs_poll polling adapter).
  const triggerCtx = workflowTrigger.context as Record<string, unknown> | undefined;
  const prNumber = typeof triggerCtx?.['itemNumber'] === 'number' ? triggerCtx['itemNumber'] : undefined;
  const prUrl = typeof triggerCtx?.['itemUrl'] === 'string' ? triggerCtx['itemUrl'] : undefined;

  if (prNumber === undefined || prUrl === undefined) {
    console.warn(
      `[TriggerRouter] Post-workflow review action skipped: workflowId=${workflowTrigger.workflowId} -- ` +
      `context missing itemNumber or itemUrl (required for draft review creation). ` +
      `Ensure the trigger uses github_prs_poll with reviewer context injection.`,
    );
    return;
  }

  // Derive prRepo from the URL: "https://github.com/owner/repo/pull/N" -> "owner/repo"
  let prRepo: string | undefined;
  try {
    const url = new URL(prUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) prRepo = `${parts[0]}/${parts[1]}`;
  } catch { /* invalid URL */ }

  if (!prRepo) {
    console.warn(
      `[TriggerRouter] Post-workflow review action skipped: workflowId=${workflowTrigger.workflowId} -- ` +
      `could not derive prRepo from prUrl="${prUrl}"`,
    );
    return;
  }

  const createResult = await reviewApprovalAdapter.createDraftReview({
    prNumber,
    prRepo,
    token: reviewerIdentity.token,
    login: reviewerIdentity.login,
    findings: reviewVerdict.findings,
    prUrl,
  });

  if (createResult.kind === 'err') {
    console.error(
      `[TriggerRouter] Draft review creation failed: workflowId=${workflowTrigger.workflowId} ` +
      `prRepo=${prRepo} prNumber=${prNumber} error=${createResult.error.message}`,
    );
    return;
  }

  const { reviewId, reused } = createResult.value;
  console.log(
    `[TriggerRouter] Draft review ${reused ? 'reused' : 'created'}: workflowId=${workflowTrigger.workflowId} ` +
    `prRepo=${prRepo} prNumber=${prNumber} reviewId=${reviewId}`,
  );

  // Write pending-draft sidecar BEFORE starting the poller (crash recovery invariant).
  const daemonSessionId = originalResult.sessionId ?? randomUUID();
  const workrailSessionId = originalResult.sessionWorkspacePath
    ? '' // session ID not directly available here; use empty string if absent
    : '';
  // Prefer the workrail session ID from the result if available.
  // WorkflowRunSuccess.lastStepArtifacts carries the session context but not the session ID.
  // The sidecar only needs it for the session event log write-back; we skip the event if absent.
  const resolvedWorkrailSessionId = (originalResult as { workrailSessionId?: string }).workrailSessionId ?? '';

  if (ctx?.v2 && resolvedWorkrailSessionId) {
    try {
      await writePendingDraftSidecar({
        reviewId,
        prNumber,
        prRepo,
        daemonSessionId,
        workrailSessionId: resolvedWorkrailSessionId,
        token: reviewerIdentity.token,
        login: reviewerIdentity.login,
        createdAt: new Date().toISOString(),
        triggerId: triggerId ?? '',
      });
    } catch (e: unknown) {
      console.warn(
        `[TriggerRouter] Failed to write pending-draft sidecar: ` +
        `${e instanceof Error ? e.message : String(e)}`,
      );
      // Non-fatal: poller still starts; crash recovery won't work but review still posts.
    }

    // Start PendingDraftReviewPoller as a fire-and-forget background task.
    // WHY fire-and-forget: poller runs until operator publishes (could be hours).
    // Awaiting it would hold the queue callback slot. Same pattern as gate evaluation.
    const poller = new PendingDraftReviewPoller(reviewApprovalAdapter, {
      prNumber,
      prRepo,
      reviewId,
      token: reviewerIdentity.token,
      login: reviewerIdentity.login,
      workrailSessionId: resolvedWorkrailSessionId,
      daemonSessionId,
      sessionStore: ctx.v2.sessionStore,
      gate: ctx.v2.gate,
      mintEventId: ctx.v2.idFactory.mintEventId.bind(ctx.v2.idFactory),
      onSubmitted: (submittedAt) => {
        console.log(
          `[TriggerRouter] Review published by operator: workflowId=${workflowTrigger.workflowId} ` +
          `prRepo=${prRepo} prNumber=${prNumber} submittedAt=${submittedAt}`,
        );
      },
    });
    poller.start();
  }

  // Notify operator that draft is ready.
  notificationService?.notify(originalResult, `WorkTrain review draft ready on PR #${prNumber} -- open in GitHub to review findings`);
}

async function maybeRunDelivery(
  triggerId: string,
  trigger: TriggerDefinition,
  result: WorkflowRunResult,
  execFn: ExecFn,
  deps?: import('./delivery-pipeline.js').DeliveryPipelineDeps,
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

  await runDeliveryPipeline(DEFAULT_DELIVERY_PIPELINE, result, trigger, execFn, triggerId, deps);
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
  private readonly _activeSessionSet: ActiveSessionSet | undefined;
  private _coordinatorDeps: AdaptiveCoordinatorDeps | undefined;
  private readonly _modeExecutors: ModeExecutors | undefined;
  private readonly _reviewApprovalAdapter: ReviewApprovalAdapter;

  /**
   * Recent adaptive dispatch timestamps keyed by a path-specific dedup key.
   *
   * Key format differs by dispatch path:
   * - route() and dispatch(): `${workflowId}::${goal}::${workspace}`
   * - dispatchAdaptivePipeline(): `${goal}::${workspace}`
   *
   * Cross-path suppression only applies when both paths produce the same key
   * (i.e. when workflowId is absent from one path's key).
   *
   * WHY Map<string, number> (not a Set): we need the timestamp to implement
   * a TTL-based sliding window. A Set can only answer "was this dispatched?",
   * not "was this dispatched within the last N milliseconds?".
   *
   * WHY cleanup-on-entry (not a background timer): a timer would introduce
   * async state that conflicts with the determinism principle and complicates
   * testing. Cleanup-on-entry is O(n) per dispatch call, bounded by the
   * number of unique keys dispatched in the last 30s -- always a small number
   * in practice.
   *
   * Shared across route(), dispatch(), and dispatchAdaptivePipeline().
   * The compile-time dependency on DispatchDeduplicator ensures new dispatch
   * methods cannot bypass dedup by omission -- they must call the injected
   * instance to compile.
   *
   * @see DispatchDeduplicator
   * @see ADAPTIVE_DEDUPE_TTL_MS
   */
  private readonly _deduplicator: DispatchDeduplicator;

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
     * Optional active session set for steer injection and graceful shutdown.
     * Replaces the former SteerRegistry + AbortRegistry pair.
     * When absent, steer endpoint returns 404 and SIGTERM does not abort sessions.
     */
    activeSessionSet?: ActiveSessionSet,
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
    /**
     * Optional deduplicator for dispatch dedup guard.
     * When absent, defaults to a new DispatchDeduplicator with ADAPTIVE_DEDUPE_TTL_MS.
     * Inject in tests to control TTL or observe dedup behavior.
     */
    deduplicator?: DispatchDeduplicator,
    /**
     * Optional ReviewApprovalAdapter for creating draft reviews after review sessions.
     * Defaults to GitHubReviewApprovalAdapter in production.
     * Inject a fake in tests to avoid real GitHub API calls.
     */
    reviewApprovalAdapter?: ReviewApprovalAdapter,
  ) {
    this.execFn = execFn ?? execFileAsync;
    this.emitter = emitter;
    this.notificationService = notificationService;
    this._activeSessionSet = activeSessionSet;
    this._coordinatorDeps = coordinatorDeps;
    this._modeExecutors = modeExecutors;
    this._deduplicator = deduplicator ?? new DispatchDeduplicator(TriggerRouter.ADAPTIVE_DEDUPE_TTL_MS);
    this._reviewApprovalAdapter = reviewApprovalAdapter ?? new GitHubReviewApprovalAdapter();
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

  /**
   * Bind coordinator deps after construction.
   *
   * Called at the composition root (startTriggerListener) after createCoordinatorDeps()
   * has been built with this router's dispatch function. Symmetric to how CoordinatorDepsImpl
   * previously used setDispatch() on the coords side -- but this direction eliminates the
   * nullable dispatch field on CoordinatorDepsImpl, making dispatch a required constructor
   * parameter there.
   *
   * WHY mutable (not constructor parameter): coordinatorDeps requires router.dispatch, and
   * router requires coordinatorDeps as a constructor arg for dispatchAdaptivePipeline wiring.
   * One side must hold the setter. Moving it here makes CoordinatorDepsImpl's dispatch
   * required and non-nullable -- the illegal state is unrepresentable on that side.
   */
  setCoordinatorDeps(deps: AdaptiveCoordinatorDeps): void {
    if (this._coordinatorDeps !== undefined) {
      process.stderr.write('[WARN TriggerRouter] setCoordinatorDeps() called more than once -- ignoring reassignment\n');
      return;
    }
    this._coordinatorDeps = deps;
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

    // Queue depth guard: reject before accepting if the per-trigger serialization queue
    // is at capacity. Only applies to serial-mode triggers -- parallel triggers use a
    // unique UUID queue key per invocation, so depth() always returns 0 for any given key.
    //
    // WHY here (after dispatchCondition, before workflowTrigger): the depth check must
    // happen BEFORE the 202 response is sent (the listener sends 202 only on _tag: 'enqueued').
    // route() must return synchronously, and the depth read is synchronous. JavaScript is
    // single-threaded, so no race can occur between the depth read and the enqueue() call.
    //
    // WHY default 10 at use time (not at parse time): trigger-store.ts leaves maxQueueDepth
    // undefined when absent so validateTriggerStrict can emit the 'missing-max-queue-depth'
    // advisory distinguishing "not set" from "explicitly set to 10".
    if (trigger.concurrencyMode !== 'parallel') {
      const maxDepth = trigger.maxQueueDepth ?? 10;
      const currentDepth = this.queue.depth(trigger.id);
      if (currentDepth >= maxDepth) {
        const retryAfterSeconds = (trigger.agentConfig?.maxSessionMinutes ?? 30) * 60;
        this.emitter?.emit({
          kind: 'session_dropped',
          triggerId: trigger.id,
          workflowId: trigger.workflowId,
          reason: 'queue_full',
          queueDepth: currentDepth,
          maxQueueDepth: maxDepth,
        });
        return {
          _tag: 'error',
          error: {
            kind: 'queue_full',
            triggerId: trigger.id,
            queueDepth: currentDepth,
            maxQueueDepth: maxDepth,
            retryAfterSeconds,
          },
        };
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
      // Reviewer identity forwarded to WorkflowTrigger so maybeRunPostWorkflowActions()
      // can access it from the dispatch() path (which receives WorkflowTrigger, not TriggerDefinition).
      ...(trigger.reviewerIdentity !== undefined ? { reviewerIdentity: trigger.reviewerIdentity } : {}),
    };

    // Deduplicate: if the same goal+workspace was dispatched within 30s, skip.
    // WHY here (after workflowTrigger construction, before emitter.emit):
    // - The goal must be fully resolved (goalTemplate interpolation happens above).
    // - No trigger_fired event is emitted for deduped dispatches -- consistent with
    //   the dispatchCondition guard which also returns before the emitter call.
    // WHY shared deduplicator: prevents duplicate dispatches within the same 30s window.
    // Key format differs by path: route/dispatch use workflowId::goal::workspace;
    // dispatchAdaptivePipeline uses goal::workspace.
    // Cross-path suppression only applies when both paths produce the same key.
    {
      const dedupeKey = `${workflowTrigger.workflowId}::${workflowTrigger.goal}::${workflowTrigger.workspacePath}`;
      if (this._deduplicator.checkAndRecord(dedupeKey)) {
        console.log(`[TriggerRouter] Skipping duplicate route dispatch: workflowId=${workflowTrigger.workflowId} goal="${workflowTrigger.goal.slice(0, 60)}" (already dispatched within 30s)`);
        return { _tag: 'enqueued', triggerId: trigger.id };
      }
    }

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
        result = await this.runWorkflowFn(workflowTrigger, this.ctx, this.apiKey, undefined, this.emitter, this._activeSessionSet);
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
      } else if (result._tag === 'gate_parked') {
        // Session parked at a requireConfirmation gate. Route based on gateKind:
        // - coordinator_eval: spawn wr.gate-eval-generic (existing autonomous path)
        // - human_approval: skip evaluator, go directly to maybeRunPostWorkflowActions
        //   (operator publishes the GitHub draft review -- that IS the gate verdict)
        // WHY switch not if-chain: assertNever enforces exhaustiveness at compile time.
        // Adding a new GateKind without updating this switch is a build error.
        const sessionId = result.sessionId;
        const stepId = result.stepId;
        const gateKind = result.gateKind;
        console.log(
          `[TriggerRouter] Workflow parked at gate: triggerId=${trigger.id} ` +
          `workflowId=${trigger.workflowId} stepId=${stepId} sessionId=${sessionId} gateKind=${gateKind}`,
        );

        switch (gateKind) {
          case 'coordinator_eval': {
            if (sessionId && this._coordinatorDeps) {
              const deps = this._coordinatorDeps;
              const ctx = this.ctx;
              const apiKey = this.apiKey;
              const activeSessionSet = this._activeSessionSet;
              const emitter = this.emitter;

              void (async () => {
                try {
                  const gateWorkrailSessionId = result.workrailSessionId;
                  const artifactContext = {
                    stepId,
                    workflowId: workflowTrigger.workflowId,
                    goal: workflowTrigger.goal,
                  };
                  const verdict = await evaluateGate(
                    {
                      spawnSession: (wfId, goal, workspace, context, agentConfig) =>
                        deps.spawnSession(wfId, goal, workspace, context, agentConfig),
                      awaitSessions: (handles, timeoutMs) => deps.awaitSessions(handles, timeoutMs),
                      getAgentResult: (handle) => deps.getAgentResult(handle),
                      stderr: (line) => process.stderr.write(line + '\n'),
                      readStepOutput: (wrSessionId) => deps.getAgentResult(wrSessionId),
                    },
                    artifactContext,
                    DEFAULT_GATE_EVALUATOR_WORKFLOW_ID,
                    workflowTrigger.workspacePath,
                    stepId,
                    gateWorkrailSessionId,
                    undefined,
                    DEFAULT_GATE_EVAL_TIMEOUT_MS,
                  );
                  if (verdict.verdict === 'uncertain') {
                    await deps.postToOutbox(
                      `Gate evaluation uncertain for step '${stepId}' in session ${sessionId}. ` +
                      `Reason: ${verdict.rationale}`,
                      { sessionId, stepId, workflowId: workflowTrigger.workflowId, verdict: verdict.verdict, confidence: verdict.confidence },
                    );
                  }
                  const resumeResult = await resumeFromGate(
                    sessionId, verdict, ctx, apiKey, this.runWorkflowFn, undefined, emitter, activeSessionSet,
                  );
                  if (resumeResult.kind === 'err') {
                    console.warn(`[TriggerRouter] Gate resume failed for session ${sessionId}: ${resumeResult.error.message}`);
                    await deps.postToOutbox(
                      `Gate session ${sessionId} could not be resumed: ${resumeResult.error.message}`,
                      { sessionId, stepId, workflowId: workflowTrigger.workflowId, error: resumeResult.error.kind },
                    );
                  } else {
                    console.log(`[TriggerRouter] Gate resumed: triggerId=${trigger.id} sessionId=${sessionId} verdict=${verdict.verdict}`);
                  }
                } catch (e) {
                  console.error(`[TriggerRouter] Gate evaluation threw for session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
                }
              })();
            } else {
              console.warn(
                `[TriggerRouter] coordinator_eval gate parked but coordinatorDeps not available -- cannot evaluate. ` +
                `workflowId=${trigger.workflowId} sessionId=${sessionId}`,
              );
            }
            break;
          }
          case 'human_approval': {
            // Human approval gate: the operator is the evaluator. Skip wr.gate-eval-generic.
            // Read the session's wr.review_verdict artifacts and create the GitHub draft review.
            // The operator publishing the draft IS the gate verdict.
            // WHY fire-and-forget: draft creation + poller are long-running.
            // WHY originalResult as success: build a synthetic success result so
            // maybeRunPostWorkflowActions can read lastStepArtifacts.
            // The session artifacts are read from the session store via workrailSessionId.
            const workrailSessionId = result.workrailSessionId;
            if (workrailSessionId && this.ctx.v2) {
              const sessionStore = this.ctx.v2.sessionStore;
              void (async () => {
                try {
                  // Read artifacts from the session store.
                  const loadResult = await sessionStore.loadValidatedPrefix(workrailSessionId);
                  if (loadResult.isErr()) {
                    console.warn(`[TriggerRouter] human_approval gate: could not load session ${String(workrailSessionId)}: ${loadResult.error.message}`);
                    return;
                  }
                  const { projectArtifactsV2 } = await import('../v2/projections/artifacts.js');
                  const { asSortedEventLog } = await import('../v2/durable-core/sorted-event-log.js');
                  const sortedResult = asSortedEventLog(loadResult.value.truth.events);
                  if (sortedResult.isErr()) return;
                  const artifactsRes = projectArtifactsV2(sortedResult.value);
                  const lastStepArtifacts: unknown[] = [];
                  if (artifactsRes.isOk()) {
                    for (const nodeArtifacts of Object.values(artifactsRes.value.byNodeId)) {
                      for (const a of nodeArtifacts.artifacts) { lastStepArtifacts.push(a.content); }
                    }
                  }
                  const syntheticSuccess: import('../daemon/types.js').WorkflowRunSuccess = {
                    _tag: 'success',
                    workflowId: workflowTrigger.workflowId,
                    stopReason: 'gate_human_approval',
                    lastStepArtifacts,
                    sessionId: result.sessionId as import('../daemon/daemon-events.js').RunId,
                  };
                  await maybeRunPostWorkflowActions(
                    workflowTrigger,
                    syntheticSuccess,
                    this._reviewApprovalAdapter,
                    this.notificationService,
                    this.ctx,
                    trigger.id,
                  );
                } catch (e) {
                  console.error(`[TriggerRouter] human_approval gate action threw for session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
                }
              })();
            } else {
              // workrailSessionId should always be set for daemon sessions -- this is a defensive
              // fallback. Post to outbox so the operator has an observable signal.
              console.warn(
                `[TriggerRouter] human_approval gate: workrailSessionId or ctx.v2 unavailable. ` +
                `workflowId=${trigger.workflowId} sessionId=${sessionId}`,
              );
              if (this._coordinatorDeps) {
                void this._coordinatorDeps.postToOutbox(
                  `human_approval gate session ${sessionId} could not create draft review: workrailSessionId or ctx.v2 unavailable.`,
                  { sessionId, stepId, workflowId: workflowTrigger.workflowId },
                );
              }
            }
            break;
          }
          default:
            assertNever(gateKind);
        }
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
      const deliveryDeps = this.ctx.v2
        ? { gate: this.ctx.v2.gate, sessionStore: this.ctx.v2.sessionStore, idFactory: this.ctx.v2.idFactory }
        : undefined;
      await maybeRunDelivery(trigger.id, trigger, originalResult, this.execFn, deliveryDeps);

      // Post-workflow review actions: create a PENDING draft review when reviewerIdentity is set.
      // Uses workflowTrigger (which carries reviewerIdentity forwarded from TriggerDefinition).
      // Uses originalResult to avoid callbackUrl delivery_failed suppressing review posting.
      await maybeRunPostWorkflowActions(workflowTrigger, originalResult, this._reviewApprovalAdapter, this.notificationService, this.ctx, trigger.id);
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
  dispatch(workflowTrigger: WorkflowTrigger, source?: SessionSource): string {
    // Pre-allocated session: executeStartWorkflow already created the session in the store.
    // Deduplication must not apply here -- dropping this dispatch would zombie the session.
    // A pre_allocated SessionSource is authoritative evidence that the caller explicitly
    // intends to start this session. Skip the dedup block entirely.
    if (source?.kind !== 'pre_allocated') {
      // Deduplicate: if the same goal+workspace was dispatched within 30s, skip.
      // WHY shared deduplicator: prevents duplicate dispatches within the same 30s window.
      // Key format differs by path: route/dispatch use workflowId::goal::workspace;
      // dispatchAdaptivePipeline uses goal::workspace.
      // Cross-path suppression only applies when both paths produce the same key.
      const dedupeKey = `${workflowTrigger.workflowId}::${workflowTrigger.goal}::${workflowTrigger.workspacePath}`;
      if (this._deduplicator.checkAndRecord(dedupeKey)) {
        console.log(`[TriggerRouter] Skipping duplicate dispatch: workflowId=${workflowTrigger.workflowId} goal="${workflowTrigger.goal.slice(0, 60)}" (already dispatched within 30s)`);
        return workflowTrigger.workflowId;
      }
    } else {
      console.log(`[TriggerRouter] Pre-allocated session dispatched: workflowId=${workflowTrigger.workflowId} goal="${workflowTrigger.goal.slice(0, 60)}"`);
    }

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
        result = await this.runWorkflowFn(workflowTrigger, this.ctx, this.apiKey, undefined, this.emitter, this._activeSessionSet, undefined, undefined, source);
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
      } else if (result._tag === 'gate_parked') {
        const sessionId = result.sessionId;
        const stepId = result.stepId;
        const gateKind = result.gateKind;
        console.log(
          `[TriggerRouter] Dispatch parked at gate: workflowId=${workflowTrigger.workflowId} ` +
          `stepId=${stepId} sessionId=${sessionId} gateKind=${gateKind}`,
        );
        switch (gateKind) {
          case 'coordinator_eval': {
            if (sessionId && this._coordinatorDeps) {
              const deps = this._coordinatorDeps;
              const ctx = this.ctx;
              const apiKey = this.apiKey;
              const activeSessionSet = this._activeSessionSet;
              const emitter = this.emitter;
              void (async () => {
                try {
                  const gateWorkrailSessionId = result.workrailSessionId;
                  const artifactContext = { stepId, workflowId: workflowTrigger.workflowId, goal: workflowTrigger.goal };
                  const verdict = await evaluateGate(
                    {
                      spawnSession: (wfId, goal, workspace, context, agentConfig) =>
                        deps.spawnSession(wfId, goal, workspace, context, agentConfig),
                      awaitSessions: (handles, timeoutMs) => deps.awaitSessions(handles, timeoutMs),
                      getAgentResult: (handle) => deps.getAgentResult(handle),
                      stderr: (line) => process.stderr.write(line + '\n'),
                      readStepOutput: (wrSessionId) => deps.getAgentResult(wrSessionId),
                    },
                    artifactContext,
                    DEFAULT_GATE_EVALUATOR_WORKFLOW_ID,
                    workflowTrigger.workspacePath,
                    stepId,
                    gateWorkrailSessionId,
                    undefined,
                    DEFAULT_GATE_EVAL_TIMEOUT_MS,
                  );
                  if (verdict.verdict === 'uncertain') {
                    await deps.postToOutbox(
                      `Gate evaluation uncertain for step '${stepId}' in session ${sessionId}. Reason: ${verdict.rationale}`,
                      { sessionId, stepId, workflowId: workflowTrigger.workflowId, verdict: verdict.verdict, confidence: verdict.confidence },
                    );
                  }
                  const resumeResult = await resumeFromGate(sessionId, verdict, ctx, apiKey, this.runWorkflowFn, undefined, emitter, activeSessionSet);
                  if (resumeResult.kind === 'err') {
                    console.warn(`[TriggerRouter] Dispatch gate resume failed for session ${sessionId}: ${resumeResult.error.message}`);
                    await deps.postToOutbox(
                      `Gate session ${sessionId} could not be resumed: ${resumeResult.error.message}`,
                      { sessionId, stepId, workflowId: workflowTrigger.workflowId, error: resumeResult.error.kind },
                    );
                  } else {
                    console.log(`[TriggerRouter] Dispatch gate resumed: sessionId=${sessionId} verdict=${verdict.verdict}`);
                  }
                } catch (e) {
                  console.error(`[TriggerRouter] Dispatch gate evaluation threw: ${e instanceof Error ? e.message : String(e)}`);
                }
              })();
            }
            break;
          }
          case 'human_approval': {
            const workrailSessionId = result.workrailSessionId;
            if (workrailSessionId && this.ctx.v2) {
              const sessionStore = this.ctx.v2.sessionStore;
              void (async () => {
                try {
                  const loadResult = await sessionStore.loadValidatedPrefix(workrailSessionId);
                  if (loadResult.isErr()) return;
                  const { projectArtifactsV2 } = await import('../v2/projections/artifacts.js');
                  const { asSortedEventLog } = await import('../v2/durable-core/sorted-event-log.js');
                  const sortedResult = asSortedEventLog(loadResult.value.truth.events);
                  if (sortedResult.isErr()) return;
                  const artifactsRes = projectArtifactsV2(sortedResult.value);
                  const lastStepArtifacts: unknown[] = [];
                  if (artifactsRes.isOk()) {
                    for (const nodeArtifacts of Object.values(artifactsRes.value.byNodeId)) {
                      for (const a of nodeArtifacts.artifacts) {
                        lastStepArtifacts.push(a.content);
                      }
                    }
                  }
                  const syntheticSuccess: import('../daemon/types.js').WorkflowRunSuccess = {
                    _tag: 'success',
                    workflowId: workflowTrigger.workflowId,
                    stopReason: 'gate_human_approval',
                    lastStepArtifacts,
                    sessionId: result.sessionId as import('../daemon/daemon-events.js').RunId,
                  };
                  await maybeRunPostWorkflowActions(workflowTrigger, syntheticSuccess, this._reviewApprovalAdapter, this.notificationService, this.ctx);
                } catch (e) {
                  console.error(`[TriggerRouter] Dispatch human_approval gate threw: ${e instanceof Error ? e.message : String(e)}`);
                }
              })();
            }
            break;
          }
          default:
            assertNever(gateKind);
        }
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

      // Post-workflow review actions: create a PENDING draft review when reviewerIdentity is set.
      // reviewerIdentity is forwarded from TriggerDefinition onto WorkflowTrigger so this path
      // can access it without a triggerId lookup.
      await maybeRunPostWorkflowActions(workflowTrigger, result, this._reviewApprovalAdapter, this.notificationService, this.ctx);
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
    if (this._deduplicator.checkAndRecord(dedupeKey)) {
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

    const opts: AdaptivePipelineOpts = {
      goal,
      workspace,
      taskCandidate: context,
    };

    return runAdaptivePipeline(effectiveDeps, opts, effectiveExecutors);
  }
}
