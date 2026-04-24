/**
 * WorkRail Auto: Trigger System Types
 *
 * Domain types for the trigger webhook server. These are the stable public
 * contract for the src/trigger/ module.
 *
 * Design notes:
 * - TriggerId is branded to prevent accidental use of bare strings.
 * - TriggerDefinition is immutable (all readonly). Mutation only at load time.
 * - ContextMapping uses simple dot-path extraction (no full JSONPath for MVP).
 *   Array indexing (e.g. "$.labels[0]") is not supported; use a custom contextMapping
 *   field that targets a non-array value instead.
 * - TriggerSource carries delivery context so a future result-posting system can
 *   route the workflow output back to the originating system (e.g. post MR comment).
 * - PollingSource is a discriminated union of all polling source types, tagged by
 *   provider. Narrowing on pollingSource.provider gives the correct source type
 *   within each switch arm without unsafe casts.
 * - GitLabPollingSource: provider === 'gitlab_poll'
 * - GitHubPollingSource: provider === 'github_issues_poll' | 'github_prs_poll'
 * - WorkspaceName / WorkspaceConfig implement Phase 1 of workspace namespacing.
 *   Phase 2 (session metadata) and Phase 3 (per-workspace concurrency) are deferred.
 */

// ---------------------------------------------------------------------------
// TriggerId: branded string to prevent accidental string substitution
// ---------------------------------------------------------------------------

export type TriggerId = string & { readonly _brand: 'TriggerId' };

export function asTriggerId(value: string): TriggerId {
  return value as TriggerId;
}

// ---------------------------------------------------------------------------
// WorkspaceName: branded string to prevent bare-string substitution
//
// Identifies a named workspace entry in ~/.workrail/config.json.
// Format: ^[a-zA-Z0-9_-]+$ (validated at parse time by trigger-store.ts).
// Follows the same pattern as TriggerId.
// ---------------------------------------------------------------------------

export type WorkspaceName = string & { readonly _brand: 'WorkspaceName' };

export function asWorkspaceName(value: string): WorkspaceName {
  return value as WorkspaceName;
}

// ---------------------------------------------------------------------------
// WorkspaceConfig: per-workspace configuration entry from ~/.workrail/config.json
//
// Phase 1: path + soulFile only.
// Phase 3 (future): add maxConcurrentSessions when the concurrency gate ships.
//   Do NOT add maxConcurrentSessions here until then.
// ---------------------------------------------------------------------------

export interface WorkspaceConfig {
  /** Absolute path to the workspace directory. */
  readonly path: string;
  /**
   * Optional workspace-specific daemon soul file path.
   * Cascade (most-to-least specific):
   *   1. TriggerDefinition.soulFile (trigger-level override in triggers.yml)
   *   2. WorkspaceConfig.soulFile (this field -- workspace default)
   *   3. ~/.workrail/daemon-soul.md (global fallback, applied at runtime)
   *   4. DAEMON_SOUL_DEFAULT (built-in constant)
   * Resolved at trigger parse time by trigger-store.ts into TriggerDefinition.soulFile.
   */
  readonly soulFile?: string;
}

// ---------------------------------------------------------------------------
// ContextMapping: maps webhook payload fields to workflow context variables
//
// Dot-path extraction: "$.pull_request.html_url" -> payload.pull_request.html_url
// Leading "$." is optional and stripped before traversal.
// Array indexing (e.g. "$.labels[0]") logs a warning and returns undefined.
// ---------------------------------------------------------------------------

export interface ContextMappingEntry {
  /** The workflow context variable to populate. */
  readonly workflowContextKey: string;
  /** Dot-path into the normalized payload. Leading "$." is optional and stripped. */
  readonly payloadPath: string;
  /** When true, a missing value logs a warning. When false, silently omitted. */
  readonly required?: boolean;
}

export interface ContextMapping {
  readonly mappings: readonly ContextMappingEntry[];
}

