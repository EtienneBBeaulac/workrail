import type { ContextAssemblerDeps } from './deps.js';
import type {
  AssemblyTask,
  ContextAssembler,
  ContextBundle,
  RenderOpts,
  SessionNote,
} from './types.js';

/**
 * Create a ContextAssembler service with the given I/O deps.
 *
 * WHY factory function (not class): follows existing coordinator pattern.
 * Factory closes over deps; no `this` binding.
 */
export function createContextAssembler(deps: ContextAssemblerDeps): ContextAssembler {
  return {
    async assemble(task: AssemblyTask): Promise<ContextBundle> {
      const [gitDiff, priorSessionNotes] = await Promise.all([
        assembleGitDiff(deps, task),
        assemblePriorNotes(deps, task.workspacePath),
      ]);
      return {
        task,
        gitDiff,
        priorSessionNotes,
        assembledAt: deps.nowIso(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Source assemblers (private)
// ---------------------------------------------------------------------------

/**
 * Assemble git diff summary.
 *
 * For pr_review: attempt `gh pr diff --name-only <prNumber>` first (more accurate
 * for PRs: shows base..head diff). On gh failure, fall back to `git diff HEAD~1 --stat`.
 * For coding_task: use `git diff HEAD~1 --stat` directly.
 *
 * NOTE: format inconsistency -- `gh pr diff --name-only` returns a plain filename list
 * (one file per line), while `git diff HEAD~1 --stat` returns stat output with change
 * counts (e.g. "src/foo.ts | 5 ++"). Both land in the same `gitDiff` field and are
 * rendered under `### Changed files`. The agent can parse either format; normalizing
 * to `--name-only` for both paths is a future improvement.
 *
 * Returns err() on all failures -- caller omits the section gracefully.
 */
async function assembleGitDiff(
  deps: ContextAssemblerDeps,
  task: AssemblyTask,
): Promise<ContextBundle['gitDiff']> {
  if (task.kind === 'pr_review') {
    const ghResult = await deps.execGh(
      ['pr', 'diff', String(task.prNumber), '--name-only'],
      task.workspacePath,
    );
    if (ghResult.kind === 'ok' && ghResult.value.trim().length > 0) {
      return { kind: 'ok', value: ghResult.value.trim() };
    }
    // Fall through to git fallback
  }
  return deps.execGit(['diff', 'HEAD~1', '--stat'], task.workspacePath);
}

/**
 * Assemble prior session notes for this workspace.
 * Returns at most 3 sessions, newest-first.
 */
async function assemblePriorNotes(
  deps: ContextAssemblerDeps,
  workspacePath: string,
): Promise<ContextBundle['priorSessionNotes']> {
  const PRIOR_SESSION_LIMIT = 3;
  return deps.listRecentSessions(workspacePath, PRIOR_SESSION_LIMIT);
}

// ---------------------------------------------------------------------------
// Rendering (pure, exported for coordinator use)
// ---------------------------------------------------------------------------

/**
 * Render a ContextBundle to a markdown string suitable for injection into
 * the system prompt as a `## Prior Context` section.
 *
 * Returns empty string if both sources are err() (nothing to inject).
 *
 * WHY pure function: renderContextBundle is called in coordinator code (not
 * inside the assembler) to keep the assembler free of formatting concerns.
 * Also independently testable without I/O.
 *
 * LOCKED FORMAT: section headers and structure are part of the coordinator-daemon
 * contract. Do not change headers without updating the buildSystemPrompt() comment.
 */
export function renderContextBundle(bundle: ContextBundle, _opts?: RenderOpts): string {
  const parts: string[] = [];

  // ---- Prior session notes ----
  if (bundle.priorSessionNotes.kind === 'ok' && bundle.priorSessionNotes.value.length > 0) {
    parts.push('### Recent session notes for this workspace\n');
    for (const note of bundle.priorSessionNotes.value) {
      const title = note.sessionTitle ?? note.sessionId.slice(0, 12);
      const branch = note.gitBranch ? ` (branch: ${note.gitBranch})` : '';
      const recap = note.recapSnippet ?? '(no recap available)';
      parts.push(`**${title}**${branch}\n${recap}\n`);
    }
  }

  // ---- Git diff summary ----
  if (bundle.gitDiff.kind === 'ok' && bundle.gitDiff.value.trim().length > 0) {
    parts.push('### Changed files\n');
    parts.push('```\n' + bundle.gitDiff.value.trim() + '\n```\n');
  }

  return parts.join('\n');
}

// Re-export types used by callers so they can import from the module root
export type { AssemblyTask, ContextBundle, ContextAssembler, SessionNote, RenderOpts } from './types.js';
export type { ContextAssemblerDeps } from './deps.js';
