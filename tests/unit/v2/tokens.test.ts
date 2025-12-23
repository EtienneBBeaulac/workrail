import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { parseTokenV1 } from '../../../src/v2/durable-core/tokens/index.js';
import { verifyTokenSignatureV1 } from '../../../src/v2/durable-core/tokens/index.js';
import { signTokenV1 } from '../../../src/v2/durable-core/tokens/index.js';
import { encodeTokenPayloadV1 } from '../../../src/v2/durable-core/tokens/index.js';
import { StateTokenPayloadV1Schema } from '../../../src/v2/durable-core/tokens/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-'));
}

describe('v2 tokens (Slice 3 prereq)', () => {
  it('signs and verifies a state token (current key)', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const hmac = new NodeHmacSha256V2();
    const keyringPort = new LocalKeyringV2(dataDir, fsPort);

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

    const token = signTokenV1('st.v1.', payloadBytes, keyring, hmac).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected sign error: ${e.code}`);
      }
    );

    const parsed = parseTokenV1(String(token)).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected parse error: ${e.code}`);
      }
    );
    const verified = verifyTokenSignatureV1(parsed, keyring, hmac);
    expect(verified.isOk()).toBe(true);
    expect(parsed.payload.tokenKind).toBe('state');
  });

  it('verifies tokens signed by previous key after rotation', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const hmac = new NodeHmacSha256V2();
    const keyringPort = new LocalKeyringV2(dataDir, fsPort);

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

    const tokenSignedWithOld = signTokenV1('st.v1.', payloadBytes, before, hmac)._unsafeUnwrap();

    const after = await keyringPort.rotate().match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected rotate error: ${e.code}`);
      }
    );

    const parsed = parseTokenV1(String(tokenSignedWithOld))._unsafeUnwrap();
    expect(verifyTokenSignatureV1(parsed, after, hmac).isOk()).toBe(true);
  });

  it('fails verification for a tampered signature', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const hmac = new NodeHmacSha256V2();
    const keyringPort = new LocalKeyringV2(dataDir, fsPort);

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
    const token = signTokenV1('st.v1.', payloadBytes, keyring, hmac)._unsafeUnwrap();

    const raw = String(token);
    // Tamper with the signature segment more aggressively to ensure bytes change significantly.
    const parts = raw.split('.');
    const sigPart = parts[3]!;
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${sigPart.slice(0, -8)}AAAAAAAA`;
    const parsed = parseTokenV1(tampered)._unsafeUnwrap();
    const verified = verifyTokenSignatureV1(parsed, keyring, hmac);
    expect(verified.isErr()).toBe(true);
    if (verified.isErr()) {
      expect(verified.error.code).toBe('TOKEN_BAD_SIGNATURE');
    }
  });
});
