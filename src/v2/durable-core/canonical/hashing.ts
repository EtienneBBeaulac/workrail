import type { WorkflowHash, Sha256Digest, CanonicalBytes, SnapshotRef } from '../ids/index.js';
import { asWorkflowHash, asSnapshotRef } from '../ids/index.js';
import type { JsonValue } from './json-types.js';
import type { Result } from 'neverthrow';
import { toCanonicalBytes } from './jcs.js';
import type { ExecutionSnapshotFileV1 } from '../schemas/execution-snapshot/index.js';

export interface CryptoPortV2 {
  sha256(bytes: CanonicalBytes): Sha256Digest;
}

export type HashingError = { readonly code: 'HASHING_CANONICALIZE_FAILED'; readonly message: string };

export function workflowHashForCompiledSnapshot(
  compiled: JsonValue,
  crypto: CryptoPortV2
): Result<WorkflowHash, HashingError> {
  return toCanonicalBytes(compiled)
    .mapErr(
      (e) =>
        ({
          code: 'HASHING_CANONICALIZE_FAILED',
          message: e.message,
        }) as const
    )
    .map((bytes) => asWorkflowHash(crypto.sha256(bytes)));
}

export function snapshotRefForExecutionSnapshotFileV1(
  snapshot: ExecutionSnapshotFileV1,
  crypto: CryptoPortV2
): Result<SnapshotRef, HashingError> {
  return toCanonicalBytes(snapshot as unknown as JsonValue)
    .mapErr(
      (e) =>
        ({
          code: 'HASHING_CANONICALIZE_FAILED',
          message: e.message,
        }) as const
    )
    .map((bytes) => asSnapshotRef(crypto.sha256(bytes)));
}

