import { ResultAsync as RA, okAsync } from 'neverthrow';
import type {
  WorkspaceContextResolverPortV2,
  WorkspaceSource,
  WorkspaceAnchor,
  WorkspaceAnchorError,
} from '../../../ports/workspace-anchor.port.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

/**
 * Local workspace anchor adapter.
 *
 * Resolves git identity signals (branch, HEAD SHA) for workspace resume ranking.
 * Implements WorkspaceContextResolverPortV2 via a single resolve(source) method
 * that exhaustively handles all WorkspaceSource variants.
 *
 * Why a single method over multiple method overloads:
 * - Exhaustive switch catches unhandled variants at compile time
 * - Source selection (which variant to use) stays in the handler layer
 * - Adapter is purely about resolution mechanics, not priority decisions
 *
 * Graceful degradation: all paths return empty list on non-git dirs,
 * missing git binary, permission errors, or command failures.
 * Observation emission must never block workflow start.
 *
 * Lock: §DI — side effects at the edges only.
 */
export class LocalWorkspaceAnchorV2 implements WorkspaceContextResolverPortV2 {
  constructor(private readonly defaultCwd: string) {}

  resolve(source: WorkspaceSource): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    switch (source.kind) {
      case 'explicit_path':
        return this.resolveGitIdentityAt(source.path);

      case 'mcp_root_uri': {
        const fsPath = uriToFsPath(source.uri);
        // Non-file:// URIs (http://, etc.) produce no anchors — graceful, not an error.
        if (fsPath === null) return okAsync([]);
        return this.resolveGitIdentityAt(fsPath);
      }

      case 'server_cwd':
        return this.resolveGitIdentityAt(this.defaultCwd);
    }
  }

  private resolveGitIdentityAt(cwd: string): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    return RA.fromPromise(
      this.runGitCommands(cwd),
      (cause): WorkspaceAnchorError => ({
        code: 'ANCHOR_RESOLVE_FAILED',
        message: `Failed to resolve workspace anchors: ${String(cause)}`,
      }),
    );
  }

  private async runGitCommands(cwd: string): Promise<readonly WorkspaceAnchor[]> {
    const anchors: WorkspaceAnchor[] = [];

    // git branch: read symbolic ref (graceful: empty on detached HEAD or non-git)
    const branch = await this.gitCommand('git rev-parse --abbrev-ref HEAD', cwd);
    if (branch && branch !== 'HEAD') {
      anchors.push({ key: 'git_branch', value: branch });
    }

    // git head sha: read full commit hash
    const sha = await this.gitCommand('git rev-parse HEAD', cwd);
    if (sha && /^[0-9a-f]{40}$/.test(sha)) {
      anchors.push({ key: 'git_head_sha', value: sha });
    }

    return anchors;
  }

  private async gitCommand(cmd: string, cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(cmd, {
        cwd,
        timeout: 5_000,
        encoding: 'utf8',
      });
      return stdout.trim() || null;
    } catch {
      // Graceful degradation: non-git dirs, missing git, permission errors, etc.
      return null;
    }
  }
}

/**
 * Convert a file:// URI to a filesystem path using Node's fileURLToPath.
 *
 * fileURLToPath correctly handles:
 * - POSIX: file:///path/to/dir → /path/to/dir
 * - Windows: file:///C:/path → C:\path (drive letter preserved)
 * - Percent-encoded characters are decoded
 *
 * Returns null for non-file:// URIs so callers can degrade gracefully.
 */
function uriToFsPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}
