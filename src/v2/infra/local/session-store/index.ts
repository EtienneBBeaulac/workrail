import type { ResultAsync } from 'neverthrow';
import { ResultAsync as RA, errAsync, okAsync, ok, err, type Result } from 'neverthrow';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2, FsError } from '../../../ports/fs.port.js';
import type { Sha256PortV2 } from '../../../ports/sha256.port.js';
import type {
  AppendPlanV2,
  LoadedValidatedPrefixV2,
  SessionEventLogStoreError,
  LoadedSessionTruthV2,
  SessionEventLogAppendStorePortV2,
  SessionEventLogReadonlyStorePortV2,
  SnapshotPinV2,
} from '../../../ports/session-event-log-store.port.js';
import type { SessionId, SnapshotRef } from '../../../durable-core/ids/index.js';
import { toJsonlLineBytes } from '../../../durable-core/canonical/jsonl.js';
import type { JsonValue } from '../../../durable-core/canonical/json-types.js';
import { DomainEventV1Schema, ManifestRecordV1Schema, type DomainEventV1, type ManifestRecordV1 } from '../../../durable-core/schemas/session/index.js';
import type { WithHealthySessionLock } from '../../../durable-core/ids/with-healthy-session-lock.js';
import type { CorruptionReasonV2 } from '../../../durable-core/schemas/session/session-health.js';
import { EVENT_KIND, MANIFEST_KIND } from '../../../durable-core/constants.js';
import * as path from 'path';

