/**
 * WorkRail Auto: Coordinator Deps
 *
 * Two classes, one factory:
 *
 * SessionReader -- reads session state from the store. Injected with only the two
 * ports it needs (sessionStore, snapshotStore). No access to dispatch, execFileAsync,
 * or coordinator infrastructure. Directly testable with fake stores. Used by:
 *   - CoordinatorDepsImpl (delegation)
 *   - Tests (direct construction)
 *
 * CoordinatorDepsImpl -- coordinator infrastructure (git, gh, outbox, pipeline context,
 * session spawning). Takes dispatch as a required constructor parameter -- no nullable
 * fields, no late-binding. The circular dep (coordinatorDeps needs dispatch, dispatch
 * needs TriggerRouter which needs coordinatorDeps) is broken by moving the setter to
 * TriggerRouter.setCoordinatorDeps() instead.
 *
 * createCoordinatorDeps(dispatch) -- builds SessionReader from ctx.v2 and CoordinatorDepsImpl
 * with the required dispatch function. Called after TriggerRouter is constructed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ok, err } from 'neverthrow';
import type { V2ToolContext } from '../mcp/types.js';
import type { AdaptiveCoordinatorDeps } from '../coordinators/adaptive-pipeline.js';
import type { CoordinatorSpawnContext } from '../coordinators/types.js';
import type { ChildSessionResult } from '../coordinators/types.js';
import { executeStartWorkflow } from '../mcp/handlers/v2-execution/start.js';
import { parseContinueTokenOrFail } from '../mcp/handlers/v2-token-ops.js';
import { createContextAssembler } from '../context-assembly/index.js';
import { createListRecentSessions } from '../context-assembly/infra.js';
import type { WorkflowTrigger, SessionSource, AllocatedSession } from '../daemon/types.js';
import { parsePipelineRunContext } from '../coordinators/pipeline-run-context.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../v2/ports/session-event-log-store.port.js';
import type { SnapshotStorePortV2 } from '../v2/ports/snapshot-store.port.js';
import { asSessionId, asSnapshotRef, asSha256Digest } from '../v2/durable-core/ids/index.js';
import { asSortedEventLog } from '../v2/durable-core/sorted-event-log.js';
import { projectRunDagV2 } from '../v2/projections/run-dag.js';
import { projectNodeOutputsV2 } from '../v2/projections/node-outputs.js';
import { projectArtifactsV2 } from '../v2/projections/artifacts.js';
import { projectGapsV2 } from '../v2/projections/gaps.js';
import { OUTPUT_CHANNEL, PAYLOAD_KIND, AUTONOMY_MODE, EVENT_KIND } from '../v2/durable-core/constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoordinatorDepsDependencies {
  /** V2 tool context -- provides sessionStore, snapshotStore, and token ports. */
  readonly ctx: V2ToolContext;
  /** Promisified execFile for git/gh CLI calls. Injectable for testing. */
  readonly execFileAsync: (
    cmd: string,
    args: string[],
    opts?: object,
  ) => Promise<{ stdout: string }>;
  /** Dispatch function from TriggerRouter. Required -- no nullable late-binding. */
  readonly dispatch: (trigger: WorkflowTrigger, source?: SessionSource) => void;
}

// ---------------------------------------------------------------------------
// SessionStatus: return type of SessionReader.deriveSessionStatus
// ---------------------------------------------------------------------------

export type SessionStatus =
  | { readonly kind: 'complete' | 'blocked' | 'in_progress' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'hard_fail'; readonly message: string }
  /**
   * Session is paused at a gate checkpoint (requireConfirmation step in autonomous mode).
   * The coordinator must dispatch a gate evaluator session and resume the paused session
   * with the verdict. PR 2 wires this up -- for now treated the same as 'blocked' (terminal).
   */
  | {
      readonly kind: 'paused_at_gate';
      readonly stepId: string;
      /**
       * The continueToken for the gate_checkpoint node -- the coordinator passes this to
       * resume_from_gate (PR 2). Null in PR 1: requires calling replayFromRecordedAdvance
       * on the gate node to mint. Any caller that reads gateToken must handle null.
       */
      readonly gateToken: string | null;
    };

