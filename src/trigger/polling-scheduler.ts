/**
 * WorkRail Auto: Polling Scheduler
 *
 * Manages polling loops for all polling triggers (gitlab_poll, github_issues_poll,
 * github_prs_poll) in the trigger index. Calls TriggerRouter.dispatch() for each
 * new event detected.
 *
 * Design notes:
 * - One setInterval per polling trigger. Each interval runs independently.
 * - Skip-cycle guard: if a poll is still running when the next interval fires,
 *   the cycle is skipped and a warning is logged. This prevents concurrent
 *   polls for the same trigger (which could cause duplicate dispatches).
 * - At-least-once delivery ordering: dispatch() is called BEFORE recording
 *   event IDs in PolledEventStore. If the process crashes between dispatch and
 *   record(), the IDs are re-dispatched on the next poll cycle.
 *   This ensures no events are silently missed at the cost of rare duplicates.
 * - Poll failures: log warning and skip the cycle. The interval continues to fire.
 * - PolledEventStore: per-trigger JSON file. Tracks processed event IDs and
 *   lastPollAt timestamp. Initialized to { processedIds: [], lastPollAt: now }
 *   on first start (fresh-start invariant: no historical events re-fired).
 * - Context for dispatched workflows (GitLab):
 *   { mrId, mrIid, mrTitle, mrUrl, mrUpdatedAt, mrAuthorUsername }
 * - Context for dispatched workflows (GitHub):
 *   { itemId, itemNumber, itemTitle, itemUrl, itemUpdatedAt, itemAuthorLogin }
 *   These are available to goalTemplate interpolation and workflow context.
 */

import type { TriggerDefinition, PollingSource, TriggerId, TaskCandidate } from './types.js';
import type { TriggerRouter } from './trigger-router.js';
import type { PolledEventStore } from './polled-event-store.js';
import { pollGitLabMRs, type FetchFn, type GitLabMR } from './adapters/gitlab-poller.js';
import { pollGitHubIssues, pollGitHubPRs, type GitHubIssue, type GitHubPR } from './adapters/github-poller.js';
import { pollGitHubQueueIssues, inferMaturity, checkIdempotency, readSidecarAttemptCount, type GitHubQueueIssue, type FetchFn as QueueFetchFn } from './adapters/github-queue-poller.js';
import { loadQueueConfig } from './github-queue-config.js';
import type { WorkflowTrigger } from '../daemon/workflow-runner.js';
import type { PipelineOutcome } from '../coordinators/adaptive-pipeline.js';
import { DISCOVERY_TIMEOUT_MS } from '../coordinators/adaptive-pipeline.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A trigger definition that has a pollingSource configured.
 * Used to narrow TriggerDefinition in the scheduler.
 * The pollingSource field is typed as a PollingSource discriminated union;
 * use switch(trigger.pollingSource.provider) to narrow further.
 */
type PollingTriggerDefinition = TriggerDefinition & {
  readonly pollingSource: PollingSource;
};

function isPollingTrigger(trigger: TriggerDefinition): trigger is PollingTriggerDefinition {
  return trigger.pollingSource !== undefined;
}

/**
 * Result type for PollingScheduler.forcePoll().
 *
 * ok: Poll cycle was attempted. cycleRan=true if a new cycle was started;
 *     cycleRan=false if the skip-cycle guard fired (previous cycle still running).
 * not_found: No trigger with the given ID exists in the scheduler.
 * wrong_provider: Trigger exists but is not a github_queue_poll trigger.
 */
export type ForcePollResult =
  | { readonly kind: 'ok'; readonly cycleRan: boolean }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'wrong_provider'; readonly provider: string };

// ---------------------------------------------------------------------------
// PollingScheduler class
// ---------------------------------------------------------------------------

/**
 * Manages polling loops for all gitlab_poll triggers.
 *
 * Lifecycle:
 *   const scheduler = new PollingScheduler(triggers, router, store, fetchFn);
 *   scheduler.start();   // begin polling all configured triggers
 *   // ... later ...
 *   scheduler.stop();    // clear all intervals (call before closing the HTTP server)
 *
 * Dependency injection:
 * - router: TriggerRouter -- used to call dispatch()
 * - store: PolledEventStore -- used to track processed event IDs
 * - fetchFn: optional injectable fetch function -- for testing without real HTTP
 */
export class PollingScheduler {
  /** Per-trigger interval handles, cleared on stop(). */
  private readonly intervals = new Map<string, ReturnType<typeof setInterval>>();
  /**
   * Per-trigger "poll in progress" flags.
   * True while a poll cycle is executing; false otherwise.
   * Prevents concurrent polls for the same trigger.
   */
  private readonly polling = new Map<string, boolean>();
  /**
   * In-memory set of issue numbers currently being dispatched via dispatchAdaptivePipeline().
   *
   * WHY this exists instead of using DaemonRegistry:
   * DaemonRegistry tracks ephemeral session liveness (start/stop signals) and does not
   * carry issue-domain knowledge. Adding issueNumber to DaemonEntry would violate its
   * single responsibility (liveness tracking) and require 4+ file changes. This Set
   * follows the existing this.polling Map pattern in the same class -- a private readonly
   * mutable guard behind the class boundary -- and is sufficient for same-process duplicate
   * prevention. Cross-restart idempotency is handled by checkIdempotency() (sidecar scan).
   *
   * Lifecycle: issue added BEFORE dispatchAdaptivePipeline() call (I1). Removed in both
   * .then() and .catch() handlers unconditionally (I2). Never awaited in the poll cycle
   * body to preserve fire-and-forget semantics.
   */
  private readonly dispatchingIssues = new Set<number>();

