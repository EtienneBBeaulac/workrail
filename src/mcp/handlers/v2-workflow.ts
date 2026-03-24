import { ResultAsync, okAsync, errAsync } from 'neverthrow';
import type { ToolContext, ToolResult } from '../types.js';
import { success, errNotRetryable, requireV2Context } from '../types.js';
import { mapUnknownErrorToToolError } from '../error-mapper.js';
import { internalSuggestion } from './v2-execution-helpers.js';
import type { V2InspectWorkflowInput, V2ListWorkflowsInput } from '../v2/tools.js';
import { V2WorkflowInspectOutputSchema, V2WorkflowListOutputSchema } from '../output-schemas.js';

import { compileV1WorkflowToV2PreviewSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { workflowHashForCompiledSnapshot } from '../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';

const TIMEOUT_MS = 30_000;

import { withTimeout } from './shared/with-timeout.js';
import { createWorkflowReaderForRequest, hasRequestWorkspaceSignal } from './shared/request-workflow-reader.js';

export async function handleV2ListWorkflows(
  input: V2ListWorkflowsInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  const guard = requireV2Context(ctx);
  if (!guard.ok) return guard.error;
  const { crypto, pinnedStore } = guard.ctx.v2;
  const workflowReader = hasRequestWorkspaceSignal({
    workspacePath: input.workspacePath,
    resolvedRootUris: guard.ctx.v2.resolvedRootUris,
  })
    ? createWorkflowReaderForRequest({
        featureFlags: ctx.featureFlags,
        workspacePath: input.workspacePath,
        resolvedRootUris: guard.ctx.v2.resolvedRootUris,
      })
    : ctx.workflowService;

  return ResultAsync.fromPromise(
    withTimeout(workflowReader.listWorkflowSummaries(), TIMEOUT_MS, 'list_workflows'),
    (err) => mapUnknownErrorToToolError(err)
  )
    .andThen((summaries) =>
      ResultAsync.combine(
        summaries.map((s) =>
          ResultAsync.fromPromise(
            workflowReader.getWorkflowById(s.id),
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
  const guard = requireV2Context(ctx);
  if (!guard.ok) return guard.error;
  const { crypto, pinnedStore } = guard.ctx.v2;
  const workflowReader = hasRequestWorkspaceSignal({
    workspacePath: input.workspacePath,
    resolvedRootUris: guard.ctx.v2.resolvedRootUris,
  })
    ? createWorkflowReaderForRequest({
        featureFlags: ctx.featureFlags,
        workspacePath: input.workspacePath,
        resolvedRootUris: guard.ctx.v2.resolvedRootUris,
      })
    : ctx.workflowService;

  return ResultAsync.fromPromise(
    withTimeout(workflowReader.getWorkflowById(input.workflowId), TIMEOUT_MS, 'inspect_workflow'),
    (err) => mapUnknownErrorToToolError(err)
  )
    .andThen((workflow) => {
      if (!workflow) {
        return errAsync(errNotRetryable('NOT_FOUND', `Workflow not found: ${input.workflowId}`));
      }

      const snapshot = compileV1WorkflowToV2PreviewSnapshot(workflow);
      const hashRes = workflowHashForCompiledSnapshot(snapshot as unknown as JsonValue, crypto);
      if (hashRes.isErr()) {
        return errAsync(errNotRetryable('INTERNAL_ERROR',
          'WorkRail could not compute a content hash for the workflow definition. This is not caused by your input.',
          { suggestion: internalSuggestion('Retry inspect_workflow.', 'WorkRail has an internal error computing workflow hashes.') },
        ));
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
        .andThen((compiled) => {
          if (!compiled) {
            return errAsync(errNotRetryable('INTERNAL_ERROR',
              'WorkRail could not produce a compiled workflow snapshot. This is not caused by your input.',
              { suggestion: internalSuggestion('Retry inspect_workflow.', 'WorkRail has an internal error.') },
            ));
          }
          const body =
            input.mode === 'metadata'
              ? { schemaVersion: compiled.schemaVersion, sourceKind: compiled.sourceKind, workflowId: compiled.workflowId }
              : compiled;

          // Surface references for discoverability (available before start_workflow)
          const references = workflow.definition.references;
          const payload = V2WorkflowInspectOutputSchema.parse({
            workflowId: input.workflowId,
            workflowHash,
            mode: input.mode,
            compiled: body,
            ...(references != null && references.length > 0 ? { references } : {}),
          });
          return okAsync(success(payload) as ToolResult<unknown>);
        });
    })
    .match(
      (result) => Promise.resolve(result),
      (err) => Promise.resolve(err as ToolResult<unknown>)
    );
}
