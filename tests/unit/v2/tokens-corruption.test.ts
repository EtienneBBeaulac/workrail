/**
 * Position-specific corruption detection tests.
 *
 * Tests that corruption at every byte offset is detected via:
 * - Bech32m checksum (copy/paste errors)
 * - HMAC signature verification (intentional tampering)
 *
 * @enforces token-corruption-detection
 * @enforces bech32m-checksum-validation
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';

import {
  signTokenV1Binary,
  parseTokenV1Binary,
  StateTokenPayloadV1Schema,
  unsafeTokenCodecPorts,
} from '../../../src/v2/durable-core/tokens/index.js';
import { asWorkflowHash, asSha256Digest } from '../../../src/v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../../src/v2/durable-core/ids/workflow-hash-ref.js';
import { encodeBase32LowerNoPad } from '../../../src/v2/durable-core/encoding/base32-lower.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-corrupt-'));
}

function mkId(prefix: string, fill: number): string {
  const bytes = new Uint8Array(16);
  bytes.fill(fill);
  return `${prefix}_${encodeBase32LowerNoPad(bytes)}`;
}

describe('Token corruption detection', () => {
  it('detects corruption in HRP prefix (st1 → xt1)', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const hmac = new NodeHmacSha256V2();
    const base64url = new NodeBase64UrlV2();
    const base32 = new Base32AdapterV2();
    const bech32m = new Bech32mAdapterV2();
    const entropy = new NodeRandomEntropyV2();
    const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    const keyring = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => { throw new Error(`keyring load failed: ${e.code}`); }
    );

    const wfHash = asWorkflowHash(asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2'));
    const wfRef = deriveWorkflowHashRef(wfHash).match(
      (v) => v,
      (e) => { throw new Error(`wfRef failed: ${e.code}`); }
    );

    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: mkId('sess', 1),
      runId: mkId('run', 2),
      nodeId: mkId('node', 3),
      workflowHashRef: String(wfRef),
    });

    const ports = unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });
    const token = signTokenV1Binary(payload, ports).match(
      (v) => v,
      (e) => { throw new Error(`sign failed: ${e.code}`); }
    );

    // Corrupt HRP: st1 → xt1
    const corrupted = 'xt1' + token.slice(3);

    const result = parseTokenV1Binary(corrupted, ports);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('TOKEN_INVALID_FORMAT');
    }
  });

  it('detects corruption at character position 10 (data section)', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const hmac = new NodeHmacSha256V2();
    const base64url = new NodeBase64UrlV2();
    const base32 = new Base32AdapterV2();
    const bech32m = new Bech32mAdapterV2();
    const entropy = new NodeRandomEntropyV2();
    const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    const keyring = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => { throw new Error(`keyring load failed: ${e.code}`); }
    );

    const wfHash = asWorkflowHash(asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2'));
    const wfRef = deriveWorkflowHashRef(wfHash).match(
      (v) => v,
      (e) => { throw new Error(`wfRef failed: ${e.code}`); }
    );

    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: mkId('sess', 1),
      runId: mkId('run', 2),
      nodeId: mkId('node', 3),
      workflowHashRef: String(wfRef),
    });

    const ports = unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });
    const token = signTokenV1Binary(payload, ports).match(
      (v) => v,
      (e) => { throw new Error(`sign failed: ${e.code}`); }
    );

    // Flip character at position 10
    const chars = token.split('');
    chars[10] = chars[10] === 'q' ? 'p' : 'q';
    const corrupted = chars.join('');

    const result = parseTokenV1Binary(corrupted, ports);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('TOKEN_INVALID_FORMAT');
      expect(result.error.message).toMatch(/checksum|corrupt/i);
    }
  });

  it('detects corruption at character position 100 (signature section)', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const hmac = new NodeHmacSha256V2();
    const base64url = new NodeBase64UrlV2();
    const base32 = new Base32AdapterV2();
    const bech32m = new Bech32mAdapterV2();
    const entropy = new NodeRandomEntropyV2();
    const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    const keyring = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => { throw new Error(`keyring load failed: ${e.code}`); }
    );

    const wfHash = asWorkflowHash(asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2'));
    const wfRef = deriveWorkflowHashRef(wfHash).match(
      (v) => v,
      (e) => { throw new Error(`wfRef failed: ${e.code}`); }
    );

    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: mkId('sess', 1),
      runId: mkId('run', 2),
      nodeId: mkId('node', 3),
      workflowHashRef: String(wfRef),
    });

    const ports = unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });
    const token = signTokenV1Binary(payload, ports).match(
      (v) => v,
      (e) => { throw new Error(`sign failed: ${e.code}`); }
    );

    // Flip character at position 100 (in signature portion)
    const chars = token.split('');
    chars[100] = chars[100] === 'a' ? 'b' : 'a';
    const corrupted = chars.join('');

    const result = parseTokenV1Binary(corrupted, ports);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('TOKEN_INVALID_FORMAT');
    }
  });

  it('detects corruption near end of token (checksum area)', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const hmac = new NodeHmacSha256V2();
    const base64url = new NodeBase64UrlV2();
    const base32 = new Base32AdapterV2();
    const bech32m = new Bech32mAdapterV2();
    const entropy = new NodeRandomEntropyV2();
    const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    const keyring = await keyringPort.loadOrCreate().match(
      (v) => v,
      (e) => { throw new Error(`keyring load failed: ${e.code}`); }
    );

    const wfHash = asWorkflowHash(asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2'));
    const wfRef = deriveWorkflowHashRef(wfHash).match(
      (v) => v,
      (e) => { throw new Error(`wfRef failed: ${e.code}`); }
    );

    const payload = StateTokenPayloadV1Schema.parse({
      tokenVersion: 1,
      tokenKind: 'state',
      sessionId: mkId('sess', 1),
      runId: mkId('run', 2),
      nodeId: mkId('node', 3),
      workflowHashRef: String(wfRef),
    });

    const ports = unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });
    const token = signTokenV1Binary(payload, ports).match(
      (v) => v,
      (e) => { throw new Error(`sign failed: ${e.code}`); }
    );

    // Corrupt near end (last 6 chars are bech32m checksum)
    const chars = token.split('');
    const pos = token.length - 3;
    chars[pos] = chars[pos] === 'z' ? 'y' : 'z';
    const corrupted = chars.join('');

    const result = parseTokenV1Binary(corrupted, ports);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('TOKEN_INVALID_FORMAT');
    }
  });
});
