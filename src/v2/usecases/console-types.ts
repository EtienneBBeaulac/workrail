/**
 * Console-specific view model types (DTOs).
 *
 * These types shape v2 projection data for the Console UI.
 * They are the boundary between internal projections and the HTTP/UI layer.
 *
 * These types are mirrored in console/src/api/types.ts. Keep both files in sync
 * until a shared codegen solution exists.
 */

// ---------------------------------------------------------------------------
// Session List
// ---------------------------------------------------------------------------

/** Status of an individual run within a session (execution-level). */
export type ConsoleRunStatus = 'in_progress' | 'complete' | 'complete_with_gaps' | 'blocked';

/** Status of a session as a whole (projection-level). Extends ConsoleRunStatus with
 * dormant, which is computed from inactivity and cannot apply to individual runs. */
export type ConsoleSessionStatus = ConsoleRunStatus | 'dormant';

export type ConsoleSessionHealth = 'healthy' | 'corrupt';

export interface ConsoleSessionSummary {
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly workflowId: string | null;
  readonly workflowName: string | null;
  readonly workflowHash: string | null;
  readonly runId: string | null;
  readonly status: ConsoleSessionStatus;
  readonly health: ConsoleSessionHealth;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly tipCount: number;
  readonly hasUnresolvedGaps: boolean;
  readonly recapSnippet: string | null;
  readonly gitBranch: string | null;
  /** Absolute filesystem path to the repo root, derived from the session's repo_root
   * observation event. Used by the console workspace view to group sessions by repo
   * when no matching worktree is available (standalone console fallback). */
  readonly repoRoot: string | null;
  /** Filesystem mtime of the session directory (epoch ms). */
  readonly lastModifiedMs: number;
  /** True when the session was started by the WorkRail autonomous daemon.
   * Durable: derived from context_set event with is_autonomous: 'true'. */
  readonly isAutonomous: boolean;
  /** True when the daemon event log for today contains a session_started event for this
   * session but no session_completed event. Derived from disk -- survives console restarts.
   * False on any read error (safe default). */
  readonly isLive: boolean;
}

export interface ConsoleSessionListResponse {
  readonly sessions: readonly ConsoleSessionSummary[];
  readonly totalCount: number;
}

// ---------------------------------------------------------------------------
// Session Detail
// ---------------------------------------------------------------------------

export interface ConsoleDagNode {
  readonly nodeId: string;
  readonly nodeKind: 'step' | 'checkpoint' | 'blocked_attempt';
  readonly parentNodeId: string | null;
  readonly createdAtEventIndex: number;
  readonly isPreferredTip: boolean;
  readonly isTip: boolean;
  readonly stepLabel: string | null;
  /** Node has a current recap output (node_output_appended with recap channel). */
  readonly hasRecap: boolean;
  /** Node has at least one failed validation (VALIDATION_PERFORMED with valid=false). */
  readonly hasFailedValidations: boolean;
  /** Node has at least one associated gap (resolved or unresolved). */
  readonly hasGaps: boolean;
  /** Node has at least one artifact output. */
  readonly hasArtifacts: boolean;
}

export interface ConsoleDagEdge {
  readonly edgeKind: 'acked_step' | 'checkpoint';
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly createdAtEventIndex: number;
}

export type ConsoleExecutionTraceItemKind =
  | 'selected_next_step'
  | 'evaluated_condition'
  | 'entered_loop'
  | 'exited_loop'
  | 'detected_non_tip_advance'
  | 'context_fact'
  | 'divergence';

export interface ConsoleExecutionTraceRef {
  readonly kind: 'node_id' | 'step_id' | 'loop_id' | 'condition_id';
  readonly value: string;
}

export interface ConsoleExecutionTraceItem {
  readonly kind: ConsoleExecutionTraceItemKind;
  readonly summary: string;
  readonly recordedAtEventIndex: number;
  readonly refs: readonly ConsoleExecutionTraceRef[];
}

export interface ConsoleExecutionTraceFact {
  readonly key: string;
  readonly value: string;
}

