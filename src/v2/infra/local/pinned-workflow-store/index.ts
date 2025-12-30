import * as path from 'path';
import type { ResultAsync } from 'neverthrow';
import { ResultAsync as RA, okAsync, errAsync } from 'neverthrow';
import type { PinnedWorkflowStorePortV2, PinnedWorkflowStoreError } from '../../../ports/pinned-workflow-store.port.js';
import type { WorkflowHash } from '../../../durable-core/ids/index.js';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2, FsError } from '../../../ports/fs.port.js';
import { CompiledWorkflowSnapshotSchema, type CompiledWorkflowSnapshot } from '../../../durable-core/schemas/compiled-workflow/index.js';
import { toCanonicalBytes } from '../../../durable-core/canonical/jcs.js';
import type { JsonValue } from '../../../durable-core/canonical/json-types.js';

function mapFsToStoreError(e: FsError): PinnedWorkflowStoreError {
  return { code: 'PINNED_WORKFLOW_IO_ERROR', message: e.message };
}

export class LocalPinnedWorkflowStoreV2 implements PinnedWorkflowStorePortV2 {
  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2
  ) {}

  get(workflowHash: WorkflowHash): ResultAsync<CompiledWorkflowSnapshot | null, PinnedWorkflowStoreError> {
    const filePath = this.dataDir.pinnedWorkflowPath(workflowHash);

    return this.fs.readFileUtf8(filePath)
      .orElse((e) => {
        // Map FS_NOT_FOUND to Ok(null) per port contract (errors-as-data: branch on code, not message)
        if (e.code === 'FS_NOT_FOUND') return okAsync(null);
        return errAsync(mapFsToStoreError(e));
      })
      .andThen((raw) => {
        if (raw === null) return okAsync(null);

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return errAsync({
            code: 'PINNED_WORKFLOW_IO_ERROR',
            message: `Invalid JSON in pinned workflow snapshot: ${filePath}`,
          } as const);
        }

        const validated = CompiledWorkflowSnapshotSchema.safeParse(parsed);
        if (!validated.success) {
          return errAsync({
            code: 'PINNED_WORKFLOW_IO_ERROR',
            message: `Pinned workflow snapshot is invalid: ${filePath}`,
          } as const);
        }

        return okAsync(validated.data);
      });
  }

  put(workflowHash: WorkflowHash, compiled: CompiledWorkflowSnapshot): ResultAsync<void, PinnedWorkflowStoreError> {
    const dir = this.dataDir.pinnedWorkflowsDir();
    const filePath = this.dataDir.pinnedWorkflowPath(workflowHash);
    const tmpPath = `${filePath}.tmp`;

    // Canonicalize first (sync, can fail)
    const canonical = toCanonicalBytes(compiled as unknown as JsonValue).mapErr((e) => ({
      code: 'PINNED_WORKFLOW_IO_ERROR',
      message: `Failed to canonicalize compiled snapshot for storage: ${e.message}`,
    }) as const);
    if (canonical.isErr()) return errAsync(canonical.error);

    const bytes = canonical.value;

    // Crash-safe write: mkdirp -> openWriteTruncate(tmp) -> writeAll -> fsyncFile -> closeFile -> rename -> fsyncDir
    return this.fs.mkdirp(dir)
      .mapErr(mapFsToStoreError)
      .andThen(() => this.fs.openWriteTruncate(tmpPath).mapErr(mapFsToStoreError))
      .andThen(({ fd }) =>
        this.fs.writeAll(fd, bytes)
          .mapErr(mapFsToStoreError)
          .andThen(() => this.fs.fsyncFile(fd).mapErr(mapFsToStoreError))
          .andThen(() => this.fs.closeFile(fd).mapErr(mapFsToStoreError))
          .orElse((e) =>
            // Ensure cleanup on error: close fd, then propagate error
            this.fs.closeFile(fd)
              .mapErr(() => e)  // Ignore close error, propagate original
              .andThen(() => errAsync(e))
          )
      )
      .andThen(() => this.fs.rename(tmpPath, filePath).mapErr(mapFsToStoreError))
      .andThen(() =>
        this.fs.fsyncDir(dir).mapErr((e) => {
          // Treat FS_UNSUPPORTED as error (strict durability per implementation_plan.md)
          return mapFsToStoreError(e);
        })
      );
  }
}
