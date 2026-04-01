/**
 * Worktree Service — reads git worktree state for the Console UI.
 *
 * Pure read-only. No DI needed — git is a stable external tool.
 * Runs git commands against the repo containing the CWD (or the provided root).
 *
 * Why not a port: git is not an application boundary we need to mock in tests.
 * The console is a dev-time tool; a real git repo is always present.
 */

import { execFileSync } from 'child_process';
import { basename } from 'path';
import type { ConsoleWorktreeSummary, ConsoleWorktreeListResponse, ConsoleRunStatus } from './console-types.js';

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and return stdout, or null if the command fails.
 *
 * null is an explicit failure signal — callers must handle it rather than
 * silently treating a failed command as empty output. Empty string is a
 * valid result (e.g. `git status --short` on a clean repo).
 */
function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

interface RawWorktree {
  path: string;
  head: string;
  branch: string | null; // null = detached
}

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * Each entry is separated by a blank line and looks like:
 *   worktree /abs/path
 *   HEAD abc1234
 *   branch refs/heads/my-branch   <- absent if detached
 *   detached                       <- present if detached
 */
function parseWorktreePorcelain(raw: string): RawWorktree[] {
  const entries: RawWorktree[] = [];
  for (const block of raw.split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const pathLine = lines.find(l => l.startsWith('worktree '));
    const headLine = lines.find(l => l.startsWith('HEAD '));
    const branchLine = lines.find(l => l.startsWith('branch '));
    if (!pathLine || !headLine) continue;
    const path = pathLine.slice('worktree '.length).trim();
    const head = headLine.slice('HEAD '.length).trim();
    const branch = branchLine
      ? branchLine.slice('branch refs/heads/'.length).trim()
      : null;
    entries.push({ path, head, branch });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Per-worktree enrichment
// ---------------------------------------------------------------------------

interface WorktreeEnrichment {
  headHash: string;
  headMessage: string;
  headTimestampMs: number;
  changedCount: number;
  aheadCount: number;
}

function enrichWorktree(wt: RawWorktree): WorktreeEnrichment {
  // Last commit: short hash, subject, unix timestamp — null if git fails
  const logRaw = git(wt.path, ['log', '-1', '--format=%h%n%s%n%ct']);
  const [hashLine, messageLine, timestampLine] = logRaw?.split('\n') ?? [];
  const headHash = hashLine?.trim() || wt.head.slice(0, 7);
  const headMessage = messageLine?.trim() ?? '';
  const headTimestampMs = timestampLine ? parseInt(timestampLine.trim(), 10) * 1000 : 0;

  // Changed files: staged + unstaged. null = git failed; 0 = genuinely clean.
  const statusRaw = git(wt.path, ['status', '--short']);
  const changedCount = statusRaw !== null
    ? statusRaw.split('\n').filter(l => l.trim()).length
    : 0;

  // Commits ahead of origin/main. null = git failed (e.g. no remote); treat as 0.
  const aheadRaw = git(wt.path, ['rev-list', '--count', 'origin/main..HEAD']);
  const aheadCount = aheadRaw !== null ? parseInt(aheadRaw, 10) : 0;

  return { headHash, headMessage, headTimestampMs, changedCount, aheadCount };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ActiveSessionsByBranch {
  /** branch name -> count of in_progress sessions */
  readonly counts: ReadonlyMap<string, number>;
}

/**
 * Build active session counts from session summaries.
 * Extracted so callers can pass in pre-fetched session data.
 */
export function buildActiveSessionCounts(
  sessions: ReadonlyArray<{ gitBranch: string | null; status: ConsoleRunStatus }>,
): ActiveSessionsByBranch {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    if (s.gitBranch && s.status === 'in_progress') {
      counts.set(s.gitBranch, (counts.get(s.gitBranch) ?? 0) + 1);
    }
  }
  return { counts };
}

/**
 * Return all git worktrees for the repo rooted at (or containing) `cwd`,
 * enriched with git status and joined with session data.
 */
export function getWorktreeList(
  cwd: string,
  activeSessions: ActiveSessionsByBranch,
): ConsoleWorktreeListResponse {
  const repoRoot = git(cwd, ['rev-parse', '--show-toplevel']);
  if (repoRoot === null) return { worktrees: [] };

  const porcelain = git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return { worktrees: [] };

  const worktrees: ConsoleWorktreeSummary[] = parseWorktreePorcelain(porcelain).map(wt => {
    const enrichment = enrichWorktree(wt);
    return {
      path: wt.path,
      name: basename(wt.path),
      branch: wt.branch,
      headHash: enrichment.headHash,
      headMessage: enrichment.headMessage,
      headTimestampMs: enrichment.headTimestampMs,
      changedCount: enrichment.changedCount,
      aheadCount: enrichment.aheadCount,
      activeSessionCount: wt.branch ? (activeSessions.counts.get(wt.branch) ?? 0) : 0,
    };
  });

  // Sort: active sessions first, then dirty, then by recency
  worktrees.sort((a, b) => {
    if (b.activeSessionCount !== a.activeSessionCount) return b.activeSessionCount - a.activeSessionCount;
    if (b.changedCount !== a.changedCount) return b.changedCount - a.changedCount;
    return b.headTimestampMs - a.headTimestampMs;
  });

  return { worktrees };
}
