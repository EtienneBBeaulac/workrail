import type { ResultAsync } from 'neverthrow';
import { ResultAsync as RA } from 'neverthrow';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2, FsError } from '../../../ports/fs.port.js';
import type { Sha256PortV2 } from '../../../ports/sha256.port.js';
import type { SessionLockPortV2, SessionLockError } from '../../../ports/session-lock.port.js';
import type {
  AppendPlanV2,
  SessionEventLogStoreError,
  LoadedSessionTruthV2,
  SessionEventLogStorePortV2,
  SnapshotPinV2,
} from '../../../ports/session-event-log-store.port.js';
import type { SessionId } from '../../../durable-core/ids/index.js';
import { toJsonlLineBytes } from '../../../durable-core/canonical/jsonl.js';
import type { JsonValue } from '../../../durable-core/canonical/json-types.js';
import { DomainEventV1Schema, ManifestRecordV1Schema, type DomainEventV1, type ManifestRecordV1 } from '../../../durable-core/schemas/session/index.js';

class StoreFailure extends Error {
  constructor(readonly storeError: SessionEventLogStoreError) {
    super(storeError.message);
  }
}

export class LocalSessionEventLogStoreV2 implements SessionEventLogStorePortV2 {
  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2,
    private readonly sha256: Sha256PortV2,
    private readonly lock: SessionLockPortV2
  ) {}

  append(sessionId: SessionId, plan: AppendPlanV2): ResultAsync<void, SessionEventLogStoreError> {
    return RA.fromPromise(this.appendImpl(sessionId, plan), (e) => {
      if (e instanceof StoreFailure) return e.storeError;
      return { code: 'SESSION_STORE_IO_ERROR', message: e instanceof Error ? e.message : String(e) };
    });
  }

  load(sessionId: SessionId): ResultAsync<LoadedSessionTruthV2, SessionEventLogStoreError> {
    return RA.fromPromise(this.loadImpl(sessionId), (e) => {
      if (e instanceof StoreFailure) return e.storeError;
      return { code: 'SESSION_STORE_IO_ERROR', message: e instanceof Error ? e.message : String(e) };
    });
  }

  private async appendImpl(sessionId: SessionId, plan: AppendPlanV2): Promise<void> {
    const lockHandle = await this.unwrap(this.lock.acquire(sessionId), mapLockError);
    try {
      const sessionDir = this.dataDir.sessionDir(sessionId);
      const eventsDir = this.dataDir.sessionEventsDir(sessionId);
      const manifestPath = this.dataDir.sessionManifestPath(sessionId);

      await this.unwrap(this.fs.mkdirp(eventsDir), mapFsToStoreError);

      const { manifest, events: existingEvents } = await this.loadTruthOrEmpty(sessionId);
      validateManifestContiguityOrThrow(manifest);

      // Idempotency check (locked): if all events already exist by dedupeKey, this is a replay.
      const existingByDedupeKey = new Set(existingEvents.map((e) => e.dedupeKey));
      const allExist = plan.events.every((e) => existingByDedupeKey.has(e.dedupeKey));
      if (allExist) {
        // Idempotent no-op: all events in this plan already exist. Return without appending.
        return;
      }

      // Partial replay detection (locked invariant violation): if ANY event exists but NOT all, fail fast.
      const anyExist = plan.events.some((e) => existingByDedupeKey.has(e.dedupeKey));
      if (anyExist && !allExist) {
        throw new StoreFailure({
          code: 'SESSION_STORE_INVARIANT_VIOLATION',
          message: 'Partial dedupeKey collision detected (some events exist, some do not); this is an invariant violation',
        });
      }

      const expectedFirstEventIndex = nextEventIndexFromManifest(manifest);
      validateAppendPlanOrThrow(sessionId, plan, expectedFirstEventIndex);

      const first = plan.events[0]!.eventIndex;
      const last = plan.events[plan.events.length - 1]!.eventIndex;

      const segmentRelPath = segmentRelPathFor(first, last);
      const segmentPath = `${sessionDir}/${segmentRelPath}`;
      const tmpPath = `${segmentPath}.tmp`;

      // Encode the segment deterministically (canonical JSONL).
      const segmentBytes = concatJsonlRecords(plan.events as unknown as readonly JsonValue[]);

      // (1) Write domain segment: tmp → fsync(file) → rename → fsync(dir)
      const tmpHandle = await this.unwrap(this.fs.openWriteTruncate(tmpPath), mapFsToStoreError);
      await this.unwrap(this.fs.writeAll(tmpHandle.fd, segmentBytes), mapFsToStoreError);
      await this.unwrap(this.fs.fsyncFile(tmpHandle.fd), mapFsToStoreError);
      await this.unwrap(this.fs.closeFile(tmpHandle.fd), mapFsToStoreError);
      await this.unwrap(this.fs.rename(tmpPath, segmentPath), mapFsToStoreError);
      await this.unwrap(this.fs.fsyncDir(eventsDir), mapFsToStoreError);

      const digest = this.sha256.sha256(segmentBytes);

      // (2) Attest segment in manifest: append segment_closed → fsync(manifest)
      const segClosed: ManifestRecordV1 = {
        v: 1,
        manifestIndex: nextManifestIndex(manifest),
        sessionId,
        kind: 'segment_closed',
        firstEventIndex: first,
        lastEventIndex: last,
        segmentRelPath,
        sha256: digest,
        bytes: segmentBytes.length,
      };
      await this.appendManifestRecords(manifestPath, [segClosed]);

      // (3) Pin snapshots: append snapshot_pinned records → fsync(manifest)
      const pins = sortedPins(plan.snapshotPins);
      if (pins.length > 0) {
        const startIndex = segClosed.manifestIndex + 1;
        const records: ManifestRecordV1[] = pins.map((p, i) => ({
          v: 1,
          manifestIndex: startIndex + i,
          sessionId,
          kind: 'snapshot_pinned',
          eventIndex: p.eventIndex,
          snapshotRef: p.snapshotRef,
          createdByEventId: p.createdByEventId,
        }));
        await this.appendManifestRecords(manifestPath, records);
      }
    } finally {
      await this.lock.release(lockHandle).match(
        () => undefined,
        () => undefined
      );
    }
  }

  private async loadImpl(sessionId: SessionId): Promise<LoadedSessionTruthV2> {
    const lockHandle = await this.unwrap(this.lock.acquire(sessionId), mapLockError);
    try {
      const sessionDir = this.dataDir.sessionDir(sessionId);
      const manifestPath = this.dataDir.sessionManifestPath(sessionId);

      const manifest = await this.readManifestOrEmpty(sessionId);
      validateManifestContiguityOrThrow(manifest);
      validateSegmentClosedContiguityOrThrow(manifest);

      const segments = manifest.filter((m): m is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => m.kind === 'segment_closed');

      const events: DomainEventV1[] = [];
      for (const seg of segments) {
        const segmentPath = `${sessionDir}/${seg.segmentRelPath}`;
        const bytes = await this.unwrap(this.fs.readFileBytes(segmentPath), mapFsToStoreError);
        const actual = this.sha256.sha256(bytes);
        if (actual !== seg.sha256) {
          throw new StoreFailure({
            code: 'SESSION_STORE_CORRUPTION_DETECTED',
            message: `Segment digest mismatch: ${seg.segmentRelPath}`,
          });
        }
        const parsed = parseJsonlLines(bytes, DomainEventV1Schema);
        // Validate bounds for this segment.
        if (parsed.length === 0) {
          throw new StoreFailure({
            code: 'SESSION_STORE_CORRUPTION_DETECTED',
            message: `Empty segment referenced by manifest: ${seg.segmentRelPath}`,
          });
        }
        if (parsed[0]!.eventIndex !== seg.firstEventIndex || parsed[parsed.length - 1]!.eventIndex !== seg.lastEventIndex) {
          throw new StoreFailure({
            code: 'SESSION_STORE_CORRUPTION_DETECTED',
            message: `Segment bounds mismatch: ${seg.segmentRelPath}`,
          });
        }
        // Contiguity within segment
        for (let i = 1; i < parsed.length; i++) {
          if (parsed[i]!.eventIndex !== parsed[i - 1]!.eventIndex + 1) {
            throw new StoreFailure({
              code: 'SESSION_STORE_CORRUPTION_DETECTED',
              message: `Non-contiguous eventIndex inside segment: ${seg.segmentRelPath}`,
            });
          }
        }
        events.push(...parsed);
      }

      // Pin-after-close corruption gating: any introduced snapshotRef must be pinned.
      const expectedPins = extractSnapshotPinsFromEvents(events);
      const actualPins = new Set(
        manifest
          .filter((m): m is Extract<ManifestRecordV1, { kind: 'snapshot_pinned' }> => m.kind === 'snapshot_pinned')
          .map((p) => `${p.eventIndex}:${p.createdByEventId}:${p.snapshotRef}`)
      );
      for (const ep of expectedPins) {
        const key = `${ep.eventIndex}:${ep.createdByEventId}:${ep.snapshotRef}`;
        if (!actualPins.has(key)) {
          throw new StoreFailure({
            code: 'SESSION_STORE_CORRUPTION_DETECTED',
            message: `Missing snapshot_pinned for introduced snapshotRef (pin-after-close violation): ${key}`,
          });
        }
      }

      return { manifest, events };
    } finally {
      await this.lock.release(lockHandle).match(
        () => undefined,
        () => undefined
      );
    }
  }

  private async readManifestOrEmpty(sessionId: SessionId): Promise<ManifestRecordV1[]> {
    const manifestPath = this.dataDir.sessionManifestPath(sessionId);
    const raw = await this.fs.readFileUtf8(manifestPath).match(
      (v) => v,
      (e) => {
        if (e.code === 'FS_NOT_FOUND') return '';
        throw new StoreFailure(mapFsToStoreError(e));
      }
    );
    if (raw.trim() === '') return [];
    return parseJsonlText(raw, ManifestRecordV1Schema);
  }

  private async loadTruthOrEmpty(sessionId: SessionId): Promise<{ manifest: ManifestRecordV1[]; events: DomainEventV1[] }> {
    const manifest = await this.readManifestOrEmpty(sessionId);
    if (manifest.length === 0) return { manifest: [], events: [] };

    const segments = manifest.filter((m): m is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => m.kind === 'segment_closed');
    const sessionDir = this.dataDir.sessionDir(sessionId);
    const events: DomainEventV1[] = [];

    for (const seg of segments) {
      const segmentPath = `${sessionDir}/${seg.segmentRelPath}`;
      const bytes = await this.unwrap(this.fs.readFileBytes(segmentPath), mapFsToStoreError);
      const parsed = parseJsonlLines(bytes, DomainEventV1Schema);
      events.push(...parsed);
    }

    return { manifest, events };
  }

  private async appendManifestRecords(manifestPath: string, records: readonly ManifestRecordV1[]): Promise<void> {
    // Write records as append-only JSONL and fsync once for this batch.
    const handle = await this.unwrap(this.fs.openAppend(manifestPath), mapFsToStoreError);
    const bytes = concatJsonlRecords(records as unknown as readonly JsonValue[]);
    await this.unwrap(this.fs.writeAll(handle.fd, bytes), mapFsToStoreError);
    await this.unwrap(this.fs.fsyncFile(handle.fd), mapFsToStoreError);
    await this.unwrap(this.fs.closeFile(handle.fd), mapFsToStoreError);
  }

  private async unwrap<T, E>(
    ra: ResultAsync<T, E>,
    map: (e: E) => SessionEventLogStoreError
  ): Promise<T> {
    return ra.match(
      (v) => v,
      (e) => {
        throw new StoreFailure(map(e));
      }
    );
  }
}

