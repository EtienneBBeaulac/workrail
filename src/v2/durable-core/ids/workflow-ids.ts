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

// WorkflowHashRef derivation
export { deriveWorkflowHashRef } from './workflow-hash-ref.js';
export type { WorkflowHashRefError } from './workflow-hash-ref.js';
