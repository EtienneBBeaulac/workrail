/**
 * WorkTrain Trigger Test Command
 *
 * `worktrain trigger test <triggerId>` -- dry-run the queue picker for a
 * github_queue_poll trigger. Shows which issues would be dispatched and which
 * would be skipped, using real API calls but NEVER dispatching any sessions.
 *
 * Design invariants:
 * - DRY-RUN INVARIANT: this command NEVER dispatches sessions. Enforced by
 *   the absence of any dispatch function in WorktrainTriggerTestDeps.
 * - All I/O is injected via WorktrainTriggerTestDeps. Zero direct fs/fetch imports.
 * - All failures are returned as CliResult -- never thrown.
 * - Real API calls are permitted (to show accurate results).
 * - Exit code: 0 if >= 1 issue would dispatch, 1 if none (useful for scripts).
 *   The CliResult.failure return for 'no dispatch' is intentional -- it is a
 *   scripting convention, not an error condition.
 * - Skip logic mirrors doPollGitHubQueue in polling-scheduler.ts (SCOPE LOCK:
 *   do not add skip conditions without updating the scheduler too).
 */

import type { CliResult } from '../types/cli-result.js';
import { failure, success } from '../types/cli-result.js';
import type { TriggerDefinition } from '../../trigger/types.js';
import type { GitHubQueuePollingSource } from '../../trigger/types.js';
import type { GitHubQueueConfig } from '../../trigger/github-queue-config.js';
import type { GitHubQueueIssue } from '../../trigger/adapters/github-queue-poller.js';
import type { Result } from '../../runtime/result.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Injected dependencies for the trigger test command.
 * All real I/O is behind these interfaces for full testability.
 *
 * WHY no dispatch dep: the DRY-RUN INVARIANT is enforced at the type level.
 * Adding a dispatch dep here would require a conscious code change, not an accident.
 */
export interface WorktrainTriggerTestDeps {
  /**
   * Load the trigger config from triggers.yml.
   * Returns a Map<triggerId, TriggerDefinition> or an error string.
   * WHY injectable: allows tests to inject any trigger config without real files.
   */
  readonly loadTriggerConfig: () => Promise<Result<Map<string, TriggerDefinition>, string>>;
  /**
   * Load the queue config from ~/.workrail/config.json.
   * Returns null when no queue config is present.
   * WHY injectable: allows tests to inject queue configs without real files.
   */
  readonly loadQueueConfig: () => Promise<Result<GitHubQueueConfig | null, string>>;
  /**
   * Fetch open GitHub issues matching the queue config filter.
   * Takes the queue config (filter type, label/user, etc.) plus the polling source
   * (repo, token) from the trigger.
   * WHY injectable: allows tests to inject issue lists without real HTTP calls.
   */
  readonly pollGitHubQueueIssues: (
    source: GitHubQueuePollingSource,
    config: GitHubQueueConfig,
  ) => Promise<Result<GitHubQueueIssue[], string>>;
  /**
   * Count active sessions by scanning ~/.workrail/daemon-sessions/ for JSON files.
   * Returns 0 when the directory doesn't exist or is unreadable.
   * WHY injectable: allows tests to simulate any active session count.
   */
  readonly countActiveSessions: () => Promise<number>;
  /**
   * Check if an issue already has an active session.
   * Conservative default: returns 'active' on any read/parse error.
   * WHY injectable: allows tests to control per-issue idempotency state.
   */
  readonly checkIdempotency: (issueNumber: number) => Promise<'active' | 'clear'>;
  /**
   * Infer the maturity of an issue from its body.
   * Returns 'idea' | 'specced' | 'ready' using the 3 deterministic heuristics.
   * WHY injectable: allows tests to control maturity per issue.
   */
  readonly inferMaturity: (issue: GitHubQueueIssue) => 'idea' | 'specced' | 'ready';
  /**
   * Write a line to stdout (dry-run output).
   * WHY injectable: allows tests to capture all output for assertion.
   */
  readonly print: (line: string) => void;
  /**
   * Write a line to stderr (errors and warnings).
   * WHY injectable: allows tests to capture error output separately.
   */
  readonly stderr: (line: string) => void;
}

