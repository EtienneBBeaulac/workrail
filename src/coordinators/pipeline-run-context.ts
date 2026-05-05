import { z } from 'zod';
import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import {
  DiscoveryHandoffArtifactV1Schema,
  type DiscoveryHandoffArtifactV1,
  ShapingHandoffArtifactV1Schema,
  type ShapingHandoffArtifactV1,
  CodingHandoffArtifactV1Schema,
  type CodingHandoffArtifactV1,
  ReviewVerdictArtifactV1Schema,
  type ReviewVerdictArtifactV1,
} from '../v2/durable-core/schemas/artifacts/index.js';

/**
 * PipelineRunContext -- durable per-run context store for WorkTrain coordinator pipelines.
 *
 * Written to {workspace}/.workrail/pipeline-runs/{runId}-context.json after each phase
 * completes. Read at coordinator start to restore priorArtifacts after a crash, enabling
 * resume without re-running completed phases.
 *
 * WHY PhaseResult<T> discriminated union (not artifact|null + quality string):
 * Separate fields can be mutually inconsistent -- e.g. artifact=valid but quality='fallback'.
 * The discriminated union makes illegal states unrepresentable at compile time. Every
 * coordinator switch on PhaseResult is exhaustive by type.
 *
 * WHY concrete per-phase Zod schemas (not generic):
 * Zod generics are complex and error-prone. Concrete schemas per phase are simple,
 * independently testable, and the type information is preserved through JSON round-trips.
 *
 * WHY deliberate linear-pipeline scope:
 * The `phases` object is a flat linear structure by design. Epic-mode extends this by
 * replacing `phases` with a keyed `tasks` map. Do not add inline logic that assumes
 * exactly one of each phase type.
 */

// ═══════════════════════════════════════════════════════════════════════════
// PHASE RESULT -- DISCRIMINATED UNION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PhaseResult<T>: the outcome of a single pipeline phase.
 *
 * - full: agent emitted a valid structured artifact + optional notes
 * - partial: no artifact but meaningful notes (>50 chars) -- coordinator uses notes as fallback
 * - fallback: no artifact and no usable notes -- coordinator has minimal context
 *
 * WHY confidenceBand is optional on 'full':
 * Not all artifact types carry a confidenceBand field (shaping and coding handoffs
 * don't; discovery and review verdict do). Making it optional here means the type
 * accurately reflects reality rather than hiding a runtime cast.
 */
export type PhaseResult<TArtifact> =
  | {
      readonly kind: 'full';
      readonly artifact: TArtifact;
      readonly confidenceBand: 'high' | 'medium' | 'low' | null;
      readonly recapMarkdown: string | null;
    }
  | {
      readonly kind: 'partial';
      readonly recapMarkdown: string;
    }
  | {
      readonly kind: 'fallback';
      readonly recapMarkdown: string | null;
    };

/**
 * Minimum notes length for 'partial' kind.
 * Matches MIN_NOTES_LENGTH_FOR_FALLBACK in full-pipeline.ts.
 */
export const MIN_NOTES_LENGTH_FOR_PHASE_RESULT = 50;

/**
 * Build a PhaseResult<T> from the raw outputs of getAgentResult().
 *
 * Pure function -- no I/O. Called by the coordinator after each phase completes
 * before writing to PipelineRunContext.
 *
 * WHY pure function (not inline logic): testable in isolation, deterministic,
 * and reusable across all coordinator mode files.
 */
export function buildPhaseResult<TArtifact>(
  artifact: TArtifact | null,
  recapMarkdown: string | null,
): PhaseResult<TArtifact> {
  if (artifact !== null) {
    // Extract confidenceBand if the artifact carries it; null otherwise.
    // WHY not cast-and-default: the type accurately reflects that some artifact
    // types don't carry a confidence band -- null is the honest representation.
    const maybeConf = (artifact as { confidenceBand?: unknown }).confidenceBand;
    const confidenceBand: 'high' | 'medium' | 'low' | null =
      maybeConf === 'high' || maybeConf === 'medium' || maybeConf === 'low'
        ? maybeConf
        : null;
    return { kind: 'full', artifact, confidenceBand, recapMarkdown };
  }
  if (recapMarkdown !== null && recapMarkdown.trim().length > MIN_NOTES_LENGTH_FOR_PHASE_RESULT) {
    return { kind: 'partial', recapMarkdown: recapMarkdown.trim() };
  }
  return { kind: 'fallback', recapMarkdown };
}

// ═══════════════════════════════════════════════════════════════════════════
// PER-PHASE RECORD TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface DiscoveryPhaseRecord {
  readonly completedAt: string;
  readonly sessionHandle: string;
  readonly result: PhaseResult<DiscoveryHandoffArtifactV1>;
}

export interface ShapingPhaseRecord {
  readonly completedAt: string;
  readonly sessionHandle: string;
  readonly result: PhaseResult<ShapingHandoffArtifactV1>;
}

export interface CodingPhaseRecord {
  readonly completedAt: string;
  readonly sessionHandle: string;
  readonly result: PhaseResult<CodingHandoffArtifactV1>;
}

export interface ReviewPhaseRecord {
  readonly completedAt: string;
  readonly sessionHandle: string;
  readonly result: PhaseResult<ReviewVerdictArtifactV1>;
}

