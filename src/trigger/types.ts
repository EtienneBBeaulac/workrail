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
// TriggerDefinition: a single configured trigger loaded from triggers.yml
// ---------------------------------------------------------------------------

export interface TriggerDefinition {
  /** Stable identifier. Used as the URL path segment: POST /webhook/:id */
  readonly id: TriggerId;

  /**
   * Provider name. MVP supports "generic" only.
   * "generic" = any HTTP POST with optional HMAC validation.
   * Post-MVP: "gitlab", "github", "jira", "cron".
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
   */
  readonly hmacSecret?: string;

  /**
   * Optional mapping from payload fields to workflow context variables.
   * When absent, the raw payload is passed as context.payload.
   */
  readonly contextMapping?: ContextMapping;
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
