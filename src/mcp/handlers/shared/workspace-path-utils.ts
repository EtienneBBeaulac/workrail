import path from 'path';

/**
 * Returns true when root is an ancestor of (or equal to) workspace.
 * Uses purely lexical path comparison -- does not follow symlinks.
 */
export function isWorkspaceAncestor(root: string, workspace: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(workspace));
  return rel.length === 0 || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
