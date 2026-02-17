import type { ToolContext, ToolResult } from '../../types.js';
import { error, success } from '../../types.js';
import type { V2ContinueWorkflowInput, V2StartWorkflowInput } from '../../v2/tools.js';
import { V2ContinueWorkflowOutputSchema } from '../../output-schemas.js';
import {
  assertTokenScopeMatchesStateBinary,
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
  mapTokenDecodeErrorToToolError,
  type ContinueWorkflowError,
} from '../v2-execution-helpers.js';
import * as z from 'zod';
import { parseStateTokenOrFail, parseAckTokenOrFail } from '../v2-token-ops.js';
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
  readonly params: {
    readonly intent: 'advance';
    readonly stateToken: string;
    readonly ackToken: string;
  };
};

export function buildNextCall(args: {
  readonly stateToken: string;
  readonly ackToken: string | undefined;
  readonly isComplete: boolean;
  readonly pending: { readonly stepId: string } | null;
  readonly retryable?: boolean;
  readonly retryAckToken?: string;
}): NextCallTemplate | null {
  // Workflow complete, nothing to call
  if (args.isComplete && !args.pending) return null;

  // Blocked retryable: use retryAckToken so agent retries with corrected output
  if (args.retryable && args.retryAckToken) {
    return {
      tool: 'continue_workflow',
      params: { intent: 'advance', stateToken: args.stateToken, ackToken: args.retryAckToken },
    };
  }

  // Blocked non-retryable: agent can't proceed without user intervention
  if (!args.ackToken) return null;

  // Normal: advance with the ackToken from this response
  return {
    tool: 'continue_workflow',
    params: { intent: 'advance', stateToken: args.stateToken, ackToken: args.ackToken },
  };
}

export async function handleV2StartWorkflow(
  input: V2StartWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  return executeStartWorkflow(input, ctx).match(
    (payload) => success(payload),
    (e) => mapStartWorkflowErrorToToolError(e)
  );
}

export async function handleV2ContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  return executeContinueWorkflow(input, ctx).match(
    (payload) => success(payload),
    (e) => mapContinueWorkflowErrorToToolError(e)
  );
}

function executeContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: ToolContext
): RA<z.infer<typeof V2ContinueWorkflowOutputSchema>, ContinueWorkflowError> {
  // Preconditions: validate context and dependencies
  if (!ctx.v2) {
    return neErrorAsync({ kind: 'precondition_failed', message: 'v2 tools disabled', suggestion: 'Enable v2Tools flag' });
  }

  const { gate, sessionStore, snapshotStore, pinnedStore, sha256, tokenCodecPorts, idFactory } = ctx.v2;
  if (!sha256 || !idFactory) {
    return neErrorAsync({
      kind: 'precondition_failed',
      message: 'v2 context missing required dependencies',
      suggestion: 'Reinitialize v2 tool context (sha256 and idFactory must be provided when v2Tools are enabled).',
    });
  }
  if (!tokenCodecPorts) {
    return neErrorAsync({
      kind: 'precondition_failed',
      message: 'v2 context missing tokenCodecPorts dependency',
      suggestion: 'Reinitialize v2 tool context (tokenCodecPorts must be provided when v2Tools are enabled).',
    });
  }

  // Parse and validate state token
  const stateRes = parseStateTokenOrFail(input.stateToken, tokenCodecPorts);
  if (!stateRes.ok) return neErrorAsync({ kind: 'validation_failed', failure: stateRes.failure });
  const state = stateRes.token;

  // Check context budget
  const ctxCheck = checkContextBudget({ tool: 'continue_workflow', context: input.context });
  if (!ctxCheck.ok) return neErrorAsync({ kind: 'validation_failed', failure: ctxCheck.error });

  const sessionId = asSessionId(state.payload.sessionId);
  const runId = asRunId(state.payload.runId);
  const nodeId = asNodeId(state.payload.nodeId);
  const workflowHashRef = state.payload.workflowHashRef;

  // Route based on intent: rehydrate (side-effect-free) or advance (state mutation)
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
      }));
  }

  // Advance path: validate ackToken and route to advance handler
  if (!input.ackToken) {
    return neErrorAsync({ kind: 'validation_failed', failure: error('VALIDATION_ERROR', 'ackToken is required for advance intent') });
  }
  const ackRes = parseAckTokenOrFail(input.ackToken, tokenCodecPorts);
  if (!ackRes.ok) return neErrorAsync({ kind: 'validation_failed', failure: ackRes.failure });
  const ack = ackRes.token;

  const scopeRes = assertTokenScopeMatchesStateBinary(state, ack);
  if (scopeRes.isErr()) return neErrorAsync({ kind: 'validation_failed', failure: mapTokenDecodeErrorToToolError(scopeRes.error) });

  const attemptId = asAttemptId(ack.payload.attemptId);

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
    }));
}
