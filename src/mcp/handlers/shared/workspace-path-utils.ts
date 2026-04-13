import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Returns true when root is an ancestor of (or equal to) workspace.
 * Uses purely lexical path comparison -- does not follow symlinks.
 */
export function isWorkspaceAncestor(root: string, workspace: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(workspace));
  return rel.length === 0 || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Returns the real absolute path of the git common directory for `dirPath`,
 * or null if `dirPath` is not inside a git repo or the command fails.
 *
 * Used to detect sibling worktrees: two directories sharing the same git common
 * dir belong to the same repository even if neither is an ancestor of the other.
 *
 * `git rev-parse --git-common-dir` may return a relative path (e.g. `.git`) on
 * older git versions when run inside the main worktree. We always resolve it
 * against `dirPath` and then apply `fs.realpath` to normalize symlinks (e.g.
 * on macOS /var is a symlink to /private/var, causing string comparison to fail
 * even when both paths point to the same directory).
 */
export async function getGitCommonDir(dirPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', dirPath, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf-8', timeout: 5_000 },
    );
    const raw = stdout.trim();
    if (!raw) return null;
    const resolved = path.resolve(dirPath, raw);
    return await fs.realpath(resolved);
  } catch {
    return null;
  }
}
