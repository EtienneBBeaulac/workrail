/**
 * v2 Token Tests (Direction B: Binary + Bech32m)
 *
 * @enforces token-prefix-closed-set
 * @enforces token-kind-closed-set
 * @enforces token-signing-hmac-sha256
 * @enforces token-signature-timing-safe
 * @enforces token-binary-wire-format
 * @enforces keyring-two-keys
 * @enforces keyring-32-byte-entropy
 * @enforces keyring-verification-order
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
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';

import { encodeBase32LowerNoPad } from '../../../src/v2/durable-core/encoding/base32-lower.js';
import { asWorkflowHash, asSha256Digest } from '../../../src/v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../../src/v2/durable-core/ids/workflow-hash-ref.js';

import {
  parseTokenV1Binary,
  signTokenV1Binary,
  verifyTokenSignatureV1Binary,
  StateTokenPayloadV1Schema,
} from '../../../src/v2/durable-core/tokens/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-'));
}

function mkId(prefix: string, fill: number): string {
  const bytes = new Uint8Array(16);
  bytes.fill(fill);
  return `${prefix}_${encodeBase32LowerNoPad(bytes)}`;
}

describe('v2 tokens (binary + bech32m)', () => {
  it('base64url decoding is strict (rejects padding)', () => {
    const base64url = new NodeBase64UrlV2();
    const res = base64url.decodeBase64Url('a===');
    expect(res.isErr()).toBe(true);
    if (res.isErr()) {
      expect(res.error.code).toBe('INVALID_BASE64URL_PADDING');
    }
  });

  it('parseTokenV1Binary fails closed on invalid prefix', () => {
    const bech32m = new Bech32mAdapterV2();
    const base32 = new Base32AdapterV2();
    const parsed = parseTokenV1Binary('invalid-prefix-token', bech32m, base32);
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error.code).toBe('TOKEN_INVALID_FORMAT');
    }
  });

  it('signs and verifies a state token (current key)', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const hmac = new NodeHmacSha256V2();
    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
    const base32 = new Base32AdapterV2();
    const bech32m = new Bech32mAdapterV2();

    const keyring = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected keyring error: ${e.code}`);
      }
    );

    const workflowHash = asWorkflowHash(asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2'));
    const wfRef = deriveWorkflowHashRef(workflowHash)._unsafeUnwrap();

    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: mkId('sess', 1),
      runId: mkId('run', 2),
      nodeId: mkId('node', 3),
      workflowHashRef: String(wfRef),
    });

    const token = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32)._unsafeUnwrap();
    expect(token.startsWith('st1')).toBe(true);

    const parsed = parseTokenV1Binary(token, bech32m, base32)._unsafeUnwrap();
    const verified = verifyTokenSignatureV1Binary(parsed, keyring, hmac, base64url);
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
    const base32 = new Base32AdapterV2();
    const bech32m = new Bech32mAdapterV2();

    const before = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected keyring error: ${e.code}`);
      }
    );

    const workflowHash = asWorkflowHash(asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2'));
    const wfRef = deriveWorkflowHashRef(workflowHash)._unsafeUnwrap();

    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: mkId('sess', 1),
      runId: mkId('run', 2),
      nodeId: mkId('node', 3),
      workflowHashRef: String(wfRef),
    });

    const tokenSignedWithOld = signTokenV1Binary(payload, before, hmac, base64url, bech32m, base32)._unsafeUnwrap();

    const after = await keyringPort.rotate().match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected rotate error: ${e.code}`);
      }
    );

    const parsed = parseTokenV1Binary(tokenSignedWithOld, bech32m, base32)._unsafeUnwrap();
    expect(verifyTokenSignatureV1Binary(parsed, after, hmac, base64url).isOk()).toBe(true);
  });

  it('fails verification for a tampered signature', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const hmac = new NodeHmacSha256V2();
    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
    const base32 = new Base32AdapterV2();
    const bech32m = new Bech32mAdapterV2();

    const keyring = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected keyring error: ${e.code}`);
      }
    );

    const workflowHash = asWorkflowHash(asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2'));
    const wfRef = deriveWorkflowHashRef(workflowHash)._unsafeUnwrap();

    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: mkId('sess', 1),
      runId: mkId('run', 2),
      nodeId: mkId('node', 3),
      workflowHashRef: String(wfRef),
    });

    const token = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32)._unsafeUnwrap();
    const parsed = parseTokenV1Binary(token, bech32m, base32)._unsafeUnwrap();

    // Mutate signature bytes; verify should fail
    parsed.signatureBytes[0] ^= 0xff;
    const verified = verifyTokenSignatureV1Binary(parsed, keyring, hmac, base64url);
    expect(verified.isErr()).toBe(true);
    if (verified.isErr()) {
      expect(verified.error.code).toBe('TOKEN_BAD_SIGNATURE');
    }
  });

  it('detects corruption via bech32m checksum', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const hmac = new NodeHmacSha256V2();
    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
    const base32 = new Base32AdapterV2();
    const bech32m = new Bech32mAdapterV2();

    const keyring = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected keyring error: ${e.code}`);
      }
    );

    const workflowHash = asWorkflowHash(asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2'));
    const wfRef = deriveWorkflowHashRef(workflowHash)._unsafeUnwrap();

    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: mkId('sess', 1),
      runId: mkId('run', 2),
      nodeId: mkId('node', 3),
      workflowHashRef: String(wfRef),
    });

    const token = signTokenV1Binary(payload, keyring, hmac, base64url, bech32m, base32)._unsafeUnwrap();
    const chars = token.split('');
    chars[10] = chars[10] === 'q' ? 'p' : 'q';
    const corrupted = chars.join('');

    const parsed = parseTokenV1Binary(corrupted, bech32m, base32);
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error.code).toBe('TOKEN_INVALID_FORMAT');
    }
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
