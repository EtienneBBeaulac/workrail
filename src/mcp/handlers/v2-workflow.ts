import path from 'path';
import fs from 'fs';
import { ResultAsync, okAsync, errAsync } from 'neverthrow';
import type { ToolContext, ToolResult } from '../types.js';
import { success, errNotRetryable, requireV2Context } from '../types.js';
import { mapUnknownErrorToToolError } from '../error-mapper.js';
import { internalSuggestion } from './v2-execution-helpers.js';
import type { V2InspectWorkflowInput, V2ListWorkflowsInput } from '../v2/tools.js';
import { V2WorkflowInspectOutputSchema, V2WorkflowListOutputSchema } from '../output-schemas.js';
import type { StalenessSummary } from '../output-schemas.js';
import type { RememberedRootRecordV2 } from '../../v2/ports/remembered-roots-store.port.js';
import type { CryptoPortV2 } from '../../v2/durable-core/canonical/hashing.js';
import type { PinnedWorkflowStorePortV2 } from '../../v2/ports/pinned-workflow-store.port.js';
import type { Workflow } from '../../types/workflow.js';
import type { IWorkflowReader, ICompositeWorkflowStorage } from '../../types/storage.js';

import { compileV1WorkflowToV2PreviewSnapshot } from '../../v2/read-only/v1-to-v2-shim.js';
import { workflowHashForCompiledSnapshot } from '../../v2/durable-core/canonical/hashing.js';
import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';

const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Staleness detection
// ---------------------------------------------------------------------------

function readCurrentSpecVersion(): number | null {
  try {
    const specPath = path.resolve(__dirname, '../../../spec/authoring-spec.json');
    const raw = fs.readFileSync(specPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const v = (parsed as Record<string, unknown>)['version'];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v;
    }
    return null;
  } catch {
    return null;
  }
}

const CURRENT_SPEC_VERSION: number | null = readCurrentSpecVersion();

/**
 * When set to '1', surfaces staleness for all workflow categories (including built-in
 * and legacy_project). Intended for maintainer use only — not documented publicly.
 */
const DEV_STALENESS: boolean = process.env['WORKRAIL_DEV_STALENESS'] === '1';

/**
 * Whether to surface the staleness field for a given workflow visibility category.
 * By default only user-owned/imported workflows get the signal; DEV_STALENESS bypasses this.
 */
function shouldShowStaleness(category: string | undefined): boolean {
  if (DEV_STALENESS) return true;
  return category === 'personal' || category === 'rooted_sharing' || category === 'external';
}

export function computeWorkflowStaleness(
  stamp: number | undefined,
  currentVersion: number | null,
): StalenessSummary | undefined {
  if (currentVersion === null) return undefined;
  if (stamp === undefined) {
    return {
      level: 'possible',
      reason: 'This workflow has not been validated against the authoring spec via workflow-for-workflows.',
    };
  }
  if (stamp === currentVersion) {
    return {
      level: 'none',
      reason: `Workflow validated against current authoring spec (v${currentVersion}).`,
      specVersionAtLastReview: stamp,
    };
  }
  return {
    level: 'likely',
    reason: `Authoring spec updated from v${stamp} to v${currentVersion} since this workflow was last reviewed.`,
    specVersionAtLastReview: stamp,
  };
}

