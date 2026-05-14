/**
 * Factory for the spawn_agent tool used in daemon agent sessions.
 *
 * Spawns one or more child WorkRail sessions in-process. The single-spawn form
 * blocks until one child completes; the parallel form runs N children concurrently
 * via Promise.all and blocks until all complete.
 */

import type { AgentTool, AgentToolResult } from '../agent-loop.js';
import type { V2ToolContext } from '../../mcp/types.js';
import type { DaemonEventEmitter, RunId } from '../daemon-events.js';
import { executeStartWorkflow } from '../../mcp/handlers/v2-execution/start.js';
import { parseContinueTokenOrFail } from '../../mcp/handlers/v2-token-ops.js';
import { assertNever } from '../../runtime/assert-never.js';
import { withWorkrailSession } from './_shared.js';
// WHY import type: runWorkflow is passed as a parameter (runWorkflowFn), not called
// directly. The type reference is erased at compile time -- no runtime circular dep.
import type { runWorkflow } from '../workflow-runner.js';
import type { ChildWorkflowRunResult, SessionSource, AllocatedSession } from '../types.js';
import type { ActiveSessionSet } from '../active-sessions.js';

// ---------------------------------------------------------------------------
// Domain types for spawn_agent inputs and results
// ---------------------------------------------------------------------------

/**
 * Parameters for a single child session to spawn.
 * Used in both single-spawn (top-level) and parallel (agents array element) forms.
 */
