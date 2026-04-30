/**
 * Port for capturing git state at session completion.
 *
 * WHY a separate port from WorkspaceContextResolverPortV2:
 * WorkspaceContextResolverPortV2 resolves workspace identity anchors at session
 * START (branch, HEAD SHA). This port resolves the end-state snapshot at session
 * COMPLETION -- a different moment with different semantics. Keeping them separate
 * avoids giving the start-state port an end-state responsibility.
 *
 * WHY --no-merges --first-parent for commitShas:
 * We want only commits made on the session's branch, not merge commits from main
 * or upstream commits that landed via merge. --first-parent follows only the
 * checked-out branch's history; --no-merges excludes merge commits.
 */

/**
 * The git snapshot captured at session completion.
 * Both fields degrade gracefully to null/[] when git is unavailable.
 */
export interface GitEndSnapshot {
  /** HEAD SHA at session completion. null if git unavailable or not a git repo. */
  readonly endSha: string | null;
  /**
   * Commits made on this branch since startSha.
   * Derived from `git log --no-merges --first-parent startSha..HEAD --format=%H`.
   * Empty array when startSha is null, git unavailable, or no commits were made.
   */
  readonly commitShas: readonly string[];
}

/**
 * Port for resolving git state at session completion.
 *
 * Implementors must:
 * - Never throw -- degrade gracefully on any git failure
 * - Respect the 2000ms timeout to avoid blocking the MCP response path
 * - Use --no-merges --first-parent for commitShas to scope to branch-local commits
 */
export interface GitSnapshotPortV2 {
  resolveEndSnapshot(
    repoRoot: string | null,
    startSha: string | null,
  ): Promise<GitEndSnapshot>;
}

/**
 * Null object implementation of GitSnapshotPortV2.
 *
 * WHY in the port file (not infra): null objects implement the port interface and
 * must be importable from any layer including MCP handlers, which cannot import
 * from v2/infra/ (composition root discipline). The port file is visible to all layers.
 */
export class NullGitSnapshotV2 implements GitSnapshotPortV2 {
  async resolveEndSnapshot(): Promise<GitEndSnapshot> {
    return { endSha: null, commitShas: [] };
  }
}
