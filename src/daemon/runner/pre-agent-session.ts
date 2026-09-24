/**
 * Pre-agent I/O phase for daemon workflow sessions.
 *
 * WHY this module: buildPreAgentSession() handles all setup before the agent
 * loop starts -- model validation, executeStartWorkflow, token decode,
 * persistTokens, worktree creation, and registry setup. It belongs in runner/
 * (the orchestration layer), not in workflow-runner.ts.
 */

import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { V2ToolContext } from '../../mcp/types.js';
import { executeStartWorkflow } from '../../v2/usecases/start-workflow.js';
import type { DaemonRegistry } from '../../v2/infra/in-memory/daemon-registry/index.js';
import { parseContinueTokenOrFail } from '../../v2/usecases/v2-token-ops.js';
import type { DaemonEventEmitter, RunId } from '../daemon-events.js';
import { createSessionState, updateToken, setSessionId } from '../state/index.js';
import { buildAgentClient } from '../core/index.js';
import { createTokenPersister } from '../tools/_shared.js';
import { ActiveSessionSet } from '../active-sessions.js';
import type { WorkflowTrigger, SessionSource, ReadFileState } from '../types.js';
import { prepareSessionWorkspace, rollbackPreparedWorkspace, type WorkspacePreparationEffects } from './workspace-preparation.js';
import { planSessionWorkspace } from './legacy-workspace-plan.js';
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
  apiKey: string | undefined,
  sessionId: RunId,
  startMs: number,
  statsDir: string,
  sessionsDir: string,
  emitter: DaemonEventEmitter | undefined,
  daemonRegistry: DaemonRegistry | undefined,
  activeSessionSet: ActiveSessionSet | undefined,
  source?: Exclude<SessionSource, { kind: 'supervised' }>,
): Promise<PreAgentSessionResult> {
  const persistTokens = createTokenPersister(sessionsDir);
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
    state.pendingStepIdAfterAdvance = s.stepId ?? null;
  } else {
    const startResult = await executeStartWorkflow(
      {
        gate: ctx.v2.gate,
        sessionStore: ctx.v2.sessionStore,
        snapshotStore: ctx.v2.snapshotStore,
        pinnedStore: ctx.v2.pinnedStore,
        crypto: ctx.v2.crypto,
        tokenCodecPorts: ctx.v2.tokenCodecPorts,
        idFactory: ctx.v2.idFactory,
        validationPipelineDeps: ctx.v2.validationPipelineDeps,
        tokenAliasStore: ctx.v2.tokenAliasStore,
        entropy: ctx.v2.entropy,
        resolvedRootUris: ctx.v2.resolvedRootUris,
        rememberedRootsStore: ctx.v2.rememberedRootsStore,
        managedSourceStore: ctx.v2.managedSourceStore,
        workspaceResolver: ctx.v2.workspaceResolver,
        fallbackWorkflowReader: ctx.workflowService,
        featureFlags: ctx.featureFlags,
      },
      { workflowId: trigger.workflowId, workspacePath: trigger.workspacePath, goal: trigger.goal },
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
    const r = startResult.value;
    continueToken = r.continueToken;
    checkpointToken = r.checkpointToken;
    firstStepPrompt = r.meta.prompt;
    isComplete = (r as any).isComplete ?? false;
    state.pendingStepIdAfterAdvance = r.meta.stepId;
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
      context: trigger.context,
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

  // Workspace preparation does not allocate sessions or persist engine authority.
  // The legacy adapter keeps its original ordering and owns sidecar writes.
  const workspaceFailure = (message: string): PreAgentSessionResult => ({
    kind: 'complete', result: { _tag: 'error', workflowId: trigger.workflowId, message, stopReason: 'error' },
    workrailSessionId: state.workrailSessionId, handle: undefined,
  });
  const plan = planSessionWorkspace(trigger, sessionId, WORKTREES_DIR,
    effectiveSource.kind === 'pre_allocated' ? effectiveSource.session.sessionWorkspacePath : undefined);
  if (plan.kind === 'failed') {
    console.error(`[WorkflowRunner] Read-only worktree creation failed: sessionId=${sessionId} -- ${plan.message}`);
    return workspaceFailure(plan.message);
  }
  const effects: WorkspacePreparationEffects = {
    ensureDirectory: async directory => { await fs.mkdir(directory, { recursive: true }); },
    git: async (repository, args) => { await execFileAsync('git', ['-C', repository, ...args]); },
  };
  const workspace = await prepareSessionWorkspace(plan.plan, effects);
  const prefix = trigger.branchStrategy === 'read-only' ? 'Read-only worktree' : 'Worktree';
  if (workspace.kind === 'failed') {
    console.error(`[WorkflowRunner] ${prefix} creation failed: sessionId=${sessionId} error=${workspace.message}`);
    return workspaceFailure(`${prefix} creation failed: ${workspace.message}`);
  }
  const sessionWorkspacePath = workspace.workspacePath;
  const sessionWorktreePath = workspace.worktreePath;
  if (workspace.kind === 'created') {
    const persisted = await persistTokens(sessionId, continueToken ?? state.currentContinueToken, checkpointToken, workspace.worktreePath, {
      workflowId: trigger.workflowId, goal: trigger.goal, workspacePath: trigger.workspacePath, context: trigger.context,
      ...(workspace.plan.checkout.kind === 'detached' ? { branchStrategy: 'read-only' as const } : {}),
    });
    if (persisted.kind === 'err') {
      console.error(`[WorkflowRunner] ${prefix} sidecar persist failed: ${persisted.error.code} -- ${persisted.error.message}`);
      if (await rollbackPreparedWorkspace(workspace, effects) === 'failed') {
        console.error(`[WorkflowRunner] ${prefix} rollback failed: sessionId=${sessionId} path=${workspace.worktreePath}`);
      }
      const detail = workspace.plan.checkout.kind === 'detached' ? persisted.error.code : `${persisted.error.code} -- ${persisted.error.message}`;
      return workspaceFailure(`${prefix} sidecar persist failed: ${detail}`);
    }
    const checkout = workspace.plan.checkout;
    const label = checkout.kind === 'branch' ? `branch=${checkout.name}` : `prBranch=${checkout.ref}`;
    console.log(`[WorkflowRunner] ${prefix} created: sessionId=${sessionId} ${label} path=${workspace.workspacePath}`);
  }

  // ---- Registry setup (AFTER all potentially-failing I/O -- FM1 invariant) ----
  let handle: ReturnType<ActiveSessionSet['register']> | undefined;
  handle = activeSessionSet?.register(sessionId, (text: string) => { state.pendingSteerParts.push(text); });
  if (state.workrailSessionId !== null) {
    daemonRegistry?.register(state.workrailSessionId, trigger.workflowId);
    handle?.setWorkrailSessionId(state.workrailSessionId);
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
      persistTokens: createTokenPersister(sessionsDir, {
        worktreePath: sessionWorktreePath, workrailSessionId: state.workrailSessionId,
        recoveryContext: { workflowId: trigger.workflowId, goal: trigger.goal, workspacePath: trigger.workspacePath,
          context: trigger.context, branchStrategy: workspace.kind === 'created' && workspace.plan.checkout.kind === 'detached'
            ? 'read-only' : trigger.branchStrategy },
      }),
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
