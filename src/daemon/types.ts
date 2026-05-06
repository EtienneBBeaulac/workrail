/**
 * Domain types for the WorkTrain daemon.
 *
 * WHY this module exists: these types are consumed by the trigger layer
 * (trigger-router.ts, coordinator-deps.ts, etc.), the console layer
 * (console-routes.ts), and the daemon's own sub-modules (context-loader.ts,
 * session-scope.ts, tools/). They previously lived in workflow-runner.ts,
 * which imports AnthropicBedrock, node:fs, and node:child_process -- forcing
 * every consumer to load the full I/O graph just to reference a data type.
 *
 * This module has zero runtime dependencies. Any import from here that pulls
 * in node: modules or SDK packages is a bug.
 *
 * NOT in this module: runner-internal types that depend on AgentLoop,
 * DaemonEventEmitter, DaemonRegistry, or SessionScope (PreAgentSession,
 * AgentReadySession, FinalizationContext, TurnEndSubscriberContext,
 * SessionContext, SessionOutcome). Those stay in workflow-runner.ts until
 * the runner/ extraction in a future refactor.
 */

// ---------------------------------------------------------------------------
// ReadFileState
// ---------------------------------------------------------------------------

/**
 * Per-file read state stored inside the session-scoped readFileState Map.
 *
 * WHY: Read, Edit, and Write tools share this Map to enforce read-before-write
 * and detect file modification between read and write.
 */
export type ReadFileState = { content: string; timestamp: number; isPartialView: boolean };

// ---------------------------------------------------------------------------
// WorkflowTrigger
// ---------------------------------------------------------------------------

/**
 * Input for a single autonomous workflow run.
 *
 * The daemon receives this from the trigger system (Step 4) and passes it here.
 */
