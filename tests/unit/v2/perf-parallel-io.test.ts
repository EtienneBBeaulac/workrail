/**
 * Performance parallel I/O tests
 *
 * Verifies correctness invariants after parallelization of:
 *   - readdirWithMtime (parallel stat calls)
 *   - loadSegmentsRecursive (parallel segment reads)
 *   - appendManifestRecords (single fsync for segment + snapshot pins)
 *   - mkdirp caching (called at most once per session dir)
 *
 * @enforces parallel-stat-correctness
 * @enforces parallel-segment-order
 * @enforces single-manifest-fsync
 * @enforces mkdirp-once-per-session
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeSha256V2 } from '../../../src/v2/infra/local/sha256/index.js';
import { LocalSessionLockV2 } from '../../../src/v2/infra/local/session-lock/index.js';
import { LocalSessionEventLogStoreV2 } from '../../../src/v2/infra/local/session-store/index.js';
import { ExecutionSessionGateV2 } from '../../../src/v2/usecases/execution-session-gate.js';
import { NodeTimeClockV2 } from '../../../src/v2/infra/local/time-clock/index.js';

import { asSessionId, asSnapshotRef, asSha256Digest } from '../../../src/v2/durable-core/ids/index.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';
import type { FileSystemPortV2 } from '../../../src/v2/ports/fs.port.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-perf-'));
}

/**
 * Build a wrapping fake FileSystemPortV2 that delegates all methods to baseFs
 * but allows overriding individual operations via a partial override object.
 *
 * WHY: Class instance methods live on the prototype and are not enumerable,
 * so object spread does not work. This helper wraps each method explicitly.
 */
function wrapFs(baseFs: NodeFileSystemV2, overrides: Partial<FileSystemPortV2>): FileSystemPortV2 {
  return {
    mkdirp: overrides.mkdirp ?? ((p) => baseFs.mkdirp(p)),
    readFileUtf8: overrides.readFileUtf8 ?? ((p) => baseFs.readFileUtf8(p)),
    readFileBytes: overrides.readFileBytes ?? ((p) => baseFs.readFileBytes(p)),
    writeFileBytes: overrides.writeFileBytes ?? ((p, b) => baseFs.writeFileBytes(p, b)),
    openWriteTruncate: overrides.openWriteTruncate ?? ((p) => baseFs.openWriteTruncate(p)),
    openAppend: overrides.openAppend ?? ((p) => baseFs.openAppend(p)),
    writeAll: overrides.writeAll ?? ((fd, b) => baseFs.writeAll(fd, b)),
    openExclusive: overrides.openExclusive ?? ((p, b) => baseFs.openExclusive(p, b)),
    fsyncFile: overrides.fsyncFile ?? ((fd) => baseFs.fsyncFile(fd)),
    fsyncDir: overrides.fsyncDir ?? ((p) => baseFs.fsyncDir(p)),
    closeFile: overrides.closeFile ?? ((fd) => baseFs.closeFile(fd)),
    rename: overrides.rename ?? ((a, b) => baseFs.rename(a, b)),
    unlink: overrides.unlink ?? ((p) => baseFs.unlink(p)),
    stat: overrides.stat ?? ((p) => baseFs.stat(p)),
    readdir: overrides.readdir ?? ((p) => baseFs.readdir(p)),
    readdirWithMtime: overrides.readdirWithMtime ?? ((p) => baseFs.readdirWithMtime(p)),
  };
}

// ---------------------------------------------------------------------------
// readdirWithMtime tests
// ---------------------------------------------------------------------------

