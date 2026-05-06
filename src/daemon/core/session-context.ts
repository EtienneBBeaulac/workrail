/**
 * Session configuration assembly for daemon agent sessions.
 *
 * WHY this module: buildSessionContext and SessionContext are pure -- no I/O,
 * no node: imports, no SDK deps. Given a ContextBundle and trigger config,
 * the function produces the system prompt, initial prompt, and session limits.
 *
 * WHY DEFAULT_* constants live here: they govern session limits and are used
 * by buildSessionContext (and by buildSessionResult for error message wording).
 * Exporting them from this module keeps the pure core self-contained.
 *
 * WHY no node: or @anthropic-ai/* imports: this module is part of the functional
 * core. It must be importable in any test context without I/O stubs.
 */

import type { WorkflowTrigger } from '../types.js';
import type { ContextBundle } from '../context-loader.js';
import type { EnricherResult } from '../workflow-enricher.js';
import { buildSystemPrompt, buildSessionRecap } from './system-prompt.js';

// ---------------------------------------------------------------------------
// Default session limits (exported for use by buildSessionResult and tests)
// ---------------------------------------------------------------------------

/**
 * Default wall-clock time limit (in minutes) for a single workflow run.
 *
 * WHY: a stuck tool call, infinite retry loop, or runaway LLM can hold a
 * queue slot indefinitely. This cap is the safety valve.
 *
 * This default is used when no agentConfig.maxSessionMinutes is configured.
 * Per-trigger overrides are set via triggers.yml agentConfig.maxSessionMinutes.
 */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;

/**
 * Default maximum number of LLM turns per agent session.
 *
 * This default is used when no agentConfig.maxTurns is configured.
 * WHY: prevents infinite retry loops when the LLM keeps calling continue_workflow
 * with a broken token. 200 turns provides a generous safety net for complex
 * autonomous workflows (e.g. wr.discovery deep codebase exploration) without
 * being the bottleneck -- wall-clock maxSessionMinutes is the primary cap.
 */
export const DEFAULT_MAX_TURNS = 200;

/**
 * Default number of seconds without a new LLM API call before the agent loop
 * is considered stalled and aborted.
 *
 * WHY 120 seconds: a legitimate tool call (bash, git, file I/O) should complete
 * well within 120s. A tool call that runs longer than 2 minutes with no LLM
 * activity is almost certainly hung (network timeout, file lock, deadlock).
 */
export const DEFAULT_STALL_TIMEOUT_SECONDS = 120;

// ---------------------------------------------------------------------------
// SessionContext
// ---------------------------------------------------------------------------

/**
 * Everything the agent loop needs, produced by buildSessionContext().
 * Pure value -- no I/O, no closures, no mutable state.
 */
export interface SessionContext {
  readonly systemPrompt: string;
  readonly initialPrompt: string;
  readonly sessionTimeoutMs: number;
  readonly maxTurns: number;
  /**
   * Per-turn stall detection timeout in milliseconds.
   * Passed directly to AgentLoopOptions.stallTimeoutMs.
   */
  readonly stallTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// buildSessionContext
// ---------------------------------------------------------------------------

/**
 * Build the session configuration from a ContextBundle and the first step prompt.
 *
 * Intentionally synchronous and pure -- all I/O (soul file, workspace context,
 * session notes) is resolved by the caller before invoking this function.
 * WHY: keeps the function unit-testable by passing pre-loaded values directly,
 * without requiring any I/O or mocking in tests.
 *
 * @param trigger - The workflow trigger (provides agentConfig limits and context).
 * @param context - The ContextBundle from DefaultContextLoader.loadSession().
 * @param firstStepPrompt - The first step's pending prompt from executeStartWorkflow
 *   or the pre-allocated AllocatedSession.
 * @param effectiveWorkspacePath - The workspace path the agent must work in.
 *   Callers compute this as: sessionWorkspacePath ?? trigger.workspacePath.
 *   Required so the type system forces callers to make an explicit decision.
 */
export function buildSessionContext(
  trigger: WorkflowTrigger,
  context: ContextBundle,
  firstStepPrompt: string,
  effectiveWorkspacePath: string,
  enricherResult?: EnricherResult,
): SessionContext {
  // ---- Flatten ContextBundle to the primitives buildSystemPrompt expects ----
  // WHY flatten here (not in DefaultContextLoader): buildSystemPrompt() is a stable
  // pure function that predates ContextBundle. Flattening at the call site in
  // buildSessionContext() keeps DefaultContextLoader decoupled from the prompt layer.
  const workspaceContext: string | null = context.workspaceRules[0]?.content ?? null;
  const sessionNotes: readonly string[] = context.sessionHistory.map((n) => n.content);

  // ---- System prompt ----
  const sessionState = buildSessionRecap(sessionNotes);
  const systemPrompt = buildSystemPrompt(trigger, sessionState, context.soulContent, workspaceContext, effectiveWorkspacePath, enricherResult);

  // ---- Initial prompt ----
  // WHY no continueToken in the initial prompt: the daemon uses complete_step which
  // manages the token internally. Including the token would invite the LLM to store
  // it and call continue_workflow (deprecated) instead of complete_step.
  const contextJson = trigger.context
    ? `\n\nTrigger context:\n\`\`\`json\n${JSON.stringify(trigger.context, null, 2)}\n\`\`\``
    : '';

  const initialPrompt =
    firstStepPrompt +
    contextJson +
    '\n\nComplete all step work, then call complete_step with your notes to advance.';

  // ---- Session limits ----
  // Resolved from trigger.agentConfig with hardcoded defaults as fallback.
  const sessionTimeoutMs =
    (trigger.agentConfig?.maxSessionMinutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES) * 60 * 1000;
  const maxTurns = trigger.agentConfig?.maxTurns ?? DEFAULT_MAX_TURNS;
  const stallTimeoutMs =
    (trigger.agentConfig?.stallTimeoutSeconds ?? DEFAULT_STALL_TIMEOUT_SECONDS) * 1000;

  return { systemPrompt, initialPrompt, sessionTimeoutMs, maxTurns, stallTimeoutMs };
}
