/**
 * REVIEW_ONLY Pipeline Mode Executor
 *
 * Delegates PR review to the existing runPrReviewCoordinator() without
 * reimplementing the fix-agent loop.
 *
 * WHY delegation (not reimplementation):
 * runPrReviewCoordinator() already implements the complete review pipeline:
 * spawn review session -> await -> parse findings -> route (clean/minor/blocking).
 * The fix-agent loop for minor findings is included. Reimplementing it here
 * would duplicate logic and diverge over time (pitch invariant 10).
 *
 * The REVIEW_ONLY mode wraps CoordinatorResult -> PipelineOutcome.
 * CoordinatorResult has PR-review-specific count fields; PipelineOutcome
 * is the single-task pipeline domain type.
 */

import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts, PipelineOutcome } from '../adaptive-pipeline.js';
import { runPrReviewCoordinator } from '../pr-review.js';

/**
 * Run the REVIEW_ONLY pipeline mode.
 *
 * Delegates to runPrReviewCoordinator() and maps CoordinatorResult to PipelineOutcome.
 *
 * @param deps - Adaptive coordinator deps (superset of CoordinatorDeps)
 * @param opts - Pipeline options
 * @param prNumbers - PR numbers to review (empty array = discover open PRs)
 * @param coordinatorStartMs - Wall-clock start time for timeout tracking
 */
export async function runReviewOnlyPipeline(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  prNumbers: readonly number[],
  _coordinatorStartMs: number,
): Promise<PipelineOutcome> {
  deps.stderr(`[review-only] Delegating to runPrReviewCoordinator() for ${prNumbers.length > 0 ? `PR(s) [${prNumbers.join(', ')}]` : 'all open PRs'}`);

  const result = await runPrReviewCoordinator(deps, {
    workspace: opts.workspace,
    prs: prNumbers.length > 0 ? [...prNumbers] : undefined,
    dryRun: opts.dryRun ?? false,
    port: opts.port,
  });

  // Map CoordinatorResult -> PipelineOutcome
  // WHY map rather than return CoordinatorResult:
  // CoordinatorResult has PR-review-specific fields (reviewed/approved counts)
  // that are semantically wrong for the pipeline domain. PipelineOutcome is
  // the clean domain type for single-task pipeline runs.
  if (result.hasErrors || result.escalated > 0) {
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 'review',
        reason: result.hasErrors
          ? `review coordinator reported errors (escalated=${result.escalated})`
          : `${result.escalated} PR(s) escalated during review`,
      },
    };
  }

  return {
    kind: 'merged',
    prUrl: result.mergedPrs.length > 0 ? `PR #${result.mergedPrs[0]}` : null,
  };
}