export class LocalSessionEventLogStoreV2 implements SessionEventLogReadonlyStorePortV2, SessionEventLogAppendStorePortV2 {
  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2,
    private readonly sha256: Sha256PortV2
  ) {}

  append(lock: WithHealthySessionLock, plan: AppendPlanV2): ResultAsync<void, SessionEventLogStoreError> {
    if (!lock.assertHeld()) {
      return errAsync({
        code: 'SESSION_STORE_INVARIANT_VIOLATION' as const,
        message: 'WithHealthySessionLock used after gate callback ended (witness misuse-after-release)',
      } satisfies SessionEventLogStoreError);
    }
    return this.appendImpl(lock.sessionId, plan);
  }

  load(sessionId: SessionId): ResultAsync<LoadedSessionTruthV2, SessionEventLogStoreError> {
    return this.loadImpl(sessionId);
  }

  loadValidatedPrefix(sessionId: SessionId): ResultAsync<LoadedValidatedPrefixV2, SessionEventLogStoreError> {
    return this.loadValidatedPrefixImpl(sessionId);
  }

  private appendImpl(sessionId: SessionId, plan: AppendPlanV2): ResultAsync<void, SessionEventLogStoreError> {
    const sessionDir = this.dataDir.sessionDir(sessionId);
    const eventsDir = this.dataDir.sessionEventsDir(sessionId);
    const manifestPath = this.dataDir.sessionManifestPath(sessionId);

    return this.fs.mkdirp(eventsDir)
      .mapErr(mapFsToStoreError)
      .andThen(() => this.loadTruthOrEmpty(sessionId))
      .andThen(({ manifest, events: existingEvents }) => {
        const contiguityRes = validateManifestContiguity(manifest);
        if (contiguityRes.isErr()) return errAsync(contiguityRes.error);

        // Idempotency check (locked): if all events already exist by dedupeKey, this is a replay.
        const existingByDedupeKey = new Set(existingEvents.map((e) => e.dedupeKey));
        const allExist = plan.events.every((e) => existingByDedupeKey.has(e.dedupeKey));
        if (allExist) {
          // Idempotent no-op: all events in this plan already exist. Return without appending.
          return okAsync(undefined);
        }

        // Partial replay detection (locked invariant violation): if ANY event exists but NOT all, fail fast.
        const anyExist = plan.events.some((e) => existingByDedupeKey.has(e.dedupeKey));
        if (anyExist && !allExist) {
          return errAsync({
            code: 'SESSION_STORE_INVARIANT_VIOLATION' as const,
            message: 'Partial dedupeKey collision detected (some events exist, some do not); this is an invariant violation',
          } satisfies SessionEventLogStoreError);
        }

        const expectedFirstEventIndex = nextEventIndexFromManifest(manifest);
        const planRes = validateAppendPlan(sessionId, plan, expectedFirstEventIndex);
        if (planRes.isErr()) return errAsync(planRes.error);

        const first = plan.events[0]!.eventIndex;
        const last = plan.events[plan.events.length - 1]!.eventIndex;

        const segmentRelPath = segmentRelPathFor(first, last);
        const segmentPath = path.join(sessionDir, segmentRelPath);
        const tmpPath = `${segmentPath}.tmp`;

        // Encode the segment deterministically (canonical JSONL).
        const segmentBytesRes = concatJsonlRecords(plan.events as unknown as readonly JsonValue[]);
        if (segmentBytesRes.isErr()) return errAsync(segmentBytesRes.error);
        const segmentBytes = segmentBytesRes.value;

        // (1) Write domain segment: tmp → fsync(file) → rename → fsync(dir)
        return this.fs.openWriteTruncate(tmpPath)
          .mapErr(mapFsToStoreError)
          .andThen((tmpHandle) => 
            this.fs.writeAll(tmpHandle.fd, segmentBytes).mapErr(mapFsToStoreError)
              .andThen(() => this.fs.fsyncFile(tmpHandle.fd).mapErr(mapFsToStoreError))
              .andThen(() => this.fs.closeFile(tmpHandle.fd).mapErr(mapFsToStoreError))
          )
          .andThen(() => this.fs.rename(tmpPath, segmentPath).mapErr(mapFsToStoreError))
          .andThen(() => this.fs.fsyncDir(eventsDir).mapErr(mapFsToStoreError))
          .andThen(() => {
            const digest = this.sha256.sha256(segmentBytes);

            // (2) Attest segment in manifest: append segment_closed → fsync(manifest)
            const segClosed: ManifestRecordV1 = {
              v: 1,
              manifestIndex: nextManifestIndex(manifest),
              sessionId,
              kind: MANIFEST_KIND.SEGMENT_CLOSED,
              firstEventIndex: first,
              lastEventIndex: last,
              segmentRelPath,
              sha256: digest,
              bytes: segmentBytes.length,
            };
            
            return this.appendManifestRecords(manifestPath, [segClosed])
              .andThen(() => {
                // (3) Pin snapshots: append snapshot_pinned records → fsync(manifest)
                const pins = sortedPins(plan.snapshotPins);
                if (pins.length === 0) return okAsync(undefined);

                const startIndex = segClosed.manifestIndex + 1;
                const records: ManifestRecordV1[] = pins.map((p, i) => ({
                  v: 1,
                  manifestIndex: startIndex + i,
                  sessionId,
                  kind: MANIFEST_KIND.SNAPSHOT_PINNED,
                  eventIndex: p.eventIndex,
                  snapshotRef: p.snapshotRef,
                  createdByEventId: p.createdByEventId,
                }));
                return this.appendManifestRecords(manifestPath, records);
              });
          });
      });
  }

  private loadImpl(sessionId: SessionId): ResultAsync<LoadedSessionTruthV2, SessionEventLogStoreError> {
    const sessionDir = this.dataDir.sessionDir(sessionId);

    return this.readManifestOrEmpty(sessionId)
      .andThen((manifest) => {
        const contRes = validateManifestContiguity(manifest);
        if (contRes.isErr()) return errAsync(contRes.error);
        
        const segRes = validateSegmentClosedContiguity(manifest);
        if (segRes.isErr()) return errAsync(segRes.error);

        const segments = manifest.filter((m): m is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => m.kind === MANIFEST_KIND.SEGMENT_CLOSED);

        return loadSegmentsRecursive({
          segments,
          sessionDir,
          sha256: this.sha256,
          fs: this.fs,
        }).andThen((events) => {
          // Pin-after-close corruption gating: any introduced snapshotRef must be pinned.
          const expectedPins = extractSnapshotPinsFromEvents(events);
          const actualPins = new Set(
            manifest
              .filter((m): m is Extract<ManifestRecordV1, { kind: 'snapshot_pinned' }> => m.kind === MANIFEST_KIND.SNAPSHOT_PINNED)
              .map((p) => `${p.eventIndex}:${p.createdByEventId}:${p.snapshotRef}`)
          );
          for (const ep of expectedPins) {
            const key = `${ep.eventIndex}:${ep.createdByEventId}:${ep.snapshotRef}`;
            if (!actualPins.has(key)) {
              return errAsync({
                code: 'SESSION_STORE_CORRUPTION_DETECTED' as const,
                location: 'tail' as const,
                reason: { code: 'missing_attested_segment' as const, message: `Missing snapshot_pinned for introduced snapshotRef: ${key}` },
                message: `Missing snapshot_pinned for introduced snapshotRef: ${key}`,
              });
            }
          }
          return okAsync({ manifest, events });
        });
      });
  }

  private readManifestOrEmpty(sessionId: SessionId): ResultAsync<ManifestRecordV1[], SessionEventLogStoreError> {
    const manifestPath = this.dataDir.sessionManifestPath(sessionId);
    return this.fs
      .readFileUtf8(manifestPath)
      .orElse((e) => (e.code === 'FS_NOT_FOUND' ? okAsync('') : errAsync(mapFsToStoreError(e))))
      .andThen((raw) => {
        if (raw.trim() === '') return okAsync([]);
        const parsed = parseJsonlText(raw, ManifestRecordV1Schema);
        return parsed.isErr() ? errAsync(parsed.error) : okAsync(parsed.value);
      });
  }

  private loadValidatedPrefixImpl(sessionId: SessionId): ResultAsync<LoadedValidatedPrefixV2, SessionEventLogStoreError> {
    const sessionDir = this.dataDir.sessionDir(sessionId);
    const manifestPath = this.dataDir.sessionManifestPath(sessionId);

    return this.fs
      .readFileUtf8(manifestPath)
      .orElse((e) => (e.code === 'FS_NOT_FOUND' ? okAsync('') : errAsync(mapFsToStoreError(e))))
      .andThen((raw) => {
        if (raw.trim() === '') {
          return okAsync({ kind: 'complete' as const, truth: { manifest: [], events: [] } });
        }

        // Validate manifest prefix line-by-line; stop at first invalid record.
        const lines = raw.split('\n').filter((l) => l.trim() !== '');
        const { manifest, isComplete, tailReason } = parseManifestPrefix(lines);

        if (manifest.length === 0) {
          return errAsync({
            code: 'SESSION_STORE_CORRUPTION_DETECTED' as const,
            location: 'head' as const,
            reason: { code: 'non_contiguous_indices' as const, message: 'No validated manifest prefix' },
            message: 'No validated manifest prefix',
          } satisfies SessionEventLogStoreError);
        }

        const segments = manifest.filter(
          (m): m is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => m.kind === MANIFEST_KIND.SEGMENT_CLOSED
        );

        type SalvageState = {
          readonly events: DomainEventV1[];
          readonly isComplete: boolean;
          readonly tailReason: CorruptionReasonV2 | null;
          readonly done: boolean;
        };

        const initial: SalvageState = { events: [], isComplete, tailReason, done: false };

        return segments
          .reduce<ResultAsync<SalvageState, SessionEventLogStoreError>>(
            (acc, seg) => acc.andThen((s) => processSegmentForSalvage({
              segment: seg,
              sessionDir,
              sha256: this.sha256,
              fs: this.fs,
              state: s,
            })),
            okAsync(initial)
          )
          .map((final): LoadedValidatedPrefixV2 => {
            if (final.isComplete) {
              return { kind: 'complete', truth: { manifest, events: final.events } };
            }
            return {
              kind: 'truncated',
              truth: { manifest, events: final.events },
              tailReason: final.tailReason ?? {
                code: 'non_contiguous_indices',
                message: 'Unknown truncation reason',
              },
            };
          });
      });
  }

  private loadTruthOrEmpty(sessionId: SessionId): ResultAsync<{ manifest: ManifestRecordV1[]; events: DomainEventV1[] }, SessionEventLogStoreError> {
    return this.readManifestOrEmpty(sessionId)
      .andThen((manifest) => {
        if (manifest.length === 0) return okAsync({ manifest: [], events: [] });

        const segments = manifest.filter((m): m is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => m.kind === MANIFEST_KIND.SEGMENT_CLOSED);
        const sessionDir = this.dataDir.sessionDir(sessionId);
        
        const loadSegments = (segs: typeof segments): ResultAsync<DomainEventV1[], SessionEventLogStoreError> => {
          if (segs.length === 0) return okAsync([]);
          const [head, ...tail] = segs;
          const segmentPath = path.join(sessionDir, head.segmentRelPath);
          return this.fs.readFileBytes(segmentPath)
.mapErr(mapFsToStoreError)
            .andThen((bytes) => {
              const parsedRes = parseJsonlLines(bytes, DomainEventV1Schema);
              if (parsedRes.isErr()) return errAsync(parsedRes.error);
              return okAsync(parsedRes.value);
            })
            .andThen((events) => loadSegments(tail).map((rest) => [...events, ...rest]));
        };

        return loadSegments(segments).map((events) => ({ manifest, events }));
      });
  }

  private appendManifestRecords(manifestPath: string, records: readonly ManifestRecordV1[]): ResultAsync<void, SessionEventLogStoreError> {
    // Write records as append-only JSONL and fsync once for this batch.
    // Guarantees handle is closed on all paths (success and error) using orElse cleanup.
    return this.fs.openAppend(manifestPath)
      .mapErr(mapFsToStoreError)
      .andThen((handle) => {
        const bytesRes = concatJsonlRecords(records as unknown as readonly JsonValue[]);
        if (bytesRes.isErr()) return errAsync(bytesRes.error);
        const bytes = bytesRes.value;

        // Chain operations with guaranteed cleanup on error
        return this.fs.writeAll(handle.fd, bytes).mapErr(mapFsToStoreError)
          .andThen(() => this.fs.fsyncFile(handle.fd).mapErr(mapFsToStoreError))
          .andThen(() => this.fs.closeFile(handle.fd).mapErr(mapFsToStoreError))
          // On any error, attempt close before propagating the original error
          .orElse((err) =>
            this.fs.closeFile(handle.fd)
              .mapErr(() => err)  // Keep original error, ignore close error
              .andThen(() => errAsync(err))
          );
      });
  }
}

