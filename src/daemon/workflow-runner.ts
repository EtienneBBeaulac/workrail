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
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { AgentLoop } from "./agent-loop.js";
import type { AgentTool, AgentToolResult, AgentEvent } from "./agent-loop.js";
import type { V2ToolContext } from '../mcp/types.js';
import { executeStartWorkflow } from '../mcp/handlers/v2-execution/start.js';
import { executeContinueWorkflow } from '../mcp/handlers/v2-execution/index.js';
import type { DaemonRegistry } from '../v2/infra/in-memory/daemon-registry/index.js';
import { parseContinueTokenOrFail } from '../mcp/handlers/v2-token-ops.js';
import { asSessionId } from '../v2/durable-core/ids/index.js';
import { projectNodeOutputsV2 } from '../v2/projections/node-outputs.js';

const execAsync = promisify(exec);

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
const DEFAULT_SESSION_TIMEOUT_MINUTES = 30;

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
 * Root directory for WorkRail user data (crash recovery, soul file, etc.).
 * WHY: daemon-soul.md lives alongside daemon-sessions/ in ~/.workrail/, not in
 * the data/ subdirectory controlled by WORKRAIL_DATA_DIR. This is consistent with
 * other files in the ~/.workrail/ root that are not part of the structured data store.
 */
const WORKRAIL_DIR = path.join(os.homedir(), '.workrail');

/**
 * Maximum combined byte size of all workspace context files.
 * WHY: Prevents context window bloat from large CLAUDE.md / AGENTS.md files.
 * Approximates 8000 tokens at ~4 bytes/token.
 */
const WORKSPACE_CONTEXT_MAX_BYTES = 32 * 1024;

/**
 * Candidate workspace context files in priority order.
 * WHY: Higher-priority files (repo-specific Claude config) are included first.
 * If the combined size exceeds WORKSPACE_CONTEXT_MAX_BYTES, lower-priority files
 * are truncated or dropped so the most relevant context always fits.
 */
const WORKSPACE_CONTEXT_CANDIDATE_PATHS = [
  '.claude/CLAUDE.md',
  'CLAUDE.md',
  'AGENTS.md',
  '.github/AGENTS.md',
] as const;

// WHY: Soul content is defined in soul-template.ts (zero imports) so the CLI
// init command can import the template without pulling in this module's heavy
// dependency graph (LLM agent SDK). workflow-runner.ts re-exports both symbols
// for backward compatibility with callers that already import this module.
import { DAEMON_SOUL_DEFAULT, DAEMON_SOUL_TEMPLATE } from './soul-template.js';
export { DAEMON_SOUL_DEFAULT, DAEMON_SOUL_TEMPLATE } from './soul-template.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input for a single autonomous workflow run.
 *
 * The daemon receives this from the trigger system (Step 4) and passes it here.
 */
export interface WorkflowTrigger {
  /** ID of the workflow to run (e.g. "coding-task-workflow-agentic"). */
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
  };
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
}

