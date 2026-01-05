import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { WorkflowHash, WorkflowHashRef } from './index.js';
import { asWorkflowHashRef } from './index.js';
import { encodeBase32LowerNoPad } from '../encoding/base32-lower.js';

export type WorkflowHashRefError =
  | { readonly code: 'WORKFLOW_HASH_INVALID_FORMAT'; readonly message: string };

/**
 * Derive a deterministic 128-bit workflowHashRef from a full workflowHash.
 *
 * Lock: Direction B binary token payload layout stores only 16 bytes for workflow identity.
 *
 * Derivation:
 * - Parse `sha256:<64 hex>`
 * - Take first 16 bytes (32 hex chars)
 * - Encode those 16 bytes as base32-lower-no-pad
 * - Prefix with `wf_`
 */
export function deriveWorkflowHashRef(workflowHash: WorkflowHash): Result<WorkflowHashRef, WorkflowHashRefError> {
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(workflowHash));
  if (!match) {
    return err({
      code: 'WORKFLOW_HASH_INVALID_FORMAT',
      message: 'Expected workflowHash format: sha256:<64 lowercase hex chars>',
    });
  }

  const hexDigest = match[1]!;
  const first32Hex = hexDigest.slice(0, 32);

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(first32Hex.slice(i * 2, i * 2 + 2), 16);
  }

  const suffix = encodeBase32LowerNoPad(bytes);
  return ok(asWorkflowHashRef(`wf_${suffix}`));
}