/** Discriminated union of all phase record types for writePhaseRecord(). */
export type PhaseRecord =
  | { readonly phase: 'discovery'; readonly record: DiscoveryPhaseRecord }
  | { readonly phase: 'shaping'; readonly record: ShapingPhaseRecord }
  | { readonly phase: 'coding'; readonly record: CodingPhaseRecord }
  | { readonly phase: 'review'; readonly record: ReviewPhaseRecord };

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE RUN CONTEXT
// ═══════════════════════════════════════════════════════════════════════════

export interface PipelineRunContext {
  readonly runId: string;
  readonly goal: string;
  readonly workspace: string;
  readonly startedAt: string;
  readonly pipelineMode: 'FULL' | 'IMPLEMENT' | 'REVIEW_ONLY' | 'QUICK_REVIEW';
  /**
   * Run status. 'in_progress' while running, 'completed' after successful finish.
   * WHY: active-run.json pointer must not be reused by the next fresh run.
   * readActiveRunId checks this field and ignores completed runs.
   */
  readonly status?: 'in_progress' | 'completed';
  /**
   * DELIBERATE SCOPE CONSTRAINT: flat linear-pipeline object.
   * Epic-mode extends this by replacing phases with tasks: { [taskId]: TaskRecord }.
   * Do not add inline logic that assumes exactly one of each phase type.
   */
  readonly phases: {
    readonly discovery?: DiscoveryPhaseRecord;
    readonly shaping?: ShapingPhaseRecord;
    readonly coding?: CodingPhaseRecord;
    readonly review?: ReviewPhaseRecord;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CONCRETE ZOD SCHEMAS FOR JSON SERIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

// WHY concrete schemas per phase (not a generic Zod schema):
// Zod generics are complex. Each concrete schema is independently testable.
// All deserialization paths MUST go through these schemas -- no raw casts.

const PhaseResultFullDiscoverySchema = z.object({
  kind: z.literal('full'),
  artifact: DiscoveryHandoffArtifactV1Schema,
  confidenceBand: z.enum(['high', 'medium', 'low']).nullable(),
  recapMarkdown: z.string().nullable(),
});

const PhaseResultFullShapingSchema = z.object({
  kind: z.literal('full'),
  artifact: ShapingHandoffArtifactV1Schema,
  confidenceBand: z.enum(['high', 'medium', 'low']).nullable(),
  recapMarkdown: z.string().nullable(),
});

const PhaseResultFullCodingSchema = z.object({
  kind: z.literal('full'),
  artifact: CodingHandoffArtifactV1Schema,
  confidenceBand: z.enum(['high', 'medium', 'low']).nullable(),
  recapMarkdown: z.string().nullable(),
});

const PhaseResultFullReviewSchema = z.object({
  kind: z.literal('full'),
  artifact: ReviewVerdictArtifactV1Schema,
  confidenceBand: z.enum(['high', 'medium', 'low']).nullable(),
  recapMarkdown: z.string().nullable(),
});

const PhaseResultPartialSchema = z.object({
  kind: z.literal('partial'),
  recapMarkdown: z.string(),
});

const PhaseResultFallbackSchema = z.object({
  kind: z.literal('fallback'),
  recapMarkdown: z.string().nullable(),
});

export const DiscoveryPhaseRecordSchema = z.object({
  completedAt: z.string(),
  sessionHandle: z.string().min(1),
  result: z.discriminatedUnion('kind', [
    PhaseResultFullDiscoverySchema,
    PhaseResultPartialSchema,
    PhaseResultFallbackSchema,
  ]),
});

export const ShapingPhaseRecordSchema = z.object({
  completedAt: z.string(),
  sessionHandle: z.string().min(1),
  result: z.discriminatedUnion('kind', [
    PhaseResultFullShapingSchema,
    PhaseResultPartialSchema,
    PhaseResultFallbackSchema,
  ]),
});

export const CodingPhaseRecordSchema = z.object({
  completedAt: z.string(),
  sessionHandle: z.string().min(1),
  result: z.discriminatedUnion('kind', [
    PhaseResultFullCodingSchema,
    PhaseResultPartialSchema,
    PhaseResultFallbackSchema,
  ]),
});

export const ReviewPhaseRecordSchema = z.object({
  completedAt: z.string(),
  sessionHandle: z.string().min(1),
  result: z.discriminatedUnion('kind', [
    PhaseResultFullReviewSchema,
    PhaseResultPartialSchema,
    PhaseResultFallbackSchema,
  ]),
});

export const PipelineRunContextSchema = z.object({
  runId: z.string().min(1),
  goal: z.string().min(1),
  workspace: z.string().min(1),
  startedAt: z.string(),
  pipelineMode: z.enum(['FULL', 'IMPLEMENT', 'REVIEW_ONLY', 'QUICK_REVIEW']),
  status: z.enum(['in_progress', 'completed']).optional(),
  phases: z.object({
    discovery: DiscoveryPhaseRecordSchema.optional(),
    shaping: ShapingPhaseRecordSchema.optional(),
    coding: CodingPhaseRecordSchema.optional(),
    review: ReviewPhaseRecordSchema.optional(),
  }),
});

// ═══════════════════════════════════════════════════════════════════════════
// PARSE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a raw JSON value as a PipelineRunContext.
 * All deserialization paths MUST use this function -- no raw casts.
 */
export function parsePipelineRunContext(
  raw: unknown,
): Result<PipelineRunContext, string> {
  const result = PipelineRunContextSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return err(`PipelineRunContext parse failed: ${issues}`);
  }
  return ok(result.data as PipelineRunContext);
}
