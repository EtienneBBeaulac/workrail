import { ResultAsync, okAsync, errAsync } from 'neverthrow';
import type { ToolContext, ToolResult } from '../types.js';
import { success, errNotRetryable, requireV2Context } from '../types.js';
import { mapUnknownErrorToToolError } from '../error-mapper.js';
import { internalSuggestion } from './v2-execution-helpers.js';
import type { V2InspectWorkflowInput, V2ListWorkflowsInput } from '../v2/tools.js';
import { V2WorkflowInspectOutputSchema, V2WorkflowListOutputSchema } from '../output-schemas.js';
import type { RememberedRootRecordV2 } from '../../v2/ports/remembered-roots-store.port.js';
import type { CryptoPortV2 } from '../../v2/durable-core/canonical/hashing.js';
import type { PinnedWorkflowStorePortV2 } from '../../v2/ports/pinned-workflow-store.port.js';
import type { Workflow } from '../../types/workflow.js';
import type { IWorkflowReader } from '../../types/storage.js';

import { compileV1WorkflowToV2PreviewSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { workflowHashForCompiledSnapshot } from '../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';

const TIMEOUT_MS = 30_000;

import { withTimeout } from './shared/with-timeout.js';
import { createWorkflowReaderForRequest, hasRequestWorkspaceSignal } from './shared/request-workflow-reader.js';
import { listRememberedRootRecords, rememberExplicitWorkspaceRoot } from './shared/remembered-roots.js';
import {
  detectWorkflowMigrationGuidance,
  toWorkflowVisibility,
} from './shared/workflow-source-visibility.js';

interface WorkflowLookupReader {
  readonly getWorkflowById: (id: string) => Promise<Workflow | null>;
  readonly listWorkflowSummaries: () => Promise<readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly version: string;
  }[]>;
}

function isToolErrorResult(
  value: readonly RememberedRootRecordV2[] | ToolResult<unknown>,
): value is ToolResult<unknown> {
  return !Array.isArray(value);
}

export async function handleV2ListWorkflows(
  input: V2ListWorkflowsInput,
  ctx: ToolContext
): Promise<ToolResult<unknown>> {
  const guard = requireV2Context(ctx);
  if (!guard.ok) return guard.error;
  const rememberedRootFailure = await rememberExplicitWorkspaceRoot(input.workspacePath, guard.ctx.v2.rememberedRootsStore);
  if (rememberedRootFailure) return rememberedRootFailure;
  const rememberedRootRecordsResult = await listRememberedRootRecords(guard.ctx.v2.rememberedRootsStore);
  if (isToolErrorResult(rememberedRootRecordsResult)) return rememberedRootRecordsResult;
  const rememberedRootRecords = rememberedRootRecordsResult;
  const { crypto, pinnedStore } = guard.ctx.v2;
  const workflowReader = hasRequestWorkspaceSignal({
    workspacePath: input.workspacePath,
    resolvedRootUris: guard.ctx.v2.resolvedRootUris,
  })
    ? await createWorkflowReaderForRequest({
        featureFlags: ctx.featureFlags,
        workspacePath: input.workspacePath,
        resolvedRootUris: guard.ctx.v2.resolvedRootUris,
        rememberedRootsStore: guard.ctx.v2.rememberedRootsStore,
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
            buildV2WorkflowListItem({
              summary: s,
              workflowReader,
              rememberedRootRecords,
              crypto,
              pinnedStore,
            }),
            (err) => mapUnknownErrorToToolError(err)
          )
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
  const rememberedRootFailure = await rememberExplicitWorkspaceRoot(input.workspacePath, guard.ctx.v2.rememberedRootsStore);
  if (rememberedRootFailure) return rememberedRootFailure;
  const rememberedRootRecordsResult = await listRememberedRootRecords(guard.ctx.v2.rememberedRootsStore);
  if (isToolErrorResult(rememberedRootRecordsResult)) return rememberedRootRecordsResult;
  const rememberedRootRecords = rememberedRootRecordsResult;
  const { crypto, pinnedStore } = guard.ctx.v2;
  const workflowReader = hasRequestWorkspaceSignal({
    workspacePath: input.workspacePath,
    resolvedRootUris: guard.ctx.v2.resolvedRootUris,
  })
    ? await createWorkflowReaderForRequest({
        featureFlags: ctx.featureFlags,
        workspacePath: input.workspacePath,
        resolvedRootUris: guard.ctx.v2.resolvedRootUris,
        rememberedRootsStore: guard.ctx.v2.rememberedRootsStore,
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
      return ResultAsync.fromPromise(
        buildWorkflowVisibility(workflow, workflowReader, rememberedRootRecords),
        (err) => mapUnknownErrorToToolError(err)
      ).andThen((visibility) =>
        pinnedStore
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
              ...(visibility ? { visibility } : {}),
              ...(references != null && references.length > 0 ? { references } : {}),
            });
            return okAsync(success(payload) as ToolResult<unknown>);
          })
      );
    })
    .match(
      (result) => Promise.resolve(result),
      (err) => Promise.resolve(err as ToolResult<unknown>)
    );
}

async function buildWorkflowVisibility(
  workflow: Workflow,
  workflowReader: WorkflowLookupReader,
  rememberedRootRecords: readonly RememberedRootRecordV2[],
) {
  const migration = await detectWorkflowMigrationGuidance({
    workflow,
    workflowReader: workflowReader as IWorkflowReader,
    rememberedRoots: rememberedRootRecords,
  });

  return toWorkflowVisibility(workflow, rememberedRootRecords, { migration });
}

async function buildV2WorkflowListItem(options: {
  readonly summary: {
    readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  };
  readonly workflowReader: WorkflowLookupReader;
  readonly rememberedRootRecords: readonly RememberedRootRecordV2[];
  readonly crypto: CryptoPortV2;
  readonly pinnedStore: PinnedWorkflowStorePortV2;
}) {
  const { summary, workflowReader, rememberedRootRecords, crypto, pinnedStore } = options;
  const workflow = await workflowReader.getWorkflowById(summary.id);

  if (!workflow) {
    return {
      workflowId: summary.id,
      name: summary.name,
      description: summary.description,
      version: summary.version,
      workflowHash: null,
      kind: 'workflow' as const,
    };
  }

  const visibility = await buildWorkflowVisibility(workflow, workflowReader, rememberedRootRecords);
  const snapshot = compileV1WorkflowToV2PreviewSnapshot(workflow);
  const hashRes = workflowHashForCompiledSnapshot(snapshot as unknown as JsonValue, crypto);
  if (hashRes.isErr()) {
    return {
      workflowId: summary.id,
      name: summary.name,
      description: summary.description,
      version: summary.version,
      workflowHash: null,
      kind: 'workflow' as const,
      visibility,
    };
  }

  const hash = hashRes.value;
  const existing = await pinnedStore.get(hash);
  if (existing.isOk() && !existing.value) {
    const persisted = await pinnedStore.put(hash, snapshot);
    if (persisted.isErr()) {
      return {
        workflowId: summary.id,
        name: summary.name,
        description: summary.description,
        version: summary.version,
        workflowHash: hash,
        kind: 'workflow' as const,
        visibility,
      };
    }
  }

  return {
    workflowId: summary.id,
    name: summary.name,
    description: summary.description,
    version: summary.version,
    workflowHash: hash,
    kind: 'workflow' as const,
    visibility,
  };
}
