import type { WorkflowHash, Sha256Digest, CanonicalBytes } from '../ids/index.js';
import { asWorkflowHash } from '../ids/index.js';
import type { JsonValue } from './json-types.js';
import type { Result } from 'neverthrow';
import { toCanonicalBytes } from './jcs.js';

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