function mapFsToStoreError(e: FsError): SessionEventLogStoreError {
  return { code: 'SESSION_STORE_IO_ERROR' as const, message: e.message } satisfies SessionEventLogStoreError;
}

function nextManifestIndex(manifest: readonly ManifestRecordV1[]): number {
  if (manifest.length === 0) return 0;
  return manifest[manifest.length - 1]!.manifestIndex + 1;
}

function nextEventIndexFromManifest(manifest: readonly ManifestRecordV1[]): number {
  const segments = manifest.filter((m): m is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => m.kind === MANIFEST_KIND.SEGMENT_CLOSED);
  if (segments.length === 0) return 0;
  return segments[segments.length - 1]!.lastEventIndex + 1;
}

function validateManifestContiguity(manifest: readonly ManifestRecordV1[]): Result<void, SessionEventLogStoreError> {
  for (let i = 0; i < manifest.length; i++) {
    const expected = i;
    if (manifest[i]!.manifestIndex !== expected) {
      return err({
        code: 'SESSION_STORE_CORRUPTION_DETECTED',
        location: i === 0 ? 'head' : 'tail',
        reason: {
          code: 'non_contiguous_indices',
          message: `Non-contiguous manifestIndex at position ${i} (expected ${expected}, got ${manifest[i]!.manifestIndex})`,
        },
        message: `Non-contiguous manifestIndex at position ${i} (expected ${expected}, got ${manifest[i]!.manifestIndex})`,
      });
    }
  }
  return ok(undefined);
}

