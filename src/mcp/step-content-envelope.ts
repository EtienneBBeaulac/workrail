/**
 * Typed intermediate representation for step content categories.
 *
 * The StepContentEnvelope makes explicit what content the agent sees,
 * with clear provenance for each category. It travels through the
 * V2ExecutionRenderEnvelope as a parallel channel alongside the
 * Zod-validated response object.
 *
 * The formatter consumes it when present, with graceful fallback
 * to current behavior when absent (incremental adoption).
 *
 * @module mcp/step-content-envelope
 */

import type { StepMetadata } from '../v2/durable-core/domain/prompt-renderer.js';
import type { FormattedSupplement } from './response-supplements.js';

/**
 * Shared fields for all resolved reference variants.
 *
 * References are workflow-declared (compile-time) or project-attached (future).
 * Content is never inlined — the agent reads the file itself if needed.
 */
interface ResolvedReferenceBase {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly purpose: string;
  readonly authoritative: boolean;
  /** Resolution context: workspace-relative or package-relative. */
  readonly resolveFrom: 'workspace' | 'package';
}

/**
 * A resolved workflow reference — discriminated union over resolution status.
 *
 * - `resolved`: I/O confirmed the path exists; `resolvedPath` is the absolute path.
 * - `unresolved`: I/O confirmed the path does NOT exist at start time.
 * - `pinned`: replayed from a pinned session — no I/O was performed, only the
 *   declaration is available. Used on rehydrate to avoid lying about resolution state.
 */
export type ResolvedReference =
  | (ResolvedReferenceBase & { readonly status: 'resolved'; readonly resolvedPath: string })
  | (ResolvedReferenceBase & { readonly status: 'unresolved' })
  | (ResolvedReferenceBase & { readonly status: 'pinned' });

/**
 * Typed content categories for a pending step.
 *
 * Each field has clear provenance:
 * - authoredPrompt: from the workflow author (the prompt string)
 * - supplements: from the engine (system-level guidance)
 * - references: from the workflow definition (external document pointers)
 *
 * The envelope is read-only and constructed once per response.
 */
export interface StepContentEnvelope {
  readonly stepId: string;
  readonly title: string;
  readonly authoredPrompt: string;
  readonly agentRole?: string;
  readonly references: readonly ResolvedReference[];
  readonly supplements: readonly FormattedSupplement[];
}

/**
 * Build a StepContentEnvelope from existing renderer output.
 *
 * This is a pure function — no I/O. References and supplements are
 * provided by the caller (handler assembles from multiple sources).
 */
export function buildStepContentEnvelope(args: {
  readonly meta: StepMetadata;
  readonly references?: readonly ResolvedReference[];
  readonly supplements?: readonly FormattedSupplement[];
}): StepContentEnvelope {
  return Object.freeze({
    stepId: args.meta.stepId,
    title: args.meta.title,
    authoredPrompt: args.meta.prompt,
    agentRole: args.meta.agentRole,
    references: Object.freeze(args.references ?? []),
    supplements: Object.freeze(args.supplements ?? []),
  });
}