export interface ConsoleExecutionTraceSummary {
  readonly items: readonly ConsoleExecutionTraceItem[];
  readonly contextFacts: readonly ConsoleExecutionTraceFact[];
}

export interface ConsoleDagRun {
  readonly runId: string;
  readonly workflowId: string | null;
  readonly workflowName: string | null;
  readonly workflowHash: string | null;
  readonly preferredTipNodeId: string | null;
  readonly nodes: readonly ConsoleDagNode[];
  readonly edges: readonly ConsoleDagEdge[];
  readonly tipNodeIds: readonly string[];
  readonly status: ConsoleRunStatus;
  readonly hasUnresolvedCriticalGaps: boolean;
  // Reserved: consumed by ExecutionTrace panel (not yet implemented)
  readonly executionTraceSummary: ConsoleExecutionTraceSummary | null;
  readonly skippedSteps: readonly ConsoleGhostStep[];
}

/**
 * A single tool call recorded in the daemon event log.
 * Shown in the console as live activity for actively-running daemon sessions.
 */
export interface ConsoleToolActivity {
  /** Name of the tool that was called (e.g. 'Bash', 'Read', 'Write', 'continue_workflow'). */
  readonly toolName: string;
  /** First 80 chars of the primary tool parameter. Absent for some tool calls. */
  readonly summary?: string;
  /** Unix epoch ms when the tool call was recorded. */
  readonly ts: number;
}

export interface ConsoleSessionDetail {
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly health: ConsoleSessionHealth;
  readonly runs: readonly ConsoleDagRun[];
  /**
   * The last N tool calls recorded in the daemon event log for this session.
   * Only present when the session is currently live (isLive=true in the session summary)
   * and the daemon event log contains correlated tool_called events.
   * null when the session is not live, the daemon is not running in the same process,
   * or the event log cannot be read.
   */
  readonly liveActivity?: readonly ConsoleToolActivity[] | null;
}

// ---------------------------------------------------------------------------
// Node Detail
// ---------------------------------------------------------------------------

export type ConsoleValidationOutcome = 'pass' | 'fail';

export interface ConsoleValidationResult {
  readonly validationId: string;
  readonly attemptId: string;
  readonly contractRef: string;
  readonly outcome: ConsoleValidationOutcome;
  readonly issues: readonly string[];
  readonly suggestions: readonly string[];
}

export type ConsoleAdvanceOutcomeKind = 'advanced' | 'blocked';

export interface ConsoleAdvanceOutcome {
  readonly attemptId: string;
  readonly kind: ConsoleAdvanceOutcomeKind;
  readonly recordedAtEventIndex: number;
}

export interface ConsoleNodeGap {
  readonly gapId: string;
  readonly severity: 'critical' | 'non_critical';
  readonly summary: string;
  readonly isResolved: boolean;
}

export interface ConsoleArtifact {
  readonly sha256: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly content: unknown;
}

// ---------------------------------------------------------------------------
// Worktree List
// ---------------------------------------------------------------------------

/**
 * The status kind of a single changed file, derived from git status XY codes.
 *
 * Closed union so the console UI can exhaustively map to colors without
 * falling through on unknown values at runtime.
 */
export type FileChangeStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'other';

/** A single file with uncommitted changes, as reported by `git status --short`. */
export interface ChangedFile {
  readonly status: FileChangeStatus;
  /** File path relative to the worktree root. For renamed files, includes arrow notation (e.g. `old -> new`). */
  readonly path: string;
}

/**
 * Git enrichment data for a single worktree. Available only after the background
 * enrichment scan completes. When null on ConsoleWorktreeSummary, the flat
 * convenience fields below default to safe values (0, [], false, '').
 */
export interface WorktreeEnrichment {
  readonly headHash: string;
  readonly headMessage: string;
  readonly headTimestampMs: number;
  readonly changedCount: number;
  readonly changedFiles: readonly ChangedFile[];
  readonly aheadCount: number;
  readonly unpushedCommits: readonly { readonly hash: string; readonly message: string }[];
  readonly isMerged: boolean;
  /** Content of `git config branch.<name>.description`, or empty string if unset. */
  readonly description: string;
}

