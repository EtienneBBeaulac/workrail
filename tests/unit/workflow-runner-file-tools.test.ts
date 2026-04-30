/**
 * Unit tests for the daemon file-navigation and editing tools added in
 * feat/daemon-file-nav-tools:
 *   makeReadTool  -- line numbers, offset+limit, 256KB size cap
 *   makeWriteTool -- staleness guard for existing files; new-file bypass
 *   makeGlobTool  -- pattern matching, 100-result limit, non-existent path
 *   makeGrepTool  -- rg not found returns descriptive error; normal grep
 *   makeEditTool  -- read-before-edit, stale mtime, exact match, curly quotes, multi-match
 *
 * Strategy: call each exported tool factory directly, invoke execute() with
 * real filesystem state. No mocking -- follows "prefer fakes over mocks" from CLAUDE.md.
 *
 * All temp files are created under os.tmpdir() and cleaned up in afterEach.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  makeReadTool,
  makeWriteTool,
  makeGlobTool,
  makeGrepTool,
  makeEditTool,
  type ReadFileState,
} from '../../src/daemon/workflow-runner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubSchemas = {
  ReadParams: {},
  WriteParams: {},
  GlobParams: {},
  GrepParams: {},
  EditParams: {},
};

/** Check synchronously whether rg (ripgrep) is available on this machine. */
function checkRgAvailableSync(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_RG = checkRgAvailableSync();

let testDir: string;

beforeEach(async () => {
  testDir = path.join(os.tmpdir(), `wr-file-tools-test-${randomUUID()}`);
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// makeReadTool
// ---------------------------------------------------------------------------

describe('makeReadTool()', () => {
  it('returns content in cat-n format with line numbers', async () => {
    const filePath = path.join(testDir, 'test.txt');
    await fs.writeFile(filePath, 'line one\nline two\nline three', 'utf8');

    const readFileState = new Map<string, ReadFileState>();
    const tool = makeReadTool(testDir, readFileState, stubSchemas);
    const result = await tool.execute('test-id', { filePath });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('1\tline one');
    expect(text).toContain('2\tline two');
    expect(text).toContain('3\tline three');
  });

  it('respects offset and limit parameters', async () => {
    const filePath = path.join(testDir, 'test.txt');
    await fs.writeFile(filePath, 'a\nb\nc\nd\ne', 'utf8');

    const readFileState = new Map<string, ReadFileState>();
    const tool = makeReadTool(testDir, readFileState, stubSchemas);
    // Read lines 2-3 (offset=1 means start at line 2, limit=2 means 2 lines)
    const result = await tool.execute('test-id', { filePath, offset: 1, limit: 2 });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('2\tb');
    expect(text).toContain('3\tc');
    expect(text).not.toContain('1\ta');
    expect(text).not.toContain('4\td');
  });

  it('throws for files larger than 256KB', async () => {
    const filePath = path.join(testDir, 'large.txt');
    // Write a file just over 256KB
    const chunk = 'x'.repeat(1024);
    const lines = Array.from({ length: 260 }, () => chunk).join('\n');
    await fs.writeFile(filePath, lines, 'utf8');

    const readFileState = new Map<string, ReadFileState>();
    const tool = makeReadTool(testDir, readFileState, stubSchemas);
    await expect(tool.execute('test-id', { filePath })).rejects.toThrow(/too large/i);
  });

  it('succeeds reading a paginated slice of a file larger than 256KB', async () => {
    const filePath = path.join(testDir, 'large-paginated.txt');
    // Write a file just over 256KB (260 lines of 1024 bytes each)
    const chunk = 'x'.repeat(1024);
    const lines = Array.from({ length: 260 }, (_, i) => `line-${i}-${chunk}`).join('\n');
    await fs.writeFile(filePath, lines, 'utf8');

    const readFileState = new Map<string, ReadFileState>();
    const tool = makeReadTool(testDir, readFileState, stubSchemas);
    // offset and limit are provided -- size cap must be skipped
    const result = await tool.execute('test-id', { filePath, offset: 0, limit: 5 });

    const text = (result.content[0] as { type: string; text: string }).text;
    const returnedLines = text.split('\n').filter(l => l.length > 0);
    expect(returnedLines).toHaveLength(5);
    expect(text).toContain('1\tline-0-');
    expect(text).toContain('5\tline-4-');
  });

  it('stores file state in readFileState after reading', async () => {
    const filePath = path.join(testDir, 'test.txt');
    await fs.writeFile(filePath, 'hello\nworld', 'utf8');

    const readFileState = new Map<string, ReadFileState>();
    const tool = makeReadTool(testDir, readFileState, stubSchemas);
    await tool.execute('test-id', { filePath });

    expect(readFileState.has(filePath)).toBe(true);
    const state = readFileState.get(filePath)!;
    expect(state.content).toBe('hello\nworld');
    expect(state.timestamp).toBeGreaterThan(0);
  });

  it('rejects paths outside the workspace', async () => {
    const outsidePath = path.join(os.tmpdir(), `wr-outside-${randomUUID()}`, 'secret.txt');

    const readFileState = new Map<string, ReadFileState>();
    const tool = makeReadTool(testDir, readFileState, stubSchemas);
    await expect(
      tool.execute('test-id', { filePath: outsidePath }),
    ).rejects.toThrow(/outside the workspace/i);
  });
});

// ---------------------------------------------------------------------------
// makeWriteTool
// ---------------------------------------------------------------------------

describe('makeWriteTool()', () => {
  it('succeeds for new files without a prior read', async () => {
    const filePath = path.join(testDir, 'new-file.txt');

    const readFileState = new Map<string, ReadFileState>();
    const tool = makeWriteTool(testDir, readFileState, stubSchemas);
    const result = await tool.execute('test-id', { filePath, content: 'hello world' });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('hello world'.length.toString());
    const written = await fs.readFile(filePath, 'utf8');
    expect(written).toBe('hello world');
  });

  it('fails for existing files that have not been read in this session', async () => {
    const filePath = path.join(testDir, 'existing.txt');
    await fs.writeFile(filePath, 'original content', 'utf8');

    const readFileState = new Map<string, ReadFileState>();
    const tool = makeWriteTool(testDir, readFileState, stubSchemas);
    await expect(
      tool.execute('test-id', { filePath, content: 'new content' }),
    ).rejects.toThrow(/has not been read/i);
  });

  it('fails for existing files with a stale mtime', async () => {
    const filePath = path.join(testDir, 'stale.txt');
    await fs.writeFile(filePath, 'original content', 'utf8');

    // Prime readFileState with a stale timestamp
    const readFileState = new Map<string, ReadFileState>();
    readFileState.set(filePath, { content: 'original content', timestamp: 1000, isPartialView: false });

    const tool = makeWriteTool(testDir, readFileState, stubSchemas);
    await expect(
      tool.execute('test-id', { filePath, content: 'new content' }),
    ).rejects.toThrow(/modified since/i);
  });

  it('rejects paths outside the workspace', async () => {
    const outsideDir = path.join(os.tmpdir(), `wr-outside-${randomUUID()}`);
    const outsidePath = path.join(outsideDir, 'secret.txt');

    const readFileState = new Map<string, ReadFileState>();
    const tool = makeWriteTool(testDir, readFileState, stubSchemas);
    await expect(
      tool.execute('test-id', { filePath: outsidePath, content: 'should not be written' }),
    ).rejects.toThrow(/outside the workspace/i);

    // Verify the file was never created
    await expect(fs.access(outsidePath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// makeGlobTool
// ---------------------------------------------------------------------------

describe('makeGlobTool()', () => {
  it('returns matching files for a pattern', async () => {
    await fs.writeFile(path.join(testDir, 'foo.ts'), '', 'utf8');
    await fs.writeFile(path.join(testDir, 'bar.ts'), '', 'utf8');
    await fs.writeFile(path.join(testDir, 'baz.js'), '', 'utf8');

    const tool = makeGlobTool(testDir, stubSchemas);
    const result = await tool.execute('test-id', { pattern: '**/*.ts', path: testDir });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('foo.ts');
    expect(text).toContain('bar.ts');
    expect(text).not.toContain('baz.js');
  });

  it('respects the 100-result limit and appends truncation notice', async () => {
    // Create 101 files
    await Promise.all(
      Array.from({ length: 101 }, (_, i) =>
        fs.writeFile(path.join(testDir, `file-${i}.txt`), '', 'utf8'),
      ),
    );

    const tool = makeGlobTool(testDir, stubSchemas);
    const result = await tool.execute('test-id', { pattern: '**/*.txt', path: testDir });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('[Results truncated at 100 files]');
    // Count actual file paths (lines that don't contain the truncation notice)
    const filePaths = text.split('\n').filter(l => l.endsWith('.txt'));
    expect(filePaths).toHaveLength(100);
  });

  it('returns "(no matches)" for a non-existent path', async () => {
    const nonExistentPath = path.join(testDir, 'does-not-exist');

    const tool = makeGlobTool(testDir, stubSchemas);
    const result = await tool.execute('test-id', { pattern: '**/*.ts', path: nonExistentPath });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('(no matches)');
  });
});

// ---------------------------------------------------------------------------
// makeGrepTool
// ---------------------------------------------------------------------------

describe('makeGrepTool()', () => {
  // On machines without rg, verify the descriptive ENOENT error message
  it.skipIf(HAS_RG)('returns descriptive error when rg is not found', async () => {
    const tool = makeGrepTool(testDir, stubSchemas);
    await expect(
      tool.execute('test-id', { pattern: 'hello', path: testDir }),
    ).rejects.toThrow(/brew install ripgrep/i);
  });

  // On machines with rg, verify happy-path behavior
  it.skipIf(!HAS_RG)('returns files with matches in files_with_matches mode', async () => {
    await fs.writeFile(path.join(testDir, 'match.txt'), 'hello world', 'utf8');
    await fs.writeFile(path.join(testDir, 'no-match.txt'), 'goodbye world', 'utf8');

    const tool = makeGrepTool(testDir, stubSchemas);
    const result = await tool.execute('test-id', {
      pattern: 'hello',
      path: testDir,
      output_mode: 'files_with_matches',
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('match.txt');
    expect(text).not.toContain('no-match.txt');
  });

  it.skipIf(!HAS_RG)('returns "(no matches)" when pattern matches nothing', async () => {
    await fs.writeFile(path.join(testDir, 'test.txt'), 'hello world', 'utf8');

    const tool = makeGrepTool(testDir, stubSchemas);
    const result = await tool.execute('test-id', {
      pattern: 'xyzzy_no_match_ever',
      path: testDir,
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('(no matches)');
  });
});

// ---------------------------------------------------------------------------
// makeEditTool
// ---------------------------------------------------------------------------

describe('makeEditTool()', () => {
  it('fails without prior Read -- "File has not been read"', async () => {
    const filePath = path.join(testDir, 'edit-test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');

    const readFileState = new Map<string, ReadFileState>();
    const tool = makeEditTool(testDir, readFileState, stubSchemas);

    await expect(
      tool.execute('test-id', { file_path: filePath, old_string: 'hello', new_string: 'goodbye' }),
    ).rejects.toThrow(/has not been read/i);
  });

  it('fails when file mtime changed since read -- "File has been modified"', async () => {
    const filePath = path.join(testDir, 'stale-edit.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');

    // Set a stale timestamp (far in the past)
    const readFileState = new Map<string, ReadFileState>();
    readFileState.set(filePath, { content: 'hello world', timestamp: 1000, isPartialView: false });

    const tool = makeEditTool(testDir, readFileState, stubSchemas);
    await expect(
      tool.execute('test-id', { file_path: filePath, old_string: 'hello', new_string: 'goodbye' }),
    ).rejects.toThrow(/modified since/i);
  });

  it('succeeds with exact match after prior Read', async () => {
    const filePath = path.join(testDir, 'exact-match.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');

    // Simulate a prior Read by populating readFileState with the current mtime
    const stat = await fs.stat(filePath);
    const readFileState = new Map<string, ReadFileState>();
    readFileState.set(filePath, { content: 'hello world', timestamp: stat.mtimeMs, isPartialView: false });

    const tool = makeEditTool(testDir, readFileState, stubSchemas);
    const result = await tool.execute('test-id', {
      file_path: filePath,
      old_string: 'hello',
      new_string: 'goodbye',
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('updated successfully');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('goodbye world');
  });

  it('succeeds with curly-quote normalization (\u2018hello\u2019 -> \'hello\')', async () => {
    const filePath = path.join(testDir, 'curly-quotes.txt');
    await fs.writeFile(filePath, "it's a test", 'utf8');

    const stat = await fs.stat(filePath);
    const readFileState = new Map<string, ReadFileState>();
    readFileState.set(filePath, { content: "it's a test", timestamp: stat.mtimeMs, isPartialView: false });

    const tool = makeEditTool(testDir, readFileState, stubSchemas);
    // Pass curly left/right single quotes (\u2018 and \u2019) in old_string
    const result = await tool.execute('test-id', {
      file_path: filePath,
      old_string: 'it\u2019s a test', // curly right single quote
      new_string: "it's done",
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('updated successfully');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe("it's done");
  });

  it('fails on multiple matches when replace_all is false', async () => {
    const filePath = path.join(testDir, 'multi-match.txt');
    await fs.writeFile(filePath, 'hello hello hello', 'utf8');

    const stat = await fs.stat(filePath);
    const readFileState = new Map<string, ReadFileState>();
    readFileState.set(filePath, { content: 'hello hello hello', timestamp: stat.mtimeMs, isPartialView: false });

    const tool = makeEditTool(testDir, readFileState, stubSchemas);
    await expect(
      tool.execute('test-id', {
        file_path: filePath,
        old_string: 'hello',
        new_string: 'goodbye',
        replace_all: false,
      }),
    ).rejects.toThrow(/3 times/);
  });

  it('succeeds with replace_all=true on multiple matches', async () => {
    const filePath = path.join(testDir, 'replace-all.txt');
    await fs.writeFile(filePath, 'hello hello hello', 'utf8');

    const stat = await fs.stat(filePath);
    const readFileState = new Map<string, ReadFileState>();
    readFileState.set(filePath, { content: 'hello hello hello', timestamp: stat.mtimeMs, isPartialView: false });

    const tool = makeEditTool(testDir, readFileState, stubSchemas);
    const result = await tool.execute('test-id', {
      file_path: filePath,
      old_string: 'hello',
      new_string: 'goodbye',
      replace_all: true,
    });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain('updated successfully');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('goodbye goodbye goodbye');
  });
});
