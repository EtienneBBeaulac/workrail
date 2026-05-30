/**
 * Pure async git reader functions for engine-side metrics collection.
 *
 * Rules:
 * - All functions use execFile (not exec) -- repoRoot is user-controlled input.
 * - All functions set explicit timeouts and maxBuffer to prevent runaway processes
 *   and unbounded memory use on large diffs.
 * - All functions return null on any failure -- errors are data, never exceptions.
 * - Zero-change results return zero-valued structs (not null).
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitCommittedDiff, GitWorkingTreeState } from './types.js';

const execFile = promisify(execFileCb);

/** Maximum number of lines from git diff --numstat before truncation. */
const MAX_NUMSTAT_LINES = 10_000;

/** Maximum buffer size for execFile (5MB). Prevents OOM on large diffs. */
const MAX_BUFFER = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Working tree state
// ---------------------------------------------------------------------------

/**
 * Read staged and unstaged file counts from the working tree.
 * Runs `git diff --cached --numstat` and `git diff --numstat` in parallel.
 *
 * @returns null if either command fails or times out.
 */
export async function readWorkingTreeState(
  repoRoot: string,
  timeoutMs: number,
): Promise<GitWorkingTreeState | null> {
  try {
    const [cached, unstaged] = await Promise.all([
      execFile('git', ['-C', repoRoot, 'diff', '--cached', '--numstat'], {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
      }),
      execFile('git', ['-C', repoRoot, 'diff', '--numstat'], {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
      }),
    ]);

    return {
      stagedFiles: countNumstatLines(cached.stdout),
      unstagedFiles: countNumstatLines(unstaged.stdout),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Committed diff
// ---------------------------------------------------------------------------

/**
 * Read committed diff stats between startSha and current HEAD.
 * Runs `git diff startSha..HEAD --numstat --no-renames`.
 *
 * @param startSha - The git SHA at session start. If null, returns null immediately.
 * @returns null if startSha is null, if the command fails, or times out.
 *          Returns a zero-valued struct if no commits were made.
 */
export async function readCommittedDiff(
  repoRoot: string,
  startSha: string | null,
  timeoutMs: number,
): Promise<GitCommittedDiff | null> {
  if (!startSha) return null;

  try {
    const { stdout } = await execFile(
      'git',
      ['-C', repoRoot, 'diff', `${startSha}..HEAD`, '--numstat', '--no-renames'],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
    );

    return parseNumstat(stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Commit SHAs + PR ref parsing
// ---------------------------------------------------------------------------

/**
 * Read commit SHAs between startSha and current HEAD.
 * Runs `git log --no-merges --first-parent --format=%H startSha..HEAD`.
 *
 * @param startSha - The git SHA at session start. If null, returns empty arrays.
 * @returns { shas, prRefs } -- shas is the list of commit SHAs; prRefs is PR numbers
 *   parsed from commit message subjects and bodies.
 */
export async function readCommitShasAndPrRefs(
  repoRoot: string,
  startSha: string | null,
  timeoutMs: number,
): Promise<{ shas: readonly string[]; prRefs: readonly number[] } | null> {
  if (!startSha) return { shas: [], prRefs: [] };

  try {
    // Use format that separates SHA and message body with a delimiter.
    // %H = full SHA, %s = subject, %b = body
    const { stdout: shaOutput } = await execFile(
      'git',
      ['-C', repoRoot, 'log', '--no-merges', '--first-parent', '--format=%H', `${startSha}..HEAD`],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
    );

    const shas = shaOutput
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length === 40 && /^[0-9a-f]{40}$/.test(s));

    if (shas.length === 0) return { shas: [], prRefs: [] };

    // Parse PR refs from subject + body of each commit.
    const { stdout: msgOutput } = await execFile(
      'git',
      ['-C', repoRoot, 'log', '--no-merges', '--first-parent', '--format=%s%n%b', `${startSha}..HEAD`],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
    );

    const prRefs = parsePrRefs(msgOutput);

    return { shas, prRefs };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count the number of non-empty lines in git numstat output.
 * Each line represents one file.
 */
function countNumstatLines(stdout: string): number {
  return stdout.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * Parse `git diff --numstat --no-renames` output into a GitCommittedDiff.
 * Format per line: `<added>\t<removed>\t<filename>`
 * Binary files show `-\t-\t<filename>` -- counted as 1 file, 0 lines.
 *
 * Truncates at MAX_NUMSTAT_LINES.
 */
function parseNumstat(stdout: string): GitCommittedDiff {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);

  const truncated = lines.length > MAX_NUMSTAT_LINES;
  const effectiveLines = truncated ? lines.slice(0, MAX_NUMSTAT_LINES) : lines;

  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  const changedFilePaths: string[] = [];
  const languageBreakdown: Record<string, number> = {};

  for (const line of effectiveLines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    filesChanged++;
    const added = parseInt(parts[0] ?? '0', 10);
    const removed = parseInt(parts[1] ?? '0', 10);
    if (!isNaN(added)) linesAdded += added;
    if (!isNaN(removed)) linesRemoved += removed;

    const filePath = parts[2] ?? '';
    changedFilePaths.push(filePath);

    // Extract extension for language breakdown (lowercase, includes dot).
    // Files with no dot (e.g. 'Makefile') map to empty string.
    const lastDot = filePath.lastIndexOf('.');
    const ext = lastDot > 0 ? filePath.slice(lastDot).toLowerCase() : '';
    languageBreakdown[ext] = (languageBreakdown[ext] ?? 0) + 1;
  }

  return { filesChanged, linesAdded, linesRemoved, truncated, changedFilePaths, languageBreakdown };
}

/**
 * Parse PR numbers from git log message text.
 * Matches: `#123`, `Closes #123`, `Fixes #123`, `Refs #123`, `close #123`, etc.
 * Returns a deduplicated sorted array of PR numbers.
 */
function parsePrRefs(text: string): readonly number[] {
  const pattern = /(?:closes?|fixes?|refs?)\s+#(\d+)|#(\d+)/gi;
  const found = new Set<number>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const num = parseInt(match[1] ?? match[2] ?? '', 10);
    if (!isNaN(num) && num > 0) {
      found.add(num);
    }
  }

  return Array.from(found).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Code churn detection
// ---------------------------------------------------------------------------

/**
 * Check how many of the session's changed files were re-modified by subsequent
 * commits within `windowDays` after the session's end SHA.
 *
 * WHY churn signal: files re-modified shortly after a session indicate the
 * session's output required follow-up work -- a quality signal.
 *
 * @param repoRoot  Workspace path
 * @param changedFilePaths  Files changed during the session (from committedDiff)
 * @param endSha  Session's end commit SHA -- used to anchor the after-window
 * @param windowDays  How many days after session end to look for re-modifications
 * @param timeoutMs  Per-command timeout
 * @returns { filesRemodified, windowDays } or null on git failure
 */
export async function readChurnSignal(
  repoRoot: string,
  changedFilePaths: readonly string[],
  endSha: string,
  windowDays: number,
  timeoutMs: number,
): Promise<{ readonly filesRemodified: number; readonly windowDays: number } | null> {
  if (changedFilePaths.length === 0) {
    return { filesRemodified: 0, windowDays };
  }

  try {
    // Resolve the Unix timestamp of endSha to use as the --after boundary.
    const { stdout: tsOut } = await execFile(
      'git',
      ['-C', repoRoot, 'log', '-1', '--format=%ct', endSha],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
    );
    const endTs = parseInt(tsOut.trim(), 10);
    if (isNaN(endTs)) return null;

    // Compute the after boundary as a local date string git understands.
    const afterDate = new Date(endTs * 1000).toISOString();
    const beforeDate = new Date((endTs + windowDays * 86_400) * 1000).toISOString();

    let filesRemodified = 0;

    for (const filePath of changedFilePaths) {
      try {
        const { stdout } = await execFile(
          'git',
          ['-C', repoRoot, 'log', '--oneline', `--after=${afterDate}`, `--before=${beforeDate}`, '--', filePath],
          { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
        );
        if (stdout.trim().length > 0) filesRemodified++;
      } catch {
        // Skip files that error -- partial results are acceptable
      }
    }

    return { filesRemodified, windowDays };
  } catch {
    return null;
  }
}
