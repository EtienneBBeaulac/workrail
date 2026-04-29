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

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of prior step notes injected into the session state recap.
 * WHY: Caps context window usage. Three notes (~200 tokens each) gives the agent
 * meaningful continuity without bloating the system prompt.
 */
const MAX_SESSION_RECAP_NOTES = 3;

/**
 * Maximum characters per note in the session state recap.
 * WHY: Individual step notes can be long (30+ lines). Truncating at 800 chars
 * preserves the summary while preventing a single verbose note from consuming
 * the entire session state budget.
 */
const MAX_SESSION_NOTE_CHARS = 800;

/**
 * Default wall-clock time limit (in minutes) for a single workflow run.
 *
 * WHY: a stuck tool call, infinite retry loop, or runaway LLM can hold a
 * queue slot indefinitely. This cap is the safety valve.
 *
 * This default is used when no agentConfig.maxSessionMinutes is configured.
 * Per-trigger overrides are set via triggers.yml agentConfig.maxSessionMinutes.
 * If the agent loop does not complete within this window, runWorkflow() aborts
 * the agent and returns { _tag: 'timeout', reason: 'wall_clock' }.
 */
export const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;

/**
 * Default maximum number of LLM turns per agent session.
 *
 * This default is used when no agentConfig.maxTurns is configured.
 * Per-trigger overrides are set via triggers.yml agentConfig.maxTurns.
 * WHY: prevents infinite retry loops when the LLM keeps calling continue_workflow
 * with a broken token -- without a cap, each isError tool_result is visible to the
 * LLM and it will simply retry, looping forever. 200 turns provides a generous
 * safety net for complex autonomous workflows (e.g. wr.discovery deep codebase
 * exploration) without being the bottleneck -- wall-clock maxSessionMinutes is
 * the primary cap for runaway sessions.
 */
export const DEFAULT_MAX_TURNS = 200;

// DAEMON_SESSIONS_DIR is re-exported from './tools/_shared.js' at the top of this file.

/**
 * Maximum age for an orphaned session file before it is treated as definitely stale.
 *
 * Sessions older than this threshold are cleared immediately during startup recovery
 * without additional checks. Tokens from a 2h+ old crash are expired in all realistic
 * configurations -- retaining them is noise.
 */
const MAX_ORPHAN_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Maximum age for an orphaned worktree before it is removed during startup recovery.
 *
 * WHY 24h instead of 2h: failed worktrees are more useful for debugging than session
 * sidecars. A developer investigating a failed session wants the worktree intact for
 * a reasonable inspection window. 24h is long enough for overnight debugging.
 *
 * WHY different from MAX_ORPHAN_AGE_MS: session sidecar files hold tokens that expire
 * quickly (2h is generous). Worktrees hold file state that may be needed for debugging.
 * Using different thresholds makes the different purposes explicit.
 */
const MAX_WORKTREE_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Root directory for WorkRail user data (crash recovery, soul file, etc.).
 * WHY: daemon-soul.md lives alongside daemon-sessions/ in ~/.workrail/, not in
 * the data/ subdirectory controlled by WORKRAIL_DATA_DIR. This is consistent with
 * other files in the ~/.workrail/ root that are not part of the structured data store.
 */
const WORKRAIL_DIR = path.join(os.homedir(), '.workrail');

/**
 * Directory that holds per-session isolated git worktrees.
 * Each runWorkflow() call with branchStrategy === 'worktree' creates a subdirectory
 * at <WORKTREES_DIR>/<sessionId>/ containing the git worktree for that session.
 * Worktrees are removed on successful session completion (after delivery).
 * Failed/timed-out sessions keep their worktree for debugging; runStartupRecovery()
 * reaps orphans older than MAX_WORKTREE_ORPHAN_AGE_MS on the next daemon start.
 */
export const WORKTREES_DIR = path.join(os.homedir(), '.workrail', 'worktrees');

/**
 * Directory that holds execution stats JSONL files written by writeExecutionStats().
 * WHY: each early-exit path and the finally block all write to this same directory.
 * Centralising it as a constant avoids the repeated inline path.join() calls.
 */
const DAEMON_STATS_DIR = path.join(os.homedir(), '.workrail', 'data');

/**
 * Maximum combined byte size of all workspace context files.
 * WHY: Prevents context window bloat from large CLAUDE.md / AGENTS.md files.
 * Approximates 8000 tokens at ~4 bytes/token.
 */
const WORKSPACE_CONTEXT_MAX_BYTES = 32 * 1024;

/**
 * Maximum byte size for injected assembledContextSummary (prior session notes + git diff).
 * WHY: caps the coordinator-assembled context to protect LLM token budget.
 * Mirrors the WORKSPACE_CONTEXT_MAX_BYTES cap pattern used for CLAUDE.md injection.
 */
const MAX_ASSEMBLED_CONTEXT_BYTES = 8192;

/**
 * A literal path entry: a single file at a known relative path.
 * WHY: Claude Code and AGENTS.md paths are stable single-file conventions.
 */
type LiteralCandidatePath = {
  readonly kind: 'literal';
  readonly relativePath: string;
};

/**
 * A glob pattern entry: zero or more files matching a pattern in a directory.
 * WHY: Cursor, Windsurf, and Firebender all use directory-based conventions
 * where teams add multiple rule files. A glob pattern discovers them all.
 */
type GlobCandidatePath = {
  readonly kind: 'glob';
  /** Relative to workspacePath, e.g. '.cursor/rules/*.mdc' */
  readonly pattern: string;
  /**
   * WHY: .mdc (Cursor/Firebender) and .windsurf/rules/*.md files have YAML
   * frontmatter with metadata (alwaysApply, description, etc.) not meant for
   * LLM consumption. Must be stripped before injection.
   */
  readonly stripFrontmatter: boolean;
  /**
   * WHY: tinyglobby order is filesystem-dependent. Alpha sort ensures the same
   * workspace produces the same context on every WorkTrain session.
   */
  readonly sort: 'alpha';
};

type WorkspaceContextCandidate = LiteralCandidatePath | GlobCandidatePath;

/**
 * Maximum files to read per glob pattern.
 * WHY: Prevents I/O cost and context budget waste in repos where .cursor/rules/
 * or similar directories contain many files (generated artifacts, etc.).
 */
const MAX_GLOB_FILES_PER_PATTERN = 20;

/**
 * Candidate workspace context files in priority order.
 * WHY: More specific (tool-specific, project-specific) before more general.
 * User-written Claude Code config takes top priority. Glob formats (newer) come
 * before legacy single-file formats (older) for each tool to reduce duplicate
 * injection when both coexist.
 *
 * Sources:
 *   Claude Code: https://code.claude.com/docs/en/memory (April 2026)
 *   Cursor .cursorrules: empirical (zillow-android-2/.cursorrules)
 *   Cursor .cursor/rules/*.mdc: empirical (zillow-android-2/.cursor/rules/)
 *   Windsurf .windsurf/rules/*.md: https://docs.windsurf.com/windsurf/cascade/memories (April 2026)
 *   Firebender .firebender/rules/*.mdc: empirical (zillow-android-2/.firebender/rules/)
 *   Firebender AGENTS.md: docs/integrations/firebender.md + empirical
 *   GitHub Copilot: https://docs.github.com/en/copilot/customizing-copilot (April 2026)
 *   Continue.dev: https://docs.continue.dev/customize/deep-dives/rules (April 2026)
 *
 * NOTE: .windsurfrules does NOT exist -- Windsurf uses .windsurf/rules/ directory.
 * NOTE: alwaysApply: false rules in .mdc files are injected unconditionally in
 *   Phase 1. Phase 2 will add filtering based on the alwaysApply frontmatter field.
 */
const WORKSPACE_CONTEXT_CANDIDATE_PATHS: readonly WorkspaceContextCandidate[] = [
  { kind: 'literal', relativePath: '.claude/CLAUDE.md' },
  { kind: 'literal', relativePath: 'CLAUDE.md' },
  { kind: 'literal', relativePath: 'CLAUDE.local.md' },
  { kind: 'literal', relativePath: 'AGENTS.md' },
  { kind: 'literal', relativePath: '.github/AGENTS.md' },
  // Cursor: newer directory format before legacy single-file format
  { kind: 'glob', pattern: '.cursor/rules/*.mdc', stripFrontmatter: true, sort: 'alpha' },
  { kind: 'literal', relativePath: '.cursorrules' },
  // Windsurf: directory format only (.windsurfrules does NOT exist per official docs)
  { kind: 'glob', pattern: '.windsurf/rules/*.md', stripFrontmatter: true, sort: 'alpha' },
  // Firebender: both rules directory and AGENTS.md convention
  { kind: 'glob', pattern: '.firebender/rules/*.mdc', stripFrontmatter: true, sort: 'alpha' },
  { kind: 'literal', relativePath: '.firebender/AGENTS.md' },
  // GitHub Copilot
  { kind: 'literal', relativePath: '.github/copilot-instructions.md' },
  // Continue.dev
  { kind: 'glob', pattern: '.continue/rules/*.md', stripFrontmatter: false, sort: 'alpha' },
] as const;

// WHY: Soul content is defined in soul-template.ts (zero imports) so the CLI
// init command can import the template without pulling in this module's heavy
// dependency graph (LLM agent SDK). workflow-runner.ts re-exports both symbols
// for backward compatibility with callers that already import this module.
import { DAEMON_SOUL_DEFAULT, DAEMON_SOUL_TEMPLATE } from './soul-template.js';
export { DAEMON_SOUL_DEFAULT, DAEMON_SOUL_TEMPLATE } from './soul-template.js';

// ---------------------------------------------------------------------------
// File tool state type
// ---------------------------------------------------------------------------

/**
 * Per-file read state stored inside the session-scoped readFileState Map.
 *
 * WHY: Read, Edit, and Write tools share this Map (passed by DI into each factory)
 * to enforce read-before-write and detect file modification between read and write.
 * isPartialView is stored so future tooling can warn when an Edit targets a file
 * that was only partially read.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReadFileState = { content: string; timestamp: number; isPartialView: boolean };

// ---------------------------------------------------------------------------
// Public types
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
  };
  /**
   * Pre-allocated session start result from a caller that already called executeStartWorkflow().
   *
   * WHY: The dispatch HTTP handler and the spawn_agent tool both call executeStartWorkflow()
   * synchronously so they can obtain a session ID before the agent loop starts. They pass
   * the resulting response here so runWorkflow() skips its own executeStartWorkflow() call
   * and starts the agent loop from the pre-created session.
   *
   * INVARIANT: When set, runWorkflow() MUST NOT call executeStartWorkflow() again.
   * The session is already created -- calling it again would create a duplicate session.
   *
   * WHY store the full response (not just the continueToken): runWorkflow() uses
   * `response.pending?.prompt` to build the initial LLM prompt and `response.isComplete`
   * to detect single-step workflows that complete immediately. Both are needed.
   *
   * WHY underscore prefix: signals this is an internal implementation detail, not
   * a user-facing field. Script authors do not set this -- it is set only by the
   * dispatch HTTP handler or the spawn_agent tool.
   */
  readonly _preAllocatedStartResponse?: import('zod').infer<typeof V2StartWorkflowOutputSchema>;
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
   * call (via internalContext). runWorkflow() uses _preAllocatedStartResponse for child
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
   * structured data without a separate HTTP round-trip. The pr-review coordinator currently reads
   * artifacts via HTTP (getAgentResult), but future coordinators or spawn_agent calls can use this.
   *
   * Related: docs/discovery/artifacts-coordinator-channel.md, Candidate A.
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
   * trigger-router.ts reads this field to determine the correct working directory for delivery.
   *
   * Follows the lastStepNotes/lastStepArtifacts precedent of threading session-level
   * context through the result type for trigger-layer consumers.
   */
  readonly sessionWorkspacePath?: string;
  /**
   * The process-local session UUID for this workflow run.
   * Present only when trigger.branchStrategy === 'worktree'.
   * Absent for 'none' strategy.
   *
   * WHY this field exists: trigger-router.ts uses sessionId for branch assertion before
   * git push (verifying HEAD matches the expected branch name `branchPrefix + sessionId`).
   * Threading sessionId here avoids fragile path-parsing: extracting sessionId from
   * sessionWorkspacePath via `.split('/').at(-1)` couples branch naming convention to
   * the caller and breaks if the path structure ever changes.
   *
   * Follows the sessionWorkspacePath threading pattern.
   */
  readonly sessionId?: string;
  /**
   * Bot identity sourced from trigger.botIdentity.
   * Present only when trigger.botIdentity is set.
   * Absent when no bot identity is configured for this trigger.
   *
   * WHY this field exists: trigger-router.ts reads this to pass per-command identity
   * flags to runDelivery() via DeliveryFlags.botIdentity. Threading it here keeps the
   * same pattern as sessionId/sessionWorkspacePath -- trigger-layer consumers read what
   * they need from WorkflowRunSuccess without coupling to WorkflowTrigger internals.
   *
   * Follows the sessionId/sessionWorkspacePath threading pattern.
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
 *
 * WHY 'abort' is the default policy: stuck loops consume queue slots and API quota
 * without producing value. Aborting early is the safe default. Operators running
 * research workflows should set stuckAbortPolicy: 'notify_only' in agentConfig.
 */
