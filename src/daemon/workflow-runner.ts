/**
 * WorkRail Daemon: Autonomous Workflow Runner
 *
 * Drives a WorkRail session to completion using pi-mono's Agent loop.
 * Calls WorkRail's own engine directly (in-process, shared DI) rather than over HTTP.
 *
 * Design decisions:
 * - Uses agent.steer() (NOT followUp()) for step injection. steer() fires after each
 *   tool batch inside the inner loop; followUp() fires only when the agent would
 *   otherwise stop, adding an unnecessary extra LLM turn per workflow step.
 * - V2ToolContext is injected by the caller (shared with MCP server in same process).
 *   The daemon must not call createWorkRailEngine() -- engineActive guard blocks reuse.
 * - Tools THROW on failure (pi-mono contract). runWorkflow() catches and returns
 *   a WorkflowRunResult discriminated union (errors-as-data at the outer boundary).
 * - continueToken + checkpointToken are persisted atomically to
 *   ~/.workrail/daemon-sessions/<sessionId>.json BEFORE returning from each
 *   continue_workflow tool call. Each concurrent session has its own file --
 *   they never clobber each other. Crash recovery invariant.
 */

import 'reflect-metadata';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { loadPiAi, loadPiAgentCore } from "./pi-mono-loader.js";
import type { Agent, AgentTool, AgentToolResult, AgentEvent } from "./pi-mono-loader.js";
import type { TSchema } from "./pi-mono-loader.js";
import type { UserMessage } from '@mariozechner/pi-ai';
import type { V2ToolContext } from '../mcp/types.js';
import { executeStartWorkflow } from '../mcp/handlers/v2-execution/start.js';
import { executeContinueWorkflow } from '../mcp/handlers/v2-execution/index.js';
import type { DaemonRegistry } from '../v2/infra/in-memory/daemon-registry/index.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum wall-clock time allowed for a single Bash tool invocation. */
const BASH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Maximum wall-clock time allowed for a single workflow run (30 minutes).
 * If the agent loop does not complete within this window, runWorkflow() aborts
 * the agent and returns { _tag: 'error', message: 'Workflow timed out' }.
 */
const WORKFLOW_TIMEOUT_MS = 30 * 60 * 1000;

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
}

/** Successful completion of a workflow run. */
export interface WorkflowRunSuccess {
  readonly _tag: 'success';
  readonly workflowId: string;
  readonly stopReason: string;
}

/** Failed workflow run (tool error, agent error, engine error, etc.). */
export interface WorkflowRunError {
  readonly _tag: 'error';
  readonly workflowId: string;
  readonly message: string;
  readonly stopReason: string;
}

/** Result of a runWorkflow() call. Never throws. */
export type WorkflowRunResult = WorkflowRunSuccess | WorkflowRunError;

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

