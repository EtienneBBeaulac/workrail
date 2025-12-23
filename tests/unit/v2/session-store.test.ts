import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ResultAsync as RA } from 'neverthrow';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../../src/v2/infra/local/sha256/index.js';
import { LocalSessionLockV2 } from '../../../src/v2/infra/local/session-lock/index.js';
import { LocalSessionEventLogStoreV2 } from '../../../src/v2/infra/local/session-store/index.js';

import { asSessionId, asSha256Digest, asSnapshotRef } from '../../../src/v2/durable-core/ids/index.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';
import type { FileSystemPortV2, FsError } from '../../../src/v2/ports/fs.port.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-'));
}

describe('v2 local session store (Slice 2 substrate)', () => {
  it('lock is fail-fast: second acquire returns SESSION_LOCK_BUSY until released', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const lock = new LocalSessionLockV2(dataDir, fsPort);

    const sessionId = asSessionId('sess_test_lock');

    const h1 = await lock.acquire(sessionId).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected lock acquire error: ${e.code}`);
      }
    );

    const second = await lock.acquire(sessionId).match(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, error: e })
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('SESSION_LOCK_BUSY');
    }

    await lock.release(h1).match(
      () => undefined,
      (e) => {
        throw new Error(`unexpected lock release error: ${e.code}`);
      }
    );

    const third = await lock.acquire(sessionId).match(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, error: e })
    );
    expect(third.ok).toBe(true);
  });

  it('load ignores orphan segments (no manifest.segment_closed => no scan)', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const sha = new NodeSha256V2();
    const lock = new LocalSessionLockV2(dataDir, fsPort);
    const store = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha, lock);

    const sessionId = asSessionId('sess_test_orphan');

    // Create an orphan segment file without any manifest record.
    const eventsDir = dataDir.sessionEventsDir(sessionId);
    await fs.mkdir(eventsDir, { recursive: true });
    await fs.writeFile(path.join(eventsDir, '00000000-00000000.jsonl'), Buffer.from('{"v":1}\n'));

    const loaded = await store.load(sessionId).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected load error: ${e.code}`);
      }
    );
    expect(loaded.manifest.length).toBe(0);
    expect(loaded.events.length).toBe(0);
  });

  it('load fails on digest mismatch for a committed segment', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const sha = new NodeSha256V2();
    const lock = new LocalSessionLockV2(dataDir, fsPort);
    const store = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha, lock);

    const sessionId = asSessionId('sess_test_digest');

    const evt: DomainEventV1 = {
      v: 1,
      eventId: 'evt_1',
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: `session_created:${sessionId}`,
      data: {},
    };

    const snapshotRef = asSnapshotRef(asSha256Digest('sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11'));
    await store
      .append(sessionId, {
        events: [evt],
        snapshotPins: [{ snapshotRef, eventIndex: 0, createdByEventId: 'evt_1' }],
      })
      .match(
        () => undefined,
        (e) => {
          throw new Error(`unexpected append error: ${e.code}`);
        }
      );

    // Tamper with the committed segment contents but keep manifest unchanged.
    const segmentPath = path.join(dataDir.sessionDir(sessionId), 'events', '00000000-00000000.jsonl');
    await fs.writeFile(segmentPath, Buffer.from('{"tampered":true}\n'));

    const loaded = await store.load(sessionId).match(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, error: e })
    );
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('SESSION_STORE_CORRUPTION_DETECTED');
    }
  });

  it('crash after segment_closed but before snapshot_pinned is corruption (pin-after-close lock)', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const baseFs = new NodeFileSystemV2();
    const sha = new NodeSha256V2();

    const sessionId = asSessionId('sess_test_pin_after_close');
    const manifestPath = dataDir.sessionManifestPath(sessionId);

    // Fail on the SECOND manifest append (pins), simulating a crash after segment_closed was committed.
    // Important: do not use object spread for class instances (methods are on prototype and not enumerable).
    let openAppendCount = 0;
    const failingFs: FileSystemPortV2 = {
      mkdirp: (p) => baseFs.mkdirp(p),
      readFileUtf8: (p) => baseFs.readFileUtf8(p),
      readFileBytes: (p) => baseFs.readFileBytes(p),
      writeFileBytes: (p, b) => baseFs.writeFileBytes(p, b),
      openWriteTruncate: (p) => baseFs.openWriteTruncate(p),
      openAppend: (filePath: string) => {
        if (filePath === manifestPath) {
          openAppendCount++;
          if (openAppendCount >= 2) {
            return RA.err<FsError>({ code: 'FS_IO_ERROR', message: 'simulated crash during pin append' });
          }
        }
        return baseFs.openAppend(filePath);
      },
      writeAll: (fd, b) => baseFs.writeAll(fd, b),
      openExclusive: (p, b) => baseFs.openExclusive(p, b),
      fsyncFile: (fd) => baseFs.fsyncFile(fd),
      fsyncDir: (p) => baseFs.fsyncDir(p),
      closeFile: (fd) => baseFs.closeFile(fd),
      rename: (a, b) => baseFs.rename(a, b),
      unlink: (p) => baseFs.unlink(p),
      stat: (p) => baseFs.stat(p),
    };

    const lock = new LocalSessionLockV2(dataDir, failingFs);
    const store = new LocalSessionEventLogStoreV2(dataDir, failingFs, sha, lock);

    const snapshotRef = asSnapshotRef(asSha256Digest('sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11'));
    const nodeCreated: DomainEventV1 = {
      v: 1,
      eventId: 'evt_node_1',
      eventIndex: 0,
      sessionId,
      kind: 'node_created',
      dedupeKey: `node_created:${sessionId}:run_1:node_1`,
      scope: { runId: 'run_1', nodeId: 'node_1' },
      data: {
        nodeKind: 'step',
        parentNodeId: null,
        workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        snapshotRef,
      },
    };

    const appendRes = await store.append(sessionId, {
      events: [nodeCreated],
      snapshotPins: [{ snapshotRef, eventIndex: 0, createdByEventId: 'evt_node_1' }],
    });
    const appended = await appendRes.match(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, error: e })
    );
    expect(appended.ok).toBe(false);

    // A normal load must now fail fast because the segment was closed but pins were not appended.
    const loaded = await store.load(sessionId).match(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, error: e })
    );
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('SESSION_STORE_CORRUPTION_DETECTED');
    }
  });

  it('append is idempotent: replaying the same events by dedupeKey is a no-op', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const sha = new NodeSha256V2();
    const lock = new LocalSessionLockV2(dataDir, fsPort);
    const store = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha, lock);

    const sessionId = asSessionId('sess_test_idempotency');
    const snapshotRef = asSnapshotRef(asSha256Digest('sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11'));

    const evt: DomainEventV1 = {
      v: 1,
      eventId: 'evt_1',
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: `session_created:${sessionId}`,
      data: {},
    };

    await store
      .append(sessionId, { events: [evt], snapshotPins: [{ snapshotRef, eventIndex: 0, createdByEventId: 'evt_1' }] })
      .match(
        () => undefined,
        (e) => {
          throw new Error(`unexpected append error: ${e.code}`);
        }
      );

    // Replay the same append (same dedupeKey).
    await store
      .append(sessionId, { events: [evt], snapshotPins: [{ snapshotRef, eventIndex: 0, createdByEventId: 'evt_1' }] })
      .match(
        () => undefined,
        (e) => {
          throw new Error(`unexpected append error on replay: ${e.code}`);
        }
      );

    // Load and verify only one event exists.
    const loaded = await store.load(sessionId).match(
      (v) => v,
      (e) => {
        throw new Error(`unexpected load error: ${e.code}`);
      }
    );
    expect(loaded.events.length).toBe(1);
  });
});