interface SingleSpawnSpec {
  readonly workflowId: string;
  readonly goal: string;
  readonly workspacePath: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * Result for a single spawned child session.
 *
 * WHY kind: 'single': allows callers to distinguish single vs parallel responses
 * without pattern-matching on which keys are present. A discriminant on the result
 * shape makes the contract explicit and prevents silent misreads.
 */
interface SingleSpawnResult {
  readonly kind: 'single';
  readonly childSessionId: string | null;
  readonly outcome: 'success' | 'error' | 'timeout' | 'stuck';
  readonly notes: string;
  readonly artifacts?: readonly unknown[];
  readonly issueSummaries?: readonly string[];
}

/**
 * Parsed, validated representation of the params passed to execute().
 *
 * WHY a discriminated union (not runtime typeof checks): parsing once at the
 * boundary produces typed values that the rest of execute() trusts without
 * re-checking. "Validate at boundaries, trust inside."
 */
type ParsedParams =
  | { readonly kind: 'single'; readonly spec: SingleSpawnSpec }
  | { readonly kind: 'parallel'; readonly agents: readonly SingleSpawnSpec[] };

/**
 * Parse and validate the raw params from the LLM tool call.
 *
 * Throws with a descriptive message if any required field is missing or wrong type.
 * Returns a ParsedParams discriminated union so all downstream code is typed.
 *
 * WHY this is the only place typeof checks appear: validation belongs at the
 * boundary. Once this returns, the rest of execute() works with typed values only.
 */
function parseParams(raw: unknown): ParsedParams {
  const p = raw as Record<string, unknown>;

  // agents[] present and non-empty => parallel form
  if (Array.isArray(p['agents'])) {
    const rawAgents = p['agents'] as unknown[];
    if (rawAgents.length === 0) {
      throw new Error('spawn_agent: agents must be a non-empty array');
    }
    if (rawAgents.length > 10) {
      throw new Error(`spawn_agent: agents array length ${rawAgents.length} exceeds maximum of 10 concurrent sessions`);
    }
    const agents: SingleSpawnSpec[] = rawAgents.map((item, i) => {
      const a = item as Record<string, unknown>;
      if (typeof a['workflowId'] !== 'string' || !a['workflowId']) throw new Error(`spawn_agent: agents[${i}].workflowId must be a non-empty string`);
      if (typeof a['goal'] !== 'string' || !a['goal']) throw new Error(`spawn_agent: agents[${i}].goal must be a non-empty string`);
      if (typeof a['workspacePath'] !== 'string' || !a['workspacePath']) throw new Error(`spawn_agent: agents[${i}].workspacePath must be a non-empty string`);
      if (a['context'] !== undefined && (typeof a['context'] !== 'object' || a['context'] === null || Array.isArray(a['context']))) throw new Error(`spawn_agent: agents[${i}].context must be a plain object if provided`);
      return {
        workflowId: a['workflowId'],
        goal: a['goal'],
        workspacePath: a['workspacePath'],
        ...(a['context'] !== undefined ? { context: a['context'] as Readonly<Record<string, unknown>> } : {}),
      };
    });
    return { kind: 'parallel', agents };
  }

  // scalar fields => single form
  if (typeof p['workflowId'] !== 'string' || !p['workflowId']) throw new Error('spawn_agent: workflowId must be a non-empty string');
  if (typeof p['goal'] !== 'string' || !p['goal']) throw new Error('spawn_agent: goal must be a non-empty string');
  if (typeof p['workspacePath'] !== 'string' || !p['workspacePath']) throw new Error('spawn_agent: workspacePath must be a non-empty string');
  return {
    kind: 'single',
    spec: {
      workflowId: p['workflowId'],
      goal: p['goal'],
      workspacePath: p['workspacePath'],
      ...(p['context'] !== undefined ? { context: p['context'] as Readonly<Record<string, unknown>> } : {}), // object type validated by JSON Schema at call boundary
    },
  };
}

// ---------------------------------------------------------------------------
// SpawnContext: session-scoped dependencies shared across all spawnOne() calls
// ---------------------------------------------------------------------------

/**
 * Session-scoped dependencies injected into every spawnOne() call.
 *
 * WHY an object (not positional params): these 9 values are fixed for the
 * lifetime of a single execute() call -- they do not vary per-child in a
 * parallel batch. Grouping them eliminates the 10-param signature smell,
 * makes call sites readable, and means adding a new dep is a one-line change
 * rather than a change at every call site.
 */
interface SpawnContext {
  readonly ctx: V2ToolContext;
  readonly apiKey: string;
  readonly sessionId: RunId;
  readonly thisWorkrailSessionId: string;
  readonly currentDepth: number;
  readonly maxDepth: number;
  readonly runWorkflowFn: typeof runWorkflow;
  readonly emitter: DaemonEventEmitter | undefined;
  readonly activeSessionSet: ActiveSessionSet | undefined;
}

// ---------------------------------------------------------------------------
// spawnOne: core single-child spawn logic (shared by single and parallel paths)
// ---------------------------------------------------------------------------

/**
 * Spawn a single child WorkRail session and return its result.
 *
 * WHY standalone function (not inline in execute()): both single and parallel
 * dispatch paths call this. Extracting it eliminates duplication and makes the
 * core logic independently testable via the fake-runWorkflowFn stub pattern.
 *
 * Never throws -- all failure paths return SingleSpawnResult with outcome: 'error'.
 * Errors are data; the caller decides what to do with each child's outcome.
 */
async function spawnOne(spec: SingleSpawnSpec, sc: SpawnContext): Promise<SingleSpawnResult> {
  // ---- Depth limit enforcement (synchronous, before any async work) ----
  // WHY check before executeStartWorkflow: fail fast at the boundary. A depth error
  // is a configuration issue, not a transient failure. No child session should be
  // created at all when the depth limit is exceeded.
  if (sc.currentDepth >= sc.maxDepth) {
    return {
      kind: 'single',
      childSessionId: null,
      outcome: 'error',
      notes: `Max spawn depth exceeded (currentDepth=${sc.currentDepth}, maxDepth=${sc.maxDepth}). ` +
        `Cannot spawn a child session from this depth. ` +
        `Increase agentConfig.maxSubagentDepth if deeper delegation is intentional.`,
    };
  }

  // ---- Pre-create child session (_preAllocatedStartResponse pattern) ----
  // WHY call executeStartWorkflow first: childSessionId is deterministic and the child
  // is observable in the store from the moment spawnOne() is called. If the process crashes
  // after executeStartWorkflow but before runWorkflow, the zombie session is traceable
  // via parentSessionId. Adapts the proven pattern from console-routes.ts.
  const startResult = await executeStartWorkflow(
    { workflowId: spec.workflowId, workspacePath: spec.workspacePath, goal: spec.goal },
    sc.ctx,
    // WHY parentSessionId via internalContext: the public V2StartWorkflowInput schema
    // stays unchanged. parentSessionId is extracted in buildInitialEvents() to populate
    // session_created.data (typed, durable, DAG-queryable).
    // is_autonomous: 'true' marks the child as a daemon-owned session.
    { is_autonomous: 'true', workspacePath: spec.workspacePath, parentSessionId: sc.thisWorkrailSessionId, triggerSource: 'daemon' },
  );

  if (startResult.isErr()) {
    return {
      kind: 'single',
      childSessionId: null,
      outcome: 'error',
      notes: `Failed to start child workflow: ${startResult.error.kind} -- ${JSON.stringify(startResult.error)}`,
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
      sc.ctx.v2.tokenCodecPorts,
      sc.ctx.v2.tokenAliasStore,
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
  // inside execute() until the child completes (AgentLoop._executeTools() is sequential).
  // For parallel spawns: multiple spawnOne() calls run concurrently via Promise.all --
  // the parent loop is still blocked inside execute() for the full batch duration.
  const childTrigger = {
    workflowId: spec.workflowId,
    goal: spec.goal,
    workspacePath: spec.workspacePath,
    context: spec.context,
    // WHY spawnDepth: child session constructs its own spawn_agent tool at depth+1.
    // This is the mechanism by which depth limits propagate through the tree.
    spawnDepth: sc.currentDepth + 1,
    // WHY parentSessionId: threads the parent link through runWorkflow -> executeStartWorkflow
    // for context_set injection (alongside the session_created.data written above).
    parentSessionId: sc.thisWorkrailSessionId,
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
  const childResult = await sc.runWorkflowFn(
    childTrigger,
    sc.ctx,
    sc.apiKey,
    undefined, // daemonRegistry: child sessions are not registered (no isLive tracking needed)
    sc.emitter,
    sc.activeSessionSet, // WHY: thread session set so child sessions are abortable on SIGTERM
    undefined, // _statsDir: use default
    undefined, // _sessionsDir: use default
    childSource,
  ) as ChildWorkflowRunResult;
  // WHY cast to ChildWorkflowRunResult: runWorkflow() returns WorkflowRunResult (includes
  // delivery_failed), but structurally only produces success/error/timeout/stuck here.
  // delivery_failed is produced by TriggerRouter after a callbackUrl POST fails -- a
  // trigger-layer concern that does not apply (child sessions have no callbackUrl).
  // The cast documents this invariant; assertNever below catches future violations.

  // ---- Map ChildWorkflowRunResult to SingleSpawnResult ----
  // WHY ChildWorkflowRunResult: exhaustive over the 4 real variants; assertNever guards additions.
  if (childResult._tag === 'success') {
    return {
      kind: 'single',
      childSessionId,
      outcome: 'success',
      notes: childResult.lastStepNotes ?? '(no notes from child session)',
      // WHY spread conditional: artifacts must be absent (not null/undefined) when the child
      // produced none. Mirrors the WorkflowRunSuccess construction pattern.
      ...(childResult.lastStepArtifacts !== undefined ? { artifacts: childResult.lastStepArtifacts } : {}),
    };
  } else if (childResult._tag === 'error') {
    return { kind: 'single', childSessionId, outcome: 'error', notes: childResult.message };
  } else if (childResult._tag === 'timeout') {
    return { kind: 'single', childSessionId, outcome: 'timeout', notes: childResult.message };
  } else if (childResult._tag === 'stuck') {
    return {
      kind: 'single',
      childSessionId,
      outcome: 'stuck',
      notes: childResult.message,
      ...(childResult.issueSummaries !== undefined ? { issueSummaries: childResult.issueSummaries } : {}),
    };
  } else if (childResult._tag === 'gate_parked') {
    // Child session parked at a requireConfirmation gate. Coordinator evaluation not yet
    // implemented (PR 2). Surface as 'stuck' outcome so the parent session knows the child
    // did not complete. The parent may report_issue and the coordinator can investigate.
    return {
      kind: 'single',
      childSessionId,
      outcome: 'stuck',
      notes: `Child session parked at gate checkpoint (step: '${childResult.stepId}'). Gate evaluation not yet implemented.`,
    };
  } else {
    // Compile-time exhaustiveness guard. If ChildWorkflowRunResult gains a new variant
    // without a corresponding branch above, TypeScript will emit a compile error here.
    // At runtime this is unreachable -- see ChildWorkflowRunResult type definition.
    assertNever(childResult);
  }
}

// ---------------------------------------------------------------------------
// makeSpawnAgentTool: factory
// ---------------------------------------------------------------------------

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
  sessionId: RunId,
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
      'Spawn one or more child WorkRail sessions to handle delegated sub-tasks. ' +
      '\n\nSINGLE form: { workflowId, goal, workspacePath, context? }' +
      '\n  Returns: { kind: "single", childSessionId, outcome: "success"|"error"|"timeout"|"stuck", notes, artifacts? }' +
      '\n\nPARALLEL form: { agents: [{ workflowId, goal, workspacePath, context? }, ...] }' +
      '\n  Runs all agents simultaneously. Returns: { kind: "parallel", results: [...] } in input order.' +
      '\n  Budget: maxSessionMinutes must cover max(child duration), NOT sum(child durations).' +
      '\n\nAlways check .kind before reading .outcome (single) or .results (parallel). ' +
      'IMPORTANT: the parent session\'s time limit keeps running while children execute. ' +
      'Per-trigger limits (maxOutputTokens, maxTurns, maxSessionMinutes) are NOT inherited by child sessions. ' +
      'Maximum spawn depth is 3 by default (configurable via agentConfig.maxSubagentDepth).',
    inputSchema: schemas['SpawnAgentParams'],
    label: 'Spawn Agent',

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_toolCallId: string, params: any, _signal: AbortSignal): Promise<AgentToolResult<unknown>> => {
      // Parse and validate all inputs at the boundary. Everything below works with
      // typed values only -- no typeof checks, no String() coercions, no as-casts.
      const parsed = parseParams(params);

      const sc: SpawnContext = { ctx, apiKey, sessionId, thisWorkrailSessionId, currentDepth, maxDepth, runWorkflowFn, emitter, activeSessionSet };

      if (parsed.kind === 'single') {
        console.log(`[WorkflowRunner] Tool: spawn_agent sessionId=${sessionId} workflowId=${parsed.spec.workflowId} depth=${currentDepth}/${maxDepth}`);
        emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'spawn_agent', summary: `${parsed.spec.workflowId} depth=${currentDepth}`, ...withWorkrailSession(thisWorkrailSessionId) });

        const result = await spawnOne(parsed.spec, sc);

        console.log(`[WorkflowRunner] spawn_agent completed: sessionId=${sessionId} childSessionId=${result.childSessionId ?? 'null'} outcome=${result.outcome}`);
        emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'spawn_agent_complete', summary: `outcome=${result.outcome} child=${result.childSessionId ?? 'null'}`, ...withWorkrailSession(thisWorkrailSessionId) });

        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };

      } else {
        // WHY Promise.all: runs all child sessions concurrently. Wall-clock time is
        // max(child durations) instead of sum. AgentLoop._executeTools() is sequential,
        // so the parent loop is blocked for the full batch duration -- but the children
        // themselves run in parallel within that single blocked turn.
        console.log(`[WorkflowRunner] Tool: spawn_agent (parallel) sessionId=${sessionId} count=${parsed.agents.length} depth=${currentDepth}/${maxDepth}`);
        emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'spawn_agent', summary: `parallel count=${parsed.agents.length} depth=${currentDepth}`, ...withWorkrailSession(thisWorkrailSessionId) });

        const results = await Promise.all(parsed.agents.map((spec) => spawnOne(spec, sc)));

        const outcomes = results.map((r) => r.outcome).join(',');
        console.log(`[WorkflowRunner] spawn_agent (parallel) completed: sessionId=${sessionId} outcomes=[${outcomes}]`);
        emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'spawn_agent_complete', summary: `parallel outcomes=[${outcomes}]`, ...withWorkrailSession(thisWorkrailSessionId) });

        const batchResult = { kind: 'parallel' as const, results };
        return { content: [{ type: 'text', text: JSON.stringify(batchResult) }], details: batchResult };
      }
    },
  };
}
