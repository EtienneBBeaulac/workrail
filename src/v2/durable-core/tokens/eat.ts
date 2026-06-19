import type { TokenCodecPorts } from './token-codec-ports.js';

export interface EATPayload {
  readonly harness: string;
  readonly activeModel: string;
  readonly parentSessionId?: string;
  readonly spawnDepth: number;
  readonly sessionId?: string;
}

// ---------------------------------------------------------------------------
// Result type for EAT operations
// ---------------------------------------------------------------------------

export type EATSignError = { readonly kind: 'sign_failed'; readonly reason: string };

export type EATParseError =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'signature_mismatch' };

/** Minimal Result type for EAT operations (mirrors neverthrow's structure). */
export type EATResult<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function eatOk<T>(value: T): EATResult<T, never> {
  return { ok: true, value };
}

export function eatErr<E>(error: E): EATResult<never, E> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------

export function canonicalEATString(eat: EATPayload): string {
  return JSON.stringify({
    harness: eat.harness,
    activeModel: eat.activeModel,
    parentSessionId: eat.parentSessionId ?? '',
    spawnDepth: eat.spawnDepth,
    sessionId: eat.sessionId ?? '',
  });
}

/**
 * Signs an EAT payload and returns a Result.
 *
 * Returns err({ kind: 'sign_failed' }) if the keyring key cannot be decoded —
 * callers should warn and continue without storing eat_token (non-fatal degradation).
 */
export function signEAT(eat: EATPayload, ports: TokenCodecPorts): EATResult<string, EATSignError> {
  const message = canonicalEATString(eat);
  const messageBytes = new TextEncoder().encode(message);
  const keyBase64Url = ports.keyring.current.keyBase64Url;
  const decoded = ports.base64url.decodeBase64Url(keyBase64Url);
  if (decoded.isErr()) {
    return eatErr({ kind: 'sign_failed' as const, reason: `Key decode failed: ${decoded.error.message ?? 'unknown'}` });
  }
  const signatureBytes = ports.hmac.hmacSha256(decoded.value, messageBytes);
  return eatOk(ports.base64url.encodeBase64Url(signatureBytes));
}

/**
 * Parses and verifies a serialised EAT token string.
 *
 * Distinguishes three failure modes:
 * - `missing`            — no token was provided (null/undefined/empty string)
 * - `malformed`          — token present but cannot be parsed as { payload, signature }
 * - `signature_mismatch` — parsed but HMAC does not match (or sessionId binding fails)
 */
export function parseEAT(
  rawToken: string | null | undefined,
  ports: TokenCodecPorts,
  expectedSessionId?: string,
): EATResult<{ readonly payload: EATPayload; readonly signature: string }, EATParseError> {
  if (!rawToken) {
    return eatErr({ kind: 'missing' as const });
  }

  let parsed: { payload: unknown; signature: unknown };
  try {
    parsed = JSON.parse(rawToken) as { payload: unknown; signature: unknown };
  } catch (e) {
    return eatErr({ kind: 'malformed' as const, reason: `JSON parse error: ${e instanceof Error ? e.message : String(e)}` });
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.payload === null ||
    parsed.payload === undefined ||
    typeof parsed.payload !== 'object' ||
    typeof (parsed as { payload: Record<string, unknown> }).payload['harness'] !== 'string' ||
    typeof (parsed as { payload: Record<string, unknown> }).payload['activeModel'] !== 'string' ||
    typeof (parsed as { payload: Record<string, unknown> }).payload['spawnDepth'] !== 'number' ||
    typeof parsed.signature !== 'string'
  ) {
    return eatErr({ kind: 'malformed' as const, reason: 'Missing or invalid required fields (harness, activeModel, spawnDepth, signature)' });
  }

  const payload = parsed.payload as EATPayload;
  const signature = parsed.signature as string;

  const isValid = verifyEAT(payload, signature, ports, expectedSessionId);
  if (!isValid) {
    return eatErr({ kind: 'signature_mismatch' as const });
  }

  return eatOk({ payload, signature });
}

/**
 * Verifies an already-parsed EAT payload against its signature.
 * Used internally by parseEAT and also exported for cases where the payload is
 * already unpacked.
 */
export function verifyEAT(
  eat: EATPayload,
  signature: string,
  ports: TokenCodecPorts,
  expectedSessionId?: string,
): boolean {
  if (expectedSessionId !== undefined && eat.sessionId !== expectedSessionId) {
    return false;
  }
  const message = canonicalEATString(eat);
  const messageBytes = new TextEncoder().encode(message);
  const signatureDecoded = ports.base64url.decodeBase64Url(signature);
  if (signatureDecoded.isErr()) {
    return false;
  }

  const keys: string[] = [ports.keyring.current.keyBase64Url];
  if (ports.keyring.previous) {
    keys.push(ports.keyring.previous.keyBase64Url);
  }

  for (const k of keys) {
    const keyDecoded = ports.base64url.decodeBase64Url(k);
    if (keyDecoded.isErr()) continue;

    const expected = ports.hmac.hmacSha256(keyDecoded.value, messageBytes);
    if (ports.hmac.timingSafeEqual(expected, signatureDecoded.value)) {
      return true;
    }
  }

  return false;
}
