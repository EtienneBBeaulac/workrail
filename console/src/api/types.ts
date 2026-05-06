// Mirror of console-types.ts from the backend (Console DTOs)
// Keep in sync with src/v2/usecases/console-types.ts and src/v2/projections/session-metrics.ts

/** Status of an individual run within a session (execution-level). */
export type ConsoleRunStatus = 'in_progress' | 'complete' | 'complete_with_gaps' | 'blocked';

/** Status of a session as a whole (projection-level). Extends ConsoleRunStatus with
 * dormant, which is computed from inactivity and cannot apply to individual runs. */
export type ConsoleSessionStatus = ConsoleRunStatus | 'dormant';

/**
 * The status kind of a single changed file, derived from git status XY codes.
 *
 * Closed union so the UI can exhaustively map to colors without falling through
 * on unknown values at runtime.
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
 * convenience fields default to safe values (0, [], false, '').
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
  readonly path: string;
  readonly name: string;
  readonly branch: string | null;
  readonly headHash: string;
  readonly headMessage: string;
  readonly headTimestampMs: number;
  readonly changedCount: number;
  /** Individual files with uncommitted changes, in git status --short order. */
  readonly changedFiles: readonly ChangedFile[];
  readonly aheadCount: number;
  /** Individual unpushed commits (git log origin/main..HEAD --oneline). */
  readonly unpushedCommits: readonly { readonly hash: string; readonly message: string }[];
  /** True when the branch has been merged into main (0 unpushed commits, not main, not detached). */
  readonly isMerged: boolean;
  readonly activeSessionCount: number;
  /** Content of `git config branch.<name>.description`. Absent when unset. */
  readonly description?: string;
  /**
   * Full git enrichment data. null when background enrichment has not yet completed.
   * UI components that show git badges should display a skeleton shimmer when null.
   */
  readonly enrichment: WorktreeEnrichment | null;
}

export interface ConsoleRepoWorktrees {
  readonly repoName: string;
  readonly repoRoot: string;
  readonly worktrees: readonly ConsoleWorktreeSummary[];
}

export interface ConsoleWorktreeListResponse {
  readonly repos: readonly ConsoleRepoWorktrees[];
}
export type ConsoleSessionHealth = 'healthy' | 'corrupt';

/**
 * Structured outcome metrics for a completed session run.
 * Mirror of SessionMetricsV2 in src/v2/projections/session-metrics.ts.
 * Keep in sync with the backend definition.
 */
export interface SessionMetricsV2 {
  // From run_completed event (engine-authoritative)
  readonly startGitSha: string | null;
  readonly endGitSha: string | null;
  readonly gitBranch: string | null;
  readonly agentCommitShas: readonly string[];
  readonly captureConfidence: 'high' | 'none';
  readonly durationMs: number | undefined;
  // From context_set metrics_* keys (agent-reported, each independently nullable)
  readonly outcome: 'success' | 'partial' | 'abandoned' | 'error' | null;
  readonly prNumbers: readonly number[];
  readonly filesChanged: number | null;
  readonly linesAdded: number | null;
  readonly linesRemoved: number | null;
}

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
  /** Repo root path from the session record. Used as fallback when worktree data is unavailable. */
  readonly repoRoot: string | null;
  readonly lastModifiedMs: number;
  /** True when the session was started by the WorkRail autonomous daemon.
   * Durable: derived from context_set event with is_autonomous: 'true'. */
  readonly isAutonomous: boolean;
  /** True when the session is currently registered in DaemonRegistry with a recent heartbeat.
   * Ephemeral: always false when daemon is not running. */
  readonly isLive: boolean;
  /** Session ID of the parent coordinator session. null for root sessions. */
  readonly parentSessionId: string | null;
  /** Structured outcome metrics for the session's first completed run.
   * Null for sessions still in progress or sessions that predate the run_completed feature. */
  readonly metrics: SessionMetricsV2 | null;
}

export interface ConsoleSessionListResponse {
  readonly sessions: readonly ConsoleSessionSummary[];
  readonly totalCount: number;
}

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

export interface ConsoleSessionDetail {
  readonly sessionId: string;
  readonly sessionTitle: string | null;
  readonly health: ConsoleSessionHealth;
  readonly runs: readonly ConsoleDagRun[];
  /**
   * Structured outcome metrics for the session's first completed run.
   * Null for sessions still in progress or sessions that predate the run_completed feature.
   * Mirror of ConsoleSessionDetail.metrics in src/v2/usecases/console-types.ts.
   */
  readonly metrics: SessionMetricsV2 | null;
  /**
   * Absolute filesystem path to the repo root. Used by the diff-summary endpoint.
   * Mirror of ConsoleSessionDetail.repoRoot in src/v2/usecases/console-types.ts.
   */
  readonly repoRoot: string | null;
  /**
   * Context injected into this session at dispatch time.
   * Absent for sessions that received no assembled context.
   * Mirror of ConsoleSessionDetail.injectedContext in src/v2/usecases/console-types.ts.
   */
  readonly injectedContext?: {
    readonly assembledContextSummary: string;
  };
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
  readonly stepCount?: number;
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

// ---------------------------------------------------------------------------
// Performance Tracing
// ---------------------------------------------------------------------------

export interface ToolCallTiming {
  readonly toolName: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly outcome: 'success' | 'error' | 'unknown_tool';
}

export interface PerfToolCallsResponse {
  readonly observations: readonly ToolCallTiming[];
  readonly devMode: boolean;
}

// ---------------------------------------------------------------------------
// API Envelope
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

// Layer 3b: ghost step type (appended)
export interface ConsoleGhostStep {
  readonly stepId: string;
  readonly stepLabel: string | null;
}

// ---------------------------------------------------------------------------
// AUTO dispatch types
// ---------------------------------------------------------------------------

/** Summary of a single trigger loaded from triggers.yml. */
export interface TriggerSummary {
  readonly id: string;
  readonly provider: string;
  readonly workflowId: string;
  readonly workspacePath: string;
  readonly goal: string;
  /** ISO 8601 timestamp of the last time this trigger fired, if available. */
}

/** Response from GET /api/v2/triggers */
export interface TriggerListResponse {
  readonly triggers: readonly TriggerSummary[];
}

/** Request body for POST /api/v2/auto/dispatch */
export interface AutoDispatchRequest {
  readonly workflowId: string;
  readonly goal: string;
  readonly workspacePath: string;
  readonly context?: Record<string, unknown>;
}

/** Response from POST /api/v2/auto/dispatch */
export interface AutoDispatchResponse {
  readonly status: 'dispatched';
  readonly workflowId: string;
}

/** Response from GET /api/v2/sessions/:id/diff-summary */
export interface DiffSummaryResponse {
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly filesChanged: number;
}
