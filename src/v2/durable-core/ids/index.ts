import type { Brand } from '../../../runtime/brand.js';

/**
 * Branded type: Sha256Digest (canonical digest string).
 *
 * Footgun prevented:
 * - Prevents plain strings being used as hashes (stringly-typed identifiers)
 * - Prevents mixing digests with unrelated string IDs
 * - Enforces canonical format expectations in APIs
 *
 * How to construct:
 * - Prefer returning this from sha256 ports/utilities (single source of truth)
 * - When accepting external input, validate against `SHA256_DIGEST_PATTERN` first, then use `asSha256Digest`
 *
 * Lock: Canonical format is `sha256:<64 lowercase hex chars>` for determinism.
 *
 * Example:
 * ```typescript
 * const digest = asSha256Digest('sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11');
 * ```
 */
export type Sha256Digest = Brand<string, 'v2.Sha256Digest'>;

/**
 * Branded type: WorkflowHash (pinned workflow identity).
 *
 * Footgun prevented:
 * - Prevents using arbitrary digests as workflow identifiers
 * - Distinguishes workflow hashes from snapshot refs at the type level
 *
 * How to construct:
 * - Compute from a compiled workflow snapshot (content-addressed)
 * - Use `asWorkflowHash(asSha256Digest(...))` only after validation or computation
 *
 * Lock: workflowHash = sha256(RFC 8785 JCS canonical bytes of CompiledWorkflowSnapshot).
 *
 * Example:
 * ```typescript
 * const hash = asWorkflowHash(asSha256Digest('sha256:...'));
 * await pinnedStore.get(hash);
 * ```
 */
export type WorkflowHash = Brand<Sha256Digest, 'v2.WorkflowHash'>;

/**
 * Branded type: WorkflowHashRef (short, deterministic reference to a workflow hash).
 *
 * Purpose:
 * - Compactly carry workflow identity through tokens without embedding the full 32-byte hash
 *
 * Format (locked intent):
 * - `wf_<base32lowernopad>` where the suffix encodes 16 bytes (128 bits) = first 16 bytes of the workflowHash digest.
 *
 * Note:
 * - This is a reference, not a replacement for the full `WorkflowHash`. Resolution must be fail-closed.
 */
export type WorkflowHashRef = Brand<string, 'v2.WorkflowHashRef'>;

/**
 * Opaque type: WorkflowId (workflow identifier).
 *
 * Note: intentionally not included in the branded-types checklist for Slice 2/3 locks.
 * Still branded to prevent accidental mixing with other string IDs.
 */
export type WorkflowId = Brand<string, 'v2.WorkflowId'>;

/**
 * Branded type: CanonicalBytes (RFC 8785 JCS canonical JSON bytes).
 *
 * Footgun prevented:
 * - Prevents hashing raw/non-canonical JSON bytes (canonicalize-before-hash discipline)
 * - Prevents passing arbitrary Uint8Array into content-addressed hashing
 *
 * How to construct:
 * - Use `toCanonicalBytes(jsonValue)` (canonicalization boundary)
 * - Treat as immutable; do not mutate the underlying bytes
 *
 * Lock: All v2 hashing inputs are RFC 8785 (JCS) canonical JSON bytes.
 *
 * Example:
 * ```typescript
 * const canonical = asCanonicalBytes(new Uint8Array());
 * ```
 */
export type CanonicalBytes = Brand<Uint8Array, 'v2.CanonicalBytes'>;

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
 * Branded type: EventId (opaque event identifier).
 *
 * Footgun prevented:
 * - Prevents using random strings as event IDs in the durable log
 * - Makes event references type-safe (vs plain string)
 *
 * How to construct:
 * - Use `asEventId()` after validating format at boundaries
 *
 * Note: EventId is not an idempotency key; use dedupeKey for that.
 *
 * Example:
 * ```typescript
 * const eventId = asEventId('evt_01JH8X2DEF');
 * ```
 */
export type EventId = Brand<string, 'v2.EventId'>;

/**
 * Branded type: EventIndex (0-based event log position).
 *
 * Footgun prevented:
 * - Prevents negative/float indices being used as ordering keys
 * - Distinguishes EventIndex from ManifestIndex at compile time
 *
 * How to construct:
 * - Use `asEventIndex(number)` only for non-negative integers
 *
 * Lock: 0-based, monotonic per session.
 *
 * Example:
 * ```typescript
 * const idx = asEventIndex(0);
 * ```
 */