export interface ConsoleWorktreeSummary {
  /** Absolute path to the worktree directory. */
  readonly path: string;
  /** Directory basename — used as display name. */
  readonly name: string;
  /** Branch name, or null if detached HEAD. */
  readonly branch: string | null;
  /** Short commit hash of HEAD. */
  readonly headHash: string;
  /** First line of the HEAD commit message. */
  readonly headMessage: string;
  /** Unix epoch ms of the HEAD commit. */
  readonly headTimestampMs: number;
  /** Number of files with uncommitted changes (staged + unstaged). */
  readonly changedCount: number;
  /** Individual files with uncommitted changes, in git status --short order. */
  readonly changedFiles: readonly ChangedFile[];
  /** Number of commits ahead of origin/main. */
  readonly aheadCount: number;
  /** Individual unpushed commits (git log origin/main..HEAD --oneline). */
  readonly unpushedCommits: readonly { readonly hash: string; readonly message: string }[];
  /** True when the branch has been merged into main (0 unpushed commits, not main, not detached). */
  readonly isMerged: boolean;
  /** Number of in_progress workflow sessions on this branch. */
  readonly activeSessionCount: number;
  /** Content of `git config branch.<name>.description`. Absent when unset. */
  readonly description?: string;
  /**
   * Full git enrichment data. null when the background enrichment scan has not yet
   * completed for this worktree. When null, all flat fields above default to safe
   * values (headHash: '', changedCount: 0, changedFiles: [], aheadCount: 0,
   * unpushedCommits: [], isMerged: false).
   *
   * Consumers that need to distinguish "enrichment not yet available" from
   * "enrichment complete with zero changes" should check this field.
   * UI components that show git badges should show a skeleton shimmer when null.
   */
  readonly enrichment: WorktreeEnrichment | null;
}

export interface ConsoleRepoWorktrees {
  /** Directory basename of the repo root (e.g. 'workrail', 'zillow-android-2'). */
  readonly repoName: string;
  /** Absolute filesystem path to the repo root. */
  readonly repoRoot: string;
  readonly worktrees: readonly ConsoleWorktreeSummary[];
}

export interface ConsoleWorktreeListResponse {
  readonly repos: readonly ConsoleRepoWorktrees[];
}

// ---------------------------------------------------------------------------
// Node Detail
// ---------------------------------------------------------------------------

export interface ConsoleNodeDetail {
  readonly nodeId: string;
  readonly nodeKind: 'step' | 'checkpoint' | 'blocked_attempt';
  readonly parentNodeId: string | null;
  readonly createdAtEventIndex: number;
  readonly isPreferredTip: boolean;
  readonly isTip: boolean;
  readonly stepLabel: string | null;
  readonly recapMarkdown: string | null;
  readonly artifacts: readonly ConsoleArtifact[];
  readonly advanceOutcome: ConsoleAdvanceOutcome | null;
  readonly validations: readonly ConsoleValidationResult[];
  readonly gaps: readonly ConsoleNodeGap[];
}

// ---------------------------------------------------------------------------
// Workflow Catalog
// ---------------------------------------------------------------------------

export interface ConsoleWorkflowSourceInfo {
  readonly kind: 'bundled' | 'user' | 'project' | 'custom' | 'git' | 'remote' | 'plugin';
  readonly displayName: string;
}

export interface ConsoleWorkflowSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly tags: readonly string[];
  readonly source: ConsoleWorkflowSourceInfo;
  readonly about?: string;
  readonly examples?: readonly string[];
}

export interface ConsoleWorkflowListResponse {
  readonly workflows: readonly ConsoleWorkflowSummary[];
}

export interface ConsoleWorkflowDetail {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly tags: readonly string[];
  readonly source: ConsoleWorkflowSourceInfo;
  readonly stepCount: number;
  readonly about?: string;
  readonly examples?: readonly string[];
  readonly preconditions?: readonly string[];
}

// Layer 3b: ghost step type (appended)
export interface ConsoleGhostStep {
  readonly stepId: string;
  readonly stepLabel: string | null;
}
