/**
 * Unit tests for git-metrics reader functions.
 *
 * Uses vi.mock to intercept execFile and test reader behavior under:
 * - success with real git output
 * - failure (execFile throws)
 * - output truncation
 * - PR ref parsing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock child_process.execFile
// Must be declared with vi.hoisted so the variable is available when vi.mock
// factory runs (vi.mock is hoisted to the top of the file by vitest).
// ---------------------------------------------------------------------------

const { mockExecFile } = vi.hoisted(() => {
  const mockExecFile = vi.fn();
  return { mockExecFile };
});

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { readWorkingTreeState, readCommittedDiff, readCommitShasAndPrRefs } from '../../src/mcp/git-metrics/reader.js';

function mockSuccess(stdout: string): Promise<{ stdout: string; stderr: string }> {
  return Promise.resolve({ stdout, stderr: '' });
}

function mockFailure(message = 'git: command not found'): Promise<never> {
  return Promise.reject(new Error(message));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// readWorkingTreeState
// ---------------------------------------------------------------------------

describe('readWorkingTreeState', () => {
  it('returns staged and unstaged file counts from numstat output', async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: '5\t3\tfile1.ts\n2\t0\tfile2.ts\n', stderr: '' }) // --cached
      .mockResolvedValueOnce({ stdout: '1\t1\tfile3.ts\n', stderr: '' }); // unstaged

    const result = await readWorkingTreeState('/repo', 5000);

    expect(result).toEqual({ stagedFiles: 2, unstagedFiles: 1 });
  });

  it('returns { stagedFiles: 0, unstagedFiles: 0 } for a clean working tree', async () => {
    mockExecFile
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await readWorkingTreeState('/repo', 5000);

    expect(result).toEqual({ stagedFiles: 0, unstagedFiles: 0 });
  });

  it('returns null when git command fails', async () => {
    mockExecFile.mockRejectedValueOnce(new Error('not a git repo'));

    const result = await readWorkingTreeState('/repo', 5000);

    expect(result).toBeNull();
  });

  it('returns null when git times out', async () => {
    mockExecFile.mockRejectedValueOnce(Object.assign(new Error('timed out'), { killed: true }));

    const result = await readWorkingTreeState('/repo', 5000);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readCommittedDiff
// ---------------------------------------------------------------------------

describe('readCommittedDiff', () => {
  it('returns null immediately when startSha is null', async () => {
    const result = await readCommittedDiff('/repo', null, 10000);

    expect(result).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('parses numstat output into file/line counts', async () => {
    // 3 lines: 2 regular files and 1 binary file (- - filename)
    const stdout = '10\t5\tfile1.ts\n3\t2\tfile2.ts\n-\t-\tbinary.bin\n';
    mockExecFile.mockResolvedValueOnce({ stdout, stderr: '' });

    const result = await readCommittedDiff('/repo', 'abc123', 10000);

    expect(result).toEqual({
      filesChanged: 3,
      linesAdded: 13,
      linesRemoved: 7,
      truncated: false,
    });
  });

  it('returns zero-valued struct when no files changed', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await readCommittedDiff('/repo', 'abc123', 10000);

    expect(result).toEqual({
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      truncated: false,
    });
  });

  it('sets truncated=true when output exceeds 10000 lines', async () => {
    // Generate 10001 numstat lines
    const lines = Array.from({ length: 10_001 }, (_, i) => `1\t0\tfile${i}.ts`).join('\n');
    mockExecFile.mockResolvedValueOnce({ stdout: lines, stderr: '' });

    const result = await readCommittedDiff('/repo', 'abc123', 10000);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.filesChanged).toBe(10_000); // truncated at limit
  });

  it('returns null when execFile fails', async () => {
    mockExecFile.mockRejectedValueOnce(new Error('git diff failed'));

    const result = await readCommittedDiff('/repo', 'abc123', 10000);

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readCommitShasAndPrRefs
// ---------------------------------------------------------------------------

describe('readCommitShasAndPrRefs', () => {
  it('returns empty arrays when startSha is null (no git info available)', async () => {
    const result = await readCommitShasAndPrRefs('/repo', null, 5000);

    expect(result).toEqual({ shas: [], prRefs: [] });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('parses commit SHAs from git log --format=%H output', async () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    mockExecFile
      .mockResolvedValueOnce({ stdout: `${sha1}\n${sha2}\n`, stderr: '' }) // SHAs
      .mockResolvedValueOnce({ stdout: 'feat: add feature\n\nCloses #123', stderr: '' }); // messages

    const result = await readCommitShasAndPrRefs('/repo', 'startSha', 5000);

    expect(result).not.toBeNull();
    expect(result!.shas).toEqual([sha1, sha2]);
    expect(result!.prRefs).toEqual([123]);
  });

  it('returns empty arrays when no commits between startSha and HEAD', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await readCommitShasAndPrRefs('/repo', 'startSha', 5000);

    expect(result).not.toBeNull();
    expect(result!.shas).toEqual([]);
    expect(result!.prRefs).toEqual([]);
  });

  it('parses PR refs from various message formats', async () => {
    const sha = 'a'.repeat(40);
    mockExecFile
      .mockResolvedValueOnce({ stdout: `${sha}\n`, stderr: '' })
      .mockResolvedValueOnce({
        stdout: 'fix: bug\n\nFixes #456\nCloses #789\nRefs #101\n#202',
        stderr: '',
      });

    const result = await readCommitShasAndPrRefs('/repo', 'startSha', 5000);

    expect(result).not.toBeNull();
    expect(result!.prRefs).toEqual([101, 202, 456, 789]); // sorted
  });

  it('deduplicates PR refs', async () => {
    const sha = 'a'.repeat(40);
    mockExecFile
      .mockResolvedValueOnce({ stdout: `${sha}\n`, stderr: '' })
      .mockResolvedValueOnce({ stdout: 'fix: bug\n\nCloses #123\n#123\nFixes #123', stderr: '' });

    const result = await readCommitShasAndPrRefs('/repo', 'startSha', 5000);

    expect(result!.prRefs).toEqual([123]); // deduplicated
  });

  it('returns null when execFile throws', async () => {
    mockExecFile.mockRejectedValueOnce(new Error('git not found'));

    const result = await readCommitShasAndPrRefs('/repo', 'startSha', 5000);

    expect(result).toBeNull();
  });
});
