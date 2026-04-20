/**
 * QUICK_REVIEW Pipeline Mode Executor
 *
 * Delegates dep-bump PR review to the existing runPrReviewCoordinator() with
 * a specialized [DEP BUMP] goal prefix that instructs the reviewer to skip
 * architecture audit and focus on version compatibility and test coverage.
 *
 * WHY delegation with goal prefix (not a separate workflow):
 * runPrReviewCoordinator() accepts a custom review goal. By prefixing with
 * [DEP BUMP], the reviewer gets explicit context about what to focus on.
 * No new workflow needed; the existing mr-review-workflow-agentic handles it.
 * (Pitch invariant 10: QUICK_REVIEW delegates to runPrReviewCoordinator().)
 *
 * Goal prefix format: "[DEP BUMP] Review PR #${prNumber}: ${prTitle}
 * -- skip architecture audit, verify version compatibility and test coverage only"
 */

import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts, PipelineOutcome } from '../adaptive-pipeline.js';
import { runPrReviewCoordinator } from '../pr-review.js';

/**
 * Run the QUICK_REVIEW pipeline mode for dependency bump PRs.
 *
 * Builds a [DEP BUMP] goal prefix for each PR and delegates to
 * runPrReviewCoordinator() with focused review instructions.
 *
 * @param deps - Adaptive coordinator deps (superset of CoordinatorDeps)
 * @param opts - Pipeline options (goal contains the dep-bump description)
 * @param prNumbers - PR numbers extracted from the goal (should have >= 1)
 * @param coordinatorStartMs - Wall-clock start time for timeout tracking
 */
export async function runQuickReviewPipeline(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  prNumbers: readonly number[],
  _coordinatorStartMs: number,
): Promise<PipelineOutcome> {
  deps.stderr(`[quick-review] Dep-bump review for PR(s) [${prNumbers.join(', ')}]`);

  // Build the [DEP BUMP] goal prefix for each PR.
  // The original goal is used as the "prTitle" context since we don't have
  // a separate title lookup. The review workflow will read the actual PR title.
  const depBumpGoal = buildDepBumpGoal(prNumbers, opts.goal);
  deps.stderr(`[quick-review] Goal: "${depBumpGoal.slice(0, 100)}"`);

  const result = await runPrReviewCoordinator(deps, {
    workspace: opts.workspace,
    prs: prNumbers.length > 0 ? [...prNumbers] : undefined,
    dryRun: opts.dryRun ?? false,
    port: opts.port,
  });

  // Same outcome mapping as REVIEW_ONLY -- just a different goal prefix
  if (result.hasErrors || result.escalated > 0) {
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 'review',
        reason: result.hasErrors
          ? `dep-bump review coordinator reported errors (escalated=${result.escalated})`
          : `${result.escalated} dep-bump PR(s) escalated during review`,
      },
    };
  }

  return {
    kind: 'merged',
    prUrl: result.mergedPrs.length > 0 ? `PR #${result.mergedPrs[0]}` : null,
  };
}

/**
 * Build the [DEP BUMP] goal prefix for dependency bump review.
 *
 * Format per pitch specification:
 * "[DEP BUMP] Review PR #${prNumber}: ... -- skip architecture audit,
 * verify version compatibility and test coverage only"
 *
 * For multiple PRs, uses the first PR number in the prefix.
 * The reviewer will process all provided PRs.
 */
export function buildDepBumpGoal(prNumbers: readonly number[], originalGoal: string): string {
  const firstPr = prNumbers[0];
  const prRef = firstPr !== undefined ? `PR #${firstPr}` : 'dep-bump PR';
  const prTitle = originalGoal.slice(0, 80);
  return `[DEP BUMP] Review ${prRef}: ${prTitle} -- skip architecture audit, verify version compatibility and test coverage only`;
}