function mapLockError(e: SessionLockError): SessionEventLogStoreError {
  if (e.code === 'SESSION_LOCK_BUSY') {
    return { code: 'SESSION_STORE_LOCK_BUSY', message: e.message, retry: e.retry };
  }
  return { code: 'SESSION_STORE_IO_ERROR', message: e.message };
}

function mapFsToStoreError(e: FsError): SessionEventLogStoreError {
  return { code: 'SESSION_STORE_IO_ERROR', message: e.message };
}

function nextManifestIndex(manifest: readonly ManifestRecordV1[]): number {
  if (manifest.length === 0) return 0;
  return manifest[manifest.length - 1]!.manifestIndex + 1;
}

function nextEventIndexFromManifest(manifest: readonly ManifestRecordV1[]): number {
  const segments = manifest.filter((m): m is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => m.kind === 'segment_closed');
  if (segments.length === 0) return 0;
  return segments[segments.length - 1]!.lastEventIndex + 1;
}

function validateManifestContiguityOrThrow(manifest: readonly ManifestRecordV1[]): void {
  for (let i = 0; i < manifest.length; i++) {
    const expected = i;
    if (manifest[i]!.manifestIndex !== expected) {
      throw new StoreFailure({
        code: 'SESSION_STORE_CORRUPTION_DETECTED',
        message: `Non-contiguous manifestIndex at position ${i} (expected ${expected}, got ${manifest[i]!.manifestIndex})`,
      });
    }
  }
}

