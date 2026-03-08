import type { Workflow } from '../../types/workflow.js';
import type { WorkflowSource } from '../../types/workflow.js';
import type { ValidationOutcome } from '../services/workflow-validation-pipeline.js';
import { validateWorkflowPhase1a, type ValidationPipelineDepsPhase1a, type SchemaError } from '../services/workflow-validation-pipeline.js';
import type { ResolutionReason, VariantResolution, SourceRef } from '../../infrastructure/storage/workflow-resolution.js';
import { resolveWorkflowCandidates, detectDuplicateIds } from '../../infrastructure/storage/workflow-resolution.js';
import type { RawWorkflowFile, VariantKind } from './raw-workflow-file-scanner.js';
import { scanRawWorkflowFiles, findWorkflowJsonFiles } from './raw-workflow-file-scanner.js';

// ─────────────────────────────────────────────────────────────────────────────
// Registry Snapshot Type
// ─────────────────────────────────────────────────────────────────────────────

export interface RegistrySnapshot {
  readonly sources: readonly WorkflowSource[];
  readonly rawFiles: readonly RawWorkflowFile[];
  readonly candidates: readonly {
    readonly sourceRef: SourceRef;
    readonly workflows: readonly Workflow[];
    readonly variantResolutions: ReadonlyMap<string, VariantResolution>;
  }[];
  readonly resolved: readonly {
    readonly workflow: Workflow;
    readonly resolvedBy: ResolutionReason;
  }[];
  readonly duplicates: readonly {
    workflowId: string;
    sources: readonly SourceRef[];
  }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 Validation Result
// ─────────────────────────────────────────────────────────────────────────────

type Tier1Outcome =
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
  readonly sourceRef?: SourceRef; // undefined if file is unparseable
  readonly workflowId?: string; // undefined if unparseable
  readonly variantKind?: VariantKind; // undefined if unparseable
  readonly isResolvedWinner: boolean;
  readonly tier1Outcome: Tier1Outcome;
}

export interface DuplicateIdReport {
  readonly workflowId: string;
  readonly sourceRefs: readonly SourceRef[];
}

