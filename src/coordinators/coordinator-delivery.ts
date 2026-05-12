/**
 * Coordinator-owned delivery: commit + PR creation for coordinator-spawned coding sessions.
 *
 * WHY a separate module (not inline in full-pipeline.ts / implement.ts):
 * Both FULL and IMPLEMENT pipeline modes need the same delivery logic. Extracting it
 * here eliminates duplication and makes the delivery path independently testable.
 *
 * WHY not reusing runDeliveryPipeline() from trigger/delivery-pipeline.ts:
 * That module imports WorkflowRunSuccess and DAEMON_SESSIONS_DIR -- daemon-only types.
 * The coordinator layer cannot depend on daemon internals. This module delegates to
 * runDelivery() from delivery-action.ts which has no daemon-only imports.
 *
 * WHY HandoffArtifact from parseHandoffArtifact(recapMarkdown) not from CodingHandoffArtifactV1:
 * CodingHandoffArtifactV1 carries {branchName, filesChanged, keyDecisions} -- audit/review fields.
 * HandoffArtifact carries {commitType, commitScope, commitSubject, prTitle, prBody, filesChanged} --
 * delivery fields. These are structurally different types. The coding workflow embeds the delivery
 * HandoffArtifact as a JSON block in the final step's notes (recapMarkdown).
 */

import type { AdaptiveCoordinatorDeps } from './adaptive-pipeline.js';
import { parseHandoffArtifact, runDelivery } from '../trigger/delivery-action.js';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';

// ---------------------------------------------------------------------------
// extractPrNumberFromUrl
// ---------------------------------------------------------------------------

/**
 * Parse a PR number from a GitHub PR URL.
 *
 * Returns the integer PR number on success, null if the URL does not contain
 * a parseable /pull/<number> segment.
 *
 * WHY pure function (not inline at call sites): testable in isolation; two call
 * sites (implement.ts, full-pipeline.ts) share the same implementation.
 *
 * Examples:
 *   'https://github.com/owner/repo/pull/42'  -> 42
 *   'https://github.com/owner/repo/pull/abc' -> null
 *   ''                                        -> null
 */
export function extractPrNumberFromUrl(prUrl: string): number | null {
  const match = /\/pull\/(\d+)(?:\/|$)/.exec(prUrl);
  if (!match || !match[1]) return null;
  const n = parseInt(match[1], 10);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// runCoordinatorDelivery
// ---------------------------------------------------------------------------

/**
 * Run post-coding delivery (git commit + gh pr create) for a coordinator-spawned session.
 *
 * Reads the HandoffArtifact from the final step's notes (recapMarkdown), then delegates
 * to runDelivery() from delivery-action.ts for the actual git/gh operations.
 *
 * Returns ok(prUrl | null) on success -- prUrl is the opened PR URL when autoOpenPR:true
 * succeeds, null when delivery committed but did not open a PR.
 * Returns err(reason) when delivery fails -- callers should escalate.
 *
 * WHY recapMarkdown (not CodingHandoffArtifactV1): see module-level WHY comment.
 * WHY Result<string|null> (not void): the PR URL from runDelivery() is needed by callers
 * to drive the review cycle. Discarding it and re-fetching via pollForPR() introduces a
 * race: if GitHub's indexing lags behind gh pr create returning, pollForPR() may time out
 * on a PR that was successfully created. The URL returned by gh pr create is authoritative.
 */
export async function runCoordinatorDelivery(
  deps: AdaptiveCoordinatorDeps,
  recapMarkdown: string | null,
  branchName: string,
  workspacePath: string,
): Promise<Result<string | null, string>> {
  if (!recapMarkdown) {
    deps.stderr(
      '[WARN coordinator-delivery] recapMarkdown is null -- coding session produced no step notes. ' +
      'Delivery skipped. Check that the coding workflow emits notes on the final step.',
    );
    return err('coding session produced no step notes; cannot parse HandoffArtifact');
  }


  const parseResult = parseHandoffArtifact(recapMarkdown);
  if (parseResult.kind === 'err') {
    deps.stderr(
      `[WARN coordinator-delivery] parseHandoffArtifact failed: ${parseResult.error}. ` +
      'Delivery skipped. Check that the coding workflow embeds a valid handoff JSON block in step notes.',
    );
    return err(`parseHandoffArtifact failed: ${parseResult.error}`);
  }

  const artifact = parseResult.value;

  const deliveryResult = await runDelivery(
    artifact,
    workspacePath,
    {
      autoCommit: true,
      autoOpenPR: true,
      // WHY no sessionId/branchPrefix assertion: the coordinator uses the branchName
      // from CodingHandoffArtifactV1 (the agent-reported branch) for pollForPR().
      // The HEAD assertion in runDelivery() uses sessionId+branchPrefix to construct
      // the expected branch -- that mechanism is for daemon-path sessions only.
      // Coordinator sessions don't have a RunId; the assertion is skipped here.
      secretScan: true,
    },
    deps.execDelivery,
  );

  if (deliveryResult._tag === 'skipped') {
    deps.stderr(`[WARN coordinator-delivery] Delivery skipped: ${deliveryResult.reason}`);
    return err(`delivery skipped: ${deliveryResult.reason}`);
  }

  if (deliveryResult._tag === 'error') {
    deps.stderr(
      `[WARN coordinator-delivery] Delivery failed at phase '${deliveryResult.phase}': ${deliveryResult.details}`,
    );
    return err(`delivery failed at phase '${deliveryResult.phase}': ${deliveryResult.details}`);
  }

  const prUrl = deliveryResult._tag === 'pr_opened' ? deliveryResult.url : null;
  deps.stderr(
    `[coordinator-delivery] Delivery complete. ` +
    `Branch: ${branchName} | PR: ${prUrl ?? 'not opened'}`,
  );
  return ok(prUrl);
}
