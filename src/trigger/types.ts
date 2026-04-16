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
 * - GitLabPollingSource is the first polling trigger source type (provider: gitlab_poll).
 *   It is an optional additive field on TriggerDefinition alongside the webhook fields.
 *   This is a stepping-stone design -- at 3+ polling adapter types, migrate to a
 *   discriminated union on TriggerDefinition. TODO(follow-up): migrate at adapter #2.
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
//
// TODO(follow-up): when a second polling adapter type (e.g. github_poll) is added,
// migrate TriggerDefinition to a discriminated union.
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
// TriggerDefinition: a single configured trigger loaded from triggers.yml
// ---------------------------------------------------------------------------

export interface TriggerDefinition {
  /** Stable identifier. Used as the URL path segment: POST /webhook/:id */
  readonly id: TriggerId;

  /**
   * Provider name.
   * "generic"     = any HTTP POST with optional HMAC validation (webhook trigger).
   * "gitlab_poll" = polling trigger that fetches GitLab MRs on a schedule.
   *
   * When provider === 'gitlab_poll', pollingSource must be present.
   * When provider === 'generic', pollingSource must be absent.
   * Validated at load time by validateAndResolveTrigger().
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
   * Polling source configuration. Present only when provider === 'gitlab_poll'.
   * Absent for webhook (generic) triggers.
   *
   * The polling scheduler uses this to determine how and when to poll the
   * external API. The webhook routing path (TriggerRouter.route()) never reads
   * this field -- it is only consumed by PollingScheduler.
   *
   * NOTE: This is a stepping-stone design. When a second polling adapter type
   * is added, migrate to a discriminated union on TriggerDefinition.
   *
   * TODO(follow-up): migrate to discriminated union at adapter #2.
   */
  readonly pollingSource?: GitLabPollingSource;
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
