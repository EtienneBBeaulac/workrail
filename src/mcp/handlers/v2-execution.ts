import * as os from 'os';
import type { ToolContext, ToolResult } from '../types.js';
import { error, success } from '../types.js';
import type { V2ContinueWorkflowInput, V2StartWorkflowInput } from '../v2/tools.js';
import { V2ContinueWorkflowOutputSchema, V2StartWorkflowOutputSchema } from '../output-schemas.js';

import { LocalDataDirV2 } from '../../v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../../v2/infra/local/hmac-sha256/index.js';
import { LocalKeyringV2 } from '../../v2/infra/local/keyring/index.js';
import { NodeSha256V2 } from '../../v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../v2/infra/local/session-store/index.js';
import { NodeCryptoV2 } from '../../v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../../v2/infra/local/snapshot-store/index.js';
import { deriveIsComplete, derivePendingStep } from '../../v2/durable-core/projections/snapshot-state.js';
import {
  assertTokenScopeMatchesState,
  parseTokenV1,
  verifyTokenSignatureV1,
  type ParsedTokenV1,
} from '../../v2/durable-core/tokens/index.js';
import { createWorkflow, getStepById } from '../../types/workflow.js';
import type { DomainEventV1 } from '../../v2/durable-core/schemas/session/index.js';
import { LocalSessionLockV2 } from '../../v2/infra/local/session-lock/index.js';
import { ExecutionSessionGateV2 } from '../../v2/usecases/execution-session-gate.js';
import { ResultAsync as RA, okAsync } from 'neverthrow';
import { compileV1WorkflowToPinnedSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { workflowHashForCompiledSnapshot } from '../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';
import { LocalPinnedWorkflowStoreV2 } from '../../v2/infra/local/pinned-workflow-store/index.js';
import { encodeTokenPayloadV1, signTokenV1 } from '../../v2/durable-core/tokens/index.js';
import { randomUUID } from 'crypto';
import { createBundledSource } from '../../types/workflow-source.js';
import type { WorkflowDefinition } from '../../types/workflow-definition.js';
import { hasWorkflowDefinitionShape } from '../../types/workflow-definition.js';
import { WorkflowCompiler } from '../../application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../application/services/workflow-interpreter.js';
import type { ExecutionState } from '../../domain/execution/state.js';
import type { WorkflowEvent } from '../../domain/execution/event.js';

/**
 * v2 Slice 3: token orchestration (`start_workflow` / `continue_workflow`).
 *
 * Locks (see `docs/design/v2-core-design-locks.md`):
 * - Token validation errors use the closed `TOKEN_*` set.
 * - Rehydrate is side-effect-free.
 * - Advance is idempotent and append-capable only under a witness.
 * - Replay is fact-returning (no recompute) and fail-closed on missing recorded facts.
 */

function normalizeTokenErrorMessage(message: string): string {
  // Keep errors deterministic and compact; avoid leaking environment-specific file paths.
  // NOTE: avoid String.prototype.replaceAll to keep compatibility with older TS lib targets.
  return message.split(os.homedir()).join('~');
}

function tokenDecodeErrorToToolError(e: { readonly code: string; readonly message: string }): ToolResult<never> {
  switch (e.code) {
    case 'TOKEN_INVALID_FORMAT':
      return error(
        'TOKEN_INVALID_FORMAT',
        normalizeTokenErrorMessage(e.message),
        'Use the exact tokens returned by WorkRail. Tokens are opaque; do not edit or construct them.'
      );
    case 'TOKEN_UNSUPPORTED_VERSION':
      return error(
        'TOKEN_UNSUPPORTED_VERSION',
        normalizeTokenErrorMessage(e.message),
        'Update WorkRail to a version that supports this token format.'
      );
    case 'TOKEN_BAD_SIGNATURE':
      return error(
        'TOKEN_BAD_SIGNATURE',
        normalizeTokenErrorMessage(e.message),
        'Token signature verification failed. Use the exact tokens returned by WorkRail.'
      );
    case 'TOKEN_SCOPE_MISMATCH':
      return error(
        'TOKEN_SCOPE_MISMATCH',
        normalizeTokenErrorMessage(e.message),
        'Tokens must come from the same WorkRail response. Do not mix tokens from different runs or nodes.'
      );
    default:
      return error('TOKEN_INVALID_FORMAT', normalizeTokenErrorMessage(e.message), 'Use the exact tokens returned by WorkRail.');
  }
}

async function loadKeyringOrThrow(): Promise<import('../../v2/ports/keyring.port.js').KeyringV1> {
  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort);

  return await keyringPort.loadOrCreate().match(
    (v) => v,
    (e) => {
      throw new Error(`KEYRING:${e.code}:${e.message}`);
    }
  );
}

