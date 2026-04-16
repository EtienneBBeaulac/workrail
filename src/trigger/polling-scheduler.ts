/**
 * WorkRail Auto: Polling Scheduler
 *
 * Manages setInterval timers for polling triggers. On each tick, fetches new
 * events from the configured external API (e.g. GitLab MRs), deduplicates via
 * PolledEventStore, dispatches new events through TriggerRouter, then records
 * processed IDs.
 *
 * Design notes:
 * - One setInterval per polling trigger. Interval is trigger.pollingSource.pollIntervalSeconds.
 * - A 5-second first-poll setTimeout fires shortly after start() to avoid waiting a full
 *   interval before the first poll. This balances responsiveness with startup safety.
 * - Skip-cycle guard: if a poll is already in progress for a trigger, the next tick
 *   is skipped and a warning is logged. Prevents concurrent polls for the same trigger.
 * - At-least-once ordering: dispatch is called BEFORE recording processed IDs.
 *   If a crash occurs after dispatch but before record, the event is re-dispatched
 *   on the next poll cycle. This is intentional and preferred over at-most-once.
 * - goalTemplate interpolation: {{$.iid}} and {{$.title}} tokens are resolved
 *   from the MR's flat field object using interpolateGoalTemplate from trigger-router.ts.
 * - WorkflowTrigger context includes MR-specific fields: mrId, mrIid, mrTitle, mrUrl, mrUpdatedAt.
 * - Only gitlab_poll triggers are handled currently. Other providers are ignored.
 * - stop() clears all intervals and first-poll timeouts.
 *
 * Invariants:
 * - polling Map flag is always reset in a finally block (never permanently locked).
 * - record() is called only after all dispatches succeed (at-least-once guarantee).
 */

import type { TriggerDefinition } from './types.js';
import type { TriggerRouter } from './trigger-router.js';
import { interpolateGoalTemplate } from './trigger-router.js';
import { PolledEventStore } from './polled-event-store.js';
import { pollGitLabMRs, type FetchFn, type GitLabMR } from './adapters/gitlab-poller.js';
import type { WorkflowTrigger } from '../daemon/workflow-runner.js';

// ---------------------------------------------------------------------------
// PollingScheduler
// ---------------------------------------------------------------------------

export class PollingScheduler {
  /**
   * Map from trigger ID to boolean. True when a poll is currently in progress.
   *
   * WHY Map (not Set): easier to toggle false in finally without deleting the key.
   * The runPollCycle guard reads the value to decide whether to skip.
   */
  // Accessed by tests via private cast: (scheduler as unknown as { polling: Map<string, boolean> }).polling
  private readonly polling: Map<string, boolean> = new Map();

  private readonly intervalHandles: Map<string, ReturnType<typeof setInterval>> = new Map();
  private readonly timeoutHandles: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private readonly triggers: readonly TriggerDefinition[],
    private readonly router: TriggerRouter,
    private readonly store: PolledEventStore,
    private readonly fetchFn?: FetchFn,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start polling for all gitlab_poll triggers.
   *
   * For each trigger, starts:
   * 1. A 5-second setTimeout for the first poll (avoids waiting a full interval).
   * 2. A setInterval for subsequent polls at pollIntervalSeconds cadence.
   */
  start(): void {
    const pollingTriggers = this.triggers.filter(
      (t) => t.provider === 'gitlab_poll' && t.pollingSource !== undefined,
    );

    for (const trigger of pollingTriggers) {
      const intervalMs = (trigger.pollingSource!.pollIntervalSeconds) * 1000;

      // First-poll timeout: fire shortly after start()
      const firstPollTimeout = setTimeout(() => {
        void this.runPollCycle(trigger);
      }, 5_000);
      this.timeoutHandles.set(trigger.id, firstPollTimeout);

      // Recurring interval
      const handle = setInterval(() => {
        void this.runPollCycle(trigger);
      }, intervalMs);
      this.intervalHandles.set(trigger.id, handle);
    }
  }

  /**
   * Stop all polling intervals and first-poll timeouts.
   */
  stop(): void {
    for (const handle of this.intervalHandles.values()) {
      clearInterval(handle);
    }
    this.intervalHandles.clear();

    for (const handle of this.timeoutHandles.values()) {
      clearTimeout(handle);
    }
    this.timeoutHandles.clear();
  }

  // ---------------------------------------------------------------------------
  // Poll cycle
  // ---------------------------------------------------------------------------

