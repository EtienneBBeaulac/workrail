/**
 * WorkRail Daemon: Autonomous Workflow Runner
 *
 * Drives a WorkRail session to completion using the first-party AgentLoop (src/daemon/agent-loop.ts).
 * Calls WorkRail's own engine directly (in-process, shared DI) rather than over HTTP.
 *
 * Design decisions:
 * - Uses agent.steer() (NOT followUp()) for step injection. steer() fires after each
 *   tool batch inside the inner loop; followUp() fires only when the agent would
 *   otherwise stop, adding an unnecessary extra LLM turn per workflow step.
 * - V2ToolContext is injected by the caller (shared with MCP server in same process).
 *   The daemon must not call createWorkRailEngine() -- engineActive guard blocks reuse.
 * - Tools THROW on failure (AgentLoop contract). runWorkflow() catches and returns
 *   a WorkflowRunResult discriminated union (errors-as-data at the outer boundary).
 * - The daemon calls executeStartWorkflow() directly before creating the Agent --
 *   this avoids one full LLM turn per session. start_workflow is NOT in the tools
 *   list; the LLM only ever calls continue_workflow for subsequent steps.
 * - continueToken + checkpointToken are persisted atomically to
 *   ~/.workrail/daemon-sessions/<sessionId>.json BEFORE the agent loop begins and
 *   BEFORE returning from each continue_workflow tool call. Each concurrent session
 *   has its own file -- they never clobber each other. Crash recovery invariant.
 */

import 'reflect-metadata';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { glob as tinyGlob } from 'tinyglobby';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { AgentLoop } from "./agent-loop.js";
import type { AgentTool, AgentEvent, AgentLoopCallbacks, AgentInternalMessage } from "./agent-loop.js";
import type { V2ToolContext } from '../mcp/types.js';
import { executeStartWorkflow } from '../mcp/handlers/v2-execution/start.js';
import { executeContinueWorkflow } from '../mcp/handlers/v2-execution/index.js';
import type { DaemonRegistry } from '../v2/infra/in-memory/daemon-registry/index.js';
import type { V2StartWorkflowOutputSchema } from '../mcp/output-schemas.js';
import { parseContinueTokenOrFail } from '../mcp/handlers/v2-token-ops.js';
import type { ContinueTokenResolved } from '../mcp/handlers/v2-token-ops.js';
import { asSessionId } from '../v2/durable-core/ids/index.js';
import type { SessionEventLogReadonlyStorePortV2, LoadedValidatedPrefixV2, SessionEventLogStoreError } from '../v2/ports/session-event-log-store.port.js';
import type { ToolFailure } from '../mcp/handlers/v2-execution-helpers.js';
import type { ResultAsync } from 'neverthrow';
import { projectNodeOutputsV2 } from '../v2/projections/node-outputs.js';
import type { DaemonEventEmitter } from './daemon-events.js';
import { assertNever } from '../runtime/assert-never.js';
import { ok, err } from '../runtime/result.js';
import type { Result } from '../runtime/result.js';
import { evaluateRecovery } from './session-recovery-policy.js';
import { writeStatsSummary } from './stats-summary.js';
import { injectPendingSteps } from './turn-end/step-injector.js';
import { flushConversation } from './turn-end/conversation-flusher.js';
import { type SessionScope, DefaultFileStateTracker } from './session-scope.js';
import { DefaultContextLoader } from './context-loader.js';
import { ActiveSessionSet } from './active-sessions.js';
import type { SessionHandle } from './active-sessions.js';
// Tool factories -- extracted to individual files under src/daemon/tools/.
// Imported for use by constructTools() in this file, and re-exported for backward
// compatibility (tests and other callers import from workflow-runner.ts).
import type {
  ReadFileState,
  WorkflowTrigger,
  AllocatedSession,
  SessionSource,
  WorkflowRunSuccess,
  WorkflowRunError,
  WorkflowRunTimeout,
  WorkflowRunStuck,
  WorkflowDeliveryFailed,
  WorkflowRunResult,
  ChildWorkflowRunResult,
  OrphanedSession,
} from './types.js';
import type { SessionState, TerminalSignal, StuckConfig, StuckSignal } from './state/index.js';
import {
  createSessionState,
  advanceStep,
  recordCompletion,
  updateToken,
  setSessionId,
  recordToolCall,
  setTerminalSignal,
  evaluateStuckSignals,
} from './state/index.js';
import type { SessionContext, SidecarLifecycle } from './core/index.js';
import {
  BASE_SYSTEM_PROMPT,
  buildSessionRecap,
  buildSystemPrompt,
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  DEFAULT_MAX_TURNS,
  DEFAULT_STALL_TIMEOUT_SECONDS,
  buildSessionContext,
  tagToStatsOutcome,
  sidecardLifecycleFor,
  buildSessionResult,
  buildAgentClient,
} from './core/index.js';
import {
  loadDaemonSoul,
  loadWorkspaceContext,
  loadSessionNotes,
  appendConversationMessages,
  writeExecutionStats,
  writeStuckOutboxEntry,
  DAEMON_STATS_DIR,
  MAX_SESSION_RECAP_NOTES,
  MAX_SESSION_NOTE_CHARS,
  stripFrontmatter,
} from './io/index.js';
export {
  loadDaemonSoul,
  loadWorkspaceContext,
  loadSessionNotes,
  stripFrontmatter,
  MAX_SESSION_RECAP_NOTES,
  MAX_SESSION_NOTE_CHARS,
} from './io/index.js';
import { getSchemas, WORKTREES_DIR } from './runner/index.js';
import type {
  PreAgentSession,
  PreAgentSessionResult,
  AgentReadySession,
  SessionOutcome,
  FinalizationContext,

} from './runner/runner-types.js';
export type {
  PreAgentSession,
  PreAgentSessionResult,
  AgentReadySession,
  SessionOutcome,
  FinalizationContext,
} from './runner/runner-types.js';
export { WORKTREES_DIR } from './runner/runner-types.js';
import {
  runStartupRecovery,
  readDaemonSessionState,
  readAllDaemonSessions,
  countOrphanStepAdvances,
  clearQueueIssueSidecars,
} from './startup-recovery.js';
export {
  runStartupRecovery,
  readDaemonSessionState,
  readAllDaemonSessions,
  countOrphanStepAdvances,
  clearQueueIssueSidecars,
} from './startup-recovery.js';
import { withWorkrailSession, persistTokens, DAEMON_SESSIONS_DIR } from './tools/_shared.js';
import { makeContinueWorkflowTool, makeCompleteStepTool } from './tools/continue-workflow.js';
import { makeBashTool } from './tools/bash.js';
import { makeReadTool, makeWriteTool, makeEditTool } from './tools/file-tools.js';
import { makeGlobTool, makeGrepTool } from './tools/glob-grep.js';
import { makeSpawnAgentTool } from './tools/spawn-agent.js';
import { makeReportIssueTool } from './tools/report-issue.js';
import { makeSignalCoordinatorTool } from './tools/signal-coordinator.js';
// Re-export for backward compatibility (tests and other callers import from workflow-runner.ts).
export { DAEMON_SESSIONS_DIR, type PersistTokensError } from './tools/_shared.js';
export { DAEMON_SIGNALS_DIR } from './tools/signal-coordinator.js';
export {
  makeContinueWorkflowTool, makeCompleteStepTool,
  makeBashTool,
  makeReadTool, makeWriteTool, makeEditTool,
  makeGlobTool, makeGrepTool,
  makeSpawnAgentTool,
  makeReportIssueTool,
  makeSignalCoordinatorTool,
};
// Re-export domain types from types.ts for backward compatibility.
// Callers that previously imported these from workflow-runner.ts continue to work.
// New code should import directly from './types.js'.
export type {
  ReadFileState,
  WorkflowTrigger,
  AllocatedSession,
  SessionSource,
  WorkflowRunSuccess,
  WorkflowRunError,
  WorkflowRunTimeout,
  WorkflowRunStuck,
  WorkflowDeliveryFailed,
  WorkflowRunResult,
  ChildWorkflowRunResult,
  OrphanedSession,
} from './types.js';
// Re-export state layer for backward compatibility.
// New code should import directly from './state/index.js'.
export type { SessionState, TerminalSignal, StuckConfig, StuckSignal } from './state/index.js';
export {
  createSessionState,
  setTerminalSignal,
  evaluateStuckSignals,
  advanceStep,
  recordCompletion,
  updateToken,
  setSessionId,
  recordToolCall,
} from './state/index.js';
// Re-export core layer for backward compatibility.
// New code should import directly from './core/index.js'.
export type { SessionContext, SidecarLifecycle } from './core/index.js';
export {
  BASE_SYSTEM_PROMPT,
  buildSessionRecap,
  buildSystemPrompt,
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  DEFAULT_MAX_TURNS,
  DEFAULT_STALL_TIMEOUT_SECONDS,
  buildSessionContext,
  tagToStatsOutcome,
  sidecardLifecycleFor,
  buildSessionResult,
  buildAgentClient,
} from './core/index.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------




