/**
 * Console-specific view model types (DTOs).
 *
 * These types shape v2 projection data for the Console UI.
 * They are the boundary between internal projections and the HTTP/UI layer.
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
  /** Absolute filesystem path to the git repo root, or null for sessions
   * recorded before this field was introduced. Used by the worktrees view
   * to group sessions and discover worktrees by repo. */
  readonly repoRoot: string | null;
  /** Filesystem mtime of the session directory (epoch ms). */
  readonly lastModifiedMs: number;
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
}

export interface ConsoleDagEdge {
  readonly edgeKind: 'acked_step' | 'checkpoint';
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly createdAtEventIndex: number;
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
}

export interface ConsoleSessionDetail {
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly health: ConsoleSessionHealth;
  readonly runs: readonly ConsoleDagRun[];
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
