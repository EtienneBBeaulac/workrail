/**
 * Shared review + verdict routing logic for IMPLEMENT and FULL pipeline modes.
 *
 * Both IMPLEMENT and FULL modes run the same review -> verdict -> fix-loop -> audit-chain
 * sequence after the coding session completes. This module extracts that shared logic
 * to avoid duplication.
 *
 * WHY a separate module (not a class or closure):
 * Following the "compose with small, pure functions" principle. The review cycle
 * is a well-defined phase that can be imported and tested independently.
 */

import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts, PipelineOutcome } from '../adaptive-pipeline.js';
import { CODING_TIMEOUT_MS, REVIEW_TIMEOUT_MS, checkSpawnCutoff } from '../adaptive-pipeline.js';
import { readVerdictArtifact, parseFindingsFromNotes } from '../pr-review.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Max fix-loop iterations (pitch invariant 15: exactly 2). */
export const MAX_FIX_ITERATIONS = 2;

// ═══════════════════════════════════════════════════════════════════════════
// SHARED REVIEW + VERDICT CYCLE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the review session and route the verdict.
 * Handles fix loop (max 2 iterations) and audit chain for blocking/critical findings.
 *
 * Shared by IMPLEMENT mode (implement.ts) and FULL pipeline mode (full-pipeline.ts).
 *
 * @param iteration - Current fix loop iteration (0 = first review)
 */
