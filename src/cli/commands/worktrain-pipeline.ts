/**
 * WorkTrain Pipeline Command
 *
 * Runs the adaptive pipeline coordinator for a given task.
 * Routes the task to QUICK_REVIEW, REVIEW_ONLY, IMPLEMENT, or FULL mode
 * based on static signals in the goal and workspace state, then executes
 * the appropriate pipeline phases end-to-end.
 *
 * Usage:
 *   worktrain run pipeline --workspace <path> --goal <text>
 *   worktrain run pipeline --workspace <path> --goal <text> --mode IMPLEMENT
 *   worktrain run pipeline --workspace <path> --goal <text> --dry-run
 *
 * Design invariants:
 * - All I/O is injected via WorktrainPipelineCommandDeps. Zero direct fs/fetch imports.
 * - All failures are returned as CliResult failure variants -- never thrown.
 * - The coordinator (runAdaptivePipeline) is injected to allow testing without the full coordinator.
 */

import type { CliResult } from '../types/cli-result.js';
import { successMessage, failure, misuse } from '../types/cli-result.js';
import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts, PipelineOutcome, ModeExecutors } from '../../coordinators/adaptive-pipeline.js';
import { runAdaptivePipeline } from '../../coordinators/adaptive-pipeline.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface WorktrainPipelineCommandDeps extends AdaptiveCoordinatorDeps {
  /** Write a line to stdout. */
  readonly stdout: (line: string) => void;
  /** Return true if the path is absolute. */
  readonly pathIsAbsolute: (p: string) => boolean;
  /** Stat a path and return whether it is a directory. Throws on ENOENT. */
  readonly statPath: (p: string) => Promise<{ isDirectory: () => boolean }>;
}

export interface WorktrainPipelineCommandOpts {
  /** Absolute path to the workspace directory. */
  readonly workspace: string;
  /** The task goal string. */
  readonly goal: string;
  /**
   * Explicit pipeline mode override (bypasses static routing).
   * Valid values: QUICK_REVIEW, REVIEW_ONLY, IMPLEMENT, FULL
   */
  readonly mode?: string;
  /** If true, print actions without executing HTTP calls or git operations. */
  readonly dryRun?: boolean;
  /** Override the console HTTP server port. */
  readonly port?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// VALID MODE VALUES
// ═══════════════════════════════════════════════════════════════════════════

const VALID_MODES = ['QUICK_REVIEW', 'REVIEW_ONLY', 'IMPLEMENT', 'FULL'] as const;
type ValidMode = (typeof VALID_MODES)[number];

function isValidMode(mode: string): mode is ValidMode {
  return (VALID_MODES as readonly string[]).includes(mode);
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMAND EXECUTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute the worktrain run pipeline command.
 *
 * Wires real mode executors and runs the adaptive pipeline coordinator.
 */
export async function executeWorktrainPipelineCommand(
  deps: WorktrainPipelineCommandDeps,
  opts: WorktrainPipelineCommandOpts,
): Promise<CliResult> {
  // ── Input validation at the boundary ─────────────────────────────────
  const goal = opts.goal.trim();
  if (!goal) {
    return misuse('--goal is required and must not be empty.');
  }

  const workspace = opts.workspace.trim();
  if (!workspace) {
    return misuse('--workspace is required and must not be empty.');
  }

  if (!deps.pathIsAbsolute(workspace)) {
    return misuse(`--workspace must be an absolute path, got: ${workspace}`);
  }

  try {
    const stat = await deps.statPath(workspace);
    if (!stat.isDirectory()) {
      return failure(`--workspace must be an existing directory: ${workspace}`);
    }
  } catch {
    return failure(`--workspace does not exist: ${workspace}`);
  }

  // Validate --mode if provided
  let modeOverride: ValidMode | undefined;
  if (opts.mode) {
    const modeUpper = opts.mode.toUpperCase();
    if (!isValidMode(modeUpper)) {
      return misuse(
        `--mode must be one of: ${VALID_MODES.join(', ')}. Got: ${opts.mode}`,
        [`Valid modes: ${VALID_MODES.join(', ')}`],
      );
    }
    modeOverride = modeUpper;
  }

  deps.stderr(`[pipeline] Starting adaptive pipeline: goal="${goal.slice(0, 80)}" workspace="${workspace}"`);
  if (modeOverride) {
    deps.stderr(`[pipeline] Mode override: ${modeOverride}`);
  }

  // ── Wire mode executors ───────────────────────────────────────────────
  // Lazily import mode executors to wire the real implementations.
  // This is the composition root for the adaptive pipeline.
  const { runReviewOnlyPipeline } = await import('../../coordinators/modes/review-only.js');
  const { runQuickReviewPipeline } = await import('../../coordinators/modes/quick-review.js');
  const { runImplementPipeline } = await import('../../coordinators/modes/implement.js');
  const { runFullPipeline } = await import('../../coordinators/modes/full-pipeline.js');

  const executors: ModeExecutors = {
    runReviewOnly: runReviewOnlyPipeline,
    runQuickReview: runQuickReviewPipeline,
    runImplement: runImplementPipeline,
    runFull: runFullPipeline,
  };

  // ── Run adaptive pipeline ─────────────────────────────────────────────
  const pipelineOpts: AdaptivePipelineOpts = {
    workspace,
    goal,
    dryRun: opts.dryRun ?? false,
    port: opts.port,
    modeOverride,
  };

  let outcome: PipelineOutcome;
  try {
    outcome = await runAdaptivePipeline(deps, pipelineOpts, executors);
  } catch (e) {
    // runAdaptivePipeline should never throw (errors-as-data policy),
    // but catch here as a last resort to prevent unhandled rejections.
    const message = e instanceof Error ? e.message : String(e);
    deps.stderr(`[pipeline] Unexpected error: ${message}`);
    return failure(`Pipeline coordinator threw unexpectedly: ${message}`);
  }

  // ── Map outcome to CliResult ──────────────────────────────────────────
  return interpretPipelineOutcome(outcome, deps.stdout);
}

// ═══════════════════════════════════════════════════════════════════════════
// OUTCOME INTERPRETATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Map a PipelineOutcome to a CliResult.
 * Writes human-readable output to stdout.
 */
function interpretPipelineOutcome(
  outcome: PipelineOutcome,
  stdout: (line: string) => void,
): CliResult {
  switch (outcome.kind) {
    case 'merged':
      stdout(`Pipeline completed: PR merged${outcome.prUrl ? ` (${outcome.prUrl})` : ''}`);
      return successMessage(`Pipeline completed successfully.${outcome.prUrl ? ` PR: ${outcome.prUrl}` : ''}`);

    case 'escalated': {
      const { phase, reason } = outcome.escalationReason;
      stdout(`Pipeline escalated: phase=${phase} reason=${reason}`);
      return failure(`Pipeline escalated at phase '${phase}': ${reason}`, {
        details: [`Phase: ${phase}`, `Reason: ${reason}`],
        suggestions: ['Check the Human Outbox for the full escalation notice.'],
      });
    }

    case 'dry_run':
      stdout(`Dry run: would execute ${outcome.mode} pipeline`);
      return successMessage(`Dry run completed. Would execute: ${outcome.mode} pipeline`);
  }
}