import { withTimeout } from './shared/with-timeout.js';
import { createWorkflowReaderForRequest, hasRequestWorkspaceSignal } from './shared/request-workflow-reader.js';
import { listRememberedRootRecords, rememberExplicitWorkspaceRoot } from './shared/remembered-roots.js';
import {
  detectWorkflowMigrationGuidance,
  toWorkflowVisibility,
  isCompositeWorkflowReader,
  deriveGroupLabel,
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
  const readerResult = hasRequestWorkspaceSignal({
    workspacePath: input.workspacePath,
    resolvedRootUris: guard.ctx.v2.resolvedRootUris,
  })
    ? await createWorkflowReaderForRequest({
        featureFlags: ctx.featureFlags,
        workspacePath: input.workspacePath,
        resolvedRootUris: guard.ctx.v2.resolvedRootUris,
        rememberedRootsStore: guard.ctx.v2.rememberedRootsStore,
      })
    : { reader: ctx.workflowService, stalePaths: [] as string[] };
  const workflowReader = readerResult.reader;
  const stalePaths = readerResult.stalePaths;

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
    .andThen((compiled) => {
      if (!input.includeSources) {
        const payload = V2WorkflowListOutputSchema.parse({
          workflows: compiled.sort((a, b) => a.workflowId.localeCompare(b.workflowId)),
          ...(stalePaths.length > 0 ? { staleRoots: [...stalePaths] } : {}),
        });
        return okAsync(success(payload) as ToolResult<unknown>);
      }
      // Reuse workflowReader directly -- it already uses the same factory as the
      // source catalog, so catalog and listing show the same set of sources.
      if (!isCompositeWorkflowReader(workflowReader)) {
        const payload = V2WorkflowListOutputSchema.parse({
          workflows: compiled.sort((a, b) => a.workflowId.localeCompare(b.workflowId)),
          ...(stalePaths.length > 0 ? { staleRoots: [...stalePaths] } : {}),
          sources: [],
        });
        return okAsync(success(payload) as ToolResult<unknown>);
      }
      return ResultAsync.fromPromise(
        withTimeout(buildSourceCatalog(workflowReader, rememberedRootRecords), TIMEOUT_MS, 'list_workflow_sources'),
        (err) => mapUnknownErrorToToolError(err),
      ).map((sources) => {
        const payload = V2WorkflowListOutputSchema.parse({
          workflows: compiled.sort((a, b) => a.workflowId.localeCompare(b.workflowId)),
          ...(stalePaths.length > 0 ? { staleRoots: [...stalePaths] } : {}),
          sources,
        });
        return success(payload) as ToolResult<unknown>;
      });
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
  const readerResult = hasRequestWorkspaceSignal({
    workspacePath: input.workspacePath,
    resolvedRootUris: guard.ctx.v2.resolvedRootUris,
  })
    ? await createWorkflowReaderForRequest({
        featureFlags: ctx.featureFlags,
        workspacePath: input.workspacePath,
        resolvedRootUris: guard.ctx.v2.resolvedRootUris,
        rememberedRootsStore: guard.ctx.v2.rememberedRootsStore,
      })
    : { reader: ctx.workflowService, stalePaths: [] as string[] };
  const workflowReader = readerResult.reader;
  const stalePaths = readerResult.stalePaths;

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
              ...(stalePaths.length > 0 ? { staleRoots: [...stalePaths] } : {}),
              ...(references != null && references.length > 0 ? { references } : {}),
              ...(() => {
                const s = shouldShowStaleness(visibility?.category)
                  ? computeWorkflowStaleness(workflow.definition.validatedAgainstSpecVersion, CURRENT_SPEC_VERSION)
                  : undefined;
                return s !== undefined ? { staleness: s } : {};
              })(),
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

  const staleness = shouldShowStaleness(visibility?.category)
    ? computeWorkflowStaleness(workflow.definition.validatedAgainstSpecVersion, CURRENT_SPEC_VERSION)
    : undefined;
  return {
    workflowId: summary.id,
    name: summary.name,
    description: summary.description,
    version: summary.version,
    workflowHash: hash,
    kind: 'workflow' as const,
    visibility,
    ...(staleness !== undefined ? { staleness } : {}),
  };
}

// -----------------------------------------------------------------------------
// Source catalog helpers (used by handleV2ListWorkflows when includeSources=true)
// -----------------------------------------------------------------------------

type WorkflowSource = import('../../types/workflow-source.js').WorkflowSource;
type RootedSharingContext = import('./shared/workflow-source-visibility.js').RootedSharingContext;

interface SourceEntryData {
  readonly source: WorkflowSource;
  readonly allIds: readonly string[];
  readonly effectiveIds: readonly string[];
}

async function buildSourceCatalog(
  workflowReader: import('../../types/storage.js').ICompositeWorkflowStorage,
  rememberedRootRecords: readonly RememberedRootRecordV2[],
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const instances = workflowReader.getStorageInstances();

  // EnhancedMultiSourceWorkflowStorage uses last-wins deduplication:
  // "highest priority last -- overwrites earlier sources" (Priority 7 = project = last).
  // Iterate from highest priority (last) to lowest (first) with a seenIds set, so
  // each instance's effectiveIds = workflows not yet claimed by a higher-priority instance.
  const seenIds = new Set<string>();
  const sourceEntryDataReversed: SourceEntryData[] = [];

  for (let i = instances.length - 1; i >= 0; i--) {
    const instance = instances[i]!;
    const summaries = await instance.listWorkflowSummaries();
    const allIds = summaries.map((s) => s.id);
    const effectiveIds = allIds.filter((id) => !seenIds.has(id));
    for (const id of allIds) seenIds.add(id);
    sourceEntryDataReversed.push({ source: instance.source, allIds, effectiveIds });
  }

  // Restore original order so the catalog output matches storage instance order.
  const sourceEntryData = sourceEntryDataReversed.reverse();

  return sourceEntryData.map((data) =>
    deriveSourceCatalogEntry({ ...data, rememberedRootRecords, sourceEntryData }),
  );
}

function deriveSourceCatalogEntry(options: {
  readonly source: WorkflowSource;
  readonly allIds: readonly string[];
  readonly effectiveIds: readonly string[];
  readonly rememberedRootRecords: readonly RememberedRootRecordV2[];
  readonly sourceEntryData: readonly SourceEntryData[];
}): Record<string, unknown> {
  const { source, allIds, effectiveIds, rememberedRootRecords, sourceEntryData } = options;
  const total = allIds.length;
  const effective = effectiveIds.length;
  const shadowed = total - effective;
  const sourceKey = deriveSourceKey(source);
  const displayName = deriveDisplayName(source);

  switch (source.kind) {
    case 'bundled':
      return { sourceKey, category: 'built_in', source: { kind: source.kind, displayName }, sourceMode: 'built_in', effectiveWorkflowCount: effective, totalWorkflowCount: total, shadowedWorkflowCount: shadowed };

    case 'user':
      return { sourceKey, category: 'personal', source: { kind: source.kind, displayName }, sourceMode: 'personal', effectiveWorkflowCount: effective, totalWorkflowCount: total, shadowedWorkflowCount: shadowed };

    case 'project': {
      const thisIds = new Set(allIds);
      const hasMigrationOverlap = sourceEntryData.some((e) => {
        if (e.source === source || e.source.kind !== 'custom') return false;
        const rootedSharing = deriveRootedSharingForPath(e.source.directoryPath, rememberedRootRecords);
        return rootedSharing != null && e.allIds.some((id) => thisIds.has(id));
      });
      const migration = hasMigrationOverlap
        ? { preferredSource: 'rooted_sharing' as const, currentSource: 'legacy_project' as const, reason: 'legacy_project_precedence' as const, summary: 'Project-scoped ./workflows currently overrides rooted .workrail/workflows during migration. Prefer rooted sharing for new team-shared workflows.' }
        : undefined;
      return { sourceKey, category: 'legacy_project', source: { kind: source.kind, displayName }, sourceMode: 'legacy_project', effectiveWorkflowCount: effective, totalWorkflowCount: total, shadowedWorkflowCount: shadowed, ...(migration ? { migration } : {}) };
    }

    case 'custom': {
      const rootedSharing = deriveRootedSharingForPath(source.directoryPath, rememberedRootRecords);
      const category = rootedSharing ? 'rooted_sharing' : 'external';
      const sourceMode = rootedSharing ? 'rooted_sharing' : 'live_directory';
      return { sourceKey, category, source: { kind: source.kind, displayName }, sourceMode, effectiveWorkflowCount: effective, totalWorkflowCount: total, shadowedWorkflowCount: shadowed, ...(rootedSharing ? { rootedSharing } : {}) };
    }

    case 'git':
    case 'remote':
    case 'plugin':
      return { sourceKey, category: 'external', source: { kind: source.kind, displayName }, sourceMode: 'live_directory', effectiveWorkflowCount: effective, totalWorkflowCount: total, shadowedWorkflowCount: shadowed };
  }
}

function deriveSourceKey(source: WorkflowSource): string {
  switch (source.kind) {
    case 'bundled': return 'built_in';
    case 'user': return `user:${source.directoryPath}`;
    case 'project': return `project:${source.directoryPath}`;
    case 'custom': return `custom:${source.directoryPath}`;
    case 'git': return `git:${source.repositoryUrl}`;
    case 'remote': return `remote:${source.registryUrl}`;
    case 'plugin': return `plugin:${source.pluginName}`;
  }
}

function deriveDisplayName(source: WorkflowSource): string {
  switch (source.kind) {
    case 'bundled': return 'Built-in';
    case 'user': return 'User Library';
    case 'project': return 'Project';
    case 'custom': return source.label ?? path.basename(source.directoryPath);
    case 'git': return source.repositoryUrl;
    case 'remote': return source.registryUrl;
    case 'plugin': return source.pluginName;
  }
}

function deriveRootedSharingForPath(
  sourcePath: string,
  rememberedRoots: readonly RememberedRootRecordV2[],
): RootedSharingContext | undefined {
  const resolved = path.resolve(sourcePath);
  for (const record of rememberedRoots) {
    const rootPath = path.resolve(record.path);
    const relative = path.relative(rootPath, resolved);
    const isUnderRoot = relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (!isUnderRoot) continue;
    return { kind: 'remembered_root', rootPath, groupLabel: deriveGroupLabel(rootPath, resolved) };
  }
  return undefined;
}