function parseAndVerifyOrReturn(
  raw: string,
  keyring: import('../../v2/ports/keyring.port.js').KeyringV1
): { ok: true; token: ParsedTokenV1 } | { ok: false; result: ToolResult<never> } {
  const parsedRes = parseTokenV1(raw);
  if (parsedRes.isErr()) {
    return {
      ok: false,
      result: tokenDecodeErrorToToolError(parsedRes.error),
    };
  }

  const hmac = new NodeHmacSha256V2();
  const verified = verifyTokenSignatureV1(parsedRes.value, keyring, hmac);
  if (verified.isErr()) {
    return {
      ok: false,
      result: tokenDecodeErrorToToolError(verified.error),
    };
  }

  return { ok: true, token: parsedRes.value };
}

function newAttemptId(): string {
  return `attempt_${randomUUID()}`;
}

function attemptIdForNextNode(parentAttemptId: string): string {
  // Deterministic derivation so replay responses can re-mint the same next-node ack/checkpoint tokens.
  return `next_${parentAttemptId}`;
}

function signTokenOrThrow(args: {
  unsignedPrefix: 'st.v1.' | 'ack.v1.' | 'chk.v1.';
  payload: unknown;
  keyring: import('../../v2/ports/keyring.port.js').KeyringV1;
}): string {
  const bytes = encodeTokenPayloadV1(args.payload as any);
  if (bytes.isErr()) throw new Error(`TOKEN_PAYLOAD:${bytes.error.code}:${bytes.error.message}`);
  const hmac = new NodeHmacSha256V2();
  const token = signTokenV1(args.unsignedPrefix, bytes.value as any, args.keyring, hmac);
  if (token.isErr()) throw new Error(`TOKEN_SIGN:${token.error.code}:${token.error.message}`);
  return String(token.value);
}

function toV1ExecutionState(engineState: any): ExecutionState {
  if (engineState.kind === 'init') return { kind: 'init' };
  if (engineState.kind === 'complete') return { kind: 'complete' };
  const pendingStep =
    engineState.pending?.kind === 'some'
      ? { stepId: String(engineState.pending.step.stepId), loopPath: engineState.pending.step.loopPath.map((f: any) => ({ loopId: String(f.loopId), iteration: f.iteration })) }
      : undefined;
  return {
    kind: 'running',
    completed: [...engineState.completed.values.map(String)],
    loopStack: engineState.loopStack.map((f: any) => ({ loopId: String(f.loopId), iteration: f.iteration, bodyIndex: f.bodyIndex })),
    pendingStep,
  };
}

function fromV1ExecutionState(state: ExecutionState): any {
  if (state.kind === 'init') return { kind: 'init' };
  if (state.kind === 'complete') return { kind: 'complete' };
  const completed = [...state.completed].map(String).sort((a, b) => a.localeCompare(b));
  return {
    kind: 'running',
    completed: { kind: 'set', values: completed },
    loopStack: state.loopStack.map((f) => ({ loopId: f.loopId, iteration: f.iteration, bodyIndex: f.bodyIndex })),
    pending:
      state.pendingStep
        ? { kind: 'some', step: { stepId: state.pendingStep.stepId, loopPath: state.pendingStep.loopPath.map((p) => ({ loopId: p.loopId, iteration: p.iteration })) } }
        : { kind: 'none' },
  };
}

