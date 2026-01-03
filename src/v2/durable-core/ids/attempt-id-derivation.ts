import type { Sha256PortV2 } from '../../ports/sha256.port.js';
import type { AttemptId } from './index.js';
import { asAttemptId } from './index.js';
import { encodeBase32LowerNoPad } from '../encoding/base32-lower.js';

const PREFIX = 'wr_attempt_next_v1:';

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('hex string must have even length');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byteHex = hex.slice(i * 2, i * 2 + 2);
    const n = Number.parseInt(byteHex, 16);
    if (Number.isNaN(n)) {
      throw new Error(`invalid hex byte: ${byteHex}`);
    }
    out[i] = n;
  }
  return out;
}

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
export function deriveChildAttemptId(parent: AttemptId, sha256: Sha256PortV2): AttemptId {
  const bytes = new TextEncoder().encode(`${PREFIX}${String(parent)}`);
  const digest = String(sha256.sha256(bytes));

  if (!SHA256_DIGEST_RE.test(digest)) {
    throw new Error(`expected sha256:<64hex> digest, got: ${digest}`);
  }

  // Use 16 bytes (128-bit) of the digest for a fixed-size derived ID.
  const first16 = hexToBytes(digest.slice('sha256:'.length, 'sha256:'.length + 32));
  const suffix = encodeBase32LowerNoPad(first16);
  return asAttemptId(`attempt_${suffix}`);
}