// ---------------------------------------------------------------------------
// GitLabPollingSource: configuration for GitLab MR polling triggers
//
// Used when provider === 'gitlab_poll'. The polling scheduler reads this to
// determine how to poll the GitLab API for new or updated merge requests.
//
// Invariants:
// - token is already resolved from environment (never a $SECRET_NAME ref here).
// - events is stored as a string array (space-separated in YAML, split at parse time).
//   Example YAML: "events: merge_request.opened merge_request.updated"
//   Parsed to: ["merge_request.opened", "merge_request.updated"]
// - pollIntervalSeconds defaults to 60 if not specified in YAML.
//
// The GitLab MR list API does not filter by event type -- all open MRs updated
// since lastPollAt are fetched, then filtered client-side against the events list.
// ---------------------------------------------------------------------------

export interface GitLabPollingSource {
  /** Base URL of the GitLab instance. Example: "https://gitlab.com" */
  readonly baseUrl: string;
  /**
   * GitLab project ID (numeric string) or namespace/project path.
   * Example: "12345" or "my-group/my-project"
   */
  readonly projectId: string;
  /**
   * GitLab personal access token or project access token.
   * Already resolved from environment (never a $SECRET_NAME ref here).
   * Requires at least read_api scope.
   */
  readonly token: string;
  /**
   * Event types to react to. Used as a client-side filter on poll results.
   * Supported values: "merge_request.opened", "merge_request.updated"
   *
   * Specified as space-separated scalar in triggers.yml (same pattern as
   * referenceUrls -- the narrow YAML parser does not support inline arrays).
   * Example: "events: merge_request.opened merge_request.updated"
   */
  readonly events: readonly string[];
  /**
   * How often to poll in seconds. Default: 60.
   * If a poll cycle takes longer than this interval, the next cycle is skipped
   * and a warning is logged (never two concurrent polls for the same trigger).
   */
  readonly pollIntervalSeconds: number;
}

// ---------------------------------------------------------------------------
// GitHubPollingSource: configuration for GitHub Issues and PRs polling triggers
//
// Used when provider === 'github_issues_poll' or provider === 'github_prs_poll'.
//
// Invariants:
// - token is already resolved from environment (never a $SECRET_NAME ref here).
// - repo is in "owner/repo" format (e.g. "acme/my-project").
// - excludeAuthors uses exact string match (not glob). Case-sensitive.
//   TODO(follow-up): add glob pattern matching (e.g. "worktrain-*").
// - pollIntervalSeconds defaults to 60 if not specified in YAML.
//
// API used:
//   Issues: GET /repos/:owner/:repo/issues?state=open&since=<ISO8601>&sort=updated
//   PRs:    GET /repos/:owner/:repo/pulls?state=open&sort=updated&direction=desc
//   Note: the Issues endpoint returns open PRs too (a PR is also an issue).
//         Use github_prs_poll for PR-only polling.
//   Note: PRs have no server-side "since" filter -- updated_at is filtered client-side.
//
// IMPORTANT: Set excludeAuthors to your WorkTrain bot account login (e.g. "worktrain-bot").
// If omitted, the adapter will dispatch workflows for PRs/issues authored by WorkTrain
// itself, creating an infinite self-review loop.
//
// Rate limiting: GitHub API allows 5000 requests/hour for authenticated requests.
// If X-RateLimit-Remaining < 100, the poll cycle is skipped and a warning is logged.
// ---------------------------------------------------------------------------

