/**
 * WorkflowEnricher: inject cross-session context for all session entry points.
 *
 * WHY this module: runWorkflow() is the single point through which all 6 session
 * entry points pass. Placing enrichment here -- for root sessions only -- gives
 * every entry point prior workspace session notes and git diff stat without
 * requiring each coordinator or trigger to opt in.
 *
 * WHY root sessions only (spawnDepth === 0): spawn_agent children should
 * inherit context from their parent's params.context, not re-assemble
 * independently. Enriching children would trigger redundant I/O for every
 * nested call and could produce context that conflicts with the parent's
 * richer coordinator-assembled context.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Result } from '../runtime/result.js';
import type { SessionNote } from '../context-assembly/types.js';
import type { WorkflowTrigger } from './types.js';
import { createListRecentSessions } from '../context-assembly/infra.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// EnricherResult
// ---------------------------------------------------------------------------

/**
 * Typed output of enrichTriggerContext().
 *
 * WHY a named type (not Partial<Record<string,unknown>>): makes the valid
 * payload explicit, gives buildSystemPrompt typed parameters rather than
 * runtime guards, and prevents accidental shadowing of WorkflowTrigger fields.
 */
export interface EnricherResult {
  /** Prior workspace session notes (max 3, newest-first, workspace-scoped). */
  readonly priorSessionNotes: readonly SessionNote[];
  /**
   * Output of `git diff HEAD~1 --stat` for the workspace.
   * Null when git is unavailable, the workspace has no commits, or the
   * command fails for any reason.
   */
  readonly gitDiffStat: string | null;
}

/** Empty result returned on timeout or total failure. */
const EMPTY_RESULT: EnricherResult = {
  priorSessionNotes: [],
  gitDiffStat: null,
};

// ---------------------------------------------------------------------------
// WorkflowEnricherDeps
// ---------------------------------------------------------------------------

/**
 * Injectable I/O dependencies for the enricher.
 *
 * Follows the ContextAssemblerDeps DI pattern exactly: all I/O behind this
 * interface; tests inject fakes.
 */
export interface WorkflowEnricherDeps {
  /**
   * Run a git command in the given working directory.
   * Args passed as an array -- no shell interpolation.
   */
  readonly execGit: (
    args: readonly string[],
    cwd: string,
  ) => Promise<Result<string, string>>;

  /**
   * List recent sessions for a workspace, ordered newest-first.
   * Returns at most `limit` sessions.
   */
  readonly listRecentSessions: (
    workspacePath: string,
    limit: number,
  ) => Promise<Result<readonly SessionNote[], string>>;
}

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

/**
 * Create production WorkflowEnricherDeps.
 */
export function createWorkflowEnricherDeps(): WorkflowEnricherDeps {
  return {
    execGit: async (args, cwd) => {
      try {
        const { stdout } = await execFileAsync('git', [...args], { cwd });
        return { kind: 'ok', value: stdout };
      } catch (e) {
        return { kind: 'err', error: e instanceof Error ? e.message : String(e) };
      }
    },
    listRecentSessions: createListRecentSessions(),
  };
}

// ---------------------------------------------------------------------------
// enrichTriggerContext
// ---------------------------------------------------------------------------

/** Maximum prior session notes to inject. */
const MAX_PRIOR_NOTES = 3;

/** Wall-clock timeout for listRecentSessions (ms). */
const LIST_SESSIONS_TIMEOUT_MS = 1000;

/**
 * Assemble cross-session context for a root session.
 *
 * Never throws. On any failure, returns the best partial result available.
 *
 * @param trigger - The WorkflowTrigger for this session.
 * @param deps - Injectable I/O dependencies.
 * @param skipPriorNotes - When true, skip prior notes assembly (coordinator
 *   already provided richer context via assembledContextSummary). gitDiffStat
 *   is always attempted regardless.
 */
export async function enrichTriggerContext(
  trigger: WorkflowTrigger,
  deps: WorkflowEnricherDeps,
  skipPriorNotes: boolean,
): Promise<EnricherResult> {
  // Run prior notes and git diff concurrently.
  const [notesResult, gitResult] = await Promise.all([
    skipPriorNotes
      ? Promise.resolve<Result<readonly SessionNote[], string>>({ kind: 'ok', value: [] })
      : Promise.race<Result<readonly SessionNote[], string>>([
          deps.listRecentSessions(trigger.workspacePath, MAX_PRIOR_NOTES),
          new Promise<Result<readonly SessionNote[], string>>((resolve) =>
            setTimeout(
              () => resolve({ kind: 'err', error: 'listRecentSessions timeout (1s)' }),
              LIST_SESSIONS_TIMEOUT_MS,
            ),
          ),
        ]),
    deps.execGit(['diff', 'HEAD~1', '--stat'], trigger.workspacePath),
  ]);

  const priorSessionNotes =
    notesResult.kind === 'ok' ? notesResult.value : [];

  const gitDiffStat =
    gitResult.kind === 'ok' && gitResult.value.trim().length > 0
      ? gitResult.value.trim()
      : null;

  return { priorSessionNotes, gitDiffStat };
}

/**
 * Decide whether to run the enricher for this trigger.
 *
 * WHY a separate pure function: keeps the guard logic testable without
 * setting up a full WorkflowTrigger with all fields.
 *
 * Returns false for:
 * - spawn_agent children (spawnDepth > 0) -- children use parent's context
 */
export function shouldEnrich(trigger: WorkflowTrigger): boolean {
  return (trigger.spawnDepth ?? 0) === 0;
}

export { EMPTY_RESULT };