function validateSegmentClosedContiguity(manifest: readonly ManifestRecordV1[]): Result<void, SessionEventLogStoreError> {
  const segments = manifest.filter((m): m is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => m.kind === MANIFEST_KIND.SEGMENT_CLOSED);
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1]!;
    const cur = segments[i]!;
    if (cur.firstEventIndex !== prev.lastEventIndex + 1) {
      return err({
        code: 'SESSION_STORE_CORRUPTION_DETECTED',
        location: 'tail',
        reason: {
          code: 'non_contiguous_indices',
          message: `Non-contiguous segment_closed bounds (expected firstEventIndex=${prev.lastEventIndex + 1}, got ${cur.firstEventIndex})`,
        },
        message: `Non-contiguous segment_closed bounds (expected firstEventIndex=${prev.lastEventIndex + 1}, got ${cur.firstEventIndex})`,
      });
    }
  }
  return ok(undefined);
}

function validateAppendPlan(sessionId: SessionId, plan: AppendPlanV2, expectedFirstEventIndex: number): Result<void, SessionEventLogStoreError> {
  if (plan.events.length === 0) {
    return err({ code: 'SESSION_STORE_INVARIANT_VIOLATION', message: 'AppendPlan.events must be non-empty' });
  }

  // Validate schema + sessionId, and contiguity.
  const first = plan.events[0]!;
  if (first.eventIndex !== expectedFirstEventIndex) {
    return err({
      code: 'SESSION_STORE_INVARIANT_VIOLATION',
      message: `AppendPlan.eventIndex must start at ${expectedFirstEventIndex} (got ${first.eventIndex})`,
    });
  }

  for (let i = 0; i < plan.events.length; i++) {
    const e = DomainEventV1Schema.safeParse(plan.events[i]);
    if (!e.success) {
      return err({ code: 'SESSION_STORE_INVARIANT_VIOLATION', message: `Invalid domain event at index ${i}` });
    }
    if (e.data.sessionId !== sessionId) {
      return err({
        code: 'SESSION_STORE_INVARIANT_VIOLATION',
        message: `Domain event sessionId mismatch at index ${i}`,
      });
    }
    if (i > 0 && plan.events[i]!.eventIndex !== plan.events[i - 1]!.eventIndex + 1) {
      return err({
        code: 'SESSION_STORE_INVARIANT_VIOLATION',
        message: `Non-contiguous eventIndex in AppendPlan at index ${i}`,
      });
    }
  }

  // Validate snapshotPins are deterministic + refer to this segment range.
  const pins = sortedPins(plan.snapshotPins);
  for (const p of pins) {
    if (p.eventIndex < first.eventIndex || p.eventIndex > plan.events[plan.events.length - 1]!.eventIndex) {
      return err({
        code: 'SESSION_STORE_INVARIANT_VIOLATION',
        message: `SnapshotPin.eventIndex must refer to an event in the appended segment`,
      });
    }
  }
  return ok(undefined);
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

function concatJsonlRecords(records: readonly JsonValue[]): Result<Uint8Array, SessionEventLogStoreError> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const r of records) {
    const encoded = toJsonlLineBytes(r);
    if (encoded.isErr()) return err({ code: 'SESSION_STORE_INVARIANT_VIOLATION', message: encoded.error.message });
    const val = encoded.value;
    parts.push(val);
    total += val.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return ok(out);
}

