/**
 * Worktree Service — reads git worktree state for the Console UI.
 *
 * Pure read-only. No DI needed — git is a stable external tool.
 * Runs git commands against the repo containing the CWD (or the provided root).
 *
 * Why not a port: git is not an application boundary we need to mock in tests.
 * The console is a dev-time tool; a real git repo is always present.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { basename } from 'path';
import type { ConsoleWorktreeSummary, ConsoleWorktreeListResponse, ConsoleRunStatus } from './console-types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** 5 s ceiling per git command — prevents the endpoint hanging on credential
 * prompts, network fetches, or a locked index. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Discriminate child_process execution errors from programmer errors.
 *
 * Execution errors (non-zero exit, ENOENT, ETIMEDOUT) are set by Node's
 * child_process module and always carry a `killed` property. TypeError,
 * ReferenceError, etc. do not — those are bugs in our code and must
 * propagate rather than being silently swallowed.
 */
function isExecError(e: unknown): boolean {
  return e instanceof Error && 'killed' in e;
}

/**
 * Run a git command and return stdout trimmed, or null on execution failure.
 *
 * null is an explicit signal — callers must handle it rather than conflating
 * a failed command with empty output (e.g. `git status --short` on a clean
 * repo legitimately returns ''). Programmer errors (TypeError etc.) are
 * re-thrown so they surface rather than being masked as missing git data.
 *
 * Async so per-worktree enrichment can be parallelized with Promise.allSettled.
 */
async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (e: unknown) {
    if (isExecError(e)) return null;
    throw e;
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

/**
 * Enrich a single worktree by running its three git commands in parallel.
 * Each command is independent so there is no reason to serialize them.
 */
async function enrichWorktree(wt: RawWorktree): Promise<WorktreeEnrichment> {
  const [logRaw, statusRaw, aheadRaw] = await Promise.all([
    git(wt.path, ['log', '-1', '--format=%h%n%s%n%ct']),
    git(wt.path, ['status', '--short']),
    git(wt.path, ['rev-list', '--count', 'origin/main..HEAD']),
  ]);

  const [hashLine, messageLine, timestampLine] = logRaw?.split('\n') ?? [];
  const headHash = hashLine?.trim() || wt.head.slice(0, 7);
  const headMessage = messageLine?.trim() ?? '';
  const headTimestampMs = timestampLine ? parseInt(timestampLine.trim(), 10) * 1000 : 0;

  // statusRaw === null means git failed; '' means clean — do not conflate them
  const changedCount = statusRaw !== null
    ? statusRaw.split('\n').filter(l => l.trim()).length
    : 0;

  // parseInt can return NaN if aheadRaw is '' (unexpected but possible)
  const parsedAhead = aheadRaw !== null ? parseInt(aheadRaw, 10) : NaN;
  const aheadCount = isNaN(parsedAhead) ? 0 : parsedAhead;

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
 *
 * All per-worktree enrichment runs in parallel — no serialization needed
 * since each worktree's git commands are independent of one another.
 */
export async function getWorktreeList(
  cwd: string,
  activeSessions: ActiveSessionsByBranch,
): Promise<ConsoleWorktreeListResponse> {
  const repoRoot = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (repoRoot === null) return { worktrees: [] };

  const porcelain = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return { worktrees: [] };

  const rawWorktrees = parseWorktreePorcelain(porcelain);

  // Enrich all worktrees in parallel — each enrichWorktree itself parallelizes
  // its three git calls, so total latency ≈ max single-worktree enrichment time.
  //
  // Promise.allSettled so a single broken worktree (unexpected JS error, not a
  // git failure — those are already handled in git()) does not silently fail the
  // entire response. Rejected entries are logged and excluded from the result
  // rather than swallowed: surface information, don't hide it.
  const results = await Promise.allSettled(rawWorktrees.map(wt => enrichWorktree(wt)));

  const worktrees: ConsoleWorktreeSummary[] = rawWorktrees.flatMap((wt, i) => {
    const result = results[i]!;
    if (result.status === 'rejected') {
      console.warn(`[WorktreeService] Failed to enrich worktree at ${wt.path}:`, result.reason);
      return [];
    }
    const e = result.value;
    return [{
      path: wt.path,
      name: basename(wt.path),
      branch: wt.branch,
      headHash: e.headHash,
      headMessage: e.headMessage,
      headTimestampMs: e.headTimestampMs,
      changedCount: e.changedCount,
      aheadCount: e.aheadCount,
      activeSessionCount: wt.branch ? (activeSessions.counts.get(wt.branch) ?? 0) : 0,
    }];
  });

  // Sort: active sessions first, then dirty, then by recency
  worktrees.sort((a, b) => {
    if (b.activeSessionCount !== a.activeSessionCount) return b.activeSessionCount - a.activeSessionCount;
    if (b.changedCount !== a.changedCount) return b.changedCount - a.changedCount;
    return b.headTimestampMs - a.headTimestampMs;
  });

  return { worktrees };
}
