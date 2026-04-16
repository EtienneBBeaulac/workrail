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

import type { TriggerDefinition, PollingSource, TriggerId } from './types.js';
import type { TriggerRouter } from './trigger-router.js';
import type { PolledEventStore } from './polled-event-store.js';
import { pollGitLabMRs, type FetchFn, type GitLabMR } from './adapters/gitlab-poller.js';
import { pollGitHubIssues, pollGitHubPRs, type GitHubIssue, type GitHubPR } from './adapters/github-poller.js';
import type { WorkflowTrigger } from '../daemon/workflow-runner.js';

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

  constructor(
    private readonly triggers: readonly TriggerDefinition[],
    private readonly router: TriggerRouter,
    private readonly store: PolledEventStore,
    private readonly fetchFn?: FetchFn,
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
  let path = rawPath.trim();
  if (path.startsWith('$.')) path = path.slice(2);
  else if (path.startsWith('$')) path = path.slice(1);

  const segments = path.split('.');
  let current: unknown = obj;
  for (const segment of segments) {
    if (segment.includes('[') || current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