function parseJsonlText<T>(text: string, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }): Result<T[], SessionEventLogStoreError> {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return err({
        code: 'SESSION_STORE_CORRUPTION_DETECTED',
        location: i === 0 ? 'head' : 'tail',
        reason: { code: 'non_contiguous_indices', message: `Invalid JSONL at line ${i}` },
        message: `Invalid JSONL at line ${i}`,
      });
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      // Check if this is a version mismatch or a schema validation failure
      // Safely extract version field by checking if it exists
      const rawVersion = (typeof parsed === 'object' && parsed !== null && 'v' in parsed) 
        ? (parsed as { v?: unknown }).v 
        : undefined;
      if (rawVersion !== 1) {
        // It's a genuine version mismatch
        return err({
          code: 'SESSION_STORE_CORRUPTION_DETECTED',
          location: i === 0 ? 'head' : 'tail',
          reason: { code: 'unknown_schema_version', message: `Expected v=1, got v=${rawVersion}` },
          message: `Unknown schema version at line ${i}: expected v=1, got v=${rawVersion}`,
        });
      }
      // Not a version mismatch—it's a schema validation failure under current constraints
      return err({
        code: 'SESSION_STORE_CORRUPTION_DETECTED',
        location: i === 0 ? 'head' : 'tail',
        reason: { code: 'schema_validation_failed', message: `Schema validation failed at line ${i}` },
        message: `Schema validation failed at line ${i}`,
      });
    }
    out.push(validated.data);
  }
  return ok(out);
}

function parseJsonlLines<T>(bytes: Uint8Array, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }): Result<T[], SessionEventLogStoreError> {
  const text = new TextDecoder().decode(bytes);
  return parseJsonlText(text, schema);
}

function extractSnapshotPinsFromEvents(events: readonly DomainEventV1[]): Array<{ snapshotRef: SnapshotRef; eventIndex: number; createdByEventId: string }> {
  // Slice 2.5 lock: snapshot pin enforcement is typed (no `any` casts).
  const out: Array<{ snapshotRef: SnapshotRef; eventIndex: number; createdByEventId: string }> = [];
  for (const e of events) {
    if (e.kind !== EVENT_KIND.NODE_CREATED) continue;
    out.push({ snapshotRef: e.data.snapshotRef, eventIndex: e.eventIndex, createdByEventId: e.eventId });
  }
  return out;
}

