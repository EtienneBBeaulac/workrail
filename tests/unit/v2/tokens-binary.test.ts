/**
 * v2 Binary Token Tests (Direction B: Binary + Bech32m)
 *
 * Tests for the new binary token encoding format that replaces
 * JCS JSON + base64url with binary + bech32m.
 *
 * @enforces token-binary-payload-layout
 * @enforces token-bech32m-encoding
 * @enforces token-binary-roundtrip
 * @enforces token-corruption-detection
 * @enforces state-token-payload-fields
 * @enforces ack-token-payload-fields
 * @enforces checkpoint-token-payload-fields
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';
import {
  packStateTokenPayload,
  packAckTokenPayload,
  packCheckpointTokenPayload,
  unpackTokenPayload,
  signTokenV1Binary,
  verifyTokenSignatureV1Binary,
  parseTokenV1Binary,
  encodeTokenPayloadV1Binary,
  TOKEN_KIND_STATE,
  TOKEN_KIND_ACK,
  TOKEN_KIND_CHECKPOINT,
} from '../../../src/v2/durable-core/tokens/index.js';
import type {
  StateTokenPayloadV1,
  AckTokenPayloadV1,
  CheckpointTokenPayloadV1,
} from '../../../src/v2/durable-core/tokens/index.js';
import { asSessionId, asRunId, asNodeId, asAttemptId, asWorkflowHash, asSha256Digest } from '../../../src/v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../../src/v2/durable-core/ids/workflow-hash-ref.js';
import type { KeyringV1 } from '../../../src/v2/ports/keyring.port.js';

// ============================================================================
// Test Fixtures
// ============================================================================

const base32 = new Base32AdapterV2();

// Fixed deterministic test IDs (valid base32-lower: only [a-z2-7])
// These are encoded from fixed byte arrays to ensure roundtrip validity
// bytes[i] = (i + offset) % 256 for each ID type
function createTestStatePayload(): StateTokenPayloadV1 {
  const workflowHash = asWorkflowHash(asSha256Digest('sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11'));
  const workflowHashRef = deriveWorkflowHashRef(workflowHash)._unsafeUnwrap();
  return {
    tokenVersion: 1,
    tokenKind: 'state',
    sessionId: asSessionId('sess_aaaqeayeaudaocajbifqydiob4'), // offset=0
    runId: asRunId('run_caireeyuculbogazdinryhi6d4'), // offset=16
    nodeId: asNodeId('node_eaqseizeeutcokbjfivsyljof4'), // offset=32
    workflowHashRef,
  };
}

function createTestAckPayload(): AckTokenPayloadV1 {
  return {
    tokenVersion: 1,
    tokenKind: 'ack',
    sessionId: asSessionId('sess_aaaqeayeaudaocajbifqydiob4'), // offset=0
    runId: asRunId('run_caireeyuculbogazdinryhi6d4'), // offset=16
    nodeId: asNodeId('node_eaqseizeeutcokbjfivsyljof4'), // offset=32
    attemptId: asAttemptId('attempt_gaytemzugu3doobzhi5typj6h4'), // offset=48
  };
}

function createTestCheckpointPayload(): CheckpointTokenPayloadV1 {
  return {
    tokenVersion: 1,
    tokenKind: 'checkpoint',
    sessionId: asSessionId('sess_aaaqeayeaudaocajbifqydiob4'), // offset=0
    runId: asRunId('run_caireeyuculbogazdinryhi6d4'), // offset=16
    nodeId: asNodeId('node_eaqseizeeutcokbjfivsyljof4'), // offset=32
    attemptId: asAttemptId('attempt_gaytemzugu3doobzhi5typj6h4'), // offset=48
  };
}

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-binary-'));
}

async function createTestKeyring(): Promise<KeyringV1> {
  const root = await mkTempDataDir();
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
  const fsPort = new NodeFileSystemV2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

  return keyringPort.loadOrCreate().match(
    (v) => v,
    (e) => {
      throw new Error(`unexpected keyring error: ${e.code}`);
    },
  );
}

// ============================================================================
// Binary Payload Tests
// ============================================================================

describe('Binary payload serialization', () => {
  it('packs state token payload to 66 bytes', () => {
    const payload = createTestStatePayload();
    const result = packStateTokenPayload(payload, base32);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(66);
      expect(result.value[0]).toBe(1); // tokenVersion
      expect(result.value[1]).toBe(TOKEN_KIND_STATE); // tokenKind = 0
    }
  });

  it('packs ack token payload to 66 bytes', () => {
    const payload = createTestAckPayload();
    const result = packAckTokenPayload(payload);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(66);
      expect(result.value[0]).toBe(1); // tokenVersion
      expect(result.value[1]).toBe(TOKEN_KIND_ACK); // tokenKind = 1
    }
  });

  it('packs checkpoint token payload to 66 bytes', () => {
    const payload = createTestCheckpointPayload();
    const result = packCheckpointTokenPayload(payload);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBe(66);
      expect(result.value[0]).toBe(1); // tokenVersion
      expect(result.value[1]).toBe(TOKEN_KIND_CHECKPOINT); // tokenKind = 2
    }
  });

  it('roundtrips pack -> unpack for state token', () => {
    const payload = createTestStatePayload();
    const packed = packStateTokenPayload(payload, base32);
    expect(packed.isOk()).toBe(true);

    const unpacked = unpackTokenPayload(packed._unsafeUnwrap());
    expect(unpacked.isOk()).toBe(true);

    if (unpacked.isOk()) {
      expect(unpacked.value.tokenVersion).toBe(payload.tokenVersion);
      expect(unpacked.value.tokenKind).toBe(payload.tokenKind);
      expect(unpacked.value.sessionId).toBe(payload.sessionId);
      expect(unpacked.value.runId).toBe(payload.runId);
      expect(unpacked.value.nodeId).toBe(payload.nodeId);
      expect((unpacked.value as StateTokenPayloadV1).workflowHashRef).toBe(payload.workflowHashRef);
    }
  });

  it('roundtrips pack -> unpack for ack token', () => {
    const payload = createTestAckPayload();
    const packed = packAckTokenPayload(payload);
    expect(packed.isOk()).toBe(true);

    const unpacked = unpackTokenPayload(packed._unsafeUnwrap());
    expect(unpacked.isOk()).toBe(true);

    if (unpacked.isOk()) {
      const unpackedAck = unpacked.value as AckTokenPayloadV1;
      expect(unpackedAck.tokenKind).toBe('ack');
      expect(unpackedAck.sessionId).toBe(payload.sessionId);
      expect(unpackedAck.attemptId).toBe(payload.attemptId);
    }
  });

  it('is deterministic across multiple iterations', () => {
    const payload = createTestStatePayload();
    const results = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const packed = packStateTokenPayload(payload, base32);
      expect(packed.isOk()).toBe(true);
      results.add(Buffer.from(packed._unsafeUnwrap()).toString('hex'));
    }

    expect(results.size).toBe(1); // Only one unique result
  });

  it('rejects invalid token version', () => {
    const payload = {
      ...createTestStatePayload(),
      tokenVersion: 2 as 1, // Force invalid version
    };

    const result = packStateTokenPayload(payload, base32);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('BINARY_INVALID_VERSION');
    }
  });

  it('rejects invalid token kind', () => {
    const payload = {
      ...createTestStatePayload(),
      tokenKind: 'ack' as 'state', // Force mismatch
    };

    const result = packStateTokenPayload(payload, base32);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('BINARY_INVALID_TOKEN_KIND');
    }
  });

  it('rejects invalid ID format', () => {
    const payload = {
      ...createTestStatePayload(),
      sessionId: asSessionId('invalid:id'), // Contains colon
    };

    const result = packStateTokenPayload(payload, base32);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('BINARY_INVALID_ID_FORMAT');
    }
  });
});

// ============================================================================
// Bech32m Encoding Tests
// ============================================================================

describe('Bech32m encoding', () => {
  const bech32m = new Bech32mAdapterV2();

  it('encodes data to bech32m string with HRP', () => {
    const data = new Uint8Array(98);
    crypto.getRandomValues(data);

    const encoded = bech32m.encode('st', data);

    expect(typeof encoded).toBe('string');
    expect(encoded.startsWith('st1')).toBe(true);
  });

  it('roundtrips encode -> decode', () => {
    const data = new Uint8Array(98);
    crypto.getRandomValues(data);

    const encoded = bech32m.encode('st', data);
    const decoded = bech32m.decode(encoded, 'st');

    expect(decoded.isOk()).toBe(true);
    if (decoded.isOk()) {
      expect(decoded.value).toEqual(data);
    }
  });

  it('detects single-character corruption', () => {
    const data = new Uint8Array(98);
    crypto.getRandomValues(data);

    const encoded = bech32m.encode('st', data);

    // Corrupt one character (after 'st1' prefix)
    const chars = encoded.split('');
    const pos = 10;
    chars[pos] = chars[pos] === 'q' ? 'p' : 'q'; // flip one char
    const corrupted = chars.join('');

    const decoded = bech32m.decode(corrupted, 'st');
    expect(decoded.isErr()).toBe(true);
    if (decoded.isErr()) {
      expect(decoded.error.code).toBe('BECH32M_CHECKSUM_FAILED');
    }
  });

  it('rejects HRP mismatch', () => {
    const data = new Uint8Array(98);
    crypto.getRandomValues(data);

    const encoded = bech32m.encode('st', data); // Encoded with HRP='st'

    const decoded = bech32m.decode(encoded, 'ack'); // Try to decode as 'ack'
    expect(decoded.isErr()).toBe(true);
    if (decoded.isErr()) {
      expect(decoded.error.code).toBe('BECH32M_HRP_MISMATCH');
    }
  });

  /**
   * @enforces token-prefix-kind-match
   */
  it('handles different HRPs for different token types', () => {
    const data = new Uint8Array(98);
    crypto.getRandomValues(data);

    // State token
    const stToken = bech32m.encode('st', data);
    expect(stToken.startsWith('st1')).toBe(true);

    // Ack token
    const ackToken = bech32m.encode('ack', data);
    expect(ackToken.startsWith('ack1')).toBe(true);

    // Checkpoint token
    const chkToken = bech32m.encode('chk', data);
    expect(chkToken.startsWith('chk1')).toBe(true);
  });
});

