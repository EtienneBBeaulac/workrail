/**
 * Factory for the spawn_agent tool used in daemon agent sessions.
 *
 * Spawns a child WorkRail session in-process, blocking the parent until the child completes.
 * Extracted from workflow-runner.ts. Zero behavior change.
 */

import type { AgentTool, AgentToolResult } from '../agent-loop.js';
import type { V2ToolContext } from '../../mcp/types.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import { executeStartWorkflow } from '../../mcp/handlers/v2-execution/start.js';
import { parseContinueTokenOrFail } from '../../mcp/handlers/v2-token-ops.js';
import { assertNever } from '../../runtime/assert-never.js';
import { withWorkrailSession } from './_shared.js';
// WHY import type: runWorkflow is passed as a parameter (runWorkflowFn), not called
// directly. The type reference is erased at compile time -- no runtime circular dep.
import type { runWorkflow, ChildWorkflowRunResult, SessionSource, AllocatedSession } from '../workflow-runner.js';
import type { ActiveSessionSet } from '../active-sessions.js';

/**
 * Factory for the `spawn_agent` tool, which lets a parent session delegate sub-tasks
 * to child WorkRail sessions.
 *
 * LIMITATION -- branchStrategy: Child sessions spawned by this tool always have
 * `branchStrategy: 'none'`. They operate in the parent's workspace (or the workspace
 * provided via the spawn_agent params) without their own isolated worktree or feature
 * branch. The child session writes directly to whatever workspace path it is given.
 *
 * WHY: spawn_agent constructs a WorkflowTrigger without a branchStrategy field, so the
 * child defaults to 'none'. Creating an isolated worktree for each child session would
 * require git credentials, disk allocation, and a branch-naming scheme per child --
 * overhead that is unnecessary for most coordinator/sub-agent patterns.
 *
 * Coordinators that need isolated child sessions (i.e. a child that fetches a branch,
 * makes changes, and opens a PR independently) should dispatch them via
 * `TriggerRouter.dispatch()` instead, which supports the full trigger configuration
 * including branchStrategy: 'worktree'.
 *
 * @param sessionId - Process-local UUID (for logging correlation).
 * @param ctx - V2ToolContext from the shared DI container.
 * @param apiKey - Anthropic API key for the child session's Claude model.
 * @param thisWorkrailSessionId - WorkRail session ID of the parent (becomes parentSessionId in child).
 * @param currentDepth - Spawn depth of the parent session (0 for root sessions).
 * @param maxDepth - Maximum allowed spawn depth. Blocks spawn when currentDepth >= maxDepth.
 * @param runWorkflowFn - Injected runWorkflow function (allows testing without real LLM calls).
 * @param schemas - Plain JSON Schema map from getSchemas().
 * @param emitter - Optional event emitter for structured lifecycle events.
 * @param activeSessionSet - Session registry for abort callbacks (graceful shutdown).
 */
