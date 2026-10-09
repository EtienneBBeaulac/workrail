import { z } from 'zod';
import { parseEAT, eatOk } from '../../../v2/durable-core/tokens/index.js';
import type { EATPayload, EATParseError, EATResult, TokenCodecPorts } from '../../../v2/durable-core/tokens/index.js';

const HistoricalSigningResultSchema = z.object({
  payload: z.unknown(),
  signature: z.object({ ok: z.literal(true), value: z.string() }).strict(),
}).strict();

type StoredAttestation = { readonly payload: EATPayload; readonly signature: string; readonly historicalWrapper: boolean };

/** Persistence-only compatibility for the old successful signing-result wrapper.
 * Recognition never grants authority: the existing verifier still owns HMAC and session binding.
 */
export function parseStoredEnvironmentAttestation(raw: string | null | undefined, ports: TokenCodecPorts,
  sessionId: string): EATResult<StoredAttestation, EATParseError> {
  const canonical = parseEAT(raw, ports, sessionId);
  if (canonical.ok) return eatOk({ ...canonical.value, historicalWrapper: false });
  if (!raw || canonical.error.kind !== 'malformed') return canonical;
  let stored: unknown;
  try { stored = JSON.parse(raw); } catch { return canonical; }
  const historical = HistoricalSigningResultSchema.safeParse(stored);
  if (!historical.success) return canonical;
  const verified = parseEAT(JSON.stringify({ payload: historical.data.payload,
    signature: historical.data.signature.value }), ports, sessionId);
  return verified.ok ? eatOk({ ...verified.value, historicalWrapper: true }) : verified;
}