function validateSegmentClosedContiguityOrThrow(manifest: readonly ManifestRecordV1[]): void {
  const segments = manifest.filter((m): m is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => m.kind === 'segment_closed');
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!;
    const cur = segments[i]!;
    if (cur.firstEventIndex !== prev.lastEventIndex + 1) {
      throw new StoreFailure({
        code: 'SESSION_STORE_CORRUPTION_DETECTED',
        message: `Non-contiguous segment_closed bounds (expected firstEventIndex=${prev.lastEventIndex + 1}, got ${cur.firstEventIndex})`,
      });
    }
  }
}

function validateAppendPlanOrThrow(sessionId: SessionId, plan: AppendPlanV2, expectedFirstEventIndex: number): void {
  if (plan.events.length === 0) {
    throw new StoreFailure({ code: 'SESSION_STORE_INVARIANT_VIOLATION', message: 'AppendPlan.events must be non-empty' });
  }

  // Validate schema + sessionId, and contiguity.
  const first = plan.events[0]!;
  if (first.eventIndex !== expectedFirstEventIndex) {
    throw new StoreFailure({
      code: 'SESSION_STORE_INVARIANT_VIOLATION',
      message: `AppendPlan.eventIndex must start at ${expectedFirstEventIndex} (got ${first.eventIndex})`,
    });
  }

  for (let i = 0; i < plan.events.length; i++) {
    const e = DomainEventV1Schema.safeParse(plan.events[i]);
    if (!e.success) {
      throw new StoreFailure({ code: 'SESSION_STORE_INVARIANT_VIOLATION', message: `Invalid domain event at index ${i}` });
    }
    if (e.data.sessionId !== sessionId) {
      throw new StoreFailure({
        code: 'SESSION_STORE_INVARIANT_VIOLATION',
        message: `Domain event sessionId mismatch at index ${i}`,
      });
    }
    if (i > 0 && plan.events[i]!.eventIndex !== plan.events[i - 1]!.eventIndex + 1) {
      throw new StoreFailure({
        code: 'SESSION_STORE_INVARIANT_VIOLATION',
        message: `Non-contiguous eventIndex in AppendPlan at index ${i}`,
      });
    }
  }

  // Validate snapshotPins are deterministic + refer to this segment range.
  const pins = sortedPins(plan.snapshotPins);
  for (const p of pins) {
    if (p.eventIndex < first.eventIndex || p.eventIndex > plan.events[plan.events.length - 1]!.eventIndex) {
      throw new StoreFailure({
        code: 'SESSION_STORE_INVARIANT_VIOLATION',
        message: `SnapshotPin.eventIndex must refer to an event in the appended segment`,
      });
    }
  }
}

