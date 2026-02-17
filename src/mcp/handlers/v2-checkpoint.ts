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
import { mapTokenDecodeErrorToToolError, mapTokenVerifyErrorToToolError, type ToolFailure } from './v2-execution-helpers.js';
import type { SessionId, NodeId, RunId, AttemptId } from '../../v2/durable-core/ids/index.js';
import { asSessionId, asRunId, asNodeId, asAttemptId } from '../../v2/durable-core/ids/index.js';
import type { ExecutionSessionGateErrorV2 } from '../../v2/usecases/execution-session-gate.js';
import type { SessionEventLogStoreError } from '../../v2/ports/session-event-log-store.port.js';
import { deriveWorkflowHashRef } from '../../v2/durable-core/ids/workflow-hash-ref.js';
import type { DomainEventV1 } from '../../v2/durable-core/schemas/session/index.js';
import type { WorkflowHash } from '../../v2/durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

type CheckpointError =
  | { readonly kind: 'precondition_failed'; readonly message: string; readonly suggestion?: string }
  | { readonly kind: 'token_signing_failed'; readonly cause: unknown }
  | { readonly kind: 'validation_failed'; readonly failure: ToolFailure }
  | { readonly kind: 'missing_node_or_run' }
  | { readonly kind: 'gate_failed'; readonly cause: ExecutionSessionGateErrorV2 }
  | { readonly kind: 'store_failed'; readonly cause: SessionEventLogStoreError };

