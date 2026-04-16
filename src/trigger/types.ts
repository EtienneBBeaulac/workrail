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
 */

// ---------------------------------------------------------------------------
// TriggerId: branded string to prevent accidental string substitution
// ---------------------------------------------------------------------------

export type TriggerId = string & { readonly _brand: 'TriggerId' };

export function asTriggerId(value: string): TriggerId {
  return value as TriggerId;
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
// PollingSource: discriminated union of all polling source configurations
//
// Tagged by provider so the polling scheduler can narrow to the correct source
// type with a switch(pollingSource.provider) without unsafe casts.
//
// Usage in polling-scheduler.ts:
//   switch (trigger.pollingSource.provider) {
//     case 'gitlab_poll':       /* trigger.pollingSource is GitLabPollingSource */ break;
//     case 'github_issues_poll': /* trigger.pollingSource is GitHubPollingSource */ break;
//     case 'github_prs_poll':   /* trigger.pollingSource is GitHubPollingSource */ break;
//   }
// ---------------------------------------------------------------------------

export type PollingSource =
  | (GitLabPollingSource & { readonly provider: 'gitlab_poll' })
  | (GitHubPollingSource & { readonly provider: 'github_issues_poll' })
  | (GitHubPollingSource & { readonly provider: 'github_prs_poll' });

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
  };

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
