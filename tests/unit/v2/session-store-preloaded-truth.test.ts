/**
 * Tests for preloaded truth optimization in LocalSessionEventLogStoreV2.
 *
 * Verifies that when a preloaded truth is supplied to append(), no additional
 * readFileUtf8 or readFileBytes calls are made to the manifest or segment files.
 * Also verifies that all idempotency invariants still hold when using preloaded truth.
 *
 * @enforces dedupe-key-idempotent
 * @enforces append-plan-atomic
 */
import { describe, it, expect, vi } from 'vitest';
import type { ResultAsync } from 'neverthrow';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { LocalSessionEventLogStoreV2 } from '../../../src/v2/infra/local/session-store/index.js';
import { NodeSha256V2 } from '../../../src/v2/infra/local/sha256/index.js';
import { InMemoryFileSystem } from '../../fakes/v2/file-system.fake.js';

import { asSessionId, asEventId } from '../../../src/v2/durable-core/ids/index.js';
import type { WithHealthySessionLock } from '../../../src/v2/durable-core/ids/with-healthy-session-lock.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';
import type { LoadedSessionTruthV2 } from '../../../src/v2/ports/session-event-log-store.port.js';
import type { FsError } from '../../../src/v2/ports/fs.port.js';

// ---- Helpers ---------------------------------------------------------------

function makeLock(sessionId: ReturnType<typeof asSessionId>): WithHealthySessionLock {
  return {
    sessionId,
    assertHeld: () => true,
  } as unknown as WithHealthySessionLock;
}

function makeSessionCreatedEvent(sessionId: ReturnType<typeof asSessionId>, eventIndex: number): DomainEventV1 {
  return {
    v: 1,
    eventId: asEventId(`evt_${eventIndex}_${String(sessionId)}`),
    eventIndex,
    sessionId,
    kind: 'session_created',
    dedupeKey: `session_created:${String(sessionId)}:${eventIndex}`,
    data: {},
  };
}

function makeStore(fs: InMemoryFileSystem): LocalSessionEventLogStoreV2 {
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: '/tmp/test-preloaded-truth' });
  const sha = new NodeSha256V2();
  return new LocalSessionEventLogStoreV2(dataDir, fs, sha);
}

// ---- Tests -----------------------------------------------------------------

