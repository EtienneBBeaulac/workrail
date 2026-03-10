import type { Workflow } from '../../types/workflow.js';

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reference to a source by its index in the registry snapshot source list.
 *
 * Philosophy: "Immutability by default" + avoid duplication.
 * Instead of copying WorkflowSource objects 10+ times, reference by index.
 */
export type SourceRef = number; // index into RegistrySnapshot.sources[]

/**
 * Explains how a variant file was selected when multiple variants existed.
 * Only present when the source had multiple variant files for this workflow ID.
 *
 * Philosophy: "Exhaustiveness everywhere" — three explicit selection paths.
 */
export type VariantResolution =
  | { readonly kind: 'only_variant' }
  | {
      readonly kind: 'feature_flag_selected';
      readonly selectedVariant: 'v2' | 'agentic' | 'standard';
      readonly availableVariants: readonly ('v2' | 'agentic' | 'standard')[];
      readonly enabledFlags: { readonly v2Tools: boolean; readonly agenticRoutines: boolean };
    }
  | {
      readonly kind: 'precedence_fallback';
      /**
       * Multiple variants existed, but no feature flags enabled.
       * Precedence rule: .v2. > .agentic. > standard (independent of flags).
       * This is a fallback — the files exist but aren't being used as intended.
       */
      readonly selectedVariant: 'v2' | 'agentic' | 'standard';
      readonly availableVariants: readonly ('v2' | 'agentic' | 'standard')[];
    };

/**
 * Explains why a specific workflow won resolution across sources and variants.
 *
 * Philosophy: "Make illegal states unrepresentable" + "Single source of truth"
 * - Each variant is exhaustive and carries exactly the needed context
 * - Variant resolution is included when applicable (not tracked separately)
 * - Source references prevent duplication
 * - Produced by a two-pass pure function, not incremental mutation
 */
export type ResolutionReason =
  | {
      readonly kind: 'unique';
      /**
       * Exactly one source provided this workflow ID.
       * No competition, no shadowing, no ambiguity.
       */
      readonly sourceRef: SourceRef;
      readonly variantResolution?: VariantResolution;
    }
  | {
      readonly kind: 'source_priority';
      /**
       * Multiple sources provided this workflow ID.
       * Winner selected by source priority (later sources override earlier).
       */
      readonly winnerRef: SourceRef;
      readonly shadowedRefs: readonly SourceRef[];
      readonly variantResolution?: VariantResolution; // for the winner source
    }
  | {
      readonly kind: 'bundled_protected';
      /**
       * `wr.*` workflow from bundled source.
       * Non-bundled sources attempted to shadow it but were blocked.
       */
      readonly bundledSourceRef: SourceRef;
      readonly attemptedShadowRefs: readonly SourceRef[];
      readonly variantResolution?: VariantResolution; // for bundled source
    };