// ============================================================================
// Full Token Lifecycle Tests
// ============================================================================

describe('Binary token signing and verification', () => {
  let keyring: KeyringV1;
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const bech32m = new Bech32mAdapterV2();

  beforeEach(async () => {
    keyring = await createTestKeyring();
  });

  it('signs state token and produces bech32m format', async () => {
    const payload = createTestStatePayload();

    const result = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.startsWith('st1')).toBe(true);
      expect(result.value.length).toBeLessThan(200); // Much shorter than old format
    }
  });

  it('signs ack token and produces bech32m format', async () => {
    const payload = createTestAckPayload();

    const result = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.startsWith('ack1')).toBe(true);
    }
  });

  it('signs checkpoint token and produces bech32m format', async () => {
    const payload = createTestCheckpointPayload();

    const result = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.startsWith('chk1')).toBe(true);
    }
  });

  it('sign -> parse -> verify roundtrip succeeds', async () => {
    const payload = createTestStatePayload();

    // Sign
    const signResult = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m);
    expect(signResult.isOk()).toBe(true);
    const token = signResult._unsafeUnwrap();

    // Parse
    const parseResult = parseTokenV1Binary(token, bech32m);
    expect(parseResult.isOk()).toBe(true);
    const parsed = parseResult._unsafeUnwrap();

    expect(parsed.hrp).toBe('st');
    expect(parsed.payload.tokenKind).toBe('state');

    // Verify
    const verifyResult = verifyTokenSignatureV1Binary(parsed, keyring, hmac, base64url);
    expect(verifyResult.isOk()).toBe(true);
  });

  it('tampered signature fails verification', async () => {
    const payload = createTestStatePayload();

    // Sign
    const signResult = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m);
    const token = signResult._unsafeUnwrap();

    // Parse
    const parseResult = parseTokenV1Binary(token, bech32m);
    const parsed = parseResult._unsafeUnwrap();

    // Tamper with signature
    parsed.signatureBytes[0] ^= 0xff;

    // Verify (should fail)
    const verifyResult = verifyTokenSignatureV1Binary(parsed, keyring, hmac, base64url);
    expect(verifyResult.isErr()).toBe(true);
    if (verifyResult.isErr()) {
      expect(verifyResult.error.code).toBe('TOKEN_BAD_SIGNATURE');
    }
  });

  it('is deterministic across iterations', async () => {
    const payload = createTestStatePayload();
    const tokens = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const result = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32);
      expect(result.isOk()).toBe(true);
      tokens.add(result._unsafeUnwrap());
    }

    expect(tokens.size).toBe(1); // Deterministic
  });
});