export interface WorkflowTrigger {
  /** ID of the workflow to run (e.g. "wr.coding-task"). */
  readonly workflowId: string;
  /** Short description of what the workflow should accomplish. */
  readonly goal: string;
  /** Absolute path to the workspace directory for tool execution. */
  readonly workspacePath: string;
  /** Initial context variables to pass to the workflow. */
  readonly context?: Readonly<Record<string, unknown>>;
  /**
   * Reference URLs to inject into the system prompt so the agent can fetch
   * and read them before starting. Sourced from TriggerDefinition.referenceUrls.
   * Kept here so workflow-runner.ts remains decoupled from trigger system types.
   */
  readonly referenceUrls?: readonly string[];
  /**
   * Agent configuration overrides. Sourced from TriggerDefinition.agentConfig.
   * Kept here so workflow-runner.ts remains decoupled from trigger system types.
   */
  readonly agentConfig?: {
    readonly model?: string;
    /**
     * Maximum wall-clock time (in minutes) for this workflow run.
     * See TriggerDefinition.agentConfig.maxSessionMinutes for full documentation.
     * Default: 30 minutes.
     */
    readonly maxSessionMinutes?: number;
    /**
     * Maximum number of LLM response turns for this workflow run.
     * See TriggerDefinition.agentConfig.maxTurns for full documentation.
     * Default: no limit.
     */
    readonly maxTurns?: number;
    /**
     * Maximum number of output tokens allowed in a single LLM response.
     * See TriggerDefinition.agentConfig.maxOutputTokens for full documentation.
     * Default: 8192 (AgentLoop built-in, applied when field is absent).
     */
    readonly maxOutputTokens?: number;
    /**
     * Maximum spawn depth for nested spawn_agent calls.
     * Root sessions have depth 0. Each child adds 1. When a session's depth reaches
     * this limit, spawn_agent returns a typed error without spawning.
     * Default: 3. Configurable per-trigger for workflows that intentionally delegate deeply.
     */
    readonly maxSubagentDepth?: number;
    /**
     * Abort policy when stuck detection fires.
     * - 'abort' (default): call agent.abort() and return _tag: 'stuck'.
     * - 'notify_only': write to outbox.jsonl but do NOT abort the session.
     *   Use for research workflows where the repeated_tool_call heuristic may
     *   fire on legitimate retry sequences.
     *
     * Default: 'abort'.
     */
    readonly stuckAbortPolicy?: 'abort' | 'notify_only';
    /**
     * When true, the no_progress heuristic (80%+ of turns with 0 step advances)
     * also participates in stuck-abort (subject to stuckAbortPolicy).
     *
     * Default: false. The no_progress heuristic has real false-positive risk on
     * research sessions that spend many turns reading before advancing. Only set
     * this to true for workflows where zero advances at 80% turns is always a bug.
     */
    readonly noProgressAbortEnabled?: boolean;
    /**
     * Number of seconds without a new LLM API call before the agent loop is
     * considered stalled and aborted.
     *
     * A stall occurs when a tool call hangs (network timeout, file lock, silent
     * deadlock) -- the loop is inside _executeTools() and never calls
     * client.messages.create() again. Without this timer, the session holds its
     * queue slot for up to maxSessionMinutes (up to 55-65 minutes).
     *
     * See DEFAULT_STALL_TIMEOUT_SECONDS for the default (120 seconds).
     * Per-trigger overrides are set via triggers.yml agentConfig.stallTimeoutSeconds.
     */
    readonly stallTimeoutSeconds?: number;
  };
  /**
   * WorkRail session ID of the parent session that spawned this one.
   *
   * WHY: Written to the `session_created` event in the session store so the parent-child
   * relationship is durable and survives crashes. Enables the console DAG view to render
   * the session tree. Set only by makeSpawnAgentTool() -- root sessions have no parent.
   *
   * WHY a first-class field (not in context map): if parentSessionId were in the generic
   * `context` map, any code that overwrites context could silently lose the parent link.
   * A typed field cannot be accidentally lost and is immediately visible to reviewers.
   *
   * NOTE: This field is not read by runWorkflow() directly. The actual parentSessionId
   * write to session_created.data is performed by makeSpawnAgentTool's executeStartWorkflow()
   * call (via internalContext). runWorkflow() receives a pre_allocated SessionSource for child
   * sessions and skips its own executeStartWorkflow() call. This field exists for
   * documentation purposes and potential future use.
   */
  readonly parentSessionId?: string;
  /**
   * Spawn depth of this session in the session tree.
   *
   * Root sessions have depth 0. Each spawn_agent call increments the depth by 1.
   * The spawn_agent tool reads this from its closure (set at factory construction
   * time by runWorkflow()) to enforce the maxSubagentDepth limit.
   *
   * WHY a first-class field (not in context map): if spawnDepth were in the generic
   * `context` map, any code that overwrites context could silently break depth enforcement.
   * A typed field cannot be accidentally lost, silently overwritten, or misused.
   */
  readonly spawnDepth?: number;
  /**
   * Optional resolved soul file path. Sourced from TriggerDefinition.soulFile
   * (already cascade-resolved by trigger-store.ts: trigger soulFile -> workspace soulFile).
   * When absent, loadDaemonSoul() falls back to ~/.workrail/daemon-soul.md.
   * Kept here so workflow-runner.ts remains decoupled from trigger system types.
   */
  readonly soulFile?: string;
  /**
   * Optional bot identity for git commit attribution in autonomous sessions.
   * Set by queue-poll dispatch (polling-scheduler.ts doPollGitHubQueue).
   *
   * When present, workflow-runner.ts runs:
   *   git -C <workspacePath> config user.name <name>
   *   git -C <workspacePath> config user.email <email>
   * after session initialization, before the agent loop begins.
   *
   * WHY deterministic (not delegated to LLM): git attribution is infra, not agent work.
   * WHY non-fatal: if git config fails, session continues with default git config.
   *
   * Default: undefined (no identity override).
   */
  readonly botIdentity?: {
    readonly name: string;
    readonly email: string;
  };
  /**
   * Branch isolation strategy for this workflow session.
   * Sourced from TriggerDefinition.branchStrategy (parsed from triggers.yml).
   * - 'worktree': runWorkflow() creates an isolated git worktree before the agent loop.
   * - 'none': no worktree; session writes directly to trigger.workspacePath.
   * When absent, defaults to 'none' behavior.
   * Kept here so workflow-runner.ts remains decoupled from trigger system types.
   */
  readonly branchStrategy?: 'worktree' | 'none';
  /**
   * Base branch for the worktree. Only used when branchStrategy === 'worktree'.
   * Sourced from TriggerDefinition.baseBranch.
   * Default: 'main' (applied at parse time in trigger-store.ts or at use time in runWorkflow()).
   */
  readonly baseBranch?: string;
  /**
   * Prefix for the session branch name. Only used when branchStrategy === 'worktree'.
   * Sourced from TriggerDefinition.branchPrefix.
   * Default: 'worktrain/' (applied at parse time or at use time in runWorkflow()).
   */
  readonly branchPrefix?: string;
}

