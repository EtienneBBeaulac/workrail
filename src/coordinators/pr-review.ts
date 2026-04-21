/**
 * PR Review Coordinator
 *
 * Autonomously reviews open GitHub PRs by dispatching mr-review-workflow-agentic
 * sessions, routing by finding severity, and merging or escalating.
 *
 * Design invariants:
 * - All I/O is injected via CoordinatorDeps. Zero direct fs/fetch imports in this module.
 * - parseFindingsFromNotes() and classifySeverity() are pure functions (no I/O).
 * - ReviewSeverity is a discriminated union -- all switch statements must be exhaustive.
 * - Errors are returned as Result<T, string> values -- never thrown.
 * - Never merge when severity is blocking, unknown, timeout, failed, or not_awaited.
 * - Fix-agent loop: check passCount >= MAX_FIX_PASSES before spawning (not after).
 *
 * Robustness rules (from docs/discovery/spawn-agent-failure-modes.md):
 * 1. Child session timeout hardcoded to 15 minutes -- never LLM-computed.
 * 2. spawnSession returning empty/null handle -> treat as error (zombie detection).
 * 3. Coordinator wall-clock check: refuse new spawns if elapsed > 70 minutes.
 * 4. Two-tier notes parsing: JSON block first (## COORDINATOR_OUTPUT), keyword scan fallback.
 *    NOTE: the JSON block parser is aspirational -- no live workflow emits ## COORDINATOR_OUTPUT.
 *    The keyword scan is the ONLY active parser path. See comment in parseFindingsFromNotes().
 *    Unknown severity defaults to 'blocking' (conservative). Blocking wins over clean keywords.
 *    Negation context suppresses blocking: /\b(?:not|no|without)\b.{0,30}\bblocking\b/i
 * 5. Traceability: write { childSessionId, outcome, elapsedMs, severity } JSON block before acting.
 */

import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';
import { assertNever } from '../runtime/assert-never.js';
import type { AwaitResult, SessionResult } from '../cli/commands/worktrain-await.js';
import {
  ReviewVerdictArtifactV1Schema,
  isReviewVerdictArtifact,
} from '../v2/durable-core/schemas/artifacts/review-verdict.js';
import { renderContextBundle } from '../context-assembly/index.js';
import type { ContextAssembler } from '../context-assembly/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Severity classification of a PR review.
 *
 * WHY discriminated union: exhaustive switch at compile time ensures every
 * routing decision handles all four variants. No string comparison bugs.
 */
export type ReviewSeverity = 'clean' | 'minor' | 'blocking' | 'unknown';

/**
 * Parsed findings from a review session's step notes or typed artifact.
 */
export interface ReviewFindings {
  readonly severity: ReviewSeverity;
  /** Short summaries of individual findings (for fix-agent goal string). */
  readonly findingSummaries: readonly string[];
  /** The raw markdown text or artifact JSON that was parsed (for report). */
  readonly raw: string;
  /**
   * The extraction path that produced these findings.
   * 'artifact': parsed from a wr.review_verdict typed artifact (preferred)
   * 'keyword_scan': parsed from step notes using keyword heuristics (fallback)
   * Optional for backward compatibility -- new code always sets this.
   */
  readonly source?: 'artifact' | 'keyword_scan';
}

/**
 * Summary of an open GitHub PR.
 */
export interface PrSummary {
  readonly number: number;
  readonly title: string;
  readonly headRef: string;
}

/**
 * Outcome of processing a single PR through the coordinator pipeline.
 */
export interface PrOutcome {
  readonly prNumber: number;
  readonly severity: ReviewSeverity;
  readonly merged: boolean;
  readonly escalated: boolean;
  readonly escalationReason: string | null;
  /** Number of fix-agent passes run (0 for first review). */
  readonly passCount: number;
  /** All session handles touched (review + fix sessions). */
  readonly sessionHandles: readonly string[];
}

/**
 * Summary result of the full coordinator run.
 */
export interface CoordinatorResult {
  readonly reviewed: number;
  readonly approved: number;
  readonly escalated: number;
  readonly mergedPrs: readonly number[];
  readonly reportPath: string;
  /** true if any PR resulted in an unexpected error (not just blocking findings) */
  readonly hasErrors: boolean;
}

/**
 * Options for running the PR review coordinator.
 */
export interface PrReviewOpts {
  /** Absolute path to the git workspace. */
  readonly workspace: string;
  /** If set, review only these PR numbers. Otherwise, discover open PRs. */
  readonly prs?: readonly number[];
  /** If true, print actions without executing HTTP calls or git operations. */
  readonly dryRun: boolean;
  /** Override the console HTTP server port. */
  readonly port?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// COORDINATOR DEPS INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Injectable dependencies for the PR review coordinator.
 *
 * All I/O is behind this interface so the coordinator core is testable with
 * fake implementations. No direct fetch/fs/exec imports in coordinator logic.
 *
 * WHY this pattern: follows WorktrainSpawnCommandDeps / WorktrainAwaitCommandDeps exactly.
 * Composition root (src/cli-worktrain.ts) wires real implementations; tests inject fakes.
 */
export interface CoordinatorDeps {
  /**
   * Dispatch a workflow session to the daemon.
   * Returns the session handle on success, or err() on connection/HTTP failure.
   *
   * The optional 4th arg passes assembled context (e.g. git diff summary, prior session
   * notes) that gets injected into the session's system prompt before turn 1.
   */
  readonly spawnSession: (
    workflowId: string,
    goal: string,
    workspace: string,
    context?: Readonly<Record<string, unknown>>,
    agentConfig?: Readonly<{ readonly maxSessionMinutes?: number; readonly maxTurns?: number }>,
  ) => Promise<Result<string, string>>;

  /**
   * Optional context assembler. When provided, assembles git diff summary and
   * prior session notes before each review session spawn.
   *
   * WHY optional: backward-compatible with existing test fakes that construct
   * CoordinatorDeps without context assembly. Undefined = no assembly.
   */
  readonly contextAssembler?: ContextAssembler;

  /**
   * Wait for a set of sessions to complete.
   * Returns the await result (outcomes per handle) after all sessions finish or timeout.
   */
  readonly awaitSessions: (
    handles: readonly string[],
    timeoutMs: number,
  ) => Promise<AwaitResult>;

  /**
   * Retrieve the recap notes and artifacts from a completed session.
   *
   * Returns recapMarkdown from the final (tip) node and artifacts aggregated
   * from ALL session nodes. Returns empty artifacts array on failure.
   *
   * WHY both fields: recapMarkdown is used by the keyword-scan fallback;
   * artifacts are used by readVerdictArtifact() for typed verdict extraction.
   * WHY all nodes for artifacts: a verdict artifact may be emitted on any step,
   * not just the final one.
   *
   * Call sequence: GET /api/v2/sessions/:id -> runs[0].nodes + preferredTipNodeId
   * -> GET /api/v2/sessions/:id/nodes/:nodeId (for each node) -> recapMarkdown + artifacts[].
   */
  readonly getAgentResult: (
    sessionHandle: string,
  ) => Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }>;

