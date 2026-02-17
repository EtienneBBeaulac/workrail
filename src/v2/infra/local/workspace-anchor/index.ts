import { ResultAsync as RA, okAsync } from 'neverthrow';
import type { WorkspaceAnchorPortV2, WorkspaceAnchor, WorkspaceAnchorError } from '../../../ports/workspace-anchor.port.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Local workspace anchor adapter.
 *
 * Resolves git identity from the current working directory.
 * Graceful degradation: returns empty list on non-git dirs or command failures.
 *
 * Lock: §DI — side effects at the edges only.
 */
export class LocalWorkspaceAnchorV2 implements WorkspaceAnchorPortV2 {
  constructor(private readonly cwd: string) {}

  resolveAnchors(): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    return RA.fromPromise(
      this.resolve(),
      (cause): WorkspaceAnchorError => ({
        code: 'ANCHOR_RESOLVE_FAILED',
        message: `Failed to resolve workspace anchors: ${String(cause)}`,
      }),
    );
  }

  private async resolve(): Promise<readonly WorkspaceAnchor[]> {
    const anchors: WorkspaceAnchor[] = [];

    // git branch: read symbolic ref (graceful: empty on detached HEAD or non-git)
    const branch = await this.gitCommand('git rev-parse --abbrev-ref HEAD');
    if (branch && branch !== 'HEAD') {
      anchors.push({ key: 'git_branch', value: branch });
    }

    // git head sha: read full commit hash
    const sha = await this.gitCommand('git rev-parse HEAD');
    if (sha && /^[0-9a-f]{40}$/.test(sha)) {
      anchors.push({ key: 'git_head_sha', value: sha });
    }

    return anchors;
  }

  private async gitCommand(cmd: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(cmd, {
        cwd: this.cwd,
        timeout: 5_000,
        encoding: 'utf8',
      });
      return stdout.trim() || null;
    } catch {
      // Graceful degradation: non-git dirs, missing git, etc.
      return null;
    }
  }
}
