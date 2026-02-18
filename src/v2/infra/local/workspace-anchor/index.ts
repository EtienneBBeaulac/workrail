import { ResultAsync as RA, okAsync } from 'neverthrow';
import type {
  WorkspaceAnchorPortV2,
  WorkspaceContextResolverPortV2,
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
 * Implements both the legacy WorkspaceAnchorPortV2 (resolves from constructor CWD)
 * and WorkspaceContextResolverPortV2 (resolves from an explicit URI or CWD fallback).
 *
 * Graceful degradation: returns empty list on non-git dirs or command failures.
 * Observation emission must never block workflow start.
 */
export class LocalWorkspaceAnchorV2 implements WorkspaceAnchorPortV2, WorkspaceContextResolverPortV2 {
  constructor(private readonly defaultCwd: string) {}

  // WorkspaceAnchorPortV2 — delegates to defaultCwd for backward compat
  resolveAnchors(): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    return this.resolveFromPath(this.defaultCwd);
  }

  // WorkspaceContextResolverPortV2
  resolveFromUri(rootUri: string): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    const fsPath = uriToFsPath(rootUri);
    // Non-file:// URIs (http://, etc.) return empty — graceful, not an error.
    if (fsPath === null) return okAsync([]);
    return this.resolveFromPath(fsPath);
  }

  resolveFromCwd(): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    return this.resolveFromPath(this.defaultCwd);
  }

  private resolveFromPath(cwd: string): RA<readonly WorkspaceAnchor[], WorkspaceAnchorError> {
    return RA.fromPromise(
      this.resolve(cwd),
      (cause): WorkspaceAnchorError => ({
        code: 'ANCHOR_RESOLVE_FAILED',
        message: `Failed to resolve workspace anchors: ${String(cause)}`,
      }),
    );
  }

  private async resolve(cwd: string): Promise<readonly WorkspaceAnchor[]> {
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
