import type { ResultAsync } from 'neverthrow';
import { ResultAsync as RA, okAsync, errAsync } from 'neverthrow';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2, FsError } from '../../../ports/fs.port.js';
import type { SnapshotStoreError, SnapshotStorePortV2 } from '../../../ports/snapshot-store.port.js';
import type { SnapshotRef } from '../../../durable-core/ids/index.js';
import { asSnapshotRef } from '../../../durable-core/ids/index.js';
import type { ExecutionSnapshotFileV1 } from '../../../durable-core/schemas/execution-snapshot/index.js';
import { ExecutionSnapshotFileV1Schema } from '../../../durable-core/schemas/execution-snapshot/index.js';
import type { CryptoPortV2 } from '../../../durable-core/canonical/hashing.js';
import { toCanonicalBytes } from '../../../durable-core/canonical/jcs.js';
import type { JsonValue } from '../../../durable-core/canonical/json-types.js';

export class LocalSnapshotStoreV2 implements SnapshotStorePortV2 {
  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2,
    private readonly crypto: CryptoPortV2
  ) {}

  putExecutionSnapshotV1(snapshot: ExecutionSnapshotFileV1): ResultAsync<SnapshotRef, SnapshotStoreError> {
    // Canonicalize early to avoid writing non-canonical JSON by accident.
    const canonical = toCanonicalBytes(snapshot as unknown as JsonValue).mapErr((e) => ({
      code: 'SNAPSHOT_STORE_INVARIANT_VIOLATION',
      message: e.message,
    }) as const);
    if (canonical.isErr()) return errAsync(canonical.error);

    const ref = asSnapshotRef(this.crypto.sha256(canonical.value));

    const dir = this.dataDir.snapshotsDir();
    const filePath = this.dataDir.snapshotPath(ref);
    const tmpPath = `${filePath}.tmp`;

    return this.fs
      .mkdirp(dir)
      .andThen(() => this.fs.openWriteTruncate(tmpPath))
      .andThen((h) =>
        this.fs
          .writeAll(h.fd, canonical.value)
          .andThen(() => this.fs.fsyncFile(h.fd))
          .andThen(() => this.fs.closeFile(h.fd))
      )
      .andThen(() => this.fs.rename(tmpPath, filePath))
      .andThen(() => this.fs.fsyncDir(dir))
      .map(() => ref)
      .mapErr((e) => ({ code: 'SNAPSHOT_STORE_IO_ERROR', message: e.message } as const));
  }

  getExecutionSnapshotV1(snapshotRef: SnapshotRef): ResultAsync<ExecutionSnapshotFileV1 | null, SnapshotStoreError> {
    const filePath = this.dataDir.snapshotPath(snapshotRef);
    return this.fs
      .readFileBytes(filePath)
      .andThen((bytes) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          return errAsync({
            code: 'SNAPSHOT_STORE_CORRUPTION_DETECTED',
            message: `Invalid JSON snapshot file: ${filePath}`,
          } as const);
        }

        const validated = ExecutionSnapshotFileV1Schema.safeParse(parsed);
        if (!validated.success) {
          return errAsync({
            code: 'SNAPSHOT_STORE_CORRUPTION_DETECTED',
            message: `Invalid execution snapshot file: ${filePath}`,
          } as const);
        }

        return okAsync(validated.data);
      })
      .orElse((e: FsError | SnapshotStoreError) => {
        if (e.code === 'FS_NOT_FOUND') return okAsync(null);
        if (e.code === 'FS_IO_ERROR' || e.code === 'FS_ALREADY_EXISTS' || e.code === 'FS_PERMISSION_DENIED' || e.code === 'FS_UNSUPPORTED') {
          return errAsync({ code: 'SNAPSHOT_STORE_IO_ERROR', message: e.message } as const);
        }
        return errAsync(e);
      });
  }
}