  constructor(
    private readonly triggers: readonly TriggerDefinition[],
    private readonly router: TriggerRouter,
    private readonly store: PolledEventStore,
    private readonly fetchFn?: FetchFn,
    private readonly sessionsDir: string = path.join(os.homedir(), '.workrail', 'daemon-sessions'),
  ) {}

  /**
   * Start polling all configured triggers.
   *
   * Filters the trigger list to only gitlab_poll triggers with pollingSource set.
   * For each, starts a setInterval at the configured pollIntervalSeconds interval.
   *
   * Does nothing if called multiple times (intervals are only set once per trigger).
   */
  start(): void {
    const pollingTriggers = this.triggers.filter(isPollingTrigger);

    if (pollingTriggers.length === 0) {
      return;
    }

    console.log(`[PollingScheduler] Starting polling for ${pollingTriggers.length} trigger(s)`);

    for (const trigger of pollingTriggers) {
      if (this.intervals.has(trigger.id)) {
        // Already started -- skip (idempotent)
        continue;
      }

      const intervalMs = trigger.pollingSource.pollIntervalSeconds * 1000;

      // Start immediately with a small delay so the first poll doesn't block startup,
      // then continue on the interval.
      this.polling.set(trigger.id, false);

      // Run the first poll shortly after startup
      const firstPollTimeout = setTimeout(() => {
        void this.runPollCycle(trigger);
      }, 5000);

      const handle = setInterval(() => {
        void this.runPollCycle(trigger);
      }, intervalMs);

      // Store both handles for cleanup
      this.intervals.set(trigger.id, handle);
      // Store the timeout separately for cleanup
      this.intervals.set(`${trigger.id}__first`, firstPollTimeout as unknown as ReturnType<typeof setInterval>);

      console.log(
        `[PollingScheduler] Started polling trigger '${trigger.id}' ` +
        `(provider: ${trigger.provider}, interval: ${trigger.pollingSource.pollIntervalSeconds}s)`,
      );
    }
  }

  /**
   * Stop all polling intervals.
   *
   * Call before closing the HTTP server to prevent dispatch() calls after
   * the router's queue has been drained.
   */
  stop(): void {
    for (const [id, handle] of this.intervals) {
      clearInterval(handle);
      this.intervals.delete(id);
    }
    console.log('[PollingScheduler] All polling loops stopped.');
  }

  // ---------------------------------------------------------------------------
  // forcePoll: fire one immediate poll cycle (bypasses interval timer)
  // ---------------------------------------------------------------------------

  /**
   * Force an immediate poll cycle for the named trigger, bypassing the interval timer.
   *
   * WHY this exists: the scheduled poll interval can be minutes. This method lets operators
   * trigger an immediate cycle from the CLI (via POST /api/v2/triggers/:triggerId/poll)
   * without restarting the daemon.
   *
   * Behavior:
   * - Returns not_found if no trigger with this ID exists in the scheduler's trigger list.
   * - Returns wrong_provider if the trigger exists but is not a github_queue_poll trigger.
   *   (Only queue poll triggers support manual polling.)
   * - Runs one poll cycle via runPollCycle(). Returns ok with cycleRan=true if the cycle
   *   was actually started, cycleRan=false if the skip-cycle guard fired (previous cycle
   *   still running).
   *
   * WHY cycleRan is determined BEFORE runPollCycle: runPollCycle checks this.polling.get(triggerId)
   * internally and returns early if true. Reading the flag here lets us tell the caller whether
   * a new cycle was actually initiated without exposing runPollCycle's internals.
   */
  async forcePoll(triggerId: string): Promise<ForcePollResult> {
    const trigger = this.triggers.find((t) => t.id === triggerId);
    if (!trigger) {
      return { kind: 'not_found' };
    }

    if (trigger.provider !== 'github_queue_poll' || !trigger.pollingSource) {
      return { kind: 'wrong_provider', provider: trigger.provider };
    }

    // WHY read before runPollCycle: the skip-cycle guard inside runPollCycle checks
    // this.polling.get(triggerId) and returns early if true. By reading here first,
    // we can surface cycleRan to the caller without needing to change runPollCycle.
    const pollInFlight = this.polling.get(triggerId) === true;
    const cycleRan = !pollInFlight;

    // runPollCycle handles the skip-cycle guard, error logging, and finally cleanup.
    // We await it so the HTTP response is sent only after the cycle completes.
    const pollingTrigger = trigger as PollingTriggerDefinition;
    await this.runPollCycle(pollingTrigger);

    return { kind: 'ok', cycleRan };
  }

  // ---------------------------------------------------------------------------
  // runPollCycle: one poll iteration for a single trigger
  // ---------------------------------------------------------------------------

