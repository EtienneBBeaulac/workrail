/**
 * Runner-internal types for the WorkTrain daemon agent loop.
 *
 * WHY this module: these types are used exclusively within the runner/ layer
 * (buildPreAgentSession, buildAgentReadySession, runAgentLoop, finalizeSession).
 * They depend on AgentLoop, SDK types, SessionState, SessionHandle, DaemonRegistry,
 * DaemonEventEmitter -- definitionally orchestration types.
 *
 * WORKTREES_DIR lives here because it is used exclusively in buildPreAgentSession
 * (where worktrees are created) and in startup recovery. It is re-exported from
 * workflow-runner.ts for backward compatibility with test files that import it.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentLoop, AgentTool } from '../agent-loop.js';
import type { SessionState } from '../state/session-state.js';
import type { SessionContext } from '../core/session-context.js';
import type { ContextBundle } from '../context-loader.js';
import type { SessionScope } from '../session-scope.js';
import type { SessionHandle } from '../active-sessions.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import type { DaemonRegistry } from '../../v2/infra/in-memory/daemon-registry/index.js';
import type { WorkflowRunResult } from '../types.js';
import type { ReadFileState } from '../types.js';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Directory that holds per-session isolated git worktrees.
 * Each runWorkflow() call with branchStrategy === 'worktree' creates a subdirectory
 * at <WORKTREES_DIR>/<sessionId>/ containing the git worktree for that session.
 * Worktrees are removed on successful session completion (after delivery).
 */
export const WORKTREES_DIR = path.join(os.homedir(), '.workrail', 'worktrees');

// ---------------------------------------------------------------------------
// PreAgentSession
// ---------------------------------------------------------------------------

/**
 * All state produced by the pre-agent I/O phase of runWorkflow().
 *
 * WHY a named interface: makes the phase boundary explicit. Everything in this
 * struct was established before `new AgentLoop()` -- the agent binding is NOT
 * included here.
 *
 * WHY `state` is mutable and included here: tool factory closures must observe
 * live token updates (getCurrentToken reads state.currentContinueToken at call
 * time). Making state an explicit field documents the intentional impurity
 * rather than hiding it in ambient scope.
 */
export interface PreAgentSession {
  readonly sessionId: string;
  readonly workrailSessionId: string | null;
  readonly continueToken: string;
  readonly checkpointToken: string | null;
  readonly sessionWorkspacePath: string;
  readonly sessionWorktreePath: string | undefined;
  /**
   * The first step's pending prompt text.
   *
   * WHY string (not the full V2StartWorkflowOutputSchema): only the prompt text
   * is needed downstream (buildSessionContext, buildAgentReadySession). Narrowing
   * to a string here prevents future callers from accidentally depending on
   * schema fields that may change, and removes the dependency on the Zod type.
   */
  readonly firstStepPrompt: string;
  readonly state: SessionState;           // mutable; explicit to document impurity
  readonly spawnCurrentDepth: number;
  readonly spawnMaxDepth: number;
  readonly readFileState: Map<string, ReadFileState>;
  readonly agentClient: Anthropic | AnthropicBedrock;
  readonly modelId: string;
  readonly startMs: number;
  /** Session handle from ActiveSessionSet. Undefined when no activeSessionSet injected. */
  readonly handle?: SessionHandle;
}

/**
 * Result of the pre-agent I/O phase.
 *
 * 'ready'    -- agent loop should run; `session` holds all pre-agent state.
 * 'complete' -- session ended before the agent loop started (instant completion,
 *               model error, start failure, worktree failure, persist failure).
 *               `result` is the final WorkflowRunResult to return from runWorkflow().
 */
export type PreAgentSessionResult =
  | { readonly kind: 'ready'; readonly session: PreAgentSession }
  | {
      readonly kind: 'complete';
      readonly result: WorkflowRunResult;
      readonly workrailSessionId: string | null;
      readonly handle: SessionHandle | undefined;
    };

// ---------------------------------------------------------------------------
// AgentReadySession
// ---------------------------------------------------------------------------

/**
 * Fully constructed pre-loop state -- everything runAgentLoop() needs.
 *
 * Produced by buildAgentReadySession() after context loading and tool
 * construction complete. Holds all pre-loop immutable values so that
 * runAgentLoop() has no knowledge of the setup steps.
 */
export interface AgentReadySession {
  readonly preAgentSession: PreAgentSession;
  readonly contextBundle: ContextBundle;
  readonly scope: SessionScope;
  readonly tools: readonly AgentTool[];
  readonly sessionCtx: SessionContext;
  readonly handle: SessionHandle | undefined;
  readonly sessionId: string;
  readonly workflowId: string;
  readonly worktreePath: string | undefined;
  readonly agent: AgentLoop;
  readonly stuckRepeatThreshold: number;
}

// ---------------------------------------------------------------------------
// SessionOutcome
// ---------------------------------------------------------------------------

/**
 * Terminal state of the agent loop, returned by runAgentLoop().
 *
 * Represents what the agent loop's own exit signal was, NOT the final
 * session outcome (which is determined by buildSessionResult() reading
 * state.terminalSignal after the loop exits).
 *
 * WHY a discriminated union (not raw strings): follows explicit-domain-types
 * philosophy. The two variants map directly to the two code paths through
 * the agent loop's try/catch block.
 */
export type SessionOutcome =
  | { readonly kind: 'completed'; readonly stopReason: string; readonly errorMessage?: string }
  | { readonly kind: 'aborted'; readonly errorMessage?: string };

// ---------------------------------------------------------------------------
// FinalizationContext
// ---------------------------------------------------------------------------

/** Context for finalizing a completed runWorkflow() session. */
export interface FinalizationContext {
  readonly sessionId: string;
  readonly workrailSessionId: string | null;
  readonly startMs: number;
  readonly stepAdvanceCount: number;
  readonly branchStrategy: 'worktree' | 'none' | undefined;
  readonly statsDir: string;
  readonly sessionsDir: string;
  readonly conversationPath: string;
  readonly emitter: DaemonEventEmitter | undefined;
  readonly daemonRegistry: DaemonRegistry | undefined;
  readonly workflowId: string;
}

// ---------------------------------------------------------------------------
// TurnEndSubscriberContext
// ---------------------------------------------------------------------------

// NOTE: TurnEndSubscriberContext remains in workflow-runner.ts alongside
// buildTurnEndSubscriber. It will move to this file in the runner/ function
// extraction follow-on PR, when constructTools() injection is refactored.
