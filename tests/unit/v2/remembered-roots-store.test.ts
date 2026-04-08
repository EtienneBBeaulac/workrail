import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeTimeClockV2 } from '../../../src/v2/infra/local/time-clock/index.js';
import { LocalRememberedRootsStoreV2 } from '../../../src/v2/infra/local/remembered-roots-store/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-remembered-roots-'));
}

describe('v2 remembered roots store', () => {
  it('persists and reloads remembered roots across store instances', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();

    const storeA = new LocalRememberedRootsStoreV2(dataDir, fsPort, new NodeTimeClockV2());
    const rememberResult = await storeA.rememberRoot(path.join(os.tmpdir(), 'project-a'));
    expect(rememberResult.isOk()).toBe(true);

    const storeB = new LocalRememberedRootsStoreV2(dataDir, fsPort, new NodeTimeClockV2());
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
    const store = new LocalRememberedRootsStoreV2(dataDir, fsPort, new NodeTimeClockV2());

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

    const store = new LocalRememberedRootsStoreV2(dataDir, new NodeFileSystemV2(), new NodeTimeClockV2());
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

    const store = new LocalRememberedRootsStoreV2(dataDir, new NodeFileSystemV2(), new NodeTimeClockV2());
    const result = await store.rememberRoot(path.join(os.tmpdir(), 'project-a'));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('REMEMBERED_ROOTS_BUSY');
  });

  it('evicts roots not seen in the last 30 days on next rememberRoot write', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();

    // Write a stale root record directly to the data file, bypassing rememberRoot,
    // with lastSeenAtMs 31 days in the past.
    const stalePath = path.resolve(path.join(root, 'stale-project'));
    const freshPath = path.resolve(path.join(root, 'fresh-project'));
    const nowMs = Date.now();
    const staleMs = nowMs - (31 * 24 * 60 * 60 * 1000);
    const filePath = dataDir.rememberedRootsPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({ v: 1, roots: [{ path: stalePath, addedAtMs: staleMs, lastSeenAtMs: staleMs, source: 'explicit_workspace_path' }] }),
      'utf8',
    );

    // rememberRoot for a fresh path -- this triggers lazy TTL eviction
    const store = new LocalRememberedRootsStoreV2(dataDir, fsPort, new NodeTimeClockV2());
    const result = await store.rememberRoot(freshPath);
    expect(result.isOk()).toBe(true);

    // Stale root should be gone; fresh root should be present
    const roots = await store.listRoots();
    expect(roots.isOk()).toBe(true);
    const rootList = roots._unsafeUnwrap();
    expect(rootList).not.toContain(stalePath);
    expect(rootList).toContain(freshPath);
  });
});