// ---------------------------------------------------------------------------
// SessionSource discriminated union (A8)
// ---------------------------------------------------------------------------

/**
 * A session that was fully allocated by the caller before the agent loop.
 * Used when the caller needs the session ID synchronously (console dispatch,
 * spawnSession, crash recovery).
 *
 * WHY this type: replaces the former implicit contract encoded in the
 * removed WorkflowTrigger._preAllocatedStartResponse field with an explicit,
 * named type. Callers that pre-allocate a session now hold an AllocatedSession
 * value passed via SessionSource rather than an ad-hoc optional field.
 */
export interface AllocatedSession {
  /** Continue token from executeStartWorkflow response. */
  readonly continueToken: string;
  readonly checkpointToken?: string | null;
  /** First step prompt from the session. May be empty if isComplete. */
  readonly firstStepPrompt: string;
  readonly isComplete: boolean;
  /**
   * Source of this session (daemon trigger or MCP client).
   * WHY stored here: feeds the "Session trigger source attribution" backlog item --
   * writing this to the run_started event makes daemon vs MCP attribution permanent
   * and queryable from the event log. Not yet wired to the event; the field is in
   * place so the wire-up is a one-liner when that work is done.
   */
  readonly triggerSource: 'daemon' | 'mcp';
  /**
   * Effective workspace path for this session -- the directory the agent should work in.
   *
   * WHY here (not on WorkflowTrigger): the recovery path sets branchStrategy:'none' to
   * suppress worktree re-creation, but the agent still needs to work in the existing
   * worktree. If we set trigger.workspacePath = worktreePath, then buildSystemPrompt()'s
   * isWorktreeSession check (effectiveWorkspacePath !== trigger.workspacePath) always
   * evaluates false and the scope boundary paragraph is never injected.
   *
   * Carrying the effective path here lets buildPreAgentSession() override sessionWorkspacePath
   * without changing trigger.workspacePath, so the comparison in buildSystemPrompt() stays
   * correct for both fresh and recovered worktree sessions.
   *
   * Only set by the crash recovery path. Normal allocations leave this undefined and
   * buildPreAgentSession() derives sessionWorkspacePath from trigger as usual.
   */
  readonly sessionWorkspacePath?: string;
}

/**
 * Explicit discriminated union for session creation source.
 *
 * WHY: replaces the former _preAllocatedStartResponse optional escape-hatch on
 * WorkflowTrigger with a typed discriminant that makes the two paths explicit.
 * 'allocate' -> buildPreAgentSession calls executeStartWorkflow internally.
 * 'pre_allocated' -> executeStartWorkflow was already called by the caller.
 */
export type SessionSource =
  | { readonly kind: 'allocate'; readonly trigger: WorkflowTrigger }
  | { readonly kind: 'pre_allocated'; readonly trigger: WorkflowTrigger; readonly session: AllocatedSession };

// ---------------------------------------------------------------------------
// WorkflowRunResult discriminated union
// ---------------------------------------------------------------------------