export interface WorkflowRunStuck {
  readonly _tag: 'stuck';
  readonly workflowId: string;
  /**
   * Which heuristic triggered the abort.
   * - 'repeated_tool_call': same tool + same args called STUCK_REPEAT_THRESHOLD (3)
   *   times in a row.
   * - 'no_progress': 80%+ of turns used with 0 step advances. Only fires when
   *   noProgressAbortEnabled: true is set in agentConfig (default: false).
   */
  readonly reason: 'repeated_tool_call' | 'no_progress';
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
 * The three result variants that runWorkflow() can actually return.
 *
 * WHY this type exists: runWorkflow() never produces WorkflowDeliveryFailed. That variant
 * is only created by TriggerRouter after an HTTP callbackUrl POST fails -- a trigger-layer
 * concern that does not apply to the runWorkflow() call itself. Child sessions spawned by
 * spawn_agent bypass TriggerRouter entirely and have no callbackUrl.
 *
 * WorkflowRunResult includes delivery_failed because TriggerRouter reassigns the result
 * variable after runWorkflow() returns (GAP-3). ChildWorkflowRunResult captures what
 * runWorkflow() actually produces and makes the architectural invariant explicit at the
 * type level: delivery_failed is an impossible state at the spawn_agent call site.
 *
 * If runWorkflow() ever gains direct callbackUrl support (bypassing TriggerRouter), this
 * type alias must be updated to include WorkflowDeliveryFailed.
 *
 * INVARIANT: WorkflowRunStuck must be added here in the SAME COMMIT as it is added to
 * WorkflowRunResult. The `as ChildWorkflowRunResult` cast at the spawn_agent call site
 * suppresses any compile-time error from a missing update -- only the assertNever guard
 * catches the omission at runtime (crashing the parent session). Keep these two unions
 * in sync atomically.
 */
export type ChildWorkflowRunResult = WorkflowRunSuccess | WorkflowRunError | WorkflowRunTimeout | WorkflowRunStuck;

/**
 * Registry mapping WorkRail session IDs to steer callbacks.
 *
 * Used by the HTTP steer endpoint (POST /api/v2/sessions/:sessionId/steer) to inject
 * text into a running daemon session's next agent turn. When a session starts, it
 * registers a callback; when it ends, it deregisters. The HTTP handler calls the
 * callback directly -- JavaScript's single-threaded event loop makes this safe without
 * any locking (the HTTP handler and the turn_end subscriber cannot interleave).
 *
 * WHY a named type alias (not a class): three trivial operations (set, delete, get/call)
 * don't warrant a class. The Map is the correct data structure; the alias names the
 * domain concept at all call sites.
 *
 * WHY (text: string) => void and not a richer type: the steer callback is a one-way
 * push into the pending steer queue. The HTTP layer handles response serialization;
 * the registry is purely a dispatch table. For v2, consider adding a signalId for
 * request/response correlation (see design-review-findings-mid-session-signaling.md).
 *
 * Daemon-only: this registry is only populated by daemon sessions. MCP-mode sessions
 * do not register callbacks -- the HTTP endpoint returns 404 for their session IDs.
 * TODO(v2): Extend to MCP-mode sessions if mid-step injection proves necessary.
 */
export type SteerRegistry = Map<string, (text: string) => void>;

/**
 * Registry mapping WorkRail session IDs to abort callbacks.
 * Each runWorkflow() call registers () => agent.abort() on session start
 * and deregisters on completion. The shutdown handler calls all callbacks
 * to abort every in-flight AgentLoop simultaneously.
 *
 * WHY alongside SteerRegistry: mirrors the same composition-root injection
 * pattern. Both are constructed in trigger-listener.ts (the composition root),
 * injected through TriggerRouter -> runWorkflow(), and returned on
 * TriggerListenerHandle so the shutdown handler can drain them.
 *
 * Daemon-only: only populated by daemon sessions. MCP-mode sessions do not
 * register callbacks.
 */
export type AbortRegistry = Map<string, () => void>;

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
   * Used by runStartupRecovery() to remove orphan worktrees older than MAX_WORKTREE_ORPHAN_AGE_MS.
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
// Token persistence (crash safety)
// ---------------------------------------------------------------------------

/**
 * Atomically persist the current session tokens to ~/.workrail/daemon-sessions/<sessionId>.json.
 *
 * Uses the temp-file-then-rename pattern so a crash mid-write never leaves a
 * corrupt state file. A previous checkpoint token survives if the rename fails.
 *
 * @param sessionId - Process-local UUID generated at runWorkflow() entry. Keys the file.
 * @param worktreePath - Absolute path to the isolated git worktree for this session.
 *   Present only when branchStrategy === 'worktree'. Persisted so runStartupRecovery()
 *   can remove orphan worktrees on the next daemon start. Omit for 'none' sessions.
 *   WHY persisted immediately after worktree creation (not at session end): a crash
 *   between worktree creation and sidecar write would leave an untracked orphan.
 *   Writing immediately ensures the recovery path can always find the worktree.
 * @param recoveryContext - Optional context fields for crash recovery. Written on the
 *   FIRST persistTokens() call in runWorkflow() so runStartupRecovery() can reconstruct
 *   a WorkflowTrigger if the daemon crashes. Only three fields are persisted (workflowId,
 *   goal, workspacePath) -- agentConfig, soulFile, and history are intentionally excluded
 *   (recovered sessions use daemon defaults per pitch no-gos).
 *   Old sidecars lacking these fields fall through to discard on the next daemon start.
 */
// PersistTokensError is re-exported from './tools/_shared.js' at the top of this file.
// persistTokens is imported from './tools/_shared.js' at the top of this file.

/**
 * Append a batch of AgentInternalMessage values to a per-session conversation JSONL file.
 *
 * WHY fire-and-forget: conversation history is observability/crash-recovery data. A write
 * failure must never affect the agent loop. Callers invoke this as void + .catch(() => {}).
 *
 * WHY JSONL (one JSON object per line): enables incremental delta appends, crash-tolerant
 * reads (discard the last line if it is not valid JSON), and direct jq inspection.
 *
 * WHY append-only: preserves the valid prefix even if the daemon crashes mid-write. Phase B
 * crash recovery uses loadValidatedPrefix semantics (discard invalid last line).
 *
 * @param filePath - Absolute path to the .jsonl file (created on first call if absent).
 * @param messages - New messages since the last flush (the delta for this turn).
 */
async function appendConversationMessages(
  filePath: string,
  messages: ReadonlyArray<AgentInternalMessage>,
): Promise<void> {
  if (messages.length === 0) return;
  const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  await fs.mkdir(DAEMON_SESSIONS_DIR, { recursive: true });
  await fs.appendFile(filePath, lines, 'utf8');
}

/**
 * Read a previously persisted session state from ~/.workrail/daemon-sessions/<sessionId>.json.
 *
 * Returns null if the file does not exist (first run, or already cleaned up after success).
 * The continueToken can be used to resume the session with executeContinueWorkflow().
 *
 * @param sessionId - The process-local UUID that was used when the session was started.
 */
export async function readDaemonSessionState(
  sessionId: string,
): Promise<{ continueToken: string; checkpointToken: string | null } | null> {
  const sessionPath = path.join(DAEMON_SESSIONS_DIR, `${sessionId}.json`);
  try {
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw) as { continueToken: string; checkpointToken: string | null };
    return { continueToken: parsed.continueToken, checkpointToken: parsed.checkpointToken };
  } catch {
    // ENOENT or parse error -- treat as no persisted state
    return null;
  }
}

/**
 * Read all orphaned session files from ~/.workrail/daemon-sessions/.
 *
 * Returns an array of valid, parseable session entries. Corrupt files (JSON parse
 * errors, missing required fields) are skipped with a warning log and left on disk --
 * runStartupRecovery() only deletes files returned by this function. This is an
 * accepted limitation: cleaning up corrupt files would require a second readdir pass,
 * which is not implemented at MVP.
 *
 * Returns an empty array if the directory does not exist (ENOENT on first run) or
 * if no valid session files are found. Never throws.
 *
 * WHY exported: called by runStartupRecovery() and testable in isolation without
 * starting the full daemon listener.
 *
 * @param sessionsDir - Optional override for the sessions directory. Defaults to
 *   DAEMON_SESSIONS_DIR. Pass a temp dir in tests to avoid touching real state.
 */