describe('LocalSessionEventLogStoreV2: preloaded truth optimization', () => {
  it('skips readFileUtf8 and readFileBytes when preloadedTruth is provided for empty session', async () => {
    const fs = new InMemoryFileSystem();
    const store = makeStore(fs);

    // Spy on read methods BEFORE append so we count reads triggered by append itself.
    const spyUtf8 = vi.spyOn(fs, 'readFileUtf8');
    const spyBytes = vi.spyOn(fs, 'readFileBytes');

    const sessionId = asSessionId('sess_preloaded_empty');
    const lock = makeLock(sessionId);
    const preloadedTruth: LoadedSessionTruthV2 = { manifest: [], events: [] };
    const event = makeSessionCreatedEvent(sessionId, 0);

    const result = await store.append(lock, { events: [event], snapshotPins: [] }, preloadedTruth);

    expect(result.isOk()).toBe(true);
    // No manifest or segment reads -- only write operations when preloadedTruth is provided.
    expect(spyUtf8).not.toHaveBeenCalled();
    expect(spyBytes).not.toHaveBeenCalled();
  });

  it('skips reads when preloadedTruth is provided for session with existing segment', async () => {
    const fs = new InMemoryFileSystem();
    const store = makeStore(fs);

    const sessionId = asSessionId('sess_preloaded_existing');

    // First append: writes segment + manifest (reads are allowed here).
    const event0 = makeSessionCreatedEvent(sessionId, 0);
    const res0 = await store.append(makeLock(sessionId), { events: [event0], snapshotPins: [] });
    expect(res0.isOk()).toBe(true);

    // Load truth to get the preloaded state.
    const loaded = await store.load(sessionId);
    expect(loaded.isOk()).toBe(true);
    const preloadedTruth = loaded._unsafeUnwrap();

    // Spy AFTER loading so we only count reads triggered by the second append.
    const spyUtf8 = vi.spyOn(fs, 'readFileUtf8');
    const spyBytes = vi.spyOn(fs, 'readFileBytes');

    const event1 = makeSessionCreatedEvent(sessionId, 1);
    const result = await store.append(makeLock(sessionId), { events: [event1], snapshotPins: [] }, preloadedTruth);

    expect(result.isOk()).toBe(true);
    // Preloaded truth bypasses loadTruthOrEmpty -- no manifest or segment reads.
    expect(spyUtf8).not.toHaveBeenCalled();
    expect(spyBytes).not.toHaveBeenCalled();
  });

  it('without preloadedTruth, reads DO occur for a session with an existing segment (baseline contrast)', async () => {
    const fs = new InMemoryFileSystem();
    const store = makeStore(fs);

    const sessionId = asSessionId('sess_no_preloaded');

    // First append (creates segment + manifest).
    const event0 = makeSessionCreatedEvent(sessionId, 0);
    await store.append(makeLock(sessionId), { events: [event0], snapshotPins: [] });

    // Spy AFTER first append to isolate reads from second append.
    const spyUtf8 = vi.spyOn(fs, 'readFileUtf8');
    const spyBytes = vi.spyOn(fs, 'readFileBytes');

    const event1 = makeSessionCreatedEvent(sessionId, 1);
    const result = await store.append(makeLock(sessionId), { events: [event1], snapshotPins: [] });

    expect(result.isOk()).toBe(true);
    // Without preloaded truth, appendImpl calls loadTruthOrEmpty which reads manifest + segments.
    const totalReads = spyUtf8.mock.calls.length + spyBytes.mock.calls.length;
    expect(totalReads).toBeGreaterThan(0);
  });

  it('idempotency: replay of same dedupeKey is a no-op when using preloaded truth', async () => {
    const fs = new InMemoryFileSystem();
    const store = makeStore(fs);

    const sessionId = asSessionId('sess_preloaded_dedup');
    const event0 = makeSessionCreatedEvent(sessionId, 0);

    // First append.
    const res0 = await store.append(makeLock(sessionId), { events: [event0], snapshotPins: [] });
    expect(res0.isOk()).toBe(true);

    // Load truth (contains event0).
    const loaded = await store.load(sessionId);
    expect(loaded.isOk()).toBe(true);
    const preloadedTruth = loaded._unsafeUnwrap();

    // Replay with preloaded truth -- must be idempotent no-op.
    const res1 = await store.append(makeLock(sessionId), { events: [event0], snapshotPins: [] }, preloadedTruth);
    expect(res1.isOk()).toBe(true);

    // Session must still have only 1 event.
    const final = await store.load(sessionId);
    expect(final.isOk()).toBe(true);
    expect(final._unsafeUnwrap().events.length).toBe(1);
  });

  it('partial idempotency violation is still detected when using preloaded truth', async () => {
    const fs = new InMemoryFileSystem();
    const store = makeStore(fs);

    const sessionId = asSessionId('sess_preloaded_partial');
    const event0 = makeSessionCreatedEvent(sessionId, 0);
    const event1 = makeSessionCreatedEvent(sessionId, 1);

    // Append event0 first.
    const res0 = await store.append(makeLock(sessionId), { events: [event0], snapshotPins: [] });
    expect(res0.isOk()).toBe(true);

    // Load truth (contains only event0).
    const loaded = await store.load(sessionId);
    expect(loaded.isOk()).toBe(true);
    const preloadedTruth = loaded._unsafeUnwrap();

    // Attempt [event0 (exists), event1 (does not)] -- partial collision must fail.
    const res1 = await store.append(makeLock(sessionId), { events: [event0, event1], snapshotPins: [] }, preloadedTruth);
    expect(res1.isErr()).toBe(true);
    if (res1.isErr()) {
      expect(res1.error.code).toBe('SESSION_STORE_INVARIANT_VIOLATION');
    }
  });

  it('on-disk state is identical whether preloaded truth is provided or not', async () => {
    // Session A: append without preloaded truth.
    const fsA = new InMemoryFileSystem();
    const storeA = makeStore(fsA);
    const sessionA = asSessionId('sess_on_disk_a');
    const evtA = makeSessionCreatedEvent(sessionA, 0);
    await storeA.append(makeLock(sessionA), { events: [evtA], snapshotPins: [] });

    // Session B: append with preloaded truth (empty session).
    const fsB = new InMemoryFileSystem();
    const storeB = makeStore(fsB);
    const sessionB = asSessionId('sess_on_disk_b');
    const evtB = makeSessionCreatedEvent(sessionB, 0);
    const preloadedTruth: LoadedSessionTruthV2 = { manifest: [], events: [] };
    await storeB.append(makeLock(sessionB), { events: [evtB], snapshotPins: [] }, preloadedTruth);

    // Load both and compare structural properties.
    const loadedA = await storeA.load(sessionA);
    const loadedB = await storeB.load(sessionB);

    expect(loadedA.isOk()).toBe(true);
    expect(loadedB.isOk()).toBe(true);

    const truthA = loadedA._unsafeUnwrap();
    const truthB = loadedB._unsafeUnwrap();

    // Both sessions must have 1 event and 1 manifest record (segment_closed).
    expect(truthA.events.length).toBe(1);
    expect(truthB.events.length).toBe(1);
    expect(truthA.manifest.length).toBe(truthB.manifest.length);
    expect(truthA.events[0]!.eventIndex).toBe(0);
    expect(truthB.events[0]!.eventIndex).toBe(0);
    expect(truthA.events[0]!.kind).toBe(truthB.events[0]!.kind);
  });
});
