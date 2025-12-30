import { z } from 'zod';
import { DELIMITER_SAFE_ID_PATTERN } from '../../constants.js';

/**
 * Decision trace reference types (v2, locked).
 *
 * Lock: decision_trace_appended.entries[].refs is a CLOSED SET union, not an open bag.
 * This prevents unbounded growth and divergent conventions across engine/Studio/export.
 *
 * See: docs/design/v2-core-design-locks.md (decision_trace_appended)
 */

/**
 * Closed-set decision trace reference kinds.
 *
 * Lock: new ref kinds require a schema version bump or explicit union extension.
 */
export const DecisionTraceRefKindSchema = z.enum([
  'step_id',
  'loop_id',
  'condition_id',
  'iteration',
]);

export type DecisionTraceRefKind = z.infer<typeof DecisionTraceRefKindSchema>;

/**
 * Decision trace ref: step_id
 * References a workflow step by its delimiter-safe ID.
 */
const StepIdRefSchema = z.object({
  kind: z.literal('step_id'),
  stepId: z.string().regex(DELIMITER_SAFE_ID_PATTERN, 'stepId must be delimiter-safe: [a-z0-9_-]+'),
}).strict();

/**
 * Decision trace ref: loop_id
 * References a loop by its delimiter-safe ID.
 */
const LoopIdRefSchema = z.object({
  kind: z.literal('loop_id'),
  loopId: z.string().regex(DELIMITER_SAFE_ID_PATTERN, 'loopId must be delimiter-safe: [a-z0-9_-]+'),
}).strict();

/**
 * Decision trace ref: condition_id
 * References a condition by its delimiter-safe ID.
 */
const ConditionIdRefSchema = z.object({
  kind: z.literal('condition_id'),
  conditionId: z.string().regex(DELIMITER_SAFE_ID_PATTERN, 'conditionId must be delimiter-safe: [a-z0-9_-]+'),
}).strict();

/**
 * Decision trace ref: iteration
 * References a loop iteration number (0-based).
 */
const IterationRefSchema = z.object({
  kind: z.literal('iteration'),
  value: z.number().int().nonnegative(),
}).strict();

/**
 * Decision trace reference (closed union).
 *
 * Lock: this is a discriminatedUnion by 'kind'. New ref kinds require explicit extension.
 */
export const DecisionTraceRefV1Schema = z.discriminatedUnion('kind', [
  StepIdRefSchema,
  LoopIdRefSchema,
  ConditionIdRefSchema,
  IterationRefSchema,
]);

export type DecisionTraceRefV1 = z.infer<typeof DecisionTraceRefV1Schema>;

/**
 * Maximum refs per decision trace entry.
 *
 * Lock: bounded to prevent unbounded growth.
 */
export const MAX_DECISION_TRACE_REFS_PER_ENTRY = 10;

/**
 * Decision trace refs array schema (bounded).
 *
 * Lock: optional, max 10 refs per entry, deterministic ordering by (kind, id/value).
 */
export const DecisionTraceRefsV1Schema = z
  .array(DecisionTraceRefV1Schema)
  .max(MAX_DECISION_TRACE_REFS_PER_ENTRY)
  .optional();

export type DecisionTraceRefsV1 = z.infer<typeof DecisionTraceRefsV1Schema>;
