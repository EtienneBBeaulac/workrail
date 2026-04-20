/**
 * Unit tests for loadWorkspaceContext() and stripFrontmatter() in workflow-runner.ts.
 *
 * Strategy: call exported functions directly with real filesystem state created
 * in a temp directory. No mocking -- follows "prefer fakes over mocks" from CLAUDE.md.
 *
 * All temp files are created under os.tmpdir() and cleaned up in afterEach.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadWorkspaceContext, stripFrontmatter } from '../../src/daemon/workflow-runner.js';

let testDir: string;

beforeEach(async () => {
  testDir = path.join(os.tmpdir(), `wr-workspace-context-test-${randomUUID()}`);
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// stripFrontmatter()
// ---------------------------------------------------------------------------

describe('stripFrontmatter()', () => {
  it('strips YAML frontmatter delimited by ---', () => {
    const content = '---\nalwaysApply: true\ndescription: My rule\n---\n# Rules\n- Use TypeScript';
    expect(stripFrontmatter(content)).toBe('# Rules\n- Use TypeScript');
  });

  it('returns original content when file does not start with ---', () => {
    const content = '# Rules\n- Use TypeScript';
    expect(stripFrontmatter(content)).toBe(content);
  });

  it('returns original content when closing --- is not found (malformed frontmatter)', () => {
    const content = '---\nalwaysApply: true\n# Rules\n- Use TypeScript';
    expect(stripFrontmatter(content)).toBe(content);
  });

  it('handles CRLF line endings in frontmatter delimiter', () => {
    const content = '---\r\nalwaysApply: true\r\n---\r\n# Rules';
    const result = stripFrontmatter(content);
    expect(result).toContain('# Rules');
    expect(result).not.toContain('alwaysApply');
  });

  it('trims leading whitespace after the closing ---', () => {
    const content = '---\nkey: val\n---\n\n\n# Rules';
    expect(stripFrontmatter(content)).toBe('# Rules');
  });
});

// ---------------------------------------------------------------------------
// loadWorkspaceContext() -- literal paths
// ---------------------------------------------------------------------------

describe('loadWorkspaceContext() -- literal paths', () => {
  it('returns null when no context files exist', async () => {
    const result = await loadWorkspaceContext(testDir);
    expect(result).toBeNull();
  });

  it('injects CLAUDE.md when present', async () => {
    await fs.writeFile(path.join(testDir, 'CLAUDE.md'), '# Project Rules\n- Use TypeScript', 'utf8');

    const result = await loadWorkspaceContext(testDir);

    expect(result).not.toBeNull();
    expect(result).toContain('### CLAUDE.md');
    expect(result).toContain('# Project Rules');
  });

  it('injects .claude/CLAUDE.md when present', async () => {
    await fs.mkdir(path.join(testDir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(testDir, '.claude', 'CLAUDE.md'), 'claude-dir-content', 'utf8');

    const result = await loadWorkspaceContext(testDir);

    expect(result).not.toBeNull();
    expect(result).toContain('### .claude/CLAUDE.md');
    expect(result).toContain('claude-dir-content');
  });

  it('injects AGENTS.md when present', async () => {
    await fs.writeFile(path.join(testDir, 'AGENTS.md'), 'agents-content', 'utf8');

    const result = await loadWorkspaceContext(testDir);

    expect(result).toContain('### AGENTS.md');
    expect(result).toContain('agents-content');
  });

  it('silently skips missing literal files without error', async () => {
    // Only one file exists; others silently skipped
    await fs.writeFile(path.join(testDir, 'AGENTS.md'), 'agents-only', 'utf8');

    const result = await loadWorkspaceContext(testDir);

    expect(result).not.toBeNull();
    expect(result).toContain('agents-only');
    // Other literal paths not present
    expect(result).not.toContain('.claude/CLAUDE.md');
  });

  it('joins multiple literal files with double newline separator', async () => {
    await fs.writeFile(path.join(testDir, 'CLAUDE.md'), 'claude-content', 'utf8');
    await fs.writeFile(path.join(testDir, 'AGENTS.md'), 'agents-content', 'utf8');

    const result = await loadWorkspaceContext(testDir);

    expect(result).toContain('claude-content\n\n### AGENTS.md\nagents-content');
  });
});

// ---------------------------------------------------------------------------
// loadWorkspaceContext() -- glob paths
// ---------------------------------------------------------------------------

describe('loadWorkspaceContext() -- glob paths', () => {
  it('expands .cursor/rules/*.mdc and returns all files alpha-sorted', async () => {
    await fs.mkdir(path.join(testDir, '.cursor', 'rules'), { recursive: true });
    await fs.writeFile(path.join(testDir, '.cursor', 'rules', 'b-rule.mdc'), '# Rule B', 'utf8');
    await fs.writeFile(path.join(testDir, '.cursor', 'rules', 'a-rule.mdc'), '# Rule A', 'utf8');

    const result = await loadWorkspaceContext(testDir);

    expect(result).not.toBeNull();
    // Both files present
    expect(result).toContain('# Rule A');
    expect(result).toContain('# Rule B');
    // Alpha order: a-rule before b-rule
    const idxA = result!.indexOf('a-rule.mdc');
    const idxB = result!.indexOf('b-rule.mdc');
    expect(idxA).toBeLessThan(idxB);
  });

  it('strips YAML frontmatter from .mdc files (stripFrontmatter: true)', async () => {
    await fs.mkdir(path.join(testDir, '.cursor', 'rules'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.cursor', 'rules', 'style.mdc'),
      '---\nalwaysApply: true\ndescription: Style rules\n---\n# Style Rules\n- Use TypeScript',
      'utf8',
    );

    const result = await loadWorkspaceContext(testDir);

    expect(result).not.toBeNull();
    expect(result).toContain('# Style Rules');
    expect(result).not.toContain('alwaysApply');
    expect(result).not.toContain('description: Style rules');
  });

  it('does NOT strip frontmatter from .continue/rules/*.md files (stripFrontmatter: false)', async () => {
    await fs.mkdir(path.join(testDir, '.continue', 'rules'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.continue', 'rules', 'style.md'),
      '---\nname: style\n---\n# Style Rules',
      'utf8',
    );

    const result = await loadWorkspaceContext(testDir);

    expect(result).not.toBeNull();
    // Frontmatter NOT stripped for .continue/rules
    expect(result).toContain('name: style');
    expect(result).toContain('# Style Rules');
  });

  it('returns no content for glob with no matching files (not an error)', async () => {
    // .cursor/rules/ directory does not exist -- no error, just no content
    const result = await loadWorkspaceContext(testDir);
    expect(result).toBeNull();
  });

  it('caps glob results at 20 files (alphabetically first 20)', async () => {
    await fs.mkdir(path.join(testDir, '.cursor', 'rules'), { recursive: true });

    // Create 25 files with zero-padded names for deterministic alpha sort
    for (let i = 0; i < 25; i++) {
      const name = `rule-${String(i).padStart(2, '0')}.mdc`;
      await fs.writeFile(
        path.join(testDir, '.cursor', 'rules', name),
        `# Rule ${i}`,
        'utf8',
      );
    }

    const result = await loadWorkspaceContext(testDir);

    expect(result).not.toBeNull();
    // Files 00-19 (alphabetically first 20) should be present
    expect(result).toContain('rule-00.mdc');
    expect(result).toContain('rule-19.mdc');
    // Files 20-24 should NOT be present
    expect(result).not.toContain('rule-20.mdc');
    expect(result).not.toContain('rule-24.mdc');
  });
});

// ---------------------------------------------------------------------------
// loadWorkspaceContext() -- 32KB budget
// ---------------------------------------------------------------------------

describe('loadWorkspaceContext() -- byte budget', () => {
  it('respects the 32KB combined cap and appends a truncation notice', async () => {
    // Create a file larger than 32KB to trigger truncation
    const bigContent = 'x'.repeat(33 * 1024);
    await fs.writeFile(path.join(testDir, 'CLAUDE.md'), bigContent, 'utf8');
    await fs.writeFile(path.join(testDir, 'AGENTS.md'), 'agents-content', 'utf8');

    const result = await loadWorkspaceContext(testDir);

    expect(result).not.toBeNull();
    // Truncation notice appended
    expect(result).toContain('[Workspace context truncated:');
    // AGENTS.md dropped because budget was exhausted
    expect(result).not.toContain('agents-content');
  });

  it('respects the 32KB cap across glob files in the inner loop', async () => {
    await fs.mkdir(path.join(testDir, '.cursor', 'rules'), { recursive: true });

    // Each file is ~8KB; after 4 files we exceed 32KB
    const fileContent = 'y'.repeat(8 * 1024);
    for (let i = 0; i < 10; i++) {
      const name = `rule-${String(i).padStart(2, '0')}.mdc`;
      await fs.writeFile(path.join(testDir, '.cursor', 'rules', name), fileContent, 'utf8');
    }

    const result = await loadWorkspaceContext(testDir);

    expect(result).not.toBeNull();
    // Should truncate and append notice (only 4 files fit in 32KB)
    expect(result).toContain('[Workspace context truncated:');
    // Files 05-09 should not appear (budget exhausted before them)
    expect(result).not.toContain('rule-05.mdc');
  });
});