export async function runReviewAndVerdictCycle(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  prUrl: string,
  coordinatorStartMs: number,
  iteration: number,
): Promise<PipelineOutcome> {
  const cutoffCheck = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'review');
  if (cutoffCheck) return cutoffCheck;

  const reviewGoal = iteration === 0
    ? `Review PR for merge: ${prUrl}`
    : `Re-review PR after fixes (iteration ${iteration}): ${prUrl}`;

  deps.stderr(`[review-cycle] Spawning review session (iteration=${iteration}): ${reviewGoal.slice(0, 80)}`);

  const reviewSpawnResult = await deps.spawnSession(
    'mr-review-workflow-agentic',
    reviewGoal,
    opts.workspace,
    { prUrl },
  );

  if (reviewSpawnResult.kind === 'err') {
    return {
      kind: 'escalated',
      escalationReason: { phase: 'review', reason: `review session spawn failed: ${reviewSpawnResult.error}` },
    };
  }

  const reviewHandle = reviewSpawnResult.value;
  if (!reviewHandle) {
    return {
      kind: 'escalated',
      escalationReason: { phase: 'review', reason: 'review session returned empty handle' },
    };
  }

  const reviewAwait = await deps.awaitSessions([reviewHandle], REVIEW_TIMEOUT_MS);
  const reviewResult = reviewAwait.results[0];

  if (!reviewResult || reviewResult.outcome !== 'success') {
    const outcome = reviewResult?.outcome ?? 'not_found';
    return {
      kind: 'escalated',
      escalationReason: { phase: 'review', reason: `review session ${outcome}` },
    };
  }

  const agentResult = await deps.getAgentResult(reviewHandle);
  const verdictFromArtifact = readVerdictArtifact(agentResult.artifacts, reviewHandle);
  const findingsResult = verdictFromArtifact !== null
    ? { kind: 'ok' as const, value: verdictFromArtifact }
    : parseFindingsFromNotes(agentResult.recapMarkdown);

  if (findingsResult.kind === 'err') {
    return {
      kind: 'escalated',
      escalationReason: { phase: 'review', reason: `review verdict parse failed: ${findingsResult.error}` },
    };
  }

  const findings = findingsResult.value;
  deps.stderr(`[review-cycle] Verdict: ${findings.severity} (iteration=${iteration})`);

  switch (findings.severity) {
    case 'clean':
      deps.stderr(`[review-cycle] Verdict clean -- merging PR`);
      return { kind: 'merged', prUrl };

    case 'minor': {
      if (iteration >= MAX_FIX_ITERATIONS) {
        deps.stderr(`[review-cycle] ${MAX_FIX_ITERATIONS} fix iterations exhausted -- escalating`);
        await deps.postToOutbox(
          `Adaptive pipeline escalated: fix loop exhausted after ${MAX_FIX_ITERATIONS} iterations`,
          { prUrl, phase: 'fix-loop', reason: 'max iterations reached', findingSummaries: findings.findingSummaries },
        );
        return {
          kind: 'escalated',
          escalationReason: { phase: 'fix-loop', reason: `${MAX_FIX_ITERATIONS} fix iterations exhausted` },
        };
      }

      deps.stderr(`[review-cycle] Verdict minor -- running fix iteration ${iteration + 1}/${MAX_FIX_ITERATIONS}`);

      const fixCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'fix-agent');
      if (fixCutoff) return fixCutoff;

      const fixGoal = `Fix review findings: ${findings.findingSummaries.slice(0, 3).join('; ')}`;
      const fixSpawnResult = await deps.spawnSession(
        'coding-task-workflow-agentic',
        fixGoal,
        opts.workspace,
        { prUrl, findings: findings.findingSummaries },
      );

      if (fixSpawnResult.kind === 'err') {
        return {
          kind: 'escalated',
          escalationReason: { phase: 'fix-agent', reason: `fix agent spawn failed: ${fixSpawnResult.error}` },
        };
      }

      const fixHandle = fixSpawnResult.value;
      if (!fixHandle) {
        return {
          kind: 'escalated',
          escalationReason: { phase: 'fix-agent', reason: 'fix agent returned empty handle' },
        };
      }

      const fixAwait = await deps.awaitSessions([fixHandle], CODING_TIMEOUT_MS);
      const fixResult = fixAwait.results[0];

      if (!fixResult || fixResult.outcome !== 'success') {
        const outcome = fixResult?.outcome ?? 'not_found';
        return {
          kind: 'escalated',
          escalationReason: { phase: 'fix-agent', reason: `fix agent ${outcome}` },
        };
      }

      deps.stderr(`[review-cycle] Fix iteration ${iteration + 1} complete -- re-reviewing`);
      return runReviewAndVerdictCycle(deps, opts, prUrl, coordinatorStartMs, iteration + 1);
    }

    case 'blocking':
    case 'unknown': {
      return runAuditChain(deps, opts, prUrl, coordinatorStartMs, findings.severity);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT CHAIN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the escalating audit chain for blocking/critical findings.
 *
 * Steps:
 * 1. Dispatch production-readiness-audit
 *    NOTE: findingCategory is NOT in the verdict schema (rabbit hole #5).
 *    TODO(follow-up): add findingCategory to ReviewVerdictArtifactV1 and branch:
 *      - correctness/security Critical -> production-readiness-audit
 *      - architecture Critical -> architecture-scalability-audit
 *    For MVP: always dispatch production-readiness-audit (safe default).
 * 2. Re-review with mr-review-workflow-agentic
 * 3. If still Critical/blocking: post to Human Outbox, do NOT auto-merge
 */
export async function runAuditChain(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  prUrl: string,
  coordinatorStartMs: number,
  severity: 'blocking' | 'unknown',
): Promise<PipelineOutcome> {
  deps.stderr(`[audit-chain] ${severity.toUpperCase()} finding -- running audit chain`);

  const auditCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'audit');
  if (auditCutoff) return auditCutoff;

  // TODO(follow-up): branch on findingCategory when it's added to the verdict schema.
  // For MVP: always dispatch production-readiness-audit (safe default -- pitch rabbit hole #5).
  const auditWorkflow = 'production-readiness-audit';

  const auditSpawnResult = await deps.spawnSession(
    auditWorkflow,
    `Audit PR before merge: ${prUrl}`,
    opts.workspace,
    { prUrl, severity },
  );

  if (auditSpawnResult.kind === 'err') {
    await deps.postToOutbox(
      `Adaptive pipeline escalated: audit workflow failed to spawn`,
      { prUrl, phase: 'audit', reason: auditSpawnResult.error, severity },
    );
    return {
      kind: 'escalated',
      escalationReason: { phase: 'audit', reason: `audit spawn failed: ${auditSpawnResult.error}` },
    };
  }

  const auditHandle = auditSpawnResult.value;
  if (!auditHandle) {
    await deps.postToOutbox(
      `Adaptive pipeline escalated: audit returned empty handle`,
      { prUrl, phase: 'audit', severity },
    );
    return {
      kind: 'escalated',
      escalationReason: { phase: 'audit', reason: 'audit returned empty handle' },
    };
  }

  const auditAwait = await deps.awaitSessions([auditHandle], REVIEW_TIMEOUT_MS);
  const auditResult = auditAwait.results[0];

  if (!auditResult || auditResult.outcome !== 'success') {
    const outcome = auditResult?.outcome ?? 'not_found';
    await deps.postToOutbox(
      `Adaptive pipeline escalated: audit session ${outcome}`,
      { prUrl, phase: 'audit', auditOutcome: outcome, severity },
    );
    return {
      kind: 'escalated',
      escalationReason: { phase: 'audit', reason: `audit session ${outcome}` },
    };
  }

  deps.stderr(`[audit-chain] Audit complete -- re-reviewing PR`);

  // Re-review after audit
  const reReviewCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 're-review-after-audit');
  if (reReviewCutoff) return reReviewCutoff;

  const reReviewSpawnResult = await deps.spawnSession(
    'mr-review-workflow-agentic',
    `Re-review after audit: ${prUrl}`,
    opts.workspace,
    { prUrl, auditComplete: true },
  );

  if (reReviewSpawnResult.kind === 'err') {
    await deps.postToOutbox(
      `Adaptive pipeline escalated: re-review after audit failed to spawn`,
      { prUrl, phase: 're-review-after-audit', reason: reReviewSpawnResult.error },
    );
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 're-review-after-audit',
        reason: `re-review spawn failed: ${reReviewSpawnResult.error}`,
      },
    };
  }

  const reReviewHandle = reReviewSpawnResult.value;
  if (!reReviewHandle) {
    await deps.postToOutbox(
      `Adaptive pipeline escalated: re-review after audit returned empty handle`,
      { prUrl, phase: 're-review-after-audit' },
    );
    return {
      kind: 'escalated',
      escalationReason: { phase: 're-review-after-audit', reason: 're-review returned empty handle' },
    };
  }

  const reReviewAwait = await deps.awaitSessions([reReviewHandle], REVIEW_TIMEOUT_MS);
  const reReviewResult = reReviewAwait.results[0];

  if (!reReviewResult || reReviewResult.outcome !== 'success') {
    const outcome = reReviewResult?.outcome ?? 'not_found';
    await deps.postToOutbox(
      `Adaptive pipeline escalated: re-review after audit session ${outcome}`,
      { prUrl, phase: 're-review-after-audit', reReviewOutcome: outcome },
    );
    return {
      kind: 'escalated',
      escalationReason: { phase: 're-review-after-audit', reason: `re-review session ${outcome}` },
    };
  }

  const reAgentResult = await deps.getAgentResult(reReviewHandle);
  const reVerdictFromArtifact = readVerdictArtifact(reAgentResult.artifacts, reReviewHandle);
  const reFindingsResult = reVerdictFromArtifact !== null
    ? { kind: 'ok' as const, value: reVerdictFromArtifact }
    : parseFindingsFromNotes(reAgentResult.recapMarkdown);

  if (reFindingsResult.kind === 'err') {
    await deps.postToOutbox(
      `Adaptive pipeline escalated: re-review verdict unparseable after audit`,
      { prUrl, phase: 're-review-after-audit' },
    );
    return {
      kind: 'escalated',
      escalationReason: { phase: 're-review-after-audit', reason: `re-review verdict parse failed` },
    };
  }

  const reFindings = reFindingsResult.value;
  deps.stderr(`[audit-chain] Post-audit re-review verdict: ${reFindings.severity}`);

  if (reFindings.severity === 'clean' || reFindings.severity === 'minor') {
    deps.stderr(`[audit-chain] Post-audit verdict acceptable (${reFindings.severity}) -- merging`);
    return { kind: 'merged', prUrl };
  }

  // Still blocking/critical after audit: post to Human Outbox, do NOT auto-merge
  deps.stderr(`[audit-chain] Post-audit verdict still ${reFindings.severity} -- escalating to Human Outbox`);
  await deps.postToOutbox(
    `PR requires human review: still ${reFindings.severity} after production-readiness audit`,
    {
      prUrl,
      phase: 'audit-chain-complete',
      severity: reFindings.severity,
      findingSummaries: reFindings.findingSummaries,
      note: 'Do NOT auto-merge. Human review required.',
    },
  );

  return {
    kind: 'escalated',
    escalationReason: {
      phase: 'audit-chain',
      reason: `PR still ${reFindings.severity} after audit -- posted to Human Outbox, do NOT merge`,
    },
  };
}
