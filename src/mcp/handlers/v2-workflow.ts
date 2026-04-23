import path from 'path';
import fs from 'fs';
import { ResultAsync, okAsync, errAsync } from 'neverthrow';
import type { z } from 'zod';
import type { ToolContext, ToolResult } from '../types.js';
import { success, errNotRetryable, requireV2Context } from '../types.js';
import { mapUnknownErrorToToolError } from '../error-mapper.js';
import { internalSuggestion } from './v2-execution-helpers.js';
import { assertNever } from '../../runtime/assert-never.js';
import type { V2InspectWorkflowInput, V2ListWorkflowsInput } from '../v2/tools.js';
import type { V2WorkflowInspectOutputSchema, V2WorkflowListOutputSchema, StalenessSummary } from '../output-schemas.js';
import type { RememberedRootRecordV2 } from '../../v2/ports/remembered-roots-store.port.js';
import type { ManagedSourceRecordV2 } from '../../v2/ports/managed-source-store.port.js';
import type { CryptoPortV2 } from '../../v2/durable-core/canonical/hashing.js';
import type { PinnedWorkflowStorePortV2 } from '../../v2/ports/pinned-workflow-store.port.js';
import type { Workflow } from '../../types/workflow.js';
import type { IWorkflowReader, ICompositeWorkflowStorage } from '../../types/storage.js';
import type { HasValidationWarnings, ValidationWarning } from '../../infrastructure/storage/schema-validating-workflow-storage.js';

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
 * Whether to surface the staleness field for a given workflow visibility category.
 * By default only user-owned/imported workflows get the signal.
 * When dev mode is active (WORKRAIL_DEV=1), all categories get the signal.
 */
export function shouldShowStaleness(category: string | undefined, devMode: boolean = isDevMode()): boolean {
  if (devMode) return true;
  return category === 'personal' || category === 'rooted_sharing' || category === 'external';
}

// ---------------------------------------------------------------------------
// Tag-first discovery
// ---------------------------------------------------------------------------

interface WorkflowTagsFile {
  readonly tags: ReadonlyArray<{
    readonly id: string;
    readonly displayName: string;
    readonly when: readonly string[];
    readonly examples: readonly string[];
  }>;
  readonly workflows: Readonly<Record<string, { readonly tags: readonly string[]; readonly hidden?: boolean }>>;
}

function readWorkflowTags(): WorkflowTagsFile | null {
  try {
    const tagsPath = path.resolve(__dirname, '../../../spec/workflow-tags.json');
    const raw = fs.readFileSync(tagsPath, 'utf-8');
    return JSON.parse(raw) as WorkflowTagsFile;
  } catch {
    return null;
  }
}

const WORKFLOW_TAGS: WorkflowTagsFile | null = readWorkflowTags();

/** Well-known acronyms that should not be title-cased like ordinary words. */
const NAMESPACE_ACRONYMS: Readonly<Record<string, string>> = {
  ios: 'iOS',
  api: 'API',
  ui: 'UI',
  ux: 'UX',
  mcp: 'MCP',
};

/**
 * Convert a kebab-case namespace like "mercury-android" to a display name like "Mercury Android".
 * Recognises common acronyms so "mercury-ios" becomes "Mercury iOS".
 */