export async function handleV2StartWorkflow(
  input: V2StartWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  try {
    const workflow = await ctx.workflowService.getWorkflowById(input.workflowId);
    if (!workflow) {
      return error('NOT_FOUND', `Workflow not found: ${input.workflowId}`, 'Use list_workflows to discover available workflows.');
    }

    const firstStep = workflow.definition.steps[0];
    if (!firstStep) {
      return error('PRECONDITION_FAILED', 'Workflow has no steps and cannot be started.', 'Fix the workflow definition (must contain at least one step).');
    }

    const dataDir = new LocalDataDirV2(process.env);
    const fsPort = new NodeFileSystemV2();
    const sha256 = new NodeSha256V2();
    const crypto = new NodeCryptoV2();
    const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
    const lockPort = new LocalSessionLockV2(dataDir, fsPort);
    const gate = new ExecutionSessionGateV2(lockPort, sessionStore);
    const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
    const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir);

    // Pin the full v1 workflow definition for determinism (until v2 authoring exists).
    const compiled = compileV1WorkflowToPinnedSnapshot(workflow);
    const workflowHashRes = workflowHashForCompiledSnapshot(compiled as unknown as JsonValue, crypto);
    if (workflowHashRes.isErr()) {
      return error('INTERNAL_ERROR', workflowHashRes.error.message);
    }
    const workflowHash = workflowHashRes.value;
    const existingPinned = await pinnedStore.get(workflowHash).match((v) => v, () => null);
    if (!existingPinned) {
      await pinnedStore.put(workflowHash, compiled).match(
        () => undefined,
        (e) => {
          throw new Error(`PINNED_WORKFLOW_STORE:${e.code}:${e.message}`);
        }
      );
    }

    // Phase 4 lock: render first pending from the pinned snapshot (not live source) to eliminate TOCTOU.
    const pinned = await pinnedStore.get(workflowHash).match(
      (v) => v,
      (e) => {
        throw new Error(`PINNED_WORKFLOW_STORE:${e.code}:${e.message}`);
      }
    );
    if (!pinned || pinned.sourceKind !== 'v1_pinned' || !hasWorkflowDefinitionShape(pinned.definition)) {
      return error('INTERNAL_ERROR', 'Failed to pin executable workflow snapshot.', 'Retry start_workflow.');
    }
    const pinnedWorkflow = createWorkflow(pinned.definition as WorkflowDefinition, createBundledSource());

    // Mint identifiers (opaque; not hashed into workflowHash).
    const sessionId = `sess_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const nodeId = `node_${randomUUID()}`;

    // Store an initial execution snapshot with the first step pending.
    const snapshot = {
      v: 1,
      kind: 'execution_snapshot' as const,
      enginePayload: {
        v: 1,
        engineState: {
          kind: 'running' as const,
          completed: { kind: 'set' as const, values: [] as string[] },
          loopStack: [] as Array<{ loopId: string; iteration: number; bodyIndex: number }>,
          pending: { kind: 'some' as const, step: { stepId: firstStep.id, loopPath: [] as Array<{ loopId: string; iteration: number }> } },
        },
      },
    };
    const snapshotRef = await snapshotStore.putExecutionSnapshotV1(snapshot as any).match(
      (v) => v,
      (e) => {
        throw new Error(`SNAPSHOT_STORE:${e.code}:${e.message}`);
      }
    );

    const evtSessionCreated = `evt_${randomUUID()}`;
    const evtRunStarted = `evt_${randomUUID()}`;
    const evtNodeCreated = `evt_${randomUUID()}`;

    // Persist durable truth under a healthy lock witness.
    await gate
      .withHealthySessionLock(sessionId as any, (lock) =>
        sessionStore.append(lock, {
          events: [
            {
              v: 1,
              eventId: evtSessionCreated,
              eventIndex: 0,
              sessionId,
              kind: 'session_created',
              dedupeKey: `session_created:${sessionId}`,
              data: {},
            },
            {
              v: 1,
              eventId: evtRunStarted,
              eventIndex: 1,
              sessionId,
              kind: 'run_started',
              dedupeKey: `run_started:${sessionId}:${runId}`,
              scope: { runId },
              data: {
                workflowId: workflow.definition.id,
                workflowHash: String(workflowHash),
                workflowSourceKind:
                  workflow.source.kind === 'bundled'
                    ? 'bundled'
                    : workflow.source.kind === 'user'
                      ? 'user'
                      : workflow.source.kind === 'project'
                        ? 'project'
                        : workflow.source.kind === 'remote'
                          ? 'remote'
                          : workflow.source.kind === 'plugin'
                            ? 'plugin'
                            : workflow.source.kind === 'git'
                              ? 'remote'
                              : 'project', // custom directory treated as project-local for v2 store schema
                workflowSourceRef:
                  workflow.source.kind === 'user' || workflow.source.kind === 'project' || workflow.source.kind === 'custom'
                    ? workflow.source.directoryPath
                    : workflow.source.kind === 'git'
                      ? `${workflow.source.repositoryUrl}#${workflow.source.branch}`
                      : workflow.source.kind === 'remote'
                        ? workflow.source.registryUrl
                        : workflow.source.kind === 'plugin'
                          ? `${workflow.source.pluginName}@${workflow.source.pluginVersion}`
                          : '(bundled)',
              },
            },
            {
              v: 1,
              eventId: evtNodeCreated,
              eventIndex: 2,
              sessionId,
              kind: 'node_created',
              dedupeKey: `node_created:${sessionId}:${runId}:${nodeId}`,
              scope: { runId, nodeId },
              data: {
                nodeKind: 'step',
                parentNodeId: null,
                workflowHash: String(workflowHash),
                snapshotRef,
              },
            },
          ] as any,
          snapshotPins: [{ snapshotRef, eventIndex: 2, createdByEventId: evtNodeCreated }],
        })
      )
      .match(
        () => undefined,
        (e) => {
          throw new Error(`SESSION_APPEND:${String((e as any).code ?? e)}`);
        }
      );

    const keyring = await loadKeyringOrThrow();

    const statePayload = {
      tokenVersion: 1,
      tokenKind: 'state' as const,
      sessionId,
      runId,
      nodeId,
      workflowHash: String(workflowHash),
    };
    const attemptId = newAttemptId();
    const ackPayload = {
      tokenVersion: 1,
      tokenKind: 'ack' as const,
      sessionId,
      runId,
      nodeId,
      attemptId,
    };
    const checkpointPayload = {
      tokenVersion: 1,
      tokenKind: 'checkpoint' as const,
      sessionId,
      runId,
      nodeId,
      attemptId,
    };

    const stateToken = signTokenOrThrow({ unsignedPrefix: 'st.v1.', payload: statePayload, keyring });
    const ackToken = signTokenOrThrow({ unsignedPrefix: 'ack.v1.', payload: ackPayload, keyring });
    const checkpointToken = signTokenOrThrow({ unsignedPrefix: 'chk.v1.', payload: checkpointPayload, keyring });

    // Render first pending from pinned snapshot (Phase 4 lock).
    const step = getStepById(pinnedWorkflow, firstStep.id);
    const title = step && 'title' in step && typeof (step as any).title === 'string' ? String((step as any).title) : firstStep.id;
    const prompt =
      step && 'prompt' in step && typeof (step as any).prompt === 'string'
        ? String((step as any).prompt)
        : `Pending step: ${firstStep.id}`;
    const pending = { stepId: firstStep.id, title, prompt };

    const payload = V2StartWorkflowOutputSchema.parse({
      stateToken,
      ackToken,
      checkpointToken,
      isComplete: false,
      pending,
    });
    return success(payload);
  } catch (e) {
    return error(
      'INTERNAL_ERROR',
      normalizeTokenErrorMessage(e instanceof Error ? e.message : String(e)),
      'Retry; if this persists, delete the WorkRail v2 data directory for this repo and retry.'
    );
  }
}

