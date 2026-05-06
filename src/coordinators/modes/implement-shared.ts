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
import type { CoordinatorSpawnContext } from '../pr-review.js';
import type { ReviewVerdictArtifactV1 } from '../../v2/durable-core/schemas/artifacts/review-verdict.js';
import { parseReviewVerdictArtifact } from '../../v2/durable-core/schemas/artifacts/review-verdict.js';
import type { PhaseHandoffArtifact } from '../../v2/durable-core/schemas/artifacts/index.js';
import { buildContextSummary } from '../context-assembly.js';

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
  runId = '',
  priorArtifacts: readonly PhaseHandoffArtifact[] = [],
): Promise<PipelineOutcome> {
  const cutoffCheck = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'review');
  if (cutoffCheck) return cutoffCheck;

  const reviewGoal = iteration === 0
    ? `Review PR for merge: ${prUrl}`
    : `Re-review PR after fixes (iteration ${iteration}): ${prUrl}`;

  deps.stderr(`[review-cycle] Spawning review session (iteration=${iteration}): ${reviewGoal.slice(0, 80)}`);

  const reviewContextSummary = buildContextSummary(priorArtifacts, 'review');
  const reviewContext: CoordinatorSpawnContext | undefined = reviewContextSummary
    ? { prUrl, assembledContextSummary: reviewContextSummary }
    : undefined;
  const reviewSpawnResult = await deps.spawnSession(
    'wr.mr-review',
    reviewGoal,
    opts.workspace,
    reviewContext,
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

  let agentResult: Awaited<ReturnType<typeof deps.getAgentResult>>;
  try {
    agentResult = await deps.getAgentResult(reviewHandle);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`[coordinator] getAgentResult failed: ${msg}`);
    return {
      kind: 'escalated',
      escalationReason: { phase: 'review', reason: `getAgentResult threw: ${msg}` },
    };
  }
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

  // Parse the raw verdict artifact to extract findingCategory for audit chain routing.
  // Done here (not in readVerdictArtifact) to avoid widening the ReviewFindings interface.
  const rawVerdict: ReviewVerdictArtifactV1 | null = agentResult.artifacts.reduce<ReviewVerdictArtifactV1 | null>(
    (acc, a) => acc ?? parseReviewVerdictArtifact(a),
    null,
  );

  switch (findings.severity) {
    case 'clean':
      deps.stderr(`[review-cycle] Verdict clean -- merging PR`);
      return { kind: 'merged', prUrl };

    case 'minor': {
      if (iteration >= MAX_FIX_ITERATIONS) {
        deps.stderr(`[review-cycle] ${MAX_FIX_ITERATIONS} fix iterations exhausted -- escalating`);
        try {
          await deps.postToOutbox(
            `Adaptive pipeline escalated: fix loop exhausted after ${MAX_FIX_ITERATIONS} iterations`,
            { prUrl, phase: 'fix-loop', reason: 'max iterations reached', findingSummaries: findings.findingSummaries },
          );
        } catch (e) {
          // postToOutbox write failure is non-fatal -- escalation still returns below
          deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return {
          kind: 'escalated',
          escalationReason: { phase: 'fix-loop', reason: `${MAX_FIX_ITERATIONS} fix iterations exhausted` },
        };
      }

      deps.stderr(`[review-cycle] Verdict minor -- running fix iteration ${iteration + 1}/${MAX_FIX_ITERATIONS}`);

      const fixCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'fix-agent');
      if (fixCutoff) return fixCutoff;

      const fixGoal = `Fix review findings: ${findings.findingSummaries.slice(0, 3).join('; ')}`;
      const fixContextSummary = buildContextSummary(priorArtifacts, 'fix');
      const fixContext: CoordinatorSpawnContext | undefined = fixContextSummary
        ? { prUrl, findings: findings.findingSummaries, assembledContextSummary: fixContextSummary }
        : undefined;
      const fixSpawnResult = await deps.spawnSession(
        'wr.coding-task',
        fixGoal,
        opts.workspace,
        fixContext,
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
      return runReviewAndVerdictCycle(deps, opts, prUrl, coordinatorStartMs, iteration + 1, runId, priorArtifacts);
    }

    case 'blocking':
    case 'unknown': {
      return runAuditChain(deps, opts, prUrl, coordinatorStartMs, findings.severity, rawVerdict?.findings, priorArtifacts);
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
 * 1. Dispatch audit workflow -- routes based on findingCategory when available:
 *      - architecture findings -> wr.architecture-scalability-audit
 *      - all others (correctness, security, ux, performance, testing, style, or unknown) -> wr.production-readiness-audit
 * 2. Re-review with wr.mr-review
 * 3. If still Critical/blocking: post to Human Outbox, do NOT auto-merge
 *
 * @param findings - Raw findings from the verdict artifact, if available.
 *   Used to select the audit workflow. Absent on the keyword-scan path (safe default applies).
 */
export async function runAuditChain(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  prUrl: string,
  coordinatorStartMs: number,
  severity: 'blocking' | 'unknown',
  findings?: ReviewVerdictArtifactV1['findings'],
  priorArtifacts: readonly PhaseHandoffArtifact[] = [],
): Promise<PipelineOutcome> {
  deps.stderr(`[audit-chain] ${severity.toUpperCase()} finding -- running audit chain`);

  const auditCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'audit');
  if (auditCutoff) return auditCutoff;

  // Route to the appropriate audit workflow based on findingCategory.
  // Architecture findings dispatch wr.architecture-scalability-audit; all others use wr.production-readiness-audit.
  // When findings is absent (keyword-scan path), safe default wr.production-readiness-audit applies.
  const auditWorkflow = findings?.some((f) => f.findingCategory === 'architecture')
    ? 'wr.architecture-scalability-audit'
    : 'wr.production-readiness-audit';

  const auditSpawnResult = await deps.spawnSession(
    auditWorkflow,
    `Audit PR before merge: ${prUrl}`,
    opts.workspace,
    { prUrl, severity },
  );

  if (auditSpawnResult.kind === 'err') {
    try {
      await deps.postToOutbox(
        `Adaptive pipeline escalated: audit workflow failed to spawn`,
        { prUrl, phase: 'audit', reason: auditSpawnResult.error, severity },
      );
    } catch (e) {
      // postToOutbox write failure is non-fatal -- escalation still returns below
      deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      kind: 'escalated',
      escalationReason: { phase: 'audit', reason: `audit spawn failed: ${auditSpawnResult.error}` },
    };
  }

  const auditHandle = auditSpawnResult.value;
  if (!auditHandle) {
    try {
      await deps.postToOutbox(
        `Adaptive pipeline escalated: audit returned empty handle`,
        { prUrl, phase: 'audit', severity },
      );
    } catch (e) {
      // postToOutbox write failure is non-fatal -- escalation still returns below
      deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      kind: 'escalated',
      escalationReason: { phase: 'audit', reason: 'audit returned empty handle' },
    };
  }

  const auditAwait = await deps.awaitSessions([auditHandle], REVIEW_TIMEOUT_MS);
  const auditResult = auditAwait.results[0];

  if (!auditResult || auditResult.outcome !== 'success') {
    const outcome = auditResult?.outcome ?? 'not_found';
    try {
      await deps.postToOutbox(
        `Adaptive pipeline escalated: audit session ${outcome}`,
        { prUrl, phase: 'audit', auditOutcome: outcome, severity },
      );
    } catch (e) {
      // postToOutbox write failure is non-fatal -- escalation still returns below
      deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
    'wr.mr-review',
    `Re-review after audit: ${prUrl}`,
    opts.workspace,
    { prUrl, auditComplete: true },
  );

  if (reReviewSpawnResult.kind === 'err') {
    try {
      await deps.postToOutbox(
        `Adaptive pipeline escalated: re-review after audit failed to spawn`,
        { prUrl, phase: 're-review-after-audit', reason: reReviewSpawnResult.error },
      );
    } catch (e) {
      // postToOutbox write failure is non-fatal -- escalation still returns below
      deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
    try {
      await deps.postToOutbox(
        `Adaptive pipeline escalated: re-review after audit returned empty handle`,
        { prUrl, phase: 're-review-after-audit' },
      );
    } catch (e) {
      // postToOutbox write failure is non-fatal -- escalation still returns below
      deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      kind: 'escalated',
      escalationReason: { phase: 're-review-after-audit', reason: 're-review returned empty handle' },
    };
  }

  const reReviewAwait = await deps.awaitSessions([reReviewHandle], REVIEW_TIMEOUT_MS);
  const reReviewResult = reReviewAwait.results[0];

  if (!reReviewResult || reReviewResult.outcome !== 'success') {
    const outcome = reReviewResult?.outcome ?? 'not_found';
    try {
      await deps.postToOutbox(
        `Adaptive pipeline escalated: re-review after audit session ${outcome}`,
        { prUrl, phase: 're-review-after-audit', reReviewOutcome: outcome },
      );
    } catch (e) {
      // postToOutbox write failure is non-fatal -- escalation still returns below
      deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {
      kind: 'escalated',
      escalationReason: { phase: 're-review-after-audit', reason: `re-review session ${outcome}` },
    };
  }

  let reAgentResult: Awaited<ReturnType<typeof deps.getAgentResult>>;
  try {
    reAgentResult = await deps.getAgentResult(reReviewHandle);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`[coordinator] getAgentResult failed: ${msg}`);
    return {
      kind: 'escalated',
      escalationReason: { phase: 'review', reason: `getAgentResult threw: ${msg}` },
    };
  }
  const reVerdictFromArtifact = readVerdictArtifact(reAgentResult.artifacts, reReviewHandle);
  const reFindingsResult = reVerdictFromArtifact !== null
    ? { kind: 'ok' as const, value: reVerdictFromArtifact }
    : parseFindingsFromNotes(reAgentResult.recapMarkdown);

  if (reFindingsResult.kind === 'err') {
    try {
      await deps.postToOutbox(
        `Adaptive pipeline escalated: re-review verdict unparseable after audit`,
        { prUrl, phase: 're-review-after-audit' },
      );
    } catch (e) {
      // postToOutbox write failure is non-fatal -- escalation still returns below
      deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
  try {
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
  } catch (e) {
    // postToOutbox write failure is non-fatal -- escalation still returns below
    deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    kind: 'escalated',
    escalationReason: {
      phase: 'audit-chain',
      reason: `PR still ${reFindings.severity} after audit -- posted to Human Outbox, do NOT merge`,
    },
  };
}
