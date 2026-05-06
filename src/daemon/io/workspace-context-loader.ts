/**
 * Workspace context loader for daemon agent sessions.
 *
 * WHY this module: loadWorkspaceContext() and stripFrontmatter() are I/O
 * functions with no session or agent dependencies. They belong in the io/ layer.
 * All workspace context constants and candidate paths live here alongside the
 * function that uses them.
 *
 * WHY this module may import node: modules: it IS the I/O layer. Reading files
 * from the workspace is its entire purpose.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob as tinyGlob } from 'tinyglobby';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum combined byte size of all workspace context files.
 * WHY: Prevents context window bloat from large CLAUDE.md / AGENTS.md files.
 * Approximates 8000 tokens at ~4 bytes/token.
 */
export const WORKSPACE_CONTEXT_MAX_BYTES = 32 * 1024;

/**
 * Maximum files to read per glob pattern.
 * WHY: Prevents I/O cost and context budget waste in repos where .cursor/rules/
 * or similar directories contain many files (generated artifacts, etc.).
 */
export const MAX_GLOB_FILES_PER_PATTERN = 20;

// ---------------------------------------------------------------------------
// Candidate path types
// ---------------------------------------------------------------------------

/**
 * A literal path entry: a single file at a known relative path.
 * WHY: Claude Code and AGENTS.md paths are stable single-file conventions.
 */
type LiteralCandidatePath = {
  readonly kind: 'literal';
  readonly relativePath: string;
};

/**
 * A glob pattern entry: zero or more files matching a pattern in a directory.
 * WHY: Cursor, Windsurf, and Firebender all use directory-based conventions
 * where teams add multiple rule files. A glob pattern discovers them all.
 */
type GlobCandidatePath = {
  readonly kind: 'glob';
  readonly pattern: string;
  /**
   * WHY: .mdc (Cursor/Firebender) and .windsurf/rules/*.md files have YAML
   * frontmatter with metadata (alwaysApply, description, etc.) not meant for
   * LLM consumption. Must be stripped before injection.
   */
  readonly stripFrontmatter: boolean;
  /**
   * WHY: tinyglobby order is filesystem-dependent. Alpha sort ensures the same
   * workspace produces the same context on every WorkTrain session.
   */
  readonly sort: 'alpha';
};

type WorkspaceContextCandidate = LiteralCandidatePath | GlobCandidatePath;

/**
 * Candidate workspace context files in priority order.
 * WHY: More specific (tool-specific, project-specific) before more general.
 *
 * Sources:
 *   Claude Code: https://code.claude.com/docs/en/memory (April 2026)
 *   Cursor .cursorrules: empirical (zillow-android-2/.cursorrules)
 *   Cursor .cursor/rules/*.mdc: empirical (zillow-android-2/.cursor/rules/)
 *   Windsurf .windsurf/rules/*.md: https://docs.windsurf.com/windsurf/cascade/memories (April 2026)
 *   Firebender .firebender/rules/*.mdc: empirical (zillow-android-2/.firebender/rules/)
 *   GitHub Copilot: https://docs.github.com/en/copilot/customizing-copilot (April 2026)
 *   Continue.dev: https://docs.continue.dev/customize/deep-dives/rules (April 2026)
 *
 * NOTE: .windsurfrules does NOT exist -- Windsurf uses .windsurf/rules/ directory.
 */
export const WORKSPACE_CONTEXT_CANDIDATE_PATHS: readonly WorkspaceContextCandidate[] = [
  { kind: 'literal', relativePath: '.claude/CLAUDE.md' },
  { kind: 'literal', relativePath: 'CLAUDE.md' },
  { kind: 'literal', relativePath: 'CLAUDE.local.md' },
  { kind: 'literal', relativePath: 'AGENTS.md' },
  { kind: 'literal', relativePath: '.github/AGENTS.md' },
  // Cursor: newer directory format before legacy single-file format
  { kind: 'glob', pattern: '.cursor/rules/*.mdc', stripFrontmatter: true, sort: 'alpha' },
  { kind: 'literal', relativePath: '.cursorrules' },
  // Windsurf: directory format only (.windsurfrules does NOT exist per official docs)
  { kind: 'glob', pattern: '.windsurf/rules/*.md', stripFrontmatter: true, sort: 'alpha' },
  // Firebender: both rules directory and AGENTS.md convention
  { kind: 'glob', pattern: '.firebender/rules/*.mdc', stripFrontmatter: true, sort: 'alpha' },
  { kind: 'literal', relativePath: '.firebender/AGENTS.md' },
  // GitHub Copilot
  { kind: 'literal', relativePath: '.github/copilot-instructions.md' },
  // Continue.dev
  { kind: 'glob', pattern: '.continue/rules/*.md', stripFrontmatter: false, sort: 'alpha' },
] as const;