// ---------------------------------------------------------------------------
// SessionReader
//
// Reads session state directly from the store. Only depends on two store ports.
// No access to dispatch, execFileAsync, or infrastructure. Fully testable with
// fake stores injected at construction time.
// ---------------------------------------------------------------------------

export class SessionReader {
  private static readonly POLL_INTERVAL_MS = 3_000;

  constructor(
    private readonly sessionStore: SessionEventLogReadonlyStorePortV2,
    private readonly snapshotStore: SnapshotStorePortV2,
  ) {}

  /**
   * Derive terminal status of a session from the store.
   *
   * WHY isBlocked inlined (not via projectRunStatusSignalsV2):
   * deriveSessionStatus already calls projectRunDagV2 for tip/snapshot lookup.
   * projectRunStatusSignalsV2 would call it again internally -- double work.
   * The isBlocked logic (3 lines) is inlined with a reference to its source:
   * src/v2/projections/run-status-signals.ts lines 68-78.
   * Coordinator sessions always use 'guided' autonomy (defaultPreferences), so
   * FULL_AUTO_NEVER_STOP is dead code here but preserved for correctness.
   */
  async deriveSessionStatus(handle: string): Promise<SessionStatus> {
    const loadResult = await this.sessionStore.load(asSessionId(handle));
    if (loadResult.isErr()) {
      const code = loadResult.error.code;
      if (code === 'SESSION_STORE_IO_ERROR' || code === 'SESSION_STORE_LOCK_BUSY') {
        return { kind: 'retry' };
      }
      return { kind: 'hard_fail', message: `Session store error: ${code} -- ${loadResult.error.message}` };
    }

    const events = loadResult.value.events;
    const sortedRes = asSortedEventLog(events);
    if (sortedRes.isErr()) return { kind: 'retry' };

    const dagRes = projectRunDagV2(sortedRes.value);
    if (dagRes.isErr()) return { kind: 'in_progress' };

    const run = Object.values(dagRes.value.runsById)[0];
    if (!run) return { kind: 'in_progress' };

    // isBlocked: inlined from run-status-signals.ts lines 68-78.
    // Requires: tip nodeKind (from dag), gaps (from projectGapsV2), preferences (from events).
    const gapsRes = projectGapsV2(sortedRes.value);
    if (gapsRes.isOk()) {
      const runId = run.runId;
      const tip = run.preferredTipNodeId;

      // Preferences: simplified re-derivation (mirrors run-status-signals.ts lines 48-54).
      const prefsByNodeId: Record<string, { autonomy: string }> = {};
      for (const e of events) {
        if (e.kind !== EVENT_KIND.PREFERENCES_CHANGED) continue;
        prefsByNodeId[e.scope.nodeId] = e.data.effective;
      }
      const prefs = (tip ? prefsByNodeId[tip] : null) ?? { autonomy: 'guided' };

      const hasBlockingCategoryGap = (gapsRes.value.unresolvedCriticalByRunId[runId] ?? []).some(
        (g) =>
          g.reason.category === 'user_only_dependency' ||
          g.reason.category === 'contract_violation' ||
          g.reason.category === 'capability_missing',
      );
      const tipNodeKind = tip ? run.nodesById[tip]?.nodeKind : undefined;
      const blockedByTopology = tipNodeKind === 'blocked_attempt';
      const isBlocked =
        prefs.autonomy !== AUTONOMY_MODE.FULL_AUTO_NEVER_STOP && (blockedByTopology || hasBlockingCategoryGap);

      if (isBlocked) return { kind: 'blocked' };

      // Gate checkpoint: tip is a gate_checkpoint node -- session paused awaiting evaluation.
      // TODO(PR 2): coordinator reads paused_at_gate and dispatches gate evaluator session.
      if (tipNodeKind === 'gate_checkpoint') {
        const tipNode = tip ? run.nodesById[tip] : undefined;
        const gateSnapshotRef = tipNode ? asSnapshotRef(asSha256Digest(tipNode.snapshotRef)) : undefined;
        if (gateSnapshotRef) {
          const gateSnapshot = await this.snapshotStore.getExecutionSnapshotV1(gateSnapshotRef);
          if (gateSnapshot.isOk() && gateSnapshot.value) {
            // gateCheckpoint is a typed field on EnginePayloadV1 -- no cast needed.
            const gatePayload = gateSnapshot.value.enginePayload.gateCheckpoint;
            const stepId = gatePayload?.stepId ?? '';
            // gateToken requires calling replayFromRecordedAdvance to mint. Stub for PR 2.
            return { kind: 'paused_at_gate', stepId, gateToken: null };
          }
        }
        return { kind: 'paused_at_gate', stepId: '', gateToken: null };
      }
    }

    // Completion: requires the tip node's execution snapshot.
    const tipNodeId = run.preferredTipNodeId;
    if (!tipNodeId) return { kind: 'in_progress' };
    const tip = run.nodesById[tipNodeId];
    if (!tip) return { kind: 'in_progress' };

    const snapshotRef = asSnapshotRef(asSha256Digest(tip.snapshotRef));
    const snapshotResult = await this.snapshotStore.getExecutionSnapshotV1(snapshotRef);
    if (snapshotResult.isErr()) {
      const code = snapshotResult.error.code;
      if (code === 'SNAPSHOT_STORE_CORRUPTION_DETECTED' || code === 'SNAPSHOT_STORE_INVARIANT_VIOLATION') {
        return { kind: 'hard_fail', message: `Snapshot store error: ${code} -- ${snapshotResult.error.message}` };
      }
      return { kind: 'in_progress' }; // IO_ERROR: snapshot not yet written
    }

    if (snapshotResult.value?.enginePayload.engineState.kind === 'complete') {
      return { kind: 'complete' };
    }
    return { kind: 'in_progress' };
  }

