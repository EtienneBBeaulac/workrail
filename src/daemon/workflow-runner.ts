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
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { glob as tinyGlob } from 'tinyglobby';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { AgentLoop } from "./agent-loop.js";
import type { AgentTool, AgentToolResult, AgentEvent, AgentLoopCallbacks, AgentInternalMessage } from "./agent-loop.js";
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

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum wall-clock time allowed for a single Bash tool invocation. */
const BASH_TIMEOUT_MS = 5 * 60 * 1000;

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

/**
 * Conditionally spreads workrailSessionId into a daemon event object.
 *
 * WHY: workrailSessionId (the WorkRail sess_xxx ID) is unavailable at session_started
 * time -- it can only be decoded from the continueToken after executeStartWorkflow()
 * returns. All subsequent events include it when available, via this helper.
 * Returns an empty object when sid is null so callers can spread unconditionally.
 */
function withWorkrailSession(sid: string | null | undefined): { workrailSessionId?: string } {
  return sid != null ? { workrailSessionId: sid } : {};
}

/**
 * Directory that holds per-session crash-recovery state files.
 * Each concurrent runWorkflow() call writes to its own <sessionId>.json file,
 * so concurrent sessions never clobber each other.
 *
 * Note: sessionId is a process-local UUID generated at runWorkflow() entry --
 * it is NOT the WorkRail server session ID. The server continueToken is stored
 * as a value inside the file, so crash-resume can retrieve it by reading the file.
 */
export const DAEMON_SESSIONS_DIR = path.join(os.homedir(), '.workrail', 'daemon-sessions');

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
/**
 * Error shape for a persistTokens failure.
 * WHY its own type (not a generic string): the code field lets callers
 * distinguish filesystem errors (ENOSPC, EPERM) from logic errors without
 * string parsing.
 */
export interface PersistTokensError {
  readonly code: string;
  readonly message: string;
}

async function persistTokens(
  sessionId: string,
  continueToken: string,
  checkpointToken: string | null,
  worktreePath?: string,
  recoveryContext?: {
    readonly workflowId: string;
    readonly goal: string;
    readonly workspacePath: string;
  },
): Promise<Result<void, PersistTokensError>> {
  try {
    await fs.mkdir(DAEMON_SESSIONS_DIR, { recursive: true });

    const sessionPath = path.join(DAEMON_SESSIONS_DIR, `${sessionId}.json`);
    const state = JSON.stringify(
      {
        continueToken,
        checkpointToken,
        ts: Date.now(),
        ...(worktreePath !== undefined ? { worktreePath } : {}),
        ...(recoveryContext !== undefined ? {
          workflowId: recoveryContext.workflowId,
          goal: recoveryContext.goal,
          workspacePath: recoveryContext.workspacePath,
        } : {}),
      },
      null,
      2,
    );
    const tmp = `${sessionPath}.tmp`;
    await fs.writeFile(tmp, state, 'utf8');
    await fs.rename(tmp, sessionPath);
    return ok(undefined);
  } catch (e: unknown) {
    const nodeErr = e as NodeJS.ErrnoException;
    return err({ code: nodeErr.code ?? 'UNKNOWN', message: nodeErr.message ?? String(e) });
  }
}

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
 */
export async function runStartupRecovery(
  sessionsDir: string = DAEMON_SESSIONS_DIR,
  execFn: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }> = execFileAsync,
  ctx?: V2ToolContext,
  _countStepAdvancesFn: typeof countOrphanStepAdvances = countOrphanStepAdvances,
  _executeContinueWorkflowFn: typeof executeContinueWorkflow = executeContinueWorkflow,
  _runWorkflowFn: typeof runWorkflow = runWorkflow,
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
            process.env['ANTHROPIC_API_KEY'] ?? '',
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

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

export function makeContinueWorkflowTool(
  sessionId: string,
  ctx: V2ToolContext,
  onAdvance: (nextStepText: string, continueToken: string) => void,
  onComplete: (notes: string | undefined, artifacts?: readonly unknown[]) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
  // Optional injection point for testing -- defaults to the real implementation.
  _executeContinueWorkflowFn: typeof executeContinueWorkflow = executeContinueWorkflow,
  emitter?: DaemonEventEmitter,
  workrailSessionId?: string | null,
): AgentTool {
  return {
    name: 'continue_workflow',
    description:
      '[DEPRECATED in daemon sessions -- use complete_step instead] ' +
      'Advance the WorkRail workflow to the next step. Call this after completing all work ' +
      'required by the current step. Include your notes in notesMarkdown. ' +
      'When the step requires an assessment gate, include wr.assessment objects in artifacts.',
    inputSchema: schemas['ContinueWorkflowParams'],
    label: 'Continue Workflow',

    execute: async (
      _toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      console.log(`[WorkflowRunner] Tool: continue_workflow sessionId=${sessionId}`);
      emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'continue_workflow', summary: (params.intent as string | undefined) ?? 'advance', ...withWorkrailSession(workrailSessionId) });
      const result = await _executeContinueWorkflowFn(
        {
          continueToken: params.continueToken,
          intent: (params.intent ?? 'advance') as 'advance' | 'rehydrate',
          // WHY: output is constructed when either notesMarkdown or artifacts is present.
          // Agents may need to submit assessment artifacts without notes (e.g. when the
          // step's only requirement is an assessment gate). Using `?.length` prevents an
          // empty artifacts array from constructing a spurious output object.
          output: (params.notesMarkdown || (params.artifacts as unknown[] | undefined)?.length)
            ? {
                ...(params.notesMarkdown ? { notesMarkdown: params.notesMarkdown } : {}),
                ...(params.artifacts ? { artifacts: params.artifacts } : {}),
              }
            : undefined,
          context: params.context,
        },
        ctx,
      );

      if (result.isErr()) {
        throw new Error(`continue_workflow failed: ${result.error.kind} -- ${JSON.stringify(result.error)}`);
      }

      const out = result.value.response;

      // Persist tokens atomically before returning -- crash safety invariant.
      // WHY continueToken vs retryToken: for a blocked response, nextCall.params.continueToken
      // is the retry token (retryContinueToken for retryable, or continueToken for non-retryable).
      // Persisting this ensures crash recovery resumes with the correct token.
      const continueToken = out.continueToken ?? '';
      const checkpointToken = out.checkpointToken ?? null;
      const persistToken = (out.kind === 'blocked' ? out.nextCall?.params.continueToken : undefined) ?? continueToken;
      if (persistToken) {
        const persistResult = await persistTokens(sessionId, persistToken, checkpointToken);
        // WHY log-and-continue (not throw): a persist failure degrades crash recovery but
        // the session is still live and the LLM has the token in memory. Killing the session
        // here loses in-progress work. Invariant 4.3: onAdvance/onTokenUpdate must still fire.
        if (persistResult.kind === 'err') {
          console.warn(`[WorkflowRunner] persistTokens failed (continue_workflow): ${persistResult.error.code} -- ${persistResult.error.message}`);
        }
      }

      // WHY: when the engine returns a blocked response, the step did NOT advance.
      // Calling onAdvance() would erroneously signal advancement and cause the agent
      // to loop forever believing it moved forward. Return feedback instead so the
      // agent knows what to fix and can retry the same step.
      if (out.kind === 'blocked') {
        const retryToken = out.nextCall?.params.continueToken ?? continueToken;
        const lines: string[] = ['## Step blocked -- action required\n'];

        for (const blocker of out.blockers.blockers) {
          lines.push(blocker.message);
          if (blocker.suggestedFix) {
            lines.push(`\nWhat to do: ${blocker.suggestedFix}`);
          }
          lines.push('');
        }

        if (out.validation) {
          if (out.validation.issues.length > 0) {
            lines.push('**Issues:**');
            for (const issue of out.validation.issues) lines.push(`- ${issue}`);
            lines.push('');
          }
          if (out.validation.suggestions.length > 0) {
            lines.push('**Suggestions:**');
            for (const s of out.validation.suggestions) lines.push(`- ${s}`);
            lines.push('');
          }
        }

        if (out.assessmentFollowup) {
          lines.push(`**Follow-up required:** ${out.assessmentFollowup.title}`);
          lines.push(out.assessmentFollowup.guidance);
          lines.push('');
        }

        if (out.retryable) {
          lines.push(`Retry the same step with corrected output.\n\ncontinueToken: ${retryToken}`);
        } else {
          lines.push(`You cannot proceed without resolving this. Inform the user and wait for their response, then call continue_workflow.\n\ncontinueToken: ${retryToken}`);
        }

        const feedback = lines.join('\n');
        return {
          content: [{ type: 'text', text: feedback }],
          details: out,
        };
      }

      if (out.isComplete) {
        // Pass the agent's notes and artifacts from this final step to onComplete so the
        // trigger layer can extract the structured handoff artifact for delivery, and so
        // coordinators can read typed artifacts via WorkflowRunSuccess.lastStepArtifacts.
        onComplete(
          params.notesMarkdown as string | undefined,
          Array.isArray(params.artifacts) ? (params.artifacts as readonly unknown[]) : undefined,
        );
        return {
          content: [{ type: 'text', text: 'Workflow complete. All steps have been executed.' }],
          details: out,
        };
      }

      const pending = out.pending;
      const stepText = pending
        ? `## Next step: ${pending.title}\n\n${pending.prompt}\n\ncontinueToken: ${continueToken}`
        : `Step advanced. continueToken: ${continueToken}`;

      onAdvance(stepText, continueToken);

      return {
        content: [{ type: 'text', text: stepText }],
        details: out,
      };
    },
  };
}

