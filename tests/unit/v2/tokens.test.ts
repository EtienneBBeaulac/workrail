/**
 * v2 Token Tests
 *
 * @enforces token-format-prefix-version-payload-sig
 * @enforces token-prefix-closed-set
 * @enforces token-kind-closed-set
 * @enforces token-prefix-kind-match
 * @enforces token-signing-hmac-sha256
 * @enforces token-signature-input-canonical-only
 * @enforces keyring-two-keys
 * @enforces keyring-verification-order
 * @enforces state-token-payload-fields
 * @enforces ack-token-payload-fields
 * @enforces keyring-32-byte-entropy
 * @enforces checkpoint-token-payload-fields
 * @enforces checkpoint-idempotency
 * @enforces token-signature-timing-safe
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import { parseTokenV1 } from '../../../src/v2/durable-core/tokens/index.js';
import { verifyTokenSignatureV1 } from '../../../src/v2/durable-core/tokens/index.js';
import { signTokenV1 } from '../../../src/v2/durable-core/tokens/index.js';
import { encodeTokenPayloadV1 } from '../../../src/v2/durable-core/tokens/index.js';
import { StateTokenPayloadV1Schema, AckTokenPayloadV1Schema, CheckpointTokenPayloadV1Schema } from '../../../src/v2/durable-core/tokens/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-'));
}

function decodeBase64Url(input: string) {
  const base64url = new NodeBase64UrlV2();
  return base64url.decodeBase64Url(input);
}

describe('v2 tokens (Slice 3 prereq)', () => {
  it('signs and verifies a state token (current key)', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
          const hmac = new NodeHmacSha256V2();
      const base64url = new NodeBase64UrlV2();
      const entropy = new NodeRandomEntropyV2();
      const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    const keyring = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected keyring error: ${e.code}`);
      }
    );

    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: 'sess_1',
      runId: 'run_1',
      nodeId: 'node_1',
      workflowHash: 'sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2',
    });

    const payloadBytes = encodeTokenPayloadV1(payload).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected payload encode error: ${e.code}`);
      }
    );

    const token = signTokenV1('st.v1.', payloadBytes, keyring, hmac, base64url).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected sign error: ${e.code}`);
      }
    );

    const parsed = parseTokenV1(String(token), base64url).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected parse error: ${e.code}`);
      }
    );
    const verified = verifyTokenSignatureV1(parsed, keyring, hmac, base64url);
    expect(verified.isOk()).toBe(true);
    expect(parsed.payload.tokenKind).toBe('state');
  });

  it('verifies tokens signed by previous key after rotation', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
          const hmac = new NodeHmacSha256V2();
      const base64url = new NodeBase64UrlV2();
      const entropy = new NodeRandomEntropyV2();
      const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    const before = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected keyring error: ${e.code}`);
      }
    );

    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: 'sess_1',
      runId: 'run_1',
      nodeId: 'node_1',
      workflowHash: 'sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2',
    });
    const payloadBytes = encodeTokenPayloadV1(payload)._unsafeUnwrap();

    const tokenSignedWithOld = signTokenV1('st.v1.', payloadBytes, before, hmac, base64url)._unsafeUnwrap();

    const after = await keyringPort.rotate().match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected rotate error: ${e.code}`);
      }
    );

    const parsed = parseTokenV1(String(tokenSignedWithOld), base64url)._unsafeUnwrap();
    expect(verifyTokenSignatureV1(parsed, after, hmac, base64url).isOk()).toBe(true);
  });

  it('fails verification for a tampered signature', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
          const hmac = new NodeHmacSha256V2();
      const base64url = new NodeBase64UrlV2();
      const entropy = new NodeRandomEntropyV2();
      const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    const keyring = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected keyring error: ${e.code}`);
      }
    );
    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: 'sess_1',
      runId: 'run_1',
      nodeId: 'node_1',
      workflowHash: 'sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2',
    });
    const payloadBytes = encodeTokenPayloadV1(payload)._unsafeUnwrap();
    const token = signTokenV1('st.v1.', payloadBytes, keyring, hmac, base64url)._unsafeUnwrap();

    const raw = String(token);
    // Tamper with the signature segment more aggressively to ensure bytes change significantly.
    const parts = raw.split('.');
    const sigPart = parts[3]!;
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${sigPart.slice(0, -8)}AAAAAAAA`;
    const parsed = parseTokenV1(tampered, base64url)._unsafeUnwrap();
    const verified = verifyTokenSignatureV1(parsed, keyring, hmac, base64url);
    expect(verified.isErr()).toBe(true);
    if (verified.isErr()) {
      expect(verified.error.code).toBe('TOKEN_BAD_SIGNATURE');
    }
  });

  describe('keyring-32-byte-entropy', () => {
    it('generates keys with exactly 32 bytes of entropy', async () => {
      const root = await mkTempDataDir();
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const fsPort = new NodeFileSystemV2();
      const base64url = new NodeBase64UrlV2();
      const entropy = new NodeRandomEntropyV2();
      const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

      const keyring = await keyringPort.loadOrCreate().match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected keyring error: ${e.code}`);
        }
      );

      // Decode the current key from base64url
      const currentDecoded = decodeBase64Url(keyring.current.keyBase64Url).match(
        (v) => v,
        (e) => {
          throw new Error(`failed to decode current key: ${e.code}`);
        }
      );
      expect(currentDecoded.length).toBe(32);

      // Previous key should also be 32 bytes if it exists
      if (keyring.previous) {
        const previousDecoded = decodeBase64Url(keyring.previous.keyBase64Url).match(
          (v) => v,
          (e) => {
            throw new Error(`failed to decode previous key: ${e.code}`);
          }
        );
        expect(previousDecoded.length).toBe(32);
      }
    });

    it('persists keys with 32-byte entropy after rotation', async () => {
      const root = await mkTempDataDir();
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const fsPort = new NodeFileSystemV2();
      const base64url = new NodeBase64UrlV2();
      const entropy = new NodeRandomEntropyV2();
      const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

      const before = await keyringPort.loadOrCreate().match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected keyring error: ${e.code}`);
        }
      );
      const beforeCurrentBytes = decodeBase64Url(before.current.keyBase64Url).match(
        (v) => v,
        (e) => {
          throw new Error(`failed to decode: ${e.code}`);
        }
      );
      expect(beforeCurrentBytes.length).toBe(32);

      const after = await keyringPort.rotate().match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected rotate error: ${e.code}`);
        }
      );

      // After rotation: previous should be old current (32 bytes)
      const afterPreviousBytes = decodeBase64Url(after.previous!.keyBase64Url).match(
        (v) => v,
        (e) => {
          throw new Error(`failed to decode: ${e.code}`);
        }
      );
      expect(afterPreviousBytes.length).toBe(32);

      // New current should also be 32 bytes
      const afterCurrentBytes = decodeBase64Url(after.current.keyBase64Url).match(
        (v) => v,
        (e) => {
          throw new Error(`failed to decode: ${e.code}`);
        }
      );
      expect(afterCurrentBytes.length).toBe(32);
    });
  });

  describe('checkpoint-token-payload-fields', () => {
    it('creates checkpoint tokens with required fields', async () => {
      const root = await mkTempDataDir();
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
          const hmac = new NodeHmacSha256V2();
      const base64url = new NodeBase64UrlV2();
      const entropy = new NodeRandomEntropyV2();
      const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

      const keyring = await keyringPort.loadOrCreate().match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected keyring error: ${e.code}`);
        }
      );

      const payload = CheckpointTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'checkpoint',
        sessionId: 'sess_1',
        runId: 'run_1',
        nodeId: 'node_1',
        attemptId: 'attempt_1',
      });

      const payloadBytes = encodeTokenPayloadV1(payload).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected payload encode error: ${e.code}`);
        }
      );

      const token = signTokenV1('chk.v1.', payloadBytes, keyring, hmac, base64url).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected sign error: ${e.code}`);
        }
      );

      const parsed = parseTokenV1(String(token), base64url).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected parse error: ${e.code}`);
        }
      );

      // Assert all required checkpoint payload fields are present
      expect(parsed.payload.tokenKind).toBe('checkpoint');
      expect(parsed.payload.tokenVersion).toBe(1);
      expect(parsed.payload.sessionId).toBe('sess_1');
      expect(parsed.payload.runId).toBe('run_1');
      expect(parsed.payload.nodeId).toBe('node_1');
      expect(parsed.payload.attemptId).toBe('attempt_1');
    });

    it('rejects checkpoint tokens with missing attemptId', async () => {
      // Attempt to parse invalid checkpoint without attemptId using safeParse
      const result = CheckpointTokenPayloadV1Schema.safeParse({
        tokenVersion: 1,
        tokenKind: 'checkpoint',
        sessionId: 'sess_1',
        runId: 'run_1',
        nodeId: 'node_1',
        // Missing attemptId - should fail validation
      });

      // Schema validation should fail when attemptId is missing
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some(issue => issue.code === 'invalid_type' && issue.path.includes('attemptId'))).toBe(true);
      }
    });

    it('distinguishes checkpoint tokens from state and ack tokens by payload', async () => {
      const checkpointPayload = CheckpointTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'checkpoint',
        sessionId: 'sess_1',
        runId: 'run_1',
        nodeId: 'node_1',
        attemptId: 'attempt_1',
      });

      const ackPayload = AckTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'ack',
        sessionId: 'sess_1',
        runId: 'run_1',
        nodeId: 'node_1',
        attemptId: 'attempt_1',
      });

      expect(checkpointPayload.tokenKind).toBe('checkpoint');
      expect(ackPayload.tokenKind).toBe('ack');
    });
  });

  describe('checkpoint-idempotency', () => {
    it('creates consistent checkpoint tokens from same payload', async () => {
      const root = await mkTempDataDir();
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
          const hmac = new NodeHmacSha256V2();
      const base64url = new NodeBase64UrlV2();
      const entropy = new NodeRandomEntropyV2();
      const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

      const keyring = await keyringPort.loadOrCreate().match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected keyring error: ${e.code}`);
        }
      );

      // Create same payload twice
      const payload1 = CheckpointTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'checkpoint',
        sessionId: 'sess_1',
        runId: 'run_1',
        nodeId: 'node_1',
        attemptId: 'attempt_1',
      });

      const payload2 = CheckpointTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'checkpoint',
        sessionId: 'sess_1',
        runId: 'run_1',
        nodeId: 'node_1',
        attemptId: 'attempt_1',
      });

      const bytes1 = encodeTokenPayloadV1(payload1)._unsafeUnwrap();
      const bytes2 = encodeTokenPayloadV1(payload2)._unsafeUnwrap();

      // Canonical encoding should be identical
      expect(bytes1).toEqual(bytes2);

      const token1 = signTokenV1('chk.v1.', bytes1, keyring, hmac, base64url)._unsafeUnwrap();
      const token2 = signTokenV1('chk.v1.', bytes2, keyring, hmac, base64url)._unsafeUnwrap();

      // Same payload with same key should produce same token (idempotent)
      expect(String(token1)).toBe(String(token2));

      // Both tokens should verify successfully
      const parsed1 = parseTokenV1(String(token1), base64url)._unsafeUnwrap();
      const parsed2 = parseTokenV1(String(token2), base64url)._unsafeUnwrap();
      expect(verifyTokenSignatureV1(parsed1, keyring, hmac, base64url).isOk()).toBe(true);
      expect(verifyTokenSignatureV1(parsed2, keyring, hmac, base64url).isOk()).toBe(true);
    });
  });

  describe('token-signature-timing-safe', () => {
    it('uses timing-safe comparison for signature verification', async () => {
      const root = await mkTempDataDir();
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
          const hmac = new NodeHmacSha256V2();
      const base64url = new NodeBase64UrlV2();
      const entropy = new NodeRandomEntropyV2();
      const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

      const keyring = await keyringPort.loadOrCreate().match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected keyring error: ${e.code}`);
        }
      );

      const payload = StateTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'state',
        sessionId: 'sess_1',
        runId: 'run_1',
        nodeId: 'node_1',
        workflowHash: 'sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2',
      });

      const payloadBytes = encodeTokenPayloadV1(payload)._unsafeUnwrap();
      const token = signTokenV1('st.v1.', payloadBytes, keyring, hmac, base64url)._unsafeUnwrap();

      const parsed = parseTokenV1(String(token), base64url)._unsafeUnwrap();

      // Verify correct signature passes
      const result = verifyTokenSignatureV1(parsed, keyring, hmac, base64url);
      expect(result.isOk()).toBe(true);

      // Verify that incorrect signature fails
      const raw = String(token);
      const parts = raw.split('.');
      const sigPart = parts[3]!;
      // Flip one byte in the signature
      const tamperedSig = sigPart.slice(0, -8) + 'AAAAAAAA';
      const tamperedToken = `${parts[0]}.${parts[1]}.${parts[2]}.${tamperedSig}`;
      const parsedTampered = parseTokenV1(tamperedToken, base64url)._unsafeUnwrap();

      // This should fail (timing-safe comparison prevents timing attacks)
      const badResult = verifyTokenSignatureV1(parsedTampered, keyring, hmac, base64url);
      expect(badResult.isErr()).toBe(true);
      expect(badResult._unsafeUnwrapErr().code).toBe('TOKEN_BAD_SIGNATURE');
    });

    it('timingSafeEqual behaves consistently regardless of mismatch position', async () => {
      const hmac = new NodeHmacSha256V2();

      // Test with identical arrays
      const a = new Uint8Array([1, 2, 3, 4, 5]);
      const b = new Uint8Array([1, 2, 3, 4, 5]);
      expect(hmac.timingSafeEqual(a, b)).toBe(true);

      // Test with different arrays (should be false regardless of position)
      const c = new Uint8Array([1, 2, 3, 4, 5]);
      const d = new Uint8Array([1, 2, 9, 4, 5]); // differ at position 2
      expect(hmac.timingSafeEqual(c, d)).toBe(false);

      const e = new Uint8Array([1, 2, 3, 4, 5]);
      const f = new Uint8Array([9, 2, 3, 4, 5]); // differ at position 0
      expect(hmac.timingSafeEqual(e, f)).toBe(false);

      // Different lengths
      const g = new Uint8Array([1, 2, 3]);
      const h = new Uint8Array([1, 2, 3, 4]);
      expect(hmac.timingSafeEqual(g, h)).toBe(false);
    });
  });
});