export interface GitHubPollingSource {
  /**
   * GitHub repository in "owner/repo" format.
   * Example: "acme/my-project"
   */
  readonly repo: string;
  /**
   * GitHub personal access token or fine-grained PAT.
   * Already resolved from environment (never a $SECRET_NAME ref here).
   * Requires at least repo:read scope.
   */
  readonly token: string;
  /**
   * Event types to react to. Used as a client-side filter on poll results.
   * For github_issues_poll: "issues.opened", "issues.updated"
   * For github_prs_poll: "pull_request.opened", "pull_request.updated"
   *
   * Specified as space-separated scalar in triggers.yml.
   * Example: "events: issues.opened issues.updated"
   */
  readonly events: readonly string[];
  /**
   * How often to poll in seconds. Default: 60.
   * Recommended: 300 (5 min) for PRs, 300 for issues.
   * At 5-min poll: ~42 requests/hour -- well within the 5000/hour limit.
   */
  readonly pollIntervalSeconds: number;
  /**
   * GitHub logins to exclude from dispatch. Exact string match (case-sensitive).
   * IMPORTANT: include your WorkTrain bot account login here to prevent infinite
   * self-review loops (e.g. "worktrain-bot").
   *
   * Space-separated in triggers.yml: "excludeAuthors: worktrain-bot dependabot[bot]"
   * Parsed to: ["worktrain-bot", "dependabot[bot]"]
   *
   * TODO(follow-up): add glob pattern matching for bot accounts with variable suffixes.
   */
  readonly excludeAuthors: readonly string[];
  /**
   * Labels to EXCLUDE from dispatch (client-side filter).
   * Items with ANY of these labels are skipped.
   *
   * Note: this filter runs after fetching. With pagination limited to 100 items,
   * a repo with many notLabels-matching items may miss some new items per cycle.
   *
   * Space-separated in triggers.yml: "notLabels: wont-fix duplicate"
   */
  readonly notLabels: readonly string[];
  /**
   * Labels to INCLUDE -- passed as `labels=` query parameter to the GitHub API.
   * Only items with ALL listed labels are returned.
   *
   * Space-separated in triggers.yml: "labelFilter: bug high-priority"
   */
  readonly labelFilter: readonly string[];
}

// ---------------------------------------------------------------------------
// GitHubQueuePollingSource: configuration for GitHub queue-poll triggers.
//
// Used when provider === 'github_queue_poll'. Queue filter params are read
// from ~/.workrail/config.json at poll time. Trigger only provides repo,
// token, and poll interval.
//
// Invariants:
// - token is already resolved from environment (never a $SECRET_NAME ref here).
// - repo is in "owner/repo" format.
// - pollIntervalSeconds defaults to 300 if not specified.
// ---------------------------------------------------------------------------

export interface GitHubQueuePollingSource {
  /** GitHub repository in "owner/repo" format. */
  readonly repo: string;
  /**
   * GitHub personal access token for the bot account.
   * Already resolved from environment (never a $SECRET_NAME ref here).
   * Requires at least repo:read scope.
   */
  readonly token: string;
  /** How often to poll in seconds. Default: 300. */
  readonly pollIntervalSeconds: number;
  /**
   * Queue filter type from triggers.yml queueType field.
   * Maps to GitHubQueueConfig.type. When present, the polling scheduler
   * may use this to override or supplement the global config.json queue type.
   * Example values: 'assignee', 'label'
   */
  readonly queueType?: string;
  /**
   * Label name for label-based queue filtering, from triggers.yml queueLabel field.
   * Only relevant when queueType === 'label'.
   * Example: 'worktrain:ready'
   */
  readonly queueLabel?: string;
}

// ---------------------------------------------------------------------------
// TaskCandidate: the structured output of the queue picker, injected into
// the dispatched session as context.taskCandidate.
//
// Invariants:
// - inferredMaturity is produced by exactly 3 deterministic heuristics (see pitch).
//   It is NOT an LLM call.
// - upstreamSpecUrl: extracted from upstream_spec: line or first paragraph URL.
// - queueConfigType: snapshot of the queue config type that produced this candidate.
// ---------------------------------------------------------------------------

export interface TaskCandidate {
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly inferredMaturity: 'idea' | 'specced' | 'ready';
  readonly upstreamSpecUrl?: string;
  readonly queueConfigType: 'assignee' | 'label' | 'mention' | 'query';
}