// ---------------------------------------------------------------------------
// stripFrontmatter
// ---------------------------------------------------------------------------

/**
 * Strip YAML frontmatter from file content before injection into the system prompt.
 *
 * WHY: .mdc files (Cursor, Firebender) and .windsurf/rules/*.md files include
 * YAML metadata (alwaysApply, description, trigger) that is tool-specific and
 * not meaningful in a WorkTrain system prompt context.
 *
 * Safety: Only strips if the file starts with '---\n' or '---\r\n'. Returns
 * original content unchanged if no frontmatter is present or malformed.
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return content;
  const endIdx = content.indexOf('\n---', 4);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 4).trimStart();
}

// ---------------------------------------------------------------------------
// loadWorkspaceContext
// ---------------------------------------------------------------------------

/**
 * Scan the workspace for convention files across 7 AI tools and combine them
 * into a single string for injection into the system prompt.
 *
 * Files are read in priority order (WORKSPACE_CONTEXT_CANDIDATE_PATHS). Combined
 * size is capped at WORKSPACE_CONTEXT_MAX_BYTES to prevent context window bloat.
 * If the cap is exceeded, a notice is appended so the agent knows content was cut.
 *
 * Returns null if no context files were found (section is omitted from the prompt).
 *
 * WHY best-effort: these files are optional. Missing or unreadable files are silently
 * skipped (or logged at warn level for non-ENOENT errors).
 */
export async function loadWorkspaceContext(workspacePath: string): Promise<string | null> {
  const parts: string[] = [];
  const injectedPaths: string[] = [];
  let combinedBytes = 0;
  let truncated = false;

  function accumulateFile(relativePath: string, content: string): void {
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (combinedBytes + contentBytes > WORKSPACE_CONTEXT_MAX_BYTES) {
      const remaining = WORKSPACE_CONTEXT_MAX_BYTES - combinedBytes;
      const truncatedContent = content.slice(0, remaining);
      parts.push(`### ${relativePath}\n${truncatedContent}`);
      injectedPaths.push(relativePath);
      truncated = true;
    } else {
      parts.push(`### ${relativePath}\n${content}`);
      injectedPaths.push(relativePath);
      combinedBytes += contentBytes;
    }
  }

  for (const entry of WORKSPACE_CONTEXT_CANDIDATE_PATHS) {
    if (truncated) break;

    if (entry.kind === 'literal') {
      const fullPath = path.join(workspacePath, entry.relativePath);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf8');
      } catch (err: unknown) {
        const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
        if (!isEnoent) {
          console.warn(
            `[WorkflowRunner] Skipping ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }
      accumulateFile(entry.relativePath, content);
    } else {
      // kind === 'glob': expand pattern, sort, cap, read each file.
      const matches = await tinyGlob(entry.pattern, { cwd: workspacePath, absolute: false });
      const sorted = [...matches].sort(); // alpha sort for determinism
      if (sorted.length > MAX_GLOB_FILES_PER_PATTERN) {
        console.warn(
          `[WorkflowRunner] ${entry.pattern}: ${sorted.length} files found, capped at ${MAX_GLOB_FILES_PER_PATTERN}`,
        );
      }
      for (const relativePath of sorted.slice(0, MAX_GLOB_FILES_PER_PATTERN)) {
        if (truncated) break;
        const fullPath = path.join(workspacePath, relativePath);
        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf8');
        } catch (err: unknown) {
          const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
          if (!isEnoent) {
            console.warn(
              `[WorkflowRunner] Skipping ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          continue;
        }
        accumulateFile(relativePath, entry.stripFrontmatter ? stripFrontmatter(content) : content);
      }
    }
  }

  if (parts.length === 0) return null;

  let combined = parts.join('\n\n');
  if (truncated) {
    combined += '\n\n[Workspace context truncated: combined size exceeded 32 KB limit. Some files may be missing.]';
  }

  console.log(
    `[WorkflowRunner] Injecting workspace context from: ${injectedPaths.join(', ')}`,
  );

  return combined;
}
