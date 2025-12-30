/**
 * Test suite for in-memory fakes.
 *
 * Verifies that all fakes implement their port contracts correctly:
 * - InMemorySessionEventLogStore: ordering, idempotency, atomicity
 * - InMemorySnapshotStore: content-addressing, get returns null for missing
 * - InMemoryPinnedWorkflowStore: idempotent get/put
 * - InMemorySessionLock: mutual exclusion, fail-fast on busy
 * - InMemoryKeyring: loadOrCreate, rotate
 * - InMemoryFileSystem: all filesystem operations
 *
 * @enforces test-fakes-exist
 * @enforces test-fakes-implement-ports
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySessionEventLogStore } from './session-event-log-store.fake.js';
import { InMemorySnapshotStore } from './snapshot-store.fake.js';
import { InMemoryPinnedWorkflowStore } from './pinned-workflow-store.fake.js';
import { InMemorySessionLock } from './session-lock.fake.js';
import { InMemoryKeyring } from './keyring.fake.js';
import { InMemoryFileSystem } from './file-system.fake.js';
import { asSessionId, asEventId, asEventIndex, asSha256Digest, asSnapshotRef, asWorkflowHash } from '../../../src/v2/durable-core/ids/index.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';
import { ExecutionSessionGateV2 } from '../../../src/v2/usecases/execution-session-gate.js';

describe('InMemorySessionEventLogStore', () => {
  let store: InMemorySessionEventLogStore;
  let lockPort: InMemorySessionLock;
  let gate: ExecutionSessionGateV2;

  beforeEach(() => {
    store = new InMemorySessionEventLogStore();
    lockPort = new InMemorySessionLock();
    gate = new ExecutionSessionGateV2(lockPort, store);
  });

  it('loads empty session as { events: [], manifest: [] }', async () => {
    const sessionId = asSessionId('sess_load_empty');
    const result = await store.load(sessionId);

    expect(result.isOk()).toBe(true);
    const loaded = result._unsafeUnwrap();
    expect(loaded.events).toEqual([]);
    expect(loaded.manifest).toEqual([]);
  });

  it('appends events with contiguous eventIndex', async () => {
    const sessionId = asSessionId('sess_contiguous');

    const event0: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_0'),
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: 'sk_0',
      data: {},
    };

    const event1: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_1'),
      eventIndex: 1,
      sessionId,
      kind: 'run_started',
      dedupeKey: 'sk_1',
      data: { runId: 'run_1' },
    };

    // Use gate to acquire lock
    const appendResult = await gate.withHealthySessionLock(sessionId, (lock) =>
      store.append(lock, { events: [event0, event1], snapshotPins: [] }),
    );

    expect(appendResult.isOk()).toBe(true);

    // Verify events were appended
    const loadResult = await store.load(sessionId);
    expect(loadResult.isOk()).toBe(true);
    const loaded = loadResult._unsafeUnwrap();
    expect(loaded.events).toHaveLength(2);
    expect(loaded.events[0].eventIndex).toBe(0);
    expect(loaded.events[1].eventIndex).toBe(1);
  });

  it('rejects out-of-order eventIndex', async () => {
    const sessionId = asSessionId('sess_out_of_order');

    const event0: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_0'),
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: 'sk_0',
      data: {},
    };

    const badEvent: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_bad'),
      eventIndex: 99, // Out of order!
      sessionId,
      kind: 'run_started',
      dedupeKey: 'sk_bad',
      data: {},
    };

    const appendResult = await gate.withHealthySessionLock(sessionId, (lock) =>
      store.append(lock, { events: [event0, badEvent], snapshotPins: [] }),
    );

    expect(appendResult.isErr()).toBe(true);
    const error = appendResult._unsafeUnwrapErr();
    expect(error.code).toBe('SESSION_STORE_INVARIANT_VIOLATION');
  });

  it('is idempotent: replaying same dedupeKeys is no-op', async () => {
    const sessionId = asSessionId('sess_idempotent');

    const event0: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_0'),
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: 'sk_0',
      data: {},
    };

    // First append
    const result1 = await gate.withHealthySessionLock(sessionId, (lock) =>
      store.append(lock, { events: [event0], snapshotPins: [] }),
    );
    expect(result1.isOk()).toBe(true);

    // Second append (same dedupeKey) should be no-op
    const result2 = await gate.withHealthySessionLock(sessionId, (lock) =>
      store.append(lock, { events: [event0], snapshotPins: [] }),
    );
    expect(result2.isOk()).toBe(true);

    // Verify only one event in store
    const loaded = (await store.load(sessionId))._unsafeUnwrap();
    expect(loaded.events).toHaveLength(1);
  });

  it('rejects partial idempotency (some exist, some do not)', async () => {
    const sessionId = asSessionId('sess_partial');

    const event0: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_0'),
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: 'sk_0',
      data: {},
    };

    const event1: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_1'),
      eventIndex: 1,
      sessionId,
      kind: 'run_started',
      dedupeKey: 'sk_1',
      data: {},
    };

    // Append event0 only
    const result1 = await gate.withHealthySessionLock(sessionId, (lock) =>
      store.append(lock, { events: [event0], snapshotPins: [] }),
    );
    expect(result1.isOk()).toBe(true);

    // Try to append both event0 and event1: should fail (partial collision)
    const result2 = await gate.withHealthySessionLock(sessionId, (lock) =>
      store.append(lock, { events: [event0, event1], snapshotPins: [] }),
    );

    expect(result2.isErr()).toBe(true);
    const error = result2._unsafeUnwrapErr();
    expect(error.code).toBe('SESSION_STORE_INVARIANT_VIOLATION');
  });
});

describe('InMemorySnapshotStore', () => {
  let store: InMemorySnapshotStore;

  beforeEach(() => {
    store = new InMemorySnapshotStore();
  });

  it('stores and retrieves snapshots', async () => {
    const snapshot = {
      v: 1 as const,
      kind: 'execution_snapshot' as const,
      executionState: {},
    };

    const refResult = await store.putExecutionSnapshotV1(snapshot);
    expect(refResult.isOk()).toBe(true);
    const ref = refResult._unsafeUnwrap();

    const getResult = await store.getExecutionSnapshotV1(ref);
    expect(getResult.isOk()).toBe(true);
    const retrieved = getResult._unsafeUnwrap();
    expect(retrieved).toEqual(snapshot);
  });

  it('returns null for missing snapshot', async () => {
    const ref = asSnapshotRef(asSha256Digest('sha256:' + '0'.repeat(64)));
    const result = await store.getExecutionSnapshotV1(ref);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('is idempotent: same snapshot → same ref', async () => {
    const snapshot = {
      v: 1 as const,
      kind: 'execution_snapshot' as const,
      executionState: { some: 'data' },
    };

    const ref1 = (await store.putExecutionSnapshotV1(snapshot))._unsafeUnwrap();
    const ref2 = (await store.putExecutionSnapshotV1(snapshot))._unsafeUnwrap();

    expect(String(ref1)).toBe(String(ref2));
  });
});

describe('InMemoryPinnedWorkflowStore', () => {
  let store: InMemoryPinnedWorkflowStore;

  beforeEach(() => {
    store = new InMemoryPinnedWorkflowStore();
  });

  it('stores and retrieves workflows by hash', async () => {
    const hash = asWorkflowHash(asSha256Digest('sha256:' + '1'.repeat(64)));
    const compiled = {
      v: 1 as const,
      kind: 'compiled_workflow' as const,
      nodes: [],
    };

    const putResult = await store.put(hash, compiled);
    expect(putResult.isOk()).toBe(true);

    const getResult = await store.get(hash);
    expect(getResult.isOk()).toBe(true);
    expect(getResult._unsafeUnwrap()).toEqual(compiled);
  });

  it('returns null for missing workflow', async () => {
    const hash = asWorkflowHash(asSha256Digest('sha256:' + '2'.repeat(64)));
    const result = await store.get(hash);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });

  it('is idempotent: put same hash twice', async () => {
    const hash = asWorkflowHash(asSha256Digest('sha256:' + '3'.repeat(64)));
    const compiled = { v: 1 as const, kind: 'compiled_workflow' as const, nodes: [] };

    const put1 = await store.put(hash, compiled);
    const put2 = await store.put(hash, compiled);

    expect(put1.isOk()).toBe(true);
    expect(put2.isOk()).toBe(true);

    const retrieved = (await store.get(hash))._unsafeUnwrap();
    expect(retrieved).toEqual(compiled);
  });
});

describe('InMemorySessionLock', () => {
  let lock: InMemorySessionLock;

  beforeEach(() => {
    lock = new InMemorySessionLock();
  });

  it('acquires and releases locks', async () => {
    const sessionId = asSessionId('sess_lock_test');

    const acquireResult = await lock.acquire(sessionId);
    expect(acquireResult.isOk()).toBe(true);
    const handle = acquireResult._unsafeUnwrap();

    const releaseResult = await lock.release(handle);
    expect(releaseResult.isOk()).toBe(true);
  });

  it('fails fast when lock is busy', async () => {
    const sessionId = asSessionId('sess_busy');

    const acquire1 = await lock.acquire(sessionId);
    expect(acquire1.isOk()).toBe(true);

    // Second acquire should fail
    const acquire2 = await lock.acquire(sessionId);
    expect(acquire2.isErr()).toBe(true);
    const error = acquire2._unsafeUnwrapErr();
    expect(error.code).toBe('SESSION_LOCK_BUSY');
    expect(error.retry.kind).toBe('retryable_after_ms');
  });

  it('allows re-acquisition after release', async () => {
    const sessionId = asSessionId('sess_reacquire');

    const handle1 = (await lock.acquire(sessionId))._unsafeUnwrap();
    await lock.release(handle1);

    const acquire2 = await lock.acquire(sessionId);
    expect(acquire2.isOk()).toBe(true);
  });
});

describe('InMemoryKeyring', () => {
  let keyring: InMemoryKeyring;

  beforeEach(() => {
    keyring = new InMemoryKeyring();
  });

  it('creates keyring on first loadOrCreate', async () => {
    const result = await keyring.loadOrCreate();
    expect(result.isOk()).toBe(true);

    const kr = result._unsafeUnwrap();
    expect(kr.v).toBe(1);
    expect(kr.current).toBeDefined();
    expect(kr.current.alg).toBe('hmac_sha256');
    expect(kr.previous).toBeNull();
  });

  it('returns same keyring on subsequent loadOrCreate', async () => {
    const kr1 = (await keyring.loadOrCreate())._unsafeUnwrap();
    const kr2 = (await keyring.loadOrCreate())._unsafeUnwrap();

    expect(kr1.current.keyBase64Url).toBe(kr2.current.keyBase64Url);
  });

  it('rotates keys: current → previous', async () => {
    const kr1 = (await keyring.loadOrCreate())._unsafeUnwrap();
    const oldCurrent = kr1.current.keyBase64Url;

    const kr2 = (await keyring.rotate())._unsafeUnwrap();

    expect(kr2.previous).toBeDefined();
    expect(kr2.previous!.keyBase64Url).toBe(oldCurrent);
    expect(kr2.current.keyBase64Url).not.toBe(oldCurrent);
  });
});

describe('InMemoryFileSystem', () => {
  let fs: InMemoryFileSystem;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
  });

  it('creates directories', async () => {
    const result = await fs.mkdirp('/data/sessions');
    expect(result.isOk()).toBe(true);
  });

  it('writes and reads files', async () => {
    await fs.mkdirp('/data');
    const content = new TextEncoder().encode('test content');

    const writeResult = await fs.writeFileBytes('/data/test.txt', content);
    expect(writeResult.isOk()).toBe(true);

    const readResult = await fs.readFileBytes('/data/test.txt');
    expect(readResult.isOk()).toBe(true);
    expect(readResult._unsafeUnwrap()).toEqual(content);
  });

  it('reads files as UTF-8 text', async () => {
    await fs.mkdirp('/data');
    const content = new TextEncoder().encode('hello world');

    await fs.writeFileBytes('/data/text.txt', content);

    const textResult = await fs.readFileUtf8('/data/text.txt');
    expect(textResult.isOk()).toBe(true);
    expect(textResult._unsafeUnwrap()).toBe('hello world');
  });

  it('returns FS_NOT_FOUND for missing files', async () => {
    const result = await fs.readFileBytes('/data/missing.txt');
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('FS_NOT_FOUND');
  });

  it('handles exclusive file creation', async () => {
    await fs.mkdirp('/data');
    const bytes = new TextEncoder().encode('exclusive');

    const fd1Result = await fs.openExclusive('/data/lock.txt', bytes);
    expect(fd1Result.isOk()).toBe(true);

    await fs.closeFile(fd1Result._unsafeUnwrap().fd);

    // Second exclusive should fail
    const fd2Result = await fs.openExclusive('/data/lock.txt', bytes);
    expect(fd2Result.isErr()).toBe(true);
    const error = fd2Result._unsafeUnwrapErr();
    expect(error.code).toBe('FS_ALREADY_EXISTS');
  });

  it('appends to files', async () => {
    await fs.mkdirp('/data');

    const fdResult = await fs.openAppend('/data/log.txt');
    expect(fdResult.isOk()).toBe(true);
    const fd = fdResult._unsafeUnwrap().fd;

    const line1 = new TextEncoder().encode('line1\n');
    await fs.writeAll(fd, line1);

    const line2 = new TextEncoder().encode('line2\n');
    await fs.writeAll(fd, line2);

    await fs.closeFile(fd);

    const content = await fs.readFileUtf8('/data/log.txt');
    expect(content._unsafeUnwrap()).toBe('line1\nline2\n');
  });

  it('renames files', async () => {
    await fs.mkdirp('/data');
    await fs.writeFileBytes('/data/old.txt', new TextEncoder().encode('content'));

    const renameResult = await fs.rename('/data/old.txt', '/data/new.txt');
    expect(renameResult.isOk()).toBe(true);

    const oldResult = await fs.readFileBytes('/data/old.txt');
    expect(oldResult.isErr()).toBe(true);

    const newResult = await fs.readFileBytes('/data/new.txt');
    expect(newResult.isOk()).toBe(true);
  });

  it('deletes files', async () => {
    await fs.mkdirp('/data');
    await fs.writeFileBytes('/data/file.txt', new TextEncoder().encode('content'));

    const deleteResult = await fs.unlink('/data/file.txt');
    expect(deleteResult.isOk()).toBe(true);

    const readResult = await fs.readFileBytes('/data/file.txt');
    expect(readResult.isErr()).toBe(true);
  });

  it('stats files', async () => {
    await fs.mkdirp('/data');
    const content = new TextEncoder().encode('12 bytes!');
    await fs.writeFileBytes('/data/file.txt', content);

    const statResult = await fs.stat('/data/file.txt');
    expect(statResult.isOk()).toBe(true);
    expect(statResult._unsafeUnwrap().sizeBytes).toBe(9);
  });
});