// ---------------------------------------------------------------------------
// PollingSource: discriminated union of all polling source configurations
//
// Tagged by provider so the polling scheduler can narrow to the correct source
// type with a switch(pollingSource.provider) without unsafe casts.
//
// Usage in polling-scheduler.ts:
//   switch (trigger.pollingSource.provider) {
//     case 'gitlab_poll':        /* GitLabPollingSource */ break;
//     case 'github_issues_poll': /* GitHubPollingSource */ break;
//     case 'github_prs_poll':    /* GitHubPollingSource */ break;
//     case 'github_queue_poll':  /* GitHubQueuePollingSource */ break;
//   }
// ---------------------------------------------------------------------------

export type PollingSource =
  | (GitLabPollingSource & { readonly provider: 'gitlab_poll' })
  | (GitHubPollingSource & { readonly provider: 'github_issues_poll' })
  | (GitHubPollingSource & { readonly provider: 'github_prs_poll' })
  | (GitHubQueuePollingSource & { readonly provider: 'github_queue_poll' });

// ---------------------------------------------------------------------------
// TriggerDefinition: a single configured trigger loaded from triggers.yml
// ---------------------------------------------------------------------------

export interface TriggerDefinition {
  /** Stable identifier. Used as the URL path segment: POST /webhook/:id */
  readonly id: TriggerId;

  /**
   * Provider name.
   * "generic"             = any HTTP POST with optional HMAC validation (webhook trigger).
   * "gitlab_poll"         = polling trigger that fetches GitLab MRs on a schedule.
   * "github_issues_poll"  = polling trigger that fetches GitHub Issues on a schedule.
   * "github_prs_poll"     = polling trigger that fetches GitHub PRs on a schedule.
   *
   * When provider is a polling provider, pollingSource must be present with the
   * corresponding tagged PollingSource type. Validated at load time.
   * When provider === 'generic', pollingSource must be absent.
   */
  readonly provider: string;

  /** WorkRail workflow ID to start when this trigger fires. */
  readonly workflowId: string;

  /** Absolute path to the workspace for the spawned workflow session. */
  readonly workspacePath: string;

  /** Short goal description passed to start_workflow. */
  readonly goal: string;

  /**
   * HMAC-SHA256 secret for validating X-WorkRail-Signature header.
   * Already resolved from environment (never a $SECRET_NAME ref here).
   * When absent, HMAC validation is skipped (open trigger).
   * Only applies to provider === 'generic' triggers.
   */
  readonly hmacSecret?: string;

  /**
   * Optional mapping from payload fields to workflow context variables.
   * When absent, the raw payload is passed as context.payload.
   * Only applies to provider === 'generic' triggers.
   */
  readonly contextMapping?: ContextMapping;

  /**
   * Mustache-style goal template. Tokens `{{$.dot.path}}` are replaced with
   * values extracted from the webhook payload at dispatch time.
   * Falls back to the static `goal` field if any token resolves to undefined.
   *
   * Example: "Review MR: {{$.pull_request.title}} by {{$.user.login}}"
   */
  readonly goalTemplate?: string;

  /**
   * Reference URLs injected into the system prompt so the agent can fetch
   * and read them before starting work.
   *
   * In YAML, specify as a space-separated scalar (MVP limitation -- the narrow
   * parser does not support YAML sequences):
   *   referenceUrls: "https://doc1 https://doc2"
   *
   * TODO(follow-up): support native YAML list syntax when the parser is extended.
   */
  readonly referenceUrls?: readonly string[];

