import type { Brand } from '../../../runtime/brand.js';

/**
 * Branded type: SessionId (opaque session identifier).
 *
 * Footgun prevented:
 * - Prevents mixing SessionId with RunId/NodeId or plain strings
 * - Prevents using arbitrary strings as session identifiers in APIs
 *
 * How to construct:
 * - Use `asSessionId()` after validating format at boundaries
 * - Server-/system-minted; treat as opaque
 *
 * Lock: sessions are globally unique and stable for durable truth substrates.
 *
 * Example:
 * ```typescript
 * const sessionId = asSessionId('sess_01JH8X2ABC');
 * await store.load(sessionId);
 * ```
 */
export type SessionId = Brand<string, 'v2.SessionId'>;

/**
 * Branded type: RunId (opaque run identifier).
 *
 * Footgun prevented:
 * - Prevents mixing RunId with SessionId/NodeId
 * - Keeps run references type-safe across projections and storage
 *
 * How to construct:
 * - Use `asRunId()` after validating format at boundaries
 * - Treat as opaque; do not parse semantic meaning from strings
 *
 * Example:
 * ```typescript
 * const runId = asRunId('run_01JFDXYZ');
 * ```
 */
export type RunId = Brand<string, 'v2.RunId'>;

/**
 * Branded type: NodeId (opaque node identifier).
 *
 * Footgun prevented:
 * - Prevents mixing NodeId with SessionId/RunId
 * - Prevents passing arbitrary strings as DAG node IDs
 *
 * How to construct:
 * - Use `asNodeId()` after validating format at boundaries
 *
 * Example:
 * ```typescript
 * const nodeId = asNodeId('node_01JFDN123');
 * ```
 */
export type NodeId = Brand<string, 'v2.NodeId'>;

/**
 * Branded type: AttemptId (ack attempt identifier).
 *
 * Footgun prevented:
 * - Prevents reusing attempt IDs across unrelated operations
 * - Keeps idempotency keys type-safe (advance/checkpoint)
 *
 * How to construct:
 * - Use `asAttemptId()` after validating format at boundaries
 * - Server-/system-minted; treat as opaque
 *
 * Lock: attemptId participates in dedupeKey construction for durable idempotency.
 *
 * Example:
 * ```typescript
 * const attemptId = asAttemptId('attempt_01JH8X2GHI');
 * ```
 */
export type AttemptId = Brand<string, 'v2.AttemptId'>;

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asRunId(value: string): RunId {
  return value as RunId;
}

export function asNodeId(value: string): NodeId {
  return value as NodeId;
}

export function asAttemptId(value: string): AttemptId {
  return value as AttemptId;
}
