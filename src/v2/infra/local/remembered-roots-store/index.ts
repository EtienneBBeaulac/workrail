import path from 'path';
import { z } from 'zod';
import { okAsync, errAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2, FsError } from '../../../ports/fs.port.js';
import type {
  RememberedRootRecordV2,
  RememberedRootsStoreError,
  RememberedRootsStorePortV2,
} from '../../../ports/remembered-roots-store.port.js';
import { toCanonicalBytes } from '../../../durable-core/canonical/jcs.js';
import type { JsonValue } from '../../../durable-core/canonical/json-types.js';

const REMEMBERED_ROOTS_LOCK_RETRY_MS = 250;

const RememberedRootRecordSchema = z.object({
  path: z.string(),
  addedAtMs: z.number().int().nonnegative(),
  lastSeenAtMs: z.number().int().nonnegative(),
  source: z.literal('explicit_workspace_path'),
});

const RememberedRootsFileSchema = z.object({
  v: z.literal(1),
  roots: z.array(RememberedRootRecordSchema),
});

type RememberedRootsFile = z.infer<typeof RememberedRootsFileSchema>;

function mapFsToRememberedRootsError(e: FsError): RememberedRootsStoreError {
  if (e.code === 'FS_ALREADY_EXISTS') {
    return {
      code: 'REMEMBERED_ROOTS_BUSY',
      message: 'Remembered roots are being updated by another WorkRail process.',
      retry: { kind: 'retryable_after_ms', afterMs: REMEMBERED_ROOTS_LOCK_RETRY_MS },
      lockPath: 'remembered-roots.lock',
    };
  }
  return { code: 'REMEMBERED_ROOTS_IO_ERROR', message: e.message };
}

function normalizeRootRecords(roots: readonly RememberedRootRecordV2[]): readonly RememberedRootRecordV2[] {
  const seen = new Set<string>();
  const normalized: RememberedRootRecordV2[] = [];

  for (const root of roots) {
    const nextPath = path.resolve(root.path);
    if (seen.has(nextPath)) continue;
    seen.add(nextPath);
    normalized.push({
      path: nextPath,
      addedAtMs: root.addedAtMs,
      lastSeenAtMs: root.lastSeenAtMs,
      source: root.source,
    });
  }

  return normalized;
}

export class LocalRememberedRootsStoreV2 implements RememberedRootsStorePortV2 {
  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2,
  ) {}

  listRoots(): ResultAsync<readonly string[], RememberedRootsStoreError> {
    return this.listRootRecords().map((roots) => roots.map((root) => root.path));
  }

  listRootRecords(): ResultAsync<readonly RememberedRootRecordV2[], RememberedRootsStoreError> {
    const filePath = this.dataDir.rememberedRootsPath();

    return this.fs.readFileUtf8(filePath)
      .orElse((e) => {
        if (e.code === 'FS_NOT_FOUND') return okAsync('');
        return errAsync(mapFsToRememberedRootsError(e));
      })
      .andThen((raw) => {
        if (raw === '') return okAsync([] as const);

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return errAsync({
            code: 'REMEMBERED_ROOTS_CORRUPTION',
            message: `Invalid JSON in remembered roots file: ${filePath}`,
          } as const);
        }

        const validated = RememberedRootsFileSchema.safeParse(parsed);
        if (!validated.success) {
          return errAsync({
            code: 'REMEMBERED_ROOTS_CORRUPTION',
            message: `Remembered roots file has invalid shape: ${filePath}`,
          } as const);
        }

        return okAsync(normalizeRootRecords(validated.data.roots));
      });
  }

  rememberRoot(rootPath: string): ResultAsync<void, RememberedRootsStoreError> {
    const normalizedRoot = path.resolve(rootPath);
    const nowMs = Date.now();

    return this.withLock(() =>
      this.listRootRecords().andThen((roots) => {
        const existing = roots.find((root) => root.path === normalizedRoot);
        const nextRoots = existing
          ? roots.map((root) =>
              root.path === normalizedRoot
                ? { ...root, lastSeenAtMs: nowMs }
                : root
            )
          : [
              ...roots,
              {
                path: normalizedRoot,
                addedAtMs: nowMs,
                lastSeenAtMs: nowMs,
                source: 'explicit_workspace_path' as const,
              },
            ];

        return this.persist(nextRoots);
      })
    );
  }

  private persist(roots: readonly RememberedRootRecordV2[]): ResultAsync<void, RememberedRootsStoreError> {
    const filePath = this.dataDir.rememberedRootsPath();
    const dir = path.dirname(filePath);
    const tmpPath = `${filePath}.tmp`;

    const fileValue: RememberedRootsFile = {
      v: 1,
      roots: [...normalizeRootRecords(roots)],
    };

    const canonical = toCanonicalBytes(fileValue as unknown as JsonValue).mapErr((e) => ({
      code: 'REMEMBERED_ROOTS_IO_ERROR',
      message: `Failed to canonicalize remembered roots state: ${e.message}`,
    }) as const);
    if (canonical.isErr()) return errAsync(canonical.error);

    const bytes = canonical.value;

    return this.fs.mkdirp(dir)
      .mapErr(mapFsToRememberedRootsError)
      .andThen(() => this.fs.openWriteTruncate(tmpPath).mapErr(mapFsToRememberedRootsError))
      .andThen(({ fd }) =>
        this.fs.writeAll(fd, bytes)
          .mapErr(mapFsToRememberedRootsError)
          .andThen(() => this.fs.fsyncFile(fd).mapErr(mapFsToRememberedRootsError))
          .andThen(() => this.fs.closeFile(fd).mapErr(mapFsToRememberedRootsError))
          .orElse((e) =>
            this.fs.closeFile(fd)
              .mapErr(() => e)
              .andThen(() => errAsync(e)),
          )
      )
      .andThen(() => this.fs.rename(tmpPath, filePath).mapErr(mapFsToRememberedRootsError))
      .andThen(() => this.fs.fsyncDir(dir).mapErr(mapFsToRememberedRootsError));
  }

  private withLock<T>(
    run: () => ResultAsync<T, RememberedRootsStoreError>
  ): ResultAsync<T, RememberedRootsStoreError> {
    const lockPath = this.dataDir.rememberedRootsLockPath();
    const dir = path.dirname(lockPath);
    const lockBytes = new TextEncoder().encode(JSON.stringify({ v: 1, pid: process.pid }));

    return this.fs.mkdirp(dir)
      .mapErr(mapFsToRememberedRootsError)
      .andThen(() => this.fs.openExclusive(lockPath, lockBytes)
        .mapErr((e) => {
          const mapped = mapFsToRememberedRootsError(e);
          if (mapped.code === 'REMEMBERED_ROOTS_BUSY') {
            return { ...mapped, lockPath } as const;
          }
          return mapped;
        }))
      .andThen(({ fd }) =>
        this.fs.fsyncFile(fd)
          .mapErr(mapFsToRememberedRootsError)
          .andThen(() => this.fs.closeFile(fd).mapErr(mapFsToRememberedRootsError))
          .andThen(() => run())
          .andThen((value) =>
            this.fs.unlink(lockPath)
              .orElse((e) => {
                if (e.code === 'FS_NOT_FOUND') return okAsync(undefined);
                return errAsync(mapFsToRememberedRootsError(e));
              })
              .map(() => value)
          )
          .orElse((error) =>
            this.fs.unlink(lockPath)
              .orElse((e) => {
                if (e.code === 'FS_NOT_FOUND') return okAsync(undefined);
                return errAsync(mapFsToRememberedRootsError(e));
              })
              .andThen(() => errAsync(error))
          )
      );
  }
}
