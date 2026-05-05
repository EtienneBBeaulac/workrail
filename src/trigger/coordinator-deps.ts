/**
 * WorkRail Auto: Coordinator Deps Factory
 *
 * Provides createCoordinatorDeps() -- a factory that builds the AdaptiveCoordinatorDeps
 * implementation used by the trigger listener's in-process adaptive pipeline coordinator.
 *
 * WHY a separate file (not inline in trigger-listener.ts):
 * startTriggerListener() was ~920 lines with ~355 of those being anonymous AdaptiveCoordinatorDeps
 * closures. Extracting them here improves readability and testability without changing behavior.
 *
 * WHY setDispatch() (not a constructor parameter):
 * spawnSession() needs router.dispatch(), but TriggerRouter's constructor takes coordinatorDeps.
 * This creates a circular construction order: coordinatorDeps must exist before TriggerRouter,
 * but dispatch only exists after TriggerRouter is constructed. setDispatch() is the explicit
 * late-binding that resolves this: it is called exactly once, immediately after TriggerRouter
 * construction, at the composition root in startTriggerListener().
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ok, err } from 'neverthrow';
import type { V2ToolContext } from '../mcp/types.js';
import type { AdaptiveCoordinatorDeps } from '../coordinators/adaptive-pipeline.js';
import type { ChildSessionResult } from '../coordinators/types.js';
import { executeStartWorkflow } from '../mcp/handlers/v2-execution/start.js';
import { parseContinueTokenOrFail } from '../mcp/handlers/v2-token-ops.js';
import { createContextAssembler } from '../context-assembly/index.js';
import { createListRecentSessions } from '../context-assembly/infra.js';
import type { WorkflowTrigger, SessionSource, AllocatedSession } from '../daemon/workflow-runner.js';
import type { ConsoleService } from '../v2/usecases/console-service.js';
import { parsePipelineRunContext } from '../coordinators/pipeline-run-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into createCoordinatorDeps().
 *
 * These correspond to the closed-over variables from startTriggerListener()
 * that the coordinatorDeps closures previously captured implicitly.
 */
export interface CoordinatorDepsDependencies {
  /** V2 tool context, used by spawnSession for executeStartWorkflow and token decoding. */
  readonly ctx: V2ToolContext;
  /**
   * Promisified execFile, used for git/gh CLI calls.
   * Kept as a parameter (not re-created internally) so test fakes can substitute it.
   */
  readonly execFileAsync: (
    cmd: string,
    args: string[],
    opts?: object,
  ) => Promise<{ stdout: string }>;
  /**
   * ConsoleService instance for in-process session polling.
   * Null when ctx.v2.dataDir or ctx.v2.directoryListing are unavailable.
   * WHY passed as parameter (not lazily imported here): ConsoleService is lazily
   * imported in trigger-listener.ts to avoid circular module deps at load time.
   * Passing the pre-constructed instance keeps coordinator-deps.ts free of that concern.
   */
  readonly consoleService: InstanceType<typeof ConsoleService> | null;
}

/**
 * AdaptiveCoordinatorDeps with an additional setDispatch() method for late-binding.
 *
 * WHY the extension (not a separate injection): TriggerRouter's constructor takes
 * AdaptiveCoordinatorDeps, so the type must already be fully constructed. setDispatch()
 * is an implementation detail of the factory's circular-dep resolution strategy -- it is
 * not part of the public AdaptiveCoordinatorDeps contract.
 */
