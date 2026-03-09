import type { Workflow } from '../../types/workflow.js';
import type { WorkflowSource } from '../../types/workflow.js';
import type { IWorkflowStorage } from '../../types/storage.js';
import type { ValidationOutcome } from '../services/workflow-validation-pipeline.js';
import { validateWorkflowPhase1a, type ValidationPipelineDepsPhase1a, type SchemaError } from '../services/workflow-validation-pipeline.js';
import type { ResolutionReason, VariantResolution, SourceRef } from '../../infrastructure/storage/workflow-resolution.js';
import { resolveWorkflowCandidates, detectDuplicateIds } from '../../infrastructure/storage/workflow-resolution.js';
import type { RawWorkflowFile, VariantKind, ParsedRawWorkflowFile } from './raw-workflow-file-scanner.js';
import { scanRawWorkflowFiles } from './raw-workflow-file-scanner.js';
import { getSourcePath } from '../../types/workflow-source.js';
import { createWorkflow } from '../../types/workflow.js';

// ─────────────────────────────────────────────────────────────────────────────
// Registry Snapshot Type
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistrySnapshot {
  /** All source descriptors in priority order. SourceRef is an index into this. */
  readonly sources: readonly WorkflowSource[];
  /** Every raw .json file discovered on disk, including unparseable ones. */
  readonly rawFiles: readonly RawWorkflowFile[];
  /** Per-source candidate workflows after variant selection (before cross-source dedup). */
  readonly candidates: readonly {
    readonly sourceRef: SourceRef;
    readonly workflows: readonly Workflow[];
    readonly variantResolutions: ReadonlyMap<string, VariantResolution>;
  }[];
  /** Resolved winners after cross-source deduplication — what runtime uses. */
  readonly resolved: readonly {
    readonly workflow: Workflow;
    readonly resolvedBy: ResolutionReason;
  }[];
  /** Workflow IDs that appeared in multiple sources. */
  readonly duplicates: readonly {
    readonly workflowId: string;
    readonly sources: readonly SourceRef[];
  }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 Validation Result
// ─────────────────────────────────────────────────────────────────────────────

export type Tier1Outcome =
  | { readonly kind: 'tier1_unparseable'; readonly parseError: string }
  | { readonly kind: 'schema_failed'; readonly errors: readonly SchemaError[] }
  | { readonly kind: 'structural_failed'; readonly issues: readonly string[] }
  | { readonly kind: 'tier1_passed' };

// ─────────────────────────────────────────────────────────────────────────────
// Validation Report
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedValidationEntry {
  readonly workflowId: string;
  readonly sourceRef: SourceRef;
  readonly resolvedBy: ResolutionReason;
  readonly outcome: ValidationOutcome | { readonly kind: 'phase1a_valid'; readonly workflowId: string };
}

export interface RawFileValidationEntry {
  readonly filePath: string;
  readonly relativeFilePath: string;
  readonly sourceRef: SourceRef | undefined;
  readonly workflowId: string | undefined;
  readonly variantKind: VariantKind | undefined;
  readonly isResolvedWinner: boolean;
  readonly tier1Outcome: Tier1Outcome;
}

export interface DuplicateIdReport {
  readonly workflowId: string;
  readonly sourceRefs: readonly SourceRef[];
  /**
   * True when this is a wr.* workflow from a bundled source being shadowed
   * by non-bundled sources. This is expected behavior (bundled protection),
   * not a hard error — the bundled version wins.
   *
   * false = hard error (ambiguous, no protection applies)
   * true = warning (bundled protection resolved it, not an error)
   */
  readonly isBundledProtection: boolean;
}

export interface RegistryValidationReport {
  readonly totalRawFiles: number;
  readonly totalResolvedWorkflows: number;
  readonly validResolvedCount: number;
  readonly invalidResolvedCount: number;
  readonly tier1PassedRawFiles: number;
  readonly tier1FailedRawFiles: number;
  readonly duplicateIds: readonly DuplicateIdReport[];
  readonly resolvedResults: readonly ResolvedValidationEntry[];
  readonly rawFileResults: readonly RawFileValidationEntry[];
  readonly isValid: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry Validator
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistryValidatorDeps extends ValidationPipelineDepsPhase1a {
  // Inherits schema, structural, compiler, normalizeToExecutable from Phase 1a deps
}

/**
 * Validate all workflows in a registry snapshot.
 *
 * Runs:
 * - Full Phase 1a pipeline on each resolved workflow (what runtime uses)
 * - Tier 1 validation (schema + structural) on all raw files (including variant losers)
 * - Reports duplicates (already in snapshot, surfaced here)
 */
export function validateRegistry(
  snapshot: RegistrySnapshot,
  deps: RegistryValidatorDeps
): RegistryValidationReport {
  // Build set of resolved workflow IDs for isResolvedWinner computation
  const resolvedWinnerIds = new Set<string>();
  for (const { workflow } of snapshot.resolved) {
    resolvedWinnerIds.add(workflow.definition.id);
  }

  // Step 1: Validate all resolved workflows (full Phase 1a pipeline)
  const resolvedResults: ResolvedValidationEntry[] = [];

  for (const { workflow, resolvedBy } of snapshot.resolved) {
    const outcome = validateWorkflowPhase1a(workflow, deps);
    resolvedResults.push({
      workflowId: workflow.definition.id,
      sourceRef: extractSourceRef(resolvedBy),
      resolvedBy,
      outcome,
    });
  }

  const validResolvedCount = resolvedResults.filter(e => e.outcome.kind === 'phase1a_valid').length;

  // Step 2: Validate raw files (Tier 1: schema + structural)
  const rawFileResults: RawFileValidationEntry[] = [];

  for (const rawFile of snapshot.rawFiles) {
    if (rawFile.kind === 'unparseable') {
      rawFileResults.push({
        filePath: rawFile.filePath,
        relativeFilePath: rawFile.relativeFilePath,
        sourceRef: findSourceRefForFile(rawFile.filePath, snapshot.sources),
        workflowId: undefined,
        variantKind: undefined,
        isResolvedWinner: false,
        tier1Outcome: { kind: 'tier1_unparseable', parseError: rawFile.error },
      });
    } else {
      const tier1Outcome = validateRawFileTier1(rawFile, deps);
      const isWinner = resolvedWinnerIds.has(rawFile.definition.id);

      rawFileResults.push({
        filePath: rawFile.filePath,
        relativeFilePath: rawFile.relativeFilePath,
        sourceRef: findSourceRefForFile(rawFile.filePath, snapshot.sources),
        workflowId: rawFile.definition.id,
        variantKind: rawFile.variantKind,
        isResolvedWinner: isWinner,
        tier1Outcome,
      });
    }
  }

  const tier1PassedRawFiles = rawFileResults.filter(e => e.tier1Outcome.kind === 'tier1_passed').length;
  const tier1FailedRawFiles = rawFileResults.length - tier1PassedRawFiles;

  // Step 3: Report duplicates with bundled protection classification
  // A duplicate is "bundled protection" (warning, not error) when the resolved
  // workflow was kept via bundled_protected resolution. All other duplicates
  // are hard errors (ambiguous, no protection applies).
  const resolvedByKindMap = new Map<string, ResolutionReason>();
  for (const { workflow, resolvedBy } of snapshot.resolved) {
    resolvedByKindMap.set(workflow.definition.id, resolvedBy);
  }

  const duplicateIdReports: DuplicateIdReport[] = snapshot.duplicates.map(dup => ({
    workflowId: dup.workflowId,
    sourceRefs: dup.sources,
    isBundledProtection: resolvedByKindMap.get(dup.workflowId)?.kind === 'bundled_protected',
  }));

  // Hard-error duplicates are those without bundled protection
  const hardErrorDuplicates = duplicateIdReports.filter(d => !d.isBundledProtection);

  const isValid =
    validResolvedCount === snapshot.resolved.length &&
    tier1FailedRawFiles === 0 &&
    hardErrorDuplicates.length === 0;

  return {
    totalRawFiles: snapshot.rawFiles.length,
    totalResolvedWorkflows: snapshot.resolved.length,
    validResolvedCount,
    invalidResolvedCount: snapshot.resolved.length - validResolvedCount,
    tier1PassedRawFiles,
    tier1FailedRawFiles,
    duplicateIds: duplicateIdReports,
    resolvedResults,
    rawFileResults,
    isValid,
  };
}

/**
 * Validate a single raw file through Tier 1 (schema + structural).
 */
function validateRawFileTier1(
  rawFile: ParsedRawWorkflowFile,
  deps: RegistryValidatorDeps
): Tier1Outcome {
  // Build a Workflow from the definition for validation
  // (schemaValidate and structuralValidate expect Workflow, not WorkflowDefinition)
  const fakeWorkflow = createWorkflow(rawFile.definition, { kind: 'bundled' } as WorkflowSource);

  const schemaResult = deps.schemaValidate(fakeWorkflow);
  if (schemaResult.isErr()) {
    return { kind: 'schema_failed', errors: schemaResult.error };
  }

  const structuralResult = deps.structuralValidate(fakeWorkflow);
  if (structuralResult.isErr()) {
    return { kind: 'structural_failed', issues: structuralResult.error };
  }

  return { kind: 'tier1_passed' };
}

/**
 * Extract SourceRef from a ResolutionReason.
 */
function extractSourceRef(resolvedBy: ResolutionReason): SourceRef {
  switch (resolvedBy.kind) {
    case 'unique':
      return resolvedBy.sourceRef;
    case 'source_priority':
      return resolvedBy.winnerRef;
    case 'bundled_protected':
      return resolvedBy.bundledSourceRef;
  }
}

/**
 * Find which source a file belongs to by matching its path against source directories.
 */
function findSourceRefForFile(
  filePath: string,
  sources: readonly WorkflowSource[]
): SourceRef | undefined {
  for (let i = 0; i < sources.length; i++) {
    const sourcePath = getSourcePath(sources[i]!);
    if (sourcePath && filePath.startsWith(sourcePath)) {
      return i;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build Registry Snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a registry snapshot atomically from storage instances.
 *
 * This captures everything the validator needs from the same moment in time:
 * - All raw .json files discovered on disk (parsed and unparseable)
 * - Per-source candidates (after variant selection within each source)
 * - Resolved winners (after cross-source deduplication)
 * - Duplicate detection (IDs appearing in multiple sources)
 *
 * @param storageInstances - The actual IWorkflowStorage instances (in priority order).
 *   Each has a `.source` property and a `.loadAllWorkflows()` method.
 */
export async function buildRegistrySnapshot(
  storageInstances: readonly IWorkflowStorage[]
): Promise<RegistrySnapshot> {
  const sources: WorkflowSource[] = storageInstances.map(s => s.source);

  // ── Step 1: Scan raw files from every file-based source ──────────────────
  const allRawFiles: RawWorkflowFile[] = [];

  for (const source of sources) {
    const sourcePath = getSourcePath(source);
    if (!sourcePath) continue; // non-file sources (bundled, remote, plugin)

    try {
      const rawFiles = await scanRawWorkflowFiles(sourcePath);
      allRawFiles.push(...rawFiles);
    } catch (_e) {
      // Source directory inaccessible — continue with other sources.
      // The missing data will surface as "zero raw files for this source"
      // rather than a silent pass.
    }
  }

  // ── Step 2: Load candidates from each storage instance ───────────────────
  const candidates: {
    readonly sourceRef: SourceRef;
    readonly workflows: readonly Workflow[];
    readonly variantResolutions: ReadonlyMap<string, VariantResolution>;
  }[] = [];

  for (let i = 0; i < storageInstances.length; i++) {
    const storage = storageInstances[i]!;

    try {
      const workflows = await storage.loadAllWorkflows();

      // Derive variant resolutions by comparing raw files to loaded candidates.
      // If a workflow ID has multiple raw files (variants) for this source,
      // but only one was loaded, we can infer which variant was selected.
      const variantResolutions = deriveVariantResolutions(
        workflows,
        allRawFiles,
        sources[i]!
      );

      candidates.push({
        sourceRef: i,
        workflows,
        variantResolutions,
      });
    } catch (_e) {
      // Storage instance failed to load — report as zero candidates.
      candidates.push({
        sourceRef: i,
        workflows: [],
        variantResolutions: new Map(),
      });
    }
  }

  // ── Step 3: Resolve cross-source winners ─────────────────────────────────
  // Build the variant map for resolveWorkflowCandidates
  const variantMap = new Map<string, ReadonlyMap<SourceRef, VariantResolution>>();
  for (const { sourceRef, variantResolutions } of candidates) {
    for (const [id, resolution] of variantResolutions.entries()) {
      const existing = variantMap.get(id) ?? new Map<SourceRef, VariantResolution>();
      const updated = new Map(existing);
      updated.set(sourceRef, resolution);
      variantMap.set(id, updated);
    }
  }

  // Wrap each candidate's workflows so resolveWorkflowCandidates can consume them
  const candidatesForResolution = candidates.map(c => ({
    sourceRef: c.sourceRef,
    workflows: c.workflows,
  }));

  const resolved = resolveWorkflowCandidates(candidatesForResolution, variantMap);

  // ── Step 4: Detect duplicates (from candidates, BEFORE dedup) ────────────
  const duplicates = detectDuplicateIds(candidatesForResolution);

  // ── Step 5: Freeze and return ────────────────────────────────────────────
  return Object.freeze({
    sources: Object.freeze(sources),
    rawFiles: Object.freeze(allRawFiles),
    candidates: Object.freeze(candidates),
    resolved: Object.freeze(resolved),
    duplicates: Object.freeze(duplicates),
  });
}

/**
 * Derive VariantResolution for each workflow loaded from a source.
 *
 * Compares the set of raw files belonging to this source against the
 * set of workflows that the storage actually loaded (after variant selection).
 *
 * For each loaded workflow ID:
 * - If only one raw variant file existed → { kind: 'only_variant' }
 * - If multiple variants existed → infer which was selected and why
 */
function deriveVariantResolutions(
  loadedWorkflows: readonly Workflow[],
  allRawFiles: readonly RawWorkflowFile[],
  source: WorkflowSource
): ReadonlyMap<string, VariantResolution> {
  const result = new Map<string, VariantResolution>();
  const sourcePath = getSourcePath(source);
  if (!sourcePath) return result;

  // Group raw files belonging to this source by workflow ID
  const rawFilesByWorkflowId = new Map<string, ParsedRawWorkflowFile[]>();
  for (const rawFile of allRawFiles) {
    if (rawFile.kind !== 'parsed') continue;
    if (!rawFile.filePath.startsWith(sourcePath)) continue;

    const id = rawFile.definition.id;
    const existing = rawFilesByWorkflowId.get(id) ?? [];
    rawFilesByWorkflowId.set(id, [...existing, rawFile]);
  }

  // For each loaded workflow, determine how its variant was selected
  for (const workflow of loadedWorkflows) {
    const id = workflow.definition.id;
    const rawFilesForId = rawFilesByWorkflowId.get(id) ?? [];

    if (rawFilesForId.length <= 1) {
      result.set(id, { kind: 'only_variant' });
    } else {
      // Multiple variant files existed — determine which was selected
      const availableVariants = rawFilesForId.map(f => f.variantKind);
      // The loaded workflow is the selected one; infer its variant kind
      // by finding which raw file has the matching definition
      const selectedRaw = rawFilesForId.find(
        f => f.definition.id === id
      );
      const selectedVariant: VariantKind = selectedRaw?.variantKind ?? 'standard';

      // Determine selection reason: was it feature-flag or precedence?
      // We can't know the exact flags here, but we can infer:
      // - If the selected variant is v2 or agentic, a flag likely drove the decision
      // - If it's standard, it's either the only option or a precedence fallback
      if (selectedVariant === 'v2' || selectedVariant === 'agentic') {
        result.set(id, {
          kind: 'feature_flag_selected',
          selectedVariant,
          availableVariants: availableVariants as VariantKind[],
          enabledFlags: {
            v2Tools: selectedVariant === 'v2',
            agenticRoutines: selectedVariant === 'agentic',
          },
        });
      } else {
        result.set(id, {
          kind: 'precedence_fallback',
          selectedVariant,
          availableVariants: availableVariants as VariantKind[],
        });
      }
    }
  }

  return result;
}