export type EventIndex = Brand<number, 'v2.EventIndex'>;

/**
 * Branded type: ManifestIndex (0-based manifest stream position).
 *
 * Footgun prevented:
 * - Prevents mixing manifest record indices with event indices
 * - Keeps manifest ordering comparisons type-safe
 *
 * How to construct:
 * - Use `asManifestIndex(number)` only for non-negative integers
 *
 * Lock: 0-based, monotonic per session manifest stream.
 *
 * Example:
 * ```typescript
 * const mIdx = asManifestIndex(0);
 * ```
 */
export type ManifestIndex = Brand<number, 'v2.ManifestIndex'>;

/**
 * Branded type: SnapshotRef (content-addressed snapshot reference).
 *
 * Footgun prevented:
 * - Prevents mixing snapshot refs with workflow hashes
 * - Prevents plain strings being used as snapshot identifiers
 *
 * How to construct:
 * - Compute from a snapshot file (content-addressed)
 * - Use `asSnapshotRef(asSha256Digest(...))` only after validation or computation
 *
 * Lock: snapshotRef = sha256(RFC 8785 JCS canonical bytes of ExecutionSnapshotFileV1).
 *
 * Example:
 * ```typescript
 * const ref = asSnapshotRef(asSha256Digest('sha256:...'));
 * await snapshotStore.getExecutionSnapshotV1(ref);
 * ```
 */
export type SnapshotRef = Brand<Sha256Digest, 'v2.SnapshotRef'>;

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

/**
 * Branded type: OutputId (stable output identifier).
 *
 * Footgun prevented:
 * - Prevents passing arbitrary strings as output IDs
 * - Separates output identifiers from event/node/run IDs
 *
 * How to construct:
 * - Use `asOutputId()` after validating format at boundaries
 * - Derive deterministically for idempotent output emission
 *
 * Example:
 * ```typescript
 * const out = asOutputId('out_recap_attempt_01...');
 * ```
 */
export type OutputId = Brand<string, 'v2.OutputId'>;

/**
 * Branded type: TokenStringV1 (opaque signed token string).
 *
 * Footgun prevented:
 * - Prevents accidentally treating arbitrary strings as signed tokens
 * - Makes token passing explicit in APIs
 *
 * How to construct:
 * - Only from token signing functions (e.g., signTokenV1)
 * - Do not construct manually without signature verification
 *
 * Example:
 * ```typescript
 * const token = asTokenStringV1('st.v1.<payload>.<sig>');
 * ```
 */
export type TokenStringV1 = Brand<string, 'v2.TokenStringV1'>;

export function asWorkflowId(value: string): WorkflowId {
  return value as WorkflowId;
}

export function asSha256Digest(value: string): Sha256Digest {
  return value as Sha256Digest;
}

export function asWorkflowHash(value: Sha256Digest): WorkflowHash {
  return value as WorkflowHash;
}

export function asWorkflowHashRef(value: string): WorkflowHashRef {
  return value as WorkflowHashRef;
}

export function asCanonicalBytes(value: Uint8Array): CanonicalBytes {
  return value as CanonicalBytes;
}

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asRunId(value: string): RunId {
  return value as RunId;
}

export function asNodeId(value: string): NodeId {
  return value as NodeId;
}

export function asEventId(value: string): EventId {
  return value as EventId;
}

export function asEventIndex(value: number): EventIndex {
  return value as EventIndex;
}

export function asManifestIndex(value: number): ManifestIndex {
  return value as ManifestIndex;
}

export function asSnapshotRef(value: Sha256Digest): SnapshotRef {
  return value as SnapshotRef;
}

export function asAttemptId(value: string): AttemptId {
  return value as AttemptId;
}

export function asOutputId(value: string): OutputId {
  return value as OutputId;
}

export function asTokenStringV1(value: string): TokenStringV1 {
  return value as TokenStringV1;
}

// WorkflowHashRef derivation
export { deriveWorkflowHashRef } from './workflow-hash-ref.js';
export type { WorkflowHashRefError } from './workflow-hash-ref.js';
