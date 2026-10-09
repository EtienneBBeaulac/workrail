import { z } from 'zod';
import { parseEAT, verifyEAT, eatOk } from '../../../v2/durable-core/tokens/index.js';
import type { EATPayload, EATParseError, EATResult, TokenCodecPorts } from '../../../v2/durable-core/tokens/index.js';

const HistoricalSigningResultSchema = z.object({
  payload: z.unknown(),
  signature: z.object({ ok: z.literal(true), value: z.string() }).strict(),
}).strict();

type StoredAttestation = { readonly payload: EATPayload; readonly signature: string; readonly historicalWrapper: boolean;
  readonly verificationKey: 'current' | 'previous' };

function identifyVerificationKey(verified: { readonly payload: EATPayload; readonly signature: string },
  ports: TokenCodecPorts, sessionId: string, historicalWrapper: boolean): StoredAttestation {
  // This runs only after full verification. A previous-key success must be renewed
  // while that authority still exists, before the next rotation retires the key.
  const currentOnly: TokenCodecPorts = { ...ports, keyring: { ...ports.keyring, previous: null } };
  const verificationKey = verifyEAT(verified.payload, verified.signature, currentOnly, sessionId) ? 'current' : 'previous';
  return { ...verified, historicalWrapper, verificationKey };
}

/** Persistence-only compatibility for the old successful signing-result wrapper.
 * Recognition never grants authority: the existing verifier still owns HMAC and session binding.
 */
export function parseStoredEnvironmentAttestation(raw: string | null | undefined, ports: TokenCodecPorts,
  sessionId: string): EATResult<StoredAttestation, EATParseError> {
  const canonical = parseEAT(raw, ports, sessionId);
  if (canonical.ok) return eatOk(identifyVerificationKey(canonical.value, ports, sessionId, false));
  if (!raw || canonical.error.kind !== 'malformed') return canonical;
  let stored: unknown;
  try { stored = JSON.parse(raw); } catch { return canonical; }
  const historical = HistoricalSigningResultSchema.safeParse(stored);
  if (!historical.success) return canonical;
  const verified = parseEAT(JSON.stringify({ payload: historical.data.payload,
    signature: historical.data.signature.value }), ports, sessionId);
  return verified.ok ? eatOk(identifyVerificationKey(verified.value, ports, sessionId, true)) : verified;
}