export function makeSpawnAgentTool(
  sessionId: string,
  ctx: V2ToolContext,
  apiKey: string,
  thisWorkrailSessionId: string,
  currentDepth: number,
  maxDepth: number,
  runWorkflowFn: typeof runWorkflow,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
  emitter?: DaemonEventEmitter,
  activeSessionSet?: ActiveSessionSet,
): AgentTool {
  return {
    name: 'spawn_agent',
    description:
      'Spawn a child WorkRail session to handle a delegated sub-task. ' +
      'Blocks until the child session completes, then returns the child\'s outcome and notes. ' +
      'Use this when a step requires delegating a well-defined sub-task to a separate workflow. ' +
      'IMPORTANT: The parent session\'s time limit (maxSessionMinutes) keeps ticking while the child runs. ' +
      'Configure the parent with enough time to cover both its own work and the child\'s work. ' +
      'Per-trigger limits (maxOutputTokens, maxTurns, maxSessionMinutes) are NOT inherited by child sessions spawned via spawn_agent -- each child uses its own trigger\'s agentConfig. ' +
      'Returns: { childSessionId, outcome: "success"|"error"|"timeout", notes: string, artifacts?: readonly unknown[] }. ' +
      'On success, artifacts contains the child session\'s final step artifacts if any were produced. ' +
      'Check outcome before using notes -- on error/timeout, notes contains the error message.',
    inputSchema: schemas['SpawnAgentParams'],
    label: 'Spawn Agent',

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_toolCallId: string, params: any): Promise<AgentToolResult<unknown>> => {
      if (typeof params.workflowId !== 'string' || !params.workflowId) throw new Error('spawn_agent: workflowId must be a non-empty string');
      if (typeof params.goal !== 'string' || !params.goal) throw new Error('spawn_agent: goal must be a non-empty string');
      if (typeof params.workspacePath !== 'string' || !params.workspacePath) throw new Error('spawn_agent: workspacePath must be a non-empty string');
      console.log(`[WorkflowRunner] Tool: spawn_agent sessionId=${sessionId} workflowId=${String(params.workflowId)} depth=${currentDepth}/${maxDepth}`);
      emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'spawn_agent', summary: `${String(params.workflowId)} depth=${currentDepth}`, ...withWorkrailSession(thisWorkrailSessionId) });

      // ---- Depth limit enforcement (synchronous, before any async work) ----
      // WHY check before executeStartWorkflow: fail fast at the boundary. A depth error
      // is a configuration issue, not a transient failure. No child session should be
      // created at all when the depth limit is exceeded.
      if (currentDepth >= maxDepth) {
        const limitResult = {
          childSessionId: null,
          outcome: 'error' as const,
          notes: `Max spawn depth exceeded (currentDepth=${currentDepth}, maxDepth=${maxDepth}). ` +
            `Cannot spawn a child session from this depth. ` +
            `Increase agentConfig.maxSubagentDepth if deeper delegation is intentional.`,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(limitResult) }],
          details: limitResult,
        };
      }

      // ---- Pre-create child session (Candidate 2: _preAllocatedStartResponse pattern) ----
      // WHY call executeStartWorkflow first: childSessionId is deterministic and the child
      // is observable in the store from the moment execute() is called. If the process crashes
      // after executeStartWorkflow but before runWorkflow, the zombie session is traceable
      // via parentSessionId. Adapts the proven pattern from console-routes.ts.
      const startInput = {
        workflowId: String(params.workflowId),
        workspacePath: String(params.workspacePath),
        goal: String(params.goal),
      };

      const startResult = await executeStartWorkflow(
        startInput,
        ctx,
        // WHY parentSessionId via internalContext: the public V2StartWorkflowInput schema
        // stays unchanged. parentSessionId is extracted in buildInitialEvents() to populate
        // session_created.data (typed, durable, DAG-queryable).
        // is_autonomous: 'true' marks the child as a daemon-owned session.
        { is_autonomous: 'true', workspacePath: String(params.workspacePath), parentSessionId: thisWorkrailSessionId, triggerSource: 'daemon' },
      );

      if (startResult.isErr()) {
        const errResult = {
          childSessionId: null,
          outcome: 'error' as const,
          notes: `Failed to start child workflow: ${startResult.error.kind} -- ${JSON.stringify(startResult.error)}`,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(errResult) }],
          details: errResult,
        };
      }

      // ---- Decode childSessionId from continueToken ----
      // WHY token decode (not return from executeStartWorkflow): adding sessionId to
      // V2StartWorkflowOutputSchema would be a public API change (GAP-7 territory).
      // Token decode via the alias store is the correct in-process path.
      // On decode failure: proceed with childSessionId = null (observable in logs).
      let childSessionId: string | null = null;
      const childContinueToken = startResult.value.response.continueToken ?? '';
      if (childContinueToken) {
        const decoded = await parseContinueTokenOrFail(
          childContinueToken,
          ctx.v2.tokenCodecPorts,
          ctx.v2.tokenAliasStore,
        );
        if (decoded.isOk()) {
          childSessionId = decoded.value.sessionId;
        } else {
          console.warn(
            `[WorkflowRunner] spawn_agent: could not decode childSessionId from continueToken -- ` +
            `childSessionId will be null in result. Reason: ${decoded.error.message}`,
          );
        }
      }

      // ---- Run child workflow (blocking until complete) ----
      // WHY direct runWorkflow() call (not dispatch()): dispatch() is fire-and-forget and uses
      // a global Semaphore. Calling it from inside a running session would deadlock.
      // Direct await runWorkflow() is naturally blocking -- the parent's AgentLoop is paused
      // inside execute() until the child completes (AgentLoop.execute() is sequential).
      const childTrigger = {
        workflowId: String(params.workflowId),
        goal: String(params.goal),
        workspacePath: String(params.workspacePath),
        context: params.context as Readonly<Record<string, unknown>> | undefined,
        // WHY spawnDepth: child session constructs its own spawn_agent tool at depth+1.
        // This is the mechanism by which depth limits propagate through the tree.
        spawnDepth: currentDepth + 1,
        // WHY parentSessionId: threads the parent link through runWorkflow -> executeStartWorkflow
        // for context_set injection (alongside the session_created.data written above).
        parentSessionId: thisWorkrailSessionId,
      };
      // WHY SessionSource: the session is already created above. runWorkflow() MUST NOT
      // call executeStartWorkflow() again (invariant). SessionSource replaces the removed
      // WorkflowTrigger._preAllocatedStartResponse field (A9 migration).
      const r = startResult.value.response;
      const childAllocatedSession: AllocatedSession = {
        continueToken: r.continueToken ?? '',
        checkpointToken: r.checkpointToken,
        firstStepPrompt: r.pending?.prompt ?? '',
        isComplete: r.isComplete,
        triggerSource: 'daemon',
      };
      const childSource: SessionSource = { kind: 'pre_allocated', trigger: childTrigger, session: childAllocatedSession };
      const childResult = await runWorkflowFn(
        childTrigger,
        ctx,
        apiKey,
        undefined, // daemonRegistry: child sessions are not registered (no isLive tracking needed)
        emitter,
        activeSessionSet, // WHY: thread session set so child sessions are abortable on SIGTERM
        undefined, // _statsDir: use default
        undefined, // _sessionsDir: use default
        childSource,
      ) as ChildWorkflowRunResult;
      // WHY cast to ChildWorkflowRunResult: runWorkflow() returns WorkflowRunResult (4 variants)
      // for TriggerRouter compatibility, but structurally only produces success/error/timeout.
      // delivery_failed is produced by TriggerRouter after a callbackUrl POST fails -- a
      // trigger-layer concern that does not apply here (child sessions have no callbackUrl).
      // The cast documents this architectural invariant; assertNever below catches any future
      // violation at compile time if ChildWorkflowRunResult or runWorkflow() changes.

      // ---- Map ChildWorkflowRunResult to structured output ----
      // WHY ChildWorkflowRunResult (not WorkflowRunResult): runWorkflow() never produces
      // delivery_failed -- see ChildWorkflowRunResult type definition and WHY comment above.
      // Using the narrower type gives compile-time exhaustiveness over the 3 real variants;
      // assertNever guards against future additions.
      let resultObj: {
        childSessionId: string | null;
        outcome: 'success' | 'error' | 'timeout' | 'stuck';
        notes: string;
        artifacts?: readonly unknown[];
        issueSummaries?: readonly string[];
      };

      if (childResult._tag === 'success') {
        resultObj = {
          childSessionId,
          outcome: 'success',
          notes: childResult.lastStepNotes ?? '(no notes from child session)',
          // WHY spread conditional: artifacts must be absent (not null/undefined) when the child
          // produced none. Mirrors the WorkflowRunSuccess construction pattern at lines 2868-2869.
          ...(childResult.lastStepArtifacts !== undefined ? { artifacts: childResult.lastStepArtifacts } : {}),
        };
      } else if (childResult._tag === 'error') {
        resultObj = {
          childSessionId,
          outcome: 'error',
          notes: childResult.message,
        };
      } else if (childResult._tag === 'timeout') {
        resultObj = {
          childSessionId,
          outcome: 'timeout',
          notes: childResult.message,
        };
      } else if (childResult._tag === 'stuck') {
        resultObj = {
          childSessionId,
          outcome: 'stuck',
          notes: childResult.message,
          ...(childResult.issueSummaries !== undefined
            ? { issueSummaries: childResult.issueSummaries }
            : {}),
        };
      } else {
        // Compile-time exhaustiveness guard. If ChildWorkflowRunResult gains a new variant
        // without a corresponding branch above, TypeScript will emit a compile error here.
        // At runtime this is unreachable -- see ChildWorkflowRunResult and WHY comment above.
        assertNever(childResult);
      }

      console.log(`[WorkflowRunner] spawn_agent completed: sessionId=${sessionId} childSessionId=${childSessionId ?? 'null'} outcome=${resultObj.outcome}`);
      emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'spawn_agent_complete', summary: `outcome=${resultObj.outcome} child=${childSessionId ?? 'null'}`, ...withWorkrailSession(thisWorkrailSessionId) });

      return {
        content: [{ type: 'text', text: JSON.stringify(resultObj) }],
        details: resultObj,
      };
    },
  };
}
