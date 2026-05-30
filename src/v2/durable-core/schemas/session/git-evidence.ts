/**
 * GitEvidence types: authoritative engine-side git diff data for a completed session.
 *
 * WHY here (in durable-core) and not in mcp/git-metrics/types.ts:
 * projections/session-metrics.ts must not import from the MCP layer
 * (architecture lock: projections are internal-only, v2-core-design-locks.md Section 6).
 * Defining the shared types in durable-core makes them accessible to both sides:
 * - projections/session-metrics.ts (reads git_metrics_recorded events)
 * - mcp/git-metrics/record.ts (writes git_metrics_recorded events)
 *
 * Nullability invariant (applies to all nullable fields):
 * - null means the corresponding git command failed or timed out.
 * - Zero-change results are represented as zero-valued structs (not null).
 *   Example: readWorkingTreeState on a clean repo returns { stagedFiles: 0, unstagedFiles: 0 }.
 */

/**
 * Committed diff between startSha and current HEAD.
 * Derived from `git diff startSha..HEAD --numstat --no-renames`.
 *
 * null on GitEvidence.committedDiff means the diff command failed or timed out.
 */
export type GitCommittedDiff = {
  readonly filesChanged: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /**
   * true when the diff output was truncated to the line limit.
   * The stats reflect partial data only.
   */
  readonly truncated: boolean;
  /**
   * Changed file paths from this diff (bounded by the numstat line limit).
   * Used for churn detection: which files to check for post-session re-modification.
   */
  readonly changedFilePaths: readonly string[];
  /**
   * File count per extension, derived from changedFilePaths.
   * Keys are lowercase extensions including the dot (e.g. '.ts', '.swift').
   * Files with no extension map to '' (empty string).
   * Empty object when no files changed or diff was unavailable.
   */
  readonly languageBreakdown: Readonly<Record<string, number>>;
};

/**
 * Working tree state: staged and unstaged file counts.
 * Captured at session start (baseline) and session completion (final state).
 *
 * null on GitEvidence.workingTree means the git status command failed or timed out.
 */
export type GitWorkingTreeState = {
  /** Files with staged changes (git diff --cached). */
  readonly stagedFiles: number;
  /** Files with unstaged changes (git diff). */
  readonly unstagedFiles: number;
};

/**
 * Authoritative git evidence for a completed session.
 * Populated from the `git_metrics_recorded` event.
 *
 * null on SessionMetricsV2.gitEvidence means no git_metrics_recorded event
 * exists for this session (session predates the feature, or completed before
 * the recording fired).
 */
export type GitEvidence = {
  readonly startSha: string | null;
  readonly endSha: string | null;
  /** Commits authored between startSha and endSha (exclusive of startSha). */
  readonly commitShas: readonly string[];
  /** PR numbers parsed from commit messages (#123, Closes #123, Fixes #123). */
  readonly prRefs: readonly number[];
  /**
   * Committed diff stats between startSha and endSha.
   * null means the diff command failed or timed out.
   * Zero-change returns { filesChanged: 0, linesAdded: 0, linesRemoved: 0, truncated: false }.
   */
  readonly committedDiff: GitCommittedDiff | null;
  /**
   * Working tree state at session completion.
   * null means the git status command failed or timed out.
   */
  readonly workingTree: GitWorkingTreeState | null;
  /** Authoritative confidence level for the diff data. */
  readonly captureConfidence: 'high' | 'partial' | 'none';
  /**
   * Code churn signal: files that were re-modified by other commits within
   * windowDays after this session ended.
   * null means the churn check was not run (git unavailable or no changed files).
   * { filesRemodified: 0 } means no churn detected.
   */
  readonly churnSignal: { readonly filesRemodified: number; readonly windowDays: number } | null;
};