export async function handleV2ContinueWorkflow(
  input: V2ContinueWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  // Slice 3.2: validate tokens and scope at the boundary even before orchestration exists.
  // This prevents agents from "training" on incorrect payload shapes and catches copy/paste corruption early.
  try {
    const keyring = await loadKeyringOrThrow();

    const state = parseAndVerifyOrReturn(input.stateToken, keyring);
    if (!state.ok) return state.result;
    if (state.token.payload.tokenKind !== 'state') {
      return error('TOKEN_INVALID_FORMAT', 'Expected a state token (st.v1.*).', 'Use the stateToken returned by WorkRail.');
    }

    if (!input.ackToken) {
      // Slice 3.3: rehydrate-only path (must be side-effect-free).
      const dataDir = new LocalDataDirV2(process.env);
      const fsPort = new NodeFileSystemV2();
      const sha256 = new NodeSha256V2();
      const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
      const crypto = new NodeCryptoV2();
      const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
      const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir);

      const sessionId = state.token.payload.sessionId;
      const runId = state.token.payload.runId;
      const nodeId = state.token.payload.nodeId;
      const workflowHash = state.token.payload.workflowHash;

      const truth = await sessionStore.load(sessionId).match(
        (v) => v,
        (e) => {
          throw new Error(`SESSION_STORE:${e.code}:${e.message}`);
        }
      );

      const runStarted = truth.events.find(
        (e): e is Extract<DomainEventV1, { kind: 'run_started' }> => e.kind === 'run_started' && e.scope.runId === String(runId)
      );
      const workflowId = runStarted?.data.workflowId;
      if (!runStarted || typeof workflowId !== 'string' || workflowId.trim() === '') {
        return error(
          'TOKEN_UNKNOWN_NODE',
          'No durable run state was found for this stateToken (missing run_started).',
          'Use start_workflow to mint a new run, or use a stateToken returned by WorkRail for an existing run.'
        );
      }
      if (String(runStarted.data.workflowHash) !== String(workflowHash)) {
        return error(
          'TOKEN_WORKFLOW_HASH_MISMATCH',
          'workflowHash mismatch for this run.',
          'Use the stateToken returned by WorkRail for this run.'
        );
      }

      const nodeCreated = truth.events.find(
        (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
          e.kind === 'node_created' && e.scope.nodeId === String(nodeId) && e.scope.runId === String(runId)
      );
      if (!nodeCreated) {
        return error(
          'TOKEN_UNKNOWN_NODE',
          'No durable node state was found for this stateToken (missing node_created).',
          'Use a stateToken returned by WorkRail for an existing node.'
        );
      }
      if (String(nodeCreated.data.workflowHash) !== String(workflowHash)) {
        return error(
          'TOKEN_WORKFLOW_HASH_MISMATCH',
          'workflowHash mismatch for this node.',
          'Use the stateToken returned by WorkRail for this node.'
        );
      }

      const snapshotRef = nodeCreated.data.snapshotRef;
      const snapshot = await snapshotStore.getExecutionSnapshotV1(snapshotRef).match(
        (v) => v,
        (e) => {
          throw new Error(`SNAPSHOT_STORE:${e.code}:${e.message}`);
        }
      );
      if (!snapshot) {
        return error(
          'TOKEN_UNKNOWN_NODE',
          'No execution snapshot was found for this node.',
          'Use a stateToken returned by WorkRail for an existing node.'
        );
      }

      const engineState = snapshot.enginePayload.engineState;
      const pending = derivePendingStep(engineState);
      const isComplete = deriveIsComplete(engineState);

      const attemptId = newAttemptId();
      const ackToken = signTokenOrThrow({
        unsignedPrefix: 'ack.v1.',
        payload: { tokenVersion: 1, tokenKind: 'ack', sessionId, runId, nodeId, attemptId },
        keyring,
      });
      const checkpointToken = signTokenOrThrow({
        unsignedPrefix: 'chk.v1.',
        payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId, attemptId },
        keyring,
      });

      if (!pending) {
        const payload = V2ContinueWorkflowOutputSchema.parse({
          kind: 'ok',
          stateToken: input.stateToken,
          ackToken,
          checkpointToken,
          isComplete,
          pending: null,
        });
        return success(payload);
      }

      const pinned = await pinnedStore.get(workflowHash).match(
        (v) => v,
        (e) => {
          throw new Error(`PINNED_WORKFLOW_STORE:${e.code}:${e.message}`);
        }
      );
      if (!pinned) {
        return error('PRECONDITION_FAILED', 'Pinned workflow snapshot is missing for this run.', 'Re-run start_workflow or re-pin the workflow via inspect_workflow.');
      }
      if (pinned.sourceKind !== 'v1_pinned') {
        return error('PRECONDITION_FAILED', 'Pinned workflow snapshot is read-only (v1_preview) and cannot be executed.', 'Re-run start_workflow to pin an executable snapshot.');
      }
      if (!hasWorkflowDefinitionShape(pinned.definition)) {
        return error('INTERNAL_ERROR', 'Pinned workflow snapshot has an invalid workflow definition shape.', 'Re-pin the workflow.');
      }
      const wf = createWorkflow(pinned.definition as WorkflowDefinition, createBundledSource());

      const stepId = String(pending.stepId);
      const step = getStepById(wf, stepId);
      const title = step && 'title' in step && typeof (step as any).title === 'string' ? String((step as any).title) : stepId;
      const prompt = step && 'prompt' in step && typeof (step as any).prompt === 'string' ? String((step as any).prompt) : `Pending step: ${stepId}`;

      const payload = V2ContinueWorkflowOutputSchema.parse({
        kind: 'ok',
        stateToken: input.stateToken,
        ackToken,
        checkpointToken,
        isComplete,
        pending: {
          stepId,
          title,
          prompt,
        },
      });
      return success(payload);
    }

    // Ack-token path: Slice 3.4 (advance/replay): record an idempotent, fact-returning blocked outcome for now.
    // This is the minimal durable "advance_recorded" path that enables replay semantics without requiring full step selection yet.
    {
      const ack = parseAndVerifyOrReturn(input.ackToken, keyring);
      if (!ack.ok) return ack.result;
      if (ack.token.payload.tokenKind !== 'ack') {
        return error('TOKEN_INVALID_FORMAT', 'Expected an ack token (ack.v1.*).', 'Use the ackToken returned by WorkRail.');
      }

      const scope = assertTokenScopeMatchesState(state.token, ack.token);
      if (scope.isErr()) {
        return tokenDecodeErrorToToolError(scope.error);
      }

      const dataDir = new LocalDataDirV2(process.env);
      const fsPort = new NodeFileSystemV2();
      const sha256 = new NodeSha256V2();
      const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
      const lockPort = new LocalSessionLockV2(dataDir, fsPort);
      const gate = new ExecutionSessionGateV2(lockPort, sessionStore);

      const sessionId = state.token.payload.sessionId;
      const runId = state.token.payload.runId;
      const nodeId = state.token.payload.nodeId;
      const attemptId = ack.token.payload.attemptId;
      const workflowHash = state.token.payload.workflowHash;

      const dedupeKey = `advance_recorded:${sessionId}:${nodeId}:${attemptId}`;

      const compiled = await new LocalPinnedWorkflowStoreV2(new LocalDataDirV2(process.env)).get(workflowHash).match((v) => v, () => null);
      if (!compiled) {
        return error('PRECONDITION_FAILED', 'Pinned workflow snapshot is missing for this run.', 'Re-run start_workflow or re-pin via inspect_workflow.');
      }
      if (compiled.sourceKind !== 'v1_pinned') {
        return error('PRECONDITION_FAILED', 'Pinned workflow snapshot is read-only (v1_preview) and cannot be executed.', 'Re-run start_workflow to pin an executable snapshot.');
      }
      if (!hasWorkflowDefinitionShape(compiled.definition)) {
        return error('INTERNAL_ERROR', 'Pinned workflow snapshot has invalid definition shape.', 'Re-pin the workflow via start_workflow.');
      }

      const pinnedWorkflow = createWorkflow(compiled.definition as WorkflowDefinition, createBundledSource());
      const compiler = new WorkflowCompiler();
      const interpreter = new WorkflowInterpreter();
      const compiledWf = compiler.compile(pinnedWorkflow);
      if (compiledWf.isErr()) {
        return error('INTERNAL_ERROR', compiledWf.error.message);
      }

      const snapshotStore = new LocalSnapshotStoreV2(new LocalDataDirV2(process.env), new NodeFileSystemV2(), new NodeCryptoV2());

      const appendRes = await gate
        .withHealthySessionLock(sessionId, (lock) => {
          // NOTE: do all reads and "already recorded?" checks under the lock to keep behavior deterministic.
          return sessionStore.load(sessionId).andThen((truth) => {
            // Enforce invariants: do not record advance attempts for unknown nodes.
            const hasRun = truth.events.some((e) => e.kind === 'run_started' && e.scope?.runId === String(runId));
            const hasNode = truth.events.some(
              (e) => e.kind === 'node_created' && e.scope?.runId === String(runId) && e.scope?.nodeId === String(nodeId)
            );
            if (!hasRun || !hasNode) {
              // No append: treat as precondition failure.
              return RA.fromPromise(
                Promise.reject(new Error('MISSING_NODE_OR_RUN')),
                (e) => e as unknown
              );
            }

            const existing = truth.events.find((e) => e.kind === 'advance_recorded' && e.dedupeKey === dedupeKey);
            if (existing) {
              // Idempotent replay: store.append would no-op too, but we can short-circuit.
              return okAsync(undefined);
            }

            // Load current node snapshot to compute next state.
            const nodeCreated = truth.events.find((e) => e.kind === 'node_created' && e.scope?.nodeId === String(nodeId));
            if (!nodeCreated || nodeCreated.kind !== 'node_created') {
              return RA.fromPromise(Promise.reject(new Error('MISSING_NODE_OR_RUN')), (e) => e as unknown);
            }
            if (String((nodeCreated as any).data.workflowHash) !== String(workflowHash)) {
              return RA.fromPromise(Promise.reject(new Error('WORKFLOW_HASH_MISMATCH')), (e) => e as unknown);
            }

            // Snapshot load is outside the append plan, but still within the lock to keep behavior coherent.
            return snapshotStore.getExecutionSnapshotV1((nodeCreated as any).data.snapshotRef).andThen((snap) => {
              if (!snap) return RA.fromPromise(Promise.reject(new Error('MISSING_SNAPSHOT')), (e) => e as unknown);
              const currentState = toV1ExecutionState(snap.enginePayload.engineState);
              const pendingStep = (currentState.kind === 'running' && currentState.pendingStep) ? currentState.pendingStep : null;
              if (!pendingStep) {
                return RA.fromPromise(Promise.reject(new Error('NO_PENDING_STEP')), (e) => e as unknown);
              }
              const event: WorkflowEvent = { kind: 'step_completed', stepInstanceId: pendingStep };
              const advanced = interpreter.applyEvent(currentState, event);
              if (advanced.isErr()) {
                return RA.fromPromise(Promise.reject(new Error(`ADVANCE_APPLY:${advanced.error.message}`)), (e) => e as unknown);
              }
              const nextRes = interpreter.next(compiledWf.value, advanced.value, input.context ?? {});
              if (nextRes.isErr()) {
                return RA.fromPromise(Promise.reject(new Error(`ADVANCE_NEXT:${nextRes.error.message}`)), (e) => e as unknown);
              }

              const out = nextRes.value;
              const newEngineState = fromV1ExecutionState(out.state);
              const snapshotFile = {
                v: 1,
                kind: 'execution_snapshot' as const,
                enginePayload: { v: 1, engineState: newEngineState },
              };

              return snapshotStore.putExecutionSnapshotV1(snapshotFile as any).andThen((newSnapshotRef) => {
                const toNodeId = `node_${randomUUID()}`;
                const nextEventIndex = truth.events.length === 0 ? 0 : truth.events[truth.events.length - 1]!.eventIndex + 1;

                const evtAdvanceRecorded = `evt_${randomUUID()}`;
                const evtNodeCreated = `evt_${randomUUID()}`;
                const evtEdgeCreated = `evt_${randomUUID()}`;

                const hasChildren = truth.events.some((e) => e.kind === 'edge_created' && (e as any).data.fromNodeId === String(nodeId));
                const causeKind = hasChildren ? 'non_tip_advance' : 'intentional_fork';

                const events: any[] = [
                  {
                    v: 1,
                    eventId: evtAdvanceRecorded,
                    eventIndex: nextEventIndex,
                    sessionId,
                    kind: 'advance_recorded',
                    dedupeKey,
                    scope: { runId, nodeId },
                    data: {
                      attemptId,
                      intent: 'ack_pending',
                      outcome: { kind: 'advanced', toNodeId },
                    },
                  },
                  {
                    v: 1,
                    eventId: evtNodeCreated,
                    eventIndex: nextEventIndex + 1,
                    sessionId,
                    kind: 'node_created',
                    dedupeKey: `node_created:${sessionId}:${runId}:${toNodeId}`,
                    scope: { runId, nodeId: toNodeId },
                    data: { nodeKind: 'step', parentNodeId: String(nodeId), workflowHash: String(workflowHash), snapshotRef: newSnapshotRef },
                  },
                  {
                    v: 1,
                    eventId: evtEdgeCreated,
                    eventIndex: nextEventIndex + 2,
                    sessionId,
                    kind: 'edge_created',
                    dedupeKey: `edge_created:${sessionId}:${runId}:${String(nodeId)}->${toNodeId}:acked_step`,
                    scope: { runId },
                    data: {
                      edgeKind: 'acked_step',
                      fromNodeId: String(nodeId),
                      toNodeId,
                      cause: { kind: causeKind, eventId: evtAdvanceRecorded },
                    },
                  },
                ];

                // Output persistence (single durable write path): if input.output exists, append node_output_appended.
                // Lock: output is attached to the CURRENT node (nodeId), not the newly created node (toNodeId).
                // The agent provides output as part of completing the current step.
                if (input.output?.notesMarkdown) {
                  const outputId = `out_recap_${String(attemptId)}`;
                  const evtOutputAppended = `evt_${randomUUID()}`;
                  events.push({
                    v: 1,
                    eventId: evtOutputAppended,
                    eventIndex: nextEventIndex + 3,
                    sessionId,
                    kind: 'node_output_appended',
                    dedupeKey: `node_output_appended:${sessionId}:${outputId}`,
                    scope: { runId, nodeId }, // CORRECTED: attach to current node, not toNodeId
                    data: {
                      outputId,
                      outputChannel: 'recap',
                      payload: {
                        payloadKind: 'notes',
                        notesMarkdown: input.output.notesMarkdown.slice(0, 4096), // locked budget
                      },
                    },
                  });
                }

                return sessionStore.append(lock, {
                  events,
                  snapshotPins: [{ snapshotRef: newSnapshotRef, eventIndex: nextEventIndex + 1, createdByEventId: evtNodeCreated }],
                });
              });
            });
          });
        })
        .match(
          () => ({ ok: true as const }),
          (e) => ({ ok: false as const, error: e })
        );

      if (!appendRes.ok) {
        const msg = String(appendRes.error);
        if (msg.includes('MISSING_NODE_OR_RUN')) {
          return error(
            'PRECONDITION_FAILED',
            'No durable run/node state was found for this stateToken. Advancement cannot be recorded.',
            'Use a stateToken returned by WorkRail for an existing run/node.'
          );
        }
        if (msg.includes('WORKFLOW_HASH_MISMATCH')) {
          return error('VALIDATION_ERROR', 'workflowHash mismatch for this node.', 'Use the stateToken returned by WorkRail for this node.');
        }
        return error(
          'INTERNAL_ERROR',
          normalizeTokenErrorMessage(msg),
          'Retry; if this persists, check for another WorkRail process holding the session lock.'
        );
      }

      // Fact-returning response: load recorded outcome and return from durable facts.
      const sessionStore2 = new LocalSessionEventLogStoreV2(new LocalDataDirV2(process.env), new NodeFileSystemV2(), new NodeSha256V2());
      const truth2 = await sessionStore2.load(sessionId).match(
        (v) => v,
        (e) => {
          throw new Error(`SESSION_STORE:${e.code}:${e.message}`);
        }
      );
      const recorded = truth2.events.find((e) => e.kind === 'advance_recorded' && e.dedupeKey === dedupeKey) as any;
      if (!recorded) {
        return error('INTERNAL_ERROR', 'Missing recorded advance outcome for ack replay.', 'Retry; if this persists, treat as invariant violation.');
      }

      const checkpointToken = signTokenOrThrow({
        unsignedPrefix: 'chk.v1.',
        payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId, attemptId },
        keyring,
      });

      if (recorded.data.outcome.kind === 'blocked') {
        const snapNode = truth2.events.find(
          (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
            e.kind === 'node_created' && e.scope?.nodeId === String(nodeId)
        );
        const snap = snapNode
          ? await snapshotStore.getExecutionSnapshotV1(snapNode.data.snapshotRef).match((v) => v, () => null)
          : null;
        const pendingNow = snap ? derivePendingStep(snap.enginePayload.engineState) : null;
        const isCompleteNow = snap ? deriveIsComplete(snap.enginePayload.engineState) : false;
        const payload = V2ContinueWorkflowOutputSchema.parse({
          kind: 'blocked',
          stateToken: input.stateToken,
          ackToken: input.ackToken,
          checkpointToken,
          isComplete: isCompleteNow,
          pending: pendingNow ? { stepId: String(pendingNow.stepId), title: String(pendingNow.stepId), prompt: `Pending step: ${String(pendingNow.stepId)}` } : null,
          blockers: recorded.data.outcome.blockers,
        });
        return success(payload);
      }

      const toNodeId = recorded.data.outcome.toNodeId;
      const toNode = truth2.events.find(
        (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
          e.kind === 'node_created' && e.scope?.nodeId === String(toNodeId)
      );
      if (!toNode) {
        return error('INTERNAL_ERROR', 'Missing node_created for advanced toNodeId.', 'Treat as invariant violation.');
      }

      const snap = await snapshotStore.getExecutionSnapshotV1(toNode.data.snapshotRef).match(
        (v) => v,
        (e) => {
          throw new Error(`SNAPSHOT_STORE:${e.code}:${e.message}`);
        }
      );
      if (!snap) return error('INTERNAL_ERROR', 'Missing execution snapshot for advanced node.', 'Treat as invariant violation.');

      const pending = derivePendingStep(snap.enginePayload.engineState);
      const isComplete = deriveIsComplete(snap.enginePayload.engineState);

      const nextAttemptId = attemptIdForNextNode(String(attemptId));
      const nextAckToken = signTokenOrThrow({
        unsignedPrefix: 'ack.v1.',
        payload: { tokenVersion: 1, tokenKind: 'ack', sessionId, runId, nodeId: toNodeId, attemptId: nextAttemptId },
        keyring,
      });
      const nextCheckpointToken = signTokenOrThrow({
        unsignedPrefix: 'chk.v1.',
        payload: { tokenVersion: 1, tokenKind: 'checkpoint', sessionId, runId, nodeId: toNodeId, attemptId: nextAttemptId },
        keyring,
      });
      const nextStateToken = signTokenOrThrow({
        unsignedPrefix: 'st.v1.',
        payload: { tokenVersion: 1, tokenKind: 'state', sessionId, runId, nodeId: toNodeId, workflowHash: String(workflowHash) },
        keyring,
      });

      const stepId = pending ? String(pending.stepId) : null;
      const step = stepId ? getStepById(pinnedWorkflow, stepId) : null;
      const title = step && 'title' in step && typeof (step as any).title === 'string' ? String((step as any).title) : stepId ?? '';
      const prompt = step && 'prompt' in step && typeof (step as any).prompt === 'string' ? String((step as any).prompt) : stepId ? `Pending step: ${stepId}` : '';

      const payload = V2ContinueWorkflowOutputSchema.parse({
        kind: 'ok',
        stateToken: nextStateToken,
        ackToken: nextAckToken,
        checkpointToken: nextCheckpointToken,
        isComplete,
        pending: stepId ? { stepId, title, prompt } : null,
      });
      return success(payload);
    }
  } catch (e) {
    return error(
      'INTERNAL_ERROR',
      normalizeTokenErrorMessage(e instanceof Error ? e.message : String(e)),
      'If this persists, delete the WorkRail v2 data directory for this repo and retry.'
    );
  }

  return error('INTERNAL_ERROR', 'Unreachable', 'Internal invariant violation');
}