import * as fs from 'fs/promises';
import type { ResultAsync } from 'neverthrow';
import { ResultAsync as RA } from 'neverthrow';
import type { PinnedWorkflowStorePortV2, PinnedWorkflowStoreError } from '../../../ports/pinned-workflow-store.port.js';
import type { WorkflowHash } from '../../../durable-core/ids/index.js';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import { CompiledWorkflowSnapshotSchema, type CompiledWorkflowSnapshot } from '../../../durable-core/schemas/compiled-workflow/index.js';
import { toCanonicalBytes } from '../../../durable-core/canonical/jcs.js';
import type { JsonValue } from '../../../durable-core/canonical/json-types.js';

export class LocalPinnedWorkflowStoreV2 implements PinnedWorkflowStorePortV2 {
  constructor(private readonly dataDir: DataDirPortV2) {}

  get(workflowHash: WorkflowHash): ResultAsync<CompiledWorkflowSnapshot | null, PinnedWorkflowStoreError> {
    const filePath = this.dataDir.pinnedWorkflowPath(workflowHash);
    return RA.fromPromise(
      (async () => {
        try {
          const raw = await fs.readFile(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          const validated = CompiledWorkflowSnapshotSchema.safeParse(parsed);
          if (!validated.success) {
            throw new Error(`Pinned workflow snapshot is invalid: ${filePath}`);
          }
          return validated.data;
        } catch (e: any) {
          if (e?.code === 'ENOENT') return null;
          throw e;
        }
      })(),
      (e) => ({
        code: 'PINNED_WORKFLOW_IO_ERROR',
        message: `Failed to read pinned workflow snapshot: ${filePath} (${e instanceof Error ? e.message : String(e)})`,
      })
    );
  }

  put(workflowHash: WorkflowHash, compiled: CompiledWorkflowSnapshot): ResultAsync<void, PinnedWorkflowStoreError> {
    const dir = this.dataDir.pinnedWorkflowsDir();
    const filePath = this.dataDir.pinnedWorkflowPath(workflowHash);

    return RA.fromPromise(
      (async () => {
        await fs.mkdir(dir, { recursive: true });

        // Store as canonical JSON (JCS) for deterministic on-disk representation.
        const canonical = toCanonicalBytes(compiled as unknown as JsonValue);
        if (canonical.isErr()) {
          throw new Error(`Failed to canonicalize compiled snapshot for storage: ${canonical.error.message}`);
        }

        const tmp = `${filePath}.tmp`;
        await fs.writeFile(tmp, Buffer.from(canonical.value));
        await fs.rename(tmp, filePath);
      })(),
      (e) => ({
        code: 'PINNED_WORKFLOW_IO_ERROR',
        message: `Failed to write pinned workflow snapshot: ${filePath} (${e instanceof Error ? e.message : String(e)})`,
      })
    );
  }
}