// Extracted from loadImpl and loadValidatedPrefixImpl: validate segment bounds and contiguity
function validateSegmentBounds(
  parsed: readonly DomainEventV1[],
  segment: { firstEventIndex: number; lastEventIndex: number; segmentRelPath: string }
): Result<void, SessionEventLogStoreError> {
  if (parsed.length === 0) {
    return err({
      code: 'SESSION_STORE_CORRUPTION_DETECTED' as const,
      location: 'tail' as const,
      reason: { code: 'non_contiguous_indices' as const, message: `Empty segment referenced by manifest: ${segment.segmentRelPath}` },
      message: `Empty segment referenced by manifest: ${segment.segmentRelPath}`,
    });
  }
  if (parsed[0]!.eventIndex !== segment.firstEventIndex || parsed[parsed.length - 1]!.eventIndex !== segment.lastEventIndex) {
    return err({
      code: 'SESSION_STORE_CORRUPTION_DETECTED' as const,
      location: 'tail' as const,
      reason: { code: 'non_contiguous_indices' as const, message: `Segment bounds mismatch: ${segment.segmentRelPath}` },
      message: `Segment bounds mismatch: ${segment.segmentRelPath}`,
    });
  }
  // Contiguity within segment
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i]!.eventIndex !== parsed[i - 1]!.eventIndex + 1) {
      return err({
        code: 'SESSION_STORE_CORRUPTION_DETECTED' as const,
        location: 'tail' as const,
        reason: { code: 'non_contiguous_indices' as const, message: `Non-contiguous eventIndex inside segment: ${segment.segmentRelPath}` },
        message: `Non-contiguous eventIndex inside segment: ${segment.segmentRelPath}`,
      });
    }
  }
  return ok(undefined);
}

// Extracted from loadValidatedPrefixImpl: parse manifest prefix line-by-line
function parseManifestPrefix(
  lines: readonly string[]
): {
  manifest: ManifestRecordV1[];
  isComplete: boolean;
  tailReason: CorruptionReasonV2 | null;
} {
  const manifest: ManifestRecordV1[] = [];
  let isComplete = true;
  let tailReason: CorruptionReasonV2 | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      isComplete = false;
      tailReason ??= { code: 'non_contiguous_indices', message: 'Invalid JSON in manifest (corrupt tail)' };
      break;
    }

    const validated = ManifestRecordV1Schema.safeParse(parsed);
    if (!validated.success) {
      isComplete = false;
      // Check if this is a version mismatch or a schema validation failure
      // Safely extract version field by checking if it exists and is a number
      const rawVersion = (typeof parsed === 'object' && parsed !== null && 'v' in parsed) 
        ? (parsed as { v?: unknown }).v 
        : undefined;
      if (rawVersion !== 1) {
        tailReason ??= { code: 'unknown_schema_version', message: `Expected v=1, got v=${rawVersion}` };
      } else {
        // Not a version mismatch—it's a schema validation failure
        tailReason ??= { code: 'schema_validation_failed', message: 'Manifest record schema validation failed (corrupt tail)' };
      }
      break;
    }

    if (validated.data.manifestIndex !== i) {
      isComplete = false;
      tailReason ??= { code: 'non_contiguous_indices', message: 'Non-contiguous manifestIndex in prefix (corrupt tail)' };
      break;
    }

    manifest.push(validated.data);
  }

  return { manifest, isComplete, tailReason };
}

