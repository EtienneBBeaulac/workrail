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
  type SessionId,
  type RunId,
  type NodeId,
} from '../../../v2/durable-core/ids/index.js';
import { ResultAsync as RA, errAsync as neErrorAsync } from 'neverthrow';
import {
  mapStartWorkflowErrorToToolError,
  mapContinueWorkflowErrorToToolError,
  type ContinueWorkflowError,
} from '../v2-execution-helpers.js';
import * as z from 'zod';
import { parseContinueTokenOrFail, parseStateTokenOrFail } from '../v2-token-ops.js';
import { errNotRetryable } from '../../types.js';
import { checkContextBudget } from '../v2-context-budget.js';
import { executeStartWorkflow } from './start.js';
import { handleRehydrateIntent, type RehydrateResult } from './continue-rehydrate.js';
import { handleAdvanceIntent } from './continue-advance.js';
import { attachV2ExecutionRenderMetadata } from '../../render-envelope.js';
import type { StepContentEnvelope } from '../../step-content-envelope.js';
import { rememberExplicitWorkspaceRoot } from '../shared/remembered-roots.js';

/** Unified result for continue_workflow — envelope present on rehydrate with pending step. */
interface ContinueWorkflowResult {
  readonly response: z.infer<typeof V2ContinueWorkflowOutputSchema>;
  readonly contentEnvelope?: StepContentEnvelope;
}

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
  const rememberedRootFailure = await rememberExplicitWorkspaceRoot(input.workspacePath, guard.ctx.v2.rememberedRootsStore);
  if (rememberedRootFailure) return rememberedRootFailure;

  return executeStartWorkflow(input, guard.ctx).match(
    (result) => success(attachV2ExecutionRenderMetadata({
      response: result.response,
      lifecycle: 'start',
      contentEnvelope: result.contentEnvelope,
    })),
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
    (result) => success(attachV2ExecutionRenderMetadata({
      response: result.response,
      lifecycle: input.intent === 'rehydrate' ? 'rehydrate' : 'advance',
      contentEnvelope: result.contentEnvelope,
    })),
    (e) => mapContinueWorkflowErrorToToolError(e)
  );
}

// ── Token kind routing ────────────────────────────────────────────────────
// Isolates prefix-matching behind a typed ADT so the main dispatch is
// exhaustive over token kinds — no raw string comparisons leak downstream.

type TokenRouting =
  | { readonly kind: 'state'; readonly raw: string }
  | { readonly kind: 'continue'; readonly raw: string };

function classifyToken(raw: string): TokenRouting {
  if (raw.startsWith('st_') || raw.startsWith('st1')) return { kind: 'state', raw };
  return { kind: 'continue', raw };
}

// ── Shared rehydrate dispatch ─────────────────────────────────────────────
// Both token paths converge here when intent is rehydrate.
// A single place prevents the two callers from silently diverging.

type RehydrateArgs = {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly workflowHashRef: string;
  readonly input: V2ContinueWorkflowInput;
  readonly ctx: V2ToolContext;
};

function loadAndRehydrate(
  args: RehydrateArgs,
): RA<RehydrateResult, ContinueWorkflowError> {
  const { sessionId, runId, nodeId, workflowHashRef, input } = args;
  const { sessionStore, tokenCodecPorts, pinnedStore, snapshotStore, idFactory, tokenAliasStore, entropy } = args.ctx.v2;

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
      resolvedRootUris: args.ctx.v2.resolvedRootUris,
      cleanResponseFormat: args.ctx.featureFlags?.isEnabled('cleanResponseFormat') ?? false,
    }));
}

// ── Main handler ─────────────────────────────────────────────────────────

export function executeContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: V2ToolContext
): RA<ContinueWorkflowResult, ContinueWorkflowError> {
  const { gate, sessionStore, snapshotStore, pinnedStore, sha256, tokenCodecPorts, idFactory, tokenAliasStore, entropy } = ctx.v2;

  // Check context budget (synchronous, early guard)
  const ctxCheck = checkContextBudget({ tool: 'continue_workflow', context: input.context });
  if (!ctxCheck.ok) return neErrorAsync({ kind: 'validation_failed', failure: ctxCheck.error });

  const routing = classifyToken(input.continueToken);

  switch (routing.kind) {
    case 'state': {
      // State tokens (st_/st1) from resume_session carry no advance authority —
      // they scope to rehydration only. Reject advance explicitly so the error is actionable.
      // Two sub-cases with different root causes and suggestions:
      //   (a) output was provided → transform auto-inferred intent: 'advance' (agent should remove output)
      //   (b) intent: 'advance' was explicit → agent should use 'rehydrate' instead
      if (input.intent === 'advance') {
        const hasOutput = input.output != null;
        const message = hasOutput
          ? 'A resumeToken cannot carry output — resumeTokens are read-only. Remove the output field and call continue_workflow with just the resumeToken to rehydrate session context.'
          : 'A resumeToken (st_... / st1...) carries no advance authority. Use intent: "rehydrate" to restore session context.';
        const suggestion = hasOutput
          ? 'Remove the output field. Pass just { continueToken: "<resumeToken>", intent: "rehydrate" } to rehydrate, then use the returned continueToken to advance.'
          : 'Pass intent: "rehydrate" when using the resumeToken from resume_session or checkpoint_workflow.';
        return neErrorAsync({
          kind: 'validation_failed',
          failure: errNotRetryable('TOKEN_SCOPE_MISMATCH', message, { suggestion }),
        });
      }

      return parseStateTokenOrFail(routing.raw, tokenCodecPorts, tokenAliasStore)
        .mapErr((failure) => ({ kind: 'validation_failed' as const, failure }))
        .andThen((resolved) => loadAndRehydrate({
          sessionId: asSessionId(resolved.payload.sessionId),
          runId: asRunId(resolved.payload.runId),
          nodeId: asNodeId(resolved.payload.nodeId),
          workflowHashRef: resolved.payload.workflowHashRef,
          input,
          ctx,
        }));
    }

    case 'continue': {
      return parseContinueTokenOrFail(routing.raw, tokenCodecPorts, tokenAliasStore)
        .mapErr((failure) => ({ kind: 'validation_failed' as const, failure }))
        .andThen((resolved) => {
          const sessionId = asSessionId(resolved.sessionId);
          const runId = asRunId(resolved.runId);
          const nodeId = asNodeId(resolved.nodeId);
          const workflowHashRef = resolved.workflowHashRef;

          if (input.intent === 'rehydrate') {
            return loadAndRehydrate({ sessionId, runId, nodeId, workflowHashRef, input, ctx });
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
              cleanResponseFormat: ctx.featureFlags?.isEnabled('cleanResponseFormat') ?? false,
            }))
            .map((response) => ({ response }));
        });
    }
  }
}
