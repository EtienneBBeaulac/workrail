/**
 * WorkRail v2 durable truth budgets, limits, and canonical constants.
 * 
 * All values are locked in: docs/design/v2-core-design-locks.md
 * 
 * Purpose:
 * - Single source of truth for all v2 limits
 * - Prevents drift between code and documentation
 * - Makes limits adjustable without hunting through schemas
 * 
 * Lock: These are not configuration; they are architectural invariants.
 * Changing these requires updating the lock doc and may break compatibility.
 */

// =============================================================================
// Blocker Limits (Section 1.1: BlockerReport)
// =============================================================================

/**
 * Maximum number of blockers in a single BlockerReport.
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (BlockerReport schema)
 * 
 * Why 10: Prevents unbounded blocker lists while allowing multiple distinct issues.
 * More than 10 blockers suggests a systemic problem requiring triage.
 */
export const MAX_BLOCKERS = 10;

/**
 * Maximum UTF-8 bytes for a blocker message.
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (BlockerReport schema)
 * 
 * Why 512: Forces concise error messages. Full explanations belong in suggestedFix.
 */
export const MAX_BLOCKER_MESSAGE_BYTES = 512;

/**
 * Maximum UTF-8 bytes for a blocker suggestedFix.
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (BlockerReport schema)
 * 
 * Why 1024: Allows actionable guidance with examples without becoming a novel.
 */
export const MAX_BLOCKER_SUGGESTED_FIX_BYTES = 1024;

// =============================================================================
// Decision Trace Limits (Section 1.1: decision_trace_appended)
// =============================================================================

/**
 * Maximum entries in a single decision trace event.
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (decision_trace_appended)
 * 
 * Why 25: Bounded "why" audit trail without becoming a transcript dump.
 * Typical workflow steps have 3-5 decision points; 25 allows complex workflows.
 */
export const MAX_DECISION_TRACE_ENTRIES = 25;

/**
 * Maximum UTF-8 bytes per decision trace entry summary.
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (decision_trace_appended)
 * 
 * Why 512: One-sentence explanations only. Full reasoning should be in workflow prompts.
 */
export const MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES = 512;

/**
 * Maximum total UTF-8 bytes for entire decision trace event.
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (decision_trace_appended)
 * 
 * Why 8192: Prevents runaway trace accumulation (8KB ~ 100-150 entries if all maxed).
 */
export const MAX_DECISION_TRACE_TOTAL_BYTES = 8192;

// =============================================================================
// Output Limits (Section 1.1: node_output_appended)
// =============================================================================

/**
 * Maximum UTF-8 bytes for output.notesMarkdown.
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (node_output_appended)
 * 
 * Why 4096: Short recap only (~50-80 lines). Detailed results belong in artifacts.
 */
export const MAX_OUTPUT_NOTES_MARKDOWN_BYTES = 4096;

// =============================================================================
// Validation Limits (Blocked retry UX)
// =============================================================================

/**
 * Maximum UTF-8 bytes for a single validation issue string.
 *
 * Why 512: Forces concise issue descriptions. Full context belongs in suggestedFix.
 */
export const MAX_VALIDATION_ISSUE_ITEM_BYTES = 512;

/**
 * Maximum UTF-8 bytes for a single validation suggestion string.
 *
 * Why 1024: Allows actionable guidance with examples without becoming verbose.
 */
export const MAX_VALIDATION_SUGGESTION_ITEM_BYTES = 1024;

/**
 * Maximum UTF-8 bytes across all validation issues stored in a single `validation_performed` event.
 *
 * Why: Validation can be verbose; we bound durable truth to keep the event log and tool responses predictable.
 */
export const MAX_VALIDATION_ISSUES_BYTES = 4096;

/**
 * Maximum UTF-8 bytes across all validation suggestions stored in a single `validation_performed` event.
 *
 * Why: Suggestions often include examples; we bound them separately from issues for clarity and budgeting.
 */