  /**
   * Optional condition that must be true for the trigger to dispatch.
   * Checked against the webhook payload before enqueueing.
   * When absent: always dispatch (current behavior).
   *
   * WHY: enables safe webhook triggers for queue use cases -- e.g., only fire
   * when `assignee.login === 'worktrain-etienneb'` so shared GitHub webhooks
   * can be scoped to a specific bot account without a separate endpoint.
   *
   * MVP: equals-only (strict string match). No regex, no AND/OR, no nested conditions.
   * When a skip occurs, route() returns { _tag: 'enqueued' } (silent -- the 202 was
   * already sent) and a debug log line is emitted for observability.
   *
   * In YAML:
   *   dispatchCondition:
   *     payloadPath: "$.assignee.login"
   *     equals: "worktrain-etienneb"
   *
   * payloadPath uses the same dot-path syntax as contextMapping.payloadPath.
   * Leading "$." is optional and stripped before traversal.
   * Array indexing (e.g. "$.labels[0]") returns undefined -> condition not met.
   */
  readonly dispatchCondition?: {
    /** Dot-path into the webhook payload. Same syntax as contextMapping payloadPath. */
    readonly payloadPath: string;
    /** Dispatch only when the extracted value strictly equals this string. */
    readonly equals: string;
  };

  /**
   * Optional agent configuration overrides for this trigger.
   * When absent, the default model selection (env-based) is used.
   */
  readonly agentConfig?: {
    /**
     * Model to use in provider/model-id format.
     * Example: "amazon-bedrock/claude-sonnet-4-6"
     * When absent, env-based model detection applies.
     */
    readonly model?: string;
    /**
     * Maximum wall-clock time (in minutes) for a single workflow run.
     * If the agent loop does not complete within this window, the run is
     * aborted and returns { _tag: 'timeout', reason: 'wall_clock' }.
     *
     * WHY: a stuck tool call, infinite retry loop, or runaway LLM can hold a
     * queue slot indefinitely. This cap is the safety valve.
     *
     * Default: 30 minutes (when absent or undefined).
     * Must be a positive integer (>= 1). Value of 0 is invalid -- omit the field
     * to use the default.
     */
    readonly maxSessionMinutes?: number;
    /**
     * Maximum number of LLM response turns allowed for a single workflow run.
     * If the agent exceeds this count, the run is aborted and returns
     * { _tag: 'timeout', reason: 'max_turns' }.
     *
     * WHY: an LLM that loops (repeatedly calling tools without advancing the
     * workflow) would otherwise run until the wall-clock timeout. A turn limit
     * catches this class of runaway loop more aggressively.
     *
     * A "turn" is one complete LLM response (which may include multiple tool
     * calls). Counted via pi-agent-core's turn_end event.
     *
     * Default: no limit (when absent or undefined).
     * Must be a positive integer (>= 1). Value of 0 is invalid -- omit the field
     * for no turn limit.
     */
    readonly maxTurns?: number;
    /**
     * Maximum number of output tokens allowed in a single LLM response.
     * Passed directly to the Anthropic API as max_tokens for every LLM request
     * in this trigger's sessions.
     *
     * WHY: Claude Sonnet supports up to 64K output tokens, but the daemon default
     * is 8192. Complex code generation tasks silently stop mid-output when the
     * ceiling is too low. This field lets operators raise the ceiling per trigger.
     *
     * Typical values:
     * - 8192  -- default (sufficient for most tasks)
     * - 32768 -- recommended for complex multi-file code generation
     * - 64000 -- Sonnet 4.x maximum (check model-specific limits in Anthropic docs)
     *
     * NOTE: the value is passed through as-is -- the daemon does NOT validate
     * against model-specific ceilings. If the value exceeds the model's supported
     * maximum, the Anthropic API returns a clear error at runtime.
     *
     * Default: 8192 (AgentLoop built-in, applied when field is absent).
     * Must be a positive integer (>= 1). Value of 0 is invalid -- omit the field
     * to use the default.
     */
    readonly maxOutputTokens?: number;
    /**
     * Abort policy when stuck detection fires.
     * - 'abort' (default): call agent.abort() and return _tag: 'stuck'.
     * - 'notify_only': write to outbox.jsonl but do NOT abort the session.
     */
    readonly stuckAbortPolicy?: 'abort' | 'notify_only';
    /**
     * When true, the no_progress heuristic (80%+ of turns with 0 step advances)
     * also participates in stuck-abort (subject to stuckAbortPolicy).
     * Default: false.
     */
    readonly noProgressAbortEnabled?: boolean;
  };

