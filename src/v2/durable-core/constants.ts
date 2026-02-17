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