export const MAX_VALIDATION_SUGGESTIONS_BYTES = 4096;

// =============================================================================
// Context Limits (Section 16.3.1: Context budget)
// =============================================================================

/**
 * Maximum UTF-8 bytes for `context` (measured as RFC 8785 JCS canonical JSON).
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 16.3.1
 * 
 * Why 256KB: Prevents "context as document dump" anti-pattern.
 * Context is for external inputs (IDs, paths, parameters), not large blobs.
 */
export const MAX_CONTEXT_BYTES = 256 * 1024; // 256 KB

/**
 * Maximum nesting depth for context object validation.
 * 
 * Why 64: Prevents stack overflow while allowing deeply nested structures.
 */
export const MAX_CONTEXT_DEPTH = 64;

// =============================================================================
// Observation Limits (Section 1.1: observation_recorded)
// =============================================================================

/**
 * Maximum length for observation value (type: short_string).
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (observation_recorded)
 * 
 * Why 80: Git branch names, short workspace paths. Not for large text.
 */
export const MAX_OBSERVATION_SHORT_STRING_LENGTH = 80;

// =============================================================================
// Retry Timing
// =============================================================================

/**
 * Default retry delay in milliseconds for session lock contention.
 * 
 * Lock: Operational envelope (Section 10)
 * 
 * Why 1000ms: Balance between responsiveness and avoiding tight retry loops.
 */
export const SESSION_LOCK_RETRY_AFTER_MS = 1000;

/**
 * Default retry delay for general retryable errors.
 * 
 * Why 1000ms: Standard backoff for transient failures.
 */
export const DEFAULT_RETRY_AFTER_MS = 1000;

// =============================================================================
// Canonical Markers
// =============================================================================

/**
 * Canonical truncation marker (must be exact for determinism).
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 1.1 (canonical truncation)
 * 
 * Why this exact string: Deterministic, visually distinct, searchable.
 */
export const TRUNCATION_MARKER = '\n\n[TRUNCATED]';

// =============================================================================
// Recovery Budget (Slice 4a S9: Recap Recovery)
// =============================================================================

/**
 * Recovery budget for rehydrate-only responses (recap + function definitions combined).
 * 
 * Lock: Midpoint of contract §340 guidance "8-16 KB" for deterministic budgeting.
 * 
 * Why 12 KB: Balances context recovery needs with token budget constraints.
 */
export const RECOVERY_BUDGET_BYTES = 12288; // 12 KB

// =============================================================================
// Regex Patterns
// =============================================================================

/**
 * SHA-256 digest format validation pattern.
 * 
 * Lock: Canonical format is `sha256:<64 lowercase hex chars>`
 * 
 * Why lowercase: Determinism (avoid case ambiguity).
 */
export const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Step ID and loop ID pattern (delimiter-safe identifiers).
 * 
 * Lock: docs/design/workflow-authoring-v2.md (Step IDs)
 * 
 * Why delimiter-safe: Allows StepInstanceKey to use `::` and `@` as structural delimiters.
 * Forbidden characters: @, /, ::
 */
export const DELIMITER_SAFE_ID_PATTERN = /^[a-z0-9_-]+$/;

// =============================================================================
// Domain Event Kinds (Section 1: Durable truth substrate)
// =============================================================================

/**
 * Closed set of v2 domain event kinds.
 *
 * Why a const object: eliminates scattered string literals across projections,
 * handlers, and builders. Typos become compile errors instead of silent bugs.
 *
 * Lock: Adding a new event kind requires updating the DomainEventV1Schema union.
 */
export const EVENT_KIND = {
  SESSION_CREATED: 'session_created',
  OBSERVATION_RECORDED: 'observation_recorded',
  RUN_STARTED: 'run_started',
  NODE_CREATED: 'node_created',
  EDGE_CREATED: 'edge_created',
  ADVANCE_RECORDED: 'advance_recorded',
  VALIDATION_PERFORMED: 'validation_performed',
  NODE_OUTPUT_APPENDED: 'node_output_appended',
  PREFERENCES_CHANGED: 'preferences_changed',
  CAPABILITY_OBSERVED: 'capability_observed',
  GAP_RECORDED: 'gap_recorded',
  CONTEXT_SET: 'context_set',
  DIVERGENCE_RECORDED: 'divergence_recorded',
  DECISION_TRACE_APPENDED: 'decision_trace_appended',
} as const;