  /**
   * Execute one poll cycle for the given trigger.
   *
   * Ordering invariant (at-least-once delivery):
   * 1. fetch new MRs from GitLab
   * 2. filter against PolledEventStore (find new IDs)
   * 3. dispatch() each new event via TriggerRouter
   * 4. record() new IDs in PolledEventStore
   *
   * Step 4 happens AFTER step 3. If the process crashes between 3 and 4,
   * the IDs are re-dispatched on the next cycle (duplicate, not missed).
   */
  private async runPollCycle(trigger: PollingTriggerDefinition): Promise<void> {
    const triggerId = trigger.id;

    // Skip-cycle guard: if a previous poll is still running, skip this cycle
    if (this.polling.get(triggerId)) {
      console.warn(
        `[PollingScheduler] Skipping poll cycle for trigger '${triggerId}' -- ` +
        `previous cycle is still running. Consider increasing pollIntervalSeconds.`,
      );
      return;
    }

    this.polling.set(triggerId, true);
    try {
      await this.doPoll(trigger);
    } catch (e) {
      // Unexpected error -- log and continue (never crash the scheduler)
      console.warn(
        `[PollingScheduler] Unexpected error in poll cycle for trigger '${triggerId}':`,
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      this.polling.set(triggerId, false);
    }
  }

  private async doPoll(trigger: PollingTriggerDefinition): Promise<void> {
    const triggerId = trigger.id;
    const pollStartAt = new Date().toISOString();

    // Get lastPollAt from store (or now if fresh start)
    const lastPollAt = await this.store.getLastPollAt(triggerId);

    // Route to the correct adapter based on provider.
    // The discriminated union on trigger.pollingSource.provider narrows the type
    // within each branch so the compiler enforces correct adapter/source pairing.
    switch (trigger.pollingSource.provider) {
      case 'gitlab_poll':
        await this.doPollGitLab(trigger, triggerId, pollStartAt, lastPollAt, trigger.pollingSource);
        break;
      case 'github_issues_poll':
        await this.doPollGitHub(trigger, triggerId, pollStartAt, lastPollAt, trigger.pollingSource, 'issues');
        break;
      case 'github_prs_poll':
        await this.doPollGitHub(trigger, triggerId, pollStartAt, lastPollAt, trigger.pollingSource, 'prs');
        break;
      case 'github_queue_poll':
        await this.doPollGitHubQueue(trigger, triggerId, trigger.pollingSource);
        break;
      default: {
        // TypeScript exhaustiveness: if a new provider is added to the PollingSource union
        // without a case here, this line becomes unreachable and the compiler warns.
        const _exhaustive: never = trigger.pollingSource;
        console.warn(
          `[PollingScheduler] Unknown provider '${String((_exhaustive as { provider?: string }).provider)}' ` +
          `for trigger '${triggerId}'. Skipping cycle.`,
        );
      }
    }
  }

  /**
   * Poll GitLab MRs and dispatch new events.
   * At-least-once delivery: dispatch BEFORE record.
   */
  private async doPollGitLab(
    trigger: PollingTriggerDefinition,
    triggerId: TriggerId,
    pollStartAt: string,
    lastPollAt: string,
    source: Extract<PollingSource, { readonly provider: 'gitlab_poll' }>,
  ): Promise<void> {
    const pollResult = await pollGitLabMRs(source, lastPollAt, this.fetchFn);

    if (pollResult.kind === 'err') {
      console.warn(
        `[PollingScheduler] GitLab poll failed for trigger '${triggerId}': ` +
        `${pollResult.error.kind}: ${(pollResult.error as { message: string }).message}. ` +
        `Skipping this cycle, will retry at next interval.`,
      );
      return;
    }

    const mrs = pollResult.value;
    await this.dispatchAndRecord(
      trigger,
      triggerId,
      pollStartAt,
      mrs.map(mr => String(mr.id)),
      (id) => {
        const mr = mrs.find(m => String(m.id) === id);
        return mr ? buildGitLabWorkflowTrigger(trigger, mr) : null;
      },
    );
  }

  /**
   * Poll GitHub Issues or PRs and dispatch new events.
   * At-least-once delivery: dispatch BEFORE record.
   */
  private async doPollGitHub(
    trigger: PollingTriggerDefinition,
    triggerId: TriggerId,
    pollStartAt: string,
    lastPollAt: string,
    source: Extract<PollingSource, { readonly provider: 'github_issues_poll' | 'github_prs_poll' }>,
    kind: 'issues' | 'prs',
  ): Promise<void> {
    type Item = GitHubIssue | GitHubPR;
    let pollResult: Awaited<ReturnType<typeof pollGitHubIssues>>;

    if (kind === 'issues') {
      pollResult = await pollGitHubIssues(source, lastPollAt, this.fetchFn);
    } else {
      pollResult = await pollGitHubPRs(source, lastPollAt, this.fetchFn);
    }

    if (pollResult.kind === 'err') {
      console.warn(
        `[PollingScheduler] GitHub ${kind} poll failed for trigger '${triggerId}': ` +
        `${pollResult.error.kind}: ${(pollResult.error as { message: string }).message}. ` +
        `Skipping this cycle, will retry at next interval.`,
      );
      return;
    }

    const items = pollResult.value as Item[];
    await this.dispatchAndRecord(
      trigger,
      triggerId,
      pollStartAt,
      items.map(item => String(item.id)),
      (id) => {
        const item = items.find(i => String(i.id) === id);
        return item ? buildGitHubWorkflowTrigger(trigger, item) : null;
      },
    );
  }

  /**
   * Shared dispatch-and-record logic for all polling providers.
   *
   * Invariant: dispatch BEFORE record (at-least-once delivery).
   * If the process crashes between dispatch and record, events re-fire on the next cycle.
   * This ensures no events are silently missed at the cost of rare duplicates.
   */
  private async dispatchAndRecord(
    trigger: PollingTriggerDefinition,
    triggerId: TriggerId,
    pollStartAt: string,
    candidateIds: string[],
    buildTrigger: (id: string) => WorkflowTrigger | null,
  ): Promise<void> {
    if (candidateIds.length === 0) {
      await this.store.record(triggerId, [], pollStartAt);
      return;
    }

    const filterResult = await this.store.filterNew(triggerId, candidateIds);

    if (filterResult.kind === 'err') {
      console.warn(
        `[PollingScheduler] Failed to read event store for trigger '${triggerId}': ` +
        `${filterResult.error.message}. Skipping dispatch to avoid duplicates.`,
      );
      return;
    }

    const newIds = filterResult.value;

    if (newIds.length === 0) {
      await this.store.record(triggerId, [], pollStartAt);
      return;
    }

    // INVARIANT: dispatch BEFORE record (at-least-once delivery)
    for (const newId of newIds) {
      const workflowTrigger = buildTrigger(newId);
      if (!workflowTrigger) continue;
      this.router.dispatch(workflowTrigger);
    }

    // Record AFTER dispatch
    const recordResult = await this.store.record(triggerId, newIds, pollStartAt);
    if (recordResult.kind === 'err') {
      console.warn(
        `[PollingScheduler] Failed to record processed events for trigger '${triggerId}': ` +
        `${recordResult.error.message}. Events may be re-dispatched on the next cycle.`,
      );
    } else {
      console.log(
        `[PollingScheduler] Dispatched ${newIds.length} new event(s) for trigger '${triggerId}'`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // doPollGitHubQueue: one poll cycle for a github_queue_poll trigger
  //
  // Does NOT use PolledEventStore (queue-poll semantics differ from event-poll).
  // At most one session dispatched per cycle.
  // Cycle order is fixed and critical -- see implementation_plan.md.
  // ---------------------------------------------------------------------------

  private async doPollGitHubQueue(
    trigger: PollingTriggerDefinition,
    triggerId: TriggerId,
    source: Extract<PollingSource, { readonly provider: 'github_queue_poll' }>,
  ): Promise<void> {
    const cycleStart = Date.now();

    const configResult = await loadQueueConfig();
    if (configResult.kind === 'err') {
      console.warn(`[QueuePoll] Failed to load queue config for trigger '${triggerId}': ${configResult.error}. Skipping cycle.`);
      return;
    }

    const queueConfig = configResult.value;
    if (queueConfig === null) return;

    if (queueConfig.type !== 'assignee') {
      console.error(`[QueuePoll] Queue type '${queueConfig.type}' is not implemented. Only 'assignee' is supported. Skipping cycle.`);
      // N2: write poll_cycle_complete (not poll_cycle_error) so operators can grep a uniform event name.
      await appendQueuePollLog({ event: 'poll_cycle_complete', triggerId, reason: 'not_implemented', queueType: queueConfig.type, ts: new Date().toISOString() });
      return;
    }

    // Concurrency cap check BEFORE per-issue evaluation (INVARIANT per pitch)
    const sessionsDir = this.sessionsDir;
    const activeSessions = await countActiveSessions(sessionsDir);
    if (activeSessions >= queueConfig.maxTotalConcurrentSessions) {
      console.log(`[QueuePoll] Skipping cycle: active sessions (${activeSessions}) >= maxTotalConcurrentSessions (${queueConfig.maxTotalConcurrentSessions}).`);
      await appendQueuePollLog({ event: 'poll_cycle_skipped', triggerId, reason: 'max_concurrency_reached', activeSessions, maxTotalConcurrentSessions: queueConfig.maxTotalConcurrentSessions, ts: new Date().toISOString() });
      return;
    }

    const fetchResult = await pollGitHubQueueIssues(source, queueConfig, this.fetchFn as QueueFetchFn | undefined);
    if (fetchResult.kind === 'err') {
      console.warn(`[QueuePoll] GitHub API error for trigger '${triggerId}': ${fetchResult.error.kind}. Skipping cycle.`);
      return;
    }

    const issues = fetchResult.value;
    console.log(`[QueuePoll] cycle start repo=${source.repo} issues_fetched=${issues.length}`);

    type ScoredIssue = { issue: GitHubQueueIssue; maturity: 'idea' | 'specced' | 'ready' };
    const candidates: ScoredIssue[] = [];
    const skipped: Array<{ issue: GitHubQueueIssue; reason: string }> = [];

    for (const issue of issues) {
      const issueLabels = issue.labels.map((l) => l.name);

      const excludedLabel = queueConfig.excludeLabels.find((el) => issueLabels.includes(el));
      if (excludedLabel) { skipped.push({ issue, reason: `excluded_label: ${excludedLabel}` }); continue; }

      // Fast in-memory idempotency check (I3: runs before sidecar scan).
      // Guards against duplicate dispatch within a single process lifetime for issues
      // whose dispatchAdaptivePipeline() Promise is still in flight.
      if (this.dispatchingIssues.has(issue.number)) {
        skipped.push({ issue, reason: 'active_session_in_process' });
        continue;
      }

      // Per-issue idempotency (conservative: any parse error = active)
      const idempotencyStatus = await checkIdempotency(issue.number, sessionsDir);
      if (idempotencyStatus === 'active') { skipped.push({ issue, reason: 'active_session' }); continue; }

      // Infer maturity (exactly 3 heuristics -- SCOPE LOCK)
      const maturity = inferMaturity(issue.body);
      candidates.push({ issue, maturity });
    }

    // Rank: ready > specced > idea, ties by issue number ascending
    const MATURITY_RANK: Record<string, number> = { ready: 0, specced: 1, idea: 2 };
    candidates.sort((a, b) => {
      const rankDiff = (MATURITY_RANK[a.maturity] ?? 2) - (MATURITY_RANK[b.maturity] ?? 2);
      return rankDiff !== 0 ? rankDiff : a.issue.number - b.issue.number;
    });

    for (const { issue, reason } of skipped) {
      console.log(`[QueuePoll] skipped #${issue.number} "${issue.title}" reason=${reason}`);
      await appendQueuePollLog({ event: 'task_skipped', issueNumber: issue.number, title: issue.title, reason, ts: new Date().toISOString() });
    }

    if (candidates.length === 0) {
      console.log('[QueuePoll] No actionable issues found in this poll cycle.');
      await appendQueuePollLog({ event: 'poll_cycle_complete', selected: 0, skipped: skipped.length, elapsed: Date.now() - cycleStart, ts: new Date().toISOString() });
      return;
    }

    const top = candidates[0]!;

    // Dispatch loop protection: check attempt count BEFORE dispatching.
    // readSidecarAttemptCount() returns 0 if no sidecar exists (first attempt) or on any
    // read error (non-blocking -- see QueueIssueSidecar docs for asymmetric defaults).
    const previousAttemptCount = await readSidecarAttemptCount(top.issue.number, sessionsDir);
    if (previousAttemptCount >= queueConfig.maxDispatchAttempts) {
      console.warn(`[QueuePoll] dispatch_cap_reached #${top.issue.number} attempts=${previousAttemptCount} limit=${queueConfig.maxDispatchAttempts}`);
      await appendQueuePollLog({ event: 'task_skipped', issueNumber: top.issue.number, title: top.issue.title, reason: 'dispatch_cap_reached', attemptCount: previousAttemptCount, limit: queueConfig.maxDispatchAttempts, ts: new Date().toISOString() });
      // Fire-and-forget cap actions: outbox write, GitHub label, GitHub comment.
      // Dispatch skip is unconditional regardless of whether these succeed.
      void postCapActions(top.issue, triggerId, previousAttemptCount, queueConfig, sessionsDir, this.fetchFn as QueueFetchFn | undefined);
      console.log(`[QueuePoll] cycle complete (cap) skipped=${skipped.length + candidates.length} elapsed=${Date.now() - cycleStart}ms`);
      return;
    }
    const attemptCount = previousAttemptCount + 1;

    const upstreamSpecUrl = extractUpstreamSpecUrl(top.issue.body);

    const taskCandidate: TaskCandidate = {
      issueNumber: top.issue.number,
      title: top.issue.title,
      body: top.issue.body,
      url: top.issue.url,
      inferredMaturity: top.maturity,
      ...(upstreamSpecUrl !== undefined ? { upstreamSpecUrl } : {}),
      queueConfigType: queueConfig.type,
    };

    const workflowTrigger: WorkflowTrigger = {
      workflowId: trigger.workflowId,
      goal: top.issue.title,
      workspacePath: trigger.workspacePath,
      context: { taskCandidate },
      ...(trigger.referenceUrls !== undefined ? { referenceUrls: trigger.referenceUrls } : {}),
      ...(trigger.agentConfig !== undefined ? { agentConfig: trigger.agentConfig } : {}),
      ...(trigger.soulFile !== undefined ? { soulFile: trigger.soulFile } : {}),
      // Bot identity for queue-poll sessions: autonomous commits use bot account.
      // Read from queue config when present; fall back to generic defaults.
      botIdentity: {
        name: queueConfig.botName ?? 'worktrain',
        email: queueConfig.botEmail ?? 'worktrain@users.noreply.github.com',
      },
    };

    const maturityReason = describeMaturityReason(top.maturity);
    console.log(`[QueuePoll] selected #${top.issue.number} "${top.issue.title}" maturity=${top.maturity} reason="${maturityReason}"`);
    await appendQueuePollLog({ event: 'task_selected', issueNumber: top.issue.number, title: top.issue.title, maturity: top.maturity, reason: maturityReason, ts: new Date().toISOString() });

    // Always use adaptive pipeline for queue poll triggers.
    // workflowId from triggers.yml is intentionally ignored for queue triggers --
    // the adaptive coordinator decides the pipeline based on task content.
    //
    // WHY always (no fallback): queue poll sessions MUST go through the adaptive
    // coordinator. Falling back to dispatch() with a fixed workflowId would bypass
    // the coordinator's routing logic and silently produce wrong behavior.
    //
    // If dispatchAdaptivePipeline is not available (test fakes must provide it),
    // throw a clear error rather than silently falling back to single-workflow dispatch.
    // This error is caught by runPollCycle's try/catch and logged as a warning --
    // the daemon does not crash, but the poll cycle is skipped with a clear message.
    if (typeof (this.router as { dispatchAdaptivePipeline?: unknown }).dispatchAdaptivePipeline !== 'function') {
      throw new Error(
        '[QueuePoll] dispatchAdaptivePipeline not available on router. ' +
        'Queue poll triggers require the adaptive coordinator. ' +
        'Inject coordinatorDeps and modeExecutors in the TriggerRouter constructor.',
      );
    }

    // I1: Add to dispatchingIssues BEFORE calling dispatchAdaptivePipeline().
    // Prevents duplicate dispatch if the next poll cycle fires before this Promise settles.
    this.dispatchingIssues.add(top.issue.number);
    console.log(`[QueuePoll] in-flight-add #${top.issue.number}`);

    // Write cross-restart ownership sidecar BEFORE dispatch.
    // WHY: in-memory dispatchingIssues is cleared on daemon restart. The sidecar persists
    // across restarts so checkIdempotency() can detect active queue sessions even after crash.
    // TTL = DISCOVERY_TIMEOUT_MS + 60s: if the daemon crashes mid-run, the sidecar expires
    // naturally after this window and the issue becomes eligible for re-dispatch (RC3 fix).
    //
    // attemptCount starts at 1 on first dispatch and persists across TTL expiry.
    // On success: sidecar deleted. On failure: incremented and rewritten (not deleted).
    // Restart resets the count via clearQueueIssueSidecars() on daemon startup.
    // See QueueIssueSidecar interface for the dual-purpose design rationale.
    const sidecarPath = path.join(sessionsDir, `queue-issue-${top.issue.number}.json`);
    const sidecarContent = JSON.stringify({
      issueNumber: top.issue.number,
      triggerId,
      dispatchedAt: Date.now(),
      ttlMs: DISCOVERY_TIMEOUT_MS + 60_000,
      attemptCount,
    }, null, 2);
    void fs.writeFile(sidecarPath, sidecarContent, 'utf8').catch((e: unknown) => {
      console.warn(`[QueuePoll] Failed to write sidecar for issue #${top.issue.number}: ${e instanceof Error ? e.message : String(e)}`);
    });

    // Capture the Promise without awaiting it (fire-and-forget semantics preserved).
    // I2: Cleanup in BOTH .then() and .catch() -- unconditional regardless of outcome.
    const dispatchP = (this.router as {
      dispatchAdaptivePipeline: (
        goal: string,
        workspace: string,
        context?: Readonly<Record<string, unknown>>,
      ) => Promise<PipelineOutcome>
    }).dispatchAdaptivePipeline(
      workflowTrigger.goal,
      workflowTrigger.workspacePath,
      workflowTrigger.context,
    );
    const issueNumber = top.issue.number;
    void dispatchP
      .then(() => {
        this.dispatchingIssues.delete(issueNumber);
        console.log(`[QueuePoll] in-flight-clear #${issueNumber} reason=completed`);
        // Delete sidecar on completion (pipeline resolved).
        void fs.unlink(sidecarPath).catch(() => {});
      })
      .catch(() => {
        this.dispatchingIssues.delete(issueNumber);
        console.log(`[QueuePoll] in-flight-clear #${issueNumber} reason=error`);
        // On failure: rewrite sidecar with the SAME attemptCount recorded at dispatch
        // time, zeroed TTL so checkIdempotency() clears immediately on the next poll.
        // WHY NOT incrementSidecarAttemptCount: that function re-reads and adds 1, which
        // would double-count (the sidecar was already written with previousAttemptCount+1
        // at dispatch time). Using attemptCount directly gives exactly N dispatches for
        // maxDispatchAttempts=N.
        void recordFailedAttempt(sidecarPath, issueNumber, triggerId, attemptCount);
      });
    console.log(`[QueuePoll] dispatched via adaptivePipeline goal="${workflowTrigger.goal.slice(0, 80)}"`);

    for (let i = 1; i < candidates.length; i++) {
      const { issue, maturity } = candidates[i]!;
      console.log(`[QueuePoll] skipped #${issue.number} "${issue.title}" reason=lower_priority_${maturity}`);
      await appendQueuePollLog({ event: 'task_skipped', issueNumber: issue.number, title: issue.title, inferredMaturity: maturity, reason: `lower_priority_${maturity}`, ts: new Date().toISOString() });
    }

    const elapsed = Date.now() - cycleStart;
    console.log(`[QueuePoll] cycle complete selected=1 skipped=${skipped.length + candidates.length - 1} elapsed=${elapsed}ms`);
    await appendQueuePollLog({ event: 'poll_cycle_complete', selected: 1, skipped: skipped.length + candidates.length - 1, elapsed, ts: new Date().toISOString() });
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a WorkflowTrigger from a TriggerDefinition and a GitLab MR.
 *
 * Context variables injected:
 * - mrId: globally unique MR ID
 * - mrIid: project-scoped MR number (the !N number)
 * - mrTitle: MR title
 * - mrUrl: MR web URL
 * - mrUpdatedAt: ISO 8601 timestamp of last update
 * - mrAuthorUsername: author's username (if available)
 */
function buildGitLabWorkflowTrigger(
  trigger: PollingTriggerDefinition,
  mr: GitLabMR,
): WorkflowTrigger {
  const context: Record<string, unknown> = {
    mrId: mr.id,
    mrIid: mr.iid,
    mrTitle: mr.title,
    mrUrl: mr.web_url,
    mrUpdatedAt: mr.updated_at,
    ...(mr.author?.username ? { mrAuthorUsername: mr.author.username } : {}),
  };

  const goal = interpolateGoalFromPayload(trigger, {
    id: mr.id,
    iid: mr.iid,
    title: mr.title,
    web_url: mr.web_url,
    updated_at: mr.updated_at,
    state: mr.state,
    author: mr.author ?? {},
  });

  return {
    workflowId: trigger.workflowId,
    goal,
    workspacePath: trigger.workspacePath,
    context,
    ...(trigger.referenceUrls !== undefined ? { referenceUrls: trigger.referenceUrls } : {}),
    ...(trigger.agentConfig !== undefined ? { agentConfig: trigger.agentConfig } : {}),
    ...(trigger.soulFile !== undefined ? { soulFile: trigger.soulFile } : {}),
  };
}

/**
 * Build a WorkflowTrigger from a TriggerDefinition and a GitHub Issue or PR.
 *
 * Context variables injected:
 * - itemId: globally unique item ID
 * - itemNumber: repository-scoped issue/PR number
 * - itemTitle: issue/PR title
 * - itemUrl: HTML URL of the item
 * - itemUpdatedAt: ISO 8601 timestamp of last update
 * - itemAuthorLogin: author's GitHub login (if available)
 */
function buildGitHubWorkflowTrigger(
  trigger: PollingTriggerDefinition,
  item: GitHubIssue | GitHubPR,
): WorkflowTrigger {
  const context: Record<string, unknown> = {
    itemId: item.id,
    itemNumber: item.number,
    itemTitle: item.title,
    itemUrl: item.html_url,
    itemUpdatedAt: item.updated_at,
    ...(item.user?.login ? { itemAuthorLogin: item.user.login } : {}),
  };

  const goal = interpolateGoalFromPayload(trigger, {
    id: item.id,
    number: item.number,
    title: item.title,
    html_url: item.html_url,
    updated_at: item.updated_at,
    state: item.state,
    user: item.user ?? {},
  });

  return {
    workflowId: trigger.workflowId,
    goal,
    workspacePath: trigger.workspacePath,
    context,
    ...(trigger.referenceUrls !== undefined ? { referenceUrls: trigger.referenceUrls } : {}),
    ...(trigger.agentConfig !== undefined ? { agentConfig: trigger.agentConfig } : {}),
    ...(trigger.soulFile !== undefined ? { soulFile: trigger.soulFile } : {}),
  };
}

/**
 * Interpolate a goal string from the trigger's goalTemplate using a payload object.
 *
 * Token syntax: {{$.path}} or {{path}}. Strips leading "$." or "$".
 * Falls back to the static goal if any token cannot be resolved.
 */
function interpolateGoalFromPayload(
  trigger: PollingTriggerDefinition,
  payload: Record<string, unknown>,
): string {
  const template = trigger.goalTemplate;
  if (!template) return trigger.goal;

  const TOKEN_RE = /\{\{([^}]+)\}\}/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(template)) !== null) {
    if (match[1] !== undefined) tokens.push(match[1]);
  }

  if (tokens.length === 0) return template;

  const resolved = new Map<string, string>();
  for (const token of tokens) {
    const value = extractDotPath(payload, token);
    if (value === undefined || value === null) {
      return trigger.goal; // fall back to static goal on any missing token
    }
    resolved.set(token, String(value));
  }

  return template.replace(/\{\{([^}]+)\}\}/g, (_, token: string) => resolved.get(token) ?? trigger.goal);
}

/**
 * Simple dot-path traversal. Strips leading "$." or "$".
 * Returns undefined for missing paths or array-indexed paths.
 */
function extractDotPath(obj: Record<string, unknown>, rawPath: string): unknown {
  let dotPath = rawPath.trim();
  if (dotPath.startsWith('$.')) dotPath = dotPath.slice(2);
  else if (dotPath.startsWith('$')) dotPath = dotPath.slice(1);

  const segments = dotPath.split('.');
  let current: unknown = obj;
  for (const segment of segments) {
    if (segment.includes('[') || current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Queue poll helper functions
// ---------------------------------------------------------------------------

async function countActiveSessions(sessionsDir: string): Promise<number> {
  try {
    const files = await fs.readdir(sessionsDir);
    // TODO(Phase B): sessions preserved by runStartupRecovery() (Phase B honest deferral)
    // also land in this directory with the same filename pattern as live session sidecars.
    // They cannot be distinguished here, so preserved sidecars count toward
    // maxConcurrentSessions and may suppress new dispatches unnecessarily.
    // Fix in Phase B: use a distinguishable filename (e.g. preserved-<sessionId>.json)
    // or a marker field inside the sidecar so countActiveSessions can exclude them.
    return files.filter((f) => f.endsWith('.json') && !f.startsWith('queue-issue-')).length;
  } catch {
    return 0;
  }
}

/**
 * Maximum size of queue-poll.jsonl before rotation.
 * When the file reaches this size, it is renamed to queue-poll.jsonl.1
 * (overwriting any existing backup) and a fresh log file is started.
 * WHY 10 MB: conservative cap holding ~5 weeks of history at 5-minute polling intervals.
 */
const MAX_QUEUE_POLL_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// NOTE: rotation path not covered by unit tests -- mocking os.homedir() requires
// test infrastructure changes not currently in place.
async function appendQueuePollLog(entry: Record<string, unknown>): Promise<void> {
  const logPath = path.join(os.homedir(), '.workrail', 'queue-poll.jsonl');
  try {
    try {
      const stat = await fs.stat(logPath);
      if (stat.size >= MAX_QUEUE_POLL_FILE_SIZE) {
        // Rotate: rename current log to .1 (overwrites any existing backup),
        // then let the appendFile below create a fresh log file.
        await fs.rename(logPath, logPath + '.1');
      }
    } catch {
      // File does not exist yet or stat/rename failed -- proceed to append.
      // On ENOENT: appendFile will create the file. On other errors: log entry
      // will still be written to the existing (potentially oversized) file,
      // and console.warn is emitted by the outer catch if appendFile itself fails.
    }
    await fs.appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.warn(`[QueuePoll] Failed to write queue-poll.jsonl: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function extractUpstreamSpecUrl(body: string): string | undefined {
  const specLineMatch = /upstream_spec:\s*(https?:\/\/\S+)/i.exec(body);
  if (specLineMatch?.[1]) return specLineMatch[1];
  const firstPara = body.split(/\n\s*\n/)[0] ?? '';
  const urlMatch = /(https?:\/\/\S+)/.exec(firstPara);
  return urlMatch?.[1];
}

function describeMaturityReason(maturity: 'idea' | 'specced' | 'ready'): string {
  switch (maturity) {
    case 'ready': return 'has upstream spec URL';
    case 'specced': return 'has acceptance criteria or checklist';
    case 'idea': return 'maturity=idea, no upstream spec';
  }
}

// ---------------------------------------------------------------------------
// Dispatch loop protection helpers
// ---------------------------------------------------------------------------

/**
 * Record a failed dispatch attempt by rewriting the sidecar with the given
 * attemptCount and a zeroed TTL so checkIdempotency() returns 'clear' immediately.
 *
 * WHY the caller passes attemptCount (not read-and-increment here):
 * The sidecar was already written at dispatch start with attemptCount = previousCount + 1.
 * If this function re-read the sidecar and added 1 again, each failure would advance
 * the stored count by 2, making maxDispatchAttempts=N give only ceil(N/2) actual
 * dispatches. Passing the already-computed value keeps the semantics exact:
 * maxDispatchAttempts=N gives exactly N dispatches.
 *
 * Fire-and-forget: errors are swallowed and logged; a failed write means the count
 * is not persisted, which is acceptable (one extra dispatch may occur).
 */
async function recordFailedAttempt(
  sidecarPath: string,
  issueNumber: number,
  triggerId: string,
  attemptCount: number,
): Promise<void> {
  const newContent = JSON.stringify({
    issueNumber,
    triggerId,
    // Set dispatchedAt=0 and ttlMs=0 so checkIdempotency() returns 'clear' immediately.
    // The sidecar is kept solely as a failure counter -- the TTL lock has no meaning here.
    dispatchedAt: 0,
    ttlMs: 0,
    attemptCount,
  }, null, 2);

  try {
    await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
    await fs.writeFile(sidecarPath, newContent, 'utf8');
    console.log(`[QueuePoll] sidecar-failure-recorded #${issueNumber} attempts=${attemptCount}`);
  } catch (e: unknown) {
    console.warn(
      `[QueuePoll] Failed to record failed attempt for issue #${issueNumber}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Post cap-exceeded actions when an issue reaches maxDispatchAttempts.
 *
 * Actions (all fire-and-forget, non-fatal):
 * 1. Write entry to ~/.workrail/outbox.jsonl (human notification)
 * 2. Apply 'worktrain:needs-human' label to the GitHub issue
 * 3. Post a comment explaining the issue was paused
 *
 * Each action is independent -- failure of one does not prevent the others.
 * The dispatch skip is handled by the caller and is unconditional.
 *
 * WHY 'worktrain:needs-human' label must pre-exist: auto-creating labels on the
 * first cap is a scope expansion. Operators who use the queue feature are expected
 * to create this label on their repos. If absent, the API returns 422 and we log
 * a warning.
 */
async function postCapActions(
  issue: GitHubQueueIssue,
  triggerId: string,
  attemptCount: number,
  queueConfig: import('./github-queue-config.js').GitHubQueueConfig,
  sessionsDir: string,
  fetchFn?: QueueFetchFn,
): Promise<void> {
  const msg = `WorkTrain paused dispatching issue #${issue.number} "${issue.title}" after ${attemptCount} failed attempt(s) (limit: ${queueConfig.maxDispatchAttempts}). Remove the 'worktrain:needs-human' label or restart the daemon to retry.`;

  // 1. Write outbox notification
  const outboxPath = path.join(os.homedir(), '.workrail', 'outbox.jsonl');
  const outboxEntry = JSON.stringify({
    id: randomUUID(),
    message: msg,
    timestamp: new Date().toISOString(),
  });
  try {
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    await fs.appendFile(outboxPath, outboxEntry + '\n', 'utf8');
  } catch (e: unknown) {
    // Non-fatal: outbox write failure -- log to console so the operator still sees the notification
    console.warn(
      `[QueuePoll] cap_actions: failed to write outbox for issue #${issue.number}: ${e instanceof Error ? e.message : String(e)}`,
    );
    console.warn(`[QueuePoll] cap_notification #${issue.number}: ${msg}`);
  }

  // 2 & 3. GitHub API calls require a fetchFn and a token
  if (!fetchFn) {
    console.warn(`[QueuePoll] cap_actions: no fetchFn available, skipping GitHub label/comment for issue #${issue.number}`);
    return;
  }

  const [owner, repo] = queueConfig.repo.split('/');
  if (!owner || !repo) {
    console.warn(`[QueuePoll] cap_actions: could not parse repo '${queueConfig.repo}', skipping GitHub actions`);
    return;
  }

  const headers = {
    'Authorization': `Bearer ${queueConfig.token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  // 2. Apply 'worktrain:needs-human' label
  const labelUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}/labels`;
  try {
    const labelResp = await fetchFn(labelUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ labels: ['worktrain:needs-human'] }),
    });
    if (!labelResp.ok) {
      const status = labelResp.status;
      if (status === 422) {
        console.warn(
          `[QueuePoll] cap_actions: 'worktrain:needs-human' label does not exist on ${queueConfig.repo}. ` +
          `Create it manually to enable label-based human reset.`,
        );
      } else {
        console.warn(`[QueuePoll] cap_actions: failed to apply label on issue #${issue.number}: HTTP ${status}`);
      }
    }
  } catch (e: unknown) {
    console.warn(`[QueuePoll] cap_actions: error applying label on issue #${issue.number}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3. Post comment
  const commentUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}/comments`;
  const commentBody = `WorkTrain paused dispatching this issue after **${attemptCount}** failed attempt(s) (limit: ${queueConfig.maxDispatchAttempts}).\n\nTo retry, either:\n- Remove the \`worktrain:needs-human\` label and restart the daemon\n- Close and reopen this issue\n\nTriggerId: \`${triggerId}\``;
  try {
    const commentResp = await fetchFn(commentUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: commentBody }),
    });
    if (!commentResp.ok) {
      console.warn(`[QueuePoll] cap_actions: failed to post comment on issue #${issue.number}: HTTP ${commentResp.status}`);
    }
  } catch (e: unknown) {
    console.warn(`[QueuePoll] cap_actions: error posting comment on issue #${issue.number}: ${e instanceof Error ? e.message : String(e)}`);
  }

}