/** Successful completion of a workflow run. */
export interface WorkflowRunSuccess {
  readonly _tag: 'success';
  readonly workflowId: string;
  readonly stopReason: string;
  /**
   * The notesMarkdown from the last continue_workflow call (the final step's notes).
   * Populated when the agent calls continue_workflow with output.notesMarkdown on the
   * completing step. Undefined if the agent did not provide notes on the final step.
   *
   * WHY this field exists: the daemon's trigger layer reads this to extract the
   * structured handoff artifact (commitType, prTitle, filesChanged, etc.) and run
   * git commit + gh pr create as scripts. See src/trigger/delivery-action.ts.
   */
  readonly lastStepNotes?: string;
  /**
   * Artifacts from the last complete_step or continue_workflow call (the final step's artifacts).
   * Populated when the agent calls complete_step or continue_workflow with artifacts[] on the
   * completing step. Undefined if the agent did not provide artifacts on the final step.
   *
   * WHY this field exists: surfaces typed artifacts (e.g. wr.review_verdict) through the result
   * type chain so callers -- including coordinators and spawn_agent parent sessions -- can read
   * structured data without a separate HTTP round-trip.
   */
  readonly lastStepArtifacts?: readonly unknown[];
  /**
   * The isolated worktree path created by runWorkflow() for this session.
   * Present only when trigger.branchStrategy === 'worktree'.
   * Absent for 'none' strategy (session used trigger.workspacePath directly).
   *
   * WHY this field exists: delivery (git add, git commit, git push, gh pr create) runs
   * in trigger-router.ts AFTER runWorkflow() returns. The delivery must use the worktree
   * path (where the agent's changes live), not trigger.workspacePath (the clean main checkout).
   */
  readonly sessionWorkspacePath?: string;
  /**
   * The process-local session UUID for this workflow run.
   * Present only when trigger.branchStrategy === 'worktree'.
   * Absent for 'none' strategy.
   *
   * WHY this field exists: trigger-router.ts uses sessionId for branch assertion before
   * git push (verifying HEAD matches the expected branch name `branchPrefix + sessionId`).
   */
  readonly sessionId?: string;
  /**
   * Bot identity sourced from trigger.botIdentity.
   * Present only when trigger.botIdentity is set.
   *
   * WHY this field exists: trigger-router.ts reads this to pass per-command identity
   * flags to runDelivery() via DeliveryFlags.botIdentity.
   */
  readonly botIdentity?: {
    readonly name: string;
    readonly email: string;
  };
}

/** Failed workflow run (tool error, agent error, engine error, etc.). */
export interface WorkflowRunError {
  readonly _tag: 'error';
  readonly workflowId: string;
  readonly message: string;
  readonly stopReason: string;
  /** Structured stuck marker for coordinator scripts. Contains WORKTRAIN_STUCK JSON
   * when the session died with an error so scripts can detect and route without LLM. */
  readonly lastStepNotes?: string;
}

/**
 * Workflow run aborted due to a configurable time or turn limit.
 *
 * WHY a separate discriminant: timeout is categorically different from a
 * workflow-logic error. Callers (delivery systems, alerting) need to
 * distinguish "this workflow ran too long / looped" from "a tool failed".
 * Encoding this as a string inside WorkflowRunError.message would require
 * string-parsing, violating 'make illegal states unrepresentable'.
 */
export interface WorkflowRunTimeout {
  readonly _tag: 'timeout';
  readonly workflowId: string;
  /**
   * Which limit was hit.
   * - 'wall_clock': the configured maxSessionMinutes elapsed
   * - 'max_turns': the configured maxTurns count was reached
   */
  readonly reason: 'wall_clock' | 'max_turns';
  readonly message: string;
  /** Always 'aborted' -- the agent loop was stopped via agent.abort(). */
  readonly stopReason: string;
}

/**
 * Workflow run aborted because the agent was detected as stuck before the
 * wall-clock or turn limit fired.
 *
 * WHY a separate discriminant (not reusing 'timeout'): stuck fires before the wall
 * clock, so conflating them forces string-parsing to distinguish the two cases.
 * Separate discriminants keep the union exhaustive and callers honest.
 */
export interface WorkflowRunStuck {
  readonly _tag: 'stuck';
  readonly workflowId: string;
  /**
   * Which heuristic triggered the abort.
   * - 'repeated_tool_call': same tool + same args called STUCK_REPEAT_THRESHOLD (3) times in a row.
   * - 'no_progress': 80%+ of turns used with 0 step advances. Only fires when noProgressAbortEnabled: true.
   * - 'stall': no LLM API call started within stallTimeoutSeconds (default 120).
   */
  readonly reason: 'repeated_tool_call' | 'no_progress' | 'stall';
  readonly message: string;
  /** Always 'aborted' -- the agent loop was stopped via agent.abort(). */
  readonly stopReason: string;
  /**
   * Issue summaries from the agent's report_issue calls during this session.
   * Populated from the issueSummaries ring buffer at abort time.
   * Absent when the agent made no report_issue calls.
   */
  readonly issueSummaries?: readonly string[];
}

/**
 * Workflow completed successfully, but the delivery POST to callbackUrl failed.
 *
 * WHY a separate discriminant: this outcome is categorically different from a
 * workflow failure. The workflow ran to completion -- the work is done. Only the
 * result delivery (HTTP callback) failed. Collapsing this into WorkflowRunError
 * would make it impossible for a caller to distinguish "job done, notification
 * failed" from "job never finished". See GAP-3 in docs/design/daemon-gap-analysis.md.
 */