// DAEMON_SESSIONS_DIR is re-exported from './tools/_shared.js' at the top of this file.


// Tool factories are implemented in src/daemon/tools/ and re-exported at the top of this file.



/** Build a user message for the agent loop. */
function buildUserMessage(text: string): { role: 'user'; content: string; timestamp: number } {
  return {
    role: 'user',
    content: text,
    timestamp: Date.now(),
  };
}


// ---------------------------------------------------------------------------
// Imperative shell helper: session finalization
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// buildPreAgentSession -- pre-agent I/O phase
// ---------------------------------------------------------------------------

/**
 * Execute all I/O required before the agent loop can start.
 *
 * Handles: model validation, executeStartWorkflow (or pre-allocated response),
 * token decode, initial persistTokens, worktree creation (with second
 * persistTokens for worktreePath), and registry setup.
 *
 * WHY registry ordering: steer and daemon registries are registered LAST --
 * after all potentially-failing I/O (executeStartWorkflow, persistTokens,
 * worktree creation). This guarantees that any error path returning
 * { kind: 'complete' } before registration has nothing to clean up.
 *
 * WHY pure + I/O separation: the caller (runWorkflow) provides sessionId and
 * startMs so that timing and identity are consistent across both phases.
 *
 * @param source - Optional session source. When provided with kind 'pre_allocated',
 *   executeStartWorkflow is skipped (the caller already allocated the session).
 *   When absent or kind 'allocate', executeStartWorkflow is called internally.
 *
 * Returns { kind: 'complete', result } for all early-exit cases.
 * Returns { kind: 'ready', session } when the agent loop should run.
 */