  /**
   * Concurrency mode for this trigger.
   *
   * - 'serial' (default): concurrent webhook fires for this trigger are serialized via
   *   KeyedAsyncQueue. Only one run executes at a time per trigger. This is the safe
   *   default -- it prevents token corruption when two webhooks fire concurrently.
   * - 'parallel': each webhook fire gets its own queue slot (unique key per invocation).
   *   Use only when concurrent runs for this trigger are intentional and safe.
   *
   * This field is always present after parse (never undefined). The default 'serial' is
   * applied at parse time in trigger-store.ts, not at use time.
   *
   * WARNING -- capacity and safety:
   * - 'serial' mode queues fires in an unbounded promise chain. Under burst load (many
   *   webhook fires in rapid succession), the chain can grow without bound. Each queued
   *   run holds a promise in memory until it executes.
   * - 'parallel' mode places no limit on concurrent runWorkflow() calls. Each fire
   *   launches an independent agent session immediately. Without a maxConcurrentSessions
   *   cap, this can exhaust API rate limits or machine resources.
   * Recommendation: use 'parallel' only when workflows are short-lived (seconds to
   * low minutes) or when a maxConcurrentSessions cap is configured in your deployment.
   *
   * In YAML:
   *   concurrencyMode: serial    # default, may be omitted
   *   concurrencyMode: parallel  # opt-in to concurrent execution
   */
  readonly concurrencyMode: 'serial' | 'parallel';

  /**
   * Optional HTTP(S) callback URL. When set, TriggerRouter POSTs the
   * WorkflowRunResult JSON to this URL after runWorkflow() completes,
   * regardless of whether the workflow succeeded or failed.
   *
   * A failed POST produces a WorkflowRunResult with _tag: 'delivery_failed'
   * so the failure is never silent. A missing or failing callbackUrl never
   * causes the daemon to throw -- errors are represented as data.
   *
   * Must be a static http:// or https:// URL. $ENV_VAR_NAME resolution is
   * not supported for this field in MVP.
   *
   * TODO(follow-up): add retry, auth headers, and $ENV_VAR_NAME resolution.
   */
  readonly callbackUrl?: string;

  /**
   * When true, the daemon automatically runs `git add <filesChanged> && git commit`
   * after a successful workflow run. Reads the structured handoff artifact from the
   * last step's notes to build the commit message.
   *
   * WHY scripts over agent: committing is deterministic and has no ambiguity.
   * The daemon reads the agent's handoff note and runs git commands itself --
   * never delegates this to the LLM. See docs/ideas/backlog.md "scripts over agent".
   *
   * Default: false (opt-in only). The daemon never commits without explicit true.
   */
  readonly autoCommit?: boolean;

  /**
   * When false, skip the secret scan before committing. Default: true (scan runs).
   *
   * WHY opt-out (not opt-in): the safer default is to scan. Operators who encounter
   * false positives from the Generic secret assign pattern can explicitly disable
   * the scan with secretScan: false in triggers.yml.
   *
   * Only meaningful when autoCommit: true. Has no effect when autoCommit is false.
   * In YAML:   secretScan: false
   */
  readonly secretScan?: boolean;

  /**
   * When true (and autoCommit is also true), the daemon runs `gh pr create` after
   * a successful commit. Reads prTitle and prBody from the handoff artifact.
   *
   * Requires autoCommit: true. If autoOpenPR is true but autoCommit is false or
   * absent, a warning is emitted at config load time and delivery is skipped.
   *
   * Default: false.
   */
  readonly autoOpenPR?: boolean;