// ============================================================================
// Corruption Detection Tests
// ============================================================================

describe('Token corruption detection', () => {
  let keyring: KeyringV1;
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const bech32m = new Bech32mAdapterV2();

  beforeEach(async () => {
    keyring = await createTestKeyring();
  });

  it('detects multi-byte corruption', async () => {
    const payload = createTestStatePayload();
    const token = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32)._unsafeUnwrap();

    // Corrupt multiple characters in the middle
    const pos = Math.floor(token.length / 2);
    const corrupted = token.slice(0, pos) + 'xxx' + token.slice(pos + 3);

    const result = parseTokenV1Binary(corrupted, bech32m);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('TOKEN_INVALID_FORMAT');
    }
  });

  it('detects truncation', async () => {
    const payload = createTestStatePayload();
    const token = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32)._unsafeUnwrap();

    // Truncate token
    const truncated = token.slice(0, -10);

    const result = parseTokenV1Binary(truncated, bech32m);
    expect(result.isErr()).toBe(true);
  });

  it('detects prefix corruption', async () => {
    const payload = createTestStatePayload();
    const token = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32)._unsafeUnwrap();

    // Replace prefix
    const corrupted = 'ack' + token.slice(2); // Change st -> ack

    const result = parseTokenV1Binary(corrupted, bech32m);
    expect(result.isErr()).toBe(true);
  });

  it('detects insertion', async () => {
    const payload = createTestStatePayload();
    const token = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32)._unsafeUnwrap();

    // Insert extra characters
    const inserted = token.slice(0, 20) + 'xyz' + token.slice(20);

    const result = parseTokenV1Binary(inserted, bech32m);
    expect(result.isErr()).toBe(true);
  });

  it('rejects invalid prefix', () => {
    const result = parseTokenV1Binary('invalid1qpzry9x8gf2tvdw0s3jn54khce6mua7l', bech32m);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('TOKEN_INVALID_FORMAT');
      expect(result.error.message).toContain('expected st1/ack1/chk1');
    }
  });
});

// ============================================================================
// Token Size Tests
// ============================================================================

describe('Binary token size', () => {
  let keyring: KeyringV1;
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const bech32m = new Bech32mAdapterV2();

  beforeEach(async () => {
    keyring = await createTestKeyring();
  });

  it('state token is shorter than 170 characters', async () => {
    const payload = createTestStatePayload();
    const result = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32);
    expect(result.isOk()).toBe(true);

    const token = result._unsafeUnwrap();
    console.log(`State token length: ${token.length} chars`);
    expect(token.length).toBeLessThan(170);
  });

  it('ack token is shorter than 170 characters', async () => {
    const payload = createTestAckPayload();
    const result = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32);
    expect(result.isOk()).toBe(true);

    const token = result._unsafeUnwrap();
    console.log(`Ack token length: ${token.length} chars`);
    expect(token.length).toBeLessThan(170);
  });

  it('checkpoint token is shorter than 170 characters', async () => {
    const payload = createTestCheckpointPayload();
    const result = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32);
    expect(result.isOk()).toBe(true);

    const token = result._unsafeUnwrap();
    console.log(`Checkpoint token length: ${token.length} chars`);
    expect(token.length).toBeLessThan(170);
  });
});