function sortedPins(pins: readonly SnapshotPinV2[]): SnapshotPinV2[] {
  return [...pins].sort((a, b) => {
    const sr = String(a.snapshotRef).localeCompare(String(b.snapshotRef));
    if (sr !== 0) return sr;
    const ei = a.eventIndex - b.eventIndex;
    if (ei !== 0) return ei;
    return a.createdByEventId.localeCompare(b.createdByEventId);
  });
}

function segmentRelPathFor(firstEventIndex: number, lastEventIndex: number): string {
  const first = String(firstEventIndex).padStart(8, '0');
  const last = String(lastEventIndex).padStart(8, '0');
  return `events/${first}-${last}.jsonl`;
}

function concatJsonlRecords(records: readonly JsonValue[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const r of records) {
    const encoded = toJsonlLineBytes(r).match(
      (v) => v,
      (e) => {
        throw new StoreFailure({ code: 'SESSION_STORE_INVARIANT_VIOLATION', message: e.message });
      }
    );
    parts.push(encoded);
    total += encoded.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function parseJsonlText<T>(text: string, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }): T[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StoreFailure({ code: 'SESSION_STORE_CORRUPTION_DETECTED', message: `Invalid JSONL at line ${i}` });
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new StoreFailure({ code: 'SESSION_STORE_CORRUPTION_DETECTED', message: `Invalid record at line ${i}` });
    }
    out.push(validated.data);
  }
  return out;
}

function parseJsonlLines<T>(bytes: Uint8Array, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }): T[] {
  const text = new TextDecoder().decode(bytes);
  return parseJsonlText(text, schema);
}

function extractSnapshotPinsFromEvents(events: readonly DomainEventV1[]): Array<{ snapshotRef: string; eventIndex: number; createdByEventId: string }> {
  // We only know how to enforce pinning for snapshot-introducing events once those event shapes exist.
  // Slice 2 uses a minimal heuristic based on the locked `node_created.data.snapshotRef`.
  const out: Array<{ snapshotRef: string; eventIndex: number; createdByEventId: string }> = [];
  for (const e of events) {
    if (e.kind !== 'node_created') continue;
    const data = e.data;
    if (typeof data !== 'object' || data === null) continue;
    const snap = (data as any).snapshotRef;
    if (typeof snap === 'string') {
      out.push({ snapshotRef: snap, eventIndex: e.eventIndex, createdByEventId: e.eventId });
    }
  }
  return out;
}