/** Failed workflow run (tool error, agent error, engine error, etc.). */
export interface WorkflowRunError {
  readonly _tag: 'error';
  readonly workflowId: string;
  readonly message: string;
  readonly stopReason: string;
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
export type WorkflowRunResult = WorkflowRunSuccess | WorkflowRunError | WorkflowRunTimeout | WorkflowDeliveryFailed;

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
 */
async function persistTokens(
  sessionId: string,
  continueToken: string,
  checkpointToken: string | null,
): Promise<void> {
  await fs.mkdir(DAEMON_SESSIONS_DIR, { recursive: true });

  const sessionPath = path.join(DAEMON_SESSIONS_DIR, `${sessionId}.json`);
  const state = JSON.stringify({ continueToken, checkpointToken, ts: Date.now() }, null, 2);
  const tmp = `${sessionPath}.tmp`;
  await fs.writeFile(tmp, state, 'utf8');
  await fs.rename(tmp, sessionPath);
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
    if (!entry.endsWith('.json')) continue;

    const sessionId = entry.slice(0, -5); // strip .json
    const filePath = path.join(sessionsDir, entry);

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        continueToken?: unknown;
        checkpointToken?: unknown;
        ts?: unknown;
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
 * Scan DAEMON_SESSIONS_DIR for orphaned session files and clear them.
 *
 * Called once during daemon startup, before the HTTP server begins accepting
 * webhook requests. This ensures no new workflow triggers arrive while recovery
 * is in progress.
 *
 * WHY this function and not a rehydrate call: clearing orphans satisfies the
 * crash recovery invariant (abandoned sessions do not persist indefinitely).
 * Calling executeContinueWorkflow({ intent: 'rehydrate' }) would only add a
 * 'token valid vs. expired' log distinction while requiring a V2ToolContext
 * dependency and risking transient engine startup errors. Clear-regardless-of-result
 * is the correct MVP behavior.
 *
 * KNOWN LIMITATION: a planned deployment restart clears in-flight sessions just as
 * a crash does. Distinguishing crash from planned restart requires out-of-band
 * state (e.g. a shutdown token written on clean stop). Not implemented at MVP.
 *
 * Non-fatal: any error during recovery is caught and logged. The daemon starts
 * regardless of whether recovery succeeds.
 *
 * @param sessionsDir - Optional override for the sessions directory. Defaults to
 *   DAEMON_SESSIONS_DIR. Pass a temp dir in tests to avoid touching real state.
 */
export async function runStartupRecovery(
  sessionsDir: string = DAEMON_SESSIONS_DIR,
): Promise<void> {
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

  for (const session of sessions) {
    const ageMs = now - session.ts;
    const isStale = ageMs > MAX_ORPHAN_AGE_MS;
    const ageSec = Math.round(ageMs / 1000);

    const label = isStale ? 'stale orphaned session' : 'orphaned session';
    console.log(
      `[WorkflowRunner] Clearing ${label}: sessionId=${session.sessionId} age=${ageSec}s`,
    );

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

  console.log(`[WorkflowRunner] Startup recovery complete: cleared ${cleared}/${sessions.length} orphaned session(s).`);
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
 * Load the operator-customizable agent rules from ~/.workrail/daemon-soul.md.
 *
 * On first run (file absent), writes a template to disk so the operator can
 * discover and customize it. The write is best-effort: if it fails (e.g. read-only
 * filesystem), the warning is logged and the default content is returned anyway.
 *
 * WHY synchronous default path: soul content must be ready before Agent construction.
 * The function is async only because first-run template creation requires an fs.writeFile.
 */
async function loadDaemonSoul(): Promise<string> {
  const soulPath = path.join(WORKRAIL_DIR, 'daemon-soul.md');
  try {
    return await fs.readFile(soulPath, 'utf8');
  } catch (err: unknown) {
    // ENOENT = first run. Write the template, then return the default content.
    // Any other error (permissions, etc.) is treated the same way.
    const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (isEnoent) {
      // Best-effort template creation -- failure is logged but never fatal.
      try {
        await fs.mkdir(WORKRAIL_DIR, { recursive: true });
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
 * Scan the workspace for CLAUDE.md / AGENTS.md context files and combine them
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
async function loadWorkspaceContext(workspacePath: string): Promise<string | null> {
  const parts: string[] = [];
  let combinedBytes = 0;
  let truncated = false;

  for (const relativePath of WORKSPACE_CONTEXT_CANDIDATE_PATHS) {
    if (truncated) break;

    const fullPath = path.join(workspacePath, relativePath);
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

    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (combinedBytes + contentBytes > WORKSPACE_CONTEXT_MAX_BYTES) {
      // Fit as much of this file as will fill the remaining budget.
      const remaining = WORKSPACE_CONTEXT_MAX_BYTES - combinedBytes;
      const truncatedContent = content.slice(0, remaining);
      parts.push(`### ${relativePath}\n${truncatedContent}`);
      truncated = true;
    } else {
      parts.push(`### ${relativePath}\n${content}`);
      combinedBytes += contentBytes;
    }
  }

  if (parts.length === 0) return null;

  let combined = parts.join('\n\n');
  if (truncated) {
    combined += '\n\n[Workspace context truncated: combined size exceeded 32 KB limit. Some files may be missing.]';
  }

  console.log(
    `[WorkflowRunner] Injecting workspace context from: ${WORKSPACE_CONTEXT_CANDIDATE_PATHS.filter(
      (p) => parts.some((part) => part.startsWith(`### ${p}`)),
    ).join(', ')}`,
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
async function loadSessionNotes(
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
        context: {
          type: 'object',
          additionalProperties: true,
          description: 'Updated context variables (only changed values).',
        },
      },
      required: ['continueToken'],
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
        filePath: { type: 'string', description: 'Absolute path to the file to read' },
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
  };
  return _schemas;
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function makeContinueWorkflowTool(
  sessionId: string,
  ctx: V2ToolContext,
  onAdvance: (nextStepText: string, continueToken: string) => void,
  onComplete: (notes: string | undefined) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
): AgentTool {
  return {
    name: 'continue_workflow',
    description:
      'Advance the WorkRail workflow to the next step. Call this after completing all work ' +
      'required by the current step. Include your notes in notesMarkdown.',
    inputSchema: schemas['ContinueWorkflowParams'],
    label: 'Continue Workflow',

    execute: async (
      _toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      const result = await executeContinueWorkflow(
        {
          continueToken: params.continueToken,
          intent: (params.intent ?? 'advance') as 'advance' | 'rehydrate',
          output: params.notesMarkdown
            ? { notesMarkdown: params.notesMarkdown }
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
      const continueToken = out.continueToken ?? '';
      const checkpointToken = out.checkpointToken ?? null;
      if (continueToken) {
        await persistTokens(sessionId, continueToken, checkpointToken);
      }

      if (out.isComplete) {
        // Pass the agent's notes from this final step to onComplete so the trigger
        // layer can extract the structured handoff artifact for delivery.
        onComplete(params.notesMarkdown as string | undefined);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeBashTool(workspacePath: string, schemas: Record<string, any>): AgentTool {
  return {
    name: 'Bash',
    description:
      'Execute a shell command. Throws on non-zero exit code. ' +
      `Maximum execution time: ${BASH_TIMEOUT_MS / 1000}s.`,
    inputSchema: schemas['BashParams'],
    label: 'Bash',

    execute: async (
      _toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      const cwd = params.cwd ?? workspacePath;
      try {
        const { stdout, stderr } = await execAsync(params.command, {
          cwd,
          timeout: BASH_TIMEOUT_MS,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeReadTool(schemas: Record<string, any>): AgentTool {
  return {
    name: 'Read',
    description: 'Read the contents of a file at the given absolute path.',
    inputSchema: schemas['ReadParams'],
    label: 'Read',

    execute: async (
      _toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      const content = await fs.readFile(params.filePath, 'utf8');
      return {
        content: [{ type: 'text', text: content }],
        details: { filePath: params.filePath, length: content.length },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeWriteTool(schemas: Record<string, any>): AgentTool {
  return {
    name: 'Write',
    description: 'Write content to a file at the given absolute path. Creates parent directories if needed.',
    inputSchema: schemas['WriteParams'],
    label: 'Write',

    execute: async (
      _toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      await fs.mkdir(path.dirname(params.filePath), { recursive: true });
      await fs.writeFile(params.filePath, params.content, 'utf8');
      return {
        content: [{ type: 'text', text: `Written ${params.content.length} bytes to ${params.filePath}` }],
        details: { filePath: params.filePath, length: params.content.length },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

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
    'You are WorkRail Auto, an autonomous agent that executes workflows step by step.',
    '',
    '## Your tools',
    '- `continue_workflow`: Advance to the next step. Call this after completing each step\'s work.',
    '  Always include your notes in notesMarkdown and round-trip the continueToken exactly.',
    '- `Bash`: Run shell commands. Use for building, testing, running scripts.',
    '- `Read`: Read files.',
    '- `Write`: Write files.',
    '',
    '## Execution contract',
    '1. Read the step carefully. Do ALL the work the step asks for.',
    '2. Call `continue_workflow` with your notes. Include the continueToken exactly.',
    '3. Repeat until the workflow reports it is complete.',
    '4. Do NOT skip steps. Do NOT call `continue_workflow` without completing the step\'s work.',
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
 * @returns WorkflowRunResult discriminated union. Never throws.
 */
export async function runWorkflow(
  trigger: WorkflowTrigger,
  ctx: V2ToolContext,
  apiKey: string,
  daemonRegistry?: DaemonRegistry,
): Promise<WorkflowRunResult> {
  // ---- Session ID (process-local, crash safety) ----
  // Each runWorkflow() call generates a unique UUID that keys the per-session
  // state file in DAEMON_SESSIONS_DIR. This UUID is NOT the WorkRail server
  // session ID -- it is a process-local identifier. The server continueToken
  // is stored as a value inside the file, so crash-resume can retrieve it.
  const sessionId = randomUUID();
  console.log(`[WorkflowRunner] Session started: sessionId=${sessionId} workflowId=${trigger.workflowId}`);

  // ---- DaemonRegistry: register session ----
  daemonRegistry?.register(sessionId, trigger.workflowId);

  // ---- Client and model setup ----
  // Priority: agentConfig.model (trigger-specific override) > env-based detection.
  // agentConfig.model format: "provider/model-id" (e.g. "amazon-bedrock/claude-sonnet-4-6").
  // WHY: per-trigger model overrides allow using different model tiers for different
  // workload types (e.g. a faster/cheaper model for simple automation tasks).
  //
  // WHY @anthropic-ai/sdk + @anthropic-ai/bedrock-sdk: both provide the identical
  // .messages.create() API, so AgentLoop works with either without any format conversion.
  // Bedrock uses AWS credentials from env (AWS_PROFILE, AWS_ACCESS_KEY_ID) automatically.
  let agentClient: Anthropic | AnthropicBedrock;
  let modelId: string;

  if (trigger.agentConfig?.model) {
    // Parse "provider/model-id" -- split on the first slash only
    const slashIdx = trigger.agentConfig.model.indexOf('/');
    if (slashIdx === -1) {
      daemonRegistry?.unregister(sessionId, 'failed');
      return {
        _tag: 'error',
        workflowId: trigger.workflowId,
        message: `agentConfig.model must be in "provider/model-id" format, got: "${trigger.agentConfig.model}"`,
        stopReason: 'error',
      };
    }
    const provider = trigger.agentConfig.model.slice(0, slashIdx);
    modelId = trigger.agentConfig.model.slice(slashIdx + 1);
    agentClient = provider === 'amazon-bedrock' ? new AnthropicBedrock() : new Anthropic({ apiKey });
  } else {
    // Default: use Bedrock when AWS credentials are present (avoids personal API key charges).
    const usesBedrock = !!process.env['AWS_PROFILE'] || !!process.env['AWS_ACCESS_KEY_ID'];
    if (usesBedrock) {
      agentClient = new AnthropicBedrock();
      modelId = 'us.anthropic.claude-sonnet-4-6';
    } else {
      agentClient = new Anthropic({ apiKey });
      modelId = 'claude-sonnet-4-5';
    }
  }

  // ---- Completion bridge ----
  // isComplete is written by continue_workflow tool's execute() when isComplete=true.
  // pendingSteerText is written by the tool after a successful step advance.
  // Both are read only in the turn_end subscriber -- no race condition since
  // tool execution is sequential (toolExecution: 'sequential').
  let isComplete = false;
  let pendingSteerText: string | null = null;
  // lastStepNotes is populated by onComplete when the agent's final continue_workflow
  // call includes output.notesMarkdown. Used by the trigger layer for delivery (git commit/PR).
  let lastStepNotes: string | undefined;

  const onAdvance = (stepText: string, _continueToken: string): void => {
    pendingSteerText = stepText;
    // Heartbeat on each step advance -- the session is alive and making progress.
    daemonRegistry?.heartbeat(sessionId);
  };

  const onComplete = (notes: string | undefined): void => {
    isComplete = true;
    lastStepNotes = notes;
  };

  // ---- Start workflow directly (daemon-owned, no LLM round-trip) ----
  // WHY: the daemon has all required context (workflowId, workspacePath, goal) at
  // startup. Calling executeStartWorkflow() here avoids one full LLM turn per session
  // and ensures tokens are persisted to disk BEFORE the agent loop begins (crash safety).
  // The LLM receives the first step's content as its initial prompt instead of being
  // told to call a start_workflow tool.
  const startResult = await executeStartWorkflow(
    { workflowId: trigger.workflowId, workspacePath: trigger.workspacePath, goal: trigger.goal },
    ctx,
    // Mark this session as autonomous so isAutonomous is derivable from the event log.
    { is_autonomous: 'true' },
  );

  if (startResult.isErr()) {
    daemonRegistry?.unregister(sessionId, 'failed');
    return {
      _tag: 'error',
      workflowId: trigger.workflowId,
      message: `start_workflow failed: ${startResult.error.kind} -- ${JSON.stringify(startResult.error)}`,
      stopReason: 'error',
    };
  }

  const firstStep = startResult.value.response;
  const startContinueToken = firstStep.continueToken ?? '';
  const startCheckpointToken = firstStep.checkpointToken ?? null;

  // Crash safety: persist tokens before starting the agent loop. A crash between
  // this point and the first continue_workflow call leaves a recoverable state file.
  if (startContinueToken) {
    await persistTokens(sessionId, startContinueToken, startCheckpointToken);
  }

  // Edge case: workflow completes immediately on start (single-step workflow with
  // no pending continuation). Return success without creating an Agent.
  if (firstStep.isComplete) {
    await fs.unlink(path.join(DAEMON_SESSIONS_DIR, `${sessionId}.json`)).catch(() => {});
    daemonRegistry?.unregister(sessionId, 'completed');
    return { _tag: 'success', workflowId: trigger.workflowId, stopReason: 'stop' };
  }

  // ---- Schemas ----
  const schemas = getSchemas();

  // ---- Tools ----
  // start_workflow is NOT in this list: the daemon calls executeStartWorkflow()
  // directly above so the LLM cannot call it again.
  const tools: AgentTool[] = [
    makeContinueWorkflowTool(sessionId, ctx, onAdvance, onComplete, schemas),
    makeBashTool(trigger.workspacePath, schemas),
    makeReadTool(schemas),
    makeWriteTool(schemas),
  ];

  // ---- Context loading (soul + workspace + session notes) ----
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
  const [soulContent, workspaceContext, sessionNotes] = await Promise.all([
    loadDaemonSoul(),
    loadWorkspaceContext(trigger.workspacePath),
    startContinueToken ? loadSessionNotes(startContinueToken, ctx) : Promise.resolve([] as readonly string[]),
  ]);

  const sessionState = buildSessionRecap(sessionNotes);

  // ---- Initial prompt: first step content from start_workflow ----
  // The daemon has already called executeStartWorkflow() and has the first step.
  // Pass the step content directly -- the LLM starts working on step 1 immediately.
  // Appending the continueToken so the LLM can pass it to continue_workflow.
  // WHY closing directive: an explicit imperative at the end of the initial prompt directs
  // the agent to complete the step work before calling continue_workflow. Without this,
  // the agent may produce a "thinking aloud" turn before the first tool call, which
  // wastes tokens and delays step execution.
  const contextJson = trigger.context
    ? `\n\nTrigger context:\n\`\`\`json\n${JSON.stringify(trigger.context, null, 2)}\n\`\`\``
    : '';

  // WHY: an explicit imperative at the end of the initial prompt directs the agent
  // to complete the step work before calling continue_workflow. Without this,
  // the agent may produce a "thinking aloud" turn before the first tool call, which
  // wastes tokens and delays step execution.
  const initialPrompt =
    (firstStep.pending?.prompt ?? 'No step content available') +
    `\n\ncontinueToken: ${startContinueToken}` +
    contextJson +
    '\n\nComplete all step work, then call continue_workflow with your notes to begin.';

  // ---- AgentLoop (one per runWorkflow() call, not reused) ----
  // WHY AgentLoop instead of pi-agent-core's Agent: AgentLoop is the first-party
  // replacement that uses @anthropic-ai/sdk directly, eliminating the private npm
  // package dependency. The client (Anthropic or AnthropicBedrock) is injected --
  // AgentLoop has no knowledge of API keys or AWS credentials.
  const agent = new AgentLoop({
    systemPrompt: buildSystemPrompt(trigger, sessionState, soulContent, workspaceContext),
    modelId,
    tools,
    client: agentClient,
    // Sequential execution: continue_workflow must complete before Bash begins
    // on the next step. Workflow tools have ordering requirements.
    toolExecution: 'sequential',
  });

  // ---- Session limits (wall-clock timeout + max-turn limit) ----
  // Resolved from trigger.agentConfig with hardcoded defaults as fallback.
  // WHY: per-trigger configurability lets operators tune limits per workflow type
  // (e.g. a fast code-review trigger vs. a slow coding-task trigger).
  const sessionTimeoutMs =
    (trigger.agentConfig?.maxSessionMinutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES) * 60 * 1000;
  const maxTurns = trigger.agentConfig?.maxTurns ?? 0; // 0 = no limit

  // ---- Timeout reason flag ----
  // Tracks which limit fired first. Set synchronously before agent.abort() so the
  // catch block can read it on the next microtask tick. JS single-thread guarantees
  // no race condition. Guard: first writer wins -- ignore if already set.
  let timeoutReason: 'wall_clock' | 'max_turns' | null = null;

  // ---- Turn counter ----
  // Incremented on each turn_end event (one complete LLM response turn).
  let turnCount = 0;

  // ---- Event subscription: steer() for step injection + turn-limit enforcement ----
  // Using steer() NOT followUp(): steer fires after each tool batch inside the
  // inner loop; followUp fires only when the agent would otherwise stop
  // (adding an extra LLM turn per workflow step).
  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    if (event.type !== 'turn_end') return;

    // Track turns for the max-turn limit.
    turnCount++;

    // Max-turn limit: abort if the turn count reaches the configured limit.
    // Guard: skip if wall-clock timeout already fired.
    if (maxTurns > 0 && turnCount >= maxTurns && timeoutReason === null) {
      timeoutReason = 'max_turns';
      agent.abort();
      return; // Do not inject the next step -- we are aborting.
    }

    // If a step was advanced and workflow is not yet complete, inject the next step.
    if (pendingSteerText !== null && !isComplete) {
      const text = pendingSteerText;
      pendingSteerText = null;
      agent.steer(buildUserMessage(text));
    }
    // If isComplete, do not call steer() -- agent exits naturally on next turn
    // when there are no tool calls and no queued steering messages.
  });

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
        if (timeoutReason === null) {
          timeoutReason = 'wall_clock';
        }
        reject(new Error('Workflow timed out'));
      }, sessionTimeoutMs);
    });
    await Promise.race([agent.prompt(buildUserMessage(initialPrompt)), timeoutPromise])
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
    // Cancel the wall-clock timer so it does not fire after successful completion
    // and mutate the closed-over timeoutReason variable. clearTimeout on an
    // already-fired or undefined handle is a safe no-op.
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }

  // ---- Timeout result (wall-clock or max-turn limit) ----
  // timeoutReason is set before agent.abort() in both abort paths; by the time we
  // reach here the catch has completed and it is safe to read synchronously.
  if (timeoutReason !== null) {
    daemonRegistry?.unregister(sessionId, 'failed');
    const limitDescription = timeoutReason === 'wall_clock'
      ? `${trigger.agentConfig?.maxSessionMinutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES} minutes`
      : `${trigger.agentConfig?.maxTurns} turns`;
    return {
      _tag: 'timeout',
      workflowId: trigger.workflowId,
      reason: timeoutReason,
      message: `Workflow ${timeoutReason === 'wall_clock' ? 'timed out' : 'exceeded turn limit'} after ${limitDescription}`,
      stopReason: 'aborted',
    };
  }

  if (stopReason === 'error' || errorMessage) {
    daemonRegistry?.unregister(sessionId, 'failed');
    return {
      _tag: 'error',
      workflowId: trigger.workflowId,
      message: errorMessage ?? 'Agent stopped with error reason',
      stopReason,
    };
  }

  // ---- Clean up state file on success ----
  // The state file is evidence of an in-flight session. Delete it on clean completion
  // so the CLI crash-recovery scan only surfaces genuinely orphaned sessions.
  await fs.unlink(path.join(DAEMON_SESSIONS_DIR, `${sessionId}.json`)).catch(() => {
    // Best-effort: ignore ENOENT (session never persisted tokens) and other errors.
  });

  daemonRegistry?.unregister(sessionId, 'completed');

  return {
    _tag: 'success',
    workflowId: trigger.workflowId,
    stopReason,
    ...(lastStepNotes !== undefined ? { lastStepNotes } : {}),
  };
}