export interface WorktrainTriggerTestOpts {
  /** The trigger ID to test (e.g. 'self-improvement'). */
  readonly triggerId: string;
  /** Override the console HTTP server port for active session count. Not used by this command. */
  readonly port?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the dry-run trigger test command.
 *
 * Returns success (exit 0) if at least one issue would be dispatched.
 * Returns failure (exit 1) if no issues would be dispatched.
 *
 * WHY failure for 'no dispatch': the exit code convention is explicitly specified
 * for scripting use cases (e.g. CI checks that verify a trigger has work to do).
 * It is NOT a runtime error -- all dry-run output is printed via deps.print().
 */
export async function executeWorktrainTriggerTestCommand(
  deps: WorktrainTriggerTestDeps,
  opts: WorktrainTriggerTestOpts,
): Promise<CliResult> {
  const triggerId = opts.triggerId.trim();
  if (!triggerId) {
    deps.stderr('[DryRun] Error: triggerId must not be empty.');
    return failure('triggerId must not be empty.');
  }

  // ---- Load trigger config ----
  const triggerIndexResult = await deps.loadTriggerConfig();
  if (triggerIndexResult.kind === 'err') {
    deps.stderr(`[DryRun] Error: Failed to load triggers.yml: ${triggerIndexResult.error}`);
    return failure(`Failed to load triggers.yml: ${triggerIndexResult.error}`);
  }

  const triggerIndex = triggerIndexResult.value;
  const trigger = triggerIndex.get(triggerId);
  if (!trigger) {
    deps.stderr(`[DryRun] Error: Trigger '${triggerId}' not found in triggers.yml.`);
    return failure(`Trigger '${triggerId}' not found in triggers.yml.`);
  }

  // ---- Validate provider ----
  if (trigger.provider !== 'github_queue_poll') {
    deps.stderr(
      `[DryRun] Error: Trigger '${triggerId}' is not a queue poll trigger -- ` +
      `only github_queue_poll triggers can be tested with this command`,
    );
    return failure(
      `Trigger '${triggerId}' is not a queue poll trigger -- ` +
      `only github_queue_poll triggers can be tested with this command`,
    );
  }

  // Safe: provider === 'github_queue_poll' guarantees pollingSource is GitHubQueuePollingSource
  const pollingSource = trigger.pollingSource as GitHubQueuePollingSource;

  // ---- Load queue config ----
  const queueConfigResult = await deps.loadQueueConfig();
  if (queueConfigResult.kind === 'err') {
    deps.stderr(`[DryRun] Error: Failed to load queue config: ${queueConfigResult.error}`);
    return failure(`Failed to load queue config: ${queueConfigResult.error}`);
  }

  const queueConfig = queueConfigResult.value;
  if (queueConfig === null) {
    deps.stderr('[DryRun] Error: No queue config found in ~/.workrail/config.json (missing "queue" key).');
    return failure('No queue config found in ~/.workrail/config.json (missing "queue" key).');
  }

  // ---- Active session count ----
  const activeSessions = await deps.countActiveSessions();

  // ---- Print header ----
  deps.print(`[DryRun] Trigger: ${triggerId} (${trigger.provider})`);
  deps.print(
    `[DryRun] Queue config: type=${queueConfig.type}${queueConfig.queueLabel ? ` queueLabel=${queueConfig.queueLabel}` : ''}${queueConfig.user ? ` user=${queueConfig.user}` : ''} repo=${queueConfig.repo}`,
  );
  deps.print(
    `[DryRun] Active sessions: ${activeSessions} / maxTotalConcurrentSessions: ${queueConfig.maxTotalConcurrentSessions}`,
  );
  deps.print('');

  // ---- Concurrency cap check (mirrors doPollGitHubQueue invariant) ----
  // WHY check before fetching: the real scheduler skips the entire cycle when
  // the concurrency cap is reached. The dry-run reflects this same behavior.
  if (activeSessions >= queueConfig.maxTotalConcurrentSessions) {
    deps.print(
      `[DryRun] Concurrency cap reached: active sessions (${activeSessions}) >= ` +
      `maxTotalConcurrentSessions (${queueConfig.maxTotalConcurrentSessions})`,
    );
    deps.print('[DryRun] Summary: 0 would dispatch, 0 would skip (concurrency cap)');
    // WHY failure: exit 1 signals 'no dispatch' for scripting use cases
    return failure('');
  }

  // ---- Fetch issues ----
  const issuesResult = await deps.pollGitHubQueueIssues(pollingSource, queueConfig);
  if (issuesResult.kind === 'err') {
    deps.stderr(`[DryRun] Error: Failed to fetch issues: ${issuesResult.error}`);
    return failure(`Failed to fetch issues: ${issuesResult.error}`);
  }

  const issues = issuesResult.value;

  // ---- Classify each issue (mirrors doPollGitHubQueue skip logic -- SCOPE LOCK) ----
  type IssueDecision =
    | { readonly kind: 'dispatch'; readonly issue: GitHubQueueIssue; readonly maturity: 'idea' | 'specced' | 'ready'; readonly upstreamSpecUrl: string | undefined }
    | { readonly kind: 'skip'; readonly issue: GitHubQueueIssue; readonly reason: string };

  const decisions: IssueDecision[] = [];

  for (const issue of issues) {
    const issueLabels = issue.labels.map((l) => l.name);

    // H: excludeLabels filter
    const excludedLabel = queueConfig.excludeLabels.find((el) => issueLabels.includes(el));
    if (excludedLabel) {
      decisions.push({ kind: 'skip', issue, reason: `excluded_label: ${excludedLabel}` });
      continue;
    }

    // H3: worktrain:in-progress label (active/skip -- not a maturity level)
    if (issueLabels.includes('worktrain:in-progress')) {
      decisions.push({ kind: 'skip', issue, reason: 'active_session_or_in_progress' });
      continue;
    }

    // H3: session ID pattern in body (active/skip)
    if (/sess_[a-z0-9]+/.test(issue.body)) {
      decisions.push({ kind: 'skip', issue, reason: 'active_session_or_in_progress' });
      continue;
    }

    // Per-issue idempotency check (conservative: any parse error = active)
    const idempotencyStatus = await deps.checkIdempotency(issue.number);
    if (idempotencyStatus === 'active') {
      decisions.push({ kind: 'skip', issue, reason: 'active_session' });
      continue;
    }

    // Infer maturity (exactly 3 heuristics -- SCOPE LOCK per github-queue-poller.ts)
    const maturity = deps.inferMaturity(issue);

    // Only 'ready' and 'specced' would dispatch; 'idea' is skipped
    if (maturity === 'idea') {
      decisions.push({ kind: 'skip', issue, reason: 'maturity=idea (no spec, no checklist)' });
      continue;
    }

    decisions.push({
      kind: 'dispatch',
      issue,
      maturity,
      upstreamSpecUrl: extractUpstreamSpecUrl(issue.body),
    });
  }

  // ---- Print per-issue results ----
  for (const decision of decisions) {
    if (decision.kind === 'dispatch') {
      deps.print(`[DryRun] Issue #${decision.issue.number} "${decision.issue.title}" -- WOULD DISPATCH`);
      deps.print(`  maturity: ${decision.maturity} (${describeMaturity(decision.maturity)})`);
      deps.print(`  upstreamSpecUrl: ${decision.upstreamSpecUrl ?? '(none)'}`);
    } else {
      deps.print(`[DryRun] Issue #${decision.issue.number} "${decision.issue.title}" -- WOULD SKIP`);
      deps.print(`  reason: ${decision.reason}`);
    }
    deps.print('');
  }

  // ---- Summary ----
  const dispatchCount = decisions.filter((d) => d.kind === 'dispatch').length;
  const skipCount = decisions.filter((d) => d.kind === 'skip').length;
  deps.print(`[DryRun] Summary: ${dispatchCount} would dispatch, ${skipCount} would skip`);

  // WHY failure for 0 dispatch: exit 1 is explicitly specified for scripting use cases.
  // This is NOT a runtime error -- all output was already printed via deps.print().
  if (dispatchCount === 0) {
    return failure('');
  }

  return success();
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract the upstream spec URL from an issue body.
 *
 * WHY duplicated from polling-scheduler.ts: that function is private to the scheduler.
 * This is a 2-line extraction matching the same heuristic. If the heuristic changes,
 * update both (they are part of the SCOPE LOCK on 3 maturity heuristics).
 */
function extractUpstreamSpecUrl(body: string): string | undefined {
  const specLineMatch = /upstream_spec:\s*(https?:\/\/\S+)/i.exec(body);
  if (specLineMatch?.[1]) return specLineMatch[1];
  const firstPara = body.split(/\n\s*\n/)[0] ?? '';
  const urlMatch = /(https?:\/\/\S+)/.exec(firstPara);
  return urlMatch?.[1];
}

/**
 * Human-readable description of a maturity level.
 * Matches the labels shown in the spec's example output.
 */
function describeMaturity(maturity: 'idea' | 'specced' | 'ready'): string {
  switch (maturity) {
    case 'ready':   return 'has acceptance criteria';
    case 'specced': return 'has checklist or acceptance criteria heading';
    case 'idea':    return 'no spec, no checklist';
  }
}