  /**
   * Read recap notes from a completed session's tip node.
   * Artifacts collected from ALL nodes -- a verdict may be emitted on any step.
   */
  async fetchAgentResult(
    sessionHandle: string,
  ): Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }> {
    const emptyResult = { recapMarkdown: null, artifacts: [] as readonly unknown[] };
    try {
      const loadResult = await this.sessionStore.load(asSessionId(sessionHandle));
      if (loadResult.isErr()) return emptyResult;

      const events = loadResult.value.events;
      const sortedRes = asSortedEventLog(events);
      if (sortedRes.isErr()) return emptyResult;
      const dagRes = projectRunDagV2(sortedRes.value);
      if (dagRes.isErr()) return emptyResult;
      const run = Object.values(dagRes.value.runsById)[0];
      const tipNodeId = run?.preferredTipNodeId ?? null;

      let recap: string | null = null;
      if (tipNodeId) {
        const outputsRes = projectNodeOutputsV2(events);
        if (outputsRes.isOk()) {
          const tipOutputs = outputsRes.value.nodesById[tipNodeId];
          const recaps = tipOutputs?.currentByChannel[OUTPUT_CHANNEL.RECAP];
          const latest = recaps?.at(-1);
          if (latest && latest.payload.payloadKind === PAYLOAD_KIND.NOTES) {
            recap = latest.payload.notesMarkdown;
          }
        }
      }

      const collectedArtifacts: unknown[] = [];
      const artifactsRes = projectArtifactsV2(events);
      if (artifactsRes.isOk()) {
        for (const nodeArtifacts of Object.values(artifactsRes.value.byNodeId)) {
          for (const a of nodeArtifacts.artifacts) {
            collectedArtifacts.push(a.content);
          }
        }
      }

      return { recapMarkdown: recap, artifacts: collectedArtifacts };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[WARN coord:reason=exception handle=${sessionHandle.slice(0, 16)}] fetchAgentResult: ${msg}\n`);
      return emptyResult;
    }
  }

  /**
   * Map a terminal session handle to a typed ChildSessionResult.
   * Caller must ensure the session is terminal (call awaitSessions first).
   */
  async fetchChildSessionResult(handle: string): Promise<ChildSessionResult> {
    const statusResult = await this.deriveSessionStatus(handle);

    if (statusResult.kind === 'complete') {
      const agentResult = await this.fetchAgentResult(handle);
      return { kind: 'success', notes: agentResult.recapMarkdown, artifacts: agentResult.artifacts };
    }
    if (statusResult.kind === 'blocked') {
      return { kind: 'failed', reason: 'stuck', message: `Child session ${handle.slice(0, 16)} reached blocked state` };
    }
    // Gate checkpoint: session paused at a requireConfirmation gate. PR 2 will dispatch
    // the gate evaluator; for now, treat as failed to unblock the coordinator.
    if (statusResult.kind === 'paused_at_gate') {
      return { kind: 'failed', reason: 'stuck', message: `Child session ${handle.slice(0, 16)} paused at gate checkpoint (step '${statusResult.stepId}'). Gate evaluation not yet implemented.` };
    }
    if (statusResult.kind === 'hard_fail') {
      process.stderr.write(`[WARN coord:reason=store_error handle=${handle.slice(0, 16)}] fetchChildSessionResult: ${statusResult.message}\n`);
      return { kind: 'failed', reason: 'error', message: statusResult.message };
    }
    // retry or in_progress: invariant violation
    process.stderr.write(`[WARN coord:reason=invariant_violation handle=${handle.slice(0, 16)}] fetchChildSessionResult called on non-terminal session (status=${statusResult.kind}). Call awaitSessions first.\n`);
    return { kind: 'timed_out', message: `Child session ${handle.slice(0, 16)} is not yet terminal (status: ${statusResult.kind})` };
  }

  async awaitSessions(handles: readonly string[], timeoutMs: number): Promise<{
    results: Array<{ handle: string; outcome: 'success' | 'failed' | 'timeout'; status: string | null; durationMs: number }>;
    allSucceeded: boolean;
  }> {
    const startMs = Date.now();
    const pending = new Set(handles);
    const results = new Map<string, { handle: string; outcome: 'success' | 'failed' | 'timeout'; status: string | null; durationMs: number }>();

    while (pending.size > 0) {
      if (Date.now() - startMs >= timeoutMs) break;

      for (const handle of [...pending]) {
        try {
          const statusResult = await this.deriveSessionStatus(handle);
          if (statusResult.kind === 'complete') {
            results.set(handle, { handle, outcome: 'success', status: 'complete', durationMs: Date.now() - startMs });
            pending.delete(handle);
          } else if (statusResult.kind === 'blocked') {
            results.set(handle, { handle, outcome: 'failed', status: 'blocked', durationMs: Date.now() - startMs });
            pending.delete(handle);
          } else if (statusResult.kind === 'paused_at_gate') {
            // Gate checkpoint: treat as terminal for now. PR 2 will dispatch the gate evaluator.
            results.set(handle, { handle, outcome: 'failed', status: 'paused_at_gate', durationMs: Date.now() - startMs });
            pending.delete(handle);
          } else if (statusResult.kind === 'hard_fail') {
            process.stderr.write(`[WARN coord:reason=store_error handle=${handle.slice(0, 16)}] awaitSessions: ${statusResult.message}\n`);
            results.set(handle, { handle, outcome: 'failed', status: null, durationMs: Date.now() - startMs });
            pending.delete(handle);
          }
          // retry or in_progress: stay pending
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`[WARN coord:reason=unexpected_exception handle=${handle.slice(0, 16)}] awaitSessions: ${msg}\n`);
          results.set(handle, { handle, outcome: 'failed', status: null, durationMs: Date.now() - startMs });
          pending.delete(handle);
        }
      }

      if (pending.size > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, SessionReader.POLL_INTERVAL_MS));
      }
    }

    for (const handle of pending) {
      results.set(handle, { handle, outcome: 'timeout', status: null, durationMs: timeoutMs });
    }

    const resultsArray = [...results.values()];
    return { results: resultsArray, allSucceeded: resultsArray.every((r) => r.outcome === 'success') };
  }
}

// ---------------------------------------------------------------------------
// CoordinatorDepsImpl
// ---------------------------------------------------------------------------

class CoordinatorDepsImpl implements AdaptiveCoordinatorDeps {
  private readonly reader: SessionReader;
  private readonly ctx: V2ToolContext;
  private readonly execFileAsync: CoordinatorDepsDependencies['execFileAsync'];
  private readonly dispatch: (trigger: WorkflowTrigger, source?: SessionSource) => void;

  constructor(
    reader: SessionReader,
    ctx: V2ToolContext,
    execFileAsync: CoordinatorDepsDependencies['execFileAsync'],
    dispatch: (trigger: WorkflowTrigger, source?: SessionSource) => void,
  ) {
    this.reader = reader;
    this.ctx = ctx;
    this.execFileAsync = execFileAsync;
    this.dispatch = dispatch;
  }

  /**
   * Core session spawn: allocate in store, decode handle, enqueue agent loop.
   *
   * WHY SessionSource pre_allocated: runWorkflow() skips its own executeStartWorkflow()
   * call when a pre_allocated SessionSource is passed, preventing double session creation.
   * WHY parentSessionId in internalContext: executeStartWorkflow writes it to the
   * session_created event so the parent-child relationship is durable in the event log.
   */
  private async spawnSessionCore(opts: {
    workflowId: string;
    goal: string;
    workspace: string;
    trigger: WorkflowTrigger;
    parentSessionId?: string;
  }): Promise<{ kind: 'ok'; handle: string } | { kind: 'err'; error: string }> {
    const startResult = await executeStartWorkflow(
      { workflowId: opts.workflowId, workspacePath: opts.workspace, goal: opts.goal },
      this.ctx,
      {
        is_autonomous: 'true',
        workspacePath: opts.workspace,
        triggerSource: 'daemon',
        ...(opts.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
      },
    );
    if (startResult.isErr()) {
      const detail = `${startResult.error.kind}${'message' in startResult.error ? ': ' + (startResult.error as { message: string }).message : ''}`;
      return { kind: 'err', error: `Session creation failed: ${detail}` };
    }

    const startContinueToken = startResult.value.response.continueToken;
    if (!startContinueToken) {
      return { kind: 'ok', handle: opts.workflowId };
    }

    const tokenResult = await parseContinueTokenOrFail(
      startContinueToken,
      this.ctx.v2.tokenCodecPorts,
      this.ctx.v2.tokenAliasStore,
    );
    if (tokenResult.isErr()) {
      process.stderr.write(`[ERROR coordinator-deps:spawnSessionCore] Failed to decode session handle: ${tokenResult.error.message}\n`);
      return { kind: 'err', error: 'Internal error: could not extract session handle from new session' };
    }
    const handle = tokenResult.value.sessionId;

    const r = startResult.value.response;
    const allocatedSession: AllocatedSession = {
      continueToken: r.continueToken ?? '',
      checkpointToken: r.checkpointToken,
      firstStepPrompt: r.pending?.prompt ?? '',
      isComplete: r.isComplete,
      triggerSource: 'daemon',
    };
    const source: SessionSource = { kind: 'pre_allocated', trigger: opts.trigger, session: allocatedSession };
    this.dispatch(opts.trigger, source);
    return { kind: 'ok', handle };
  }

  // ---------------------------------------------------------------------------
  // CoordinatorDeps interface
  // ---------------------------------------------------------------------------

  async spawnSession(
    workflowId: string,
    goal: string,
    workspace: string,
    context?: CoordinatorSpawnContext,
    agentConfig?: Readonly<{ readonly maxSessionMinutes?: number; readonly maxTurns?: number }>,
    parentSessionId?: string,
    branchStrategy?: 'worktree' | 'none',
  ) {
    // WHY in-process (not HTTP): avoids the HTTP handler's LLM credential check and
    // the race where new sessions aren't yet visible via HTTP.
    // WHY agentConfig forwarded: coordinator sets per-phase timeouts (e.g. 55m for discovery)
    // that exceed DEFAULT_SESSION_TIMEOUT_MINUTES=30.
    const trigger: WorkflowTrigger = {
      workflowId,
      goal,
      workspacePath: workspace,
      context: context as Readonly<Record<string, unknown>> | undefined,
      ...(agentConfig !== undefined ? { agentConfig } : {}),
      ...(branchStrategy !== undefined ? { branchStrategy } : {}),
    };
    const result = await this.spawnSessionCore({ workflowId, goal, workspace, trigger, parentSessionId });
    if (result.kind === 'err') return { kind: 'err' as const, error: result.error };
    return { kind: 'ok' as const, value: result.handle };
  }

  readonly contextAssembler = createContextAssembler({
    execGit: async (args: readonly string[], cwd: string) => {
      try {
        const { stdout } = await this.execFileAsync('git', [...args], { cwd });
        return { kind: 'ok' as const, value: stdout };
      } catch (e) {
        return { kind: 'err' as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
    execGh: async (args: readonly string[], cwd: string) => {
      try {
        const { stdout } = await this.execFileAsync('gh', [...args], { cwd });
        return { kind: 'ok' as const, value: stdout };
      } catch (e) {
        return { kind: 'err' as const, error: e instanceof Error ? e.message : String(e) };
      }
    },
    listRecentSessions: createListRecentSessions(),
    nowIso: () => new Date().toISOString(),
  });

  async awaitSessions(handles: readonly string[], timeoutMs: number) {
    return this.reader.awaitSessions(handles, timeoutMs);
  }

  async getAgentResult(sessionHandle: string) {
    return this.reader.fetchAgentResult(sessionHandle);
  }

  async getChildSessionResult(handle: string, _coordinatorSessionId?: string): Promise<ChildSessionResult> {
    return this.reader.fetchChildSessionResult(handle);
  }

  async spawnAndAwait(
    workflowId: string,
    goal: string,
    workspace: string,
    opts?: {
      readonly coordinatorSessionId?: string;
      readonly timeoutMs?: number;
      readonly agentConfig?: Readonly<{ readonly maxSessionMinutes?: number; readonly maxTurns?: number }>;
    },
  ): Promise<ChildSessionResult> {
    const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const trigger: WorkflowTrigger = {
      workflowId, goal, workspacePath: workspace,
      ...(opts?.agentConfig !== undefined ? { agentConfig: opts.agentConfig } : {}),
    };
    const spawnResult = await this.spawnSessionCore({
      workflowId, goal, workspace, trigger,
      parentSessionId: opts?.coordinatorSessionId,
    });
    if (spawnResult.kind === 'err') {
      return { kind: 'failed', reason: 'error', message: spawnResult.error };
    }
    await this.reader.awaitSessions([spawnResult.handle], timeoutMs);
    return this.reader.fetchChildSessionResult(spawnResult.handle);
  }

  // ---------------------------------------------------------------------------
  // AdaptiveCoordinatorDeps extensions
  // ---------------------------------------------------------------------------

  async listOpenPRs(workspace: string) {
    try {
      const { stdout } = await this.execFileAsync('gh', ['pr', 'list', '--json', 'number,title,headRefName'], { cwd: workspace, timeout: 30_000 });
      const parsed = JSON.parse(stdout) as Array<{ number: number; title: string; headRefName: string }>;
      return parsed.map((p) => ({ number: p.number, title: p.title, headRef: p.headRefName }));
    } catch {
      return [];
    }
  }

  async mergePR(prNumber: number, workspace: string) {
    try {
      await this.execFileAsync('gh', ['pr', 'merge', String(prNumber), '--squash', '--auto'], { cwd: workspace, timeout: 60_000 });
      return { kind: 'ok' as const, value: undefined };
    } catch (e) {
      return { kind: 'err' as const, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async writeFile(filePath: string, content: string) {
    await fs.promises.writeFile(filePath, content, 'utf-8');
  }

  readFile(filePath: string) {
    return fs.promises.readFile(filePath, 'utf-8');
  }

  appendFile(filePath: string, content: string) {
    return fs.promises.appendFile(filePath, content, 'utf-8');
  }

  mkdir(dirPath: string, opts: { recursive: boolean }) {
    return fs.promises.mkdir(dirPath, opts);
  }

  readonly homedir = os.homedir;
  readonly joinPath = path.join;
  nowIso() { return new Date().toISOString(); }
  generateId() { return randomUUID(); }
  stderr(line: string) { process.stderr.write(line + '\n'); }
  now() { return Date.now(); }

  fileExists(p: string): boolean { return fs.existsSync(p); }

  archiveFile(src: string, dest: string): Promise<void> {
    return fs.promises.rename(src, dest);
  }

  async pollForPR(branchPattern: string, timeoutMs: number): Promise<string | null> {
    const pollIntervalMs = 30_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const { stdout } = await this.execFileAsync('gh', ['pr', 'list', '--head', branchPattern, '--json', 'url', '--limit', '1'], { timeout: 30_000 });
        const parsed = JSON.parse(stdout) as Array<{ url: string }>;
        if (parsed.length > 0 && parsed[0]?.url) return parsed[0].url;
      } catch { /* PR may not exist yet */ }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
    }
    return null;
  }

  async postToOutbox(message: string, metadata: Readonly<Record<string, unknown>>): Promise<void> {
    const workrailDir = path.join(os.homedir(), '.workrail');
    const outboxPath = path.join(workrailDir, 'outbox.jsonl');
    await fs.promises.mkdir(workrailDir, { recursive: true });
    const entry = JSON.stringify({ id: randomUUID(), message, metadata, timestamp: new Date().toISOString() });
    await fs.promises.appendFile(outboxPath, entry + '\n', 'utf-8');
  }

  async pollOutboxAck(_requestId: string, timeoutMs: number): Promise<'acked' | 'timeout'> {
    // WHY snapshot approach: postToOutbox appends a line to outbox.jsonl. The inbox
    // command sets lastReadCount = total valid lines. When the cursor advances beyond
    // the snapshot count, the human has acknowledged the notification.
    const pollIntervalMs = 5 * 60 * 1000;
    const workrailDir = path.join(os.homedir(), '.workrail');
    const outboxPath = path.join(workrailDir, 'outbox.jsonl');
    const cursorPath = path.join(workrailDir, 'inbox-cursor.json');

    let snapshotCount = 0;
    try {
      const outboxContent = await fs.promises.readFile(outboxPath, 'utf-8');
      snapshotCount = outboxContent.split('\n').filter((l) => l.trim() !== '').length;
    } catch { /* outbox.jsonl doesn't exist yet */ }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
      try {
        const cursorContent = await fs.promises.readFile(cursorPath, 'utf-8');
        const cursor = JSON.parse(cursorContent) as { lastReadCount?: number };
        if (typeof cursor.lastReadCount === 'number' && cursor.lastReadCount > snapshotCount) return 'acked';
      } catch { /* cursor missing or malformed */ }
    }
    return 'timeout';
  }

  // ── Living work context ──────────────────────────────────────────────

  generateRunId() { return randomUUID(); }

  async readActiveRunId(workspace: string) {
    const runsDir = path.join(workspace, '.workrail', 'pipeline-runs');
    try {
      const entries = await fs.promises.readdir(runsDir);
      const candidates: Array<{ runId: string; startedAt: string }> = [];
      for (const entry of entries) {
        if (!entry.endsWith('-context.json')) continue;
        try {
          const raw = await fs.promises.readFile(path.join(runsDir, entry), 'utf-8');
          const ctx = JSON.parse(raw) as unknown;
          if (typeof ctx !== 'object' || ctx === null) continue;
          const c = ctx as Record<string, unknown>;
          if (typeof c['runId'] !== 'string') continue;
          if (c['status'] === 'completed') continue;
          candidates.push({ runId: c['runId'] as string, startedAt: String(c['startedAt'] ?? '') });
        } catch { continue; }
      }
      if (candidates.length === 0) return ok(null);
      candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      if (candidates.length > 1) {
        process.stderr.write(
          `[WARN coordinator] ${candidates.length} in-progress pipeline runs found -- resuming newest (${candidates[0]!.runId}). ` +
          `Others: ${candidates.slice(1).map(c => c.runId).join(', ')}. To reset, delete the stale context files from ${runsDir}.\n`,
        );
      }
      return ok(candidates[0]!.runId);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok(null);
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[WARN coordinator] readActiveRunId failed -- crash recovery skipped: ${msg}\n`);
      return err(`readActiveRunId failed: ${msg}`);
    }
  }

  async markPipelineRunComplete(workspace: string, runId: string) {
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
  }

  async readPipelineContext(workspace: string, runId: string) {
    const runsDir = path.join(workspace, '.workrail', 'pipeline-runs');
    const filePath = path.join(runsDir, `${runId}-context.json`);
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return parsePipelineRunContext(parsed);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok(null);
      return err(`readPipelineContext failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async createPipelineContext(
    workspace: string,
    runId: string,
    goal: string,
    pipelineMode: import('../coordinators/pipeline-run-context.js').PipelineRunContext['pipelineMode'],
    worktreePath: string,
  ) {
    const runsDir = path.join(workspace, '.workrail', 'pipeline-runs');
    const filePath = path.join(runsDir, `${runId}-context.json`);
    const tmpPath = filePath + '.tmp';
    try {
      await fs.promises.mkdir(runsDir, { recursive: true });
      const initial = { runId, goal, workspace, startedAt: new Date().toISOString(), pipelineMode, worktreePath, phases: {} };
      await fs.promises.writeFile(tmpPath, JSON.stringify(initial, null, 2) + '\n', 'utf-8');
      await fs.promises.rename(tmpPath, filePath);
      return ok(undefined);
    } catch (e) {
      try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
      return err(`createPipelineContext failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async writePhaseRecord(
    workspace: string,
    runId: string,
    entry: import('../coordinators/pipeline-run-context.js').PhaseRecord,
  ) {
    const runsDir = path.join(workspace, '.workrail', 'pipeline-runs');
    const filePath = path.join(runsDir, `${runId}-context.json`);
    const tmpPath = filePath + '.tmp';
    try {
      await fs.promises.mkdir(runsDir, { recursive: true });
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const existing = parsePipelineRunContext(parsed);
      if (existing.isErr() || existing.value === null) {
        return err(`writePhaseRecord: context file missing or invalid for runId=${runId}`);
      }
      const updated = { ...existing.value, phases: { ...existing.value.phases, [entry.phase]: entry.record } };
      await fs.promises.writeFile(tmpPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
      await fs.promises.rename(tmpPath, filePath);
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
      return err(`writePhaseRecord failed: ${msg}`);
    }
  }

  async execDelivery(file: string, args: string[], options: { cwd: string; timeout: number }) {
    const result = await this.execFileAsync(file, args, options);
    return { stdout: result.stdout, stderr: '' };
  }

  async createPipelineWorktree(workspace: string, runId: string, baseBranch = 'main') {
    const worktreePath = path.join(os.homedir(), '.workrail', 'worktrees', runId);
    const branchName = `worktrain/${runId}`;
    try {
      await fs.promises.mkdir(path.join(os.homedir(), '.workrail', 'worktrees'), { recursive: true });
      await this.execFileAsync('git', ['-C', workspace, 'fetch', 'origin', baseBranch], {});
      await this.execFileAsync('git', ['-C', workspace, 'worktree', 'add', worktreePath, '-b', branchName, `origin/${baseBranch}`], {});
      return ok(worktreePath);
    } catch (e) {
      return err(`createPipelineWorktree failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async removePipelineWorktree(workspace: string, worktreePath: string) {
    try {
      await this.execFileAsync('git', ['-C', workspace, 'worktree', 'remove', '--force', worktreePath], {});
    } catch (e) {
      process.stderr.write(`[WARN coordinator] removePipelineWorktree failed for ${worktreePath}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function: preserves existing call sites unchanged
// ---------------------------------------------------------------------------

export function createCoordinatorDeps(deps: CoordinatorDepsDependencies): AdaptiveCoordinatorDeps {
  const v2 = deps.ctx.v2;
  if (!v2) {
    throw new Error('createCoordinatorDeps: ctx.v2 is required');
  }
  const reader = new SessionReader(v2.sessionStore, v2.snapshotStore);
  return new CoordinatorDepsImpl(reader, deps.ctx, deps.execFileAsync, deps.dispatch);
}