export interface CoordinatorDepsWithDispatch extends AdaptiveCoordinatorDeps {
  /**
   * Bind the dispatch function from TriggerRouter after router construction.
   *
   * Call exactly once, immediately after `new TriggerRouter(...)`, passing
   * `router.dispatch.bind(router)`. Until this is called, spawnSession() returns
   * a typed error rather than crashing.
   */
  setDispatch(dispatch: (trigger: WorkflowTrigger, source?: SessionSource) => void): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the AdaptiveCoordinatorDeps implementation for the trigger listener.
 *
 * All method bodies are extracted verbatim from startTriggerListener() in
 * trigger-listener.ts. No logic changes.
 */
export function createCoordinatorDeps(
  deps: CoordinatorDepsDependencies,
): CoordinatorDepsWithDispatch {
  const { ctx, execFileAsync, consoleService } = deps;

  // Mutable dispatch function. Null until setDispatch() is called.
  // WHY let (not const): assigned by setDispatch(), which is called after TriggerRouter construction.
  let dispatch: ((trigger: WorkflowTrigger, source?: SessionSource) => void) | null = null;

  // Shared implementation for reading notes and artifacts from a completed session.
  // WHY extracted (not inlined in getAgentResult and getChildSessionResult separately):
  // Both methods need this logic. Extracting it avoids duplication and allows
  // getChildSessionResult to call it without a self-reference problem in the
  // factory object literal.
  async function fetchAgentResult(
    sessionHandle: string,
  ): Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }> {
    const emptyResult = { recapMarkdown: null, artifacts: [] as readonly unknown[] };

    if (consoleService === null) {
      return emptyResult;
    }

    try {
      const detailResult = await consoleService.getSessionDetail(sessionHandle);
      if (detailResult.isErr()) return emptyResult;

      const run = detailResult.value.runs[0];
      if (!run) return emptyResult;

      const tipNodeId = run.preferredTipNodeId;
      if (!tipNodeId) return emptyResult;

      const allNodeIds = run.nodes
        .map((n) => n.nodeId)
        .filter((id): id is string => typeof id === 'string' && id !== '');
      const nodeIdsToFetch = allNodeIds.length > 0 ? allNodeIds : [tipNodeId];

      let recap: string | null = null;
      const collectedArtifacts: unknown[] = [];

      for (const nodeId of nodeIdsToFetch) {
        try {
          const nodeResult = await consoleService.getNodeDetail(sessionHandle, nodeId);
          if (nodeResult.isErr()) continue;
          if (nodeId === tipNodeId) recap = nodeResult.value.recapMarkdown;
          if (nodeResult.value.artifacts.length > 0) collectedArtifacts.push(...nodeResult.value.artifacts);
        } catch { continue; }
      }

      return { recapMarkdown: recap, artifacts: collectedArtifacts };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[WARN coord:reason=exception handle=${sessionHandle.slice(0, 16)}] fetchAgentResult: ${msg}\n`);
      return emptyResult;
    }
  }

  // Shared implementation for mapping a terminal session handle to ChildSessionResult.
  // WHY extracted: both getChildSessionResult and spawnAndAwait need this logic.
  // spawnAndAwait calls this after its inline awaitSessions loop; getChildSessionResult
  // calls it directly (the caller is responsible for calling awaitSessions first).
  async function fetchChildSessionResult(
    handle: string,
    coordinatorSessionId?: string,
  ): Promise<ChildSessionResult> {
    if (consoleService === null) {
      process.stderr.write(
        `[WARN coord:reason=await_degraded handle=${handle.slice(0, 16)}${coordinatorSessionId ? ' parent=' + coordinatorSessionId.slice(0, 16) : ''}] fetchChildSessionResult: ConsoleService unavailable\n`,
      );
      return {
        kind: 'await_degraded',
        message: 'ConsoleService unavailable -- cannot read child session outcome',
      };
    }

    let runStatus: string | null = null;
    try {
      const detailResult = await consoleService.getSessionDetail(handle);
      if (detailResult.isErr()) {
        process.stderr.write(
          `[WARN coord:reason=getSessionDetail_failed handle=${handle.slice(0, 16)}] fetchChildSessionResult: ${String(detailResult.error)}\n`,
        );
        return {
          kind: 'failed',
          reason: 'error',
          message: `Could not read session detail: ${String(detailResult.error)}`,
        };
      }
      const run = detailResult.value.runs[0];
      runStatus = run?.status ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[WARN coord:reason=exception handle=${handle.slice(0, 16)}] fetchChildSessionResult getSessionDetail: ${msg}\n`,
      );
      return { kind: 'failed', reason: 'error', message: `Exception reading session detail: ${msg}` };
    }