interface ResolvedWorkflow {
  readonly workflow: Workflow;
  readonly resolvedBy: ResolutionReason;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Resolution Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve cross-source workflow competition using priority rules.
 *
 * Philosophy: "Functional/declarative" — two-pass pure function.
 * Pass 1: Group workflows by ID (collect all sources)
 * Pass 2: Apply resolution rules with complete information
 *
 * This eliminates incremental mutation bugs (e.g., setting 'unique' on first
 * encounter, then upgrading it when a second source appears).
 *
 * This is the SAME function that EnhancedMultiSourceWorkflowStorage uses internally.
 * Shared to eliminate drift between validation and runtime resolution.
 */
export function resolveWorkflowCandidates(
  candidates: readonly { readonly sourceRef: SourceRef; readonly workflows: readonly Workflow[] }[],
  variantResolutions: ReadonlyMap<string, ReadonlyMap<SourceRef, VariantResolution>>
): readonly ResolvedWorkflow[] {
  // Pass 1: Group all workflows by ID
  const grouped = new Map<string, { sourceRef: SourceRef; workflow: Workflow }[]>();
  for (const { sourceRef, workflows } of candidates) {
    for (const workflow of workflows) {
      const id = workflow.definition.id;
      const existing = grouped.get(id) ?? [];
      grouped.set(id, [...existing, { sourceRef, workflow }]);
    }
  }

  // Pass 2: Apply resolution rules per ID with complete information
  const resolved: ResolvedWorkflow[] = [];

  for (const [id, sources] of grouped.entries()) {
    if (sources.length === 1) {
      // Unique — only one source
      const { sourceRef, workflow } = sources[0]!;
      const variantResolution = variantResolutions.get(id)?.get(sourceRef);
      resolved.push({
        workflow,
        resolvedBy: {
          kind: 'unique',
          sourceRef,
          variantResolution,
        },
      });
    } else {
      // Multiple sources — apply priority rules
      // Check for bundled protection
      const bundledSource = sources.find(s => isBundledWorkflow(s.workflow));

      if (bundledSource && sources.some(s => s !== bundledSource && !isBundledWorkflow(s.workflow))) {
        // Bundled source with non-bundled shadowers
        const { sourceRef: bundledRef, workflow } = bundledSource;
        const attemptedShadowRefs = sources
          .filter(s => s !== bundledSource && !isBundledWorkflow(s.workflow))
          .map(s => s.sourceRef);

        const variantResolution = variantResolutions.get(id)?.get(bundledRef);
        resolved.push({
          workflow,
          resolvedBy: {
            kind: 'bundled_protected',
            bundledSourceRef: bundledRef,
            attemptedShadowRefs,
            variantResolution,
          },
        });
      } else {
        // Source priority: later sources override earlier
        const winner = sources[sources.length - 1]!;
        const { sourceRef: winnerRef, workflow } = winner;
        const shadowedRefs = sources.slice(0, -1).map(s => s.sourceRef);

        const variantResolution = variantResolutions.get(id)?.get(winnerRef);
        resolved.push({
          workflow,
          resolvedBy: {
            kind: 'source_priority',
            winnerRef,
            shadowedRefs,
            variantResolution,
          },
        });
      }
    }
  }

  return resolved;
}

/**
 * Check if a workflow qualifies for bundled protection.
 *
 * Both conditions must be true:
 * - ID starts with 'wr.' (the namespace convention)
 * - Source kind is 'bundled' (actually from the bundled storage)
 *
 * A wr.* ID from a non-bundled source does NOT get protection —
 * it's a user-created workflow that happens to use the wr. prefix.
 */
function isBundledWorkflow(workflow: Workflow): boolean {
  return workflow.definition.id.startsWith('wr.') && workflow.source.kind === 'bundled';
}

// ─────────────────────────────────────────────────────────────────────────────
// Variant Selection (Intra-Source)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Variant candidate for a single workflow within one source.
 */
export interface VariantCandidate {
  readonly variantKind: 'v2' | 'agentic' | 'standard';
  readonly identifier: string; // filename or other identifier for traceability
}

/**
 * Feature flags relevant to variant selection.
 */
export interface VariantSelectionFlags {
  readonly v2Tools: boolean;
  readonly agenticRoutines: boolean;
}

/**
 * Result of variant selection for a single workflow ID within one source.
 */
export interface VariantSelectionResult {
  readonly selectedVariant: 'v2' | 'agentic' | 'standard';
  readonly selectedIdentifier: string;
  readonly resolution: VariantResolution;
}

/**
 * Select the appropriate variant file for a workflow when multiple variants exist.
 *
 * Pure function — same logic as FileWorkflowStorage.buildWorkflowIndex (lines 184-202).
 * Shared so that both runtime and validation use the same selection rules.
 *
 * Precedence:
 * 1. .v2. variant when v2 tools are enabled
 * 2. .agentic. variant when agentic routines are enabled
 * 3. standard variant otherwise
 *
 * If no matching variant is found for the enabled flags, falls back to the
 * first available variant (same behavior as FileWorkflowStorage).
 */
export function selectVariant(
  candidates: readonly VariantCandidate[],
  flags: VariantSelectionFlags
): VariantSelectionResult {
  if (candidates.length === 0) {
    throw new Error('selectVariant called with empty candidates');
  }

  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      selectedVariant: only.variantKind,
      selectedIdentifier: only.identifier,
      resolution: { kind: 'only_variant' },
    };
  }

  // Multiple variants — apply precedence rules
  const availableVariants = candidates.map(c => c.variantKind);

  const v2Candidate = candidates.find(c => c.variantKind === 'v2');
  const agenticCandidate = candidates.find(c => c.variantKind === 'agentic');
  const standardCandidate = candidates.find(c => c.variantKind === 'standard');

  // Feature-flag-driven selection
  if (flags.v2Tools && v2Candidate) {
    return {
      selectedVariant: 'v2',
      selectedIdentifier: v2Candidate.identifier,
      resolution: {
        kind: 'feature_flag_selected',
        selectedVariant: 'v2',
        availableVariants,
        enabledFlags: flags,
      },
    };
  }

  if (flags.agenticRoutines && agenticCandidate) {
    return {
      selectedVariant: 'agentic',
      selectedIdentifier: agenticCandidate.identifier,
      resolution: {
        kind: 'feature_flag_selected',
        selectedVariant: 'agentic',
        availableVariants,
        enabledFlags: flags,
      },
    };
  }

  // No flags matched — standard gets priority, otherwise precedence fallback
  if (standardCandidate) {
    return {
      selectedVariant: 'standard',
      selectedIdentifier: standardCandidate.identifier,
      resolution: {
        kind: 'precedence_fallback',
        selectedVariant: 'standard',
        availableVariants,
      },
    };
  }

  // No standard variant; fall back to first available (v2 > agentic by precedence)
  const fallback = v2Candidate ?? agenticCandidate ?? candidates[0]!;
  return {
    selectedVariant: fallback.variantKind,
    selectedIdentifier: fallback.identifier,
    resolution: {
      kind: 'precedence_fallback',
      selectedVariant: fallback.variantKind,
      availableVariants,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find and return all duplicate workflow IDs (IDs appearing in multiple sources).
 */
export function detectDuplicateIds(
  candidates: readonly { readonly sourceRef: SourceRef; readonly workflows: readonly Workflow[] }[]
): readonly { workflowId: string; sources: readonly SourceRef[] }[] {
  const grouped = new Map<string, SourceRef[]>();

  for (const { sourceRef, workflows } of candidates) {
    for (const workflow of workflows) {
      const id = workflow.definition.id;
      const existing = grouped.get(id) ?? [];
      grouped.set(id, [...existing, sourceRef]);
    }
  }

  const duplicates: { workflowId: string; sources: readonly SourceRef[] }[] = [];
  for (const [id, sources] of grouped.entries()) {
    if (sources.length > 1) {
      duplicates.push({
        workflowId: id,
        sources: [...new Set(sources)], // deduplicate (in case source appears twice)
      });
    }
  }

  return duplicates;
}
