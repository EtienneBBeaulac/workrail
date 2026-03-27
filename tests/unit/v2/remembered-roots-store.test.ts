import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { LocalRememberedRootsStoreV2 } from '../../../src/v2/infra/local/remembered-roots-store/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-remembered-roots-'));
}

describe('v2 remembered roots store', () => {
  it('persists and reloads remembered roots across store instances', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();

    const storeA = new LocalRememberedRootsStoreV2(dataDir, fsPort);
    const rememberResult = await storeA.rememberRoot(path.join(os.tmpdir(), 'project-a'));
    expect(rememberResult.isOk()).toBe(true);

    const storeB = new LocalRememberedRootsStoreV2(dataDir, fsPort);
    const rootsResult = await storeB.listRoots();
    expect(rootsResult.isOk()).toBe(true);
    expect(rootsResult._unsafeUnwrap()).toEqual([path.resolve(path.join(os.tmpdir(), 'project-a'))]);

    const recordsResult = await storeB.listRootRecords();
    expect(recordsResult.isOk()).toBe(true);
    expect(recordsResult._unsafeUnwrap()).toMatchObject([
      {
        path: path.resolve(path.join(os.tmpdir(), 'project-a')),
        source: 'explicit_workspace_path',
      },
    ]);
  });

  it('deduplicates repeated remembered roots', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalRememberedRootsStoreV2(dataDir, fsPort);

    expect((await store.rememberRoot(path.join(os.tmpdir(), 'project-a'))).isOk()).toBe(true);
    expect((await store.rememberRoot(path.join(os.tmpdir(), 'project-a'))).isOk()).toBe(true);
    expect((await store.rememberRoot(path.resolve(path.join(os.tmpdir(), 'project-a')))).isOk()).toBe(true);

    const rootsResult = await store.listRoots();
    expect(rootsResult.isOk()).toBe(true);
    expect(rootsResult._unsafeUnwrap()).toEqual([path.resolve(path.join(os.tmpdir(), 'project-a'))]);

    const recordsResult = await store.listRootRecords();
    expect(recordsResult.isOk()).toBe(true);
    const [record] = recordsResult._unsafeUnwrap();
    expect(record).toBeDefined();
    expect(record?.addedAtMs).toBeLessThanOrEqual(record?.lastSeenAtMs ?? 0);
  });

  it('returns corruption error for invalid remembered roots JSON', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const filePath = dataDir.rememberedRootsPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{invalid json', 'utf8');

    const store = new LocalRememberedRootsStoreV2(dataDir, new NodeFileSystemV2());
    const result = await store.listRoots();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('REMEMBERED_ROOTS_CORRUPTION');
  });

  it('returns busy error when another process holds the remembered-roots lock', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const filePath = dataDir.rememberedRootsLockPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'locked', 'utf8');

    const store = new LocalRememberedRootsStoreV2(dataDir, new NodeFileSystemV2());
    const result = await store.rememberRoot(path.join(os.tmpdir(), 'project-a'));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('REMEMBERED_ROOTS_BUSY');
  });
});