export interface RegistryValidationReport {
  readonly totalRawFiles: number;
  readonly totalResolvedWorkflows: number;
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
 * Returns a comprehensive report covering:
 * - Resolved workflows: full Phase 1a pipeline validation (what runtime uses)
 * - Raw files: Tier 1 validation (schema + structural) for variant losers
 * - Duplicates: IDs appearing in multiple sources
 */
export async function validateRegistry(
  snapshot: RegistrySnapshot,
  deps: RegistryValidatorDeps
): Promise<RegistryValidationReport> {
  // Step 1: Validate all resolved workflows (full Phase 1a pipeline)
  const resolvedResults: ResolvedValidationEntry[] = [];
  let resolvedValid = true;

  for (const { workflow, resolvedBy } of snapshot.resolved) {
    const outcome = validateWorkflowPhase1a(workflow, deps);
    resolvedResults.push({
      workflowId: workflow.definition.id,
      sourceRef: extractSourceRef(resolvedBy),
      resolvedBy,
      outcome,
    });

    if (outcome.kind !== 'phase1a_valid') {
      resolvedValid = false;
    }
  }

  // Step 2: Validate raw files (Tier 1: schema + structural)
  const rawFileResults: RawFileValidationEntry[] = [];
  let rawFilesValid = true;

  // Build a map of workflowId + variantKind -> resolved winner for checking isResolvedWinner
  const resolvedWinners = new Set<string>();
  for (const { workflow, resolvedBy } of snapshot.resolved) {
    const id = workflow.definition.id;
    const sourceRef = extractSourceRef(resolvedBy);
    const source = snapshot.sources[sourceRef];
    resolvedWinners.add(`${id}|${source}`); // Mark as winner
  }

  for (const rawFile of snapshot.rawFiles) {
    if (rawFile.kind === 'unparseable') {
      // Unparseable files are Tier 1 failures
      rawFileResults.push({
        filePath: rawFile.filePath,
        relativeFilePath: rawFile.relativeFilePath,
        isResolvedWinner: false,
        tier1Outcome: {
          kind: 'schema_failed',
          errors: [{ instancePath: '', message: rawFile.error }],
        },
      });
      rawFilesValid = false;
    } else {
      // Parsed files: run Tier 1 validation (schema + structural)
      const schemaResult = deps.schemaValidate(rawFile.definition as any);
      let tier1Outcome: Tier1Outcome;

      if (schemaResult.isErr()) {
        tier1Outcome = { kind: 'schema_failed', errors: schemaResult.error };
        rawFilesValid = false;
      } else {
        const structuralResult = deps.structuralValidate(rawFile.definition as any);
        if (structuralResult.isErr()) {
          tier1Outcome = { kind: 'structural_failed', issues: structuralResult.error };
          rawFilesValid = false;
        } else {
          tier1Outcome = { kind: 'tier1_passed' };
        }
      }

      rawFileResults.push({
        filePath: rawFile.filePath,
        relativeFilePath: rawFile.relativeFilePath,
        sourceRef: undefined, // TODO: map raw file back to source
        workflowId: rawFile.definition.id,
        variantKind: rawFile.variantKind,
        isResolvedWinner: false, // TODO: compute based on resolved list
        tier1Outcome,
      });
    }
  }

  // Step 3: Report duplicates
  const duplicateIdReports: DuplicateIdReport[] = snapshot.duplicates.map(dup => ({
    workflowId: dup.workflowId,
    sourceRefs: dup.sources,
  }));
  const hasDuplicates = duplicateIdReports.length > 0;

  return {
    totalRawFiles: snapshot.rawFiles.length,
    totalResolvedWorkflows: snapshot.resolved.length,
    duplicateIds: duplicateIdReports,
    resolvedResults,
    rawFileResults,
    isValid: resolvedValid && rawFilesValid && !hasDuplicates,
  };
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

// ─────────────────────────────────────────────────────────────────────────────
// Build Registry Snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a registry snapshot atomically from raw files and storage instances.
 *
 * This is the core function that captures everything the validator needs:
 * - All raw files discovered on disk (parsed and unparseable)
 * - Per-source candidates (after variant selection within each source)
 * - Resolved winners (after cross-source deduplication)
 * - Duplicate detection (IDs appearing in multiple sources)
 *
 * All captured from the same moment in time — no two-step drift.
 */
export async function buildRegistrySnapshot(
  sources: readonly WorkflowSource[],
  variant: string,
  featureFlags: { readonly v2Tools: boolean; readonly agenticRoutines: boolean }
): Promise<RegistrySnapshot> {
  // Step 1: Scan all raw files from all sources
  const allRawFiles: RawWorkflowFile[] = [];

  for (const source of sources) {
    if (source.kind === 'bundled') {
      // Bundled workflows are provided inline, not discovered
      continue;
    }

    // TODO: Get base directory from source
    // For now, this is a placeholder that would be wired through storage layer
    const baseDir = (source as any).baseDir || (source as any).path;
    if (!baseDir) continue;

    try {
      const rawFiles = await scanRawWorkflowFiles(baseDir);
      allRawFiles.push(...rawFiles);
    } catch (_e) {
      // Source scan failed - continue with other sources
    }
  }

  // Step 2: Load candidates from each source (independently)
  // NOTE: This requires wiring to actual storage instances
  // For now, placeholder implementation
  const candidates: {
    sourceRef: SourceRef;
    workflows: Workflow[];
    variantResolutions: ReadonlyMap<string, VariantResolution>;
  }[] = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!;
    // TODO: Call storage.loadAllWorkflows() for this source
    // For now, empty placeholder
    candidates.push({
      sourceRef: i,
      workflows: [],
      variantResolutions: new Map(),
    });
  }

  // Step 3: Resolve cross-source winners
  const allCandidates = candidates.flatMap(c =>
    c.workflows.map(w => ({
      sourceRef: c.sourceRef,
      workflows: [w] as readonly Workflow[],
    }))
  );

  const variantMap = new Map<string, ReadonlyMap<SourceRef, VariantResolution>>();
  for (const { sourceRef, variantResolutions } of candidates) {
    for (const [id, resolution] of variantResolutions.entries()) {
      const existing = variantMap.get(id) || new Map();
      const updated = new Map(existing);
      updated.set(sourceRef, resolution);
      variantMap.set(id, updated);
    }
  }

  const resolved = resolveWorkflowCandidates(allCandidates, variantMap).map(({ workflow, resolvedBy }) => ({
    workflow,
    resolvedBy,
  }));

  // Step 4: Detect duplicates
  const duplicates = detectDuplicateIds(allCandidates).map(dup => ({
    workflowId: dup.workflowId,
    sources: dup.sources,
  }));

  return Object.freeze({
    sources,
    rawFiles: Object.freeze(allRawFiles),
    candidates: Object.freeze(candidates),
    resolved: Object.freeze(resolved),
    duplicates: Object.freeze(duplicates),
  });
}
