import path from 'path';
import { z } from 'zod';
import { okAsync, errAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2, FsError } from '../../../ports/fs.port.js';
import type {
  ManagedSourceRecordV2,
  ManagedSourceStoreError,
  ManagedSourceStorePortV2,
} from '../../../ports/managed-source-store.port.js';

const MANAGED_SOURCE_LOCK_RETRY_MS = 250;
import { toCanonicalBytes } from '../../../durable-core/canonical/jcs.js';
import type { JsonValue } from '../../../durable-core/canonical/json-types.js';

const ManagedSourceRecordSchema = z.object({
  path: z.string(),
  addedAtMs: z.number().int().nonnegative(),
});

const ManagedSourcesFileSchema = z.object({
  v: z.literal(1),
  sources: z.array(ManagedSourceRecordSchema),
});

type ManagedSourcesFile = z.infer<typeof ManagedSourcesFileSchema>;

function mapFsToManagedSourceError(e: FsError): ManagedSourceStoreError {
  if (e.code === 'FS_ALREADY_EXISTS') {
    return {
      code: 'MANAGED_SOURCE_BUSY',
      message: 'Managed sources are being updated by another WorkRail process.',
      retry: { kind: 'retryable_after_ms', afterMs: MANAGED_SOURCE_LOCK_RETRY_MS },
      lockPath: 'managed-sources.lock',
    };
  }
  return { code: 'MANAGED_SOURCE_IO_ERROR', message: e.message };
}

function normalizeRecords(sources: readonly ManagedSourceRecordV2[]): readonly ManagedSourceRecordV2[] {
  const seen = new Set<string>();
  const normalized: ManagedSourceRecordV2[] = [];

  for (const source of sources) {
    const normalizedPath = path.resolve(source.path);
    if (seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    normalized.push({ path: normalizedPath, addedAtMs: source.addedAtMs });
  }

  return normalized;
}

export class LocalManagedSourceStoreV2 implements ManagedSourceStorePortV2 {
  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2,
  ) {}

  list(): ResultAsync<readonly ManagedSourceRecordV2[], ManagedSourceStoreError> {
    // No lock needed: rename() is atomic at the VFS level; readers see either the old
    // or the new file entirely, never a partial write. Same pattern as remembered-roots-store.
    return this.readSources();
  }

  attach(sourcePath: string): ResultAsync<void, ManagedSourceStoreError> {
    const normalizedPath = path.resolve(sourcePath);
    const nowMs = Date.now();

    return this.withLock(() =>
      this.readSources().andThen((sources) => {
        const alreadyPresent = sources.some((s) => s.path === normalizedPath);
        if (alreadyPresent) return okAsync(undefined);

        const next = [...sources, { path: normalizedPath, addedAtMs: nowMs }];
        return this.persist(next);
      })
    );
  }

  detach(sourcePath: string): ResultAsync<void, ManagedSourceStoreError> {
    const normalizedPath = path.resolve(sourcePath);

    return this.withLock(() =>
      this.readSources().andThen((sources) => {
        const next = sources.filter((s) => s.path !== normalizedPath);
        if (next.length === sources.length) return okAsync(undefined); // no-op
        return this.persist(next);
      })
    );
  }

  private readSources(): ResultAsync<readonly ManagedSourceRecordV2[], ManagedSourceStoreError> {
    const filePath = this.dataDir.managedSourcesPath();

    return this.fs.readFileUtf8(filePath)
      .orElse((e) => {
        if (e.code === 'FS_NOT_FOUND') return okAsync('');
        return errAsync(mapFsToManagedSourceError(e));
      })
      .andThen((raw) => {
        if (raw === '') return okAsync([] as const);

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return errAsync({
            code: 'MANAGED_SOURCE_CORRUPTION',
            message: `Invalid JSON in managed sources file: ${filePath}`,
          } as const);
        }

        const validated = ManagedSourcesFileSchema.safeParse(parsed);
        if (!validated.success) {
          return errAsync({
            code: 'MANAGED_SOURCE_CORRUPTION',
            message: `Managed sources file has invalid shape: ${filePath}`,
          } as const);
        }

        return okAsync(normalizeRecords(validated.data.sources));
      });
  }

  private persist(sources: readonly ManagedSourceRecordV2[]): ResultAsync<void, ManagedSourceStoreError> {
    const filePath = this.dataDir.managedSourcesPath();
    const dir = path.dirname(filePath);
    const tmpPath = `${filePath}.tmp`;

    const fileValue: ManagedSourcesFile = {
      v: 1,
      sources: [...normalizeRecords(sources)],
    };

    const canonical = toCanonicalBytes(fileValue as unknown as JsonValue).mapErr((e) => ({
      code: 'MANAGED_SOURCE_IO_ERROR',
      message: `Failed to canonicalize managed sources state: ${e.message}`,
    }) as const);
    if (canonical.isErr()) return errAsync(canonical.error);

    const bytes = canonical.value;

    return this.fs.mkdirp(dir)
      .mapErr(mapFsToManagedSourceError)
      .andThen(() => this.fs.openWriteTruncate(tmpPath).mapErr(mapFsToManagedSourceError))
      .andThen(({ fd }) =>
        this.fs.writeAll(fd, bytes)
          .mapErr(mapFsToManagedSourceError)
          .andThen(() => this.fs.fsyncFile(fd).mapErr(mapFsToManagedSourceError))
          .andThen(() => this.fs.closeFile(fd).mapErr(mapFsToManagedSourceError))
          .orElse((e) =>
            this.fs.closeFile(fd)
              .mapErr(() => e)
              .andThen(() => errAsync(e)),
          )
      )
      .andThen(() => this.fs.rename(tmpPath, filePath).mapErr(mapFsToManagedSourceError))
      .andThen(() => this.fs.fsyncDir(dir).mapErr(mapFsToManagedSourceError));
  }

  private withLock<T>(
    run: () => ResultAsync<T, ManagedSourceStoreError>
  ): ResultAsync<T, ManagedSourceStoreError> {
    const lockPath = this.dataDir.managedSourcesLockPath();
    const dir = path.dirname(lockPath);
    const lockBytes = new TextEncoder().encode(JSON.stringify({ v: 1, pid: process.pid }));

    return this.fs.mkdirp(dir)
      .mapErr(mapFsToManagedSourceError)
      .andThen(() => this.fs.openExclusive(lockPath, lockBytes)
        .mapErr((e) => {
          const mapped = mapFsToManagedSourceError(e);
          if (mapped.code === 'MANAGED_SOURCE_BUSY') {
            return { ...mapped, lockPath } as const;
          }
          return mapped;
        }))
      .andThen(({ fd }) =>
        this.fs.fsyncFile(fd)
          .mapErr(mapFsToManagedSourceError)
          .andThen(() => this.fs.closeFile(fd).mapErr(mapFsToManagedSourceError))
          .andThen(() => run())
          .andThen((value) =>
            this.fs.unlink(lockPath)
              .orElse((e) => {
                if (e.code === 'FS_NOT_FOUND') return okAsync(undefined);
                return errAsync(mapFsToManagedSourceError(e));
              })
              .map(() => value)
          )
          .orElse((error) =>
            this.fs.unlink(lockPath)
              .orElse((e) => {
                if (e.code === 'FS_NOT_FOUND') return okAsync(undefined);
                return errAsync(mapFsToManagedSourceError(e));
              })
              .andThen(() => errAsync(error))
          )
      );
  }
}
