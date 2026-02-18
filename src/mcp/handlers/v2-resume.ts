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
import type { ResumeQuery, RankedResumeCandidate } from '../../v2/projections/resume-ranking.js';
import type { WorkspaceAnchor } from '../../v2/ports/workspace-anchor.port.js';
import { asRunId, asNodeId, deriveWorkflowHashRef } from '../../v2/durable-core/ids/index.js';
import type { TokenCodecPorts } from '../../v2/durable-core/tokens/index.js';
import { resumeSession } from '../../v2/usecases/resume-session.js';
import { resolveWorkspaceAnchors } from './v2-workspace-resolution.js';

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

  // Resolve workspace anchors (graceful: empty on failure).
  // Priority: explicit workspacePath input > MCP roots URI > server process CWD.
  const anchorsResult = await resolveWorkspaceAnchors(v2, input.workspacePath);
  const anchors: readonly WorkspaceAnchor[] = anchorsResult.isOk() ? anchorsResult.value : [];

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

  // Mint fresh stateTokens for each candidate.
  // workflowHash is guaranteed non-null by HealthySessionSummary (validated at boundary).
  const { outputCandidates, skipped } = mintCandidateTokens(candidates, v2.tokenCodecPorts);

  if (skipped > 0) {
    console.error(`[workrail:resume] ${skipped}/${candidates.length} candidate(s) skipped: token minting failed (workflowHashRef derivation or signing error)`);
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

// ---------------------------------------------------------------------------
// Token minting — pure, no I/O
// ---------------------------------------------------------------------------

interface MintedCandidate {
  readonly sessionId: string;
  readonly runId: string;
  readonly stateToken: string;
  readonly snippet: string;
  readonly whyMatched: string[];
}

/**
 * Mint stateTokens for ranked candidates.
 *
 * Why separate function: isolates the token-minting concern from the handler
 * orchestration. Pure (no I/O), testable independently.
 *
 * workflowHash is branded WorkflowHash (non-nullable) — guaranteed by
 * HealthySessionSummary construction. No defensive null checks needed here.
 */
function mintCandidateTokens(
  candidates: readonly RankedResumeCandidate[],
  ports: TokenCodecPorts,
): { readonly outputCandidates: readonly MintedCandidate[]; readonly skipped: number } {
  const outputCandidates: MintedCandidate[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const wfRefRes = deriveWorkflowHashRef(candidate.workflowHash);
    if (wfRefRes.isErr()) {
      skipped++;
      continue;
    }

    const stateTokenRes = signTokenOrErr({
      payload: {
        tokenVersion: 1 as const,
        tokenKind: 'state' as const,
        sessionId: candidate.sessionId,
        runId: asRunId(candidate.runId),
        nodeId: asNodeId(candidate.preferredTipNodeId),
        workflowHashRef: wfRefRes.value,
      },
      ports,
    });

    if (stateTokenRes.isErr()) {
      skipped++;
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

  return { outputCandidates, skipped };
}