function namespaceToDisplayName(namespace: string): string {
  return namespace
    .split('-')
    .map((word) => NAMESPACE_ACRONYMS[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Build virtual source tags for namespaced workflow IDs that are not registered in the
 * bundled tags file (e.g. "mercury-android.clickstream-implementation" → tag "mercury-android").
 * Exported for unit testing.
 */
export function buildVirtualSourceTags(
  tagsFile: WorkflowTagsFile,
  compiledWorkflowIds: readonly string[],
): Array<{ id: string; displayName: string; count: number; when: string[]; examples: string[] }> {
  const registeredIds = new Set(Object.keys(tagsFile.workflows));
  const namespaceMap = new Map<string, string[]>();
  for (const id of compiledWorkflowIds) {
    if (registeredIds.has(id)) continue;
    const dotIndex = id.indexOf('.');
    if (dotIndex === -1) continue;
    const namespace = id.slice(0, dotIndex);
    const bucket = namespaceMap.get(namespace);
    if (bucket) {
      bucket.push(id);
    } else {
      namespaceMap.set(namespace, [id]);
    }
  }
  return Array.from(namespaceMap.entries()).map(([namespace, ids]) => {
    const displayName = namespaceToDisplayName(namespace);
    return {
      id: namespace,
      displayName,
      count: ids.length,
      when: [`running ${displayName} workflows`],
      examples: ids.slice(0, 3),
    };
  });
}

/**
 * Build a tag summary from the tag definitions and the compiled workflow list.
 * Bundled functional tags come first; virtual source tags for unregistered namespaced
 * workflows are appended after.
 * Exported for unit testing.
 */
export function buildTagSummary(
  tagsFile: WorkflowTagsFile,
  compiledWorkflowIds: readonly string[],
): Array<{ id: string; displayName: string; count: number; when: string[]; examples: string[] }> {
  const idSet = new Set(compiledWorkflowIds);
  const bundledTags = tagsFile.tags.map((tag) => {
    const count = Object.entries(tagsFile.workflows)
      .filter(([wid, meta]) => !meta.hidden && idSet.has(wid) && meta.tags.includes(tag.id))
      .length;
    return {
      id: tag.id,
      displayName: tag.displayName,
      count,
      when: [...tag.when],
      examples: [...tag.examples],
    };
  });
  // Invariant: bundled tag IDs are functional slugs (e.g. "coding", "review_audit") while
  // virtual source tag IDs are namespace prefixes (e.g. "mercury-android"). These
  // namespaces are categorically distinct, so collision is not expected. If workflow-tags.json
  // ever gains a bundled tag whose id matches a team namespace, two entries with the same id
  // would appear in the summary — update the bundled tag id to avoid the overlap.
  return [...bundledTags, ...buildVirtualSourceTags(tagsFile, compiledWorkflowIds)];
}

/**
 * Filter compiled workflow IDs to those matching any of the requested tags.
 * Handles both bundled functional tags (from tagsFile.workflows) and virtual source
 * tags derived from namespace prefixes (e.g. tag "mercury-android" matches all IDs of
 * the form "mercury-android.*" that are not in the bundled registry).
 */
export function filterByTags(
  tagsFile: WorkflowTagsFile,
  compiledWorkflowIds: readonly string[],
  requestedTags: readonly string[],
): readonly string[] {
  const tagSet = new Set(requestedTags);
  // Registered workflow matching (bundled functional tags).
  const matching = new Set(
    Object.entries(tagsFile.workflows)
      .filter(([, meta]) => !meta.hidden && meta.tags.some((t) => tagSet.has(t)))
      .map(([wid]) => wid),
  );
  // Virtual namespace tag matching: tag "mercury-android" matches all unregistered IDs
  // whose namespace prefix equals the requested tag.
  const registeredIds = new Set(Object.keys(tagsFile.workflows));
  for (const id of compiledWorkflowIds) {
    if (registeredIds.has(id)) continue;
    const dotIndex = id.indexOf('.');
    if (dotIndex === -1) continue;
    const namespace = id.slice(0, dotIndex);
    if (tagSet.has(namespace)) matching.add(id);
  }
  return compiledWorkflowIds.filter((id) => matching.has(id));
}

export function computeWorkflowStaleness(
  stamp: number | undefined,
  currentVersion: number | null,
): StalenessSummary | undefined {
  if (currentVersion === null) return undefined;
  if (stamp === undefined) {
    return {
      level: 'possible',
      reason: 'This workflow has not been validated against the authoring spec via wr.workflow-for-workflows.',
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

import { isDevMode } from '../dev-mode.js';
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
  readonly loadAllWorkflows: () => Promise<readonly Workflow[]>;
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
        managedSourceStore: guard.ctx.v2.managedSourceStore,
      })
    : { reader: ctx.workflowService, stalePaths: [] as string[], managedSourceRecords: [] as ManagedSourceRecordV2[], staleManagedRecords: [] as ManagedSourceRecordV2[], managedStoreError: undefined as string | undefined };
  const workflowReader = readerResult.reader;
  const stalePaths = readerResult.stalePaths;
  const managedSourceRecords = readerResult.managedSourceRecords;
  const staleManagedRecords = readerResult.staleManagedRecords;
  const managedStoreError = readerResult.managedStoreError;
  const warnings = managedStoreError
    ? [`Managed workflow source store was temporarily unavailable (${managedStoreError}). Managed sources were not loaded.`]
    : undefined;

  // Type-narrow to HasValidationWarnings to collect structured diagnostics for workflows
  // that failed schema validation. When the reader supports it (i.e. it is one of the
  // validating wrapper classes), we call loadAllWorkflowsWithWarnings() to get both the
  // valid workflows and the failure diagnostics in one pass. When the reader is the
  // ctx.workflowService singleton fallback (no workspace signal), it does not implement
  // HasValidationWarnings -- we fall through to loadAllWorkflows() and omit the field.
  const hasValidationWarnings = (r: unknown): r is HasValidationWarnings =>
    typeof (r as Record<string, unknown>).loadAllWorkflowsWithWarnings === 'function';

  // Load all workflows in a single pass and build a Map for O(1) access.
  // Previously this called listWorkflowSummaries() then fanned out to N
  // individual getWorkflowById() calls -- one per workflow (N+1 pattern).
  let capturedValidationWarnings: readonly ValidationWarning[] | undefined;
  return ResultAsync.fromPromise(
    hasValidationWarnings(workflowReader)
      ? withTimeout(workflowReader.loadAllWorkflowsWithWarnings(), TIMEOUT_MS, 'list_workflows').then(
          ({ workflows, warnings }) => {
            capturedValidationWarnings = warnings.length > 0 ? warnings : undefined;
            return workflows;
          }
        )
      : withTimeout(workflowReader.loadAllWorkflows(), TIMEOUT_MS, 'list_workflows'),
    (err) => mapUnknownErrorToToolError(err)
  )
    .andThen((allWorkflows) => {
      const workflowMap = new Map<string, Workflow>(allWorkflows.map((w) => [w.definition.id, w]));
      // Build summary list from loaded workflows to preserve sort-stability and filtering.
      const summaries = allWorkflows.map((w) => ({
        id: w.definition.id,
        name: w.definition.name,
        description: w.definition.description,
        version: w.definition.version,
      }));
      return ResultAsync.combine(
        summaries.map((s) =>
          ResultAsync.fromPromise(
            buildV2WorkflowListItem({
              workflow: workflowMap.get(s.id) ?? null,
              summary: s,
              workflowReader,
              rememberedRootRecords,
              crypto,
              pinnedStore,
            }),
            (err) => mapUnknownErrorToToolError(err)
          )
        )
      );
    })
    .andThen((compiled) => {
      const sortedIds = compiled.map((w) => w.workflowId).sort((a, b) => a.localeCompare(b));
      const sortedCompiled = [...compiled].sort((a, b) => a.workflowId.localeCompare(b.workflowId));

      // Tag-first discovery:
      // - No tags filter: return tagSummary + workflows: [] (compact first call, ~500 tokens)
      // - tags filter: return full filtered list, no tagSummary
      // - includeSources=true: always return full list (source catalog mode, backward compat)
      const tagFilteredCompiled = (() => {
        if (input.includeSources) return sortedCompiled; // source catalog: always full list
        if (!WORKFLOW_TAGS) return sortedCompiled; // no tags file: fall back to full list
        if (input.tags && input.tags.length > 0) {
          const filteredIds = new Set(filterByTags(WORKFLOW_TAGS, sortedIds, input.tags));
          return sortedCompiled.filter((w) => filteredIds.has(w.workflowId));
        }
        return []; // default: empty — tagSummary is the first-call response
      })();

      const tagSummaryEntry = (() => {
        if (input.includeSources) return undefined; // source catalog mode: no tagSummary
        if (!WORKFLOW_TAGS) return undefined;
        if (input.tags && input.tags.length > 0) return undefined; // tags filter = no summary
        return buildTagSummary(WORKFLOW_TAGS, sortedIds);
      })();

      // _nextStep: guide the agent when tagSummary is returned (no tags filter),
      // or when validationWarnings are present (tell the agent to fix the errors).
      // staleRoots: maintenance signal — only surface in source catalog mode (includeSources).
      // In tag-discovery mode it is noise: the agent cannot act on stale source paths.
      const nextStepHint = (() => {
        if (tagSummaryEntry) {
          return 'Pick a tag from tagSummary that fits the user\'s goal, then call list_workflows with tags=["<tagId>"]. ' +
            'If a workflow ID in examples[] already matches, call start_workflow directly — no second list call needed. ' +
            'If multiple tags could apply, pick the most specific one.';
        }
        if (capturedValidationWarnings) {
          return 'One or more workflow files failed validation and were excluded from the workflows list. ' +
            'Fix the errors listed in validationWarnings in the workflow file(s) and retry list_workflows to confirm.';
        }
        return undefined;
      })();

      if (!input.includeSources) {
        // staleRoots is suppressed when tagSummary is present (compact first-call mode):
        // the agent is just discovering tags, not looking for specific workflows, so stale
        // source paths are noise it cannot act on. Emit staleRoots on filtered calls only.
        const includeStaleRoots = !tagSummaryEntry && stalePaths.length > 0;
        const payload: z.infer<typeof V2WorkflowListOutputSchema> = {
          workflows: tagFilteredCompiled,
          ...(tagSummaryEntry ? { tagSummary: tagSummaryEntry } : {}),
          ...(nextStepHint ? { _nextStep: nextStepHint } : {}),
          ...(includeStaleRoots ? { staleRoots: [...stalePaths] } : {}),
          ...(warnings ? { warnings } : {}),
          ...(capturedValidationWarnings ? { validationWarnings: [...capturedValidationWarnings] } : {}),
        };
        return okAsync(success(payload) as ToolResult<unknown>);
      }
      // Reuse workflowReader directly -- it already uses the same factory as the
      // source catalog, so catalog and listing show the same set of sources.
      // NOTE: when !isCompositeWorkflowReader, staleManagedRecords is always [] because
      // the fallback ctx.workflowService path sets it to [] and the factory always
      // produces a composite reader. If this assumption ever breaks, stale managed entries
      // would appear in staleRoots but NOT in sources -- an inconsistency worth knowing about.
      if (!isCompositeWorkflowReader(workflowReader)) {
        const payload: z.infer<typeof V2WorkflowListOutputSchema> = {
          workflows: tagFilteredCompiled,
          ...(tagSummaryEntry ? { tagSummary: tagSummaryEntry } : {}),
          ...(nextStepHint ? { _nextStep: nextStepHint } : {}),
          ...(stalePaths.length > 0 ? { staleRoots: [...stalePaths] } : {}),
          ...(warnings ? { warnings } : {}),
          ...(capturedValidationWarnings ? { validationWarnings: [...capturedValidationWarnings] } : {}),
          sources: [],
        };
        return okAsync(success(payload) as ToolResult<unknown>);
      }
      return ResultAsync.fromPromise(
        withTimeout(buildSourceCatalog(workflowReader, rememberedRootRecords, managedSourceRecords, staleManagedRecords), TIMEOUT_MS, 'list_workflow_sources'),
        (err) => mapUnknownErrorToToolError(err),
      ).map((sources) => {
        const payload: z.infer<typeof V2WorkflowListOutputSchema> = {
          workflows: tagFilteredCompiled,
          ...(tagSummaryEntry ? { tagSummary: tagSummaryEntry } : {}),
          ...(nextStepHint ? { _nextStep: nextStepHint } : {}),
          ...(stalePaths.length > 0 ? { staleRoots: [...stalePaths] } : {}),
          ...(warnings ? { warnings } : {}),
          ...(capturedValidationWarnings ? { validationWarnings: [...capturedValidationWarnings] } : {}),
          sources: [...sources] as z.infer<typeof V2WorkflowListOutputSchema>['sources'],
        };
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
        managedSourceStore: guard.ctx.v2.managedSourceStore,
      })
    : { reader: ctx.workflowService, stalePaths: [] as string[], managedSourceRecords: [] as ManagedSourceRecordV2[], staleManagedRecords: [] as ManagedSourceRecordV2[], managedStoreError: undefined as string | undefined };
  const workflowReader = readerResult.reader;
  const stalePaths = readerResult.stalePaths;
  const inspectWarnings = readerResult.managedStoreError
    ? [`Managed workflow source store was temporarily unavailable (${readerResult.managedStoreError}). Managed sources were not loaded.`]
    : undefined;
  // inspect_workflow returns a single workflow, not a source catalog. staleRoots is surfaced
  // in the response for parity with list_workflows, but staleManagedRecords is intentionally
  // unused here -- there is no catalog output to append stale entries to.

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
            const payload = {
              workflowId: input.workflowId,
              workflowHash,
              mode: input.mode,
              compiled: body as import('../../v2/durable-core/canonical/json-types.js').JsonValue,
              ...(visibility ? { visibility } : {}),
              ...(stalePaths.length > 0 ? { staleRoots: [...stalePaths] } : {}),
              ...(inspectWarnings ? { warnings: inspectWarnings } : {}),
              ...(references != null && references.length > 0 ? { references: [...references] } : {}),
              ...(() => {
                const staleness = shouldShowStaleness(visibility?.category)
                  ? computeWorkflowStaleness(workflow.definition.validatedAgainstSpecVersion, CURRENT_SPEC_VERSION)
                  : undefined;
                return staleness !== undefined ? { staleness } : {};
              })(),
            } as z.infer<typeof V2WorkflowInspectOutputSchema>;
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

export async function buildV2WorkflowListItem(options: {
  /** Full workflow object, pre-fetched by the caller to avoid N+1 reads. */
  readonly workflow: Workflow | null;
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
  const { workflow, summary, workflowReader, rememberedRootRecords, crypto, pinnedStore } = options;

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
  const examples = workflow.definition.examples?.length
    ? { examples: [...workflow.definition.examples] }
    : {};
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
      ...examples,
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
        ...examples,
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
    ...examples,
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
  managedSourceRecords: readonly ManagedSourceRecordV2[],
  staleManagedRecords: readonly ManagedSourceRecordV2[],
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

  const activeEntries = sourceEntryData.map((data) =>
    deriveSourceCatalogEntry({ ...data, rememberedRootRecords, managedSourceRecords, sourceEntryData }),
  );

  // Append catalog entries for managed source directories that are missing on disk.
  // These give agents visibility into attached-but-inaccessible sources without requiring
  // them to cross-reference staleRoots with the managed source list.
  const staleEntries = staleManagedRecords.map((record) => ({
    sourceKey: `custom:${record.path}`,
    category: 'managed',
    source: { kind: 'custom', displayName: path.basename(record.path) },
    sourceMode: 'live_directory',
    effectiveWorkflowCount: 0,
    totalWorkflowCount: 0,
    shadowedWorkflowCount: 0,
    managed: { addedAtMs: record.addedAtMs },
    stale: true,
  }));

  return [...activeEntries, ...staleEntries];
}

function deriveSourceCatalogEntry(options: {
  readonly source: WorkflowSource;
  readonly allIds: readonly string[];
  readonly effectiveIds: readonly string[];
  readonly rememberedRootRecords: readonly RememberedRootRecordV2[];
  readonly managedSourceRecords: readonly ManagedSourceRecordV2[];
  readonly sourceEntryData: readonly SourceEntryData[];
}): Record<string, unknown> {
  const { source, allIds, effectiveIds, rememberedRootRecords, managedSourceRecords, sourceEntryData } = options;
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
      const managedRecord = managedSourceRecords.find(
        (r) => path.resolve(r.path) === path.resolve(source.directoryPath),
      );
      if (managedRecord) {
        // Explicitly attached managed source. Category is 'managed' regardless of whether
        // it is also a rooted-sharing path. When both apply, include rootedSharing context
        // so the relationship is visible without creating a second catalog entry (dual truth).
        return {
          sourceKey,
          category: 'managed',
          source: { kind: source.kind, displayName },
          sourceMode: 'live_directory',
          effectiveWorkflowCount: effective,
          totalWorkflowCount: total,
          shadowedWorkflowCount: shadowed,
          managed: { addedAtMs: managedRecord.addedAtMs },
          ...(rootedSharing ? { rootedSharing } : {}),
        };
      }
      const category = rootedSharing ? 'rooted_sharing' : 'external';
      const sourceMode = rootedSharing ? 'rooted_sharing' : 'live_directory';
      return { sourceKey, category, source: { kind: source.kind, displayName }, sourceMode, effectiveWorkflowCount: effective, totalWorkflowCount: total, shadowedWorkflowCount: shadowed, ...(rootedSharing ? { rootedSharing } : {}) };
    }

    case 'git':
    case 'remote':
    case 'plugin':
      return { sourceKey, category: 'external', source: { kind: source.kind, displayName }, sourceMode: 'live_directory', effectiveWorkflowCount: effective, totalWorkflowCount: total, shadowedWorkflowCount: shadowed };
  }

  // Exhaustiveness guard: adding a new WorkflowSource.kind without updating this switch
  // will cause a compile-time error here. Do not replace with a default case.
  assertNever(source);
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