// Extracted from loadValidatedPrefixImpl: process a single segment for salvage operation
function processSegmentForSalvage(args: {
  segment: Extract<ManifestRecordV1, { kind: 'segment_closed' }>;
  sessionDir: string;
  sha256: Sha256PortV2;
  fs: CrashSafeFileOpsPortV2;
  state: {
    readonly events: DomainEventV1[];
    readonly isComplete: boolean;
    readonly tailReason: CorruptionReasonV2 | null;
    readonly done: boolean;
  };
}): ResultAsync<{
  readonly events: DomainEventV1[];
  readonly isComplete: boolean;
  readonly tailReason: CorruptionReasonV2 | null;
  readonly done: boolean;
}, SessionEventLogStoreError> {
  if (args.state.done) return okAsync(args.state);

  const segmentPath = path.join(args.sessionDir, args.segment.segmentRelPath);
  return args.fs
    .readFileBytes(segmentPath)
    .map((bytes) => ({ kind: 'present' as const, bytes }))
    .orElse((e) => (e.code === 'FS_NOT_FOUND' ? okAsync({ kind: 'missing' as const }) : errAsync(mapFsToStoreError(e))))
    .andThen((res) => {
      if (res.kind === 'missing') {
        return okAsync({
          ...args.state,
          isComplete: false,
          tailReason: args.state.tailReason ?? { code: 'missing_attested_segment', message: `Missing attested segment: ${args.segment.segmentRelPath}` },
          done: true,
        });
      }

      const bytes = res.bytes;
      const actual = args.sha256.sha256(bytes);
      if (actual !== args.segment.sha256) {
        return okAsync({
          ...args.state,
          isComplete: false,
          tailReason: args.state.tailReason ?? { code: 'digest_mismatch', message: `Segment digest mismatch: ${args.segment.segmentRelPath}` },
          done: true,
        });
      }

      const parsedRes = parseJsonlLines(bytes, DomainEventV1Schema);
      if (parsedRes.isErr()) {
        return okAsync({
          ...args.state,
          isComplete: false,
          tailReason: args.state.tailReason ?? { code: 'non_contiguous_indices', message: `Invalid JSONL inside segment: ${args.segment.segmentRelPath}` },
          done: true,
        });
      }
      const parsed = parsedRes.value;

      const boundsResult = validateSegmentBounds(parsed, args.segment);
      if (boundsResult.isErr()) {
        const reason = boundsResult.error.code === 'SESSION_STORE_CORRUPTION_DETECTED' 
          ? boundsResult.error.reason 
          : { code: 'non_contiguous_indices' as const, message: boundsResult.error.message };
        return okAsync({
          ...args.state,
          isComplete: false,
          tailReason: args.state.tailReason ?? reason,
          done: true,
        });
      }

      return okAsync({
        ...args.state,
        events: [...args.state.events, ...parsed],
      });
    });
}

// Type alias for CrashSafeFileOpsPortV2 to match the required interface
type CrashSafeFileOpsPortV2 = Pick<FileSystemPortV2, 'readFileBytes'>;

// Extracted from loadImpl: recursive segment loading with full validation
function loadSegmentsRecursive(args: {
  segments: readonly Extract<ManifestRecordV1, { kind: 'segment_closed' }>[];
  sessionDir: string;
  sha256: Sha256PortV2;
  fs: CrashSafeFileOpsPortV2;
}): ResultAsync<readonly DomainEventV1[], SessionEventLogStoreError> {
  if (args.segments.length === 0) return okAsync([]);
  const [head, ...tail] = args.segments;
  const segmentPath = path.join(args.sessionDir, head.segmentRelPath);
  
  return args.fs.readFileBytes(segmentPath)
    .mapErr((e) => {
      if (e.code === 'FS_NOT_FOUND') {
        return {
          code: 'SESSION_STORE_CORRUPTION_DETECTED' as const,
          location: 'tail' as const,
          reason: { code: 'missing_attested_segment' as const, message: `Missing attested segment: ${head.segmentRelPath}` },
          message: `Missing attested segment: ${head.segmentRelPath}`,
        };
      }
      return mapFsToStoreError(e);
    })
    .andThen((bytes) => {
      const actual = args.sha256.sha256(bytes);
      if (actual !== head.sha256) {
        return errAsync({
          code: 'SESSION_STORE_CORRUPTION_DETECTED' as const,
          location: 'tail' as const,
          reason: { code: 'digest_mismatch' as const, message: `Segment digest mismatch: ${head.segmentRelPath}` },
          message: `Segment digest mismatch: ${head.segmentRelPath}`,
        });
      }
      const parsedRes = parseJsonlLines(bytes, DomainEventV1Schema);
      if (parsedRes.isErr()) return errAsync(parsedRes.error);
      const parsed = parsedRes.value;

      const boundsResult = validateSegmentBounds(parsed, head);
      if (boundsResult.isErr()) return errAsync(boundsResult.error);

      return okAsync(parsed);
    })
    .andThen((events) => loadSegmentsRecursive({ ...args, segments: tail }).map((rest) => [...events, ...rest]));
}