/**
 * Build the complete_step tool for daemon sessions.
 *
 * WHY this tool exists: continue_workflow requires the LLM to round-trip a
 * continueToken (an HMAC-signed opaque token). The LLM frequently mangles
 * this token, causing TOKEN_BAD_SIGNATURE errors that kill sessions. complete_step
 * eliminates this failure mode by having the daemon inject the continueToken
 * internally -- the LLM only provides notes, artifacts, and context.
 *
 * WHY two token-update paths: the continueToken must be updated on both
 * (a) successful advance: getCurrentToken() returns the new next-step token
 *     from the response, which onAdvance will have stored before the next call.
 * (b) blocked retry: the engine returns a retryContinueToken that must be used
 *     on the retry call; onTokenUpdate updates the closure variable so the next
 *     complete_step call injects the correct retry token.
 * Both paths are mutually exclusive (kind: 'ok' vs kind: 'blocked') and cannot
 * race because AgentLoop runs tools sequentially (toolExecution: 'sequential').
 *
 * WHY getCurrentToken is a getter (not a value): the closure variable
 * currentContinueToken in runWorkflow() is updated after each step advance.
 * The getter captures the variable by reference so each complete_step call
 * reads the current token at call time, not at construction time.
 *
 * @param sessionId - Process-local UUID for crash-recovery token persistence.
 * @param ctx - V2ToolContext from the shared DI container.
 * @param getCurrentToken - Getter that returns the current continueToken from the
 *   runWorkflow() closure. Called at tool execution time, not construction time.
 * @param onAdvance - Called after a successful step advance with the next step text
 *   and the new continueToken. Appends step text to pendingSteerParts and updates currentContinueToken.
 * @param onComplete - Called when the workflow is complete.
 * @param onTokenUpdate - Called when the continueToken changes without an advance
 *   (i.e., on a blocked retry). Updates currentContinueToken in the runWorkflow() closure.
 * @param schemas - Plain JSON Schema map from getSchemas().
 * @param _executeContinueWorkflowFn - Optional injection point for testing.
 * @param emitter - Optional event emitter for structured lifecycle events.
 * @param workrailSessionId - WorkRail session ID for event correlation.
 */
