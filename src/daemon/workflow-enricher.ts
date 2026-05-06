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

export interface EnricherResult {
  readonly priorSessionNotes: readonly SessionNote[];
  readonly gitDiffStat: string | null;
}

export const EMPTY_RESULT: EnricherResult = {
  priorSessionNotes: [],
  gitDiffStat: null,
};

// ---------------------------------------------------------------------------
// PriorNotesPolicy
// ---------------------------------------------------------------------------

/**
 * Controls whether prior workspace session notes are assembled.
 *
 * 'inject': assemble and inject notes (standard path for all root sessions).
 * 'skip_coordinator_provided': coordinator already wrote assembledContextSummary;
 *   prior notes would be redundant and lower-signal. gitDiffStat still assembled.
 */
export type PriorNotesPolicy = 'inject' | 'skip_coordinator_provided';

// ---------------------------------------------------------------------------
// WorkflowEnricherDeps
// ---------------------------------------------------------------------------

export interface WorkflowEnricherDeps {
  readonly execGit: (args: readonly string[], cwd: string) => Promise<Result<string, string>>;
  readonly listRecentSessions: (workspacePath: string, limit: number) => Promise<Result<readonly SessionNote[], string>>;
}

// ---------------------------------------------------------------------------
// Production deps factory
// ---------------------------------------------------------------------------

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
// raceWithTimeout
// ---------------------------------------------------------------------------

const LIST_SESSIONS_TIMEOUT_MS = 1000;

/**
 * Race a promise against a timeout. Clears the timer if the promise resolves
 * first to avoid handle leaks.
 *
 * Returns err('timeout') when the timer fires before the promise resolves.
 */
function raceWithTimeout<T>(
  promise: Promise<Result<T, string>>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Result<T, string>> {
  let handle: ReturnType<typeof setTimeout>;
  const timeout = new Promise<Result<T, string>>((resolve) => {
    handle = setTimeout(() => resolve({ kind: 'err', error: timeoutMessage }), timeoutMs);
  });
  return Promise.race([
    promise.then((r) => { clearTimeout(handle); return r; }),
    timeout,
  ]);
}

// ---------------------------------------------------------------------------
// enrichTriggerContext
// ---------------------------------------------------------------------------

const MAX_PRIOR_NOTES = 3;

export async function enrichTriggerContext(
  trigger: WorkflowTrigger,
  deps: WorkflowEnricherDeps,
  policy: PriorNotesPolicy,
): Promise<EnricherResult> {
  const notesPromise = policy === 'skip_coordinator_provided'
    ? Promise.resolve<Result<readonly SessionNote[], string>>({ kind: 'ok', value: [] })
    : raceWithTimeout(
        deps.listRecentSessions(trigger.workspacePath, MAX_PRIOR_NOTES),
        LIST_SESSIONS_TIMEOUT_MS,
        'listRecentSessions timeout (1s)',
      );

  const [notesResult, gitResult] = await Promise.all([
    notesPromise,
    deps.execGit(['diff', 'HEAD~1', '--stat'], trigger.workspacePath),
  ]);

  return {
    priorSessionNotes: notesResult.kind === 'ok' ? notesResult.value : [],
    gitDiffStat: gitResult.kind === 'ok' && gitResult.value.trim().length > 0
      ? gitResult.value.trim()
      : null,
  };
}

// ---------------------------------------------------------------------------
// shouldEnrich
// ---------------------------------------------------------------------------

export function shouldEnrich(trigger: WorkflowTrigger): boolean {
  return (trigger.spawnDepth ?? 0) === 0;
}
