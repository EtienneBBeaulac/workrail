/**
 * Agent loop setup and execution for daemon workflow sessions.
 *
 * WHY this module: five functions that are all part of the agent loop lifecycle
 * -- TurnEndSubscriberContext (interface), buildTurnEndSubscriber, buildAgentCallbacks,
 * buildAgentReadySession, buildUserMessage, and runAgentLoop. They belong together
 * in runner/ (the orchestration layer), not in workflow-runner.ts.
 *
 * WHY runner/ imports io/ and core/: runner/ is the orchestration layer.
 * Correct direction: runner/ -> io/ (for appendConversationMessages) and
 * runner/ -> core/ (for buildSessionContext, buildSessionResult, etc.).
 */

import type { AgentLoop, AgentEvent, AgentLoopCallbacks } from '../agent-loop.js';
import { AgentLoop as AgentLoopClass } from '../agent-loop.js';
import type { V2ToolContext } from '../../mcp/types.js';
import type { DaemonRegistry } from '../../v2/infra/in-memory/daemon-registry/index.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import type { SessionState } from '../state/session-state.js';
import type { StuckConfig } from '../state/stuck-detection.js';
import {
  setTerminalSignal,
  evaluateStuckSignals,
  advanceStep,
  recordCompletion,
  updateToken,
  recordToolCall,
} from '../state/index.js';
import { buildSessionContext } from '../core/session-context.js';
import { buildSessionResult } from '../core/session-result.js';
import { buildAgentClient } from '../core/agent-client.js';
import { assertNever } from '../../runtime/assert-never.js';
import { loadDaemonSoul, loadWorkspaceContext, loadSessionNotes } from '../io/index.js';
import { appendConversationMessages, writeStuckOutboxEntry } from '../io/index.js';
import { DefaultContextLoader } from '../context-loader.js';
import { type SessionScope, DefaultFileStateTracker } from '../session-scope.js';
import { ActiveSessionSet } from '../active-sessions.js';
import { withWorkrailSession } from '../tools/_shared.js';
import { injectPendingSteps } from '../turn-end/step-injector.js';
import { flushConversation } from '../turn-end/conversation-flusher.js';
import type { WorkflowTrigger } from '../types.js';
import type { PreAgentSession, AgentReadySession, SessionOutcome } from './runner-types.js';
import { getSchemas } from './tool-schemas.js';
import { constructTools } from './construct-tools.js';
import type { runWorkflow } from '../workflow-runner.js';

// ---------------------------------------------------------------------------
// TurnEndSubscriberContext
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

// ---------------------------------------------------------------------------
// buildTurnEndSubscriber
// ---------------------------------------------------------------------------

