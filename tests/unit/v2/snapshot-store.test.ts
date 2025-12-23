import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../../../src/v2/infra/local/snapshot-store/index.js';
import { ExecutionSnapshotFileV1Schema } from '../../../src/v2/durable-core/schemas/execution-snapshot/index.js';
import { snapshotRefForExecutionSnapshotFileV1 } from '../../../src/v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../../src/v2/durable-core/canonical/json-types.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-'));
}

describe('v2 snapshot CAS store (Slice 3 prereq)', () => {
  it('put -> get roundtrip and ref matches sha256(JCS(snapshot))', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const crypto = new NodeCryptoV2();
    const store = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);

    const snapshot = ExecutionSnapshotFileV1Schema.parse({
      v: 1,
      kind: 'execution_snapshot',
      enginePayload: { v: 1, engineState: { kind: 'init' } },
    });

    const expected = snapshotRefForExecutionSnapshotFileV1(snapshot, crypto);
    expect(expected.isOk()).toBe(true);

    const ref = await store.putExecutionSnapshotV1(snapshot).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected put error: ${e.code}`);
      }
    );
    expect(String(ref)).toBe(String(expected._unsafeUnwrap()));

    const loaded = await store.getExecutionSnapshotV1(ref).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected get error: ${e.code}`);
      }
    );
    expect(loaded).not.toBeNull();
    expect(loaded as unknown as JsonValue).toEqual(snapshot as unknown as JsonValue);
  });

  it('get returns null when snapshot file is missing', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const crypto = new NodeCryptoV2();
    const store = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);

    // Use the golden execution-snapshot digest from Slice 1 test for a stable ref string.
    const missingRef = 'sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2';
    const loaded = await store.getExecutionSnapshotV1(missingRef as any).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected get error: ${e.code}`);
      }
    );
    expect(loaded).toBeNull();
  });
});