// ---------------------------------------------------------------------------
// Tool parameter schemas (TypeBox -- built lazily via loadPiAi() for ESM compat)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _schemas: Record<string, any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSchemas(): Promise<Record<string, any>> {
  if (_schemas) return _schemas;
  const { Type } = await loadPiAi();
  _schemas = {
    StartWorkflowParams: Type.Object({
      workflowId: Type.String({ description: 'Workflow ID to start (e.g. coding-task-workflow-agentic)' }),
      workspacePath: Type.String({ description: 'Absolute path to the workspace directory' }),
      goal: Type.String({ description: 'Short description of what you are trying to accomplish' }),
      context: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: 'Initial workflow context variables',
      })),
    }),
    ContinueWorkflowParams: Type.Object({
      continueToken: Type.String({
        description: 'The continueToken from the previous start_workflow or continue_workflow call. Round-trip exactly as received.',
      }),
      intent: Type.Optional(Type.Union([Type.Literal('advance'), Type.Literal('rehydrate')], {
        description: 'advance: I completed this step. rehydrate: remind me what the current step is.',
      })),
      notesMarkdown: Type.Optional(Type.String({
        description: 'Notes on what you did in this step (10-30 lines, markdown).',
      })),
      context: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: 'Updated context variables (only changed values).',
      })),
    }),
    BashParams: Type.Object({
      command: Type.String({ description: 'Shell command to execute' }),
      cwd: Type.Optional(Type.String({ description: 'Working directory for the command' })),
    }),
    ReadParams: Type.Object({
      filePath: Type.String({ description: 'Absolute path to the file to read' }),
    }),
    WriteParams: Type.Object({
      filePath: Type.String({ description: 'Absolute path to the file to write' }),
      content: Type.String({ description: 'Content to write to the file' }),
    }),
  };
  return _schemas;
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStartWorkflowTool(
  sessionId: string,
  ctx: V2ToolContext,
  onComplete: (notes: string) => void,
  schemas: Record<string, any>,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any> {
  return {
    name: 'start_workflow',
    description: 'Start a WorkRail workflow session. Call this first to get the initial step.',
    parameters: schemas['StartWorkflowParams'],
    label: 'Start Workflow',

    execute: async (
      _toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      const result = await executeStartWorkflow(
        {
          workflowId: params.workflowId,
          workspacePath: params.workspacePath,
          goal: params.goal,
        },
        ctx,
        // Mark this session as autonomous. The daemon sets this at session creation
        // so isAutonomous is derivable from the event log even after restart.
        { is_autonomous: 'true' },
      );

      if (result.isErr()) {
        throw new Error(`start_workflow failed: ${result.error.kind} -- ${JSON.stringify(result.error)}`);
      }

      const out = result.value.response;

      // Persist tokens before returning to the agent -- crash safety invariant.
      const continueToken = out.continueToken ?? '';
      const checkpointToken = out.checkpointToken ?? null;
      if (continueToken) {
        await persistTokens(sessionId, continueToken, checkpointToken);
      }

      if (out.isComplete) {
        onComplete('Workflow completed immediately after start.');
        return {
          content: [{ type: 'text', text: 'Workflow is already complete.' }],
          details: out,
        };
      }

      const pending = out.pending;
      const stepText = pending
        ? `## Step: ${pending.title}\n\n${pending.prompt}\n\ncontinueToken: ${continueToken}`
        : `Workflow started. continueToken: ${continueToken}`;

      return {
        content: [{ type: 'text', text: stepText }],
        details: out,
      };
    },
  };
}

function makeContinueWorkflowTool(
  sessionId: string,
  ctx: V2ToolContext,
  onAdvance: (nextStepText: string, continueToken: string) => void,
  onComplete: (notes: string) => void,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any> {
  return {
    name: 'continue_workflow',
    description:
      'Advance the WorkRail workflow to the next step. Call this after completing all work ' +
      'required by the current step. Include your notes in notesMarkdown.',
    parameters: schemas['ContinueWorkflowParams'],
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
        onComplete('Workflow session complete.');
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
function makeBashTool(workspacePath: string, schemas: Record<string, any>// eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any> {
  return {
    name: 'Bash',
    description:
      'Execute a shell command. Throws on non-zero exit code. ' +
      `Maximum execution time: ${BASH_TIMEOUT_MS / 1000}s.`,
    parameters: schemas['BashParams'],
    label: 'Bash',

    execute: async (
      _toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<unknown>> => {
      const cwd = params.cwd ?? workspacePath;
      const { stdout, stderr } = await execAsync(params.command, {
        cwd,
        timeout: BASH_TIMEOUT_MS,
      });
      const output = [stdout, stderr].filter(Boolean).join('\n');
      return {
        content: [{ type: 'text', text: output || '(no output)' }],
        details: { stdout, stderr },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeReadTool(schemas: Record<string, any>// eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any> {
  return {
    name: 'Read',
    description: 'Read the contents of a file at the given absolute path.',
    parameters: schemas['ReadParams'],
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
function makeWriteTool(schemas: Record<string, any>// eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgentTool<any> {
  return {
    name: 'Write',
    description: 'Write content to a file at the given absolute path. Creates parent directories if needed.',
    parameters: schemas['WriteParams'],
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

function buildSystemPrompt(trigger: WorkflowTrigger, sessionState: string): string {
  return [
    'You are WorkRail Auto, an autonomous agent that executes workflows step by step.',
    '',
    '## Your tools',
    '- `start_workflow`: Start a WorkRail workflow. Call this first with the workflowId and goal.',
    '- `continue_workflow`: Advance to the next step. Call this after completing each step\'s work.',
    '  Always include your notes in notesMarkdown and round-trip the continueToken exactly.',
    '- `Bash`: Run shell commands. Use for building, testing, running scripts.',
    '- `Read`: Read files.',
    '- `Write`: Write files.',
    '',
    '## Execution contract',
    '1. Call `start_workflow` first to get the initial step.',
    '2. Read the step carefully. Do ALL the work the step asks for.',
    '3. Call `continue_workflow` with your notes. Include the continueToken exactly.',
    '4. Repeat until the workflow reports it is complete.',
    '5. Do NOT skip steps. Do NOT call `continue_workflow` without completing the step\'s work.',
    '',
    `<workrail_session_state>${sessionState}</workrail_session_state>`,
    '',
    `## Workspace: ${trigger.workspacePath}`,
  ].join('\n');
}

function buildUserMessage(text: string): UserMessage {
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

  // ---- Model setup ----
  // Use Bedrock when AWS_PROFILE is set (Zillow's corp account), otherwise
  // fall back to direct Anthropic API. This avoids personal API key charges.
  let model;
  try {
    const { getModel } = await loadPiAi();
    const usesBedrock = !!process.env['AWS_PROFILE'] || !!process.env['AWS_ACCESS_KEY_ID'];
    if (usesBedrock) {
      model = getModel('bedrock-converse-stream', 'us.anthropic.claude-sonnet-4-6');
    } else {
      model = getModel('anthropic', 'claude-sonnet-4-5');
    }
  } catch (err) {
    daemonRegistry?.unregister(sessionId, 'failed');
    return {
      _tag: 'error',
      workflowId: trigger.workflowId,
      message: `Model not found: ${err instanceof Error ? err.message : String(err)}`,
      stopReason: 'error',
    };
  }

  // ---- Completion bridge ----
  // isComplete is written by continue_workflow tool's execute() when isComplete=true.
  // pendingSteerText is written by the tool after a successful step advance.
  // Both are read only in the turn_end subscriber -- no race condition since
  // tool execution is sequential (toolExecution: 'sequential').
  let isComplete = false;
  let pendingSteerText: string | null = null;

  const onAdvance = (stepText: string, _continueToken: string): void => {
    pendingSteerText = stepText;
    // Heartbeat on each step advance -- the session is alive and making progress.
    daemonRegistry?.heartbeat(sessionId);
  };

  const onComplete = (_notes: string): void => {
    isComplete = true;
  };

  // ---- Schemas (lazy ESM load) ----
  const schemas = await getSchemas();

  // ---- Tools ----
  // Cast through unknown to satisfy AgentTool<TSchema> -- each tool factory
  // produces a concrete TypeBox schema type; the agent loop accepts the base type.
  const tools: AgentTool<TSchema>[] = [
    makeStartWorkflowTool(sessionId, ctx, onComplete, schemas) as unknown as AgentTool<TSchema>,
    makeContinueWorkflowTool(sessionId, ctx, onAdvance, onComplete, schemas) as unknown as AgentTool<TSchema>,
    makeBashTool(trigger.workspacePath, schemas) as unknown as AgentTool<TSchema>,
    makeReadTool(schemas) as unknown as AgentTool<TSchema>,
    makeWriteTool(schemas) as unknown as AgentTool<TSchema>,
  ];

  // ---- Agent (one per runWorkflow() call, not reused) ----
  const { Agent } = await loadPiAgentCore();
  const agent = new Agent({
    initialState: {
      systemPrompt: buildSystemPrompt(trigger, ''),
      model,
      tools,
    },
    // Bedrock uses AWS credentials from env (AWS_PROFILE etc.) -- no API key needed.
    // For direct Anthropic, pass the provided key.
    getApiKey: async (_provider: string) => apiKey ?? '',

    // Sequential execution: continue_workflow must complete before Bash begins
    // on the next step. Workflow tools have ordering requirements.
    toolExecution: 'sequential',
  });

  // ---- Event subscription: steer() for step injection ----
  // Using steer() NOT followUp(): steer fires after each tool batch inside the
  // inner loop; followUp fires only when the agent would otherwise stop
  // (adding an extra LLM turn per workflow step).
  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    if (event.type !== 'turn_end') return;

    // If a step was advanced and workflow is not yet complete, inject the next step.
    if (pendingSteerText !== null && !isComplete) {
      const text = pendingSteerText;
      pendingSteerText = null;
      agent.steer(buildUserMessage(text));
    }
    // If isComplete, do not call steer() -- agent exits naturally on next turn
    // when there are no tool calls and no queued steering messages.
  });

  // ---- Initial prompt ----
  const contextJson = trigger.context
    ? `\n\nTrigger context:\n\`\`\`json\n${JSON.stringify(trigger.context, null, 2)}\n\`\`\``
    : '';

  const initialPrompt =
    `Start the workflow \`${trigger.workflowId}\`.\n` +
    `Goal: ${trigger.goal}\n` +
    `workspacePath: ${trigger.workspacePath}` +
    contextJson;

  let stopReason = 'stop';
  let errorMessage: string | undefined;

  try {
    // ---- Whole-workflow timeout ----
    // If the agent loop does not complete within WORKFLOW_TIMEOUT_MS, abort the
    // agent and propagate a timeout error through the existing error-handling path.
    // agent.abort() is idempotent (optional-chained on activeRun in pi-agent-core).
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Workflow timed out')), WORKFLOW_TIMEOUT_MS),
    );
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
  };
}
