/**
 * v2 Checkpoint Handler
 *
 * Handles checkpoint_workflow tool calls.
 * Creates a checkpoint edge on the current node, enabling
 * agents to mark progress without advancing to the next step.
 *
 * Idempotent via dedupeKey derived from checkpointToken.
 */

import type { z } from 'zod';
import type { ResultAsync as RA } from 'neverthrow';
import { okAsync, errAsync } from 'neverthrow';
import type { ToolContext, ToolResult } from '../types.js';
import { success, errNotRetryable } from '../types.js';
import type { V2CheckpointWorkflowInput } from '../v2/tools.js';
import { V2CheckpointWorkflowOutputSchema } from '../output-schemas.js';
import { parseCheckpointTokenOrFail, signTokenOrErr } from './v2-token-ops.js';
import type { ToolFailure } from './v2-execution-helpers.js';
import type { SessionId, NodeId, RunId, AttemptId } from '../../v2/durable-core/ids/index.js';
import { asSessionId, asRunId, asNodeId, asAttemptId } from '../../v2/durable-core/ids/index.js';
import type { ExecutionSessionGateErrorV2 } from '../../v2/usecases/execution-session-gate.js';
import type { SessionEventLogStoreError } from '../../v2/ports/session-event-log-store.port.js';
import { deriveWorkflowHashRef } from '../../v2/durable-core/ids/workflow-hash-ref.js';
import { DomainEventV1Schema, type DomainEventV1 } from '../../v2/durable-core/schemas/session/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CheckpointOutput = z.infer<typeof V2CheckpointWorkflowOutputSchema>;

type CheckpointError =
  | { readonly kind: 'precondition_failed'; readonly message: string }
  | { readonly kind: 'token_signing_failed'; readonly cause: unknown }
  | { readonly kind: 'validation_failed'; readonly failure: ToolFailure }
  | { readonly kind: 'missing_node_or_run' }
  | { readonly kind: 'event_schema_invalid'; readonly issues: string }
  | { readonly kind: 'gate_failed'; readonly cause: ExecutionSessionGateErrorV2 }
  | { readonly kind: 'store_failed'; readonly cause: SessionEventLogStoreError };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Find a node_created event by nodeId. */
function findNodeCreated(
  events: readonly DomainEventV1[],
  nodeId: NodeId,
): Extract<DomainEventV1, { kind: 'node_created' }> | undefined {
  return events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
      e.kind === 'node_created' && e.scope?.nodeId === String(nodeId),
  );
}

/** Mint a stateToken for the original node (checkpoint does not advance). */
function mintStateTokenForNode(
  originalNode: Extract<DomainEventV1, { kind: 'node_created' }>,
  sessionId: SessionId,
  runId: RunId,
  nodeId: NodeId,
  tokenCodecPorts: NonNullable<NonNullable<ToolContext['v2']>['tokenCodecPorts']>,
): { ok: true; value: string } | { ok: false; error: CheckpointError } {
  const wfRefRes = deriveWorkflowHashRef(originalNode.data.workflowHash);
  if (wfRefRes.isErr()) {
    return { ok: false, error: { kind: 'precondition_failed', message: 'Cannot derive workflowHashRef for stateToken.' } };
  }

  const stateTokenRes = signTokenOrErr({
    payload: { tokenVersion: 1, tokenKind: 'state', sessionId, runId, nodeId, workflowHashRef: wfRefRes.value },
    ports: tokenCodecPorts,
  });
  if (stateTokenRes.isErr()) {
    return { ok: false, error: { kind: 'token_signing_failed', cause: stateTokenRes.error } };
  }

  return { ok: true, value: stateTokenRes.value };
}

