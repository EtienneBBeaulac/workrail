import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitEndSnapshot, GitSnapshotPortV2 } from '../../../ports/git-snapshot.port.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 2000;

/**
 * Local git snapshot adapter.
 *
 * Runs two git commands in parallel at session completion:
 * 1. `git rev-parse HEAD` -- end SHA
 * 2. `git log --no-merges --first-parent <startSha>..HEAD --format=%H` -- branch-local commits
 *
 * WHY parallel: both are independent read-only queries against the same repo.
 * Running in parallel keeps the MCP response path latency at max(t1, t2) rather than t1 + t2.
 *
 * WHY --no-merges --first-parent: scopes to commits made on the session's branch only.
 * Without these flags, upstream merges and merge commits from main would appear in the list.
 *
 * WHY best-effort (never throws): this runs in the MCP advance handler response path.
 * A git failure must never block session completion.
 */
export class LocalGitSnapshotV2 implements GitSnapshotPortV2 {
  async resolveEndSnapshot(
    repoRoot: string | null,
    startSha: string | null,
  ): Promise<GitEndSnapshot> {
    if (!repoRoot) return { endSha: null, commitShas: [] };

    const [endSha, commitShas] = await Promise.all([
      this.resolveEndSha(repoRoot),
      this.resolveCommitRange(repoRoot, startSha),
    ]);

    return { endSha, commitShas };
  }

  private async resolveEndSha(repoRoot: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: repoRoot, timeout: GIT_TIMEOUT_MS },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async resolveCommitRange(repoRoot: string, startSha: string | null): Promise<readonly string[]> {
    if (!startSha) return [];
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', '--no-merges', '--first-parent', `${startSha}..HEAD`, '--format=%H'],
        { cwd: repoRoot, timeout: GIT_TIMEOUT_MS },
      );
      return stdout.trim().split('\n').filter(s => s.length > 0);
    } catch {
      return [];
    }
  }
}