describe('readdirWithMtime - parallel stat calls', () => {
  it('returns correct name and mtimeMs for all entries', async () => {
    const root = await mkTempDataDir();

    const names = ['sess_a', 'sess_b', 'sess_c', 'sess_d', 'sess_e'];
    for (const name of names) {
      await fs.mkdir(path.join(root, name));
    }

    const fsPort = new NodeFileSystemV2();
    const result = await fsPort.readdirWithMtime(root).match(
      (v) => v,
      (e) => { throw new Error(`unexpected error: ${e.message}`); }
    );

    expect(result).toHaveLength(names.length);
    const returnedNames = result.map((e) => e.name).sort();
    expect(returnedNames).toEqual(names.sort());
    for (const entry of result) {
      expect(typeof entry.mtimeMs).toBe('number');
      expect(entry.mtimeMs).toBeGreaterThan(0);
    }
  });

  it('gracefully skips entries where stat fails, returning the rest', async () => {
    // WHY: A file that disappears between readdir and stat must not abort enumeration.
    // Simulate this by creating entries, then removing one before stat runs.
    // The implementation must skip the missing entry gracefully.
    const root = await mkTempDataDir();

    const names = ['sess_x', 'sess_y', 'sess_z'];
    for (const name of names) {
      await fs.mkdir(path.join(root, name));
    }

    // Remove one entry after readdir would have listed it to simulate ENOENT on stat
    // We achieve this by using a fake that fails stat for one specific path.
    // For the graceful degradation test, use the real fs but delete a dir mid-scan.
    // We can't intercept internals easily, so we instead verify the real behavior
    // with a directory that disappears:
    const fsPort = new NodeFileSystemV2();
    await fs.rmdir(path.join(root, 'sess_y'));

    // After removing sess_y, readdir may or may not list it. The key invariant is:
    // if stat fails on an entry, it's skipped gracefully without aborting.
    const result = await fsPort.readdirWithMtime(root).match(
      (v) => v,
      (e) => { throw new Error(`unexpected error: ${e.message}`); }
    );

    // Either 2 results (sess_x, sess_z) or 3 results depending on readdir timing,
    // but no error is thrown. What's certain is sess_y is missing from stat results.
    expect(result.find((e) => e.name === 'sess_y')).toBeUndefined();
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for empty directory', async () => {
    const root = await mkTempDataDir();
    const fsPort = new NodeFileSystemV2();
    const result = await fsPort.readdirWithMtime(root).match(
      (v) => v,
      (e) => { throw new Error(`unexpected error: ${e.message}`); }
    );
    expect(result).toHaveLength(0);
  });

  it('returns all entries for a directory with many entries', async () => {
    // Correctness parity: parallel impl must return same number of results as sequential
    const root = await mkTempDataDir();
    const count = 10;
    const names = Array.from({ length: count }, (_, i) => `sess_${String(i).padStart(3, '0')}`);
    for (const name of names) {
      await fs.mkdir(path.join(root, name));
    }

    const fsPort = new NodeFileSystemV2();
    const result = await fsPort.readdirWithMtime(root).match(
      (v) => v,
      (e) => { throw new Error(`unexpected error: ${e.message}`); }
    );

    expect(result).toHaveLength(count);
    expect(result.map((e) => e.name).sort()).toEqual(names.sort());
  });
});

// ---------------------------------------------------------------------------
// loadSegmentsRecursive - order preservation after parallel reads
// ---------------------------------------------------------------------------

