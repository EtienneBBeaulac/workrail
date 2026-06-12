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

import type { ResolvedReference } from '../v2/usecases/reference-types.js';
export type { ResolvedReference };

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
  readonly modelTier?: 'lightweight' | 'mid' | 'heavy';
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
    modelTier: args.meta.modelTier,
    references: Object.freeze(args.references ?? []),
    supplements: Object.freeze(args.supplements ?? []),
  });
}