/**
 * Build the turn_end subscriber for the agent loop.
 *
 * Returns a subscriber function that handles: tool_error emission, stuck
 * detection, conversation history flush, and steer injection.
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
// buildAgentCallbacks
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
      setTerminalSignal(state, { kind: 'stuck', reason: 'stall' });
      emitter?.emit({
        kind: 'agent_stuck',
        sessionId,
        reason: 'stall',
        detail: `No LLM API call started within the stall timeout window. Last tool calls: ${state.lastNToolCalls.map((c) => c.toolName).join(', ') || 'none'}`,
        ...withWorkrailSession(state.workrailSessionId),
      });
      void writeStuckOutboxEntry({
        workflowId: workflowId ?? sessionId,
        reason: 'stall',
        ...(state.issueSummaries.length > 0 ? { issueSummaries: [...state.issueSummaries] } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// buildUserMessage (private helper)
// ---------------------------------------------------------------------------

/** Build a user message for the agent loop. */
function buildUserMessage(text: string): { role: 'user'; content: string; timestamp: number } {
  return { role: 'user', content: text, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// buildAgentReadySession
// ---------------------------------------------------------------------------

/**
 * Construct everything the agent loop needs, given a PreAgentSession.
 *
 * WHY a named function: makes the setup phase independently readable.
 * WHY not pure: constructs closures (onAdvance, onComplete) that capture and
 * mutate session.state. This impurity is documented via the SessionScope pattern.
 */
export async function buildAgentReadySession(
  preAgentSession: PreAgentSession,
  trigger: WorkflowTrigger,
  ctx: V2ToolContext,
  apiKey: string,
  sessionId: string,
  emitter: DaemonEventEmitter | undefined,
  daemonRegistry: DaemonRegistry | undefined,
  activeSessionSet: ActiveSessionSet | undefined,
  runWorkflowFn: typeof runWorkflow,
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
  const tools = constructTools(ctx, apiKey, schemas, scope, runWorkflowFn);

  // ---- I/O phase: load context (soul + workspace + session notes) ----
  const contextLoader = new DefaultContextLoader(loadDaemonSoul, loadWorkspaceContext, loadSessionNotes, ctx);
  const baseCtx = await contextLoader.loadBase(trigger);
  const contextBundle = await contextLoader.loadSession(startContinueToken, baseCtx);

  // ---- Pure phase: build session configuration ----
  const effectiveWorkspacePath = sessionWorkspacePath;
  const sessionCtx = buildSessionContext(
    trigger,
    contextBundle,
    firstStepPrompt || 'No step content available',
    effectiveWorkspacePath,
  );

  // ---- Observability callbacks for AgentLoop ----
  const agentCallbacks = buildAgentCallbacks(sessionId, state, modelId, emitter, STUCK_REPEAT_THRESHOLD, trigger.workflowId);

  // ---- AgentLoop construction ----
  const agent = new AgentLoopClass({
    systemPrompt: sessionCtx.systemPrompt,
    modelId,
    tools,
    client: agentClient,
    toolExecution: 'sequential',
    callbacks: agentCallbacks,
    ...(trigger.agentConfig?.maxOutputTokens !== undefined
      ? { maxTokens: trigger.agentConfig.maxOutputTokens }
      : {}),
    stallTimeoutMs: sessionCtx.stallTimeoutMs,
  });

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
// runAgentLoop
// ---------------------------------------------------------------------------

/**
 * Run the agent prompt loop to completion (or timeout/error).
 *
 * Returns a SessionOutcome describing the loop's raw exit signal. The final
 * session outcome is determined by buildSessionResult() reading state.terminalSignal.
 *
 * WHY intentionally impure: mutates session.preAgentSession.state via the
 * turn_end subscriber and tool callbacks.
 */
export async function runAgentLoop(
  session: AgentReadySession,
  trigger: WorkflowTrigger,
  conversationPath: string,
): Promise<SessionOutcome> {
  const { agent, preAgentSession, sessionCtx, sessionId, handle } = session;
  const { state } = preAgentSession;
  const { emitter } = session.scope;
  const { stuckRepeatThreshold } = session;

  const { sessionTimeoutMs, maxTurns } = sessionCtx;

  const stuckConfig: StuckConfig = {
    maxTurns,
    stuckAbortPolicy: trigger.agentConfig?.stuckAbortPolicy ?? 'abort',
    noProgressAbortEnabled: trigger.agentConfig?.noProgressAbortEnabled ?? false,
    stuckRepeatThreshold,
  };

  const lastFlushedRef = { count: 0 };

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
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
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
    const remainingMessages = agent.state.messages.slice(lastFlushedRef.count);
    void appendConversationMessages(conversationPath, remainingMessages).catch(() => {});
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    handle?.dispose();
    console.log(`[WorkflowRunner] Agent loop ended: sessionId=${sessionId} stopReason=${stopReason}${errorMessage ? ` error=${errorMessage.slice(0, 120)}` : ''}`);
  }

  if (stopReason === 'error') {
    return { kind: 'aborted', errorMessage };
  }
  return { kind: 'completed', stopReason, errorMessage };
}
