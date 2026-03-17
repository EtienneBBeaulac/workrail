import type { ToolContext, ToolResult, V2ToolContext } from '../../types.js';
import { success, requireV2Context } from '../../types.js';
import type { V2ContinueWorkflowInput, V2StartWorkflowInput } from '../../v2/tools.js';
import { V2ContinueWorkflowOutputSchema } from '../../output-schemas.js';
import {
  asAttemptId,
} from '../../../v2/durable-core/tokens/index.js';
import {
  asSessionId,
  asRunId,
  asNodeId,
} from '../../../v2/durable-core/ids/index.js';
import { ResultAsync as RA, errAsync as neErrorAsync } from 'neverthrow';
import {
  mapStartWorkflowErrorToToolError,
  mapContinueWorkflowErrorToToolError,
  type ContinueWorkflowError,
} from '../v2-execution-helpers.js';
import * as z from 'zod';
import { parseContinueTokenOrFail } from '../v2-token-ops.js';
import { checkContextBudget } from '../v2-context-budget.js';
import { executeStartWorkflow } from './start.js';
import { handleRehydrateIntent } from './continue-rehydrate.js';
import { handleAdvanceIntent } from './continue-advance.js';

/**
 * v2 Slice 3: token orchestration (`start_workflow` / `continue_workflow`).
 *
 * Locks (see `docs/design/v2-core-design-locks.md`):
 * - Token validation errors use the closed `TOKEN_*` set.
 * - Rehydrate is side-effect-free.
 * - Advance is idempotent and append-capable only under a witness.
 * - Replay is fact-returning (no recompute) and fail-closed on missing recorded facts.
 */

// ── nextCall builder ─────────────────────────────────────────────────
// Pure function: derives the pre-built continuation template from response values.
// Tells the agent exactly what to call when done — no memory of tool descriptions needed.

type NextCallTemplate = {
  readonly tool: 'continue_workflow';
  readonly params: { readonly continueToken: string };
};

export function buildNextCall(args: {
  readonly continueToken?: string;
  readonly isComplete: boolean;
  readonly pending: { readonly stepId: string } | null;
  readonly retryContinueToken?: string;
}): NextCallTemplate | null {
  if (args.isComplete && !args.pending) return null;

  // Blocked retryable: use retry continue token
  if (args.retryContinueToken) {
    return { tool: 'continue_workflow', params: { continueToken: args.retryContinueToken } };
  }

  if (args.continueToken) {
    return { tool: 'continue_workflow', params: { continueToken: args.continueToken } };
  }

  return null;
}

export async function handleV2StartWorkflow(
  input: V2StartWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  const guard = requireV2Context(ctx);
  if (!guard.ok) return guard.error;

  return executeStartWorkflow(input, guard.ctx).match(
    (payload) => success(payload),
    (e) => mapStartWorkflowErrorToToolError(e)
  );
}

export async function handleV2ContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  const guard = requireV2Context(ctx);
  if (!guard.ok) return guard.error;

  return executeContinueWorkflow(input, guard.ctx).match(
    (payload) => success(payload),
    (e) => mapContinueWorkflowErrorToToolError(e)
  );
}

export function executeContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: V2ToolContext
): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  const { gate, sessionStore, snapshotStore, pinnedStore, sha256, tokenCodecPorts, idFactory, tokenAliasStore, entropy } = ctx.v2;

  // Check context budget (synchronous, early guard)
  const ctxCheck = checkContextBudget({ tool: 'continue_workflow', context: input.context });
  if (!ctxCheck.ok) return neErrorAsync({ kind: 'validation_failed', failure: ctxCheck.error });

  return parseContinueTokenOrFail(input.continueToken, tokenCodecPorts, tokenAliasStore)
    .mapErr((failure) => ({ kind: 'validation_failed' as const, failure }))
    .andThen((resolved) => {
      const sessionId = asSessionId(resolved.sessionId);
      const runId = asRunId(resolved.runId);
      const nodeId = asNodeId(resolved.nodeId);
      const workflowHashRef = resolved.workflowHashRef;

      if (input.intent === 'rehydrate') {
        return sessionStore.load(sessionId)
          .mapErr((cause) => ({ kind: 'session_load_failed' as const, cause }))
          .andThen((truth) => handleRehydrateIntent({
            input,
            sessionId,
            runId,
            nodeId,
            workflowHashRef,
            truth,
            tokenCodecPorts,
            pinnedStore,
            snapshotStore,
            idFactory,
            aliasStore: tokenAliasStore,
            entropy,
          }));
      }

      const attemptId = asAttemptId(resolved.attemptId);

      return sessionStore.load(sessionId)
        .mapErr((cause) => ({ kind: 'session_load_failed' as const, cause }))
        .andThen((truth) => handleAdvanceIntent({
          input,
          sessionId,
          runId,
          nodeId,
          attemptId,
          workflowHashRef,
          truth,
          gate,
          sessionStore,
          snapshotStore,
          pinnedStore,
          tokenCodecPorts,
          idFactory,
          sha256,
          aliasStore: tokenAliasStore,
          entropy,
        }));
    });
}