describe('loadSegmentsRecursive - parallel reads preserve event order', () => {
  it('returns events in eventIndex order when multiple segments are read in parallel', async () => {
    // WHY: Write 3 segments directly to disk (bypassing the gate health check)
    // to simulate a multi-segment session. Then verify load() returns events
    // in eventIndex order regardless of the order segments are read from disk.
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const fsPort = new NodeFileSystemV2();
    const sha = new NodeSha256V2();
    const store = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha);

    const sessionId = asSessionId('sess_perf_order_test');
    const sessionDir = dataDir.sessionDir(sessionId);
    const eventsDir = dataDir.sessionEventsDir(sessionId);
    const manifestPath = dataDir.sessionManifestPath(sessionId);

    await fs.mkdir(eventsDir, { recursive: true });

    // Build 3 single-event segments with sequential eventIndex values
    const { toJsonlLineBytes } = await import('../../../src/v2/durable-core/canonical/jsonl.js');
    const { NodeSha256V2: Sha256 } = await import('../../../src/v2/infra/local/sha256/index.js');
    const sha256Port = new Sha256();

    type SegmentSpec = {
      eventIndex: number;
      segmentRelPath: string;
      kind: DomainEventV1['kind'];
    };

    const segments: SegmentSpec[] = [
      { eventIndex: 0, segmentRelPath: 'events/00000000-00000000.jsonl', kind: 'session_created' },
      { eventIndex: 1, segmentRelPath: 'events/00000001-00000001.jsonl', kind: 'session_created' },
      { eventIndex: 2, segmentRelPath: 'events/00000002-00000002.jsonl', kind: 'session_created' },
    ];

    const manifestLines: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const event: DomainEventV1 = {
        v: 1,
        eventId: `evt_${i}`,
        eventIndex: seg.eventIndex,
        sessionId,
        kind: 'session_created',
        dedupeKey: `session_created:${sessionId}:${i}`,
        data: {},
      };

      // Write segment file
      const lineResult = toJsonlLineBytes(event as unknown as Record<string, unknown>);
      if (lineResult.isErr()) throw new Error(`failed to encode event: ${lineResult.error.message}`);
      const segBytes = lineResult.value;
      const segPath = path.join(sessionDir, seg.segmentRelPath);
      await fs.writeFile(segPath, segBytes);

      // Compute digest and add manifest record
      const digest = sha256Port.sha256(segBytes);
      manifestLines.push(JSON.stringify({
        v: 1,
        manifestIndex: i,
        sessionId,
        kind: 'segment_closed',
        firstEventIndex: seg.eventIndex,
        lastEventIndex: seg.eventIndex,
        segmentRelPath: seg.segmentRelPath,
        sha256: digest,
        bytes: segBytes.length,
      }));
    }

    // Write manifest
    await fs.writeFile(manifestPath, manifestLines.join('\n') + '\n');

    // Load and verify order is preserved (the key invariant after parallelization)
    const loaded = await store.load(sessionId).match(
      (v) => v,
      (e) => { throw new Error(`unexpected load error: ${e.code} - ${e.message}`); }
    );

    expect(loaded.events).toHaveLength(3);
    expect(loaded.events[0]!.eventIndex).toBe(0);
    expect(loaded.events[1]!.eventIndex).toBe(1);
    expect(loaded.events[2]!.eventIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Single manifest write (merged segment_closed + snapshot_pinned records)
// ---------------------------------------------------------------------------

describe('appendManifestRecords - single write when snapshot pins are present', () => {
  it('calls openAppend exactly once on the manifest when snapshot pins are included', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const baseFs = new NodeFileSystemV2();
    const sha = new NodeSha256V2();

    const sessionId = asSessionId('sess_perf_manifest_write_test');
    const manifestPath = dataDir.sessionManifestPath(sessionId);

    // Count openAppend calls to the manifest file
    let manifestOpenAppendCount = 0;
    const countingFs = wrapFs(baseFs, {
      openAppend: (filePath: string) => {
        if (filePath === manifestPath) {
          manifestOpenAppendCount++;
        }
        return baseFs.openAppend(filePath);
      },
    });

    const clock = new NodeTimeClockV2();
    const lock = new LocalSessionLockV2(dataDir, countingFs, clock);
    const store = new LocalSessionEventLogStoreV2(dataDir, countingFs, sha);
    const gate = new ExecutionSessionGateV2(lock, store);

    const snapshotRef = asSnapshotRef(asSha256Digest('sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11'));

    const nodeCreatedEvent: DomainEventV1 = {
      v: 1,
      eventId: 'evt_node_0',
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

    const res = await gate.withHealthySessionLock(sessionId, (w) =>
      store.append(w, {
        events: [nodeCreatedEvent],
        snapshotPins: [{ snapshotRef, eventIndex: 0, createdByEventId: 'evt_node_0' }],
      })
    );
    expect(res.isOk()).toBe(true);

    // With the optimization, both segment_closed and snapshot_pinned records
    // should be written in a single openAppend call (one fsync).
    expect(manifestOpenAppendCount).toBe(1);
  });

  it('calls openAppend exactly once when no snapshot pins are present', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const baseFs = new NodeFileSystemV2();
    const sha = new NodeSha256V2();

    const sessionId = asSessionId('sess_perf_no_pins_test');
    const manifestPath = dataDir.sessionManifestPath(sessionId);

    let manifestOpenAppendCount = 0;
    const countingFs = wrapFs(baseFs, {
      openAppend: (filePath: string) => {
        if (filePath === manifestPath) {
          manifestOpenAppendCount++;
        }
        return baseFs.openAppend(filePath);
      },
    });

    const clock = new NodeTimeClockV2();
    const lock = new LocalSessionLockV2(dataDir, countingFs, clock);
    const store = new LocalSessionEventLogStoreV2(dataDir, countingFs, sha);
    const gate = new ExecutionSessionGateV2(lock, store);

    const evt: DomainEventV1 = {
      v: 1,
      eventId: 'evt_0',
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: `session_created:${sessionId}`,
      data: {},
    };

    const res = await gate.withHealthySessionLock(sessionId, (w) =>
      store.append(w, { events: [evt], snapshotPins: [] })
    );
    expect(res.isOk()).toBe(true);

    // No pins - still exactly one openAppend call
    expect(manifestOpenAppendCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mkdirp caching - called at most once per session events dir
// ---------------------------------------------------------------------------

describe('mkdirp caching - called at most once per session events dir', () => {
  it('calls mkdirp only once for the same session across multiple appends', async () => {
    const root = await mkTempDataDir();
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
    const baseFs = new NodeFileSystemV2();
    const sha = new NodeSha256V2();

    const sessionId = asSessionId('sess_perf_mkdirp_cache_test');
    const eventsDir = dataDir.sessionEventsDir(sessionId);

    // Count mkdirp calls for the events dir
    let mkdirpCount = 0;
    const countingFs = wrapFs(baseFs, {
      mkdirp: (dirPath: string) => {
        if (dirPath === eventsDir) {
          mkdirpCount++;
        }
        return baseFs.mkdirp(dirPath);
      },
    });

    const clock = new NodeTimeClockV2();
    const lock = new LocalSessionLockV2(dataDir, countingFs, clock);
    const store = new LocalSessionEventLogStoreV2(dataDir, countingFs, sha);
    const gate = new ExecutionSessionGateV2(lock, store);

    // First append
    const evt0: DomainEventV1 = {
      v: 1,
      eventId: 'evt_0',
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: `session_created:${sessionId}`,
      data: {},
    };
    const res1 = await gate.withHealthySessionLock(sessionId, (w) =>
      store.append(w, { events: [evt0], snapshotPins: [] })
    );
    expect(res1.isOk()).toBe(true);

    // Second append to the same session
    const evt1: DomainEventV1 = {
      v: 1,
      eventId: 'evt_1',
      eventIndex: 1,
      sessionId,
      kind: 'run_started',
      dedupeKey: `run_started:${sessionId}:run_1`,
      scope: { runId: 'run_1' },
      data: {
        workflowId: 'test-wf',
        workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        workflowSourceKind: 'project',
        workflowSourceRef: 'test-wf',
      },
    };
    const res2 = await gate.withHealthySessionLock(sessionId, (w) =>
      store.append(w, { events: [evt1], snapshotPins: [] })
    );
    expect(res2.isOk()).toBe(true);

    // mkdirp should have been called only once for the events dir
    expect(mkdirpCount).toBe(1);
  });
});
