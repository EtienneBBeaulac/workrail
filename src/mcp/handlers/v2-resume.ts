/**
 * v2 Resume Session Handler
 *
 * Handles resume_session tool calls.
 * Enumerates existing sessions, ranks them against the current workspace context
 * (git branch, SHA, free text query), and returns the best candidates with
 * fresh state tokens.
 *
 * Read-only: does not modify any session state.
 *
 * @module mcp/handlers/v2-resume
 */

import type { z } from 'zod';
import type { V2ResumeSessionInput } from '../v2/tools.js';
import type { ToolContext, ToolResult } from '../types.js';
import { errNotRetryable } from '../types.js';
import { V2ResumeSessionOutputSchema } from '../output-schemas.js';
import { signTokenOrErr } from './v2-token-ops.js';
import type { ResumeQuery } from '../../v2/projections/resume-ranking.js';
import type { WorkspaceAnchor } from '../../v2/ports/workspace-anchor.port.js';
import { asRunId, asNodeId, asWorkflowHashRef } from '../../v2/durable-core/ids/index.js';
import { resumeSession } from '../../v2/usecases/resume-session.js';

type ResumeInput = z.infer<typeof V2ResumeSessionInput>;
type ResumeOutput = z.infer<typeof V2ResumeSessionOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a value from workspace anchors by key. */
function anchorValue(anchors: readonly WorkspaceAnchor[], key: WorkspaceAnchor['key']): string | undefined {
  const anchor = anchors.find((a) => a.key === key);
  return anchor?.value;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle resume_session tool call.
 *
 * Flow:
 * 1. Resolve workspace anchors (or use input overrides)
 * 2. Enumerate + load + rank sessions via SessionSummaryProvider
 * 3. Mint fresh stateToken per candidate
 * 4. Return bounded response (max 5 candidates)
 */
export async function handleV2ResumeSession(
  input: ResumeInput,
  ctx: ToolContext,
): Promise<ToolResult<ResumeOutput>> {
  const v2 = ctx.v2;
  if (!v2) {
    return errNotRetryable('INTERNAL_ERROR', 'v2 dependencies not available');
  }

  // Check required ports for resume
  if (!v2.sessionSummaryProvider) {
    return errNotRetryable('INTERNAL_ERROR', 'resume_session requires sessionSummaryProvider port');
  }

  // Resolve workspace anchors (graceful: empty on failure)
  let anchors: readonly WorkspaceAnchor[] = [];
  if (v2.workspaceAnchor) {
    const anchorRes = await v2.workspaceAnchor.resolveAnchors();
    if (anchorRes.isOk()) {
      anchors = anchorRes.value;
    }
  }

  // Build resume query from input overrides + workspace anchors
  const query: ResumeQuery = {
    gitHeadSha: input.gitHeadSha ?? anchorValue(anchors, 'git_head_sha'),
    gitBranch: input.gitBranch ?? anchorValue(anchors, 'git_branch'),
    freeTextQuery: input.query,
  };

  // Run resume
  const resumeResult = await resumeSession(query, v2.sessionSummaryProvider);

  if (resumeResult.isErr()) {
    return errNotRetryable('INTERNAL_ERROR', `Resume failed: ${resumeResult.error.message}`);
  }

  const candidates = resumeResult.value;

  // Mint fresh stateTokens for each candidate
  const outputCandidates: Array<{
    sessionId: string;
    runId: string;
    stateToken: string;
    snippet: string;
    whyMatched: string[];
  }> = [];

  for (const candidate of candidates) {
    // Mint stateToken pointing at the preferred tip node
    const stateTokenRes = signTokenOrErr({
      payload: {
        tokenVersion: 1 as const,
        tokenKind: 'state' as const,
        sessionId: candidate.sessionId,
        runId: asRunId(candidate.runId),
        nodeId: asNodeId(candidate.preferredTipNodeId),
        workflowHashRef: asWorkflowHashRef(''), // Resolved on continue_workflow
      },
      ports: v2.tokenCodecPorts,
    });

    if (stateTokenRes.isErr()) {
      // Skip candidate if token minting fails (graceful degradation)
      continue;
    }

    outputCandidates.push({
      sessionId: candidate.sessionId,
      runId: candidate.runId,
      stateToken: stateTokenRes.value,
      snippet: candidate.snippet,
      whyMatched: [...candidate.whyMatched],
    });
  }

  const output = V2ResumeSessionOutputSchema.parse({
    candidates: outputCandidates,
    totalEligible: candidates.length,
  });

  return {
    type: 'success' as const,
    data: output,
  };
}
