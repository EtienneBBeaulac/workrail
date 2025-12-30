import type { ToolContext, ToolResult } from '../types.js';
import { success, errNotRetryable } from '../types.js';
import { mapUnknownErrorToToolError } from '../error-mapper.js';
import type { V2InspectWorkflowInput, V2ListWorkflowsInput } from '../v2/tools.js';
import { V2WorkflowInspectOutputSchema, V2WorkflowListOutputSchema } from '../output-schemas.js';

import { compileV1WorkflowToV2PreviewSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { workflowHashForCompiledSnapshot } from '../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';

const TIMEOUT_MS = 30_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([operation, timeoutPromise]);
}

/**
 * Require v2 context to be available.
 * Returns PRECONDITION_FAILED if v2 tools are not enabled.
 */
function requireV2(ctx: ToolContext): ToolResult<NonNullable<typeof ctx.v2>> | null {
  if (!ctx.v2) {
    return errNotRetryable('PRECONDITION_FAILED', 'v2 tools are not enabled');
  }
  return null;
}

export async function handleV2ListWorkflows(
  _input: V2ListWorkflowsInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  const v2Err = requireV2(ctx);
  if (v2Err) return v2Err;
  const { crypto, pinnedStore } = ctx.v2!;

  try {
    const summaries = await withTimeout(ctx.workflowService.listWorkflowSummaries(), TIMEOUT_MS, 'list_workflows');

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
    return mapped;
  }
}

export async function handleV2InspectWorkflow(
  input: V2InspectWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  const v2Err = requireV2(ctx);
  if (v2Err) return v2Err;
  const { crypto, pinnedStore } = ctx.v2!;

  try {
    const workflow = await withTimeout(ctx.workflowService.getWorkflowById(input.workflowId), TIMEOUT_MS, 'inspect_workflow');
    if (!workflow) {
      return errNotRetryable('NOT_FOUND', `Workflow not found: ${input.workflowId}`);
    }

    const snapshot = compileV1WorkflowToV2PreviewSnapshot(workflow);
    const hashRes = workflowHashForCompiledSnapshot(snapshot as unknown as JsonValue, crypto);
    if (hashRes.isErr()) {
      return errNotRetryable('INTERNAL_ERROR', hashRes.error.message);
    }

    const workflowHash = hashRes.value;
    const existing = await pinnedStore.get(workflowHash).match((v) => v, () => null);
    if (!existing) {
      const wrote = await pinnedStore.put(workflowHash, snapshot).match(
        () => ({ ok: true as const }),
        (e) => ({ ok: false as const, error: e })
      );
      if (!wrote.ok) {
        return errNotRetryable('INTERNAL_ERROR', wrote.error.message);
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
    return mapped;
  }
}
