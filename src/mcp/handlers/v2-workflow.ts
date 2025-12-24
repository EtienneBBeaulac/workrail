import type { ToolContext, ToolResult } from '../types.js';
import { success, error } from '../types.js';
import { mapUnknownErrorToToolError } from '../error-mapper.js';
import type { V2InspectWorkflowInput, V2ListWorkflowsInput } from '../v2/tools.js';
import { V2WorkflowInspectOutputSchema, V2WorkflowListOutputSchema } from '../output-schemas.js';

import { compileV1WorkflowToV2PreviewSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { NodeCryptoV2 } from '../../v2/infra/local/crypto/index.js';
import { LocalDataDirV2 } from '../../v2/infra/local/data-dir/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../v2/infra/local/pinned-workflow-store/index.js';
import { workflowHashForCompiledSnapshot } from '../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';

const TIMEOUT_MS = 30_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([operation, timeoutPromise]);
}

export async function handleV2ListWorkflows(
  _input: V2ListWorkflowsInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  try {
    const summaries = await withTimeout(ctx.workflowService.listWorkflowSummaries(), TIMEOUT_MS, 'list_workflows');
    const crypto = new NodeCryptoV2();
    const dataDir = new LocalDataDirV2(process.env);
    const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir);

    const compiled = await Promise.all(
      summaries.map(async (s) => {
        const wf = await ctx.workflowService.getWorkflowById(s.id);
        if (!wf) {
          return {
            workflowId: s.id,
            name: s.name,
            description: s.description,
            version: s.version,
            workflowHash: null,
            kind: 'workflow' as const,
          };
        }

        const snapshot = compileV1WorkflowToV2PreviewSnapshot(wf);
        const hashRes = workflowHashForCompiledSnapshot(snapshot as unknown as JsonValue, crypto);
        if (hashRes.isErr()) {
          return {
            workflowId: s.id,
            name: s.name,
            description: s.description,
            version: s.version,
            workflowHash: null,
            kind: 'workflow' as const,
          };
        }

        const hash = hashRes.value;
        const existing = await pinnedStore.get(hash).match((v) => v, () => null);
        if (!existing) {
          await pinnedStore.put(hash, snapshot).match(() => undefined, () => undefined);
        }

        return {
          workflowId: s.id,
          name: s.name,
          description: s.description,
          version: s.version,
          workflowHash: hash,
          kind: 'workflow' as const,
        };
      })
    );

    const payload = V2WorkflowListOutputSchema.parse({
      workflows: compiled.sort((a, b) => a.workflowId.localeCompare(b.workflowId)),
    });
    return success(payload);
  } catch (err) {
    const mapped = mapUnknownErrorToToolError(err);
    return error(mapped.code, mapped.message, mapped.suggestion, mapped.retry, mapped.details);
  }
}

export async function handleV2InspectWorkflow(
  input: V2InspectWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  try {
    const workflow = await withTimeout(ctx.workflowService.getWorkflowById(input.workflowId), TIMEOUT_MS, 'inspect_workflow');
    if (!workflow) {
      return error('NOT_FOUND', `Workflow not found: ${input.workflowId}`);
    }

    const crypto = new NodeCryptoV2();
    const dataDir = new LocalDataDirV2(process.env);
    const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir);

    const snapshot = compileV1WorkflowToV2PreviewSnapshot(workflow);
    const hashRes = workflowHashForCompiledSnapshot(snapshot as unknown as JsonValue, crypto);
    if (hashRes.isErr()) {
      return error('INTERNAL_ERROR', hashRes.error.message);
    }

    const workflowHash = hashRes.value;
    const existing = await pinnedStore.get(workflowHash).match((v) => v, () => null);
    if (!existing) {
      const wrote = await pinnedStore.put(workflowHash, snapshot).match(
        () => ({ ok: true as const }),
        (e) => ({ ok: false as const, error: e })
      );
      if (!wrote.ok) {
        return error('INTERNAL_ERROR', wrote.error.message);
      }
    }

    const compiled = (await pinnedStore.get(workflowHash).match((v) => v, () => null)) ?? snapshot;
    const body =
      input.mode === 'metadata'
        ? { schemaVersion: compiled.schemaVersion, sourceKind: compiled.sourceKind, workflowId: compiled.workflowId }
        : compiled;

    const payload = V2WorkflowInspectOutputSchema.parse({
      workflowId: input.workflowId,
      workflowHash,
      mode: input.mode,
      compiled: body,
    });
    return success(payload);
  } catch (err) {
    const mapped = mapUnknownErrorToToolError(err);
    return error(mapped.code, mapped.message, mapped.suggestion, mapped.retry, mapped.details);
  }
}
