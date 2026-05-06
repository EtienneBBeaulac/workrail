/**
 * Pre-agent I/O phase for daemon workflow sessions.
 *
 * WHY this module: buildPreAgentSession() handles all setup before the agent
 * loop starts -- model validation, executeStartWorkflow, token decode,
 * persistTokens, worktree creation, and registry setup. It belongs in runner/
 * (the orchestration layer), not in workflow-runner.ts.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { V2ToolContext } from '../../mcp/types.js';
import { executeStartWorkflow } from '../../mcp/handlers/v2-execution/start.js';
import type { DaemonRegistry } from '../../v2/infra/in-memory/daemon-registry/index.js';
import { parseContinueTokenOrFail } from '../../mcp/handlers/v2-token-ops.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import { createSessionState, updateToken, setSessionId } from '../state/index.js';
import { buildAgentClient } from '../core/index.js';
import { persistTokens } from '../tools/_shared.js';
import { ActiveSessionSet } from '../active-sessions.js';
import type { WorkflowTrigger, SessionSource, ReadFileState } from '../types.js';
import type { PreAgentSessionResult } from './runner-types.js';
import { WORKTREES_DIR } from './runner-types.js';

const execFileAsync = promisify(execFile);

/**
 * Execute all I/O required before the agent loop can start.
 *
 * Handles: model validation, executeStartWorkflow (or pre-allocated response),
 * token decode, initial persistTokens, worktree creation (with second
 * persistTokens for worktreePath), and registry setup.
 *
 * WHY registry ordering: steer and daemon registries are registered LAST --
 * after all potentially-failing I/O. This guarantees that any error path
 * returning { kind: 'complete' } before registration has nothing to clean up.
 *
 * @param source - Optional session source. When provided with kind 'pre_allocated',
 *   executeStartWorkflow is skipped (the caller already allocated the session).
 *   When absent or kind 'allocate', executeStartWorkflow is called internally.
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
  source?: SessionSource,
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
    return { kind: 'complete', result: { _tag: 'error', workflowId: trigger.workflowId, message, stopReason: 'error' }, workrailSessionId: null, handle: undefined };
  }

  // ---- Session state ----
  const state = createSessionState('');

  // ---- executeStartWorkflow (or pre-allocated via SessionSource) ----
  let continueToken: string;
  let checkpointToken: string | null;
  let firstStepPrompt: string;
  let isComplete: boolean;

  const effectiveSource = source ?? { kind: 'allocate' as const, trigger };
  if (effectiveSource.kind === 'pre_allocated') {
    const s = effectiveSource.session;
    continueToken = s.continueToken;
    checkpointToken = s.checkpointToken ?? null;
    firstStepPrompt = s.firstStepPrompt;
    isComplete = s.isComplete;
  } else {
    const startResult = await executeStartWorkflow(
      { workflowId: trigger.workflowId, workspacePath: trigger.workspacePath, goal: trigger.goal },
      ctx,
      { is_autonomous: 'true', workspacePath: trigger.workspacePath, triggerSource: 'daemon' },
    );
    if (startResult.isErr()) {
      return {
        kind: 'complete',
        result: {
          _tag: 'error',
          workflowId: trigger.workflowId,
          message: `start_workflow failed: ${startResult.error.kind} -- ${JSON.stringify(startResult.error)}`,
          stopReason: 'error',
        },
        workrailSessionId: null,
        handle: undefined,
      };
    }
    const r = startResult.value.response;
    continueToken = r.continueToken ?? '';
    checkpointToken = r.checkpointToken ?? null;
    firstStepPrompt = r.pending?.prompt ?? '';
    isComplete = r.isComplete;
  }
  updateToken(state, continueToken);

  // ---- Decode WorkRail session ID ----
  if (continueToken) {
    const decoded = await parseContinueTokenOrFail(continueToken, ctx.v2.tokenCodecPorts, ctx.v2.tokenAliasStore);
    if (decoded.isOk()) {
      setSessionId(state, decoded.value.sessionId);
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
      return {
        kind: 'complete',
        result: {
          _tag: 'error',
          workflowId: trigger.workflowId,
          message: `Initial token persist failed: ${persistResult.error.code} -- ${persistResult.error.message}`,
          stopReason: 'error',
        },
        workrailSessionId: state.workrailSessionId,
        handle: undefined,
      };
    }
  }

  // ---- Worktree isolation ----
  let sessionWorkspacePath = trigger.workspacePath;
  let sessionWorktreePath: string | undefined;

  if (effectiveSource.kind === 'pre_allocated' && effectiveSource.session.sessionWorkspacePath !== undefined) {
    sessionWorkspacePath = effectiveSource.session.sessionWorkspacePath;
    sessionWorktreePath = effectiveSource.session.sessionWorkspacePath;
  }

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
        return {
          kind: 'complete',
          result: {
            _tag: 'error',
            workflowId: trigger.workflowId,
            message: `Worktree sidecar persist failed: ${worktreePersistResult.error.code} -- ${worktreePersistResult.error.message}`,
            stopReason: 'error',
          },
          workrailSessionId: state.workrailSessionId,
          handle: undefined,
        };
      }

      console.log(`[WorkflowRunner] Worktree created: sessionId=${sessionId} branch=${branchPrefix}${sessionId} path=${sessionWorkspacePath}`);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[WorkflowRunner] Worktree creation failed: sessionId=${sessionId} error=${errMsg}`);
      return {
        kind: 'complete',
        result: { _tag: 'error', workflowId: trigger.workflowId, message: `Worktree creation failed: ${errMsg}`, stopReason: 'error' },
        workrailSessionId: state.workrailSessionId,
        handle: undefined,
      };
    }
  }

  // ---- Registry setup (AFTER all potentially-failing I/O -- FM1 invariant) ----
  let handle: ReturnType<ActiveSessionSet['register']> | undefined;
  if (state.workrailSessionId !== null) {
    daemonRegistry?.register(state.workrailSessionId, trigger.workflowId);
    handle = activeSessionSet?.register(state.workrailSessionId, (text: string) => { state.pendingSteerParts.push(text); });
  }

  // ---- Single-step completion (must check AFTER registry setup) ----
  if (isComplete) {
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
      workrailSessionId: state.workrailSessionId,
      handle,
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
      firstStepPrompt,
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