  /**
   * List open PRs in the workspace via gh CLI.
   * Returns an empty array if no PRs are open or gh command fails.
   */
  readonly listOpenPRs: (workspace: string) => Promise<PrSummary[]>;

  /**
   * Merge a PR using gh pr merge --squash.
   * Returns err() if the merge command fails (conflict, CI required, etc.).
   */
  readonly mergePR: (
    prNumber: number,
    workspace: string,
  ) => Promise<Result<void, string>>;

  /**
   * Write a file at the given absolute path.
   * Used for writing the coordinator report markdown.
   */
  readonly writeFile: (path: string, content: string) => Promise<void>;

  /** Write a line to stderr (progress, warnings, traceability JSON). */
  readonly stderr: (line: string) => void;

  /** Return the current wall-clock time in milliseconds. */
  readonly now: () => number;

  /** Resolved console HTTP server port (after lock file discovery). Optional in in-process contexts. */
  readonly port?: number;

  /**
   * Read file contents as UTF-8 string.
   * Used by drainMessageQueue to read message-queue.jsonl and cursor files.
   * Throws on ENOENT (caller handles the error as "no messages").
   */
  readonly readFile: (path: string) => Promise<string>;

  /**
   * Append content to a file, creating it if it does not exist.
   * Used by drainMessageQueue to write outbox.jsonl notifications.
   */
  readonly appendFile: (path: string, content: string) => Promise<void>;

  /**
   * Create a directory (recursive: true = mkdir -p).
   * Used by drainMessageQueue to ensure ~/.workrail/ exists before writing the cursor.
   */
  readonly mkdir: (path: string, options: { recursive: boolean }) => Promise<string | undefined>;

  /**
   * Return the user's home directory.
   * Used by drainMessageQueue to build ~/.workrail paths.
   */
  readonly homedir: () => string;

  /**
   * Join path segments (same semantics as node:path join).
   * Used by drainMessageQueue for cross-platform path construction.
   */
  readonly joinPath: (...paths: string[]) => string;

  /**
   * Return the current timestamp as ISO 8601 string.
   * Used by drainMessageQueue to timestamp outbox notifications.
   */
  readonly nowIso: () => string;

  /**
   * Generate a UUIDv4.
   * Used by drainMessageQueue to assign IDs to outbox notifications.
   */
  readonly generateId: () => string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum fix-agent passes per PR before escalating. */
const MAX_FIX_PASSES = 3;

/**
 * Child session timeout: hardcoded 15 minutes per robustness rule 1.
 * Never computed from LLM output or coordinator config.
 */
const CHILD_SESSION_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Coordinator max runtime: 90 minutes.
 * Go/no-go check (Rule 3): refuse new spawns if elapsed > 70 minutes (90 - 20 buffer).
 */
const COORDINATOR_MAX_MS = 90 * 60 * 1000;
const COORDINATOR_SPAWN_CUTOFF_MS = COORDINATOR_MAX_MS - 20 * 60 * 1000; // 70 minutes

/** Default review await timeout: 20 minutes (child sessions are 15m, add buffer). */
const REVIEW_AWAIT_TIMEOUT_MS = 20 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse review findings from a step's recapMarkdown text.
 *
 * Two-tier strategy (mirrors parseHandoffArtifact in delivery-action.ts):
 * 1. JSON block: look for ## COORDINATOR_OUTPUT fenced block and parse it.
 *    This is the stable machine-parseable format for future workflow updates.
 * 2. Keyword scan: scan for severity-indicating keywords with priority ordering.
 *    Blocking keywords take absolute precedence over clean keywords.
 *    Negation context suppresses blocking: "not blocking" or "no blocking" -> does not classify as blocking.
 *
 * WHY two-tier: the mr-review-workflow final step currently produces free-form markdown.
 * The keyword scan handles current output; the JSON block handles future structured output.
 *
 * Returns ok(ReviewFindings) on success, err(reason) when notes are null/empty.
 */
export function parseFindingsFromNotes(notes: string | null): Result<ReviewFindings, string> {
  if (notes === null || notes.trim() === '') {
    return err('notes is null or empty');
  }

  // Strategy 1: JSON fenced block after ## COORDINATOR_OUTPUT marker.
  //
  // IMPORTANT: This parser is NOT currently active for any live workflow.
  // The mr-review-workflow.agentic.v2 workflow (and all other versions) produce
  // free-form markdown -- NOT a structured ## COORDINATOR_OUTPUT JSON block.
  // The keyword scan (Strategy 2) is the ONLY live parser path today.
  //
  // This block is intentionally kept because it is the right long-term contract:
  // when a future workflow version emits structured output, this parser will
  // activate automatically without code changes. Do NOT rely on it today.
  //
  // WHY we still try all JSON blocks: if a workflow ever happens to include a
  // JSON block with the right shape, we prefer the explicit machine-readable
  // signal over keyword heuristics.
  const jsonBlockRe = /```json\s*\n([\s\S]*?)\n```/g;
  for (const blockMatch of notes.matchAll(jsonBlockRe)) {
    const blockContent = blockMatch[1];
    if (!blockContent) continue;
    try {
      const parsed = JSON.parse(blockContent) as Record<string, unknown>;
      // Check for coordinator output structure
      if (
        typeof parsed['recommendation'] === 'string' &&
        ['clean', 'minor', 'blocking'].includes(parsed['recommendation'] as string)
      ) {
        const severity = parsed['recommendation'] as ReviewSeverity;
        const findings = Array.isArray(parsed['findings'])
          ? (parsed['findings'] as unknown[])
              .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
              .map((f) => typeof f['summary'] === 'string' ? f['summary'] : JSON.stringify(f))
          : [];
        return ok({ severity, findingSummaries: findings, raw: notes });
      }
    } catch {
      // JSON parse failed -- try next block
    }
  }

  // Strategy 2: Keyword scan with priority ordering.
  // Blocking wins over clean. Negation context suppresses blocking.
  const upperNotes = notes.toUpperCase();

  // Check for blocking keywords first (highest priority).
  // Suppressed by negation context within ~30 chars before the keyword.
  const NEGATION_BLOCKING_RE = /\b(?:not|no|without)\b.{0,30}\bblocking\b/i;
  const NEGATION_CRITICAL_RE = /\b(?:not|no|without)\b.{0,30}\bcritical\b/i;
  const NEGATION_REQUEST_CHANGES_RE = /\b(?:not|no|without)\b.{0,30}\brequest[\s_]changes\b/i;

  const hasBlockingKeyword =
    (upperNotes.includes('BLOCKING') && !NEGATION_BLOCKING_RE.test(notes)) ||
    (upperNotes.includes('CRITICAL') && !NEGATION_CRITICAL_RE.test(notes)) ||
    (upperNotes.includes('REQUEST CHANGES') && !NEGATION_REQUEST_CHANGES_RE.test(notes));

  if (hasBlockingKeyword) {
    return ok({
      severity: 'blocking',
      findingSummaries: extractFindingSummaries(notes),
      raw: notes,
      source: 'keyword_scan',
    });
  }

  // Check for clean keywords (APPROVE, LGTM are strong positive signals).
  // WHY word boundary for CLEAN: bare includes('CLEAN') matches "CLEANED", "CLEANER",
  // "CLEANING", "UNCLEAN", etc. -- all false positives for auto-merge decisions.
  // /\bCLEAN\b/ matches exactly the standalone word and nothing else.
  const hasCleanKeyword =
    upperNotes.includes('APPROVE') ||
    upperNotes.includes('LGTM') ||
    upperNotes.includes('NO FINDINGS') ||
    upperNotes.includes('NO ISSUES') ||
    /\bCLEAN\b/.test(upperNotes);

  // Check for minor-only keywords.
  const hasMinorKeyword =
    upperNotes.includes('MINOR') ||
    upperNotes.includes('NIT') ||
    upperNotes.includes('NITPICK') ||
    upperNotes.includes('SUGGESTION');

  if (hasCleanKeyword && !hasMinorKeyword) {
    return ok({
      severity: 'clean',
      findingSummaries: [],
      raw: notes,
      source: 'keyword_scan',
    });
  }

  if (hasMinorKeyword) {
    // Handles both minor-only AND clean+minor: conservative -- minor findings exist.
    return ok({
      severity: 'minor',
      findingSummaries: extractFindingSummaries(notes),
      raw: notes,
      source: 'keyword_scan',
    });
  }

  // No recognized keywords -- unknown severity.
  // WHY unknown -> blocking in routing: safer than unknown -> clean.
  return ok({
    severity: 'unknown',
    findingSummaries: [],
    raw: notes,
    source: 'keyword_scan',
  });
}

/**
 * Read a typed verdict from a session's artifacts array.
 *
 * Searches artifacts for a valid `wr.review_verdict` artifact using Zod safeParse.
 * Returns ReviewFindings on success, null if no valid verdict artifact is found.
 *
 * Called before parseFindingsFromNotes() as the preferred extraction path.
 * Falls through to keyword scan when no artifact is present (backward compat during transition).
 *
 * WHY kind check before safeParse: limits WARN logs to cases where the agent tried to emit
 * a verdict artifact but got the schema wrong. Other artifact types (assessment, loop_control)
 * are not verdict artifacts and must not emit false warnings.
 *
 * @param artifacts - Artifacts aggregated from all session nodes
 * @param sessionHandle - Session handle for logging context (first 16 chars)
 */
export function readVerdictArtifact(
  artifacts: readonly unknown[],
  sessionHandle?: string,
): ReviewFindings | null {
  const handlePrefix = sessionHandle ? sessionHandle.slice(0, 16) : 'unknown';
  for (const raw of artifacts) {
    // Only attempt full validation when kind discriminant matches.
    // This prevents false WARN logs for non-verdict artifacts.
    if (!isReviewVerdictArtifact(raw)) continue;

    const result = ReviewVerdictArtifactV1Schema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      // RED finding R1: log WARN when agent tried to emit verdict but schema was wrong.
      // Without this log, malformed artifacts are invisible and the fallback is silent.
      process.stderr.write(
        `[WARN coord:reason=artifact_parse_failed handle=${handlePrefix}] readVerdictArtifact: wr.review_verdict schema validation failed: ${issues}\n`,
      );
      continue;
    }

    const v = result.data;
    return {
      severity: v.verdict,
      findingSummaries: v.findings.map((f) => f.summary),
      raw: JSON.stringify(v),
      source: 'artifact',
    };
  }
  return null;
}

