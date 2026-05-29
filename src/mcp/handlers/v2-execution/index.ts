import type { ToolContext, ToolResult, V2ToolContext } from '../../types.js';
import { success, requireV2Context } from '../../types.js';
import { NullGitSnapshotV2 } from '../../../v2/ports/git-snapshot.port.js';
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
import { ResultAsync as RA, errAsync as neErrorAsync, okAsync } from 'neverthrow';
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
import { collect } from '../../client-usage/index.js';
import { claudeCodeUsageReader } from '../../client-usage/claude-code.js';
import { EVENT_KIND } from '../../../v2/durable-core/constants.js';
import { buildSessionIndex } from '../../../v2/durable-core/session-index.js';
import { asSortedEventLog } from '../../../v2/durable-core/sorted-event-log.js';

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

  return executeStartWorkflow(input, guard.ctx, { triggerSource: 'mcp' }).match(
    (result) => {
      // Fire-and-forget: snapshot conversation tokens at workflow start.
      void recordTokenCheckpoint(
        result.sessionId, 'start', input.workspacePath,
        guard.ctx.v2.sessionStore, guard.ctx.v2.gate, guard.ctx.v2.idFactory,
      );
      return success(attachV2ExecutionRenderMetadata({
        response: result.response,
        lifecycle: 'start',
        contentEnvelope: result.contentEnvelope,
      }));
    },
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

// ── Token checkpoint (fire-and-forget) ───────────────────────────────────

/**
 * Snapshot the current conversation's cumulative token usage and write a
 * token_checkpoint event to the session store.
 *
 * Called fire-and-forget at workflow start (phase='start') and completion (phase='end').
 * Must never throw or reject -- all errors are caught and logged.
 *
 * WHY at both boundaries: the delta between end and start gives tokens consumed
 * by this specific workflow run, isolated from prior conversation turns.
 *
 * WHY sessionId optional at start: the session has just been created and has not
 * appeared in any tool call yet, so JSONL verification would always fail. At end
 * time, the session ID has been used in tool calls and verification is meaningful.
 */
async function recordTokenCheckpoint(
  sessionId: SessionId,
  phase: 'start' | 'end',
  /** Workspace path known at call time (start phase). When undefined, re-read from session events. */
  workspacePathHint: string | undefined,
  sessionStore: V2ToolContext['v2']['sessionStore'],
  gate: V2ToolContext['v2']['gate'],
  idFactory: V2ToolContext['v2']['idFactory'],
): Promise<void> {
  try {
    // Re-read session events to get workspacePath and runId.
    const loadResult = await sessionStore.load(sessionId);
    if (loadResult.isErr()) return;
    const events = loadResult.value.events;

    let workspacePath: string | null = workspacePathHint ?? null;
    let runId: string | null = null;

    for (const e of events) {
      if (!workspacePath && e.kind === 'observation_recorded' && e.data.key === 'repo_root') {
        workspacePath = e.data.value.value;
      }
      if (!runId && e.kind === EVENT_KIND.RUN_STARTED) {
        runId = e.scope.runId;
      }
      if (workspacePath && runId) break;
    }

    if (!workspacePath || !runId) return;

    const verifyId = phase === 'end' ? String(sessionId) : undefined;
    const snapshot = await claudeCodeUsageReader.snapshotCurrentConversation(workspacePath, verifyId);
    if (!snapshot) return;

    await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.load(sessionId).andThen((truth) => {
        const sortedResult = asSortedEventLog(truth.events);
        if (sortedResult.isErr()) return okAsync(undefined as void);
        const index = buildSessionIndex(sortedResult.value);

        const event = {
          v: 1 as const,
          eventId: idFactory.mintEventId(),
          eventIndex: index.nextEventIndex,
          sessionId: String(sessionId),
          kind: EVENT_KIND.TOKEN_CHECKPOINT,
          dedupeKey: `token-checkpoint:${String(sessionId)}:${phase}`,
          scope: { runId },
          data: {
            phase,
            inputTokens: snapshot.inputTokens,
            outputTokens: snapshot.outputTokens,
            cacheReadTokens: snapshot.cacheReadTokens,
            cacheWriteTokens: snapshot.cacheWriteTokens,
            turns: snapshot.turns,
          },
          timestampMs: Date.now(),
        };

        return sessionStore.append(lock, { events: [event], snapshotPins: [] }, truth);
      })
    ).match(
      () => { /* success */ },
      (err) => {
        console.warn(`[workrail:checkpoint] Could not write token_checkpoint(${phase}) for ${String(sessionId)}: ${JSON.stringify(err)}`);
      }
    );
  } catch (err: unknown) {
    console.warn(`[workrail:checkpoint] Unexpected error writing token_checkpoint(${phase}) for ${String(sessionId)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Usage collection (fire-and-forget) ───────────────────────────────────

/**
 * Collect MCP client token usage and write usage_recorded events to the session store.
 *
 * Called fire-and-forget after a session completes (isComplete === true).
 * Must never throw or reject -- all errors are caught and logged.
 *
 * WHY standalone function (not inside the lock chain): the session lock is held
 * throughout handleAdvanceIntent. This function runs after the lock is released,
 * acquiring its own fresh lock for the append. This is the same pattern as
 * delivery_recorded in the daemon delivery pipeline.
 *
 * WHY re-reads the session store: the post-advance truth is not accessible at
 * the index.ts call site without threading it through the response. The extra
 * read is fire-and-forget and does not affect response latency.
 */
async function collectAndRecordUsage(
  sessionId: SessionId,
  sessionStore: V2ToolContext['v2']['sessionStore'],
  gate: V2ToolContext['v2']['gate'],
  idFactory: V2ToolContext['v2']['idFactory'],
): Promise<void> {
  try {
    // Re-read session events to extract workspacePath, startMs, and runId.
    const loadResult = await sessionStore.load(sessionId);
    if (loadResult.isErr()) return;

    const events = loadResult.value.events;
    if (events.length === 0) return;

    // workspacePath: from repo_root observation event
    let workspacePath: string | null = null;
    for (const e of events) {
      if (e.kind === 'observation_recorded' && e.data.key === 'repo_root') {
        workspacePath = e.data.value.value;
        break;
      }
    }

    // startMs: from the first event's timestampMs
    const startMs = events[0]?.timestampMs ?? Date.now();

    // runId: from the run_completed event's scope
    let runId: string | null = null;
    for (const e of events) {
      if (e.kind === EVENT_KIND.RUN_COMPLETED) {
        runId = e.scope.runId;
        break;
      }
    }
    if (!runId) return;

    // Collect usage from all registered readers
    const usageResults = await collect(String(sessionId), workspacePath, startMs);
    if (usageResults.length === 0) return;

    // Append one usage_recorded event per client that was detected.
    // Each append uses a fresh session lock to avoid lock re-entrancy.
    await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.load(sessionId).andThen((truth) => {
        const sortedResult = asSortedEventLog(truth.events);
        if (sortedResult.isErr()) return okAsync(undefined as void);
        const index = buildSessionIndex(sortedResult.value);

        // Build one event per usage result, chaining the appends.
        // Each event gets a sequential eventIndex derived from the post-append index.
        const eventsToAppend = usageResults.map((usage, i) => ({
          v: 1 as const,
          eventId: idFactory.mintEventId(),
          eventIndex: index.nextEventIndex + i,
          sessionId: String(sessionId),
          kind: EVENT_KIND.USAGE_RECORDED,
          dedupeKey: `usage-recorded:${String(sessionId)}:${usage.client}`,
          scope: { runId: runId! },
          data: {
            client: usage.client,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            turns: usage.turns,
          },
          timestampMs: Date.now(),
        }));

        return sessionStore.append(lock, { events: eventsToAppend, snapshotPins: [] }, truth);
      })
    ).match(
      () => {
        // Success -- usage recorded
      },
      (err) => {
        console.warn(`[workrail:usage] Could not record usage for session ${String(sessionId)}: ${JSON.stringify(err)}`);
      }
    );
  } catch (err: unknown) {
    console.warn(`[workrail:usage] Unexpected error collecting usage for session ${String(sessionId)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Main handler ─────────────────────────────────────────────────────────

export function executeContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: V2ToolContext
): RA<ContinueWorkflowResult, ContinueWorkflowError> {
  const { gate, sessionStore, snapshotStore, pinnedStore, sha256, tokenCodecPorts, idFactory, tokenAliasStore, entropy, gitSnapshot } = ctx.v2;

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
              gitSnapshot: gitSnapshot ?? new NullGitSnapshotV2(),
              aliasStore: tokenAliasStore,
              entropy,
              cleanResponseFormat: ctx.featureFlags?.isEnabled('cleanResponseFormat') ?? false,
            }))
            .map((response) => {
              // Fire-and-forget: collect MCP client usage after session completion.
              // WHY void (no await): usage collection must never block the session response.
              // WHY kind check + isComplete: gate_checkpoint has no isComplete field;
              // only ok/blocked variants with isComplete=true represent a finished session.
              if (response.kind !== 'gate_checkpoint' && response.isComplete) {
                // WHY sequential (not concurrent): both functions acquire the same
                // session gate lock. Concurrent void calls would cause the second
                // to hit SESSION_LOCK_REENTRANT and silently fail. The lock is
                // released after each operation, so sequential is correct and safe.
                void (async () => {
                  await collectAndRecordUsage(sessionId, sessionStore, gate, idFactory);
                  await recordTokenCheckpoint(sessionId, 'end', undefined, sessionStore, gate, idFactory);
                })();
              }
              return { response };
            });
        });
    }
  }
}
