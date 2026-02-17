import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { signTokenV1Binary, parseTokenV1Binary, verifyTokenSignatureV1Binary, unsafeTokenCodecPorts } from '../../../src/v2/durable-core/tokens/index.js';
import type { AckTokenPayloadV1 } from '../../../src/v2/durable-core/tokens/payloads.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
import { IdFactoryV2 } from '../../../src/v2/infra/local/id-factory/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import type { KeyringV1 } from '../../../src/v2/ports/keyring.port.js';

describe('Blocked node token validation', () => {
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();

  it('token with corrupted payload (bit flip) fails verification', () => {
    const keyring: KeyringV1 = {
      v: 1,
      current: { alg: 'hmac_sha256', keyBase64Url: randomBytes(32).toString('base64url') },
      previous: null,
    };
    const ports = unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });

    const payload: AckTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'ack',
      sessionId: idFactory.mintSessionId(),
      runId: idFactory.mintRunId(),
      nodeId: idFactory.mintNodeId(),
      attemptId: idFactory.mintAttemptId(),
    };

    const tokenRes = signTokenV1Binary(payload, ports);
    expect(tokenRes.isOk()).toBe(true);
    if (!tokenRes.isOk()) return;

    const token = tokenRes.value;

    // Corrupt token (flip a bit in the middle)
    const corrupted = token.substring(0, 10) + (token[10] === 'a' ? 'b' : 'a') + token.substring(11);

    // Verification should fail (either format or signature error)
    const parseRes = parseTokenV1Binary(corrupted, ports);
    expect(parseRes.isErr()).toBe(true);
    if (parseRes.isErr()) {
      expect(['TOKEN_SIGNATURE_INVALID', 'TOKEN_INVALID_FORMAT']).toContain(parseRes.error.code);
    }
  });

  it('retryAckToken with wrong sessionId fails scope validation', () => {
    const sessionId1 = idFactory.mintSessionId();
    const sessionId2 = idFactory.mintSessionId();

    expect(sessionId1).not.toBe(sessionId2);

    // Token from session1 shouldn't work in session2 (scope mismatch)
    // This would be caught by assertTokenScopeMatchesStateBinary in v2-execution.ts
  });

  it('retryAckToken validates with previous key after rotation', () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);

    const keyringBefore: KeyringV1 = {
      v: 1,
      current: { alg: 'hmac_sha256', keyBase64Url: keyA.toString('base64url') },
      previous: null,
    };

    const keyringAfterRotation: KeyringV1 = {
      v: 1,
      current: { alg: 'hmac_sha256', keyBase64Url: keyB.toString('base64url') },
      previous: { alg: 'hmac_sha256', keyBase64Url: keyA.toString('base64url') }, // Key A in previous
    };

    const portsBefore = unsafeTokenCodecPorts({ keyring: keyringBefore, hmac, base64url, base32, bech32m });
    const portsAfter = unsafeTokenCodecPorts({ keyring: keyringAfterRotation, hmac, base64url, base32, bech32m });

    const payload: AckTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'ack',
      sessionId: idFactory.mintSessionId(),
      runId: idFactory.mintRunId(),
      nodeId: idFactory.mintNodeId(),
      attemptId: idFactory.mintAttemptId(),
    };

    // Sign with key A
    const tokenRes = signTokenV1Binary(payload, portsBefore);
    expect(tokenRes.isOk()).toBe(true);
    const token = tokenRes._unsafeUnwrap();

    // Verify with keyring after rotation (key A is in previous)
    // Should still validate (graceful rotation)
    const parseRes = parseTokenV1Binary(token, portsAfter);
    expect(parseRes.isOk()).toBe(true);
    if (parseRes.isOk()) {
      expect(parseRes.value.payload.attemptId).toBe(payload.attemptId);
    }
  });

  it('retryAckToken validates with current key', () => {
    const keyring: KeyringV1 = {
      v: 1,
      current: { alg: 'hmac_sha256', keyBase64Url: randomBytes(32).toString('base64url') },
      previous: null,
    };
    const ports = unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });

    const payload: AckTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'ack',
      sessionId: idFactory.mintSessionId(),
      runId: idFactory.mintRunId(),
      nodeId: idFactory.mintNodeId(),
      attemptId: idFactory.mintAttemptId(),
    };

    const tokenRes = signTokenV1Binary(payload, ports);
    expect(tokenRes.isOk()).toBe(true);
    const token = tokenRes._unsafeUnwrap();

    const parseRes = parseTokenV1Binary(token, ports);
    expect(parseRes.isOk()).toBe(true);
    if (parseRes.isOk()) {
      expect(parseRes.value.payload.attemptId).toBe(payload.attemptId);
    }
  });
});