function neErrorAsync<T>(e: CheckpointError): RA<T, CheckpointError> {
  return errAsync(e);
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
): RA<z.infer<typeof V2CheckpointWorkflowOutputSchema>, CheckpointError> {
  if (!ctx.v2) {
    return neErrorAsync({ kind: 'precondition_failed', message: 'v2 tools disabled', suggestion: 'Enable v2Tools flag' });
  }

  const { gate, sessionStore, tokenCodecPorts, idFactory } = ctx.v2;
  if (!tokenCodecPorts) {
    return neErrorAsync({ kind: 'precondition_failed', message: 'v2 context missing tokenCodecPorts', suggestion: 'Reinitialize v2 tool context.' });
  }
  if (!idFactory) {
    return neErrorAsync({ kind: 'precondition_failed', message: 'v2 context missing idFactory', suggestion: 'Reinitialize v2 tool context.' });
  }

  // Parse and verify checkpoint token
  const tokenRes = parseCheckpointTokenOrFail(input.checkpointToken, tokenCodecPorts);
  if (!tokenRes.ok) {
    return neErrorAsync({ kind: 'validation_failed', failure: tokenRes.failure });
  }

  const token = tokenRes.token;
  const sessionId = asSessionId(String(token.payload.sessionId));
  const runId = asRunId(String(token.payload.runId));
  const nodeId = asNodeId(String(token.payload.nodeId));
  const attemptId = asAttemptId(String(token.payload.attemptId));

  // Idempotency dedupeKey: unique per checkpoint token
  const dedupeKey = `checkpoint:${String(sessionId)}:${String(runId)}:${String(nodeId)}:${String(attemptId)}`;

  // Acquire session lock + health gate
  return gate.withHealthySessionLock(sessionId, (lock) => {
    return sessionStore.load(sessionId)
      .mapErr((cause): CheckpointError => ({ kind: 'store_failed', cause }))
      .andThen((truth) => {
        // Verify the node exists in durable truth
        const hasNode = truth.events.some(
          (e) => e.kind === 'node_created' && e.scope?.runId === String(runId) && e.scope?.nodeId === String(nodeId),
        );
        if (!hasNode) {
          return neErrorAsync<z.infer<typeof V2CheckpointWorkflowOutputSchema>>({ kind: 'missing_node_or_run' });
        }

        // Check if this checkpoint was already recorded (idempotency)
        const alreadyRecorded = truth.events.some(
          (e) => e.dedupeKey === dedupeKey,
        );

        if (alreadyRecorded) {
          // Idempotent replay: find existing checkpoint node and return its ID
          const existingCheckpointNode = truth.events.find(
            (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
              e.kind === 'node_created' && e.dedupeKey === `checkpoint_node:${dedupeKey}`,
          );
          const checkpointNodeId = existingCheckpointNode
            ? String(existingCheckpointNode.scope?.nodeId ?? 'unknown')
            : 'unknown';

          // Re-mint stateToken pointing at the ORIGINAL node (checkpoint does not advance).
          const originalNode = truth.events.find(
            (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
              e.kind === 'node_created' && e.scope?.nodeId === String(nodeId),
          );
          if (!originalNode) {
            return neErrorAsync<z.infer<typeof V2CheckpointWorkflowOutputSchema>>({
              kind: 'precondition_failed',
              message: 'Cannot find original node for re-minting stateToken.',
            });
          }
          const wfRefRes = deriveWorkflowHashRef(originalNode.data.workflowHash);

          if (wfRefRes.isErr()) {
            return neErrorAsync<z.infer<typeof V2CheckpointWorkflowOutputSchema>>({
              kind: 'precondition_failed',
              message: 'Cannot derive workflowHashRef for re-minting stateToken.',
            });
          }

          const stateTokenRes = signTokenOrErr({
            payload: { tokenVersion: 1, tokenKind: 'state', sessionId, runId, nodeId, workflowHashRef: wfRefRes.value },
            ports: tokenCodecPorts,
          });
          if (stateTokenRes.isErr()) {
            return neErrorAsync<z.infer<typeof V2CheckpointWorkflowOutputSchema>>({ kind: 'token_signing_failed', cause: stateTokenRes.error });
          }

          return okAsync(V2CheckpointWorkflowOutputSchema.parse({
            checkpointNodeId,
            stateToken: stateTokenRes.value,
          }));
        }

        // Create checkpoint node + edge
        const checkpointNodeId = idFactory.mintNodeId();
        const originalNode = truth.events.find(
          (e): e is Extract<DomainEventV1, { kind: 'node_created' }> =>
            e.kind === 'node_created' && e.scope?.nodeId === String(nodeId),
        );
        if (!originalNode) {
          return neErrorAsync<z.infer<typeof V2CheckpointWorkflowOutputSchema>>({ kind: 'missing_node_or_run' });
        }

        // Mint event IDs upfront so edge_created can reference node_created's eventId
        const nodeCreatedEventId = idFactory.mintEventId();
        const edgeCreatedEventId = idFactory.mintEventId();

        const newEvents = [
          {
            v: 1,
            eventId: nodeCreatedEventId,
            eventIndex: truth.events.length,
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

        return sessionStore.append(lock, { events: newEvents as unknown as readonly DomainEventV1[], snapshotPins: [] })
          .mapErr((cause): CheckpointError => ({ kind: 'store_failed', cause }))
          .andThen(() => {
            // Mint fresh stateToken pointing at the ORIGINAL node (not the checkpoint node).
            // Checkpoint marks progress but does NOT advance — the agent continues from the same step.
            // The checkpoint node exists in the DAG for observability/export but is not a resumption point.
            const wfRefRes = deriveWorkflowHashRef(originalNode.data.workflowHash);
            if (wfRefRes.isErr()) {
              return neErrorAsync<z.infer<typeof V2CheckpointWorkflowOutputSchema>>({
                kind: 'precondition_failed',
                message: 'Cannot derive workflowHashRef for stateToken.',
              });
            }

            const stateTokenRes = signTokenOrErr({
              payload: { tokenVersion: 1, tokenKind: 'state', sessionId, runId, nodeId, workflowHashRef: wfRefRes.value },
              ports: tokenCodecPorts,
            });
            if (stateTokenRes.isErr()) {
              return neErrorAsync<z.infer<typeof V2CheckpointWorkflowOutputSchema>>({ kind: 'token_signing_failed', cause: stateTokenRes.error });
            }

            return okAsync(V2CheckpointWorkflowOutputSchema.parse({
              checkpointNodeId: String(checkpointNodeId),
              stateToken: stateTokenRes.value,
            }));
          });
      });
  }).mapErr((gateErr): CheckpointError => {
    // Map gate errors to our error type
    if ('code' in gateErr) {
      return { kind: 'gate_failed', cause: gateErr as ExecutionSessionGateErrorV2 };
    }
    return gateErr as CheckpointError;
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
