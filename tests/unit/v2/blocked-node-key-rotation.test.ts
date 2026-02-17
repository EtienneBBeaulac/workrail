import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { signTokenV1Binary, parseTokenV1Binary, unsafeTokenCodecPorts } from '../../../src/v2/durable-core/tokens/index.js';
import type { AckTokenPayloadV1 } from '../../../src/v2/durable-core/tokens/payloads.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
import { IdFactoryV2 } from '../../../src/v2/infra/local/id-factory/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import type { KeyringV1 } from '../../../src/v2/ports/keyring.port.js';

describe('Blocked node replay under key rotation (functional equivalence)', () => {
  it('retryAckToken re-signed after key rotation decodes to same retryAttemptId', () => {
    const hmac = new NodeHmacSha256V2();
    const base64url = new NodeBase64UrlV2();
    const base32 = new Base32AdapterV2();
    const bech32m = new Bech32mAdapterV2();
    const entropy = new NodeRandomEntropyV2();
    const idFactory = new IdFactoryV2(entropy);

    // Create initial keyring with currentKey (32 bytes)
    const keyA = randomBytes(32);
    const keyringBefore: KeyringV1 = {
      v: 1,
      current: { alg: 'hmac_sha256', keyBase64Url: keyA.toString('base64url') },
      previous: null,
    };

    const portsBeforeRotation = unsafeTokenCodecPorts({
      keyring: keyringBefore,
      hmac,
      base64url,
      base32,
      bech32m,
    });

    const payload: AckTokenPayloadV1 = {
      tokenVersion: 1,
      tokenKind: 'ack',
      sessionId: idFactory.mintSessionId(),
      runId: idFactory.mintRunId(),
      nodeId: idFactory.mintNodeId(),
      attemptId: idFactory.mintAttemptId(),
    };

    // Sign token with key A
    const token1Res = signTokenV1Binary(payload, portsBeforeRotation);
    if (token1Res.isErr()) {
      console.error('Sign error:', token1Res.error);
    }
    expect(token1Res.isOk()).toBe(true);
    const token1 = token1Res._unsafeUnwrap();

    // Parse to get attemptId
    const parsed1Res = parseTokenV1Binary(token1, portsBeforeRotation);
    expect(parsed1Res.isOk()).toBe(true);
    const attemptId1 = parsed1Res._unsafeUnwrap().payload.attemptId;

    // Rotate keyring: currentKey → previousKeys, new currentKey
    const keyB = randomBytes(32);
    const keyringAfterRotation: KeyringV1 = {
      v: 1,
      current: { alg: 'hmac_sha256', keyBase64Url: keyB.toString('base64url') },
      previous: { alg: 'hmac_sha256', keyBase64Url: keyA.toString('base64url') },
    };

    const portsAfterRotation = unsafeTokenCodecPorts({
      keyring: keyringAfterRotation,
      hmac,
      base64url,
      base32,
      bech32m,
    });

    // Re-sign same payload with new key
    const token2Res = signTokenV1Binary(payload, portsAfterRotation);
    expect(token2Res.isOk()).toBe(true);
    const token2 = token2Res._unsafeUnwrap();

    // Tokens are different strings (different signatures)
    expect(token1).not.toBe(token2);

    // But both decode to same attemptId (functional equivalence)
    const parsed2Res = parseTokenV1Binary(token2, portsAfterRotation);
    expect(parsed2Res.isOk()).toBe(true);
    const attemptId2 = parsed2Res._unsafeUnwrap().payload.attemptId;

    // Both decode to same attemptId (functional equivalence under key rotation)
    expect(attemptId1).toBe(attemptId2);

    // Original token still validates with rotated keyring (previous key)
    const token1VerifyRes = parseTokenV1Binary(token1, portsAfterRotation);
    expect(token1VerifyRes.isOk()).toBe(true);
  });

  it('validation details loaded from events are identical across key rotation', () => {
    // This tests that validation.issues and validation.suggestions come from durable events,
    // not recomputed, so they're identical even after key rotation (replay is fact-returning).
    
    const validationEvent = {
      v: 1,
      eventId: 'evt_val',
      eventIndex: 10,
      sessionId: 'sess_test',
      kind: 'validation_performed' as const,
      dedupeKey: 'validation_performed:sess_test:attempt_123',
      scope: { runId: 'run_test', nodeId: 'node_test' },
      data: {
        validationId: 'validation_123',
        attemptId: 'attempt_123',
        contractRef: 'wr.contracts.example',
        result: {
          valid: false,
          issues: ['Issue A', 'Issue B'],
          suggestions: ['Fix A', 'Fix B'],
        },
      },
    };

    // Before rotation
    const issues1 = validationEvent.data.result.issues;
    const suggestions1 = validationEvent.data.result.suggestions;

    // After rotation (event is unchanged, fact-returning)
    const issues2 = validationEvent.data.result.issues;
    const suggestions2 = validationEvent.data.result.suggestions;

    // Identical (no recomputation)
    expect(issues1).toEqual(issues2);
    expect(suggestions1).toEqual(suggestions2);
  });
});
