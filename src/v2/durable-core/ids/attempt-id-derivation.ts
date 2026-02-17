import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { Sha256PortV2 } from '../../ports/sha256.port.js';
import type { AttemptId } from './index.js';
import { asAttemptId } from './index.js';
import { encodeBase32LowerNoPad } from '../encoding/base32-lower.js';
import { hexToBytes } from '../encoding/hex-to-bytes.js';

const PREFIX = 'wr_attempt_next_v1:';

export type AttemptIdDerivationError = {
  readonly code: 'INVALID_HEX' | 'INVALID_DIGEST_FORMAT';
  readonly message: string;
};

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Deterministically derive the next node's attemptId from a parent attemptId.
 *
 * Why:
 * - preserves replay determinism (same parent attemptId => same child attemptId)
 * - avoids unbounded `next_next_next_...` growth that bloats tokens
 *
 * Output is always: attempt_<26 base32 chars>
 */
export function deriveChildAttemptId(parent: AttemptId, sha256: Sha256PortV2): Result<AttemptId, AttemptIdDerivationError> {
  const bytes = new TextEncoder().encode(`${PREFIX}${String(parent)}`);
  const digest = String(sha256.sha256(bytes));

  if (!SHA256_DIGEST_RE.test(digest)) {
    return err({ code: 'INVALID_DIGEST_FORMAT', message: `expected sha256:<64hex> digest, got: ${digest}` });
  }

  // Use 16 bytes (128-bit) of the digest for a fixed-size derived ID.
  const first16Res = hexToBytes(digest.slice('sha256:'.length, 'sha256:'.length + 32));
  if (first16Res.isErr()) {
    return err(first16Res.error);
  }
  
  const suffix = encodeBase32LowerNoPad(first16Res.value);
  return ok(asAttemptId(`attempt_${suffix}`));
}