/**
 * Extract a short list of finding summaries from review markdown.
 * Used to build the fix-agent goal string.
 *
 * Heuristic: extract bullet points that look like findings.
 * Returns up to 5 summaries to keep the goal string concise.
 */
function extractFindingSummaries(notes: string): string[] {
  const summaries: string[] = [];
  const lines = notes.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Match bullet points or numbered list items that look like findings
    if (/^[-*]\s+.{10,}/.test(trimmed) || /^\d+\.\s+.{10,}/.test(trimmed)) {
      // Skip meta-commentary lines
      const upper = trimmed.toUpperCase();
      if (
        upper.includes('RECOMMEND') ||
        upper.includes('CONFIDENCE') ||
        upper.includes('COVERAGE') ||
        upper.includes('SUMMARY')
      ) {
        continue;
      }
      // Strip leading list marker
      const summary = trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
      summaries.push(summary.slice(0, 120)); // truncate long summaries
      if (summaries.length >= 5) break;
    }
  }

  return summaries;
}

/**
 * Build the fix-agent goal string for a given PR and its findings.
 *
 * WHY coding-task-workflow-agentic: it handles implementation tasks
 * ('implement', 'fix', 'refactor') which is exactly what fixing review
 * findings requires.
 */
export function buildFixGoal(prNumber: number, findings: ReviewFindings): string {
  const findingList = findings.findingSummaries.length > 0
    ? ': ' + findings.findingSummaries.slice(0, 3).join('; ')
    : '';
  return `Fix review findings in PR #${prNumber}${findingList}`;
}

/**
 * Format elapsed milliseconds as a human-readable duration string.
 * Examples: 512ms -> "0:00", 68000ms -> "1:08", 510000ms -> "8:30"
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Lock file names for port discovery (same as worktrain-spawn.ts).
 * Checked in priority order: standalone console first, MCP server second.
 *
 * WHY duplicated here: coordinator is a standalone script; coupling to
 * internal daemon utils would be the wrong dependency direction.
 */
const LOCK_FILE_NAMES = ['daemon-console.lock', 'dashboard.lock'] as const;

/** Default console HTTP server port. */
const DEFAULT_CONSOLE_PORT = 3456;

/**
 * Discover the console HTTP server port from lock files.
 *
 * Injected readFile/homedir/joinPath allow testing without real filesystem access.
 */