export async function readAllDaemonSessions(
  sessionsDir: string = DAEMON_SESSIONS_DIR,
): Promise<OrphanedSession[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch (err: unknown) {
    const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isEnoent) {
      console.warn(
        `[WorkflowRunner] Could not read sessions directory ${sessionsDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return [];
  }

  const sessions: OrphanedSession[] = [];

  for (const entry of entries) {
    // Only consider complete session files. Temp files are named <sessionId>.json.tmp
    // (i.e. they end with .tmp, not .json) -- the endsWith('.json') check already
    // excludes them. The belt-and-suspenders check keeps this robust to naming changes.
    // queue-issue-*.json sidecars live in the same directory; skip them here.
    if (!entry.endsWith('.json') || entry.startsWith('queue-issue-')) continue;

    const sessionId = entry.slice(0, -5); // strip .json
    const filePath = path.join(sessionsDir, entry);

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        continueToken?: unknown;
        checkpointToken?: unknown;
        ts?: unknown;
        worktreePath?: unknown;
        workflowId?: unknown;
        goal?: unknown;
        workspacePath?: unknown;
      };

      if (typeof parsed.continueToken !== 'string' || typeof parsed.ts !== 'number') {
        console.warn(`[WorkflowRunner] Skipping malformed session file: ${filePath}`);
        continue;
      }

      sessions.push({
        sessionId,
        continueToken: parsed.continueToken,
        checkpointToken: typeof parsed.checkpointToken === 'string' ? parsed.checkpointToken : null,
        ts: parsed.ts,
        // worktreePath is optional -- absent in sessions created before Issue #627.
        // Use undefined (not null) to match the OrphanedSession.worktreePath? type.
        ...(typeof parsed.worktreePath === 'string' ? { worktreePath: parsed.worktreePath } : {}),
        // Recovery context fields (workflowId, goal, workspacePath) -- written by persistTokens()
        // on the first call in runWorkflow(). Absent in old-format sidecars (backward compat).
        // Sessions lacking workflowId or workspacePath will fall through to discard in
        // runStartupRecovery() rather than being resumed.
        ...(typeof parsed.workflowId === 'string' ? { workflowId: parsed.workflowId } : {}),
        ...(typeof parsed.goal === 'string' ? { goal: parsed.goal } : {}),
        ...(typeof parsed.workspacePath === 'string' ? { workspacePath: parsed.workspacePath } : {}),
      });
    } catch (err: unknown) {
      console.warn(
        `[WorkflowRunner] Skipping unreadable session file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return sessions;
}

/**
 * Scan DAEMON_SESSIONS_DIR for orphaned session files and handle them.
 *
 * Called once during daemon startup, before the HTTP server begins accepting
 * webhook requests. Two recovery behaviors fire unconditionally:
 *
 * Phase A: Delete all queue-issue-*.json sidecars so blocked GitHub issues
 *   become eligible for re-dispatch within one poll cycle (~5 min).
 *
 * Phase B (requires ctx): For each orphaned session, decode the continueToken,
 *   count advance_recorded events in the WorkRail session event log, and apply
 *   the binary evaluateRecovery() policy:
 *   - stepAdvances >= 1 -> attempt resume: rehydrate via executeContinueWorkflow, reconstruct
 *     WorkflowTrigger with _preAllocatedStartResponse, call runWorkflow fire-and-forget.
 *     Falls through to discard if sidecar lacks recovery context fields (backward compat),
 *     if the worktree directory is gone, if rehydrate fails, or if the session is complete.
 *   - stepAdvances === 0 -> discard (sidecar deleted; issue re-dispatched)
 *   When ctx is absent, all sessions fall to discard (backward-compatible behavior).
 *
 * Non-fatal: any error during recovery is caught and logged. The daemon starts
 * regardless of whether recovery succeeds.
 *
 * @param sessionsDir - Optional override for the sessions directory. Defaults to
 *   DAEMON_SESSIONS_DIR. Pass a temp dir in tests to avoid touching real state.
 * @param execFn - Injectable exec function for git worktree removal.
 *   Defaults to execFileAsync. Override in tests to avoid real git calls.
 * @param ctx - Optional V2ToolContext for phase B logic. When provided,
 *   sessions with step advances are resumed rather than discarded.
 * @param _countStepAdvancesFn - Injectable step-count implementation for testing.
 *   Defaults to the real countOrphanStepAdvances() implementation.
 * @param _executeContinueWorkflowFn - Injectable continue-workflow implementation for testing.
 *   Used in the resume path to call intent: 'rehydrate' and get the current step prompt.
 *   Defaults to the real executeContinueWorkflow().
 * @param _runWorkflowFn - Injectable runWorkflow implementation for testing.
 *   Used in the resume path to start a new agent loop from the current step.
 *   Defaults to the real runWorkflow(). Passed as fire-and-forget in production.
 * @param apiKey - Anthropic API key forwarded to runWorkflow() on the resume path.
 *   Injected by the caller (startTriggerListener) rather than read from process.env
 *   so this function stays boundary-clean. Defaults to '' for tests that do not
 *   exercise the resume path.
 */
export async function runStartupRecovery(
  sessionsDir: string = DAEMON_SESSIONS_DIR,
  execFn: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }> = execFileAsync,
  ctx?: V2ToolContext,
  _countStepAdvancesFn: typeof countOrphanStepAdvances = countOrphanStepAdvances,
  _executeContinueWorkflowFn: typeof executeContinueWorkflow = executeContinueWorkflow,
  _runWorkflowFn: typeof runWorkflow = runWorkflow,
  // WHY last / default '': adding after all injectable params keeps every existing call
  // site valid without positional changes. Production passes the key from startTriggerListener;
  // tests that don't exercise the resume path can omit it.
  apiKey: string = '',
): Promise<void> {
  // Phase A: Delete all queue-issue-*.json sidecars unconditionally.
  // WHY first: queue-issue cleanup is independent of session state and must
  // always run, even if session recovery fails or ctx is absent.
  await clearQueueIssueSidecars(sessionsDir);

  // Read all parseable session files.
  const sessions = await readAllDaemonSessions(sessionsDir);

  if (sessions.length === 0) {
    // Also attempt to clear any stray .tmp files left from a crash mid-write.
    await clearStrayTmpFiles(sessionsDir);
    return;
  }

  console.log(`[WorkflowRunner] Startup recovery: found ${sessions.length} orphaned session(s).`);

  const now = Date.now();
  let cleared = 0;
  let preserved = 0;

  for (const session of sessions) {
    const ageMs = now - session.ts;
    const isStale = ageMs > MAX_ORPHAN_AGE_MS;
    const ageSec = Math.round(ageMs / 1000);

    // Orphan worktree cleanup: if this session created a worktree and the worktree
    // has been orphaned long enough (24h), remove it.
    //
    // WHY different age threshold (MAX_WORKTREE_ORPHAN_AGE_MS = 24h) from session sidecar
    // threshold (MAX_ORPHAN_AGE_MS = 2h): failed worktrees are useful for debugging.
    // A developer investigating a failed session wants the worktree intact for a reasonable
    // inspection window. Session sidecars hold expired tokens; worktrees hold file state.
    //
    // WHY best-effort (try/catch, log + continue): worktree removal must never block
    // daemon startup. A non-removable worktree (e.g. disk full, path deleted by user)
    // is logged and skipped; the session sidecar is still deleted so the next startup
    // does not attempt the removal again.
    if (session.worktreePath && ageMs > MAX_WORKTREE_ORPHAN_AGE_MS) {
      console.log(
        `[WorkflowRunner] Removing orphan worktree: sessionId=${session.sessionId} worktreePath=${session.worktreePath}`,
      );
      try {
        await execFn('git', ['worktree', 'remove', '--force', session.worktreePath]);
        console.log(`[WorkflowRunner] Removed orphan worktree: ${session.worktreePath}`);
      } catch (err: unknown) {
        // Best-effort: log and continue. The sidecar will still be deleted below so
        // the next startup does not attempt this removal again.
        console.warn(
          `[WorkflowRunner] Could not remove orphan worktree ${session.worktreePath}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (session.worktreePath && ageMs <= MAX_WORKTREE_ORPHAN_AGE_MS) {
      // Worktree exists but is not yet old enough to reap. Keep it for debugging.
      const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1);
      console.log(
        `[WorkflowRunner] Keeping recent orphan worktree: sessionId=${session.sessionId} ` +
        `age=${ageHours}h (threshold=24h) worktreePath=${session.worktreePath}`,
      );
    }

    // Phase B: Resume-or-discard decision when ctx is available.
    // When ctx is absent, fall through to discard (same as previous behavior).
    if (ctx !== undefined) {
      let stepAdvances = 0;
      try {
        stepAdvances = await _countStepAdvancesFn(session.continueToken, ctx);
      } catch (err: unknown) {
        // Non-fatal: if step count fails, fall through to discard.
        console.warn(
          `[WorkflowRunner] Could not count step advances for orphaned session ${session.sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)} -- falling back to discard`,
        );
      }

      const action = evaluateRecovery({ stepAdvances, ageMs });

      // Exhaustive switch: assertNever prevents silent fall-through if
      // RecoveryAction gains new variants in the future.
      switch (action) {
        case 'resume': {
          // Phase B: attempt to resume an orphaned session that had meaningful progress.
          //
          // Required conditions (all must pass; any failure falls through to discard):
          //   1. Sidecar has workflowId + workspacePath (written by persistTokens since Phase B).
          //      Old-format sidecars (missing fields) are discarded for backward compatibility.
          //   2. Session is not stale (age <= MAX_ORPHAN_AGE_MS = 2h).
          //   3. If a worktree was used: the worktree directory still exists on disk.
          //      (No worktree re-creation -- pitch no-go #7.)
          //   4. Rehydrate call succeeds (executeContinueWorkflow returns ok).
          //   5. Session is not already complete and has a pending step.

          const hasContext = typeof session.workflowId === 'string' &&
            typeof session.workspacePath === 'string';

          if (!hasContext) {
            console.log(
              `[WorkflowRunner] Startup recovery: cannot resume session ${session.sessionId} -- ` +
              `missing workflowId/workspacePath in sidecar (old format). Discarding.`,
            );
            break; // fall through to sidecar deletion
          }

          if (isStale) {
            console.log(
              `[WorkflowRunner] Startup recovery: discarding stale resumable session ${session.sessionId} ` +
              `(age=${ageSec}s > ${MAX_ORPHAN_AGE_MS / 1000}s threshold).`,
            );
            break;
          }

          // Worktree existence check: if the session used a worktree, verify it is still on disk.
          // WHY: runWorkflow with branchStrategy: 'none' uses worktreePath as workspacePath.
          // A missing worktree means the agent would fail immediately on any file operation.
          // Discarding is safer than re-creating (pitch no-go #7).
          if (session.worktreePath !== undefined) {
            let worktreeExists = true;
            try {
              await fs.access(session.worktreePath);
            } catch {
              worktreeExists = false;
            }
            if (!worktreeExists) {
              console.log(
                `[WorkflowRunner] Startup recovery: discarding session ${session.sessionId} -- ` +
                `worktree no longer exists at ${session.worktreePath}.`,
              );
              break;
            }
          }

          // Rehydrate: call executeContinueWorkflow with intent: 'rehydrate' to get the current
          // step prompt and a fresh continueToken, without advancing the session.
          let rehydrateResult: Awaited<ReturnType<typeof _executeContinueWorkflowFn>>;
          try {
            rehydrateResult = await _executeContinueWorkflowFn(
              { continueToken: session.continueToken, intent: 'rehydrate' },
              ctx!,
            );
          } catch (err: unknown) {
            console.warn(
              `[WorkflowRunner] Startup recovery: rehydrate failed for session ${session.sessionId}: ` +
              `${err instanceof Error ? err.message : String(err)}. Discarding.`,
            );
            break;
          }

          if (rehydrateResult.isErr()) {
            console.warn(
              `[WorkflowRunner] Startup recovery: rehydrate error for session ${session.sessionId}: ` +
              `${rehydrateResult.error.kind}. Discarding.`,
            );
            break;
          }

          const rehydrated = rehydrateResult.value.response;

          // Only resume if the session has a pending step. isComplete=true means nothing to do.
          if (rehydrated.isComplete || !rehydrated.pending) {
            console.log(
              `[WorkflowRunner] Startup recovery: session ${session.sessionId} is already complete ` +
              `or has no pending step. Discarding.`,
            );
            break;
          }

          // Build the _preAllocatedStartResponse adapter.
          // WHY: runWorkflow() uses _preAllocatedStartResponse to skip executeStartWorkflow()
          // (preventing a duplicate session). V2ContinueWorkflowOutputSchema 'ok' variant and
          // V2StartWorkflowOutputSchema share the fields we care about: continueToken,
          // checkpointToken, isComplete, pending, preferences, nextIntent, nextCall.
          // V2StartWorkflowOutputSchema has optional staleRoots/warnings not present here --
          // they are optional so their absence is correct.
          const preAllocated: import('zod').infer<typeof V2StartWorkflowOutputSchema> = {
            continueToken: rehydrated.continueToken ?? '',
            checkpointToken: rehydrated.checkpointToken,
            isComplete: rehydrated.isComplete,
            pending: rehydrated.pending,
            preferences: rehydrated.preferences,
            nextIntent: rehydrated.nextIntent, // 'rehydrate_only' from rehydrate call; runWorkflow() does not read this field
            nextCall: rehydrated.nextCall,
          };

          // Determine effective workspace: use the worktree path if the session had one
          // (already verified to exist above), otherwise use the original workspacePath.
          const effectiveWorkspacePath = session.worktreePath ?? session.workspacePath!;
          // Suppress worktree re-creation: the worktree already exists (or was never created).
          const branchStrategy: 'none' = 'none';

          const recoveredTrigger: WorkflowTrigger = {
            workflowId: session.workflowId!,
            goal: session.goal ?? 'Resumed session (crash recovery)',
            workspacePath: effectiveWorkspacePath,
            branchStrategy,
            _preAllocatedStartResponse: preAllocated,
          };

          console.log(
            `[WorkflowRunner] Startup recovery: resuming session ${session.sessionId} ` +
            `workflowId=${session.workflowId} stepAdvances=${stepAdvances}`,
          );

          // Fire-and-forget: run the resumed session without blocking startup.
          // The sidecar is NOT deleted here -- runWorkflow() manages its own lifecycle.
          //
          // WHY bypass TriggerRouter semaphore: recovery sessions are rare and bounded by the
          // number of orphaned sidecars (typically 0-2). Routing through TriggerRouter.dispatch()
          // would require a triggerId and blocks on the semaphore -- neither is appropriate here.
          // Same tradeoff as spawn_agent (see makeSpawnAgentTool WHY comment).
          void _runWorkflowFn(
            recoveredTrigger,
            ctx!,
            apiKey,
          ).then((result) => {
            console.log(
              `[WorkflowRunner] Startup recovery: resumed session ${session.sessionId} completed: ${result._tag}`,
            );
          }).catch((err: unknown) => {
            console.warn(
              `[WorkflowRunner] Startup recovery: resumed session ${session.sessionId} failed: ` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
          });

          preserved++;
          continue; // do NOT delete sidecar -- runWorkflow() manages its own lifecycle
        }
        case 'discard': {
          const label = isStale ? 'stale orphaned session' : 'orphaned session';
          console.log(
            `[WorkflowRunner] Discarding ${label}: sessionId=${session.sessionId} ` +
            `stepAdvances=${stepAdvances} age=${ageSec}s`,
          );
          break;
        }
        default:
          assertNever(action);
      }
    } else {
      // No ctx: log discard as before (backward-compatible behavior).
      const label = isStale ? 'stale orphaned session' : 'orphaned session';
      console.log(
        `[WorkflowRunner] Clearing ${label}: sessionId=${session.sessionId} age=${ageSec}s`,
      );
    }

    try {
      await fs.unlink(path.join(sessionsDir, `${session.sessionId}.json`));
      cleared++;
    } catch (err: unknown) {
      // Best-effort: ENOENT means already gone, any other error is logged.
      const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isEnoent) {
        console.warn(
          `[WorkflowRunner] Could not clear session file ${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Also clear any stray .tmp files left from a crash mid-write.
  await clearStrayTmpFiles(sessionsDir);

  if (ctx !== undefined) {
    console.log(
      `[WorkflowRunner] Startup recovery complete: preserved=${preserved} discarded=${cleared}/${sessions.length} orphaned session(s).`,
    );
  } else {
    console.log(`[WorkflowRunner] Startup recovery complete: cleared ${cleared}/${sessions.length} orphaned session(s).`);
  }
}

/**
 * Count the number of step advances (advance_recorded events) in a WorkRail session
 * event log for an orphaned session.
 *
 * WHY exported: testable in isolation via injectable _parseFn and _loadFn params --
 * callers can supply fakes without a real V2ToolContext.
 *
 * The injectable params are pre-bound: _parseFn takes only the raw token string, and
 * _loadFn takes only the sessionId. This keeps the function testable without requiring
 * real tokenCodecPorts or sessionStore instances in tests.
 *
 * Uses loadValidatedPrefix() instead of load() to handle truncated JSONL event logs
 * from a crash during append. Both 'complete' and 'truncated' kinds expose .truth.events.
 *
 * Returns 0 on any error (safe: caller falls back to discard).
 *
 * @param _parseFn - Injectable token parser. Receives the raw continueToken string and
 *   returns a ResultAsync<ContinueTokenResolved, ToolFailure>. Defaults to calling
 *   parseContinueTokenOrFail with ctx.v2.tokenCodecPorts and ctx.v2.tokenAliasStore.
 * @param _loadFn - Injectable session loader. Receives the WorkRail SessionId and
 *   returns a ResultAsync<LoadedValidatedPrefixV2, SessionEventLogStoreError>. Defaults to
 *   ctx.v2.sessionStore.loadValidatedPrefix.
 */
export async function countOrphanStepAdvances(
  continueToken: string,
  ctx: V2ToolContext,
  _parseFn: ((raw: string) => ResultAsync<ContinueTokenResolved, ToolFailure>) | undefined = undefined,
  _loadFn: SessionEventLogReadonlyStorePortV2['loadValidatedPrefix'] | undefined = undefined,
): Promise<number> {
  const parseFn = _parseFn ?? ((raw: string) =>
    parseContinueTokenOrFail(raw, ctx.v2.tokenCodecPorts, ctx.v2.tokenAliasStore)
  );
  const loadFn = _loadFn ?? ctx.v2.sessionStore.loadValidatedPrefix.bind(ctx.v2.sessionStore);

  // Decode the continueToken to extract the WorkRail sessionId.
  const resolvedResult = await parseFn(continueToken);

  if (resolvedResult.isErr()) {
    console.warn(
      `[WorkflowRunner] Could not decode continueToken for orphaned session: ${resolvedResult.error.message}`,
    );
    return 0;
  }

  const sessionId = asSessionId(resolvedResult.value.sessionId);

  // Use loadValidatedPrefix to handle crash-truncated JSONL gracefully.
  // Both 'complete' and 'truncated' kinds expose .truth.events with the valid prefix.
  const loadResult = await loadFn(sessionId);

  if (loadResult.isErr()) {
    console.warn(
      `[WorkflowRunner] Could not load session event log for orphaned session: ${loadResult.error.code} -- ${loadResult.error.message}`,
    );
    return 0;
  }

  const events = loadResult.value.truth.events;
  return events.filter((e) => e.kind === 'advance_recorded').length;
}

/**
 * Best-effort cleanup of queue-issue idempotency sidecars in the sessions directory.
 *
 * WHY these files exist: polling-scheduler.ts writes `queue-issue-<N>.json` BEFORE
 * dispatching a GitHub issue to prevent duplicate dispatch within a 56-minute window
 * (DISCOVERY_TIMEOUT_MS + 60s). On clean completion or error, the sidecar is deleted.
 * On daemon crash, it is NOT deleted -- it has a different JSON shape
 * ({ issueNumber, dispatchedAt, ttlMs }) than session sidecars ({ continueToken, ts })
 * and is silently skipped by readAllDaemonSessions().
 *
 * WHY unconditional: there is no link from OrphanedSession to the queue-issue sidecar
 * (OrphanedSession does not store the issue number). We must scan ALL queue-issue-*.json
 * files and delete them all.
 *
 * After deletion, the affected issue becomes eligible for re-dispatch in the next poll
 * cycle (~5 minutes).
 *
 * Non-fatal: any error (ENOENT, permissions) is caught per-file and logged. Never throws.
 *
 * WHY exported: called by runStartupRecovery() and testable in isolation.
 */
export async function clearQueueIssueSidecars(sessionsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return; // ENOENT or permission error -- nothing to clean up
  }

  for (const entry of entries) {
    if (!entry.startsWith('queue-issue-') || !entry.endsWith('.json')) continue;
    try {
      await fs.unlink(path.join(sessionsDir, entry));
      // Extract issue number from filename for log clarity.
      const issueNum = entry.slice('queue-issue-'.length, -'.json'.length);
      console.log(`[WorkflowRunner] Cleared queue-issue sidecar: issue=${issueNum}`);
    } catch (err: unknown) {
      const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isEnoent) {
        console.warn(
          `[WorkflowRunner] Could not clear queue-issue sidecar ${entry}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/**
 * Best-effort cleanup of stray .tmp files in the sessions directory.
 *
 * These are written by persistTokens() as part of the atomic temp-rename pattern.
 * If the daemon crashes between writeFile(tmp) and rename(tmp, final), the .tmp
 * file is orphaned. It holds no useful state (the rename never completed), so we
 * discard it unconditionally.
 */
async function clearStrayTmpFiles(sessionsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return; // ENOENT or permission error -- nothing to clean up
  }

  for (const entry of entries) {
    if (!entry.endsWith('.tmp')) continue;
    try {
      await fs.unlink(path.join(sessionsDir, entry));
      console.log(`[WorkflowRunner] Cleared stray temp file: ${entry}`);
    } catch {
      // Best-effort -- ignore all errors
    }
  }
}

// ---------------------------------------------------------------------------
// Context loaders (daemon soul + workspace context)
// ---------------------------------------------------------------------------

/**
 * Load the operator-customizable agent rules from a soul file.
 *
 * @param resolvedPath - Optional resolved path from the cascade in trigger-store.ts:
 *   TriggerDefinition.soulFile (trigger override) -> WorkspaceConfig.soulFile (workspace default).
 *   When absent, falls back to ~/.workrail/daemon-soul.md (global default).
 *
 * On first run (file absent), writes a template to disk so the operator can discover
 * and customize it. The write is best-effort: if it fails, the warning is logged and
 * DAEMON_SOUL_DEFAULT is returned anyway.
 *
 * WHY path.dirname(soulPath) for mkdir: for workspace-scoped paths like
 * ~/.workrail/workspaces/my-project/daemon-soul.md, the parent dir must be created --
 * not WORKRAIL_DIR (~/.workrail) which is already present.
 */
async function loadDaemonSoul(resolvedPath?: string): Promise<string> {
  const soulPath = resolvedPath ?? path.join(WORKRAIL_DIR, 'daemon-soul.md');
  try {
    return await fs.readFile(soulPath, 'utf8');
  } catch (err: unknown) {
    // ENOENT = first run. Write the template, then return the default content.
    // Any other error (permissions, etc.) is treated the same way.
    const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (isEnoent) {
      // Best-effort template creation -- failure is logged but never fatal.
      try {
        await fs.mkdir(path.dirname(soulPath), { recursive: true });
        await fs.writeFile(soulPath, DAEMON_SOUL_TEMPLATE, 'utf8');
        console.log(`[WorkflowRunner] Created daemon-soul.md template at ${soulPath}`);
      } catch (writeErr: unknown) {
        console.warn(
          `[WorkflowRunner] Warning: could not write daemon-soul.md template: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
        );
      }
    } else {
      console.warn(
        `[WorkflowRunner] Warning: could not read daemon-soul.md: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return DAEMON_SOUL_DEFAULT;
  }
}

/**
 * Strip YAML frontmatter from file content before injection into the system prompt.
 *
 * WHY: .mdc files (Cursor, Firebender) and .windsurf/rules/*.md files include
 * YAML metadata (alwaysApply, description, trigger) that is tool-specific and
 * not meaningful in a WorkTrain system prompt context.
 *
 * Safety: Only strips if the file starts with '---\n' or '---\r\n' (YAML frontmatter
 * is always at the start of the file). Returns original content unchanged if:
 * - File does not start with '---' (no frontmatter present -- safe no-op)
 * - No closing '---' delimiter found (malformed frontmatter -- preserve as-is)
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return content;
  const endIdx = content.indexOf('\n---', 4);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 4).trimStart();
}

/**
 * Scan the workspace for convention files across 7 AI tools and combine them
 * into a single string for injection into the system prompt.
 *
 * Files are read in priority order (WORKSPACE_CONTEXT_CANDIDATE_PATHS). Combined
 * size is capped at WORKSPACE_CONTEXT_MAX_BYTES to prevent context window bloat.
 * If the cap is exceeded, a notice is appended so the agent knows content was cut.
 *
 * Returns null if no context files were found (section is omitted from the prompt).
 *
 * WHY best-effort: these files are optional. Missing or unreadable files are silently
 * skipped (or logged at warn level for non-ENOENT errors). The agent can still run
 * without workspace context.
 */
export async function loadWorkspaceContext(workspacePath: string): Promise<string | null> {
  const parts: string[] = [];
  const injectedPaths: string[] = [];
  let combinedBytes = 0;
  let truncated = false;

  /**
   * Accumulates a single file's content into parts[], respecting the byte budget.
   * WHY extracted as inner helper: the same accumulation logic is needed for both
   * literal and glob candidates.
   */
  function accumulateFile(relativePath: string, content: string): void {
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (combinedBytes + contentBytes > WORKSPACE_CONTEXT_MAX_BYTES) {
      // Fit as much of this file as will fill the remaining budget.
      const remaining = WORKSPACE_CONTEXT_MAX_BYTES - combinedBytes;
      const truncatedContent = content.slice(0, remaining);
      parts.push(`### ${relativePath}\n${truncatedContent}`);
      injectedPaths.push(relativePath);
      truncated = true;
    } else {
      parts.push(`### ${relativePath}\n${content}`);
      injectedPaths.push(relativePath);
      combinedBytes += contentBytes;
    }
  }

  for (const entry of WORKSPACE_CONTEXT_CANDIDATE_PATHS) {
    if (truncated) break;

    if (entry.kind === 'literal') {
      const fullPath = path.join(workspacePath, entry.relativePath);
      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf8');
      } catch (err: unknown) {
        const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
        if (!isEnoent) {
          // Unexpected error (permissions, etc.) -- log and skip.
          console.warn(
            `[WorkflowRunner] Skipping ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }
      accumulateFile(entry.relativePath, content);
    } else {
      // kind === 'glob': expand pattern, sort, cap, read each file.
      const matches = await tinyGlob(entry.pattern, { cwd: workspacePath, absolute: false });
      const sorted = [...matches].sort(); // alpha sort for determinism
      if (sorted.length > MAX_GLOB_FILES_PER_PATTERN) {
        console.warn(
          `[WorkflowRunner] ${entry.pattern}: ${sorted.length} files found, capped at ${MAX_GLOB_FILES_PER_PATTERN}`,
        );
      }
      for (const relativePath of sorted.slice(0, MAX_GLOB_FILES_PER_PATTERN)) {
        if (truncated) break;
        const fullPath = path.join(workspacePath, relativePath);
        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf8');
        } catch (err: unknown) {
          const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
          if (!isEnoent) {
            console.warn(
              `[WorkflowRunner] Skipping ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          continue;
        }
        accumulateFile(relativePath, entry.stripFrontmatter ? stripFrontmatter(content) : content);
      }
    }
  }

  if (parts.length === 0) return null;

  let combined = parts.join('\n\n');
  if (truncated) {
    combined += '\n\n[Workspace context truncated: combined size exceeded 32 KB limit. Some files may be missing.]';
  }

  console.log(
    `[WorkflowRunner] Injecting workspace context from: ${injectedPaths.join(', ')}`,
  );

  return combined;
}

/**
 * Load prior step notes from the WorkRail session store for recap injection.
 *
 * Best-effort: any failure (token decode, store load, projection) logs a WARN
 * and returns an empty array so the daemon session can continue without context.
 * WHY: session state is a continuity aid, not a correctness requirement. A
 * session that starts without a recap still functions correctly -- it just has
 * no awareness of prior steps from the same checkpoint-resumed session.
 *
 * WHY system prompt injection instead of agent.steer():
 * The daemon calls executeStartWorkflow() BEFORE constructing the Agent.
 * Populating the system prompt at Agent construction time satisfies
 * "after start_workflow fires, before first LLM call" -- steer() would fire
 * AFTER the first LLM response (incorrect ordering for pre-step-1 context).
 *
 * @param continueToken - The continueToken from executeStartWorkflow (used to
 *   extract the sessionId via the alias store, without schema changes).
 * @param ctx - V2ToolContext providing tokenCodecPorts, tokenAliasStore, sessionStore.
 */
export async function loadSessionNotes(
  continueToken: string,
  ctx: V2ToolContext,
): Promise<readonly string[]> {
  try {
    // Decode the continueToken to extract the sessionId.
    // WHY token decode instead of returning sessionId from executeStartWorkflow:
    // Adding sessionId to V2StartWorkflowOutputSchema is a public schema change
    // (GAP-7 territory). Token decode via the alias store is the correct in-process
    // path that avoids breaking the public API contract.
    const resolvedResult = await parseContinueTokenOrFail(
      continueToken,
      ctx.v2.tokenCodecPorts,
      ctx.v2.tokenAliasStore,
    );

    if (resolvedResult.isErr()) {
      console.warn(
        `[WorkflowRunner] Warning: could not decode continueToken for session recap: ${resolvedResult.error.message}`,
      );
      return [];
    }

    const sessionId = asSessionId(resolvedResult.value.sessionId);

    // Load the session event log (read-only -- no state mutation).
    const loadResult = await ctx.v2.sessionStore.load(sessionId);
    if (loadResult.isErr()) {
      console.warn(
        `[WorkflowRunner] Warning: could not load session store for recap: ${loadResult.error.code} -- ${loadResult.error.message}`,
      );
      return [];
    }

    // Project node outputs to extract step notes.
    const projectionResult = projectNodeOutputsV2(loadResult.value.events);
    if (projectionResult.isErr()) {
      console.warn(
        `[WorkflowRunner] Warning: could not project session outputs for recap: ${projectionResult.error.code} -- ${projectionResult.error.message}`,
      );
      return [];
    }

    // Collect all recap-channel notes across all nodes, in event order.
    // WHY recap channel only: 'artifact' outputs are references, not human-readable notes.
    const allNotes: string[] = [];
    for (const nodeView of Object.values(projectionResult.value.nodesById)) {
      for (const output of nodeView.currentByChannel.recap) {
        if (output.payload.payloadKind === 'notes') {
          // Truncate each note to prevent per-note context bloat.
          const note = output.payload.notesMarkdown.length > MAX_SESSION_NOTE_CHARS
            ? output.payload.notesMarkdown.slice(0, MAX_SESSION_NOTE_CHARS) + '\n[truncated]'
            : output.payload.notesMarkdown;
          allNotes.push(note);
        }
      }
    }

    // Take only the last N notes (most recent context is most relevant).
    return allNotes.slice(-MAX_SESSION_RECAP_NOTES);
  } catch (err) {
    console.warn(
      `[WorkflowRunner] Warning: unexpected error loading session notes for recap: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool parameter schemas (plain JSON Schema -- no TypeBox or external loader needed)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _schemas: Record<string, any> | null = null;

// WHY plain JSON Schema: the Anthropic SDK's Tool.input_schema accepts
// Record<string, unknown>. TypeBox was only needed because pi-agent-core's
// AgentTool<TSchema> required a TypeBox schema type. The new AgentTool interface
// (from agent-loop.ts) accepts plain JSON Schema directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSchemas(): Record<string, any> {
  if (_schemas) return _schemas;
  _schemas = {
    ContinueWorkflowParams: {
      type: 'object',
      properties: {
        continueToken: {
          type: 'string',
          description: 'The continueToken from the previous start_workflow or continue_workflow call. Round-trip exactly as received.',
        },
        intent: {
          type: 'string',
          enum: ['advance', 'rehydrate'],
          description: 'advance: I completed this step. rehydrate: remind me what the current step is.',
        },
        notesMarkdown: {
          type: 'string',
          description: 'Notes on what you did in this step (10-30 lines, markdown).',
        },
        artifacts: {
          type: 'array',
          items: {},
          description:
            'Optional structured artifacts to attach to this step. ' +
            'Include wr.assessment objects here when the step requires an assessment gate. ' +
            'Example: [{ "kind": "wr.assessment", "assessmentId": "<id>", "dimensions": { "<dimensionId>": "high" } }]',
        },
        context: {
          type: 'object',
          additionalProperties: true,
          description: 'Updated context variables (only changed values). Exception: metrics_commit_shas must always contain the FULL accumulated list of all commit SHAs from this session -- never send only new SHAs.',
        },
      },
      required: ['continueToken'],
    },
    CompleteStepParams: {
      type: 'object',
      properties: {
        notes: {
          type: 'string',
          minLength: 50,
          description:
            'What you did in this step (required, at least 50 characters). Write for a human reader. ' +
            'Include: what you did and key decisions, what you produced (files, tests, numbers), ' +
            'anything notable (risks, open questions, things you chose NOT to do and why). ' +
            'Use markdown: headings, bullets, bold. 10-30 lines is ideal.',
        },
        artifacts: {
          type: 'array',
          items: {},
          description:
            'Optional structured artifacts to attach to this step. ' +
            'Include wr.assessment objects here when the step requires an assessment gate. ' +
            'Example: [{ "kind": "wr.assessment", "assessmentId": "<id>", "dimensions": { "<dimensionId>": "high" } }]',
        },
        context: {
          type: 'object',
          additionalProperties: true,
          description: 'Updated context variables (only changed values). Omit entirely if no facts changed. Exception: metrics_commit_shas must always contain the FULL accumulated list of all commit SHAs from this session -- never send only new SHAs.',
        },
      },
      required: ['notes'],
      additionalProperties: false,
    },
    BashParams: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory for the command' },
      },
      required: ['command'],
    },
    ReadParams: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file to read. Content is returned in cat -n format: each line prefixed with its 1-indexed line number and a tab character.' },
        offset: { type: 'number', description: '0-indexed line number to start reading from (inclusive). Omit to read from the beginning.' },
        limit: { type: 'number', description: 'Maximum number of lines to return. Omit to read to end of file.' },
      },
      required: ['filePath'],
    },
    WriteParams: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['filePath', 'content'],
    },
    GlobParams: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.ts"). Supports standard glob syntax.' },
        path: { type: 'string', description: 'Absolute path to search root. Defaults to the workspace root.' },
      },
      required: ['pattern'],
    },
    GrepParams: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression pattern to search for in file contents.' },
        path: { type: 'string', description: 'Absolute path to search in. Defaults to the workspace root.' },
        glob: { type: 'string', description: 'Glob pattern to restrict which files are searched (e.g. "*.ts").' },
        type: { type: 'string', description: 'File type filter for ripgrep (e.g. "ts", "js", "py").' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode. "files_with_matches": only file paths (default). "content": matching lines with context. "count": match counts per file.' },
        head_limit: { type: 'number', description: 'Maximum number of output lines to return. Default: 250.' },
        context: { type: 'number', description: 'Number of lines of context to show before and after each match (output_mode=content only).' },
        '-i': { type: 'boolean', description: 'Case-insensitive search.' },
      },
      required: ['pattern'],
    },
    EditParams: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit. The file must have been read in this session via the Read tool.' },
        old_string: { type: 'string', description: 'Exact string to find and replace. Must appear exactly once in the file (or use replace_all=true for multiple occurrences). Do NOT include line-number prefixes from Read output.' },
        new_string: { type: 'string', description: 'Replacement string. Must differ from old_string.' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string. Default: false (fails if more than one match).' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    SpawnAgentParams: {
      type: 'object',
      properties: {
        workflowId: {
          type: 'string',
          description: 'ID of the workflow to run in the child session (e.g. "wr.discovery").',
        },
        goal: {
          type: 'string',
          description: 'One-sentence description of what the child session should accomplish.',
        },
        workspacePath: {
          type: 'string',
          description: 'Absolute path to the workspace directory for the child session.',
        },
        context: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional initial context variables to pass to the child workflow.',
        },
      },
      required: ['workflowId', 'goal', 'workspacePath'],
      additionalProperties: false,
    },
  };
  return _schemas;
}

// Tool factories are implemented in src/daemon/tools/ and re-exported at the top of this file.

// ---------------------------------------------------------------------------
// writeStuckOutboxEntry -- stuck detection helper
// ---------------------------------------------------------------------------

/**
 * Append a stuck-escalation entry to ~/.workrail/outbox.jsonl.
 *
 * WHY fire-and-forget (called as void): outbox write is best-effort. A failed
 * write must never affect the session result or abort the turn_end subscriber.
 *
 * WHY a separate helper: keeps the turn_end subscriber readable. The outbox write
 * requires async fs operations that would add noise inside the subscriber.
 */
async function writeStuckOutboxEntry(opts: {
  workflowId: string;
  reason: 'repeated_tool_call' | 'no_progress';
  issueSummaries?: readonly string[];
}): Promise<void> {
  try {
    const outboxPath = path.join(os.homedir(), '.workrail', 'outbox.jsonl');
    await fs.mkdir(path.dirname(outboxPath), { recursive: true });
    const entry = JSON.stringify({
      id: randomUUID(),
      kind: 'stuck',
      message:
        `Session stuck (${opts.reason}): workflowId=${opts.workflowId}` +
        (opts.issueSummaries && opts.issueSummaries.length > 0
          ? ` -- issues: ${opts.issueSummaries.join('; ')}`
          : ''),
      timestamp: new Date().toISOString(),
      workflowId: opts.workflowId,
      reason: opts.reason,
      ...(opts.issueSummaries && opts.issueSummaries.length > 0
        ? { issueSummaries: opts.issueSummaries }
        : {}),
    });
    await fs.appendFile(outboxPath, entry + '\n');
  } catch (err) {
    console.warn(
      `[WorkflowRunner] Could not write stuck outbox entry: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Static preamble for the daemon agent system prompt.
 *
 * WHY a named constant: extracting the preamble makes it readable as a document,
 * gives it a stable identity for tests, and follows the soul-template.ts precedent
 * of separating stable content from dynamic assembly. The dynamic parts (session
 * state, soul, workspace context) are injected by buildSystemPrompt() below.
 *
 * WHY these sections: daemon sessions run unattended. The agent has no user to ask.
 * The preamble replaces that missing human with: an oracle hierarchy, a reasoning
 * protocol, and explicit contracts for the two failure modes that matter most --
 * skipping steps and silent failure.
 */
const BASE_SYSTEM_PROMPT = `\
You are WorkRail Auto, an autonomous agent that executes workflows step by step. You are running unattended -- there is no user watching. Your entire job is to faithfully complete the current workflow.

## What you are
You are highly capable. You handle ambitious, multi-step tasks that require real codebase understanding. You don't hedge, ask for permission, or stop to check in. You work.

## Your oracle (consult in this order when uncertain)
1. The daemon soul rules (## Agent Rules and Philosophy below)
2. AGENTS.md / CLAUDE.md in the workspace (injected below under Workspace Context)
3. The current workflow step's prompt and guidance
4. Local code patterns in the relevant module (grep the directory, not the whole repo)
5. Industry best practices -- only when nothing above applies

## Self-directed reasoning
Ask yourself questions to clarify your approach, then answer them yourself using tools before acting. Never wait for a human to answer -- you are the oracle.

Bad pattern: "I'll analyze both layers." (no justification)
Good pattern: "Question: Should I check the middleware? Answer: The workflow step says 'trace the full call chain', and the AGENTS.md says the entry point is in the middleware layer. Yes, start there."

## Your tools
- \`complete_step\`: Mark the current step complete and advance to the next one. Call this after completing ALL work required by the step. Include your notes (min 50 characters) in the notes field. The daemon manages the session token internally -- you do NOT need a continueToken. This is the preferred advancement tool for daemon sessions.
- \`continue_workflow\`: [DEPRECATED -- use complete_step instead. Do NOT pass a continueToken.] Only use this if complete_step is unavailable.
- \`Bash\`: Run shell commands. Use for building, testing, running scripts.
- \`Read\`: Read files.
- \`Write\`: Write files.
- \`report_issue\`: Record a structured issue, error, or unexpected behavior. Call this AND complete_step (unless fatal). Does not stop the session -- it creates a record for the auto-fix coordinator.
- \`spawn_agent\`: Delegate a sub-task to a child WorkRail session. BLOCKS until the child completes. Returns \`{ childSessionId, outcome: "success"|"error"|"timeout", notes: string }\`. Always check \`outcome\` before using \`notes\`. IMPORTANT: your session's time limit (maxSessionMinutes) keeps running while the child executes -- ensure your parent session has enough time for both your work AND the child's work. Maximum spawn depth is 3 by default (configurable). Use only when a step explicitly asks for delegation or when a clearly separable sub-task would benefit from its own WorkRail audit trail.
- \`signal_coordinator\`: Emit a structured mid-session signal to the coordinator WITHOUT advancing the workflow step. Use when the step asks you to surface a finding, request data, request approval, or report a blocking condition. Always returns immediately -- fire-and-observe. Signal kinds: "progress", "finding", "data_needed", "approval_needed", "blocked".

## Execution contract
1. Read the step carefully. Do ALL the work the step asks for.
2. Call \`complete_step\` with your notes. No continueToken needed -- the daemon manages it.
3. Repeat until the workflow reports it is complete.
4. Do NOT skip steps. Do NOT call \`complete_step\` without completing the step's work.

## The workflow is the contract
Every step must be fully completed before you call complete_step. The workflow step prompt is the specification of what 'done' means -- not a suggestion. Don't advance until the work is actually done.

Your cognitive mode changes per step: some steps make you a researcher, others a reviewer, others an implementer. Adopt the mode the step describes. Don't bring your own agenda.

## Silent failure is the worst outcome
If something goes wrong: call report_issue, then continue unless severity is 'fatal'. Do NOT silently retry forever, work around failures without noting them, or pretend things worked. The issue record is how the system learns and self-heals.

## Tools are your hands, not your voice
Don't narrate what you're about to do. Use the tool and report what you found. Token efficiency matters -- you have a wall-clock timeout.

## You don't have a user. You have a workflow and a soul.
If you're unsure, consult the oracle above. If nothing answers the question, make a reasoned decision, call report_issue with kind='self_correction' to document it, and continue.

## IMPORTANT: Never use continue_workflow in daemon sessions
complete_step is your advancement tool. It does not require a continueToken. Do NOT call continue_workflow with a token you found in a previous message -- use complete_step instead.\
`;

/**
 * Format prior step notes into a concise session state recap string.
 *
 * This is a pure function -- all I/O (note loading, truncation decisions) is
 * handled by the caller. WHY pure: unit-testable without mocking the session
 * store or token codec.
 *
 * Returns an empty string when `notes` is empty so the caller can guard on
 * `recap !== ''` before injecting it into the system prompt.
 *
 * WHY `<workrail_session_state>` tag: `buildSystemPrompt()` already reserves
 * this XML slot in the system prompt. Using the existing tag ensures the agent
 * parses it consistently with the documented schema.
 *
 * @param notes - Prior step notes (already limited to MAX_SESSION_RECAP_NOTES
 *   entries and truncated to MAX_SESSION_NOTE_CHARS each by the caller).
 */
export function buildSessionRecap(notes: readonly string[]): string {
  if (notes.length === 0) return '';

  const formattedNotes = notes
    .map((note, i) => `### Prior step ${i + 1}\n${note}`)
    .join('\n\n');

  return `<workrail_session_state>\nThe following notes summarize prior steps from this session:\n\n${formattedNotes}\n</workrail_session_state>`;
}

/**
 * Build the system prompt for the daemon agent.
 *
 * This function is intentionally synchronous and pure -- all I/O (soul file,
 * workspace context) is resolved by the caller before invoking this function.
 * WHY: keeps the function unit-testable by passing pre-loaded strings directly,
 * without requiring fs mocking or real disk access in tests.
 *
 * @param trigger - The workflow trigger containing workspacePath and referenceUrls.
 * @param sessionState - Serialized WorkRail session state (may be empty string).
 * @param soulContent - Loaded content of daemon-soul.md (always a string; caller
 *   provides the hardcoded default if the file was absent).
 * @param workspaceContext - Combined workspace context from CLAUDE.md / AGENTS.md,
 *   or null if no workspace context files were found.
 */
export function buildSystemPrompt(
  trigger: WorkflowTrigger,
  sessionState: string,
  soulContent: string,
  workspaceContext: string | null,
): string {
  const lines = [
    BASE_SYSTEM_PROMPT,
    '',
    `<workrail_session_state>${sessionState}</workrail_session_state>`,
    '',
    '## Agent Rules and Philosophy',
    soulContent,
    '',
    `## Workspace: ${trigger.workspacePath}`,
  ];

  // Inject workspace context (CLAUDE.md / AGENTS.md) when available.
  // WHY: these files define repo-specific coding conventions, commit style, and
  // tooling preferences. Injecting them here gives the agent the same context
  // it would have if invoked by Claude Code or another agent-aware tool.
  if (workspaceContext !== null) {
    lines.push('');
    lines.push('## Workspace Context (from AGENTS.md / CLAUDE.md)');
    lines.push(workspaceContext);
  }

  // Inject assembled task context (prior session notes + git diff stat) when provided.
  // WHY before referenceUrls: task-specific runtime context should be visible before
  // static reference documents. Earlier position improves agent attention.
  // WHY trigger.context key: the coordinator serializes the rendered context bundle
  // into trigger.context['assembledContextSummary'] (string) before spawning. This
  // survives the HTTP transport (context map is already JSON-serialized).
  const assembledContextSummary = trigger.context?.['assembledContextSummary'];
  if (typeof assembledContextSummary === 'string' && assembledContextSummary.trim().length > 0) {
    let ctxStr = assembledContextSummary as string;
    if (Buffer.byteLength(ctxStr, 'utf8') > MAX_ASSEMBLED_CONTEXT_BYTES) {
      ctxStr = ctxStr.slice(0, MAX_ASSEMBLED_CONTEXT_BYTES) + '\n[Prior context truncated at 8KB]';
    }
    lines.push('');
    lines.push('## Prior Context');
    lines.push(ctxStr.trim());
  }

  // Append reference URLs section when provided.
  // WHY: some tasks require background context (specs, design docs, ADRs) that
  // the agent should fetch and read before starting work. Providing the URLs in
  // the system prompt ensures they are visible from the first turn.
  if (trigger.referenceUrls && trigger.referenceUrls.length > 0) {
    lines.push('');
    lines.push('## Reference documents');
    lines.push(
      'Before starting, fetch and read these reference documents: ' +
      trigger.referenceUrls.join(' '),
    );
    lines.push(
      'If you cannot fetch any of these documents, note their unavailability and proceed.',
    );
  }

  return lines.join('\n');
}

/** Build a user message for the agent loop. */
function buildUserMessage(text: string): { role: 'user'; content: string; timestamp: number } {
  return {
    role: 'user',
    content: text,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Execution stats helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pure functions: functional core
// ---------------------------------------------------------------------------

/**
 * Map a WorkflowRunResult._tag to the stats outcome string recorded in execution-stats.jsonl.
 *
 * WHY pure function with assertNever: the compiler enforces exhaustiveness.
 * Adding a new _tag variant to WorkflowRunResult without updating this function
 * produces a TypeScript compile error -- silent omissions are impossible.
 *
 * WHY delivery_failed -> 'success': the workflow ran to completion; only the
 * HTTP callback POST failed. The stats should reflect that the work was done.
 * See WorkflowDeliveryFailed and invariants doc section 1.3.
 */
export function tagToStatsOutcome(tag: WorkflowRunResult['_tag']): 'success' | 'error' | 'timeout' | 'stuck' {
  switch (tag) {
    case 'success': return 'success';
    case 'error': return 'error';
    case 'timeout': return 'timeout';
    case 'stuck': return 'stuck';
    case 'delivery_failed': return 'success'; // workflow succeeded; only POST failed
    default: return assertNever(tag);
  }
}

/**
 * Sidecar lifecycle decision for a completed runWorkflow() session.
 *
 * WHY a discriminated union: the two outcomes have categorically different
 * cleanup owners. 'delete_now' means runWorkflow() (via finalizeSession) deletes
 * the sidecar before returning. 'retain_for_delivery' means TriggerRouter.maybeRunDelivery()
 * deletes it after git delivery completes -- runWorkflow() must NOT delete it.
 */
export type SidecarLifecycle =
  | { readonly kind: 'delete_now' }
  | { readonly kind: 'retain_for_delivery' };

/**
 * Determine the correct sidecar lifecycle action for a completed session.
 *
 * Pure: no I/O, no side effects, deterministic.
 *
 * Rules (from worktrain-daemon-invariants.md section 2.2):
 * - success + worktree: retain -- delivery (git push, gh pr create) runs in the
 *   worktree after runWorkflow() returns; sidecar must outlive this function.
 * - all other outcomes and branch strategies: delete immediately.
 *
 * WHY delivery_failed hits assertNever: runWorkflow() never produces delivery_failed
 * (invariant 1.2). If it ever does, a compile error here forces the caller to handle it.
 */
export function sidecardLifecycleFor(
  tag: WorkflowRunResult['_tag'],
  branchStrategy: WorkflowTrigger['branchStrategy'],
): SidecarLifecycle {
  switch (tag) {
    case 'success':
      return branchStrategy === 'worktree'
        ? { kind: 'retain_for_delivery' }
        : { kind: 'delete_now' };
    case 'error':
    case 'timeout':
    case 'stuck':
      return { kind: 'delete_now' };
    case 'delivery_failed':
      // WHY throw: delivery_failed is in WorkflowRunResult but is never produced by
      // runWorkflow() directly (invariant 1.2). This case is unreachable in production.
      // Explicit handling (not assertNever) so the default: branch remains typed as never,
      // making the assertNever guard work for future WorkflowRunResult variants.
      throw new Error(`sidecardLifecycleFor: delivery_failed is not a valid input (invariant 1.2)`);
    default:
      // WHY assertNever: if a new WorkflowRunResult._tag variant is added without updating
      // this function, the compiler breaks here and forces handling.
      return assertNever(tag);
  }
}

/**
 * Build the Anthropic (or AnthropicBedrock) client and resolve the model ID.
 *
 * Pure: no I/O. Reads only the trigger config and process.env.
 * Throws with a clear message on invalid model format -- the caller wraps
 * in a try/catch that returns _tag: 'error'.
 *
 * WHY pure: model selection is a pure computation from trigger + env. Extracting
 * it makes the logic testable without real API keys or a running daemon session.
 *
 * Model format: "provider/model-id" (e.g. "amazon-bedrock/claude-sonnet-4-6").
 * When absent, detects AWS credentials in env (Bedrock) vs. direct API key.
 *
 * @param trigger - WorkflowTrigger carrying optional agentConfig.model override.
 * @param apiKey - Anthropic API key (used only when not using Bedrock).
 * @param env - Process environment variables (for AWS credential detection).
 */
export function buildAgentClient(
  trigger: WorkflowTrigger,
  apiKey: string,
  env: NodeJS.ProcessEnv,
): { agentClient: Anthropic | AnthropicBedrock; modelId: string } {
  if (trigger.agentConfig?.model) {
    // Parse "provider/model-id" -- split on the first slash only.
    const slashIdx = trigger.agentConfig.model.indexOf('/');
    if (slashIdx === -1) {
      throw new Error(
        `agentConfig.model must be in "provider/model-id" format, got: "${trigger.agentConfig.model}"`,
      );
    }
    const provider = trigger.agentConfig.model.slice(0, slashIdx);
    const modelId = trigger.agentConfig.model.slice(slashIdx + 1);
    const agentClient: Anthropic | AnthropicBedrock =
      provider === 'amazon-bedrock' ? new AnthropicBedrock() : new Anthropic({ apiKey });
    return { agentClient, modelId };
  }

  // Default: use Bedrock when AWS credentials are present, direct API otherwise.
  // WHY: avoids personal API key charges when AWS credentials are available.
  const usesBedrock = !!env['AWS_PROFILE'] || !!env['AWS_ACCESS_KEY_ID'];
  if (usesBedrock) {
    return {
      agentClient: new AnthropicBedrock(),
      modelId: 'us.anthropic.claude-sonnet-4-6',
    };
  }
  return {
    agentClient: new Anthropic({ apiKey }),
    modelId: 'claude-sonnet-4-6',
  };
}

// ---------------------------------------------------------------------------
// Session state: explicit mutable record
// ---------------------------------------------------------------------------

/**
 * All mutable state for a single runWorkflow() call.
 *
 * WHY a named interface (not 13 separate let declarations): makes the mutation
 * surface explicit and auditable. Every field that changes during a session is
 * visible here, not scattered across a 1000-line function body. The object is
 * passed by reference so closures (onAdvance, onComplete, onTokenUpdate, the
 * steer callback) capture `state` once and see all mutations.
 *
 * WHY mutable (not readonly): the callback pattern inherently mutates shared
 * state. Making it explicitly mutable is better than hiding mutation in closures.
 *
 * INVARIANT: workrailSessionId starts null and is populated asynchronously
 * after parseContinueTokenOrFail() succeeds. All closures that need it capture
 * `state` by reference -- they see the correct value when they execute (after
 * assignment), because JavaScript object mutation is visible through all references.
 */
export interface SessionState {
  /** Set to true by onComplete when the workflow's final step is advanced. */
  isComplete: boolean;
  /** Notes from the agent's final continue_workflow/complete_step call. */
  lastStepNotes: string | undefined;
  /** Artifacts from the agent's final continue_workflow/complete_step call. */
  lastStepArtifacts: readonly unknown[] | undefined;
  /**
   * The current session token injected by complete_step.
   * Updated by onAdvance (successful step) and onTokenUpdate (blocked retry).
   * INVARIANT: always updated AFTER persistTokens() is called.
   */
  currentContinueToken: string;
  /**
   * The WorkRail sess_* ID decoded from the continueToken after executeStartWorkflow.
   * Starts null; populated by parseContinueTokenOrFail(). Used to key DaemonRegistry,
   * SteerRegistry, AbortRegistry, and event emission.
   */
  workrailSessionId: string | null;
  /**
   * Number of times onAdvance() was called (workflow step advances in the agent loop).
   * Used for stuck detection Signal 2 and recorded in execution stats as stepCount.
   */
  stepAdvanceCount: number;
  /**
   * Ring buffer of the last STUCK_REPEAT_THRESHOLD tool calls.
   * Used by stuck detection Signal 1 (repeated tool + same args).
   */
  lastNToolCalls: Array<{ toolName: string; argsSummary: string }>;
  /** Issue summaries from report_issue calls; included in WORKTRAIN_STUCK marker. */
  issueSummaries: string[];
  /**
   * Pending text parts to inject via agent.steer() on the next turn_end.
   * Populated by onAdvance (step text) and the steer callback (coordinator injection).
   */
  pendingSteerParts: string[];
  /**
   * Which stuck heuristic fired first, or null if none has fired.
   * Set synchronously before agent.abort() so the result path can read it.
   * First writer wins -- subsequent signals are ignored.
   */
  stuckReason: 'repeated_tool_call' | 'no_progress' | null;
  /**
   * Which timeout limit fired first, or null if none has fired.
   * Set synchronously before agent.abort() so the result path can read it.
   * First writer wins -- subsequent triggers are ignored.
   */
  timeoutReason: 'wall_clock' | 'max_turns' | null;
  /** Number of complete LLM response turns since the agent loop started. */
  turnCount: number;
}

/**
 * Create a fresh SessionState for a new runWorkflow() call.
 *
 * @param initialToken - The continueToken from executeStartWorkflow. This is
 *   the first token complete_step will inject for the first workflow step.
 */
export function createSessionState(initialToken: string): SessionState {
  return {
    isComplete: false,
    lastStepNotes: undefined,
    lastStepArtifacts: undefined,
    currentContinueToken: initialToken,
    workrailSessionId: null,
    stepAdvanceCount: 0,
    lastNToolCalls: [],
    issueSummaries: [],
    pendingSteerParts: [],
    stuckReason: null,
    timeoutReason: null,
    turnCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Pure: stuck signal evaluation
// ---------------------------------------------------------------------------

/**
 * Configuration for stuck detection heuristics.
 *
 * WHY separated from SessionState: these are read-only inputs (trigger config +
 * constants). They do not change during the session and do not belong in the
 * mutable SessionState record.
 */
export interface StuckConfig {
  /** Configured max LLM turns for this session (DEFAULT_MAX_TURNS if not set). */
  maxTurns: number;
  /** 'abort' (default) or 'notify_only' -- controls whether abort fires on stuck. */
  stuckAbortPolicy: 'abort' | 'notify_only';
  /** When true, Signal 2 (no_progress) participates in abort. Default: false. */
  noProgressAbortEnabled: boolean;
  /** How many consecutive identical tool calls trigger Signal 1. Currently 3. */
  stuckRepeatThreshold: number;
}

/**
 * A stuck signal returned by evaluateStuckSignals(). Each kind maps to a
 * specific stuck detection heuristic.
 *
 * WHY discriminated union: forces the subscriber to handle each kind explicitly.
 * The subscriber is inherently imperative (calls agent.abort(), emitter.emit(),
 * writes outbox), but the decision of WHICH signal fired is pure.
 */
export type StuckSignal =
  | { kind: 'repeated_tool_call'; toolName: string; argsSummary: string }
  | { kind: 'no_progress'; turnCount: number; maxTurns: number }
  | { kind: 'max_turns_exceeded' }
  | { kind: 'timeout_imminent'; timeoutReason: 'wall_clock' | 'max_turns' };

/**
 * Evaluate all stuck detection signals for the current turn and return the
 * first applicable one, or null if none fires.
 *
 * Pure: reads `state` and `config`, no I/O, no side effects.
 * The caller (turn_end subscriber) handles all effects (abort, emit, outbox).
 *
 * WHY check max_turns_exceeded before repeated_tool_call: the max_turns path
 * in the subscriber returns early (skipping steer injection), so it must be
 * evaluated first. If we returned a repeated_tool_call signal when max_turns
 * also fired, the subscriber would handle the wrong signal.
 *
 * WHY check timeout_imminent last: it is purely observational (the abort was
 * already triggered by the wall-clock timeout). It does not cause a new abort.
 *
 * @param state - Current session state (read-only view).
 * @param config - Stuck detection configuration from the trigger.
 */
export function evaluateStuckSignals(state: Readonly<SessionState>, config: StuckConfig): StuckSignal | null {
  // Signal: max_turns exceeded -- this turn is the termination turn.
  // WHY evaluated first: the subscriber returns early on this signal (no steer injection).
  if (config.maxTurns > 0 && state.turnCount >= config.maxTurns && state.timeoutReason === null) {
    return { kind: 'max_turns_exceeded' };
  }

  // Signal 1: same tool + same args called stuckRepeatThreshold times in a row.
  // WHY argsSummary comparison: same tool with different args is not stuck.
  if (
    state.lastNToolCalls.length === config.stuckRepeatThreshold &&
    state.lastNToolCalls.every(
      (c) => c.toolName === state.lastNToolCalls[0]?.toolName && c.argsSummary === state.lastNToolCalls[0]?.argsSummary,
    )
  ) {
    return {
      kind: 'repeated_tool_call',
      toolName: state.lastNToolCalls[0]?.toolName ?? 'unknown',
      argsSummary: state.lastNToolCalls[0]?.argsSummary ?? '',
    };
  }

  // Signal 2: 80%+ of turns used with 0 step advances.
  // WHY 0.8: conservative -- avoids false positives on research workflows.
  // Returns regardless of noProgressAbortEnabled -- the subscriber checks the flag
  // before deciding whether to abort.
  if (
    config.maxTurns > 0 &&
    state.turnCount >= Math.floor(config.maxTurns * 0.8) &&
    state.stepAdvanceCount === 0
  ) {
    return { kind: 'no_progress', turnCount: state.turnCount, maxTurns: config.maxTurns };
  }

  // Signal 3: wall-clock timeout already firing (session is aborting).
  // WHY observational: the abort was triggered by the timeout Promise rejection,
  // not by this signal. Signal 3 is a last-chance notification, not a new abort.
  if (state.timeoutReason !== null) {
    return { kind: 'timeout_imminent', timeoutReason: state.timeoutReason };
  }

  return null;
}

/**
 * Write a single execution-stats entry and regenerate the stats summary.
 *
 * Fire-and-forget: returns void, never throws, never awaited. A stats write
 * failure must never affect the session result -- this is observability data,
 * not crash recovery state.
 *
 * WHY module-level (not inline): the same logic is needed at 4 early-exit
 * paths (before the try block) and in the finally block. A single helper
 * eliminates duplication and guarantees all paths write the same schema.
 *
 * WHY chained .then() for writeStatsSummary: writeStatsSummary reads
 * execution-stats.jsonl and must include the record just appended above.
 * Chaining ensures the append completes before the read starts.
 */
function writeExecutionStats(
  statsDir: string,
  sessionId: string,
  workflowId: string,
  startMs: number,
  outcome: 'success' | 'error' | 'timeout' | 'stuck' | 'unknown',
  stepCount: number,
): void {
  const endMs = Date.now();
  const statsPath = path.join(statsDir, 'execution-stats.jsonl');
  fs.mkdir(statsDir, { recursive: true })
    .then(() => fs.appendFile(
      statsPath,
      JSON.stringify({
        sessionId,
        workflowId,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        outcome,
        stepCount,
        ts: new Date().toISOString(),
      }) + '\n',
      'utf8',
    ))
    .then(() => { writeStatsSummary(statsDir).catch(() => {}); })
    .catch(() => {}); // best-effort -- never propagate
}

// ---------------------------------------------------------------------------
// Imperative shell helper: session finalization
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Two-phase session construction
// ---------------------------------------------------------------------------

/**
 * All state produced by the pre-agent I/O phase of runWorkflow().
 *
 * WHY a named interface: makes the phase boundary explicit. Everything in this
 * struct was established before `new AgentLoop()` -- the agent binding is NOT
 * included here. The abort registry is registered AFTER agent construction,
 * using `session.workrailSessionId` as the key.
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
  readonly firstStep: import('zod').infer<typeof V2StartWorkflowOutputSchema>;
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
  | { readonly kind: 'complete'; readonly result: WorkflowRunResult };

// ---------------------------------------------------------------------------
// AgentReadySession -- fully constructed pre-loop state
// ---------------------------------------------------------------------------

/**
 * Fully constructed pre-loop state -- everything runAgentLoop() needs.
 *
 * Produced by buildAgentReadySession() after context loading and tool
 * construction complete. Holds all pre-loop immutable values so that
 * runAgentLoop() has no knowledge of the setup steps.
 *
 * WHY a named interface (not an anonymous object): follows the established
 * FinalizationContext / TurnEndSubscriberContext / SessionScope pattern of
 * making dependency surfaces explicit and readable at the call site.
 */
export interface AgentReadySession {
  /** Pre-agent state from buildPreAgentSession() -- includes mutable SessionState. */
  readonly preAgentSession: PreAgentSession;
  /** Loaded context bundle (soul + workspace + session notes). */
  readonly contextBundle: import('./context-loader.js').ContextBundle;
  /** Per-session tool dependency bundle. */
  readonly scope: SessionScope;
  /** Constructed tool list for the agent. */
  readonly tools: readonly AgentTool[];
  /** Assembled session config (system prompt, initial prompt, limits). */
  readonly sessionCtx: SessionContext;
  /** Session handle from ActiveSessionSet. Undefined when no activeSessionSet injected. */
  readonly handle: import('./active-sessions.js').SessionHandle | undefined;
  /** Process-local session UUID (keys the sidecar file and conversation JSONL). */
  readonly sessionId: string;
  /** Workflow ID from the trigger. */
  readonly workflowId: string;
  /** Worktree path when branchStrategy === 'worktree', otherwise undefined. */
  readonly worktreePath: string | undefined;
  /** Constructed AgentLoop instance, ready to receive prompt(). */
  readonly agent: AgentLoop;
  /** Repeat threshold for stuck-detection heuristic. */
  readonly stuckRepeatThreshold: number;
}

// ---------------------------------------------------------------------------
// SessionOutcome -- terminal agent states before delivery and cleanup
// ---------------------------------------------------------------------------

/**
 * Terminal state of the agent loop, returned by runAgentLoop().
 *
 * Represents what the agent loop's own exit signal was, NOT the final
 * session outcome (which is determined by buildSessionResult() reading
 * state.stuckReason and state.timeoutReason after the loop exits).
 *
 * WHY a discriminated union (not raw strings): follows explicit-domain-types
 * philosophy. The two variants map directly to the two code paths through
 * the agent loop's try/catch block.
 */
export type SessionOutcome =
  | { readonly kind: 'completed'; readonly stopReason: string; readonly errorMessage?: string }
  | { readonly kind: 'aborted'; readonly errorMessage?: string };

/**
 * Context for finalizing a completed runWorkflow() session.
 * Passed from runWorkflow() to finalizeSession() after the agent loop exits.
 */
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

/**
 * Consolidate all session cleanup I/O for a completed runWorkflow() call.
 *
 * Handles:
 * 1. emitter?.emit({ kind: 'session_completed', ... }) with the correct outcome
 * 2. daemonRegistry?.unregister() with the correct status ('completed' or 'failed')
 * 3. writeExecutionStats() using tagToStatsOutcome() for exhaustive outcome mapping
 * 4. Sidecar file deletion (all paths except success+worktree)
 * 5. Conversation file deletion (success+non-worktree only)
 *
 * WHY consolidated here (not inline at each result path): each result path previously
 * had ~15-20 lines of identical cleanup code. A single function guarantees consistent
 * behavior across all paths and makes adding a new result path safer.
 *
 * WHY sidecar deletion for stuck: the pre-existing stuck path did NOT delete the sidecar.
 * This function fixes that bug. See worktrain-daemon-invariants.md section 2.2.
 *
 * WHY NOT called on early-exit paths (model validation, start_workflow failure, worktree
 * creation failure): those paths clean up inline because the agent loop never started
 * and this function assumes post-agent-loop state (conversationPath, stepAdvanceCount).
 */
export async function finalizeSession(
  result: WorkflowRunResult,
  ctx: FinalizationContext,
): Promise<void> {
  // ---- 1. Emit session_completed event ----
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

  // ---- 2. DaemonRegistry unregister ----
  // WHY NOT in finally block: the completion status ('completed' vs 'failed') differs
  // by result path. The finally block handles steer/abort registry cleanup (always safe).
  if (ctx.workrailSessionId !== null) {
    ctx.daemonRegistry?.unregister(
      ctx.workrailSessionId,
      result._tag === 'success' || result._tag === 'delivery_failed' ? 'completed' : 'failed',
    );
  }

  // ---- 3. Execution stats ----
  writeExecutionStats(ctx.statsDir, ctx.sessionId, ctx.workflowId, ctx.startMs, outcome, ctx.stepAdvanceCount);

  // ---- 4. Sidecar deletion ----
  // Decision is delegated to sidecardLifecycleFor() -- see that function and
  // worktrain-daemon-invariants.md section 2.2 for the full rules.
  // WHY assertNever is in sidecardLifecycleFor: if WorkflowRunResult gains a new
  // variant, the compiler breaks there and forces the caller to handle it here.
  const lifecycle = sidecardLifecycleFor(result._tag, ctx.branchStrategy);
  switch (lifecycle.kind) {
    case 'delete_now':
      await fs.unlink(path.join(ctx.sessionsDir, `${ctx.sessionId}.json`)).catch(() => {});
      break;
    case 'retain_for_delivery':
      // TriggerRouter.maybeRunDelivery() deletes the sidecar after delivery completes.
      break;
    default:
      assertNever(lifecycle);
  }

  // ---- 5. Conversation file deletion ----
  // Delete on clean success (non-worktree only): no debug value after success.
  // WHY only non-worktree: worktree sessions defer conversation file deletion to
  // TriggerRouter.maybeRunDelivery() alongside the sidecar, after delivery completes.
  // Errors and crashes leave the file intact for post-hoc inspection and Phase B.
  if (result._tag === 'success' && ctx.branchStrategy !== 'worktree') {
    await fs.unlink(ctx.conversationPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// buildSessionContext -- pure session configuration
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
}

/**
 * Build the session configuration from a ContextBundle and the first step prompt.
 *
 * This function is intentionally synchronous and pure -- all I/O (soul file,
 * workspace context, session notes) is resolved by the caller before invoking
 * this function. WHY: keeps the function unit-testable by passing pre-loaded
 * values directly, without requiring any I/O or mocking in tests.
 *
 * @param trigger - The workflow trigger (provides agentConfig limits and context).
 * @param context - The ContextBundle from DefaultContextLoader.loadSession().
 * @param firstStepPrompt - The first step's pending prompt from executeStartWorkflow
 *   or _preAllocatedStartResponse.
 * @returns SessionContext containing systemPrompt, initialPrompt, and session limits.
 */
export function buildSessionContext(
  trigger: WorkflowTrigger,
  context: import('./context-loader.js').ContextBundle,
  firstStepPrompt: string,
): SessionContext {
  // ---- Flatten ContextBundle to the primitives buildSystemPrompt expects ----
  // WHY flatten here (not in DefaultContextLoader): buildSystemPrompt() is a stable
  // pure function that predates ContextBundle. Flattening at the call site in
  // buildSessionContext() keeps DefaultContextLoader decoupled from the prompt layer.
  // workspaceRules[0].content: v1 always has at most one element (the aggregate from
  // loadWorkspaceContext). The ?? null pattern converts undefined to null correctly
  // since optional chaining returns undefined, not null.
  const workspaceContext: string | null = context.workspaceRules[0]?.content ?? null;
  // sessionHistory.map: restores the flat string[] that buildSessionRecap expects.
  // nodeId/stepId are discarded here -- they are unused in v1.
  const sessionNotes: readonly string[] = context.sessionHistory.map((n) => n.content);

  // ---- System prompt ----
  // buildSystemPrompt() is synchronous and pure. It reads assembledContextSummary
  // and referenceUrls from trigger.context and trigger.referenceUrls directly;
  // the authoritative values flow through trigger.
  const sessionState = buildSessionRecap(sessionNotes);
  const systemPrompt = buildSystemPrompt(trigger, sessionState, context.soulContent, workspaceContext);

  // ---- Initial prompt ----
  // WHY no continueToken in the initial prompt: the daemon uses complete_step which
  // manages the token internally. Including the token would invite the LLM to store
  // it and call continue_workflow (deprecated) instead of complete_step, defeating
  // the purpose of the new tool.
  // WHY closing directive: an explicit imperative at the end of the initial prompt
  // directs the agent to complete the step work before calling complete_step. Without
  // this, the agent may produce a "thinking aloud" turn before the first tool call,
  // which wastes tokens and delays step execution.
  const contextJson = trigger.context
    ? `\n\nTrigger context:\n\`\`\`json\n${JSON.stringify(trigger.context, null, 2)}\n\`\`\``
    : '';

  const initialPrompt =
    firstStepPrompt +
    contextJson +
    '\n\nComplete all step work, then call complete_step with your notes to advance.';

  // ---- Session limits ----
  // Resolved from trigger.agentConfig with hardcoded defaults as fallback.
  // WHY: per-trigger configurability lets operators tune limits per workflow type
  // (e.g. a fast code-review trigger vs. a slow coding-task trigger).
  const sessionTimeoutMs =
    (trigger.agentConfig?.maxSessionMinutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES) * 60 * 1000;
  const maxTurns = trigger.agentConfig?.maxTurns ?? DEFAULT_MAX_TURNS;

  return { systemPrompt, initialPrompt, sessionTimeoutMs, maxTurns };
}

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
    writeExecutionStats(statsDir, sessionId, trigger.workflowId, startMs, 'error', 0);
    return { kind: 'complete', result: { _tag: 'error', workflowId: trigger.workflowId, message, stopReason: 'error' } };
  }

  // ---- Session state ----
  const state = createSessionState('');

  // ---- executeStartWorkflow (or pre-allocated) ----
  let firstStep: import('zod').infer<typeof V2StartWorkflowOutputSchema>;
  if (trigger._preAllocatedStartResponse !== undefined) {
    firstStep = trigger._preAllocatedStartResponse;
  } else {
    const startResult = await executeStartWorkflow(
      { workflowId: trigger.workflowId, workspacePath: trigger.workspacePath, goal: trigger.goal },
      ctx,
      { is_autonomous: 'true', workspacePath: trigger.workspacePath },
    );
    if (startResult.isErr()) {
      writeExecutionStats(statsDir, sessionId, trigger.workflowId, startMs, 'error', 0);
      return {
        kind: 'complete',
        result: {
          _tag: 'error',
          workflowId: trigger.workflowId,
          message: `start_workflow failed: ${startResult.error.kind} -- ${JSON.stringify(startResult.error)}`,
          stopReason: 'error',
        },
      };
    }
    firstStep = startResult.value.response;
  }

  const continueToken = firstStep.continueToken ?? '';
  const checkpointToken = firstStep.checkpointToken ?? null;
  state.currentContinueToken = continueToken;

  // ---- Decode WorkRail session ID ----
  if (continueToken) {
    const decoded = await parseContinueTokenOrFail(continueToken, ctx.v2.tokenCodecPorts, ctx.v2.tokenAliasStore);
    if (decoded.isOk()) {
      state.workrailSessionId = decoded.value.sessionId;
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
      writeExecutionStats(statsDir, sessionId, trigger.workflowId, startMs, 'error', 0);
      return {
        kind: 'complete',
        result: {
          _tag: 'error',
          workflowId: trigger.workflowId,
          message: `Initial token persist failed: ${persistResult.error.code} -- ${persistResult.error.message}`,
          stopReason: 'error',
        },
      };
    }
  }

  // ---- Worktree isolation ----
  let sessionWorkspacePath = trigger.workspacePath;
  let sessionWorktreePath: string | undefined;

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
        writeExecutionStats(statsDir, sessionId, trigger.workflowId, startMs, 'error', 0);
        return {
          kind: 'complete',
          result: {
            _tag: 'error',
            workflowId: trigger.workflowId,
            message: `Worktree sidecar persist failed: ${worktreePersistResult.error.code} -- ${worktreePersistResult.error.message}`,
            stopReason: 'error',
          },
        };
      }

      console.log(`[WorkflowRunner] Worktree created: sessionId=${sessionId} branch=${branchPrefix}${sessionId} path=${sessionWorkspacePath}`);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[WorkflowRunner] Worktree creation failed: sessionId=${sessionId} error=${errMsg}`);
      writeExecutionStats(statsDir, sessionId, trigger.workflowId, startMs, 'error', 0);
      return {
        kind: 'complete',
        result: { _tag: 'error', workflowId: trigger.workflowId, message: `Worktree creation failed: ${errMsg}`, stopReason: 'error' },
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
  if (firstStep.isComplete) {
    const lifecycle = sidecardLifecycleFor('success', trigger.branchStrategy);
    if (lifecycle.kind === 'delete_now') {
      await fs.unlink(path.join(sessionsDir, `${sessionId}.json`)).catch(() => {});
    }
    emitter?.emit({ kind: 'session_completed', sessionId, workflowId: trigger.workflowId, outcome: 'success', detail: 'stop', ...withWorkrailSession(state.workrailSessionId) });
    if (state.workrailSessionId !== null) {
      daemonRegistry?.unregister(state.workrailSessionId, 'completed');
      handle?.dispose();
    }
    writeExecutionStats(statsDir, sessionId, trigger.workflowId, startMs, 'success', 0);
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
      firstStep,
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
 * visible at the call site. This function is NOT pure -- the tool closures reference
 * `session.state` (mutable) and `onAdvance`/`onComplete` (side-effecting callbacks).
 * Passing these as explicit parameters documents the impurity rather than hiding it.
 *
 * WHY not exported: this is an internal construction detail. Tests exercise tool
 * behavior through runWorkflow() integration paths.
 */
function constructTools(
  session: PreAgentSession,
  ctx: V2ToolContext,
  apiKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
  scope: SessionScope,
): readonly AgentTool[] {
  const { state, sessionWorkspacePath, spawnCurrentDepth, spawnMaxDepth } = session;
  const { fileTracker, onAdvance, onComplete, emitter, activeSessionSet, maxIssueSummaries } = scope;
  const sid = scope.sessionId;
  // WHY from scope (not state directly): SessionScope is the typed boundary for what
  // constructTools() is allowed to see. Passing state directly would leak all mutable
  // session fields to the tool layer; scope captures only the subset tools need.
  const workrailSid = scope.workrailSessionId;
  // WHY toMap(): tool factories (makeReadTool, makeWriteTool, makeEditTool) accept
  // Map<string, ReadFileState> directly. Their public signatures cannot change because
  // tests call them directly with Maps. toMap() is defined on the FileStateTracker
  // interface and returns the same Map instance the tracker uses internally, so
  // read-before-write checks remain valid across all tool invocations.
  const readFileStateMap = fileTracker.toMap();

  return [
    makeCompleteStepTool(
      sid,
      ctx,
      () => state.currentContinueToken,
      onAdvance,
      onComplete,
      // WHY onTokenUpdate: on a blocked response, the engine returns a retryContinueToken.
      // This callback updates state.currentContinueToken so the next complete_step call
      // injects the correct retry token.
      (t: string) => { state.currentContinueToken = t; },
      schemas,
      executeContinueWorkflow,
      emitter,
      workrailSid,
    ),
    makeContinueWorkflowTool(sid, ctx, onAdvance, onComplete, schemas, executeContinueWorkflow, emitter, workrailSid),
    // WHY sessionWorkspacePath: when branchStrategy === 'worktree', all agent file operations
    // must target the isolated worktree, not the main checkout.
    makeBashTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeReadTool(readFileStateMap, schemas, sid, emitter, workrailSid),
    makeWriteTool(readFileStateMap, schemas, sid, emitter, workrailSid),
    makeGlobTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeGrepTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeEditTool(sessionWorkspacePath, readFileStateMap, schemas, sid, emitter, workrailSid),
    makeReportIssueTool(sid, emitter, workrailSid, undefined, (summary: string) => {
      if (state.issueSummaries.length < maxIssueSummaries) {
        state.issueSummaries.push(summary);
      }
    }),
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
 * stuckReason, timeoutReason, pendingSteerParts) and ctx.lastFlushedRef.count.
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
        ctx.state.timeoutReason = 'max_turns';
        ctx.emitter?.emit({ kind: 'agent_stuck', sessionId: ctx.sessionId, reason: 'timeout_imminent', detail: 'Max-turn limit reached', ...withWorkrailSession(ctx.state.workrailSessionId) });
        ctx.agent.abort();
        return;
      } else if (signal.kind === 'repeated_tool_call') {
        ctx.emitter?.emit({ kind: 'agent_stuck', sessionId: ctx.sessionId, reason: 'repeated_tool_call', detail: `Same tool+args called ${ctx.stuckRepeatThreshold} times: ${signal.toolName}`, toolName: signal.toolName, argsSummary: signal.argsSummary, ...withWorkrailSession(ctx.state.workrailSessionId) });
        void writeStuckOutboxEntry({ workflowId: ctx.workflowId, reason: 'repeated_tool_call', ...(ctx.state.issueSummaries.length > 0 ? { issueSummaries: [...ctx.state.issueSummaries] } : {}) });
        if (ctx.stuckConfig.stuckAbortPolicy !== 'notify_only' && ctx.state.stuckReason === null && ctx.state.timeoutReason === null) {
          ctx.state.stuckReason = 'repeated_tool_call';
          ctx.agent.abort();
          return;
        }
      } else if (signal.kind === 'no_progress') {
        ctx.emitter?.emit({ kind: 'agent_stuck', sessionId: ctx.sessionId, reason: 'no_progress', detail: `${signal.turnCount} turns used, 0 step advances (${signal.maxTurns} turn limit)`, ...withWorkrailSession(ctx.state.workrailSessionId) });
        if (ctx.stuckConfig.noProgressAbortEnabled) {
          void writeStuckOutboxEntry({ workflowId: ctx.workflowId, reason: 'no_progress', ...(ctx.state.issueSummaries.length > 0 ? { issueSummaries: [...ctx.state.issueSummaries] } : {}) });
          if (ctx.stuckConfig.stuckAbortPolicy !== 'notify_only' && ctx.state.stuckReason === null && ctx.state.timeoutReason === null) {
            ctx.state.stuckReason = 'no_progress';
            ctx.agent.abort();
            return;
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
      state.lastNToolCalls.push({ toolName, argsSummary });
      if (state.lastNToolCalls.length > stuckRepeatThreshold) state.lastNToolCalls.shift();
    },
    onToolCallCompleted: ({ toolName, durationMs, resultSummary }) => {
      emitter?.emit({ kind: 'tool_call_completed', sessionId, toolName, durationMs, resultSummary, ...withWorkrailSession(state.workrailSessionId) });
    },
    onToolCallFailed: ({ toolName, durationMs, errorMessage }) => {
      emitter?.emit({ kind: 'tool_call_failed', sessionId, toolName, durationMs, errorMessage, ...withWorkrailSession(state.workrailSessionId) });
    },
  };
}

// ---------------------------------------------------------------------------
// buildSessionResult -- pure result construction
// ---------------------------------------------------------------------------

/**
 * Build the WorkflowRunResult for the completed session.
 *
 * Pure: reads state and trigger config, produces a typed result value.
 * Does NOT call finalizeSession -- the caller is responsible for that.
 *
 * WHY pure: the result-building logic is deterministic from its inputs.
 * Extracting it makes the mapping from session state to result type
 * independently readable and testable.
 */
export function buildSessionResult(
  state: Readonly<SessionState>,
  stopReason: string,
  errorMessage: string | undefined,
  trigger: WorkflowTrigger,
  sessionId: string,
  sessionWorktreePath: string | undefined,
): WorkflowRunResult {
  // Stuck takes priority over timeout (invariant 1.4).
  if (state.stuckReason !== null) {
    return {
      _tag: 'stuck',
      workflowId: trigger.workflowId,
      reason: state.stuckReason,
      message: `Session aborted: stuck heuristic fired (${state.stuckReason})`,
      stopReason: 'aborted',
      ...(state.issueSummaries.length > 0 ? { issueSummaries: [...state.issueSummaries] } : {}),
    };
  }

  if (state.timeoutReason !== null) {
    const limitDescription = state.timeoutReason === 'wall_clock'
      ? `${trigger.agentConfig?.maxSessionMinutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES} minutes`
      : `${trigger.agentConfig?.maxTurns ?? DEFAULT_MAX_TURNS} turns`;
    return {
      _tag: 'timeout',
      workflowId: trigger.workflowId,
      reason: state.timeoutReason,
      message: `Workflow ${state.timeoutReason === 'wall_clock' ? 'timed out' : 'exceeded turn limit'} after ${limitDescription}`,
      stopReason: 'aborted',
    };
  }

  if (stopReason === 'error' || errorMessage) {
    const errMsg = errorMessage ?? 'Agent stopped with error reason';
    const lastToolCalled = state.lastNToolCalls.length > 0 ? state.lastNToolCalls[state.lastNToolCalls.length - 1] : null;
    const stuckMarker = `\n\nWORKTRAIN_STUCK: ${JSON.stringify({
      reason: 'session_error',
      error: errMsg.slice(0, 500),
      workflowId: trigger.workflowId,
      sessionId,
      turnCount: state.turnCount,
      stepAdvanceCount: state.stepAdvanceCount,
      ...(lastToolCalled !== null && { lastToolCalled }),
      ...(state.issueSummaries.length > 0 && { issueSummaries: state.issueSummaries }),
    })}`;
    return {
      _tag: 'error',
      workflowId: trigger.workflowId,
      message: errMsg,
      stopReason,
      lastStepNotes: stuckMarker,
    };
  }

  // Success
  return {
    _tag: 'success',
    workflowId: trigger.workflowId,
    stopReason,
    ...(state.lastStepNotes !== undefined ? { lastStepNotes: state.lastStepNotes } : {}),
    ...(state.lastStepArtifacts !== undefined ? { lastStepArtifacts: state.lastStepArtifacts } : {}),
    ...(sessionWorktreePath !== undefined ? { sessionWorkspacePath: sessionWorktreePath } : {}),
    ...(sessionWorktreePath !== undefined ? { sessionId } : {}),
    ...(trigger.botIdentity !== undefined ? { botIdentity: trigger.botIdentity } : {}),
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
  const { state, firstStep, sessionWorkspacePath, sessionWorktreePath, agentClient, modelId } = preAgentSession;
  const startContinueToken = preAgentSession.continueToken;
  const handle = preAgentSession.handle;

  const MAX_ISSUE_SUMMARIES = 10;
  const STUCK_REPEAT_THRESHOLD = 3;

  const onAdvance = (stepText: string, continueToken: string): void => {
    state.pendingSteerParts.push(stepText);
    state.stepAdvanceCount++;
    state.currentContinueToken = continueToken;
    if (state.workrailSessionId !== null) daemonRegistry?.heartbeat(state.workrailSessionId);
    emitter?.emit({ kind: 'step_advanced', sessionId, ...withWorkrailSession(state.workrailSessionId) });
  };

  const onComplete = (notes: string | undefined, artifacts?: readonly unknown[]): void => {
    state.isComplete = true;
    state.lastStepNotes = notes;
    state.lastStepArtifacts = artifacts;
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
    workrailSessionId: state.workrailSessionId,
    emitter,
    sessionId,
    workflowId: trigger.workflowId,
    activeSessionSet,
    maxIssueSummaries: MAX_ISSUE_SUMMARIES,
  };
  const tools = constructTools(preAgentSession, ctx, apiKey, schemas, scope);

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
  const sessionCtx = buildSessionContext(
    trigger,
    contextBundle,
    firstStep.pending?.prompt ?? 'No step content available',
  );

  // ---- Observability callbacks for AgentLoop ----
  const agentCallbacks = buildAgentCallbacks(sessionId, state, modelId, emitter, STUCK_REPEAT_THRESHOLD);

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
 * buildSessionResult() reading state.stuckReason and state.timeoutReason
 * after this function returns.
 *
 * WHY a named function (not inline in runWorkflow): makes the agent loop
 * independently readable. The boundary is clean: everything from stuckConfig
 * setup through handle?.dispose() in finally belongs here.
 *
 * WHY intentionally impure: mutates session.preAgentSession.state (turnCount,
 * stuckReason, timeoutReason, stepAdvanceCount, pendingSteerParts) via the
 * turn_end subscriber and tool callbacks. This impurity is by design and is
 * documented in the SessionState interface.
 */
async function runAgentLoop(
  session: AgentReadySession,
  trigger: WorkflowTrigger,
  sessionsDir: string,
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
  const conversationPath = path.join(sessionsDir, `${sessionId}-conversation.jsonl`);
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
        if (state.timeoutReason === null) {
          state.timeoutReason = 'wall_clock';
        }
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
    // and mutate the closed-over timeoutReason variable. clearTimeout on an
    // already-fired or undefined handle is a safe no-op.
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    // Deregister steer callback so the HTTP endpoint returns 404 for completed sessions.
    // Dispose the session handle: deregisters from ActiveSessionSet so steer() stops
    // working and abortRegistry.size decrements (shutdown drain window terminates).
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
  );
  if (preResult.kind === 'complete') {
    return preResult.result;
  }

  // ---- Agent-ready phase: context loading + tool construction + AgentLoop setup ----
  const readySession = await buildAgentReadySession(
    preResult.session, trigger, ctx, apiKey, sessionId,
    emitter, daemonRegistry, activeSessionSet,
  );

  // ---- Agent loop phase: run prompt loop to completion ----
  const outcome = await runAgentLoop(readySession, trigger, sessionsDir);

  // Map SessionOutcome back to the raw stopReason/errorMessage that buildSessionResult expects.
  const stopReason = outcome.kind === 'aborted' ? 'error' : outcome.stopReason;
  const errorMessage = outcome.errorMessage;

  // ---- Build finalization context (shared across all result paths) ----
  const { state, sessionWorktreePath } = readySession.preAgentSession;
  const conversationPath = path.join(sessionsDir, `${sessionId}-conversation.jsonl`);
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
