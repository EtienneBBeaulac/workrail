import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { LocalManagedSourceStoreV2 } from '../../../src/v2/infra/local/managed-source-store/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-managed-sources-'));
}

describe('v2 managed source store', () => {
  it('persists and reloads attached sources across store instances', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();

    const storeA = new LocalManagedSourceStoreV2(dataDir, fsPort);
    const attachResult = await storeA.attach(path.join(os.tmpdir(), 'project-a', 'workflows'));
    expect(attachResult.isOk()).toBe(true);

    const storeB = new LocalManagedSourceStoreV2(dataDir, fsPort);
    const listResult = await storeB.list();
    expect(listResult.isOk()).toBe(true);
    expect(listResult._unsafeUnwrap()).toEqual([
      {
        path: path.resolve(path.join(os.tmpdir(), 'project-a', 'workflows')),
        addedAtMs: expect.any(Number),
      },
    ]);
  });

  it('attach is idempotent -- duplicate path does not add a second entry or update addedAtMs', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalManagedSourceStoreV2(dataDir, fsPort);

    const sourcePath = path.join(os.tmpdir(), 'project-b', 'workflows');
    expect((await store.attach(sourcePath)).isOk()).toBe(true);

    const [first] = (await store.list())._unsafeUnwrap();

    // Re-attach via both original and resolved path -- must remain idempotent
    expect((await store.attach(sourcePath)).isOk()).toBe(true);
    expect((await store.attach(path.resolve(sourcePath))).isOk()).toBe(true);

    const result = (await store.list())._unsafeUnwrap();
    expect(result).toHaveLength(1);
    // Port contract: addedAtMs must not be updated on re-attach
    expect(result[0]!.addedAtMs).toBe(first!.addedAtMs);
  });

  it('detach removes a source; second detach is a no-op', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalManagedSourceStoreV2(dataDir, fsPort);

    const sourcePath = path.join(os.tmpdir(), 'project-c', 'workflows');
    expect((await store.attach(sourcePath)).isOk()).toBe(true);
    expect((await store.list())._unsafeUnwrap()).toHaveLength(1);

    expect((await store.detach(sourcePath)).isOk()).toBe(true);
    expect((await store.list())._unsafeUnwrap()).toHaveLength(0);

    // Second detach: no-op, must not fail
    expect((await store.detach(sourcePath)).isOk()).toBe(true);
    expect((await store.list())._unsafeUnwrap()).toHaveLength(0);
  });

  it('re-attach after detach produces a fresh addedAtMs', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalManagedSourceStoreV2(dataDir, fsPort);

    const sourcePath = path.join(os.tmpdir(), 'project-e', 'workflows');
    expect((await store.attach(sourcePath)).isOk()).toBe(true);
    const [first] = (await store.list())._unsafeUnwrap();

    expect((await store.detach(sourcePath)).isOk()).toBe(true);
    expect((await store.list())._unsafeUnwrap()).toHaveLength(0);

    // Small delay to ensure addedAtMs can differ if implementation re-timestamps
    await new Promise((resolve) => setTimeout(resolve, 2));

    expect((await store.attach(sourcePath)).isOk()).toBe(true);
    const result = (await store.list())._unsafeUnwrap();
    expect(result).toHaveLength(1);
    // Re-attach is a fresh entry -- addedAtMs may be >= original
    expect(result[0]!.addedAtMs).toBeGreaterThanOrEqual(first!.addedAtMs);
  });

  it('list returns sources in stable insertion order', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalManagedSourceStoreV2(dataDir, fsPort);

    const pathA = path.join(os.tmpdir(), 'alpha', 'workflows');
    const pathB = path.join(os.tmpdir(), 'beta', 'workflows');

    expect((await store.attach(pathA)).isOk()).toBe(true);
    expect((await store.attach(pathB)).isOk()).toBe(true);

    const result = (await store.list())._unsafeUnwrap();
    expect(result).toHaveLength(2);
    expect(result[0]!.path).toBe(path.resolve(pathA));
    expect(result[1]!.path).toBe(path.resolve(pathB));
  });

  it('list returns empty array when file does not exist yet', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalManagedSourceStoreV2(dataDir, fsPort);

    const listResult = await store.list();
    expect(listResult.isOk()).toBe(true);
    expect(listResult._unsafeUnwrap()).toEqual([]);
  });

  it('returns MANAGED_SOURCE_CORRUPTION for invalid JSON', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const filePath = dataDir.managedSourcesPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{invalid json', 'utf8');

    const store = new LocalManagedSourceStoreV2(dataDir, new NodeFileSystemV2());
    const result = await store.list();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('MANAGED_SOURCE_CORRUPTION');
  });

  it('returns MANAGED_SOURCE_CORRUPTION for valid JSON with invalid Zod schema', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const filePath = dataDir.managedSourcesPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Valid JSON but wrong shape (missing required fields, wrong types)
    await fs.writeFile(filePath, JSON.stringify({ v: 1, sources: [{ wrong: 'field' }] }), 'utf8');

    const store = new LocalManagedSourceStoreV2(dataDir, new NodeFileSystemV2());
    const result = await store.list();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('MANAGED_SOURCE_CORRUPTION');
  });

  it('returns MANAGED_SOURCE_BUSY when lock file already exists', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const lockPath = dataDir.managedSourcesLockPath();
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, 'locked', 'utf8');

    const store = new LocalManagedSourceStoreV2(dataDir, new NodeFileSystemV2());
    const result = await store.attach(path.join(os.tmpdir(), 'project-d'));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('MANAGED_SOURCE_BUSY');
  });
});