export function makeCompleteStepTool(
  sessionId: string,
  ctx: V2ToolContext,
  getCurrentToken: () => string,
  onAdvance: (nextStepText: string, continueToken: string) => void,
  onComplete: (notes: string | undefined, artifacts?: readonly unknown[]) => void,
  onTokenUpdate: (t: string) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
  // Optional injection point for testing -- defaults to the real implementation.
  _executeContinueWorkflowFn: typeof executeContinueWorkflow = executeContinueWorkflow,
  emitter?: DaemonEventEmitter,
  workrailSessionId?: string | null,
): AgentTool {
  return {
    name: 'complete_step',
    description:
      'Mark the current WorkRail workflow step as complete and advance to the next one. ' +
      'Call this after completing all work required by the current step. ' +
      'Include your substantive notes (min 50 characters) describing what you did. ' +
      'The daemon manages the session token internally -- you do not need a continueToken. ' +
      'When the step requires an assessment gate, include wr.assessment objects in artifacts.',
    inputSchema: schemas['CompleteStepParams'],
    label: 'Complete Step',

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (
      _toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      console.log(`[WorkflowRunner] Tool: complete_step sessionId=${sessionId}`);
      emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'complete_step', summary: 'advance', ...withWorkrailSession(workrailSessionId) });

      // WHY runtime validation: JSON Schema minLength is informational to the LLM
      // but NOT enforced by AgentLoop. We must validate here so the LLM gets a
      // clear error immediately, rather than a downstream blocked response from
      // the engine. Fail fast at the boundary.
      const notes = params.notes as string | undefined;
      if (!notes || notes.length < 50) {
        throw new Error(
          `complete_step: notes is required and must be at least 50 characters. ` +
          `Provide substantive notes describing what you did, what you produced, and any notable decisions. ` +
          `Current length: ${notes?.length ?? 0} characters.`,
        );
      }

      // WHY inject getCurrentToken(): the daemon holds the continueToken in a
      // closure variable (currentContinueToken in runWorkflow()). The LLM never
      // sees this token -- we inject it here so the engine can authenticate the
      // advance call. This is the core value of complete_step over continue_workflow.
      const continueToken = getCurrentToken();

      const result = await _executeContinueWorkflowFn(
        {
          continueToken,
          intent: 'advance',
          // WHY: output is constructed when notes is present (always true after validation)
          // or when artifacts is a non-empty array (e.g. assessment-only steps without notes,
          // though complete_step always requires notes). An empty artifacts array must not
          // spread {} or {} with artifacts: [] -- use ?.length to guard against this.
          output: (notes || (params.artifacts as unknown[] | undefined)?.length)
            ? {
                notesMarkdown: notes,
                ...((params.artifacts as unknown[] | undefined)?.length ? { artifacts: params.artifacts } : {}),
              }
            : undefined,
          context: params.context,
        },
        ctx,
      );

      if (result.isErr()) {
        throw new Error(`complete_step failed: ${result.error.kind} -- ${JSON.stringify(result.error)}`);
      }

      const out = result.value.response;

      // Persist tokens atomically before returning -- crash safety invariant.
      // WHY this must happen before onAdvance/onTokenUpdate: a crash between
      // executeContinueWorkflow returning and the token being persisted would
      // leave no recoverable state. Persisting first ensures crash recovery works.
      const newContinueToken = out.continueToken ?? '';
      const checkpointToken = out.checkpointToken ?? null;
      // WHY blocked uses retry token: on a blocked response, the engine returns a
      // retryContinueToken (via nextCall.params.continueToken). The session token
      // advances to this retry token -- the original session token is consumed.
      const persistToken = (out.kind === 'blocked' ? out.nextCall?.params.continueToken : undefined) ?? newContinueToken;
      if (persistToken) {
        const persistResult = await persistTokens(sessionId, persistToken, checkpointToken);
        // WHY log-and-continue (not throw): a persist failure degrades crash recovery but
        // the session is still live. Invariant 4.3: onAdvance/onTokenUpdate must still fire.
        if (persistResult.kind === 'err') {
          console.warn(`[WorkflowRunner] persistTokens failed (complete_step): ${persistResult.error.code} -- ${persistResult.error.message}`);
        }
      }

      // WHY onTokenUpdate on blocked: the next complete_step call must inject the
      // retry token (not the original session token). We update the closure variable
      // so getCurrentToken() returns the correct retry token on the next call.
      // This is a separate path from onAdvance because a blocked response does NOT
      // advance the step -- it only changes which token is valid for retry.
      if (out.kind === 'blocked') {
        const retryToken = out.nextCall?.params.continueToken ?? newContinueToken;
        // Update the closure token to the retry token for the next complete_step call.
        onTokenUpdate(retryToken);

        const lines: string[] = ['## Step blocked -- action required\n'];

        for (const blocker of out.blockers.blockers) {
          lines.push(blocker.message);
          if (blocker.suggestedFix) {
            lines.push(`\nWhat to do: ${blocker.suggestedFix}`);
          }
          lines.push('');
        }

        if (out.validation) {
          if (out.validation.issues.length > 0) {
            lines.push('**Issues:**');
            for (const issue of out.validation.issues) lines.push(`- ${issue}`);
            lines.push('');
          }
          if (out.validation.suggestions.length > 0) {
            lines.push('**Suggestions:**');
            for (const s of out.validation.suggestions) lines.push(`- ${s}`);
            lines.push('');
          }
        }

        if (out.assessmentFollowup) {
          lines.push(`**Follow-up required:** ${out.assessmentFollowup.title}`);
          lines.push(out.assessmentFollowup.guidance);
          lines.push('');
        }

        if (out.retryable) {
          lines.push(`Retry the same step: call complete_step again with corrected notes.`);
        } else {
          lines.push(`You cannot proceed without resolving this. Inform the user and wait for their response, then call complete_step.`);
        }

        const feedback = lines.join('\n');
        return {
          content: [{ type: 'text', text: feedback }],
          details: out,
        };
      }

      if (out.isComplete) {
        // Forward artifacts alongside notes so WorkflowRunSuccess.lastStepArtifacts is
        // populated for coordinator consumption. See docs/discovery/artifacts-coordinator-channel.md.
        onComplete(notes, Array.isArray(params.artifacts) ? (params.artifacts as readonly unknown[]) : undefined);
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'complete' }) }],
          details: out,
        };
      }

      const pending = out.pending;
      // WHY no continueToken in the response text: the LLM does not need the token.
      // Including it would invite the LLM to store it and pass it to continue_workflow,
      // defeating the purpose of complete_step.
      const nextStepTitle = pending?.title ?? 'Next step';
      const stepText = pending
        ? `${JSON.stringify({ status: 'advanced', nextStep: pending.title })}\n\n## ${pending.title}\n\n${pending.prompt}`
        : JSON.stringify({ status: 'advanced', nextStep: nextStepTitle });

      onAdvance(stepText, newContinueToken);

      return {
        content: [{ type: 'text', text: stepText }],
        details: out,
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeBashTool(workspacePath: string, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Bash',
    description:
      'Execute a shell command. Throws on failure (non-zero exit with stderr, or exit code 2+). ' +
      'Exit code 1 with empty stderr is treated as "no match found" (standard grep semantics) and ' +
      'returns empty output without throwing. ' +
      `Maximum execution time: ${BASH_TIMEOUT_MS / 1000}s.`,
    inputSchema: schemas['BashParams'],
    label: 'Bash',

    execute: async (
      _toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.command !== 'string' || !params.command) throw new Error('Bash: command must be a non-empty string');
      console.log(`[WorkflowRunner] Tool: bash "${String(params.command).slice(0, 80)}"`);
      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Bash', summary: String(params.command).slice(0, 80), ...withWorkrailSession(workrailSessionId) });
      const cwd = params.cwd ?? workspacePath;
      try {
        const { stdout, stderr } = await execAsync(params.command, {
          cwd,
          timeout: BASH_TIMEOUT_MS,
          shell: '/bin/bash',
        });
        const output = [stdout, stderr].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output || '(no output)' }],
          details: { stdout, stderr },
        };
      } catch (err: unknown) {
        // Node's child_process.exec errors (ExecException) attach stdout, stderr,
        // code, and signal as own properties. Extract them so the agent can reason
        // about what went wrong and retry intelligently.
        // WHY rawCode: `code` is null (not a number) when the process was killed by
        // a signal (e.g. SIGTERM on exec timeout). Check rawCode before coalescing
        // so the signal branch is reachable -- `rawCode ?? 'unknown'` would collapse
        // null to 'unknown' and make signal unreachable.
        const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown; signal?: unknown };
        const stdout = String(e.stdout ?? '');
        const stderr = String(e.stderr ?? '');
        const rawCode = e.code;
        const signal = e.signal;

        // Exit code 1 with empty stderr is "no match found" -- not a real error.
        // This is standard POSIX semantics for grep (exit 1 = no lines matched,
        // exit 2 = genuine error). Applying the same rule to any command that exits
        // 1 with no error output is safe: a command that fails silently is almost
        // always reporting "nothing found", not a broken execution.
        // WHY `rawCode === 1 && !stderr.trim()`: rawCode is a number when set by
        // normal process exit; the trim() guard ignores purely-whitespace stderr.
        // This branch is NOT entered for exit 2+ (always an error) or when stderr
        // is non-empty (the process wrote a diagnostic message, so it is a real error).
        if (rawCode === 1 && !stderr.trim()) {
          return {
            content: [{ type: 'text', text: stdout || '(no output)' }],
            details: { stdout, stderr },
          };
        }

        const exitInfo = rawCode != null
          ? `exit ${String(rawCode)}`
          : signal
            ? `signal ${String(signal)}`
            : 'exit unknown';
        throw new Error(
          `Command failed: ${params.command} (${exitInfo})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// File navigation and editing tools
// ---------------------------------------------------------------------------

/**
 * Normalizes LLM-generated typographic quotes to their ASCII equivalents.
 *
 * WHY: LLMs trained on typographic text often generate curly single quotes (\u2018, \u2019)
 * and curly double quotes (\u201C, \u201D) where the user intended straight ASCII quotes.
 * When these appear in an `old_string` for Edit, the exact match fails. This function
 * tries the normalized form as a fallback, recovering from the most common LLM quote variants.
 *
 * Handles ~95% of LLM quote variants. Full Unicode normalization is YAGNI (YELLOW-2).
 */
function findActualString(fileContent: string, oldString: string): string | null {
  if (fileContent.includes(oldString)) return oldString;
  // Handle LLM-generated typographic quotes
  const normalized = oldString
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '--');
  if (fileContent.includes(normalized)) return normalized;
  return null;
}

/** Max file size Read will return without offset/limit (256 KiB). */
const READ_SIZE_CAP_BYTES = 256 * 1024;

/** Glob paths always excluded from makeGlobTool results. */
const GLOB_ALWAYS_EXCLUDE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeReadTool(readFileState: Map<string, ReadFileState>, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Read',
    description:
      'Read the contents of a file at the given absolute path. ' +
      'Content is returned in cat -n format: each line is prefixed with its 1-indexed line number and a tab character (e.g. "1\\tline one\\n2\\tline two"). ' +
      'Use offset (0-indexed start line) and limit (max lines) to read a slice of a large file.',
    inputSchema: schemas['ReadParams'],
    label: 'Read',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.filePath !== 'string' || !params.filePath) throw new Error('Read: filePath must be a non-empty string');
      const filePath: string = params.filePath;
      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Read', summary: filePath.slice(0, 80), ...withWorkrailSession(workrailSessionId) });

      // Block device paths to prevent reads from infinite streams
      const devPaths = ['/dev/stdin', '/dev/tty', '/dev/zero', '/dev/random', '/dev/full', '/dev/urandom'];
      if (devPaths.some(d => filePath === d)) {
        throw new Error(`Refusing to read device path: ${filePath}`);
      }

      const stat = await fs.stat(filePath);
      const offset: number = params.offset ?? 0;
      const limit: number | undefined = params.limit;
      const isPaginated = params.offset !== undefined || params.limit !== undefined;
      if (!isPaginated && stat.size > READ_SIZE_CAP_BYTES) {
        throw new Error(
          `File is too large to read at once (${stat.size} bytes, cap is ${READ_SIZE_CAP_BYTES} bytes). ` +
          `Use offset and limit parameters to read a specific range of lines.`,
        );
      }

      const rawContent = await fs.readFile(filePath, 'utf8');
      const allLines = rawContent.split('\n');
      const isPartialView = offset !== 0 || limit != null;

      const slicedLines = limit != null ? allLines.slice(offset, offset + limit) : allLines.slice(offset);
      const startLine = offset; // 0-indexed offset -> 1-indexed line numbers start at offset+1
      const formatted = slicedLines.map((l, i) => `${startLine + i + 1}\t${l}`).join('\n');

      // Store in readFileState so Edit and Write can enforce staleness checks
      readFileState.set(filePath, { content: rawContent, timestamp: stat.mtimeMs, isPartialView });

      return {
        content: [{ type: 'text', text: formatted }],
        details: { filePath, totalLines: allLines.length, returnedLines: slicedLines.length, offset, isPartialView },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeWriteTool(readFileState: Map<string, ReadFileState>, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Write',
    description:
      'Write content to a file at the given absolute path. Creates parent directories if needed. ' +
      'For existing files: the file must have been read in this session and must not have changed on disk since then. ' +
      'For new files (path does not exist): no prior read is required.',
    inputSchema: schemas['WriteParams'],
    label: 'Write',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.filePath !== 'string' || !params.filePath) throw new Error('Write: filePath must be a non-empty string');
      if (typeof params.content !== 'string') throw new Error('Write: content must be a string');
      const filePath: string = params.filePath;
      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Write', summary: filePath.slice(0, 80), ...withWorkrailSession(workrailSessionId) });

      // Staleness guard: only for existing files. New files bypass the check entirely.
      // WHY: a new file has never been read, so there is nothing stale to guard against.
      let existsOnDisk = false;
      try {
        await fs.access(filePath);
        existsOnDisk = true;
      } catch {
        // File does not exist -- new file, no guard needed
      }

      if (existsOnDisk) {
        const state = readFileState.get(filePath);
        if (!state) {
          throw new Error(
            `File has not been read in this session. Call Read first before writing to it: ${filePath}`,
          );
        }
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs !== state.timestamp) {
          throw new Error(
            `File has been modified since it was read. Re-read before writing: ${filePath}`,
          );
        }
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, params.content, 'utf8');

      // Update readFileState so a subsequent Edit/Write sees the new mtime
      const newStat = await fs.stat(filePath);
      readFileState.set(filePath, { content: params.content, timestamp: newStat.mtimeMs, isPartialView: false });

      return {
        content: [{ type: 'text', text: `Written ${params.content.length} bytes to ${filePath}` }],
        details: { filePath, length: params.content.length },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeGlobTool(workspacePath: string, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Glob',
    description:
      'Find files matching a glob pattern. Returns newline-separated relative file paths, sorted by modification time descending. ' +
      'node_modules, .git, dist, and build directories are always excluded. ' +
      'Results are capped at 100 files.',
    inputSchema: schemas['GlobParams'],
    label: 'Glob',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.pattern !== 'string' || !params.pattern) throw new Error('Glob: pattern must be a non-empty string');
      const pattern: string = params.pattern;
      const searchRoot: string = params.path ?? workspacePath;
      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Glob', summary: pattern.slice(0, 80), ...withWorkrailSession(workrailSessionId) });

      const GLOB_LIMIT = 100;

      let paths: string[];
      try {
        paths = await tinyGlob(pattern, {
          cwd: searchRoot,
          ignore: GLOB_ALWAYS_EXCLUDE,
          absolute: false,
        });
      } catch {
        // Non-existent search root or invalid pattern returns empty
        paths = [];
      }

      // Sort by mtime descending (most recently modified first)
      const withMtimes = await Promise.all(
        paths.map(async (p) => {
          try {
            const stat = await fs.stat(path.join(searchRoot, p));
            return { p, mtime: stat.mtimeMs };
          } catch {
            return { p, mtime: 0 };
          }
        }),
      );
      withMtimes.sort((a, b) => b.mtime - a.mtime);

      const sorted = withMtimes.map(x => x.p);
      const truncated = sorted.length > GLOB_LIMIT;
      const result = sorted.slice(0, GLOB_LIMIT);

      let text = result.join('\n');
      if (truncated) {
        text += '\n[Results truncated at 100 files]';
      }

      return {
        content: [{ type: 'text', text: text || '(no matches)' }],
        details: { pattern, searchRoot, matchCount: sorted.length, truncated },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeGrepTool(workspacePath: string, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Grep',
    description:
      'Search file contents using ripgrep (rg). Fast regex search with optional context lines, file-type filtering, and case-insensitive mode. ' +
      'output_mode: "files_with_matches" (default) returns only file paths; "content" returns matching lines; "count" returns match counts per file. ' +
      'node_modules and .git are always excluded.',
    inputSchema: schemas['GrepParams'],
    label: 'Grep',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.pattern !== 'string' || !params.pattern) throw new Error('Grep: pattern must be a non-empty string');
      const pattern: string = params.pattern;
      const searchPath: string = params.path ?? workspacePath;
      const outputMode: string = params.output_mode ?? 'files_with_matches';
      const headLimit: number = params.head_limit ?? 250;
      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Grep', summary: pattern.slice(0, 80), ...withWorkrailSession(workrailSessionId) });

      const args: string[] = [
        '--hidden',
        '--glob', '!node_modules',
        '--glob', '!.git',
        '--max-columns', '500',
      ];

      if (params['-i']) args.push('-i');
      if (params.glob) { args.push('--glob', params.glob); }
      if (params.type) { args.push('--type', params.type); }

      switch (outputMode) {
        case 'files_with_matches':
          args.push('--files-with-matches');
          break;
        case 'count':
          args.push('--count');
          break;
        case 'content':
          args.push('--vimgrep');
          if (params.context != null) { args.push('-C', String(params.context)); }
          break;
      }

      args.push('--', pattern, searchPath);

      let stdout: string;
      try {
        const result = await execFileAsync('rg', args, { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 });
        stdout = result.stdout;
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
        // ENOENT: rg binary not found
        if (nodeErr.code === 'ENOENT') {
          throw new Error(
            'ripgrep (rg) is not installed. Install it with: brew install ripgrep (macOS) or apt install ripgrep (Ubuntu/Debian).',
          );
        }
        // exit code 1 from rg means "no matches found" -- not an error
        if (typeof nodeErr.code === 'number' && nodeErr.code === 1) {
          return {
            content: [{ type: 'text', text: '(no matches)' }],
            details: { pattern, searchPath, outputMode },
          };
        }
        throw new Error(`rg failed: ${nodeErr.message ?? String(err)}`);
      }

      // Apply head_limit
      const lines = stdout.split('\n').filter(l => l.length > 0);
      const truncated = lines.length > headLimit;
      let result = lines.slice(0, headLimit).join('\n');
      if (truncated) {
        result += `\n[Results truncated at ${headLimit} lines. Use a more specific pattern or increase head_limit.]`;
      }

      return {
        content: [{ type: 'text', text: result || '(no matches)' }],
        details: { pattern, searchPath, outputMode, lineCount: lines.length, truncated },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeEditTool(workspacePath: string, readFileState: Map<string, ReadFileState>, schemas: Record<string, any>, sessionId?: string, emitter?: DaemonEventEmitter, workrailSessionId?: string | null): AgentTool {
  return {
    name: 'Edit',
    description:
      'Perform an exact string replacement in a file. ' +
      'The file must have been read in this session via the Read tool. ' +
      'By default, old_string must appear exactly once; use replace_all=true to replace all occurrences. ' +
      'Do NOT include line-number prefixes (e.g. "1\\t") from Read output in old_string or new_string.',
    inputSchema: schemas['EditParams'],
    label: 'Edit',

    execute: async (
      _toolCallId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      if (typeof params.file_path !== 'string' || !params.file_path) throw new Error('Edit: file_path must be a non-empty string');
      if (typeof params.old_string !== 'string') throw new Error('Edit: old_string must be a string');
      if (typeof params.new_string !== 'string') throw new Error('Edit: new_string must be a string');
      const rawFilePath: string = params.file_path;
      const absoluteFilePath = path.isAbsolute(rawFilePath)
        ? rawFilePath
        : path.join(workspacePath, rawFilePath);
      // Enforce workspace boundary: prevent edits outside the workspace
      if (!absoluteFilePath.startsWith(workspacePath)) {
        throw new Error(`Edit target is outside the workspace: ${rawFilePath}`);
      }
      const filePath: string = absoluteFilePath;
      const oldString: string = params.old_string;
      const newString: string = params.new_string;
      const replaceAll: boolean = params.replace_all ?? false;

      if (sessionId) emitter?.emit({ kind: 'tool_called', sessionId, toolName: 'Edit', summary: filePath.slice(0, 80), ...withWorkrailSession(workrailSessionId) });

      // Validate that old_string and new_string differ
      if (oldString === newString) {
        throw new Error('old_string and new_string are identical. No edit needed.');
      }

      // Read-before-write enforcement
      const state = readFileState.get(filePath);
      if (!state) {
        throw new Error(
          `File has not been read in this session. Call Read first before editing: ${filePath}`,
        );
      }

      // Staleness check
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(filePath);
      } catch {
        throw new Error(`File not found: ${filePath}. It may have been deleted after it was read.`);
      }
      if (stat.mtimeMs !== state.timestamp) {
        throw new Error(
          `File has been modified since it was read. Re-read before editing: ${filePath}`,
        );
      }

      const currentContent = await fs.readFile(filePath, 'utf8');

      // Find the actual string to replace (with optional curly-quote normalization)
      const actualString = findActualString(currentContent, oldString);
      if (actualString === null) {
        throw new Error(
          `String to replace not found in file. Make sure old_string exactly matches the file content ` +
          `(do not include line-number prefixes from Read output): ${filePath}`,
        );
      }

      // Count occurrences
      const occurrences = currentContent.split(actualString).length - 1;
      if (!replaceAll && occurrences > 1) {
        throw new Error(
          `old_string appears ${occurrences} times in the file. ` +
          `Provide a more specific string that matches exactly once, or set replace_all=true to replace all occurrences.`,
        );
      }

      // Apply the replacement
      const updatedContent = replaceAll
        ? currentContent.split(actualString).join(newString)
        : currentContent.replace(actualString, newString);

      await fs.writeFile(filePath, updatedContent, 'utf8');

      // Update readFileState with new content and new mtime
      const newStat = await fs.stat(filePath);
      readFileState.set(filePath, { content: updatedContent, timestamp: newStat.mtimeMs, isPartialView: false });

      return {
        content: [{ type: 'text', text: `The file ${filePath} has been updated successfully.` }],
        details: { filePath, occurrencesReplaced: occurrences },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// spawn_agent tool
// ---------------------------------------------------------------------------

/**
 * Build the spawn_agent tool for daemon sessions.
 *
 * Spawns a child WorkRail session in-process, blocking the parent until the child completes.
 * Returns `{ childSessionId, outcome, notes }` as a JSON string so the parent LLM can reason
 * about the child's result and decide how to proceed.
 *
 * WHY in-process (not via TriggerRouter.dispatch): dispatch() uses a global Semaphore and is
 * fire-and-forget. Calling it from inside a running session would deadlock (parent holds a slot
 * waiting for child to acquire one). Direct runWorkflow() call is naturally blocking via await.
 *
 * WHY pre-create session (Candidate 2): calls executeStartWorkflow() first so childSessionId is
 * deterministic and the child is observable in the session store from the moment execute() is called.
 * Crash-before-start is observable (zombie session with parentSessionId). Adapts the proven
 * _preAllocatedStartResponse pattern from console-routes.ts.
 *
 * WHY errors as data (not throw): a child failure should not abort the parent session. The parent
 * LLM receives { outcome: 'error', notes: errorMessage } and decides how to proceed. This is
 * different from other tools (complete_step, Bash) which throw on failure because those failures
 * ARE errors in the parent session's own execution.
 *
 * WHY currentDepth is a constructor parameter (not read from store): depth is set at factory
 * construction time by runWorkflow(), which reads trigger.spawnDepth. For checkpoint-resumed
 * sessions, the daemon restarts the AgentLoop from scratch and re-reads trigger.spawnDepth --
 * the constructor parameter is always correct. Store reads would add async I/O and error paths
 * for a theoretical edge case that does not exist in practice.
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
 */
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
  abortRegistry?: AbortRegistry,
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
        { is_autonomous: 'true', workspacePath: String(params.workspacePath), parentSessionId: thisWorkrailSessionId },
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
      const childResult = await runWorkflowFn(
        {
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
          // WHY _preAllocatedStartResponse: the session is already created above.
          // runWorkflow() MUST NOT call executeStartWorkflow() again (invariant).
          _preAllocatedStartResponse: startResult.value.response,
        },
        ctx,
        apiKey,
        undefined, // daemonRegistry: child sessions are not registered (no isLive tracking needed)
        emitter,
        undefined, // steerRegistry: child sessions are not steerable by coordinator
        abortRegistry, // WHY: thread abort registry so child sessions are abortable on SIGTERM
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

// ---------------------------------------------------------------------------
// report_issue tool
// ---------------------------------------------------------------------------

/**
 * Append a single JSON issue record to the per-session JSONL file.
 *
 * WHY void + catch: issue recording is purely observational. A failed write
 * (disk full, permission denied) must not propagate to the caller or interrupt
 * the workflow session. Same fire-and-forget contract as DaemonEventEmitter.
 *
 * WHY separate helper: keeps execute() synchronous from the caller's perspective
 * and makes the async write path independently testable via issuesDirOverride.
 *
 * @param issuesDir - Directory for issue files (override in tests; production uses ~/.workrail/issues).
 * @param sessionId - Session identifier used as the filename.
 * @param record - The issue payload to serialize as a JSON line.
 */
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

async function appendIssueAsync(
  issuesDir: string,
  sessionId: string,
  record: IssueRecord,
): Promise<void> {
  await fs.mkdir(issuesDir, { recursive: true });
  const filePath = path.join(issuesDir, `${sessionId}.jsonl`);
  const line = JSON.stringify({ ...record, ts: Date.now() }) + '\n';
  await fs.appendFile(filePath, line, 'utf8');
}

/** Input record shape for a report_issue call (before ts is appended). */
interface IssueRecord {
  sessionId: string;
  kind: 'tool_failure' | 'blocked' | 'unexpected_behavior' | 'needs_human' | 'self_correction';
  severity: 'info' | 'warn' | 'error' | 'fatal';
  summary: string;
  context?: string;
  toolName?: string;
  command?: string;
  suggestedFix?: string;
  continueToken?: string;
}

/**
 * Build the report_issue tool.
 *
 * Agents call this to record a structured issue for the auto-fix coordinator.
 * The tool does NOT stop the session -- it creates a record and returns a
 * confirmation. For fatal severity, the return value instructs the agent to call
 * continue_workflow with a blocker note, after which the session ends.
 *
 * @param sessionId - The process-local session UUID (keys the issues file).
 * @param emitter - Optional event emitter to fire an issue_reported event.
 * @param workrailSessionId - The WorkRail session ID for event correlation (optional).
 * @param issuesDirOverride - Override the issues directory (for tests).
 * @param onIssueSummary - Optional callback called synchronously with the issue summary
 *   string after each successful report_issue call. Used by runWorkflow() to accumulate
 *   issue summaries for the WORKTRAIN_STUCK marker without async file I/O.
 *   WHY optional callback: avoids circular dependency and keeps execute() synchronous
 *   from the caller's perspective. Fire-and-forget writes happen separately.
 */
export function makeReportIssueTool(
  sessionId: string,
  emitter?: DaemonEventEmitter,
  workrailSessionId?: string | null,
  issuesDirOverride?: string,
  onIssueSummary?: (summary: string) => void,
): AgentTool {
  const issuesDir = issuesDirOverride ?? path.join(os.homedir(), '.workrail', 'issues');

  return {
    name: 'report_issue',
    description:
      "Record a structured issue, error, or unexpected behavior. Call this AND continue_workflow (unless fatal). " +
      "Does not stop the session -- it creates a record for the auto-fix coordinator.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['tool_failure', 'blocked', 'unexpected_behavior', 'needs_human', 'self_correction'],
          description: 'Category of issue being reported.',
        },
        severity: {
          type: 'string',
          enum: ['info', 'warn', 'error', 'fatal'],
          description: 'Severity level. Fatal means the session cannot continue productively.',
        },
        summary: {
          type: 'string',
          description: 'One-line summary of the issue. Max 200 chars.',
          maxLength: 200,
        },
        context: {
          type: 'string',
          description: 'What you were trying to do when this issue occurred.',
        },
        toolName: {
          type: 'string',
          description: 'Name of the tool that failed or behaved unexpectedly, if applicable.',
        },
        command: {
          type: 'string',
          description: 'The shell command or expression that caused the issue, if applicable.',
        },
        suggestedFix: {
          type: 'string',
          description: 'A suggested fix or recovery action for the auto-fix coordinator.',
        },
        continueToken: {
          type: 'string',
          description: 'The current continueToken, so the coordinator can resume this session.',
        },
      },
      required: ['kind', 'severity', 'summary'],
      additionalProperties: false,
    },
    label: 'report_issue',

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_toolCallId: string, params: any): Promise<AgentToolResult<unknown>> => {
      if (typeof params.kind !== 'string' || !params.kind) throw new Error('report_issue: kind must be a non-empty string');
      if (typeof params.severity !== 'string' || !params.severity) throw new Error('report_issue: severity must be a non-empty string');
      if (typeof params.summary !== 'string' || !params.summary) throw new Error('report_issue: summary must be a non-empty string');
      const record: IssueRecord = {
        sessionId,
        kind: params.kind as IssueRecord['kind'],
        severity: params.severity as IssueRecord['severity'],
        summary: String(params.summary ?? '').slice(0, 200),
        ...(params.context !== undefined && { context: String(params.context) }),
        ...(params.toolName !== undefined && { toolName: String(params.toolName) }),
        ...(params.command !== undefined && { command: String(params.command) }),
        ...(params.suggestedFix !== undefined && { suggestedFix: String(params.suggestedFix) }),
        ...(params.continueToken !== undefined && { continueToken: String(params.continueToken) }),
      };

      // Fire-and-forget: write must never block execute() or propagate errors.
      // WHY void + catch: observability must not affect correctness.
      void appendIssueAsync(issuesDir, sessionId, record).catch(() => {
        // Intentionally empty: write failures are silently swallowed.
      });

      // Emit structured event for console/SSE stream visibility.
      emitter?.emit({
        kind: 'issue_reported',
        sessionId,
        issueKind: record.kind,
        severity: record.severity,
        summary: record.summary,
        ...(record.continueToken !== undefined && { continueToken: record.continueToken }),
        ...(workrailSessionId != null ? { workrailSessionId } : {}),
      });

      // Notify the accumulator so runWorkflow() can include issue summaries in
      // the WORKTRAIN_STUCK marker without async file I/O.
      // WHY synchronous callback: execute() already runs synchronously from the
      // agent loop's perspective; the callback push is O(1) and never throws.
      onIssueSummary?.(record.summary);

      const isFatal = record.severity === 'fatal';
      const message = isFatal
        ? `FATAL issue recorded. Call continue_workflow with notes explaining the blocker, then the session will end.`
        : `Issue recorded (severity=${record.severity}). Continue with your work unless this is fatal.`;

      return {
        content: [{ type: 'text', text: message }],
        details: { sessionId, kind: record.kind, severity: record.severity },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// signal_coordinator tool
// ---------------------------------------------------------------------------

/**
 * Directory that holds per-session signal JSONL files.
 *
 * Each concurrent runWorkflow() call appends its signals to
 * ~/.workrail/signals/<sessionId>.jsonl. Coordinators can tail this file
 * or read it at session boundaries without touching the durable session store.
 *
 * WHY a sidecar file instead of the v2 session store:
 * The session store uses a re-entrancy guard (ExecutionSessionGate.activeSessions).
 * At the point signal_coordinator executes, the gate is already held by the
 * ongoing continue_workflow / complete_step machinery. Attempting a second
 * session lock would return SESSION_LOCK_REENTRANT. The sidecar file avoids
 * this entirely: it is a separate, lock-free append channel that the coordinator
 * can read independently. The DaemonEventEmitter simultaneously broadcasts the
 * signal to the daemon JSONL event stream for live console visibility.
 */
export const DAEMON_SIGNALS_DIR = path.join(os.homedir(), '.workrail', 'signals');

/**
 * Append a single JSON signal record to the per-session JSONL file.
 *
 * Fire-and-forget: errors are swallowed so a failed write never interrupts
 * the session. Same contract as appendIssueAsync and DaemonEventEmitter.
 */
async function appendSignalAsync(
  signalsDir: string,
  sessionId: string,
  record: SignalRecord,
): Promise<void> {
  await fs.mkdir(signalsDir, { recursive: true });
  const filePath = path.join(signalsDir, `${sessionId}.jsonl`);
  const line = JSON.stringify({ ...record, ts: Date.now() }) + '\n';
  await fs.appendFile(filePath, line, 'utf8');
}

/** Payload written to the per-session JSONL sidecar (before ts is appended). */
interface SignalRecord {
  readonly signalId: string;
  readonly sessionId: string;
  readonly workrailSessionId?: string;
  readonly signalKind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Build the signal_coordinator tool for daemon sessions.
 *
 * The agent calls this to emit a structured coordinator signal without
 * advancing the workflow step. The signal is written to:
 * 1. ~/.workrail/signals/<sessionId>.jsonl -- sidecar JSONL for coordinator polling
 * 2. The daemon event log (via DaemonEventEmitter) -- for live console visibility
 *
 * WHY NOT writing to the v2 session store directly:
 * The session store uses a re-entrancy guard (ExecutionSessionGate). When
 * signal_coordinator executes, the gate is already held by the in-flight
 * continue_workflow / complete_step tool. Attempting withHealthySessionLock()
 * would return SESSION_LOCK_REENTRANT and abort the signal write. The sidecar
 * file is the correct channel for mid-step, non-advancing signal emission.
 *
 * WHY fire-and-observe (always returns immediately):
 * The tool must not block the agent. Signals are best-effort observability
 * artifacts -- a coordinator that reads them asynchronously is the intended
 * consumer. The agent proceeds to its next tool call regardless.
 *
 * @param sessionId - Process-local UUID (keys the sidecar JSONL file).
 * @param emitter - Optional event emitter for daemon JSONL visibility.
 * @param workrailSessionId - WorkRail session ID for event correlation.
 * @param signalsDirOverride - Override the signals directory (for tests).
 */
export function makeSignalCoordinatorTool(
  sessionId: string,
  emitter?: DaemonEventEmitter,
  workrailSessionId?: string | null,
  signalsDirOverride?: string,
): AgentTool {
  const signalsDir = signalsDirOverride ?? DAEMON_SIGNALS_DIR;

  return {
    name: 'signal_coordinator',
    description:
      'Emit a structured mid-session signal to the coordinator WITHOUT advancing the workflow step. ' +
      'Use this to surface progress updates, intermediate findings, data requests, ' +
      'approval requests, or blocking conditions while the session continues. ' +
      'Always returns immediately -- fire-and-observe, never blocks. ' +
      'Signal kinds: "progress" (heartbeat, no data needed), "finding" (intermediate result), ' +
      '"data_needed" (request external data), "approval_needed" (request coordinator approval), ' +
      '"blocked" (cannot continue without coordinator intervention).',
    inputSchema: {
      type: 'object',
      properties: {
        signalKind: {
          type: 'string',
          enum: ['progress', 'finding', 'data_needed', 'approval_needed', 'blocked'],
          description: 'The kind of signal to emit.',
        },
        payload: {
          type: 'object',
          additionalProperties: true,
          description: 'Structured data accompanying the signal. Pass {} for progress signals.',
        },
      },
      required: ['signalKind', 'payload'],
      additionalProperties: false,
    },
    label: 'signal_coordinator',

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (_toolCallId: string, params: any): Promise<AgentToolResult<unknown>> => {
      if (typeof params.signalKind !== 'string' || !params.signalKind) throw new Error('signal_coordinator: signalKind must be a non-empty string');
      const signalId = 'sig_' + randomUUID().replace(/-/g, '').slice(0, 8);
      const signalKind = String(params.signalKind ?? 'progress');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = (typeof params.payload === 'object' && params.payload !== null && !Array.isArray(params.payload))
        ? (params.payload as Record<string, unknown>)
        : {};

      console.log(`[WorkflowRunner] Tool: signal_coordinator sessionId=${sessionId} signalKind=${signalKind} signalId=${signalId}`);

      const record: SignalRecord = {
        signalId,
        sessionId,
        ...(workrailSessionId != null ? { workrailSessionId } : {}),
        signalKind,
        payload,
      };

      // Fire-and-forget sidecar write. A failed write never blocks or throws.
      void appendSignalAsync(signalsDir, sessionId, record).catch(() => {
        // Intentionally empty: write failures are silently swallowed.
      });

      // Emit to the daemon event log for live console visibility.
      emitter?.emit({
        kind: 'signal_emitted',
        sessionId,
        signalKind,
        signalId,
        payload,
        ...(workrailSessionId != null ? { workrailSessionId } : {}),
      });

      const result = { status: 'recorded' as const, signalId };
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
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
 * Pre-loaded I/O results passed into buildSessionContext().
 * Each field is the result of a specific I/O operation that the shell performs
 * before calling buildSessionContext(). Keeping these separate makes the I/O
 * boundary explicit and the pure function testable without any I/O setup.
 */
export interface SessionContextInputs {
  /** Result of loadDaemonSoul() */
  readonly soulContent: string;
  /** Result of loadWorkspaceContext() -- null if no context files found */
  readonly workspaceContext: string | null;
  /** Result of loadSessionNotes() -- empty array if none */
  readonly sessionNotes: readonly string[];
  /** The first step's pending prompt from executeStartWorkflow / _preAllocatedStartResponse */
  readonly firstStepPrompt: string;
}

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
 * Build the session configuration from pre-loaded I/O results.
 *
 * This function is intentionally synchronous and pure -- all I/O (soul file,
 * workspace context, session notes) is resolved by the caller before invoking
 * this function. WHY: keeps the function unit-testable by passing pre-loaded
 * strings directly, without requiring any I/O or mocking in tests.
 *
 * @param trigger - The workflow trigger (provides agentConfig limits and context).
 * @param inputs - Pre-loaded I/O results (soul content, workspace context, etc.).
 * @returns SessionContext containing systemPrompt, initialPrompt, and session limits.
 */
export function buildSessionContext(
  trigger: WorkflowTrigger,
  inputs: SessionContextInputs,
): SessionContext {
  // ---- System prompt ----
  // buildSystemPrompt() is synchronous and pure. It reads assembledContextSummary
  // and referenceUrls from trigger.context and trigger.referenceUrls directly,
  // so the SessionContextInputs fields for those are supplementary documentation
  // of what the trigger carries; the authoritative values flow through trigger.
  const sessionState = buildSessionRecap(inputs.sessionNotes);
  const systemPrompt = buildSystemPrompt(trigger, sessionState, inputs.soulContent, inputs.workspaceContext);

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
    inputs.firstStepPrompt +
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
  steerRegistry: SteerRegistry | undefined,
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
  if (state.workrailSessionId !== null) {
    daemonRegistry?.register(state.workrailSessionId, trigger.workflowId);
    steerRegistry?.set(state.workrailSessionId, (text: string) => { state.pendingSteerParts.push(text); });
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
      steerRegistry?.delete(state.workrailSessionId);
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
  emitter: DaemonEventEmitter | undefined,
  abortRegistry: AbortRegistry | undefined,
  onAdvance: (stepText: string, continueToken: string) => void,
  onComplete: (notes: string | undefined, artifacts?: readonly unknown[]) => void,
  maxIssueSummaries: number,
): readonly AgentTool[] {
  const { state, sessionId: sid, sessionWorkspacePath, readFileState, spawnCurrentDepth, spawnMaxDepth } = session;
  // Alias for readability -- workrailSessionId is read-only after buildPreAgentSession
  const workrailSid = state.workrailSessionId;

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
    makeReadTool(readFileState, schemas, sid, emitter, workrailSid),
    makeWriteTool(readFileState, schemas, sid, emitter, workrailSid),
    makeGlobTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeGrepTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeEditTool(sessionWorkspacePath, readFileState, schemas, sid, emitter, workrailSid),
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
      abortRegistry,
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
    const currentMessages = ctx.agent.state.messages;
    const newMessages = currentMessages.slice(ctx.lastFlushedRef.count);
    ctx.lastFlushedRef.count = currentMessages.length;
    void appendConversationMessages(ctx.conversationPath, newMessages).catch(() => {});

    // Steer injection: drain pendingSteerParts into the next turn.
    if (ctx.state.pendingSteerParts.length > 0 && !ctx.state.isComplete) {
      const joined = ctx.state.pendingSteerParts.join('\n\n');
      ctx.state.pendingSteerParts.length = 0;
      ctx.agent.steer(buildUserMessage(joined));
    }
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
  steerRegistry?: SteerRegistry,
  abortRegistry?: AbortRegistry,
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
    statsDir, sessionsDir, emitter, daemonRegistry, steerRegistry,
  );
  if (preResult.kind === 'complete') {
    return preResult.result;
  }
  const session = preResult.session;

  // Extract session fields needed in the agent loop phase.
  // readFileState, spawnCurrentDepth, spawnMaxDepth are consumed by constructTools.
  const { state, firstStep, sessionWorkspacePath, sessionWorktreePath, agentClient, modelId } = session;
  const startContinueToken = session.continueToken;

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
    state.stepAdvanceCount++;
    if (state.workrailSessionId !== null) daemonRegistry?.heartbeat(state.workrailSessionId);
    emitter?.emit({ kind: 'step_advanced', sessionId, ...withWorkrailSession(state.workrailSessionId) });
  };

  // ---- Schemas + tool construction ----
  const schemas = getSchemas();
  const tools = constructTools(session, ctx, apiKey, schemas, emitter, abortRegistry, onAdvance, onComplete, MAX_ISSUE_SUMMARIES);

  // ---- I/O phase: load context (soul + workspace + session notes) ----
  // WHY: load before Agent construction -- the system prompt is set at init
  // time and is not mutable after. All loads are best-effort; errors are
  // logged but never abort the session.
  //
  // loadSessionNotes decodes startContinueToken to get the WorkRail sessionId,
  // then reads the session store for prior step notes. For fresh sessions (no
  // node_output_appended events yet), this returns [] and sessionState is ''.
  // For checkpoint-resumed sessions, it returns prior step notes for continuity.
  // WHY system prompt instead of agent.steer(): steer() fires AFTER LLM responses,
  // not before. Populating the system prompt at construction time is the correct
  // pre-step-1 injection point.
  // trigger.soulFile is already cascade-resolved by trigger-store.ts:
  //   trigger soulFile -> workspace soulFile -> undefined (global fallback in loadDaemonSoul)
  // NOTE: use trigger.workspacePath (not sessionWorkspacePath) for context loading.
  // For worktree sessions, the context files (CLAUDE.md / AGENTS.md) live in the
  // main checkout, not the isolated worktree. The worktree only contains the agent's
  // working changes.
  const [soulContent, workspaceContext, sessionNotes] = await Promise.all([
    loadDaemonSoul(trigger.soulFile),
    loadWorkspaceContext(trigger.workspacePath),
    startContinueToken ? loadSessionNotes(startContinueToken, ctx) : Promise.resolve([] as readonly string[]),
  ]);

  // ---- Pure phase: build session configuration from pre-loaded I/O ----
  // buildSessionContext() is synchronous and pure -- it assembles the system
  // prompt, initial prompt, and session limits from the loaded data and trigger config.
  // WHY separated from I/O: makes prompt assembly testable without any fs or LLM mocking.
  const sessionCtx = buildSessionContext(trigger, {
    soulContent,
    workspaceContext,
    sessionNotes,
    firstStepPrompt: firstStep.pending?.prompt ?? 'No step content available',
  });

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

  // ---- AbortRegistry: register abort callback now that agent is initialized ----
  // WHY registered here (not before context loading): the closure `() => agent.abort()`
  // references `agent`, which is declared with `const` above. Registering before `agent`
  // is initialized would be a TDZ (Temporal Dead Zone) hazard -- the shutdown handler
  // could call the callback on an early-exit path where `agent` was never assigned,
  // throwing a ReferenceError. Registering here, after `const agent = new AgentLoop(...)`,
  // guarantees the binding is initialized at the point of registration.
  //
  // WHY () => agent.abort() (not agent itself): the registry value is an opaque callback,
  // consistent with SteerRegistry pattern. The shutdown handler never needs to inspect the
  // agent directly.
  //
  // Registration gap: steerRegistry is registered ~336 lines earlier (before context loading).
  // This abort registration happens after context loading completes, so there is a ~200-500ms
  // window where SIGTERM will not abort this session. Sessions in that window run to completion
  // or hit the wall-clock timeout. Accepted tradeoff -- see worktrain-daemon-invariants.md 3.4.
  if (state.workrailSessionId !== null) {
    abortRegistry?.set(state.workrailSessionId, () => { agent.abort(); });
  }

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
    stuckRepeatThreshold: STUCK_REPEAT_THRESHOLD,
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
    stuckRepeatThreshold: STUCK_REPEAT_THRESHOLD,
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
    console.log(`[WorkflowRunner] Agent loop started: sessionId=${sessionId} workflowId=${trigger.workflowId} modelId=${modelId}`);
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
    // WHY in finally: must run even on error or abort -- stale registry entries would make
    // the endpoint return 200 (calling the closed-over callback) on a dead session.
    if (state.workrailSessionId !== null) {
      steerRegistry?.delete(state.workrailSessionId);
    }
    // Deregister abort callback so the shutdown handler does not call abort() on a session
    // that has already exited. WHY synchronous / WHY in finally: same rationale as steerRegistry
    // above. The drain window in the shutdown handler polls abortRegistry.size to determine
    // when all sessions have completed cleanup -- this delete is the signal that cleanup is done.
    if (state.workrailSessionId !== null) {
      abortRegistry?.delete(state.workrailSessionId);
    }
    console.log(`[WorkflowRunner] Agent loop ended: sessionId=${sessionId} stopReason=${stopReason}${errorMessage ? ` error=${errorMessage.slice(0, 120)}` : ''}`);

  }

  // ---- Build finalization context (shared across all result paths) ----
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
