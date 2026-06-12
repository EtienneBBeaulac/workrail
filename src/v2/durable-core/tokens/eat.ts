import type { TokenCodecPorts } from './token-codec-ports.js';

export interface EATPayload {
  readonly harness: string;
  readonly activeModel: string;
  readonly parentSessionId?: string;
  readonly spawnDepth: number;
  readonly sessionId?: string;
}

export function canonicalEATString(eat: EATPayload): string {
  return JSON.stringify({
    harness: eat.harness,
    activeModel: eat.activeModel,
    parentSessionId: eat.parentSessionId ?? '',
    spawnDepth: eat.spawnDepth,
    sessionId: eat.sessionId ?? '',
  });
}

export function signEAT(eat: EATPayload, ports: TokenCodecPorts): string | null {
  const message = canonicalEATString(eat);
  const messageBytes = new TextEncoder().encode(message);
  const keyBase64Url = ports.keyring.current.keyBase64Url;
  const decoded = ports.base64url.decodeBase64Url(keyBase64Url);
  if (decoded.isErr()) {
    return null;
  }
  const signatureBytes = ports.hmac.hmacSha256(decoded.value, messageBytes);
  return ports.base64url.encodeBase64Url(signatureBytes);
}

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