export async function buildPreAgentSession(
  trigger: WorkflowTrigger,
  ctx: V2ToolContext,
  apiKey: string,
  sessionId: string,
  startMs: number,
  statsDir: string,
  sessionsDir: string,
  emitter: DaemonEventEmitter | undefined,
  daemonRegistry: DaemonRegistry | undefined,
  activeSessionSet: ActiveSessionSet | undefined,
  source?: SessionSource,
): Promise<PreAgentSessionResult> {
  // ---- Model setup ----
  let agentClient: Anthropic | AnthropicBedrock;
  let modelId: string;
  try {
    ({ agentClient, modelId } = buildAgentClient(trigger, apiKey, process.env));
    if (trigger.agentConfig?.model) {
      console.log(`[WorkflowRunner] Model: ${modelId} (override from agentConfig.model)`);
    } else {
      const usesBedrock = !!process.env['AWS_PROFILE'] || !!process.env['AWS_ACCESS_KEY_ID'];
      if (usesBedrock) {
        console.log(`[WorkflowRunner] Model: ${modelId} (amazon-bedrock, detected from AWS env)`);
      } else {
        console.log(`[WorkflowRunner] Model: ${modelId} (anthropic direct). Set agentConfig.model or AWS env vars to use Bedrock.`);
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { kind: 'complete', result: { _tag: 'error', workflowId: trigger.workflowId, message, stopReason: 'error' }, workrailSessionId: null, handle: undefined };
  }

  // ---- Session state ----
  const state = createSessionState('');

  // ---- executeStartWorkflow (or pre-allocated via SessionSource) ----
  // WHY SessionSource: replaces the removed WorkflowTrigger._preAllocatedStartResponse
  // field (A9 migration). Callers that pre-allocate a session pass source.kind === 'pre_allocated';
  // callers that want buildPreAgentSession to allocate pass 'allocate' or omit source entirely.
  let continueToken: string;
  let checkpointToken: string | null;
  let firstStepPrompt: string;
  let isComplete: boolean;

  const effectiveSource = source ?? { kind: 'allocate' as const, trigger };
  if (effectiveSource.kind === 'pre_allocated') {
    const s = effectiveSource.session;
    continueToken = s.continueToken;
    checkpointToken = s.checkpointToken ?? null;
    firstStepPrompt = s.firstStepPrompt;
    isComplete = s.isComplete;
  } else {
    const startResult = await executeStartWorkflow(
      { workflowId: trigger.workflowId, workspacePath: trigger.workspacePath, goal: trigger.goal },
      ctx,
      { is_autonomous: 'true', workspacePath: trigger.workspacePath, triggerSource: 'daemon' },
    );
    if (startResult.isErr()) {
      return {
        kind: 'complete',
        result: {
          _tag: 'error',
          workflowId: trigger.workflowId,
          message: `start_workflow failed: ${startResult.error.kind} -- ${JSON.stringify(startResult.error)}`,
          stopReason: 'error',
        },
        workrailSessionId: null,
        handle: undefined,
      };
    }
    const r = startResult.value.response;
    continueToken = r.continueToken ?? '';
    checkpointToken = r.checkpointToken ?? null;
    firstStepPrompt = r.pending?.prompt ?? '';
    isComplete = r.isComplete;
  }
  updateToken(state, continueToken);

  // ---- Decode WorkRail session ID ----
  if (continueToken) {
    const decoded = await parseContinueTokenOrFail(continueToken, ctx.v2.tokenCodecPorts, ctx.v2.tokenAliasStore);
    if (decoded.isOk()) {
      setSessionId(state, decoded.value.sessionId);
    } else {
      console.error(
        `[WorkflowRunner] Error: could not decode WorkRail session ID from continueToken -- isLive and liveActivity will not work. Reason: ${decoded.error.message}`,
      );
    }
  }

  // ---- Initial persistTokens (crash safety) ----
  if (continueToken) {
    const persistResult = await persistTokens(sessionId, continueToken, checkpointToken, undefined, {
      workflowId: trigger.workflowId,
      goal: trigger.goal,
      workspacePath: trigger.workspacePath,
    });
    if (persistResult.kind === 'err') {
      return {
        kind: 'complete',
        result: {
          _tag: 'error',
          workflowId: trigger.workflowId,
          message: `Initial token persist failed: ${persistResult.error.code} -- ${persistResult.error.message}`,
          stopReason: 'error',
        },
        workrailSessionId: state.workrailSessionId,
        handle: undefined,
      };
    }
  }

  // ---- Worktree isolation ----
  let sessionWorkspacePath = trigger.workspacePath;
  let sessionWorktreePath: string | undefined;

  // Override sessionWorkspacePath for crash-recovered worktree sessions.
  // WHY: the recovery path sets branchStrategy:'none' (suppress re-creation) but the
  // agent still needs to work in the existing worktree. AllocatedSession.sessionWorkspacePath
  // carries the worktree path; trigger.workspacePath stays as the main checkout so that
  // buildSystemPrompt()'s isWorktreeSession check (effectiveWorkspacePath !== trigger.workspacePath)
  // evaluates correctly and the scope boundary paragraph is injected.
  if (effectiveSource.kind === 'pre_allocated' && effectiveSource.session.sessionWorkspacePath !== undefined) {
    sessionWorkspacePath = effectiveSource.session.sessionWorkspacePath;
    sessionWorktreePath = effectiveSource.session.sessionWorkspacePath;
  }

  if (trigger.branchStrategy === 'worktree') {
    const branchPrefix = trigger.branchPrefix ?? 'worktrain/';
    const baseBranch = trigger.baseBranch ?? 'main';
    sessionWorkspacePath = path.join(WORKTREES_DIR, sessionId);
    sessionWorktreePath = sessionWorkspacePath;

    try {
      await fs.mkdir(WORKTREES_DIR, { recursive: true });
      await execFileAsync('git', ['-C', trigger.workspacePath, 'fetch', 'origin', baseBranch]);
      await execFileAsync('git', [
        '-C', trigger.workspacePath,
        'worktree', 'add',
        sessionWorkspacePath,
        '-b', `${branchPrefix}${sessionId}`,
        `origin/${baseBranch}`,
      ]);

      const worktreePersistResult = await persistTokens(
        sessionId, continueToken ?? state.currentContinueToken, checkpointToken, sessionWorktreePath,
        { workflowId: trigger.workflowId, goal: trigger.goal, workspacePath: trigger.workspacePath },
      );
      if (worktreePersistResult.kind === 'err') {
        console.error(`[WorkflowRunner] Worktree sidecar persist failed: ${worktreePersistResult.error.code} -- ${worktreePersistResult.error.message}`);
        try { await execFileAsync('git', ['-C', trigger.workspacePath, 'worktree', 'remove', '--force', sessionWorkspacePath]); } catch { /* best effort */ }
        return {
          kind: 'complete',
          result: {
            _tag: 'error',
            workflowId: trigger.workflowId,
            message: `Worktree sidecar persist failed: ${worktreePersistResult.error.code} -- ${worktreePersistResult.error.message}`,
            stopReason: 'error',
          },
          workrailSessionId: state.workrailSessionId,
          handle: undefined,
        };
      }

      console.log(`[WorkflowRunner] Worktree created: sessionId=${sessionId} branch=${branchPrefix}${sessionId} path=${sessionWorkspacePath}`);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[WorkflowRunner] Worktree creation failed: sessionId=${sessionId} error=${errMsg}`);
      return {
        kind: 'complete',
        result: { _tag: 'error', workflowId: trigger.workflowId, message: `Worktree creation failed: ${errMsg}`, stopReason: 'error' },
        workrailSessionId: state.workrailSessionId,
        handle: undefined,
      };
    }
  }

  // ---- Registry setup (AFTER all potentially-failing I/O -- FM1 invariant) ----
  // WHY registered last: any error path before this point returns 'complete' without
  // having registered. This means no cleanup is needed on those paths.
  // steer and daemon registries are registered here; abort registry is registered in
  // runWorkflow() AFTER agent construction (agent binding required).
  let handle: SessionHandle | undefined;
  if (state.workrailSessionId !== null) {
    daemonRegistry?.register(state.workrailSessionId, trigger.workflowId);
    handle = activeSessionSet?.register(state.workrailSessionId, (text: string) => { state.pendingSteerParts.push(text); });
  }

  // ---- Single-step completion (must check AFTER registry setup) ----
  // WHY after registration: the session is observable in the console from this point.
  // A session that completes immediately should still appear as 'completed' not 'not found'.
  if (isComplete) {
    return {
      kind: 'complete',
      result: {
        _tag: 'success',
        workflowId: trigger.workflowId,
        stopReason: 'stop',
        ...(sessionWorktreePath !== undefined ? { sessionWorkspacePath: sessionWorktreePath } : {}),
        ...(sessionWorktreePath !== undefined ? { sessionId } : {}),
        ...(trigger.botIdentity !== undefined ? { botIdentity: trigger.botIdentity } : {}),
      },
      workrailSessionId: state.workrailSessionId,
      handle,
    };
  }

  return {
    kind: 'ready',
    session: {
      sessionId,
      workrailSessionId: state.workrailSessionId,
      continueToken,
      checkpointToken,
      sessionWorkspacePath,
      sessionWorktreePath,
      firstStepPrompt,
      state,
      spawnCurrentDepth: trigger.spawnDepth ?? 0,
      spawnMaxDepth: trigger.agentConfig?.maxSubagentDepth ?? 3,
      readFileState: new Map<string, ReadFileState>(),
      agentClient,
      modelId,
      startMs,
      ...(handle !== undefined ? { handle } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// constructTools -- explicitly impure tool construction
// ---------------------------------------------------------------------------

/**
 * Construct the tool list for a daemon agent session.
 *
 * WHY a named function (not inline in runWorkflow): makes the intentional impurity
 * visible at the call site. The tool closures reference side-effecting callbacks
 * (onAdvance, onComplete, onTokenUpdate, onIssueReported) from scope.
 *
 * WHY scope-only (no PreAgentSession): scope is the complete typed boundary for
 * everything constructTools needs. Removing PreAgentSession eliminates the last
 * direct coupling between constructTools and SessionState -- no field on state is
 * read or written here. All values come from scope's explicit, named fields.
 *
 * WHY not exported: this is an internal construction detail. Tests exercise tool
 * behavior through runWorkflow() integration paths.
 */
function constructTools(
  ctx: V2ToolContext,
  apiKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
  scope: SessionScope,
): readonly AgentTool[] {
  const {
    fileTracker, onAdvance, onComplete, onTokenUpdate, onIssueReported,
    getCurrentToken, sessionWorkspacePath, spawnCurrentDepth, spawnMaxDepth,
    emitter, activeSessionSet,
  } = scope;
  const sid = scope.sessionId;
  const workrailSid = scope.workrailSessionId;
  // WHY toMap(): tool factories (makeReadTool, makeWriteTool, makeEditTool) accept
  // Map<string, ReadFileState> directly. Their public signatures cannot change because
  // tests call them directly with Maps. toMap() returns the same Map instance the
  // tracker uses internally, so read-before-write checks remain valid.
  const readFileStateMap = fileTracker.toMap();

  return [
    makeCompleteStepTool(
      sid,
      ctx,
      getCurrentToken,
      onAdvance,
      onComplete,
      onTokenUpdate,
      schemas,
      executeContinueWorkflow,
      emitter,
      workrailSid,
    ),
    makeContinueWorkflowTool(sid, ctx, onAdvance, onComplete, schemas, executeContinueWorkflow, emitter, workrailSid),
    // WHY sessionWorkspacePath: when branchStrategy === 'worktree', all agent file operations
    // must target the isolated worktree, not the main checkout.
    makeBashTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeReadTool(sessionWorkspacePath, readFileStateMap, schemas, sid, emitter, workrailSid),
    makeWriteTool(sessionWorkspacePath, readFileStateMap, schemas, sid, emitter, workrailSid),
    makeGlobTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeGrepTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeEditTool(sessionWorkspacePath, readFileStateMap, schemas, sid, emitter, workrailSid),
    makeReportIssueTool(sid, emitter, workrailSid, undefined, onIssueReported),
    makeSpawnAgentTool(
      sid,
      ctx,
      apiKey,
      workrailSid ?? '',
      spawnCurrentDepth,
      spawnMaxDepth,
      runWorkflow,
      schemas,
      emitter,
      activeSessionSet,
    ),
    makeSignalCoordinatorTool(sid, emitter, workrailSid),
  ];
}

// ---------------------------------------------------------------------------
// buildTurnEndSubscriber -- turn_end event handler factory
// ---------------------------------------------------------------------------

/**
 * Dependencies for the turn_end subscriber.
 *
 * WHY a named interface: makes the dependency surface of the subscriber
 * explicit and visible at the call site in runWorkflow(). All mutations
 * (state, lastFlushedRef) are explicit -- the subscriber is intentionally
 * impure and this interface documents that impurity.
 */
export interface TurnEndSubscriberContext {
  readonly agent: AgentLoop;
  /** Mutable session state -- subscriber increments turnCount and reads stuck signals. */
  readonly state: SessionState;
  readonly stuckConfig: StuckConfig;
  readonly sessionId: string;
  readonly workflowId: string;
  readonly emitter: DaemonEventEmitter | undefined;
  readonly conversationPath: string;
  /**
   * Mutable counter for conversation flush tracking.
   * WHY an object (not a primitive): allows the counter to be shared by reference
   * across multiple turns without re-creating the closure.
   */
  readonly lastFlushedRef: { count: number };
  readonly stuckRepeatThreshold: number;
}

/**
 * Build the turn_end subscriber for the agent loop.
 *
 * Returns a subscriber function that handles: tool_error emission, stuck
 * detection, conversation history flush, and steer injection.
 *
 * WHY a named factory (not inline in runWorkflow): separates the subscription
 * logic from the session setup, making both independently readable.
 *
 * WHY intentionally impure: the subscriber mutates ctx.state (turnCount,
 * terminalSignal via setTerminalSignal, pendingSteerParts) and ctx.lastFlushedRef.count.
 * These mutations are the subscriber's job -- this impurity is by design.
 */
export function buildTurnEndSubscriber(
  ctx: TurnEndSubscriberContext,
): (event: AgentEvent) => Promise<void> {
  return async (event: AgentEvent): Promise<void> => {
    if (event.type !== 'turn_end') return;

    // Emit tool_error events for any tool results that reported isError=true.
    for (const toolResult of event.toolResults) {
      if (toolResult.isError) {
        const errorText = toolResult.result?.content[0]?.text ?? 'tool error';
        ctx.emitter?.emit({ kind: 'tool_error', sessionId: ctx.sessionId, toolName: toolResult.toolName, error: errorText.slice(0, 200), ...withWorkrailSession(ctx.state.workrailSessionId) });
      }
    }

    // Track turns for stuck detection.
    ctx.state.turnCount++;

    const signal = evaluateStuckSignals(ctx.state, ctx.stuckConfig);

    if (signal !== null) {
      if (signal.kind === 'max_turns_exceeded') {
        setTerminalSignal(ctx.state, { kind: 'timeout', reason: 'max_turns' });
        ctx.emitter?.emit({ kind: 'agent_stuck', sessionId: ctx.sessionId, reason: 'timeout_imminent', detail: 'Max-turn limit reached', ...withWorkrailSession(ctx.state.workrailSessionId) });
        ctx.agent.abort();
        return;
      } else if (signal.kind === 'repeated_tool_call') {
        ctx.emitter?.emit({ kind: 'agent_stuck', sessionId: ctx.sessionId, reason: 'repeated_tool_call', detail: `Same tool+args called ${ctx.stuckRepeatThreshold} times: ${signal.toolName}`, toolName: signal.toolName, argsSummary: signal.argsSummary, ...withWorkrailSession(ctx.state.workrailSessionId) });
        void writeStuckOutboxEntry({ workflowId: ctx.workflowId, reason: 'repeated_tool_call', ...(ctx.state.issueSummaries.length > 0 ? { issueSummaries: [...ctx.state.issueSummaries] } : {}) });
        if (ctx.stuckConfig.stuckAbortPolicy !== 'notify_only') {
          if (setTerminalSignal(ctx.state, { kind: 'stuck', reason: 'repeated_tool_call' })) {
            ctx.agent.abort();
            return;
          }
        }
      } else if (signal.kind === 'no_progress') {
        ctx.emitter?.emit({ kind: 'agent_stuck', sessionId: ctx.sessionId, reason: 'no_progress', detail: `${signal.turnCount} turns used, 0 step advances (${signal.maxTurns} turn limit)`, ...withWorkrailSession(ctx.state.workrailSessionId) });
        if (ctx.stuckConfig.noProgressAbortEnabled) {
          void writeStuckOutboxEntry({ workflowId: ctx.workflowId, reason: 'no_progress', ...(ctx.state.issueSummaries.length > 0 ? { issueSummaries: [...ctx.state.issueSummaries] } : {}) });
          if (ctx.stuckConfig.stuckAbortPolicy !== 'notify_only') {
            if (setTerminalSignal(ctx.state, { kind: 'stuck', reason: 'no_progress' })) {
              ctx.agent.abort();
              return;
            }
          }
        }
      } else if (signal.kind === 'timeout_imminent') {
        ctx.emitter?.emit({ kind: 'agent_stuck', sessionId: ctx.sessionId, reason: 'timeout_imminent', detail: `${signal.timeoutReason === 'wall_clock' ? 'Wall-clock timeout' : 'Max-turn limit'} reached`, ...withWorkrailSession(ctx.state.workrailSessionId) });
      } else {
        assertNever(signal);
      }
    }

    // Conversation history: delta-append after each turn.
    flushConversation(ctx.agent.state.messages, ctx.lastFlushedRef, ctx.conversationPath, appendConversationMessages);

    // Steer injection: drain pendingSteerParts into the next turn.
    injectPendingSteps(ctx.state, ctx.agent);
  };
}

// ---------------------------------------------------------------------------
// buildAgentCallbacks -- observability callback wiring
// ---------------------------------------------------------------------------

/**
 * Build the AgentLoopCallbacks that wire daemon event emission to the agent loop.
 *
 * Pure: no I/O, no side effects -- each callback calls emitter?.emit() which is
 * fire-and-forget (void, errors swallowed by AgentLoop's try/catch guards).
 * onToolCallStarted also updates the stuck-detection ring buffer in state.
 */
export function buildAgentCallbacks(
  sessionId: string,
  state: SessionState,
  modelId: string,
  emitter: DaemonEventEmitter | undefined,
  stuckRepeatThreshold: number,
  workflowId?: string,
): AgentLoopCallbacks {
  return {
    onLlmTurnStarted: ({ messageCount }) => {
      emitter?.emit({ kind: 'llm_turn_started', sessionId, messageCount, modelId, ...withWorkrailSession(state.workrailSessionId) });
    },
    onLlmTurnCompleted: ({ stopReason, outputTokens, inputTokens, toolNamesRequested }) => {
      emitter?.emit({ kind: 'llm_turn_completed', sessionId, stopReason, outputTokens, inputTokens, toolNamesRequested, ...withWorkrailSession(state.workrailSessionId) });
    },
    onToolCallStarted: ({ toolName, argsSummary }) => {
      emitter?.emit({ kind: 'tool_call_started', sessionId, toolName, argsSummary, ...withWorkrailSession(state.workrailSessionId) });
      // WHY here: fires synchronously before tool.execute() so the ring buffer reflects
      // the most recent tool calls at turn_end check time. Bounded at stuckRepeatThreshold.
      recordToolCall(state, toolName, argsSummary, stuckRepeatThreshold);
    },
    onToolCallCompleted: ({ toolName, durationMs, resultSummary }) => {
      emitter?.emit({ kind: 'tool_call_completed', sessionId, toolName, durationMs, resultSummary, ...withWorkrailSession(state.workrailSessionId) });
    },
    onToolCallFailed: ({ toolName, durationMs, errorMessage }) => {
      emitter?.emit({ kind: 'tool_call_failed', sessionId, toolName, durationMs, errorMessage, ...withWorkrailSession(state.workrailSessionId) });
    },
    onStallDetected: () => {
      // WHY setTerminalSignal before emitting: buildSessionResult() reads terminalSignal
      // after the loop exits. Setting it here (in the timer callback, synchronously
      // before abort() resolves) ensures the correct reason is recorded even if the
      // abort path completes before the next turn_end fires.
      // WHY setTerminalSignal (not direct write): first-writer-wins -- if repeated_tool_call
      // or no_progress already fired, we preserve the prior signal rather than overwriting it.
      setTerminalSignal(state, { kind: 'stuck', reason: 'stall' });
      emitter?.emit({
        kind: 'agent_stuck',
        sessionId,
        reason: 'stall',
        detail: `No LLM API call started within the stall timeout window. Last tool calls: ${state.lastNToolCalls.map((c) => c.toolName).join(', ') || 'none'}`,
        ...withWorkrailSession(state.workrailSessionId),
      });
      // Write stuck outbox entry so coordinator can route the stalled session.
      // WHY workflowId ?? sessionId: workflowId is always provided by buildPreAgentReadySession
      // call site (passed from trigger.workflowId). The fallback to sessionId maintains
      // backward compat with any test/caller that omits the optional param.
      void writeStuckOutboxEntry({
        workflowId: workflowId ?? sessionId,
        reason: 'stall',
        ...(state.issueSummaries.length > 0 ? { issueSummaries: [...state.issueSummaries] } : {}),
      });
    },
  };
}


// ---------------------------------------------------------------------------
// buildAgentReadySession -- context loading + tool construction + AgentLoop setup
// ---------------------------------------------------------------------------

/**
 * Construct everything the agent loop needs, given a PreAgentSession.
 *
 * This function handles: onAdvance/onComplete callback construction, tool
 * construction via SessionScope, context loading (soul + workspace + session
 * notes via DefaultContextLoader), session config assembly (buildSessionContext),
 * AgentLoop construction, and wiring the abort callback into the session handle.
 *
 * WHY a named function (not inline in runWorkflow): makes the setup phase
 * independently readable and testable. The boundary is clean: everything from
 * after buildPreAgentSession() returns 'ready' up to and including
 * handle?.setAgent(agent) belongs here.
 *
 * WHY not pure: constructs closures (onAdvance, onComplete) that capture and
 * mutate session.state. This impurity is documented via the SessionScope pattern.
 */
async function buildAgentReadySession(
  preAgentSession: PreAgentSession,
  trigger: WorkflowTrigger,
  ctx: V2ToolContext,
  apiKey: string,
  sessionId: string,
  emitter: DaemonEventEmitter | undefined,
  daemonRegistry: DaemonRegistry | undefined,
  activeSessionSet: ActiveSessionSet | undefined,
): Promise<AgentReadySession> {
  const { state, firstStepPrompt, sessionWorkspacePath, sessionWorktreePath, agentClient, modelId } = preAgentSession;
  const startContinueToken = preAgentSession.continueToken;
  const handle = preAgentSession.handle;

  const MAX_ISSUE_SUMMARIES = 10;
  const STUCK_REPEAT_THRESHOLD = 3;

  const onAdvance = (stepText: string, continueToken: string): void => {
    advanceStep(state, stepText, continueToken);
    if (state.workrailSessionId !== null) daemonRegistry?.heartbeat(state.workrailSessionId);
    emitter?.emit({ kind: 'step_advanced', sessionId, ...withWorkrailSession(state.workrailSessionId) });
  };

  const onComplete = (notes: string | undefined, artifacts?: readonly unknown[]): void => {
    recordCompletion(state, notes, artifacts);
  };

  // ---- Schemas + tool construction ----
  const schemas = getSchemas();
  // WHY SessionScope: bundles all per-session tool dependencies into a single typed
  // object instead of individual positional params. Follows the TurnEndSubscriberContext
  // and FinalizationContext patterns. fileTracker wraps session.readFileState in the
  // FileStateTracker interface while preserving the same Map instance for tool factories.
  const scope: SessionScope = {
    fileTracker: new DefaultFileStateTracker(preAgentSession.readFileState),
    onAdvance,
    onComplete,
    onTokenUpdate: (t: string) => { updateToken(state, t); },
    onIssueReported: (summary: string) => {
      if (state.issueSummaries.length < MAX_ISSUE_SUMMARIES) {
        state.issueSummaries.push(summary);
      }
    },
    onSteer: (text: string) => { state.pendingSteerParts.push(text); },
    getCurrentToken: () => state.currentContinueToken,
    sessionWorkspacePath,
    spawnCurrentDepth: preAgentSession.spawnCurrentDepth,
    spawnMaxDepth: preAgentSession.spawnMaxDepth,
    workrailSessionId: state.workrailSessionId,
    emitter,
    sessionId,
    workflowId: trigger.workflowId,
    activeSessionSet,
  };
  const tools = constructTools(ctx, apiKey, schemas, scope);

  // ---- I/O phase: load context (soul + workspace + session notes) ----
  // WHY: load before Agent construction -- the system prompt is set at init
  // time and is not mutable after. All loads are best-effort; errors are
  // logged but never abort the session.
  //
  // Phase 1 (loadBase): soul + workspace -- both are independent of the WorkRail
  // session token. loadBase injects loadDaemonSoul and loadWorkspaceContext, which
  // run concurrently inside DefaultContextLoader.loadBase().
  //
  // Phase 2 (loadSession): session notes -- requires startContinueToken to decode
  // the WorkRail sessionId for the session store lookup. For fresh sessions (no
  // node_output_appended events yet), loadSessionNotes returns [] and sessionState is ''.
  // For checkpoint-resumed sessions, it returns prior step notes for continuity.
  //
  // WHY system prompt instead of agent.steer(): steer() fires AFTER LLM responses,
  // not before. Populating the system prompt at construction time is the correct
  // pre-step-1 injection point.
  //
  // trigger.soulFile is already cascade-resolved by trigger-store.ts:
  //   trigger soulFile -> workspace soulFile -> undefined (global fallback in loadDaemonSoul)
  //
  // NOTE: DefaultContextLoader.loadBase uses trigger.workspacePath (not sessionWorkspacePath).
  // For worktree sessions, the context files (CLAUDE.md / AGENTS.md) live in the
  // main checkout, not the isolated worktree. The worktree only contains the agent's
  // working changes. See DefaultContextLoader.loadBase() WHY comment.
  const contextLoader = new DefaultContextLoader(loadDaemonSoul, loadWorkspaceContext, loadSessionNotes, ctx);
  const baseCtx = await contextLoader.loadBase(trigger);
  const contextBundle = await contextLoader.loadSession(startContinueToken, baseCtx);

  // ---- Pure phase: build session configuration from pre-loaded I/O ----
  // buildSessionContext() is synchronous and pure -- it assembles the system
  // prompt, initial prompt, and session limits from the loaded data and trigger config.
  // WHY separated from I/O: makes prompt assembly testable without any fs or LLM mocking.
  // WHY effectiveWorkspacePath (not sessionWorkspacePath directly): buildSessionContext
  // requires a string, not string|undefined. The caller resolves the value here so the
  // type system enforces an explicit decision -- there is no silent fallback inside the
  // function. For worktree sessions, effectiveWorkspacePath is the isolated worktree;
  // for branchStrategy:'none', it equals trigger.workspacePath.
  const effectiveWorkspacePath = sessionWorkspacePath ?? trigger.workspacePath;
  const sessionCtx = buildSessionContext(
    trigger,
    contextBundle,
    firstStepPrompt || 'No step content available',
    effectiveWorkspacePath,
  );

  // ---- Observability callbacks for AgentLoop ----
  const agentCallbacks = buildAgentCallbacks(sessionId, state, modelId, emitter, STUCK_REPEAT_THRESHOLD, trigger.workflowId);

  // ---- AgentLoop (one per runWorkflow() call, not reused) ----
  // WHY AgentLoop instead of pi-agent-core's Agent: AgentLoop is the first-party
  // replacement that uses @anthropic-ai/sdk directly, eliminating the private npm
  // package dependency. The client (Anthropic or AnthropicBedrock) is injected --
  // AgentLoop has no knowledge of API keys or AWS credentials.
  const agent = new AgentLoop({
    systemPrompt: sessionCtx.systemPrompt,
    modelId,
    tools,
    client: agentClient,
    // Sequential execution: continue_workflow must complete before Bash begins
    // on the next step. Workflow tools have ordering requirements.
    toolExecution: 'sequential',
    callbacks: agentCallbacks,
    // WHY: per-trigger token ceiling configured in agentConfig.maxOutputTokens.
    // When absent, AgentLoop defaults to 8192 (unchanged behavior).
    // The value is passed through as-is; the Anthropic API enforces model-specific limits.
    ...(trigger.agentConfig?.maxOutputTokens !== undefined
      ? { maxTokens: trigger.agentConfig.maxOutputTokens }
      : {}),
    // WHY: stallTimeoutMs from sessionCtx is always defined (buildSessionContext uses
    // DEFAULT_STALL_TIMEOUT_SECONDS as fallback). Passing it unconditionally enables
    // stall detection for all sessions. To disable stall detection, set
    // agentConfig.stallTimeoutSeconds to 0 in triggers.yml -- the AgentLoop silently
    // ignores stallTimeoutMs <= 0 values.
    stallTimeoutMs: sessionCtx.stallTimeoutMs,
  });

  // ---- Wire abort capability into the session handle ----
  // setAgent() closes the TDZ gap: the handle was registered before AgentLoop existed;
  // now that agent is constructed, setAgent() wires in the abort callback.
  // abort() before setAgent() is a safe no-op, so SIGTERM during context loading
  // does not crash -- the session just runs to completion or hits the wall-clock timeout.
  handle?.setAgent(agent);

  return {
    preAgentSession,
    contextBundle,
    scope,
    tools,
    sessionCtx,
    handle,
    sessionId,
    workflowId: trigger.workflowId,
    worktreePath: sessionWorktreePath,
    agent,
    stuckRepeatThreshold: STUCK_REPEAT_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// runAgentLoop -- agent prompt loop with timeout, stuck detection, and cleanup
// ---------------------------------------------------------------------------

/**
 * Run the agent prompt loop to completion (or timeout/error).
 *
 * Handles: stuck-detection config, conversation history persistence,
 * turn-end subscription, wall-clock timeout, and the try/catch/finally
 * lifecycle (conversation flush, timeout cancel, handle disposal).
 *
 * Returns a SessionOutcome describing the loop's raw exit signal. The final
 * session outcome (stuck vs timeout vs success) is determined by
 * buildSessionResult() reading state.terminalSignal after this function returns.
 *
 * WHY a named function (not inline in runWorkflow): makes the agent loop
 * independently readable. The boundary is clean: everything from stuckConfig
 * setup through handle?.dispose() in finally belongs here.
 *
 * WHY intentionally impure: mutates session.preAgentSession.state (turnCount,
 * terminalSignal via setTerminalSignal, stepAdvanceCount, pendingSteerParts) via the
 * turn_end subscriber and tool callbacks. This impurity is by design and is
 * documented in the SessionState interface.
 */
async function runAgentLoop(
  session: AgentReadySession,
  trigger: WorkflowTrigger,
  conversationPath: string,
): Promise<SessionOutcome> {
  const { agent, preAgentSession, sessionCtx, sessionId, handle } = session;
  const { state } = preAgentSession;
  const { emitter } = session.scope;
  const { stuckRepeatThreshold } = session;

  // ---- Session limits (wall-clock timeout + max-turn limit) ----
  // Provided by buildSessionContext() -- resolved from trigger.agentConfig with
  // hardcoded defaults as fallback. Destructured here for clarity.
  const { sessionTimeoutMs, maxTurns } = sessionCtx;

  // ---- Stuck detection configuration ----
  // WHY resolved here: these are read-only trigger config values. They do not change
  // during the session and should not be re-computed on every turn_end invocation.
  const stuckConfig: StuckConfig = {
    maxTurns,
    stuckAbortPolicy: trigger.agentConfig?.stuckAbortPolicy ?? 'abort',
    noProgressAbortEnabled: trigger.agentConfig?.noProgressAbortEnabled ?? false,
    stuckRepeatThreshold,
  };

  // ---- Conversation history persistence ----
  // Per-session JSONL file written incrementally after each turn_end and flushed
  // in the finally block. Each line is a JSON.stringify(AgentInternalMessage).
  // WHY initialized to 0: the first turn_end flush includes the initial user message
  // (appended in prompt() before _runLoop() starts) as well as the first LLM response.
  // WHY fire-and-forget: write failures must never affect the agent loop.
  // WHY conversationPath as parameter: computed once in runWorkflow() and shared with
  // the finalizationCtx so both use the identical path, eliminating duplicate formula.
  // WHY lastFlushedRef as object: the mutable counter must be shared by reference
  // between the turn_end subscriber (via buildTurnEndSubscriber) and the finally block
  // final flush below. A primitive let cannot be shared by reference across a closure boundary.
  const lastFlushedRef = { count: 0 };

  // ---- Event subscription: steer() for step injection + turn-limit enforcement ----
  // Using steer() NOT followUp(): steer fires after each tool batch inside the
  // inner loop; followUp fires only when the agent would otherwise stop
  // (adding an extra LLM turn per workflow step).
  const unsubscribe = agent.subscribe(buildTurnEndSubscriber({
    agent,
    state,
    stuckConfig,
    sessionId,
    workflowId: trigger.workflowId,
    emitter,
    conversationPath,
    lastFlushedRef,
    stuckRepeatThreshold,
  }));

  let stopReason = 'stop';
  let errorMessage: string | undefined;
  // WHY hoisted: timeoutHandle must be accessible in the finally block to cancel the
  // timer on successful completion. Promise constructor callbacks are synchronous
  // (ES6 spec), so timeoutHandle is always assigned before the await resolves.
  // The undefined initial value is required by TypeScript types; the undefined guard
  // in finally is defensive (technically unreachable in a spec-compliant JS engine).
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    // ---- Whole-workflow timeout ----
    // If the agent loop does not complete within sessionTimeoutMs, abort the agent
    // and propagate a timeout through the existing error-handling path.
    // agent.abort() is idempotent -- AgentLoop sets activeRun to null after abort.
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        setTerminalSignal(state, { kind: 'timeout', reason: 'wall_clock' });
        reject(new Error('Workflow timed out'));
      }, sessionTimeoutMs);
    });
    console.log(`[WorkflowRunner] Agent loop started: sessionId=${sessionId} workflowId=${trigger.workflowId} modelId=${preAgentSession.modelId}`);
    await Promise.race([agent.prompt(buildUserMessage(sessionCtx.initialPrompt)), timeoutPromise])
      .catch((err: unknown) => {
        agent.abort();
        throw err;
      });

    // Extract stop reason from the last assistant message.
    // Note: findLast is ES2023; use a reverse-scan loop for ES2020 compat.
    const messages = agent.state.messages;
    let lastAssistant: (typeof messages[number] & { role: 'assistant' }) | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if ('role' in m && m.role === 'assistant') {
        lastAssistant = m as typeof lastAssistant;
        break;
      }
    }
    stopReason = lastAssistant?.stopReason ?? 'stop';
    errorMessage = lastAssistant?.errorMessage;

  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    stopReason = 'error';
  } finally {
    unsubscribe();
    // ---- Conversation history: final flush ----
    // Catch any remaining messages not covered by the last turn_end (e.g. error
    // messages appended by _appendErrorMessage() after an API error or abort).
    // Fire-and-forget: write failures in finally must never propagate.
    const remainingMessages = agent.state.messages.slice(lastFlushedRef.count);
    void appendConversationMessages(conversationPath, remainingMessages).catch(() => {});

    // Cancel the wall-clock timer so it does not fire after successful completion
    // and call setTerminalSignal unnecessarily. clearTimeout on an
    // already-fired or undefined handle is a safe no-op.
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    // Dispose the session handle: deregisters from ActiveSessionSet so steer() stops
    // working and activeSessionSet.size decrements (shutdown drain window terminates).
    // WHY in finally: must run even on error or abort.
    handle?.dispose();
    console.log(`[WorkflowRunner] Agent loop ended: sessionId=${sessionId} stopReason=${stopReason}${errorMessage ? ` error=${errorMessage.slice(0, 120)}` : ''}`);
  }

  // Map raw loop exit to the SessionOutcome discriminated union.
  // WHY 'aborted' when stopReason === 'error': the catch block always sets stopReason
  // to 'error' on any thrown error (timeout, API error, abort). This is the only
  // condition under which the loop exits via the catch path.
  if (stopReason === 'error') {
    return { kind: 'aborted', errorMessage };
  }
  return { kind: 'completed', stopReason, errorMessage };
}

// ---------------------------------------------------------------------------
// finalizeSession -- session cleanup
// ---------------------------------------------------------------------------

/**
 * Consolidate all session cleanup I/O for a completed runWorkflow() call.
 *
 * WHY NOT in runner/: finalizeSession calls writeExecutionStats (io/), uses
 * fs directly for sidecar deletion, and needs sidecardLifecycleFor + tagToStatsOutcome
 * (core/). Moving it to runner/ would require runner/ -> io/ + core/ imports, which
 * is already the correct direction. Deferred to the runner/ function extraction follow-on.
 */
export async function finalizeSession(
  result: WorkflowRunResult,
  ctx: FinalizationContext,
): Promise<void> {
  const outcome = tagToStatsOutcome(result._tag);
  const detail = result._tag === 'stuck' ? result.reason
    : result._tag === 'timeout' ? result.reason
    : result._tag === 'error' ? result.message.slice(0, 200)
    : result._tag === 'delivery_failed' ? result.deliveryError.slice(0, 200)
    : result.stopReason;
  ctx.emitter?.emit({
    kind: 'session_completed',
    sessionId: ctx.sessionId,
    workflowId: ctx.workflowId,
    outcome,
    detail,
    ...withWorkrailSession(ctx.workrailSessionId),
  });

  if (ctx.workrailSessionId !== null) {
    ctx.daemonRegistry?.unregister(
      ctx.workrailSessionId,
      result._tag === 'success' || result._tag === 'delivery_failed' ? 'completed' : 'failed',
    );
  }

  writeExecutionStats(ctx.statsDir, ctx.sessionId, ctx.workflowId, ctx.startMs, outcome, ctx.stepAdvanceCount);

  const lifecycle = sidecardLifecycleFor(result._tag, ctx.branchStrategy);
  switch (lifecycle.kind) {
    case 'delete_now':
      await fs.unlink(path.join(ctx.sessionsDir, `${ctx.sessionId}.json`)).catch(() => {});
      break;
    case 'retain_for_delivery':
      break;
    default:
      assertNever(lifecycle);
  }

  if (result._tag === 'success' && ctx.branchStrategy !== 'worktree') {
    await fs.unlink(ctx.conversationPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a WorkRail workflow session autonomously to completion.
 *
 * The caller is responsible for providing a valid V2ToolContext (from the shared
 * DI container). Do NOT call createWorkRailEngine() inside this function --
 * the engineActive guard blocks a second instance when the MCP server is running
 * in the same process.
 *
 * @param trigger - The workflow to run and its context.
 * @param ctx - The V2ToolContext from the shared DI container.
 * @param apiKey - Anthropic API key for the Claude model.
 * @param daemonRegistry - Optional registry for tracking live daemon sessions.
 *   When provided, register/heartbeat/unregister are called at the appropriate
 *   lifecycle points. When omitted, registry operations are skipped.
 * @param emitter - Optional event emitter for structured lifecycle events.
 *   When provided, emits session_started, tool_called, tool_error, step_advanced,
 *   and session_completed events. When omitted, no events are emitted (zero overhead).
 * @returns WorkflowRunResult discriminated union. Never throws.
 */
export async function runWorkflow(
  trigger: WorkflowTrigger,
  ctx: V2ToolContext,
  apiKey: string,
  daemonRegistry?: DaemonRegistry,
  emitter?: DaemonEventEmitter,
  activeSessionSet?: ActiveSessionSet,
  // Injectable for testing -- defaults to DAEMON_STATS_DIR and DAEMON_SESSIONS_DIR.
  // WHY: enables unit tests to verify stats file content and sidecar lifecycle
  // without touching real ~/.workrail/data or ~/.workrail/daemon-sessions directories.
  _statsDir?: string,
  _sessionsDir?: string,
  /**
   * Optional pre-allocated session source.
   *
   * WHY: replaces WorkflowTrigger._preAllocatedStartResponse (removed in A9).
   * Callers that pre-allocate a session (console dispatch, coordinator spawnSession,
   * spawn_agent, crash recovery) pass kind: 'pre_allocated' so buildPreAgentSession
   * skips its own executeStartWorkflow() call. Callers that want the default flow
   * (allocate internally) pass kind: 'allocate' or omit this parameter entirely.
   */
  source?: SessionSource,
): Promise<WorkflowRunResult> {
  // ---- Resolved dirs (injectable for tests) ----
  const statsDir = _statsDir ?? DAEMON_STATS_DIR;
  const sessionsDir = _sessionsDir ?? DAEMON_SESSIONS_DIR;

  // ---- Execution timing (for calibration of session timeouts) ----
  // WHY at entry: captures the true start before any early-exit paths (model validation,
  // start_workflow failure, worktree creation failure). A startMs captured after these
  // paths would miss their duration entirely.
  const startMs = Date.now();

  // ---- Session ID (process-local, crash safety) ----
  // Each runWorkflow() call generates a unique UUID that keys the per-session
  // state file in sessionsDir. This UUID is NOT the WorkRail server session ID --
  // it is a process-local identifier. The server continueToken is stored as a value
  // inside the file, so crash-resume can retrieve it.
  const sessionId = randomUUID();
  console.log(`[WorkflowRunner] Session started: sessionId=${sessionId} workflowId=${trigger.workflowId}`);

  // Emit session_started event immediately after session ID is assigned.
  // WHY workrailSessionId absent here: the continueToken is not yet decoded at this
  // point (executeStartWorkflow has not been called yet). workrailSessionId is added
  // to subsequent per-session events after the token decode completes below.
  emitter?.emit({
    kind: 'session_started',
    sessionId,
    workflowId: trigger.workflowId,
    workspacePath: trigger.workspacePath,
  });

  // ---- Pre-agent I/O phase ----
  // All setup (model validation, start_workflow, token decode, persistTokens,
  // worktree creation, registry setup) is delegated to buildPreAgentSession().
  // This function returns { kind: 'complete', result } for all early-exit cases
  // (model error, start failure, worktree failure, persist failure, single-step
  // completion) and { kind: 'ready', session } when the agent loop should run.
  const preResult = await buildPreAgentSession(
    trigger, ctx, apiKey, sessionId, startMs,
    statsDir, sessionsDir, emitter, daemonRegistry, activeSessionSet,
    source,
  );
  if (preResult.kind === 'complete') {
    // Early-exit paths (model error, start failure, persist failure, worktree failure,
    // instant single-step completion) all go through finalizeSession so stats, sidecar
    // deletion, event emission, and registry cleanup happen in one place.
    // conversationPath is not meaningful for early exits but FinalizationContext requires it;
    // the path will never exist so the deletion attempt in finalizeSession is a silent no-op.
    const earlyCtx: FinalizationContext = {
      sessionId,
      workrailSessionId: preResult.workrailSessionId,
      startMs,
      stepAdvanceCount: 0,
      branchStrategy: trigger.branchStrategy,
      statsDir,
      sessionsDir,
      conversationPath: path.join(sessionsDir, `${sessionId}-conversation.jsonl`),
      emitter,
      daemonRegistry,
      workflowId: trigger.workflowId,
    };
    preResult.handle?.dispose();
    await finalizeSession(preResult.result, earlyCtx);
    return preResult.result;
  }

  // ---- Agent-ready phase: context loading + tool construction + AgentLoop setup ----
  const readySession = await buildAgentReadySession(
    preResult.session, trigger, ctx, apiKey, sessionId,
    emitter, daemonRegistry, activeSessionSet,
  );

  // ---- Agent loop phase: run prompt loop to completion ----
  const conversationPath = path.join(sessionsDir, `${sessionId}-conversation.jsonl`);
  const outcome = await runAgentLoop(readySession, trigger, conversationPath);

  // Map SessionOutcome back to the raw stopReason/errorMessage that buildSessionResult expects.
  const stopReason = outcome.kind === 'aborted' ? 'error' : outcome.stopReason;
  const errorMessage = outcome.errorMessage;

  // ---- Build finalization context (shared across all result paths) ----
  const { state, sessionWorktreePath } = readySession.preAgentSession;
  const finalizationCtx: FinalizationContext = {
    sessionId,
    workrailSessionId: state.workrailSessionId,
    startMs,
    stepAdvanceCount: state.stepAdvanceCount,
    branchStrategy: trigger.branchStrategy,
    statsDir,
    sessionsDir,
    conversationPath,
    emitter,
    daemonRegistry,
    workflowId: trigger.workflowId,
  };

  // ---- Build and finalize result ----
  // buildSessionResult() is pure -- it reads state and trigger config, produces the result.
  // finalizeSession() handles all I/O: event emission, registry cleanup, stats, sidecar deletion.
  const result = buildSessionResult(state, stopReason, errorMessage, trigger, sessionId, sessionWorktreePath);
  await finalizeSession(result, finalizationCtx);
  return result;
}