    if (runStatus === 'complete' || runStatus === 'complete_with_gaps') {
      const agentResult = await fetchAgentResult(handle);
      return {
        kind: 'success',
        notes: agentResult.recapMarkdown,
        artifacts: agentResult.artifacts,
      };
    }

    if (runStatus === 'blocked') {
      return {
        kind: 'failed',
        reason: 'stuck',
        message: `Child session ${handle.slice(0, 16)} reached blocked state`,
      };
    }

    if (runStatus === null) {
      return {
        kind: 'timed_out',
        message: `Child session ${handle.slice(0, 16)} has no terminal run status (likely timed out)`,
      };
    }

    // 'in_progress' or 'dormant': not yet terminal.
    // Should not happen if awaitSessions was called first, but handle defensively.
    return {
      kind: 'timed_out',
      message: `Child session ${handle.slice(0, 16)} is still in state '${runStatus}' -- awaitSessions may not have been called`,
    };
  }

  return {
    setDispatch(fn: (trigger: WorkflowTrigger, source?: SessionSource) => void): void {
      if (dispatch !== null) {
        process.stderr.write('[WARN coordinator-deps] setDispatch() called more than once -- ignoring reassignment\n');
        return;
      }
      dispatch = fn;
    },

    spawnSession: async (
      workflowId: string,
      goal: string,
      workspace: string,
      context?: Readonly<Record<string, unknown>>,
      agentConfig?: Readonly<{ readonly maxSessionMinutes?: number; readonly maxTurns?: number }>,
      parentSessionId?: string,
    ) => {
      // WHY in-process (not HTTP): the coordinator runs inside the daemon process.
      // POSTing to /api/v2/auto/dispatch would go out-of-process to itself, hitting
      // the HTTP handler's LLM credential check which can fail even when the daemon
      // is running correctly (the daemon already validated credentials at startup).
      // Calling executeStartWorkflow + router.dispatch() directly bypasses the
      // redundant credential check and eliminates the HTTP roundtrip.
      // This mirrors the pattern used in console-routes.ts (the HTTP handler
      // uses this same flow: executeStartWorkflow -> SessionSource -> dispatch).
      if (dispatch === null) {
        return { kind: 'err' as const, error: 'in-process router not initialized -- coordinator deps not ready' };
      }

      // Step 1: Allocate a session in the store synchronously.
      // WHY SessionSource: runWorkflow() skips its own executeStartWorkflow() call when
      // a pre_allocated SessionSource is passed, preventing double session creation.
      // WHY parentSessionId in internalContext: executeStartWorkflow reads it from
      // internalContext and writes it to the session_created event's data field so the
      // parent-child relationship is durable in the event log.
      const startResult = await executeStartWorkflow(
        { workflowId, workspacePath: workspace, goal },
        ctx,
        {
          is_autonomous: 'true',
          workspacePath: workspace,
          triggerSource: 'daemon',
          ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        },
      );
      if (startResult.isErr()) {
        const detail = `${startResult.error.kind}${'message' in startResult.error ? ': ' + (startResult.error as { message: string }).message : ''}`;
        return { kind: 'err' as const, error: `Session creation failed: ${detail}` };
      }

      const startContinueToken = startResult.value.response.continueToken;
      if (!startContinueToken) {
        // Workflow completed immediately (single-step); no agent loop session needed.
        // Use workflowId as fallback handle (matches console-routes.ts behavior).
        return { kind: 'ok' as const, value: workflowId };
      }

      // Step 2: Decode the session ID from the continueToken.
      // WHY parseContinueTokenOrFail: V2StartWorkflowOutputSchema does not expose sessionId
      // directly (to avoid a breaking schema change). Same approach as console-routes.ts.
      const tokenResult = await parseContinueTokenOrFail(
        startContinueToken,
        ctx.v2.tokenCodecPorts,
        ctx.v2.tokenAliasStore,
      );
      if (tokenResult.isErr()) {
        process.stderr.write(
          `[ERROR trigger-listener:spawnSession] Failed to decode session handle from new session: ${tokenResult.error.message}\n`,
        );
        return { kind: 'err' as const, error: 'Internal error: could not extract session handle from new session' };
      }
      const sessionHandle = tokenResult.value.sessionId;

      // Step 3: Enqueue the agent loop via TriggerRouter's queue and semaphore.
      // WHY agentConfig forwarded: coordinator sets per-phase timeouts (e.g. 55m for discovery)
      // that exceed DEFAULT_SESSION_TIMEOUT_MINUTES=30. Without forwarding, sessions die at 30m
      // and the coordinator's phase budget is never consumed (discovery-loop-fix, RC1).
      const trigger: WorkflowTrigger = {
        workflowId,
        goal,
        workspacePath: workspace,
        context,
        ...(agentConfig !== undefined ? { agentConfig } : {}),
      };
      const r = startResult.value.response;
      const allocatedSession: AllocatedSession = {
        continueToken: r.continueToken ?? '',
        checkpointToken: r.checkpointToken,
        firstStepPrompt: r.pending?.prompt ?? '',
        isComplete: r.isComplete,
        triggerSource: 'daemon',
      };
      const source: SessionSource = { kind: 'pre_allocated', trigger, session: allocatedSession };
      dispatch(trigger, source);

      return { kind: 'ok' as const, value: sessionHandle };
    },

    contextAssembler: createContextAssembler({
      execGit: async (args: readonly string[], cwd: string) => {
        try {
          const { stdout } = await execFileAsync('git', [...args], { cwd });
          return { kind: 'ok' as const, value: stdout };
        } catch (e) {
          return { kind: 'err' as const, error: e instanceof Error ? e.message : String(e) };
        }
      },
      execGh: async (args: readonly string[], cwd: string) => {
        try {
          const { stdout } = await execFileAsync('gh', [...args], { cwd });
          return { kind: 'ok' as const, value: stdout };
        } catch (e) {
          return { kind: 'err' as const, error: e instanceof Error ? e.message : String(e) };
        }
      },
      listRecentSessions: createListRecentSessions(),
      nowIso: () => new Date().toISOString(),
    }),

    // WHY in-process polling (not HTTP): see ConsoleService construction comment in trigger-listener.ts.
    // SESSION_LOAD_FAILED on getSessionDetail() is treated as "not ready yet" (retry),
    // not as failure. This handles the race where spawnSession() creates a session
    // in-process but the event log is not yet complete enough to project.
    awaitSessions: async (handles: readonly string[], timeoutMs: number) => {
      const POLL_INTERVAL_MS = 3_000;

      if (consoleService === null) {
        process.stderr.write(
          `[WARN coord:reason=await_degraded] awaitSessions: ConsoleService unavailable -- returning all ${handles.length} session(s) as failed.\n`,
        );
        return {
          results: [...handles].map((h) => ({
            handle: h,
            outcome: 'failed' as const,
            status: null,
            durationMs: 0,
          })),
          allSucceeded: false,
        };
      }

      const startMs = Date.now();
      const pending = new Set(handles);
      const results = new Map<string, { handle: string; outcome: 'success' | 'failed' | 'timeout'; status: string | null; durationMs: number }>();

      while (pending.size > 0) {
        const elapsed = Date.now() - startMs;
        if (elapsed >= timeoutMs) {
          break;
        }

        for (const handle of [...pending]) {
          try {
            const detail = await consoleService.getSessionDetail(handle);
            if (detail.isErr()) {
              // SESSION_LOAD_FAILED or NODE_NOT_FOUND: session not yet visible or corrupt.
              // Retry on next poll cycle -- do not mark as failed.
              continue;
            }
            const run = detail.value.runs[0];
            if (!run) continue; // session started but no run yet

            const status = run.status;
            if (status === 'complete' || status === 'complete_with_gaps') {
              results.set(handle, { handle, outcome: 'success', status, durationMs: Date.now() - startMs });
              pending.delete(handle);
            } else if (status === 'blocked') {
              results.set(handle, { handle, outcome: 'failed', status, durationMs: Date.now() - startMs });
              pending.delete(handle);
            }
            // in_progress: still running -- stay in pending
          } catch {
            // Unexpected throw (should not happen with ResultAsync, but defensive)
            results.set(handle, { handle, outcome: 'failed', status: null, durationMs: Date.now() - startMs });
            pending.delete(handle);
          }
        }

        if (pending.size > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      }

      // Any remaining pending handles hit the timeout
      for (const handle of pending) {
        results.set(handle, { handle, outcome: 'timeout', status: null, durationMs: timeoutMs });
      }

      const resultsArray = [...results.values()];
      return {
        results: resultsArray,
        allSucceeded: resultsArray.every((r) => r.outcome === 'success'),
      };
    },

    // WHY delegates to fetchAgentResult: see comment above fetchAgentResult definition.
    // getAgentResult behavior is unchanged -- this is a pure refactor to extract shared logic.
    // WHY delegates to fetchAgentResult: see comment above fetchAgentResult definition.
    getAgentResult: async (sessionHandle: string): Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }> => {
      return fetchAgentResult(sessionHandle);
    },

    // WHY delegates to fetchChildSessionResult: see comment on fetchChildSessionResult above.
    // The caller (spawnAndAwait or manual batch pattern) is responsible for calling awaitSessions
    // first. getChildSessionResult does not poll -- it reads the terminal status once.
    getChildSessionResult: async (
      handle: string,
      coordinatorSessionId?: string,
    ): Promise<ChildSessionResult> => {
      return fetchChildSessionResult(handle, coordinatorSessionId);
    },

    // WHY thin wrapper (not more logic): spawnAndAwait is sequential single-child only.
    // For batch/parallel patterns, callers use spawnSession N times -> awaitSessions(handles)
    // -> getChildSessionResult(handle) per handle. See interface JSDoc for details.
    //
    // WHY spawnAndAwait does not call sibling methods by name:
    // In a factory object literal, sibling methods cannot reference each other during
    // construction. spawnAndAwait accesses the closure variables (dispatch, ctx, etc.)
    // directly, mirroring the sub-steps of spawnSession and getChildSessionResult.
    // The spawnSession steps are reproduced here rather than calling this.spawnSession.
    spawnAndAwait: async (
      workflowId: string,
      goal: string,
      workspace: string,
      opts?: {
        readonly coordinatorSessionId?: string;
        readonly timeoutMs?: number;
        readonly agentConfig?: Readonly<{ readonly maxSessionMinutes?: number; readonly maxTurns?: number }>;
      },
    ): Promise<ChildSessionResult> => {
      // Default timeout: 15 minutes. Hardcoded to mirror CHILD_SESSION_TIMEOUT_MS in
      // pr-review.ts without importing from it (to avoid a circular dep).
      const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const coordinatorSessionId = opts?.coordinatorSessionId;
      const agentConfig = opts?.agentConfig;

      // Step 1: Spawn the child session (mirrors spawnSession logic).
      if (dispatch === null) {
        return {
          kind: 'failed',
          reason: 'error',
          message: 'spawnAndAwait: in-process router not initialized (setDispatch not called)',
        };
      }

      const startResult = await executeStartWorkflow(
        { workflowId, workspacePath: workspace, goal },
        ctx,
        {
          is_autonomous: 'true',
          workspacePath: workspace,
          triggerSource: 'daemon',
          ...(coordinatorSessionId !== undefined ? { parentSessionId: coordinatorSessionId } : {}),
        },
      );
      if (startResult.isErr()) {
        const detail = `${startResult.error.kind}${'message' in startResult.error ? ': ' + (startResult.error as { message: string }).message : ''}`;
        return { kind: 'failed', reason: 'error', message: `Session creation failed: ${detail}` };
      }

      const startContinueToken = startResult.value.response.continueToken;
      let handle: string;

      if (!startContinueToken) {
        // Workflow completed immediately (single-step); use workflowId as fallback handle.
        handle = workflowId;
      } else {
        const tokenResult = await parseContinueTokenOrFail(
          startContinueToken,
          ctx.v2.tokenCodecPorts,
          ctx.v2.tokenAliasStore,
        );
        if (tokenResult.isErr()) {
          return {
            kind: 'failed',
            reason: 'error',
            message: `Internal error: could not extract session handle from new session: ${tokenResult.error.message}`,
          };
        }
        handle = tokenResult.value.sessionId;

        // Enqueue the agent loop.
        const trigger: import('../daemon/workflow-runner.js').WorkflowTrigger = {
          workflowId,
          goal,
          workspacePath: workspace,
          ...(agentConfig !== undefined ? { agentConfig } : {}),
        };
        const r = startResult.value.response;
        const allocatedSession: import('../daemon/workflow-runner.js').AllocatedSession = {
          continueToken: r.continueToken ?? '',
          checkpointToken: r.checkpointToken,
          firstStepPrompt: r.pending?.prompt ?? '',
          isComplete: r.isComplete,
          triggerSource: 'daemon',
        };
        const source: import('../daemon/workflow-runner.js').SessionSource = {
          kind: 'pre_allocated',
          trigger,
          session: allocatedSession,
        };
        dispatch(trigger, source);
      }

      // Step 2: Wait for the child session to reach a terminal state.
      const awaitResult = await (async () => {
        const POLL_INTERVAL_MS = 3_000;

        if (consoleService === null) {
          return null; // signals await_degraded
        }

        const startMs = Date.now();
        const pending = new Set([handle]);
        while (pending.size > 0) {
          const elapsed = Date.now() - startMs;
          if (elapsed >= timeoutMs) break;

          for (const h of [...pending]) {
            try {
              const detail = await consoleService.getSessionDetail(h);
              if (detail.isErr()) continue;
              const run = detail.value.runs[0];
              if (!run) continue;
              const status = run.status;
              if (status === 'complete' || status === 'complete_with_gaps') {
                pending.delete(h);
              } else if (status === 'blocked') {
                pending.delete(h);
              }
            } catch {
              pending.delete(h);
            }
          }

          if (pending.size > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
        }
        return handle; // timed out if still pending; getChildSessionResult handles it
      })();

      if (awaitResult === null) {
        // consoleService was null -- return await_degraded directly.
        return {
          kind: 'await_degraded',
          message: 'ConsoleService unavailable -- cannot await child session outcome',
        };
      }

      // Step 3: Read the terminal result (single status check + artifact extraction).
      return fetchChildSessionResult(handle, coordinatorSessionId);
    },

    listOpenPRs: async (workspace: string) => {
      try {
        const { stdout } = await execFileAsync('gh', ['pr', 'list', '--json', 'number,title,headRefName'], {
          cwd: workspace,
          timeout: 30_000,
        });
        const parsed = JSON.parse(stdout) as Array<{ number: number; title: string; headRefName: string }>;
        return parsed.map((p) => ({ number: p.number, title: p.title, headRef: p.headRefName }));
      } catch {
        return [];
      }
    },

    mergePR: async (prNumber: number, workspace: string) => {
      try {
        await execFileAsync('gh', ['pr', 'merge', String(prNumber), '--squash', '--auto'], {
          cwd: workspace,
          timeout: 60_000,
        });
        return { kind: 'ok' as const, value: undefined };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { kind: 'err' as const, error: msg };
      }
    },

    writeFile: async (filePath: string, content: string) => {
      await fs.promises.writeFile(filePath, content, 'utf-8');
    },

    readFile: (filePath: string) => fs.promises.readFile(filePath, 'utf-8'),

    appendFile: (filePath: string, content: string) =>
      fs.promises.appendFile(filePath, content, 'utf-8'),

    mkdir: (dirPath: string, opts: { recursive: boolean }) =>
      fs.promises.mkdir(dirPath, opts),

    homedir: os.homedir,
    joinPath: path.join,
    nowIso: () => new Date().toISOString(),
    generateId: () => randomUUID(),

    stderr: (line: string) => process.stderr.write(line + '\n'),
    now: () => Date.now(),

    // AdaptiveCoordinatorDeps extensions (beyond CoordinatorDeps)

    fileExists: (p: string): boolean => fs.existsSync(p),

    archiveFile: (src: string, dest: string): Promise<void> =>
      fs.promises.rename(src, dest),

    pollForPR: async (branchPattern: string, timeoutMs: number): Promise<string | null> => {
      // Poll `gh pr list --head <branchPattern>` every 30 seconds until a PR is found
      // or the timeout elapses. Returns the PR URL or null.
      const pollIntervalMs = 30_000;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        try {
          const { stdout } = await execFileAsync(
            'gh',
            ['pr', 'list', '--head', branchPattern, '--json', 'url', '--limit', '1'],
            { timeout: 30_000 },
          );
          const parsed = JSON.parse(stdout) as Array<{ url: string }>;
          if (parsed.length > 0 && parsed[0] && parsed[0].url) {
            return parsed[0].url;
          }
        } catch {
          // gh command failed -- continue polling (PR may not exist yet)
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
        );
      }
      return null;
    },

    postToOutbox: async (message: string, metadata: Readonly<Record<string, unknown>>): Promise<void> => {
      const workrailDir = path.join(os.homedir(), '.workrail');
      const outboxPath = path.join(workrailDir, 'outbox.jsonl');
      await fs.promises.mkdir(workrailDir, { recursive: true });
      const entry = JSON.stringify({
        id: randomUUID(),
        message,
        metadata,
        timestamp: new Date().toISOString(),
      });
      await fs.promises.appendFile(outboxPath, entry + '\n', 'utf-8');
    },

    pollOutboxAck: async (requestId: string, timeoutMs: number): Promise<'acked' | 'timeout'> => {
      // Poll ~/.workrail/inbox-cursor.json every 5 minutes.
      // The human acknowledges by running `worktrain inbox`, which advances the cursor.
      // Resolve 'acked' when the cursor has advanced past the snapshot line count.
      //
      // WHY snapshot approach: postToOutbox appends a line to outbox.jsonl. The inbox
      // command sets lastReadCount = total valid lines in outbox.jsonl. When the cursor
      // advances beyond the snapshot count, the human has read the notification.
      const pollIntervalMs = 5 * 60 * 1000; // 5 minutes
      const workrailDir = path.join(os.homedir(), '.workrail');
      const outboxPath = path.join(workrailDir, 'outbox.jsonl');
      const cursorPath = path.join(workrailDir, 'inbox-cursor.json');

      // Take snapshot of current outbox line count
      let snapshotCount = 0;
      try {
        const outboxContent = await fs.promises.readFile(outboxPath, 'utf-8');
        snapshotCount = outboxContent.split('\n').filter((l) => l.trim() !== '').length;
      } catch {
        // outbox.jsonl doesn't exist yet -- snapshot is 0
      }

      // Suppress unused parameter warning: requestId is for traceability in logs
      void requestId;

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
        );

        try {
          const cursorContent = await fs.promises.readFile(cursorPath, 'utf-8');
          const cursor = JSON.parse(cursorContent) as { lastReadCount?: number };
          if (typeof cursor.lastReadCount === 'number' && cursor.lastReadCount > snapshotCount) {
            return 'acked';
          }
        } catch {
          // cursor file missing or malformed -- not yet acked, continue polling
        }
      }
      return 'timeout';
    },

    // ── Living work context ──────────────────────────────────────────────

    generateRunId: () => randomUUID(),

    readActiveRunId: async (workspace: string) => {
      const pointerPath = path.join(workspace, '.workrail', 'pipeline-runs', 'active-run.json');
      try {
        const raw = await fs.promises.readFile(pointerPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== 'object' || parsed === null) return ok(null);
        const p = parsed as Record<string, unknown>;
        if (typeof p['runId'] !== 'string') return ok(null);
        const runId = p['runId'] as string;

        // Check if the run is already completed -- if so, don't resume it.
        // This prevents a fresh run from inheriting prior-task artifacts.
        const runsDir = path.join(workspace, '.workrail', 'pipeline-runs');
        const contextPath = path.join(runsDir, `${runId}-context.json`);
        try {
          const ctxRaw = await fs.promises.readFile(contextPath, 'utf-8');
          const ctx = JSON.parse(ctxRaw) as unknown;
          if (typeof ctx === 'object' && ctx !== null && (ctx as Record<string, unknown>)['status'] === 'completed') {
            return ok(null); // prior run completed -- start fresh
          }
        } catch { /* context file missing or unreadable -- treat as in-progress */ }

        return ok(runId);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok(null);
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[WARN coordinator] readActiveRunId failed -- crash recovery skipped: ${msg}\n`);
        return err(`readActiveRunId failed: ${msg}`);
      }
    },

    markPipelineRunComplete: async (workspace: string, runId: string) => {
      const runsDir = path.join(workspace, '.workrail', 'pipeline-runs');
      const filePath = path.join(runsDir, `${runId}-context.json`);
      const tmpPath = filePath + '.tmp';
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const existing = JSON.parse(raw) as Record<string, unknown>;
        const updated = { ...existing, status: 'completed' };
        await fs.promises.writeFile(tmpPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
        await fs.promises.rename(tmpPath, filePath);
        return ok(undefined);
      } catch (e) {
        try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
        return err(`markPipelineRunComplete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    readPipelineContext: async (workspace: string, runId: string) => {
      const runsDir = path.join(workspace, '.workrail', 'pipeline-runs');
      const filePath = path.join(runsDir, `${runId}-context.json`);
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        return parsePipelineRunContext(parsed);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          return ok(null);
        }
        const msg = e instanceof Error ? e.message : String(e);
        return err(`readPipelineContext failed: ${msg}`);
      }
    },

    createPipelineContext: async (workspace, runId, goal, pipelineMode) => {
      const runsDir = path.join(workspace, '.workrail', 'pipeline-runs');
      const filePath = path.join(runsDir, `${runId}-context.json`);
      const tmpPath = filePath + '.tmp';
      try {
        await fs.promises.mkdir(runsDir, { recursive: true });
        const initial = { runId, goal, workspace, startedAt: new Date().toISOString(), pipelineMode, phases: {} };
        await fs.promises.writeFile(tmpPath, JSON.stringify(initial, null, 2) + '\n', 'utf-8');
        await fs.promises.rename(tmpPath, filePath);
        // Write recovery pointer AFTER the context file.
        // WHY context-first: if a crash occurs between the two renames, the context file exists
        // but the pointer does not. readActiveRunId returns null (ENOENT on pointer) so the next
        // run starts fresh -- the orphaned context file is harmless. The reverse ordering
        // (pointer-first) would be worse: the pointer would name a runId whose context file
        // doesn't exist yet, causing writePhaseRecord to fail on the next run.
        const pointerPath = path.join(runsDir, 'active-run.json');
        const pointerTmp = pointerPath + '.tmp';
        await fs.promises.writeFile(pointerTmp, JSON.stringify({ runId, workspace }, null, 2) + '\n', 'utf-8');
        await fs.promises.rename(pointerTmp, pointerPath);
        return ok(undefined);
      } catch (e) {
        try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
        return err(`createPipelineContext failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    writePhaseRecord: async (workspace: string, runId: string, entry) => {
      const runsDir = path.join(workspace, '.workrail', 'pipeline-runs');
      const filePath = path.join(runsDir, `${runId}-context.json`);
      const tmpPath = filePath + '.tmp';

      try {
        await fs.promises.mkdir(runsDir, { recursive: true });

        // Read existing context -- file must exist (createPipelineContext called first)
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        const existing = parsePipelineRunContext(parsed);
        if (existing.isErr() || existing.value === null) {
          return err(`writePhaseRecord: context file missing or invalid for runId=${runId}`);
        }

        // Merge the phase record immutably
        const updated = {
          ...existing.value,
          phases: {
            ...existing.value.phases,
            [entry.phase]: entry.record,
          },
        };

        // Atomic write via temp-rename
        await fs.promises.writeFile(tmpPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
        await fs.promises.rename(tmpPath, filePath);
        return ok(undefined);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
        return err(`writePhaseRecord failed: ${msg}`);
      }
    },
  };
}
