import { ResultAsync, okAsync, errAsync } from 'neverthrow';
import type { ToolContext, ToolResult } from '../types.js';
import { success, errNotRetryable } from '../types.js';
import { mapUnknownErrorToToolError } from '../error-mapper.js';
import type { V2InspectWorkflowInput, V2ListWorkflowsInput } from '../v2/tools.js';
import { V2WorkflowInspectOutputSchema, V2WorkflowListOutputSchema } from '../output-schemas.js';

import { compileV1WorkflowToV2PreviewSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { workflowHashForCompiledSnapshot } from '../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';

const TIMEOUT_MS = 30_000;

import { withTimeout } from './shared/with-timeout.js';

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

  return ResultAsync.fromPromise(
    withTimeout(ctx.workflowService.listWorkflowSummaries(), TIMEOUT_MS, 'list_workflows'),
    (err) => mapUnknownErrorToToolError(err)
  )
    .andThen((summaries) =>
      ResultAsync.combine(
        summaries.map((s) =>
          ResultAsync.fromPromise(
            ctx.workflowService.getWorkflowById(s.id),
            (err) => mapUnknownErrorToToolError(err)
          ).andThen((wf) => {
            if (!wf) {
              return okAsync({
                workflowId: s.id,
                name: s.name,
                description: s.description,
                version: s.version,
                workflowHash: null,
                kind: 'workflow' as const,
              });
            }

            const snapshot = compileV1WorkflowToV2PreviewSnapshot(wf);
            const hashRes = workflowHashForCompiledSnapshot(snapshot as unknown as JsonValue, crypto);
            if (hashRes.isErr()) {
              return okAsync({
                workflowId: s.id,
                name: s.name,
                description: s.description,
                version: s.version,
                workflowHash: null,
                kind: 'workflow' as const,
              });
            }

            const hash = hashRes.value;
            return pinnedStore
              .get(hash)
              .andThen((existing) => {
                if (!existing) {
                  return pinnedStore.put(hash, snapshot).map(() => undefined);
                }
                return okAsync(undefined);
              })
              .map(() => ({
                workflowId: s.id,
                name: s.name,
                description: s.description,
                version: s.version,
                workflowHash: hash,
                kind: 'workflow' as const,
              }))
              .orElse(() =>
                okAsync({
                  workflowId: s.id,
                  name: s.name,
                  description: s.description,
                  version: s.version,
                  workflowHash: hash,
                  kind: 'workflow' as const,
                })
              );
          })
        )
      )
    )
    .map((compiled) => {
      const payload = V2WorkflowListOutputSchema.parse({
        workflows: compiled.sort((a, b) => a.workflowId.localeCompare(b.workflowId)),
      });
      return success(payload) as ToolResult<unknown>;
    })
    .match(
      (result) => Promise.resolve(result),
      (err) => Promise.resolve(err as ToolResult<unknown>)
    );
}

export async function handleV2InspectWorkflow(
  input: V2InspectWorkflowInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  const v2Err = requireV2(ctx);
  if (v2Err) return v2Err;
  const { crypto, pinnedStore } = ctx.v2!;

  return ResultAsync.fromPromise(
    withTimeout(ctx.workflowService.getWorkflowById(input.workflowId), TIMEOUT_MS, 'inspect_workflow'),
    (err) => mapUnknownErrorToToolError(err)
  )
    .andThen((workflow) => {
      if (!workflow) {
        return errAsync(errNotRetryable('NOT_FOUND', `Workflow not found: ${input.workflowId}`));
      }

      const snapshot = compileV1WorkflowToV2PreviewSnapshot(workflow);
      const hashRes = workflowHashForCompiledSnapshot(snapshot as unknown as JsonValue, crypto);
      if (hashRes.isErr()) {
        return errAsync(errNotRetryable('INTERNAL_ERROR', hashRes.error.message));
      }

      const workflowHash = hashRes.value;
      return pinnedStore
        .get(workflowHash)
        .andThen((existing) => {
          if (!existing) {
            return pinnedStore.put(workflowHash, snapshot).map(() => snapshot);
          }
          return okAsync(existing);
        })
        .orElse(() => okAsync(snapshot))
        .map((compiled) => {
          if (!compiled) {
            throw new Error('Compiled workflow unexpectedly null');
          }
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
          return success(payload) as ToolResult<unknown>;
        });
    })
    .match(
      (result) => Promise.resolve(result),
      (err) => Promise.resolve(err as ToolResult<unknown>)
    );
}