export async function discoverConsolePort(
  deps: Pick<CoordinatorPortDiscoveryDeps, 'readFile' | 'homedir' | 'joinPath'>,
  portOverride?: number,
): Promise<number> {
  if (portOverride !== undefined && portOverride > 0) {
    return portOverride;
  }

  for (const lockFileName of LOCK_FILE_NAMES) {
    const lockPath = deps.joinPath(deps.homedir(), '.workrail', lockFileName);
    try {
      const raw = await deps.readFile(lockPath);
      const parsed = JSON.parse(raw) as { port?: unknown };
      if (typeof parsed.port === 'number' && parsed.port > 0) {
        return parsed.port;
      }
    } catch {
      // ENOENT or parse error -- try next lock file
    }
  }

  return DEFAULT_CONSOLE_PORT;
}

/**
 * Minimal deps for port discovery (subset of CoordinatorDeps used in CLI wiring).
 */
export interface CoordinatorPortDiscoveryDeps {
  readonly readFile: (path: string) => Promise<string>;
  readonly homedir: () => string;
  readonly joinPath: (...paths: string[]) => string;
}

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE QUEUE DRAIN TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of draining the message queue.
 *
 * INVARIANT: When `stop` is true, all other fields are informational only.
 * The coordinator MUST honor `stop` before inspecting `skipPrNumbers` or
 * `addPrNumbers`. Any messages processed alongside a stop are captured for
 * diagnostic purposes but must not be acted on.
 */