export interface WorkflowDeliveryFailed {
  readonly _tag: 'delivery_failed';
  readonly workflowId: string;
  /** stopReason from the underlying WorkflowRunSuccess or WorkflowRunError. */
  readonly stopReason: string;
  /** Human-readable description of why the delivery POST failed. */
  readonly deliveryError: string;
}

/** Result of a runWorkflow() call. Never throws. */
export type WorkflowRunResult = WorkflowRunSuccess | WorkflowRunError | WorkflowRunTimeout | WorkflowRunStuck | WorkflowDeliveryFailed;

/**
 * The result variants that runWorkflow() can actually return directly.
 *
 * WHY this type exists: runWorkflow() never produces WorkflowDeliveryFailed. That variant
 * is only created by TriggerRouter after an HTTP callbackUrl POST fails -- a trigger-layer
 * concern that does not apply to the runWorkflow() call itself. Child sessions spawned by
 * spawn_agent bypass TriggerRouter entirely and have no callbackUrl.
 *
 * INVARIANT: WorkflowRunStuck must be added here in the SAME COMMIT as it is added to
 * WorkflowRunResult. The `as ChildWorkflowRunResult` cast at the spawn_agent call site
 * suppresses any compile-time error from a missing update -- only the assertNever guard
 * catches the omission at runtime. Keep these two unions in sync atomically.
 */
export type ChildWorkflowRunResult = WorkflowRunSuccess | WorkflowRunError | WorkflowRunTimeout | WorkflowRunStuck;

// ---------------------------------------------------------------------------
// OrphanedSession (crash recovery)
// ---------------------------------------------------------------------------

/**
 * A session file found in DAEMON_SESSIONS_DIR during startup recovery.
 *
 * Each active runWorkflow() call writes a per-session file to DAEMON_SESSIONS_DIR.
 * A file that survives daemon restart is an orphan: the session that created it
 * did not complete cleanly (crash or kill). readAllDaemonSessions() surfaces these
 * so runStartupRecovery() can log and clear them.
 */
export interface OrphanedSession {
  /** The process-local UUID that was used to key the session file. */
  readonly sessionId: string;
  /** The last persisted continueToken for this session. */
  readonly continueToken: string;
  /** The last persisted checkpointToken (null if none was written). */
  readonly checkpointToken: string | null;
  /** Unix timestamp (ms) when the token was last written. Used for staleness checks. */
  readonly ts: number;
  /**
   * Absolute path to the isolated git worktree created for this session.
   * Present when branchStrategy === 'worktree'; absent for 'none' sessions or
   * sessions created before Issue #627 was implemented (backward compat).
   */
  readonly worktreePath?: string;
  /**
   * WorkRail workflow ID for this session (e.g. 'wr.coding-task').
   * Written to the sidecar by persistTokens() so runStartupRecovery() can reconstruct
   * a WorkflowTrigger for crash recovery. Absent in old-format sidecars -- sessions
   * without this field are discarded (not resumed) for backward compatibility.
   */
  readonly workflowId?: string;
  /**
   * Human-readable goal for this session.
   * Written alongside workflowId for trigger reconstruction at recovery time.
   * Absent in old-format sidecars (backward compat).
   */
  readonly goal?: string;
  /**
   * Original workspacePath passed to runWorkflow() (i.e. trigger.workspacePath).
   * Stored separately from worktreePath: this is the main repo checkout path, while
   * worktreePath (when present) is the isolated git worktree for this session.
   * At recovery: effectiveWorkspacePath = worktreePath (if set and exists) else workspacePath.
   * Absent in old-format sidecars (backward compat).
   */
  readonly workspacePath?: string;
}

// ---------------------------------------------------------------------------
// WorkflowContextSlots
// ---------------------------------------------------------------------------

export interface WorkflowContextSlots {
  /** Coordinator-assembled prior phase context (discovery/shaping/coding handoffs). */
  readonly assembledContextSummary?: string;
}

export function extractContextSlots(context: Readonly<Record<string, unknown>> | undefined): WorkflowContextSlots {
  if (!context) return {};
  const assembledContextSummary = typeof context['assembledContextSummary'] === 'string'
    ? context['assembledContextSummary']
    : undefined;
  return { assembledContextSummary };
}