  /**
   * Completion hook configuration (parsed but NOT executed in MVP).
   * Emits a load-time warning for runOn !== 'success'.
   *
   * TODO(follow-up): implement execution for all runOn values.
   */
  readonly onComplete?: {
    /**
     * When to run the completion hook.
     * Only 'success' is planned for implementation. 'failure' and 'always'
     * are accepted by the parser but log a warning and are not executed.
     */
    readonly runOn: 'success' | 'failure' | 'always';
    /** Workflow to run on completion. When absent, no workflow is triggered. */
    readonly workflowId?: string;
    /** Goal passed to the completion workflow. */
    readonly goal?: string;
  };

  /**
   * Polling source configuration. Present when provider is a polling provider
   * ('gitlab_poll', 'github_issues_poll', 'github_prs_poll').
   * Absent for webhook (generic) triggers.
   *
   * Typed as a PollingSource discriminated union tagged by provider. Use
   * switch(pollingSource.provider) in the scheduler to narrow to the correct
   * source type without unsafe casts.
   *
   * The polling scheduler uses this to determine how and when to poll the
   * external API. The webhook routing path (TriggerRouter.route()) never reads
   * this field -- it is only consumed by PollingScheduler.
   */
  readonly pollingSource?: PollingSource;

  /**
   * Optional named workspace this trigger belongs to.
   * When set, trigger-store.ts resolves workspacePath from WorkspaceConfig.path
   * at parse time. Unknown names cause a per-trigger soft error (daemon continues).
   * Format: ^[a-zA-Z0-9_-]+$ (validated at parse time).
   * Phase 2 (future): DaemonEntry.workspaceName for console filtering.
   */
  readonly workspaceName?: WorkspaceName;

  /**
   * Optional resolved soul file path for this trigger's agent runs.
   * Set by trigger-store.ts after cascade resolution:
   *   trigger YAML soulFile -> workspace soulFile -> undefined.
   * When absent, workflow-runner.ts falls back to ~/.workrail/daemon-soul.md.
   * In YAML:   soulFile: "~/.workrail/workspaces/my-project/daemon-soul.md"
   */
  readonly soulFile?: string;

  /**
   * Branch isolation strategy for this trigger's workflow sessions.
   *
   * - 'none' (default): no git worktree is created. The session uses
   *   trigger.workspacePath directly (existing behavior). Safe for read-only
   *   triggers (MR review, polling analysis) where the session does not commit.
   * - 'worktree': runWorkflow() creates an isolated git worktree at
   *   ~/.workrail/worktrees/<sessionId> on a fresh branch before the agent loop
   *   starts. Each concurrent session gets its own checkout. The branch is pushed
   *   and the worktree is removed after successful delivery. Kept for debugging
   *   on failure or timeout.
   *
   * WHY: Without worktree isolation, concurrent coding sessions corrupt the main
   * checkout. With 'worktree', trigger.workspacePath is never modified -- all
   * agent writes go to the isolated checkout. trigger.workspacePath continues to
   * be used for git operations (-C flag) that target the repo, not the worktree.
   *
   * Default: 'worktree' when autoCommit or autoOpenPR is true; 'none' otherwise.
   * Explicit 'branchStrategy: none' is the opt-out when autoCommit/autoOpenPR is set.
   * In YAML: branchStrategy: worktree
   */
  readonly branchStrategy?: 'worktree' | 'none';

  /**
   * Base branch for the worktree. Only used when branchStrategy === 'worktree'.
   *
   * The session branch is created from origin/<baseBranch>. The remote branch
   * is fetched as an auth pre-flight before worktree creation.
   *
   * Default: 'main'.
   * In YAML: baseBranch: main
   */
  readonly baseBranch?: string;

  /**
   * Prefix for the session branch name. Only used when branchStrategy === 'worktree'.
   *
   * The full branch name is `${branchPrefix}${sessionId}`.
   * Example: 'worktrain/' + 'abc123' = 'worktrain/abc123'.
   *
   * Default: 'worktrain/'.
   * In YAML: branchPrefix: "worktrain/"
   */
  readonly branchPrefix?: string;
}

