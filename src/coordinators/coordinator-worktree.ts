/**
 * Shared pipeline worktree lifecycle for coordinator mode executors.
 *
 * WHY this module: the worktree setup logic (crash recovery, creation,
 * context persistence, existence check) is identical between FULL and IMPLEMENT
 * modes. Extracting it here eliminates the duplicate `worktreeCreated` flag
 * and the `if (!priorRunId || priorWorktreePath === undefined)` guard pattern
 * from both mode files. A third mode (e.g. EPIC_FULL) calls setupPipelineWorktree()
 * without copying any lifecycle boilerplate.
 *
 * The caller owns the `finally` block: pitch archival then
 * `if (worktreeCreated) await deps.removePipelineWorktree(...)`.
 */

import type { AdaptiveCoordinatorDeps, PipelineOutcome } from './adaptive-pipeline.js';

// ---------------------------------------------------------------------------
// WorktreeSetupResult
// ---------------------------------------------------------------------------

/**
 * Successful worktree setup: the worktree is ready for sessions.
 *
 * - `activeWorkspacePath`: the effective workspace path for all session spawns
 *   and within-session path construction (pitchPath, archiveDir, delivery).
 * - `worktreeCreated`: true when THIS call created the worktree. The caller's
 *   finally block must call removePipelineWorktree only when this is true.
 *   False for crash-resume (existing worktree reused) and CLI no-op stub.
 */
export interface WorktreeSetupOk {
  readonly kind: 'ok';
  readonly activeWorkspacePath: string;
  readonly worktreeCreated: boolean;
}

/**
 * Failed worktree setup: the pipeline must escalate at phase 'init'.
 * The caller returns this escalated outcome directly without running any sessions.
 */
export interface WorktreeSetupFailed {
  readonly kind: 'failed';
  readonly outcome: PipelineOutcome;
}

export type WorktreeSetupResult = WorktreeSetupOk | WorktreeSetupFailed;

// ---------------------------------------------------------------------------
// setupPipelineWorktree
// ---------------------------------------------------------------------------

/**
 * Resolve the active workspace path for a pipeline run.
 *
 * Handles three cases in order:
 * 1. Crash resume with existing worktree: reuse the persisted path if it exists on disk.
 * 2. Fresh run (or old-format resume): create a new worktree and persist its path.
 * 3. Worktree creation failed: return a failed result so the caller can escalate.
 *
 * Callers use the result as:
 * ```typescript
 * const worktreeSetup = await setupPipelineWorktree(deps, opts.workspace, runId, priorWorktreePath, pipelineMode, opts.goal);
 * if (worktreeSetup.kind === 'failed') return worktreeSetup.outcome;
 * const { activeWorkspacePath, worktreeCreated } = worktreeSetup;
 * // ... run pipeline phases ...
 * // In finally:
 * if (worktreeCreated) await deps.removePipelineWorktree(opts.workspace, activeWorkspacePath);
 * ```
 *
 * @param workspace - The main repo checkout path (opts.workspace). Used for git operations
 *   and as the enricher-correct trigger.workspacePath for all spawned sessions.
 * @param runId - The current pipeline run ID.
 * @param priorWorktreePath - The worktreePath from the existing PipelineRunContext, if any.
 *   Undefined when starting a fresh run or when the prior context predates this feature.
 * @param pipelineMode - Passed to createPipelineContext for durability. Also used for log messages.
 * @param goal - Passed to createPipelineContext for durability.
 */
export async function setupPipelineWorktree(
  deps: AdaptiveCoordinatorDeps,
  workspace: string,
  runId: string,
  priorWorktreePath: string | undefined,
  pipelineMode: 'FULL' | 'IMPLEMENT',
  goal: string,
): Promise<WorktreeSetupResult> {
  const tag = `[${pipelineMode.toLowerCase()}-pipeline]`;

  if (priorWorktreePath !== undefined) {
    if (!deps.fileExists(priorWorktreePath)) {
      deps.stderr(`${tag} Crash recovery: prior pipeline worktree not found at ${priorWorktreePath}`);
      return {
        kind: 'failed',
        outcome: {
          kind: 'escalated',
          escalationReason: {
            phase: 'init',
            reason:
              `Crash recovery: prior pipeline worktree not found at ${priorWorktreePath}. ` +
              `Delete ${workspace}/.workrail/pipeline-runs/${runId}-context.json to start fresh.`,
          },
        },
      };
    }
    deps.stderr(`${tag} Crash recovery: reusing existing worktree at ${priorWorktreePath}`);
    return { kind: 'ok', activeWorkspacePath: priorWorktreePath, worktreeCreated: false };
  }

  const worktreeResult = await deps.createPipelineWorktree(workspace, runId);
  if (worktreeResult.isErr()) {
    deps.stderr(`${tag} FATAL: failed to create pipeline worktree: ${worktreeResult.error}`);
    return {
      kind: 'failed',
      outcome: {
        kind: 'escalated',
        escalationReason: { phase: 'init', reason: `Pipeline worktree creation failed: ${worktreeResult.error}` },
      },
    };
  }

  const activeWorkspacePath = worktreeResult.value;

  const initResult = await deps.createPipelineContext(workspace, runId, goal, pipelineMode, activeWorkspacePath);
  if (initResult.isErr()) {
    deps.stderr(`${tag} FATAL: failed to initialize PipelineRunContext: ${initResult.error}`);
    await deps.removePipelineWorktree(workspace, activeWorkspacePath);
    return {
      kind: 'failed',
      outcome: {
        kind: 'escalated',
        escalationReason: { phase: 'init', reason: `PipelineRunContext initialization failed: ${initResult.error}` },
      },
    };
  }

  return { kind: 'ok', activeWorkspacePath, worktreeCreated: true };
}