export interface DrainResult {
  /** True if any queued message requests the coordinator to stop. */
  readonly stop: boolean;
  /** The full text of the message that triggered the stop (for outbox/logging). */
  readonly stopReason: string | null;
  /** PR numbers to remove from the review list (from skip-pr messages). */
  readonly skipPrNumbers: readonly number[];
  /** PR numbers to add to the review list (from add-pr messages). */
  readonly addPrNumbers: readonly number[];
  /** Total number of valid messages processed in this drain. */
  readonly messagesProcessed: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE QUEUE DRAIN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Drain the WorkTrain message queue for the current coordinator cycle.
 *
 * Reads new lines from ~/.workrail/message-queue.jsonl since the last run
 * (tracked by ~/.workrail/message-queue-cursor.json) and acts on actionable
 * messages. Appends outbox.jsonl notifications for each actionable message and
 * advances the cursor so messages are not re-processed on the next invocation.
 *
 * Recognized command patterns (matched against QueuedMessage.message text):
 * - /^\s*stop\b/i           -> coordinator must halt before any spawn
 * - /\bskip[- ]pr\s#?(\d+)/i -> remove that PR from the review list
 * - /\badd[- ]pr\s#?(\d+)/i  -> add that PR to the review list
 * All other messages are treated as informational notes and skipped silently.
 *
 * WHY text parsing: QueuedMessage has no structured `kind` field today.
 * Text matching follows the same pattern as parseFindingsFromNotes() in this
 * file. A follow-up task should add a `kind` field to QueuedMessage to make
 * routing type-safe and eliminate the text-parsing fragility.
 *
 * WHY cursor (not timestamp filter): the cursor pattern is strictly more
 * correct than timestamp-based dedup. It is the same approach used by
 * worktrain-inbox.ts (InboxCursor / inbox-cursor.json).
 *
 * INVARIANT: message-queue.jsonl is never modified -- only the cursor file
 * is written. The queue is append-only per worktrain-tell.ts design.
 */
export async function drainMessageQueue(
  deps: Pick<
    CoordinatorDeps,
    | 'readFile'
    | 'appendFile'
    | 'writeFile'
    | 'mkdir'
    | 'homedir'
    | 'joinPath'
    | 'nowIso'
    | 'generateId'
    | 'stderr'
  >,
): Promise<DrainResult> {
  const workrailDir = deps.joinPath(deps.homedir(), '.workrail');
  const queuePath = deps.joinPath(workrailDir, 'message-queue.jsonl');
  const cursorPath = deps.joinPath(workrailDir, 'message-queue-cursor.json');
  const outboxPath = deps.joinPath(workrailDir, 'outbox.jsonl');

  // ── Read queue ───────────────────────────────────────────────────────────

  let queueContent: string;
  try {
    queueContent = await deps.readFile(queuePath);
  } catch (err) {
    if (isEnoentError(err)) {
      // Queue file doesn't exist yet -- no messages, proceed normally.
      return { stop: false, stopReason: null, skipPrNumbers: [], addPrNumbers: [], messagesProcessed: 0 };
    }
    // Unexpected I/O error -- log and proceed as if empty.
    deps.stderr(
      `[WARN coord:drain reason=read_failed] drainMessageQueue: could not read message queue: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { stop: false, stopReason: null, skipPrNumbers: [], addPrNumbers: [], messagesProcessed: 0 };
  }

  const allLines = queueContent.split('\n').filter((line) => line.trim() !== '');
  const parsedMessages: import('../cli/commands/worktrain-tell.js').QueuedMessage[] = [];

  for (const line of allLines) {
    try {
      const msg = JSON.parse(line) as import('../cli/commands/worktrain-tell.js').QueuedMessage;
      parsedMessages.push(msg);
    } catch {
      deps.stderr(`[WARN coord:drain reason=malformed_line] drainMessageQueue: skipped malformed JSONL line`);
    }
  }

  const totalLines = parsedMessages.length;

  // ── Read cursor ──────────────────────────────────────────────────────────

  let lastReadCount = 0;
  try {
    const cursorContent = await deps.readFile(cursorPath);
    const cursor = JSON.parse(cursorContent) as { lastReadCount?: unknown };
    if (typeof cursor.lastReadCount === 'number' && cursor.lastReadCount >= 0) {
      lastReadCount = cursor.lastReadCount;
    }
  } catch {
    // Missing cursor or corrupt JSON -- default to 0 (process all messages).
    lastReadCount = 0;
  }

  // Cursor desync guard: if queue was truncated/wiped, cursor may point past
  // the end. Reset to 0 so all current messages are processed.
  // (cursor === totalLines is the normal "all read" state -- no reset needed.)
  if (lastReadCount > totalLines) {
    lastReadCount = 0;
  }

  // ── Process new messages ─────────────────────────────────────────────────

  const newMessages = parsedMessages.slice(lastReadCount);

  let stop = false;
  let stopReason: string | null = null;
  const skipSet = new Set<number>();
  const addSet = new Set<number>();
  const outboxEntries: string[] = [];

  const STOP_RE = /^\s*stop\b/i;
  const SKIP_PR_RE = /\bskip[- ]pr[\s#]+([0-9]+)/i;
  const ADD_PR_RE = /\badd[- ]pr[\s#]+([0-9]+)/i;

  for (const msg of newMessages) {
    const text = msg.message;

    if (STOP_RE.test(text)) {
      stop = true;
      stopReason = text;
      deps.stderr(
        `[INFO coord:drain kind=stop ts=${msg.timestamp}] drainMessageQueue: stop signal received -- message: "${text}"`,
      );
      // Outbox notification includes full triggering text for diagnostics (FM1 mitigation).
      outboxEntries.push(
        JSON.stringify({
          id: deps.generateId(),
          message: `WorkTrain coordinator stopped by queued message: "${text}" (queued at ${msg.timestamp})`,
          timestamp: deps.nowIso(),
        }) + '\n',
      );
      continue;
    }

    const skipMatch = SKIP_PR_RE.exec(text);
    if (skipMatch !== null) {
      const prNum = parseInt(skipMatch[1]!, 10);
      skipSet.add(prNum);
      deps.stderr(
        `[INFO coord:drain kind=skip-pr prNumber=${prNum} ts=${msg.timestamp}] drainMessageQueue: skip-pr signal received -- message: "${text}"`,
      );
      outboxEntries.push(
        JSON.stringify({
          id: deps.generateId(),
          message: `WorkTrain coordinator skipping PR #${prNum} per queued message: "${text}" (queued at ${msg.timestamp})`,
          timestamp: deps.nowIso(),
        }) + '\n',
      );
      continue;
    }

    const addMatch = ADD_PR_RE.exec(text);
    if (addMatch !== null) {
      const prNum = parseInt(addMatch[1]!, 10);
      addSet.add(prNum);
      deps.stderr(
        `[INFO coord:drain kind=add-pr prNumber=${prNum} ts=${msg.timestamp}] drainMessageQueue: add-pr signal received -- message: "${text}"`,
      );
      outboxEntries.push(
        JSON.stringify({
          id: deps.generateId(),
          message: `WorkTrain coordinator adding PR #${prNum} per queued message: "${text}" (queued at ${msg.timestamp})`,
          timestamp: deps.nowIso(),
        }) + '\n',
      );
      continue;
    }

    // Informational note -- no action taken.
  }

  // ── Write outbox notifications ───────────────────────────────────────────

  if (outboxEntries.length > 0) {
    try {
      await deps.mkdir(workrailDir, { recursive: true });
      await deps.appendFile(outboxPath, outboxEntries.join(''));
    } catch (err) {
      // Outbox write failure is non-fatal. Actions are still honored.
      deps.stderr(
        `[WARN coord:drain reason=outbox_write_failed] drainMessageQueue: could not write outbox notifications: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Advance cursor ───────────────────────────────────────────────────────
  // WHY writeFile (not appendFile): the cursor is a single JSON object that
  // must be overwritten on each run. appendFile would grow it unboundedly.

  const newCursor = JSON.stringify({ lastReadCount: totalLines }, null, 2) + '\n';
  try {
    await deps.mkdir(workrailDir, { recursive: true });
    await deps.writeFile(cursorPath, newCursor);
  } catch (err) {
    // Cursor write failure is non-fatal -- messages were already processed.
    // Next run will re-read from the old cursor (at worst, messages are re-processed,
    // which is safe for stop/skip/add idempotent actions).
    deps.stderr(
      `[WARN coord:drain reason=cursor_write_failed] drainMessageQueue: could not update cursor: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    stop,
    stopReason,
    skipPrNumbers: [...skipSet],
    addPrNumbers: [...addSet],
    messagesProcessed: newMessages.length,
  };
}

/**
 * Returns true if the error is a Node.js ENOENT (file not found).
 * WHY local copy: worktrain-inbox.ts has an identical function -- this avoids
 * a cross-module dependency for a 5-line utility.
 */
function isEnoentError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// COORDINATOR CORE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the PR review coordinator pipeline.
 *
 * Stages:
 * 1. Discover or validate PR list
 * 2. Dispatch parallel review sessions (spawn all, then await all)
 * 3. Extract notes and classify severity for each PR
 * 4. Route: clean -> merge queue, minor -> fix-agent loop, blocking/unknown -> escalate
 * 5. Serial merge for clean PRs
 * 6. Write report file
 *
 * Returns CoordinatorResult for the CLI to interpret.
 */
export async function runPrReviewCoordinator(
  deps: CoordinatorDeps,
  opts: PrReviewOpts,
): Promise<CoordinatorResult> {
  const coordinatorStartMs = deps.now();
  const today = new Date(deps.now()).toISOString().slice(0, 10);
  const reportPath = opts.workspace + `/coordinator-pr-review-${today}.md`;
  const reportLines: string[] = [];

  function log(line: string): void {
    deps.stderr(line);
    reportLines.push(line);
  }

  // ---- Message queue drain ----
  // Drain before any spawn (never mid-agent-run). Acts on stop/skip-pr/add-pr
  // signals queued via `worktrain tell` from phone or terminal.
  // INVARIANT: check drainResult.stop BEFORE acting on skip/add arrays.
  const drainResult = await drainMessageQueue(deps);
  if (drainResult.messagesProcessed > 0) {
    const skipStr = drainResult.skipPrNumbers.length > 0
      ? `, skip=[${drainResult.skipPrNumbers.join(',')}]`
      : '';
    const addStr = drainResult.addPrNumbers.length > 0
      ? `, add=[${drainResult.addPrNumbers.join(',')}]`
      : '';
    log(`[drain] processed ${drainResult.messagesProcessed} message(s)${skipStr}${addStr}${drainResult.stop ? ', STOP SIGNAL' : ''}`);
  }

  // Honor stop signal -- exit cleanly before spawning any agent.
  if (drainResult.stop) {
    const stopMsg = drainResult.stopReason ?? 'stop signal in message queue';
    log(`  STOP: coordinator halted by queued message: "${stopMsg}"`);
    const result: CoordinatorResult = {
      reviewed: 0,
      approved: 0,
      escalated: 0,
      mergedPrs: [],
      reportPath,
      hasErrors: false,
    };
    await writeReport(deps, reportPath, reportLines, result);
    return result;
  }

  // ---- Stage 1: Gather PRs ----
  log('[1/3] Gathering open PRs...');
  const stageStart = deps.now();

  let prs: PrSummary[];
  if (opts.prs && opts.prs.length > 0) {
    prs = opts.prs.map((n) => ({ number: n, title: `PR #${n}`, headRef: '' }));
  } else if (opts.dryRun) {
    prs = [];
    log('  [dry-run] would call gh pr list');
  } else {
    prs = await deps.listOpenPRs(opts.workspace);
  }

  // Apply add-pr from message queue (before skip-pr, before dedup).
  if (drainResult.addPrNumbers.length > 0) {
    const existingNums = new Set(prs.map((p) => p.number));
    for (const addNum of drainResult.addPrNumbers) {
      if (!existingNums.has(addNum)) {
        prs = [...prs, { number: addNum, title: `PR #${addNum}`, headRef: '' }];
        existingNums.add(addNum);
        log(`  [drain] added PR #${addNum} from message queue`);
      }
    }
  }

  // Apply skip-pr from message queue.
  if (drainResult.skipPrNumbers.length > 0) {
    const skipSet = new Set(drainResult.skipPrNumbers);
    const prsBefore = prs.length;
    prs = prs.filter((p) => !skipSet.has(p.number));
    const skippedCount = prsBefore - prs.length;
    if (skippedCount > 0) {
      log(`  [drain] skipped ${skippedCount} PR(s) from message queue: [${[...skipSet].join(',')}]`);
    }
  }

  log(`  done (${formatElapsed(deps.now() - stageStart)}) -- ${prs.length} PR(s) found`);

  if (prs.length === 0) {
    const result: CoordinatorResult = {
      reviewed: 0,
      approved: 0,
      escalated: 0,
      mergedPrs: [],
      reportPath,
      hasErrors: false,
    };
    await writeReport(deps, reportPath, reportLines, result);
    return result;
  }

  // ---- Stage 2: Parallel review sessions ----
  log(`[2/3] Running reviews (${prs.length} parallel)...`);
  const reviewStart = deps.now();

  // Check go/no-go before spawning (Rule 3: wall-clock elapsed check)
  if (!opts.dryRun && deps.now() - coordinatorStartMs > COORDINATOR_SPAWN_CUTOFF_MS) {
    log('  WARNING: coordinator elapsed > 70 minutes, refusing to spawn new sessions');
    const result: CoordinatorResult = {
      reviewed: 0,
      approved: 0,
      escalated: prs.length,
      mergedPrs: [],
      reportPath,
      hasErrors: true,
    };
    await writeReport(deps, reportPath, reportLines, result);
    return result;
  }

  // Spawn review sessions in parallel
  const reviewHandles = new Map<number, string>(); // prNumber -> sessionHandle
  const spawnErrors = new Map<number, string>(); // prNumber -> error message
  // Assembled context per PR -- forwarded to re-review spawns in runFixAgentLoop
  const spawnContexts = new Map<number, Readonly<Record<string, unknown>>>();

  for (const pr of prs) {
    const goal = `Review PR #${pr.number} "${pr.title}" before merge`;
    if (opts.dryRun) {
      log(`      PR #${pr.number} [dry-run] would spawn mr-review-workflow-agentic`);
      continue;
    }

    // Assemble context before spawning (optional -- skip if no assembler injected).
    let spawnContext: Readonly<Record<string, unknown>> | undefined;
    if (deps.contextAssembler) {
      const bundle = await deps.contextAssembler.assemble({
        kind: 'pr_review',
        prNumber: pr.number,
        workspacePath: opts.workspace,
      });
      const rendered = renderContextBundle(bundle);
      if (rendered.trim().length > 0) {
        spawnContext = { assembledContextSummary: rendered };
        spawnContexts.set(pr.number, spawnContext);
      }
      // WARN log when a source fails so issues are surfaced in coordinator output
      if (bundle.gitDiff.kind === 'err') {
        deps.stderr(`[WARN coord:context prNumber=${pr.number}] gitDiff failed: ${bundle.gitDiff.error}`);
      }
      if (bundle.priorSessionNotes.kind === 'err') {
        deps.stderr(`[WARN coord:context prNumber=${pr.number}] priorSessionNotes failed: ${bundle.priorSessionNotes.error}`);
      }
    }

    const spawnResult = await deps.spawnSession(
      'mr-review-workflow-agentic',
      goal,
      opts.workspace,
      spawnContext,
    );

    if (spawnResult.kind === 'err') {
      spawnErrors.set(pr.number, spawnResult.error);
      log(`      PR #${pr.number} spawn failed: ${spawnResult.error}`);
    } else {
      // Rule 2: check for null/empty handle (zombie detection)
      const handle = spawnResult.value;
      if (!handle) {
        spawnErrors.set(pr.number, 'spawn returned empty session handle (zombie detection)');
        log(`      PR #${pr.number} spawn returned empty handle -- zombie detection triggered`);
      } else {
        reviewHandles.set(pr.number, handle);
      }
    }
  }

  // Await all review sessions
  const outcomes = new Map<number, PrOutcome>();

  if (!opts.dryRun && reviewHandles.size > 0) {
    const awaitResult = await deps.awaitSessions(
      [...reviewHandles.values()],
      REVIEW_AWAIT_TIMEOUT_MS,
    );

    // Build reverse map: handle -> prNumber
    const handleToPr = new Map<string, number>();
    for (const [prNum, handle] of reviewHandles) {
      handleToPr.set(handle, prNum);
    }

    for (const sessionResult of awaitResult.results) {
      const prNum = handleToPr.get(sessionResult.handle);
      if (prNum === undefined) continue;

      const elapsedMs = sessionResult.durationMs;
      const handle = sessionResult.handle;

      // Get notes and artifacts for this session
      let notes: string | null = null;
      let artifacts: readonly unknown[] = [];
      if (sessionResult.outcome === 'success') {
        const agentResult = await deps.getAgentResult(handle);
        notes = agentResult.recapMarkdown;
        artifacts = agentResult.artifacts;
      }

      // Parse findings -- try artifact path first, keyword-scan fallback
      const verdictFromArtifact = readVerdictArtifact(artifacts, handle);
      const findingsResult = verdictFromArtifact !== null
        ? (() => {
            deps.stderr(`[INFO coord:source=artifact handle=${handle.slice(0, 16)}] readVerdictArtifact succeeded`);
            return ok(verdictFromArtifact);
          })()
        : (() => {
            const keywordResult = parseFindingsFromNotes(notes);
            if (keywordResult.kind === 'ok') {
              const reason = artifacts.length > 0 ? 'no_valid_artifact' : 'no_artifacts';
              deps.stderr(`[INFO coord:source=keyword_scan reason=${reason} artifactCount=${artifacts.length} handle=${handle.slice(0, 16)}]`);
            }
            return keywordResult;
          })();
      const severity: ReviewSeverity = findingsResult.kind === 'ok'
        ? findingsResult.value.severity
        : 'unknown';

      // Rule 5: write traceability JSON block before acting
      const traceBlock = JSON.stringify({
        childSessionId: handle,
        outcome: sessionResult.outcome,
        elapsedMs,
        severity,
      });
      deps.stderr(`[TRACE] ${traceBlock}`);
      reportLines.push(`\n<!-- TRACE: ${traceBlock} -->`);

      const pr = prs.find((p) => p.number === prNum)!;
      const severityLabel = severity.toUpperCase();
      log(`      PR #${pr.number} ${pr.title}    done (${formatElapsed(elapsedMs)})  ${severityLabel}`);

      const findings = findingsResult.kind === 'ok' ? findingsResult.value : null;
      const outcome: PrOutcome = {
        prNumber: prNum,
        severity,
        merged: false,
        escalated: sessionResult.outcome !== 'success' || severity === 'blocking' || severity === 'unknown',
        escalationReason: sessionResult.outcome !== 'success'
          ? `session ${sessionResult.outcome}`
          : severity === 'blocking' || severity === 'unknown'
            ? `severity: ${severity}`
            : null,
        passCount: 0,
        sessionHandles: [handle],
      };

      // Process minor PRs through fix-agent loop
      if (severity === 'minor' && findings && sessionResult.outcome === 'success') {
        const processedOutcome = await runFixAgentLoop(
          deps,
          opts,
          pr,
          findings,
          outcome,
          coordinatorStartMs,
          log,
          spawnContexts.get(prNum),
        );
        outcomes.set(prNum, processedOutcome);
      } else {
        outcomes.set(prNum, outcome);
      }
    }
  }

  // Add spawn-error PRs as escalated outcomes
  for (const [prNum, errorMsg] of spawnErrors) {
    outcomes.set(prNum, {
      prNumber: prNum,
      severity: 'unknown',
      merged: false,
      escalated: true,
      escalationReason: `spawn error: ${errorMsg}`,
      passCount: 0,
      sessionHandles: [],
    });
  }

  // ---- Stage 3: Process results ----
  log('[3/3] Processing results...');

  const mergeQueue: number[] = [];
  const escalated: PrOutcome[] = [];

  for (const outcome of outcomes.values()) {
    if (!outcome.escalated && outcome.severity === 'clean') {
      mergeQueue.push(outcome.prNumber);
      log(`      PR #${outcome.prNumber}  ->  queued for merge`);
    } else {
      escalated.push(outcome);
      const reason = outcome.escalationReason ?? outcome.severity;
      log(`      PR #${outcome.prNumber}  ->  escalated (${reason})`);
    }
  }

  // Serial merge: one at a time
  const mergedPrs: number[] = [];
  for (const prNum of mergeQueue) {
    if (opts.dryRun) {
      log(`      PR #${prNum}  ->  [dry-run] would merge`);
      mergedPrs.push(prNum);
      continue;
    }

    const mergeResult = await deps.mergePR(prNum, opts.workspace);
    if (mergeResult.kind === 'ok') {
      mergedPrs.push(prNum);
      log(`      PR #${prNum}  ->  merged`);
    } else {
      log(`      PR #${prNum}  ->  merge failed: ${mergeResult.error} (escalated)`);
      escalated.push({
        prNumber: prNum,
        severity: 'clean',
        merged: false,
        escalated: true,
        escalationReason: `merge failed: ${mergeResult.error}`,
        passCount: 0,
        sessionHandles: [],
      });
    }
  }

  const result: CoordinatorResult = {
    reviewed: outcomes.size - spawnErrors.size,
    approved: mergedPrs.length,
    escalated: escalated.length,
    mergedPrs,
    reportPath,
    hasErrors: spawnErrors.size > 0 || escalated.some((o) => o.escalationReason?.startsWith('spawn error') || o.escalationReason?.startsWith('session ') === true),
  };

  // Terminal summary
  const mergedStr = mergedPrs.length > 0 ? `PR #${mergedPrs.join(', PR #')}` : 'none';
  log('');
  log(`RESULT: ${result.reviewed} PRs reviewed, ${result.approved} approved, ${result.escalated} escalated`);
  log(`Merged: ${mergedStr}`);
  log(`Full report: ${reportPath}`);

  log(`\nTotal time: ${formatElapsed(deps.now() - reviewStart)}`);

  await writeReport(deps, reportPath, reportLines, result);
  return result;
}

/**
 * Run the fix-agent loop for a PR with minor findings.
 * Max MAX_FIX_PASSES passes; escalates if still minor after all passes.
 *
 * WHY passCount >= MAX_FIX_PASSES BEFORE spawning: prevents spawning a 4th agent
 * when the loop has already run 3 times.
 */
async function runFixAgentLoop(
  deps: CoordinatorDeps,
  opts: PrReviewOpts,
  pr: PrSummary,
  initialFindings: ReviewFindings,
  initialOutcome: PrOutcome,
  coordinatorStartMs: number,
  log: (line: string) => void,
  /** Assembled context from the initial review spawn. Forwarded to re-review spawns. */
  reviewSpawnContext?: Readonly<Record<string, unknown>>,
): Promise<PrOutcome> {
  let passCount = 0;
  let currentFindings = initialFindings;
  let sessionHandles = [...initialOutcome.sessionHandles];

  while (passCount < MAX_FIX_PASSES) {
    // Rule 3: go/no-go time check before spawning
    if (!opts.dryRun && deps.now() - coordinatorStartMs > COORDINATOR_SPAWN_CUTOFF_MS) {
      log(`      PR #${pr.number}  ->  coordinator elapsed > 70 minutes, escalating`);
      return {
        ...initialOutcome,
        passCount,
        sessionHandles,
        escalated: true,
        escalationReason: 'coordinator elapsed > 70 minutes',
      };
    }

    passCount++;
    const fixGoal = buildFixGoal(pr.number, currentFindings);

    if (opts.dryRun) {
      log(`      PR #${pr.number}  ->  [dry-run] would spawn fix agent (pass ${passCount}): ${fixGoal}`);
      return {
        ...initialOutcome,
        passCount,
        sessionHandles,
        severity: 'clean',
        merged: false,
        escalated: false,
        escalationReason: null,
      };
    }

    log(`      PR #${pr.number}  ->  spawning fix agent (pass ${passCount})...`);

    const fixSpawnResult = await deps.spawnSession(
      'coding-task-workflow-agentic',
      fixGoal,
      opts.workspace,
    );

    if (fixSpawnResult.kind === 'err') {
      log(`      PR #${pr.number}  ->  fix agent spawn failed: ${fixSpawnResult.error}`);
      return {
        ...initialOutcome,
        passCount,
        sessionHandles,
        escalated: true,
        escalationReason: `fix agent spawn error (pass ${passCount}): ${fixSpawnResult.error}`,
      };
    }

    const fixHandle = fixSpawnResult.value;
    if (!fixHandle) {
      // Rule 2: zombie detection
      return {
        ...initialOutcome,
        passCount,
        sessionHandles,
        escalated: true,
        escalationReason: `fix agent returned empty handle (zombie, pass ${passCount})`,
      };
    }

    sessionHandles = [...sessionHandles, fixHandle];

    // Await fix agent (child session timeout: 15 minutes, Rule 1)
    const fixAwait = await deps.awaitSessions([fixHandle], CHILD_SESSION_TIMEOUT_MS);
    const fixResult = fixAwait.results[0];

    if (!fixResult || fixResult.outcome !== 'success') {
      const outcome = fixResult?.outcome ?? 'not_found';
      log(`      PR #${pr.number}  ->  fix agent ${outcome} (pass ${passCount})`);
      return {
        ...initialOutcome,
        passCount,
        sessionHandles,
        escalated: true,
        escalationReason: `fix agent ${outcome} (pass ${passCount})`,
      };
    }

    log(`      PR #${pr.number}  ->  fix done (pass ${passCount}), re-reviewing...`);

    // OP-4: Wall-clock cutoff check before re-review spawn.
    // Same guard as the fix-agent spawn above -- prevents running past 90 minutes
    // even if the fix agent itself ran close to the cutoff.
    if (!opts.dryRun && deps.now() - coordinatorStartMs > COORDINATOR_SPAWN_CUTOFF_MS) {
      log(`      PR #${pr.number}  ->  coordinator elapsed > 70 minutes, skipping re-review spawn`);
      return {
        ...initialOutcome,
        passCount,
        sessionHandles,
        escalated: true,
        escalationReason: 'coordinator elapsed > 70 minutes (re-review cutoff)',
      };
    }

    // Re-review after fix
    const reReviewGoal = `Re-review PR #${pr.number} after fixes (pass ${passCount})`;
    // Forward same context as the initial review spawn (assembled before first spawn).
    const reReviewSpawnResult = await deps.spawnSession(
      'mr-review-workflow-agentic',
      reReviewGoal,
      opts.workspace,
      reviewSpawnContext,
    );

    if (reReviewSpawnResult.kind === 'err') {
      log(`      PR #${pr.number}  ->  re-review spawn failed: ${reReviewSpawnResult.error}`);
      return {
        ...initialOutcome,
        passCount,
        sessionHandles,
        escalated: true,
        escalationReason: `re-review spawn error (pass ${passCount}): ${reReviewSpawnResult.error}`,
      };
    }

    const reReviewHandle = reReviewSpawnResult.value;
    if (!reReviewHandle) {
      return {
        ...initialOutcome,
        passCount,
        sessionHandles,
        escalated: true,
        escalationReason: `re-review returned empty handle (zombie, pass ${passCount})`,
      };
    }

    sessionHandles = [...sessionHandles, reReviewHandle];

    const reReviewAwait = await deps.awaitSessions([reReviewHandle], REVIEW_AWAIT_TIMEOUT_MS);
    const reReviewResult = reReviewAwait.results[0];

    if (!reReviewResult || reReviewResult.outcome !== 'success') {
      const outcome = reReviewResult?.outcome ?? 'not_found';
      log(`      PR #${pr.number}  ->  re-review ${outcome} (pass ${passCount})`);
      return {
        ...initialOutcome,
        passCount,
        sessionHandles,
        escalated: true,
        escalationReason: `re-review ${outcome} (pass ${passCount})`,
      };
    }

    const reAgentResult = await deps.getAgentResult(reReviewHandle);
    const reVerdictFromArtifact = readVerdictArtifact(reAgentResult.artifacts, reReviewHandle);
    const reFindingsResult = reVerdictFromArtifact !== null
      ? (() => {
          deps.stderr(`[INFO coord:source=artifact handle=${reReviewHandle.slice(0, 16)}] readVerdictArtifact succeeded (re-review pass ${passCount})`);
          return ok(reVerdictFromArtifact);
        })()
      : (() => {
          const reason = reAgentResult.artifacts.length > 0 ? 'no_valid_artifact' : 'no_artifacts';
          deps.stderr(`[INFO coord:source=keyword_scan reason=${reason} artifactCount=${reAgentResult.artifacts.length} handle=${reReviewHandle.slice(0, 16)}]`);
          return parseFindingsFromNotes(reAgentResult.recapMarkdown);
        })();
    const reSeverity: ReviewSeverity = reFindingsResult.kind === 'ok'
      ? reFindingsResult.value.severity
      : 'unknown';

    // Rule 5: traceability for re-review
    const traceBlock = JSON.stringify({
      childSessionId: reReviewHandle,
      outcome: reReviewResult.outcome,
      elapsedMs: reReviewResult.durationMs,
      severity: reSeverity,
    });
    deps.stderr(`[TRACE] ${traceBlock}`);

    log(`      PR #${pr.number}  ->  re-review result: ${reSeverity.toUpperCase()} (pass ${passCount})`);

    if (reSeverity === 'clean') {
      return {
        prNumber: pr.number,
        severity: 'clean',
        merged: false,
        escalated: false,
        escalationReason: null,
        passCount,
        sessionHandles,
      };
    }

    if (reSeverity === 'blocking' || reSeverity === 'unknown') {
      return {
        prNumber: pr.number,
        severity: reSeverity,
        merged: false,
        escalated: true,
        escalationReason: `severity: ${reSeverity} after fix (pass ${passCount})`,
        passCount,
        sessionHandles,
      };
    } else if (reSeverity !== 'minor') {
      // Compile-time exhaustiveness guard: if ReviewSeverity gains a new variant,
      // this will fail to compile, forcing the developer to handle the new case here.
      assertNever(reSeverity);
    }

    // Still minor -- continue loop
    currentFindings = reFindingsResult.kind === 'ok'
      ? reFindingsResult.value
      : { severity: 'minor', findingSummaries: [], raw: reAgentResult.recapMarkdown ?? '' };
  }

  // Exhausted max passes
  log(`      PR #${pr.number}  ->  ${MAX_FIX_PASSES} fix passes exhausted, escalating`);
  return {
    prNumber: pr.number,
    severity: 'minor',
    merged: false,
    escalated: true,
    escalationReason: `${MAX_FIX_PASSES} fix passes exhausted`,
    passCount: MAX_FIX_PASSES,
    sessionHandles,
  };
}

/**
 * Write the coordinator report markdown file.
 */
async function writeReport(
  deps: CoordinatorDeps,
  reportPath: string,
  logLines: string[],
  result: CoordinatorResult,
): Promise<void> {
  const today = new Date(deps.now()).toISOString().slice(0, 19).replace('T', ' ');
  const content = [
    `# PR Review Coordinator Report`,
    ``,
    `Generated: ${today}`,
    ``,
    `## Summary`,
    ``,
    `- PRs reviewed: ${result.reviewed}`,
    `- Approved and merged: ${result.approved}`,
    `- Escalated: ${result.escalated}`,
    result.mergedPrs.length > 0 ? `- Merged PRs: ${result.mergedPrs.map((n) => `#${n}`).join(', ')}` : `- Merged PRs: none`,
    ``,
    `## Run Log`,
    ``,
    `\`\`\``,
    ...logLines,
    `\`\`\``,
    ``,
  ].join('\n');

  try {
    await deps.writeFile(reportPath, content);
  } catch {
    // Non-fatal -- coordinator result is still valid even if report write fails
    deps.stderr(`Warning: could not write report to ${reportPath}`);
  }
}