  /**
   * Outer cycle runner. Checks the skip-cycle guard before calling doPoll.
   *
   * WHY runPollCycle as a separate method: tests spy on it to verify setInterval
   * wiring without executing the full poll logic (which involves real I/O).
   * The skip-cycle guard here prevents concurrent polls from the same trigger.
   */
  // Accessed by tests via private cast
  private async runPollCycle(trigger: TriggerDefinition): Promise<void> {
    if (this.polling.get(trigger.id) === true) {
      console.warn(
        `[PollingScheduler] Skipping poll cycle for trigger '${trigger.id}' -- previous poll still running.`,
      );
      return;
    }
    await this.doPoll(trigger);
  }

  /**
   * Core poll logic: fetch, filter, dispatch, record.
   *
   * At-least-once ordering: dispatch is called BEFORE record().
   * If a crash occurs between dispatch and record, the next poll will re-dispatch.
   * This is intentional: duplicate dispatch is safer than missing one.
   *
   * WHY try/finally: the polling flag MUST be reset even if an error occurs.
   * Omitting finally would permanently lock out future polls for this trigger.
   */
  // Accessed by tests via private cast
  private async doPoll(trigger: TriggerDefinition): Promise<void> {
    const pollingSource = trigger.pollingSource;
    if (!pollingSource) return;

    this.polling.set(trigger.id, true);
    try {
      const since = await this.store.getLastPollAt(trigger.id);
      const pollAt = new Date().toISOString();

      // Fetch from the external API
      // Only gitlab_poll is supported by the scheduler currently.
      // WHY narrow on provider: pollingSource is a discriminated union.
      if (pollingSource.provider !== 'gitlab_poll') {
        console.warn(
          `[PollingScheduler] Unsupported polling provider '${pollingSource.provider}' for trigger '${trigger.id}'. Skipping.`,
        );
        return;
      }
      const pollResult = await pollGitLabMRs(
        pollingSource,
        since,
        this.fetchFn,
      );

      if (pollResult.kind === 'err') {
        console.warn(
          `[PollingScheduler] poll failed for trigger '${trigger.id}': ${pollResult.error.kind} -- ${JSON.stringify(pollResult.error)}`,
        );
        return;
      }

      const mrs = pollResult.value;
      if (mrs.length === 0) {
        // No new MRs; still update lastPollAt
        await this.store.record(trigger.id, [], pollAt);
        return;
      }

      // Deduplicate: find MRs not yet processed
      const candidateIds = mrs.map((mr) => String(mr.id));
      const filterResult = await this.store.filterNew(trigger.id, candidateIds);
      if (filterResult.kind === 'err') return;

      const newIds = filterResult.value;
      const newMrs = mrs.filter((mr) => newIds.includes(String(mr.id)));

      // Dispatch new MRs (BEFORE recording -- at-least-once guarantee)
      for (const mr of newMrs) {
        const workflowTrigger = this.buildWorkflowTrigger(trigger, mr);
        this.router.dispatch(workflowTrigger);
      }

      // Record processed IDs and update lastPollAt
      await this.store.record(trigger.id, newIds, pollAt);
    } finally {
      // WHY finally: ensures the flag is always reset, even if an unexpected
      // error occurs. Without this, the trigger would be permanently locked out.
      this.polling.set(trigger.id, false);
    }
  }

  // ---------------------------------------------------------------------------
  // WorkflowTrigger builder
  // ---------------------------------------------------------------------------

  /**
   * Build a WorkflowTrigger from a TriggerDefinition and a GitLab MR.
   *
   * Context includes MR-specific fields for use in workflow steps.
   * Goal is interpolated from goalTemplate if set; falls back to static goal.
   *
   * WHY flat MR object as goalTemplate payload: interpolateGoalTemplate strips
   * the leading "$." and traverses the payload by dot-path. The MR fields are
   * accessible as {{$.iid}}, {{$.title}}, etc. The MR is passed directly as
   * the payload object (not nested under a key).
   */
  private buildWorkflowTrigger(trigger: TriggerDefinition, mr: GitLabMR): WorkflowTrigger {
    const mrPayload: Record<string, unknown> = {
      id: mr.id,
      iid: mr.iid,
      title: mr.title,
      web_url: mr.web_url,
      updated_at: mr.updated_at,
      state: mr.state,
    };

    const goal = trigger.goalTemplate
      ? interpolateGoalTemplate(trigger.goalTemplate, trigger.goal, mrPayload, trigger.id)
      : trigger.goal;

    return {
      workflowId: trigger.workflowId,
      goal,
      workspacePath: trigger.workspacePath,
      context: {
        mrId: mr.id,
        mrIid: mr.iid,
        mrTitle: mr.title,
        mrUrl: mr.web_url,
        mrUpdatedAt: mr.updated_at,
      },
    };
  }
}