/** Validate raw event objects against DomainEventV1Schema. Fail fast on first invalid event. */
function validateEvents(rawEvents: readonly Record<string, unknown>[]): readonly DomainEventV1[] | { issues: string } {
  const validated: DomainEventV1[] = [];
  for (const raw of rawEvents) {
    const parsed = DomainEventV1Schema.safeParse(raw);
    if (!parsed.success) {
      return { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    }
    validated.push(parsed.data);
  }
  return validated;
}

/** Type guard: ExecutionSessionGateErrorV2 always has a `code` string property. */
function isGateError(e: unknown): e is ExecutionSessionGateErrorV2 {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as Record<string, unknown>).code === 'string' && !('kind' in e);
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export async function handleV2CheckpointWorkflow(
  input: V2CheckpointWorkflowInput,
  ctx: ToolContext,
): Promise<ToolResult<unknown>> {
  return executeCheckpoint(input, ctx).match(
    (payload) => success(payload),
    (e) => mapCheckpointErrorToToolError(e),
  );
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

function executeCheckpoint(
  input: V2CheckpointWorkflowInput,
  ctx: ToolContext,
): RA<CheckpointOutput, CheckpointError> {
  if (!ctx.v2) {
    return errAsync({ kind: 'precondition_failed', message: 'v2 tools disabled' });
  }

  const { gate, sessionStore, tokenCodecPorts, idFactory } = ctx.v2;
  if (!tokenCodecPorts) {
    return errAsync({ kind: 'precondition_failed', message: 'v2 context missing tokenCodecPorts' });
  }
  if (!idFactory) {
    return errAsync({ kind: 'precondition_failed', message: 'v2 context missing idFactory' });
  }

  // Parse and verify checkpoint token
  const tokenRes = parseCheckpointTokenOrFail(input.checkpointToken, tokenCodecPorts);
  if (!tokenRes.ok) {
    return errAsync({ kind: 'validation_failed', failure: tokenRes.failure });
  }

  const token = tokenRes.token;
  const sessionId = asSessionId(String(token.payload.sessionId));
  const runId = asRunId(String(token.payload.runId));
  const nodeId = asNodeId(String(token.payload.nodeId));
  const attemptId = asAttemptId(String(token.payload.attemptId));

  // Unique per checkpoint token — guarantees idempotent replay
  const dedupeKey = `checkpoint:${String(sessionId)}:${String(runId)}:${String(nodeId)}:${String(attemptId)}`;

  return gate.withHealthySessionLock(sessionId, (lock) => {
    return sessionStore.load(sessionId)
      .mapErr((cause): CheckpointError => ({ kind: 'store_failed', cause }))
      .andThen((truth) => {
        // Verify the node referenced by the token exists
        const originalNode = findNodeCreated(truth.events, nodeId);
        if (!originalNode) {
          return errAsync<CheckpointOutput, CheckpointError>({ kind: 'missing_node_or_run' });
        }

        // Idempotent replay: if dedupeKey already exists, return cached result
        const alreadyRecorded = truth.events.some((e) => e.dedupeKey === dedupeKey);
        if (alreadyRecorded) {
          return replayCheckpoint(truth.events, dedupeKey, originalNode, sessionId, runId, nodeId, tokenCodecPorts);
        }

        // First-write path: create checkpoint node + edge
        return writeCheckpoint(
          truth, dedupeKey, originalNode, sessionId, runId, nodeId,
          idFactory.mintNodeId(), () => idFactory.mintEventId(), lock, sessionStore, tokenCodecPorts,
        );
      });
  }).mapErr((gateErr): CheckpointError => {
    if (isGateError(gateErr)) {
      return { kind: 'gate_failed', cause: gateErr };
    }
    return gateErr as CheckpointError;
  });
}

// ---------------------------------------------------------------------------
// Idempotent replay (read-only, no writes)
// ---------------------------------------------------------------------------

function replayCheckpoint(
  events: readonly DomainEventV1[],
  dedupeKey: string,
  originalNode: Extract<DomainEventV1, { kind: 'node_created' }>,
  sessionId: SessionId,
  runId: RunId,
  nodeId: NodeId,
  tokenCodecPorts: NonNullable<NonNullable<ToolContext['v2']>['tokenCodecPorts']>,
): RA<CheckpointOutput, CheckpointError> {
  const existingCheckpointNode = events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
      e.kind === 'node_created' && e.dedupeKey === `checkpoint_node:${dedupeKey}`,
  );
  const checkpointNodeId = existingCheckpointNode
    ? String(existingCheckpointNode.scope?.nodeId ?? 'unknown')
    : 'unknown';

  // Re-mint stateToken pointing at the ORIGINAL node (checkpoint does not advance)
  const tokenResult = mintStateTokenForNode(originalNode, sessionId, runId, nodeId, tokenCodecPorts);
  if (!tokenResult.ok) return errAsync(tokenResult.error);

  return okAsync(V2CheckpointWorkflowOutputSchema.parse({
    checkpointNodeId,
    stateToken: tokenResult.value,
  }));
}

// ---------------------------------------------------------------------------
// First-write path (creates events under lock)
// ---------------------------------------------------------------------------

function writeCheckpoint(
  truth: { readonly events: readonly DomainEventV1[]; readonly manifest: readonly unknown[] },
  dedupeKey: string,
  originalNode: Extract<DomainEventV1, { kind: 'node_created' }>,
  sessionId: SessionId,
  runId: RunId,
  nodeId: NodeId,
  checkpointNodeId: NodeId,
  mintEventId: () => string,
  lock: Parameters<Parameters<ExecutionSessionGateV2['withHealthySessionLock']>[1]>[0],
  sessionStore: NonNullable<ToolContext['v2']>['sessionStore'],
  tokenCodecPorts: NonNullable<NonNullable<ToolContext['v2']>['tokenCodecPorts']>,
): RA<CheckpointOutput, CheckpointError> {

  // Mint event IDs upfront so edge_created can reference node_created's eventId
  const nodeCreatedEventId = mintEventId();
  const edgeCreatedEventId = mintEventId();

  const rawEvents = [
    {
      v: 1,
      eventId: nodeCreatedEventId,
      eventIndex: truth.events.length,
      sessionId: String(sessionId),
      kind: 'node_created' as const,
      dedupeKey: `checkpoint_node:${dedupeKey}`,
      scope: { runId: String(runId), nodeId: String(checkpointNodeId) },
      data: {
        nodeKind: 'checkpoint' as const,
        parentNodeId: String(nodeId),
        workflowHash: originalNode.data.workflowHash,
        snapshotRef: originalNode.data.snapshotRef,
      },
    },
    {
      v: 1,
      eventId: edgeCreatedEventId,
      eventIndex: truth.events.length + 1,
      sessionId: String(sessionId),
      kind: 'edge_created' as const,
      dedupeKey,
      scope: { runId: String(runId) },
      data: {
        edgeKind: 'checkpoint' as const,
        fromNodeId: String(nodeId),
        toNodeId: String(checkpointNodeId),
        cause: {
          kind: 'checkpoint_created' as const,
          eventId: String(nodeCreatedEventId),
        },
      },
    },
  ];

  // Validate events against schema before appending (fail fast on schema violations)
  const validated = validateEvents(rawEvents);
  if ('issues' in validated) {
    return errAsync({ kind: 'event_schema_invalid', issues: validated.issues });
  }

  // Include snapshotPin for the checkpoint node's snapshotRef to satisfy manifest integrity.
  // The checkpoint reuses the original node's snapshot, but the manifest must attest it.
  const snapshotPins = [{
    snapshotRef: originalNode.data.snapshotRef,
    eventIndex: truth.events.length,
    createdByEventId: nodeCreatedEventId,
  }];

  return sessionStore.append(lock, { events: validated, snapshotPins })
    .mapErr((cause): CheckpointError => ({ kind: 'store_failed', cause }))
    .andThen(() => {
      // Mint stateToken pointing at the ORIGINAL node (not the checkpoint node).
      // Checkpoint marks progress but does NOT advance — the agent continues from the same step.
      const tokenResult = mintStateTokenForNode(originalNode, sessionId, runId, nodeId, tokenCodecPorts);
      if (!tokenResult.ok) return errAsync<CheckpointOutput, CheckpointError>(tokenResult.error);

      return okAsync(V2CheckpointWorkflowOutputSchema.parse({
        checkpointNodeId: String(checkpointNodeId),
        stateToken: tokenResult.value,
      }));
    });
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function mapCheckpointErrorToToolError(e: CheckpointError): ToolResult<never> {
  switch (e.kind) {
    case 'precondition_failed':
      return errNotRetryable('PRECONDITION_FAILED', e.message) as ToolResult<never>;
    case 'token_signing_failed':
      return errNotRetryable('INTERNAL_ERROR', 'Failed to sign token.') as ToolResult<never>;
    case 'validation_failed':
      return e.failure as ToolResult<never>;
    case 'missing_node_or_run':
      return errNotRetryable('TOKEN_UNKNOWN_NODE', 'No durable node state found for this checkpointToken. Use a checkpointToken returned by WorkRail.') as ToolResult<never>;
    case 'event_schema_invalid':
      return errNotRetryable('INTERNAL_ERROR', `Checkpoint events failed schema validation: ${e.issues}`) as ToolResult<never>;
    case 'gate_failed': {
      const code = e.cause.code;
      if (code === 'SESSION_LOCKED' || code === 'SESSION_LOCK_REENTRANT') {
        return errNotRetryable('TOKEN_SESSION_LOCKED', `Session is locked: ${code}`) as ToolResult<never>;
      }
      if (code === 'SESSION_NOT_HEALTHY') {
        return errNotRetryable('SESSION_NOT_HEALTHY', 'Session is not healthy.') as ToolResult<never>;
      }
      return errNotRetryable('INTERNAL_ERROR', `Session gate error: ${code}`) as ToolResult<never>;
    }
    case 'store_failed':
      return errNotRetryable('INTERNAL_ERROR', `Session store error: ${e.cause.code}`) as ToolResult<never>;
  }
}

// Re-export gate type for writeCheckpoint parameter typing
import type { ExecutionSessionGateV2 } from '../../v2/usecases/execution-session-gate.js';
