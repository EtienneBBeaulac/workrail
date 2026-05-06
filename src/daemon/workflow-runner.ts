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
import {
  getSchemas,
  WORKTREES_DIR,
  constructTools,
  finalizeSession,
  buildPreAgentSession,
  buildTurnEndSubscriber,
  buildAgentCallbacks,
  buildAgentReadySession,
  runAgentLoop,
} from './runner/index.js';
import type {
  PreAgentSession,
  PreAgentSessionResult,
  AgentReadySession,
  SessionOutcome,
  FinalizationContext,
  TurnEndSubscriberContext,
} from './runner/index.js';
export type {
  PreAgentSession,
  PreAgentSessionResult,
  AgentReadySession,
  SessionOutcome,
  FinalizationContext,
  TurnEndSubscriberContext,
} from './runner/index.js';
export { WORKTREES_DIR } from './runner/runner-types.js';
export {
  buildPreAgentSession,
  buildTurnEndSubscriber,
  buildAgentCallbacks,
  finalizeSession,
} from './runner/index.js';
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
    emitter, daemonRegistry, activeSessionSet, runWorkflow,
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