// ---------------------------------------------------------------------------
// TriggerConfig: the full deserialized triggers.yml
// ---------------------------------------------------------------------------

export interface TriggerConfig {
  readonly triggers: readonly TriggerDefinition[];
}

// ---------------------------------------------------------------------------
// TriggerSource: delivery context stored at session start
//
// Carries routing info so a future delivery system can post results back
// to the originating system (e.g., post a GitLab MR comment).
// ---------------------------------------------------------------------------

export interface TriggerSource {
  readonly triggerId: TriggerId;
  readonly provider: string;
  /** Raw normalized payload from the incoming webhook. */
  readonly rawPayload: Readonly<Record<string, unknown>>;
  /** ISO 8601 timestamp when the trigger fired. */
  readonly firedAt: string;
}

// ---------------------------------------------------------------------------
// WebhookEvent: the internal representation of an incoming webhook request
// ---------------------------------------------------------------------------

export interface WebhookEvent {
  readonly triggerId: TriggerId;
  /** Raw request body bytes (preserved for HMAC computation). */
  readonly rawBody: Buffer;
  /** Parsed JSON payload (from rawBody). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** X-WorkRail-Signature header value (optional). */
  readonly signature?: string;
}

// ---------------------------------------------------------------------------
// TriggerValidationRule: stable rule identifiers for semantic validation.
//
// INVARIANT: Every rule that causes validateAndResolveTrigger() to return
// a TriggerStoreError MUST have a corresponding entry here with severity
// 'error' in validateTriggerStrict(). Run 'worktrain trigger validate'
// to check both layers simultaneously. Sync enforced by unit test.
//
// Rule IDs are kebab-case strings used for programmatic identification
// (scripting, CI integration, documentation). They are stable -- do not
// rename a rule ID once it ships.
// ---------------------------------------------------------------------------

export type TriggerValidationRule =
  /** autoCommit: true AND branchStrategy absent or 'none' -- checkout corruption risk */
  | 'autocommit-needs-worktree'
  /** autoOpenPR: true AND autoCommit not true -- PR requires a commit */
  | 'autoopenpr-needs-autocommit'
  /** branchStrategy: 'worktree' AND baseBranch absent */
  | 'worktree-needs-base-branch'
  /** branchStrategy: 'worktree' AND branchPrefix absent */
  | 'worktree-needs-prefix'
  /** concurrencyMode: 'parallel' AND branchStrategy absent or 'none' -- concurrent clobber risk */
  | 'parallel-without-worktree'
  /** goalTemplate absent AND no static goal -- agent will use sentinel "Autonomous task" */
  | 'missing-goal-template'
  /** agentConfig.maxSessionMinutes absent -- effective default is 30 minutes */
  | 'missing-max-session-minutes'
  /** agentConfig.maxTurns absent -- no turn limit will apply */
  | 'missing-max-turns'
  /** autoCommit: true AND branchStrategy: 'none' explicit -- latent danger in serial mode */
  | 'autocommit-on-main-checkout';

// ---------------------------------------------------------------------------
// TriggerValidationIssue: a single named validation issue for a trigger.
//
// Returned by validateTriggerStrict() and validateAllTriggers().
// severity 'error' issues match the hard errors in validateAndResolveTrigger().
// severity 'warning' and 'info' issues are informational -- they do not block
// daemon startup but are surfaced by 'worktrain trigger validate'.
// ---------------------------------------------------------------------------

export interface TriggerValidationIssue {
  /** Stable rule identifier. Used for programmatic identification and scripting. */
  readonly rule: TriggerValidationRule;
  /** Severity of the issue. 'error' = daemon would skip this trigger. */
  readonly severity: 'error' | 'warning' | 'info';
  /** The trigger ID this issue belongs to. */
  readonly triggerId: string;
  /** Human-readable description of the issue. */
  readonly message: string;
  /**
   * Optional suggested fix (config change that would resolve the issue).
   * Absent when no simple single-line fix applies.
   */
  readonly suggestedFix?: string;
}