export type EventKindV1 = typeof EVENT_KIND[keyof typeof EVENT_KIND];

// =============================================================================
// Output Channels (Section 1.2: node_output_appended)
// =============================================================================

/**
 * Closed set of output channels for node_output_appended events.
 *
 * Why: prevents typos in channel filtering and ensures exhaustive handling.
 */
export const OUTPUT_CHANNEL = {
  RECAP: 'recap',
  ARTIFACT: 'artifact',
} as const;

export type OutputChannelV1 = typeof OUTPUT_CHANNEL[keyof typeof OUTPUT_CHANNEL];

// =============================================================================
// Edge Kinds (Section 1.2: edge_created)
// =============================================================================

/**
 * Closed set of edge kinds for edge_created events.
 */
export const EDGE_KIND = {
  ACKED_STEP: 'acked_step',
  CHECKPOINT: 'checkpoint',
} as const;

export type EdgeKindV1 = typeof EDGE_KIND[keyof typeof EDGE_KIND];

// =============================================================================
// Engine States (Execution snapshot)
// =============================================================================

/**
 * Closed set of engine states in execution snapshots.
 */
export const ENGINE_STATE = {
  INIT: 'init',
  RUNNING: 'running',
  BLOCKED: 'blocked',
  COMPLETE: 'complete',
} as const;

export type EngineStateKindV1 = typeof ENGINE_STATE[keyof typeof ENGINE_STATE];

// =============================================================================
// Advance Outcome Kinds (Section 1.2: advance_recorded)
// =============================================================================

/**
 * Closed set of advance outcome kinds.
 */
export const ADVANCE_OUTCOME = {
  ADVANCED: 'advanced',
  BLOCKED: 'blocked',
} as const;

// =============================================================================
// Edge Cause Kinds (Section 1.2: edge_created)
// =============================================================================

/**
 * Closed set of edge cause kinds (why an edge was created).
 */
export const EDGE_CAUSE = {
  INTENTIONAL_FORK: 'intentional_fork',
  NON_TIP_ADVANCE: 'non_tip_advance',
  IDEMPOTENT_REPLAY: 'idempotent_replay',
  CHECKPOINT_CREATED: 'checkpoint_created',
} as const;

export type EdgeCauseKindV1 = typeof EDGE_CAUSE[keyof typeof EDGE_CAUSE];

// =============================================================================
// Manifest Record Kinds (Section 1: Manifest control stream)
// =============================================================================

/**
 * Closed set of manifest record kinds.
 */
export const MANIFEST_KIND = {
  SEGMENT_CLOSED: 'segment_closed',
  SNAPSHOT_PINNED: 'snapshot_pinned',
} as const;

// =============================================================================
// Advance Intent (Section 1.2: advance_recorded)
// =============================================================================

/**
 * Closed set of advance intents.
 */
export const ADVANCE_INTENT = {
  ACK_PENDING: 'ack_pending',
} as const;

// =============================================================================
// Autonomy Modes (Section 1.3: preferences)
// =============================================================================

/**
 * Closed set of agent autonomy modes.
 *
 * Why: prevents typos in mode comparison and ensures exhaustive handling.
 */
export const AUTONOMY_MODE = {
  GUIDED: 'guided',
  FULL_AUTO_NEVER_STOP: 'full_auto_never_stop',
  FULL_AUTO_STOP_ON_USER_DEPS: 'full_auto_stop_on_user_deps',
} as const;

export type AutonomyModeV1 = typeof AUTONOMY_MODE[keyof typeof AUTONOMY_MODE];
