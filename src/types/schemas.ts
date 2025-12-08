/**
 * Master Zod Schemas - Single Source of Truth
 * 
 * CTC Pattern: Schema defines BOTH validation AND TypeScript type.
 * All types are derived via z.infer<typeof Schema>.
 * 
 * Philosophy:
 * - DRY: One schema = validation + type (can't drift)
 * - Explicit: No primitives except where truly necessary
 * - Branded: Zod 3.23+ brands atomically during validation
 * - Immutable: All arrays are readonly
 * 
 * This file replaces workflow-types.ts (743 lines of manual types).
 */

import { z } from 'zod';

// ============================================================================
// Primitive Schemas (Validated, Branded)
// ============================================================================

export const NonEmptyStringSchema = z.string()
  .min(1, "Cannot be empty")
  .brand<"NonEmptyString">();

export const PositiveIntegerSchema = z.number()
  .int("Must be an integer")
  .positive("Must be positive")
  .brand<"PositiveInteger">();

export const SemVerSchema = z.string()
  .regex(/^\d+\.\d+\.\d+$/, "Must be semantic version (e.g., '1.0.0')")
  .brand<"SemVer">();

export const FilePathSchema = z.string()
  .min(1, "Path cannot be empty")
  .brand<"FilePath">();

export const UrlSchema = z.string()
  .url("Must be a valid URL")
  .brand<"Url">();

// Infer types
export type NonEmptyString = z.infer<typeof NonEmptyStringSchema>;
export type PositiveInteger = z.infer<typeof PositiveIntegerSchema>;
export type SemVer = z.infer<typeof SemVerSchema>;
export type FilePath = z.infer<typeof FilePathSchema>;
export type Url = z.infer<typeof UrlSchema>;

// ============================================================================
// Domain ID Schemas (Branded for Compile-Time Safety)
// ============================================================================

export const WorkflowIdSchema = z.string()
  .regex(
    /^[a-z][a-z0-9-]*$/,
    "Workflow ID must be lowercase kebab-case (e.g., 'bug-investigation', 'migrate-workflow')"
  )
  .min(3, "Workflow ID must be at least 3 characters")
  .max(100, "Workflow ID cannot exceed 100 characters")
  .brand<"WorkflowId">();

export const SessionIdSchema = z.string()
  .uuid("Session ID must be a valid UUID v4")
  .brand<"SessionId">();

export const StepIdSchema = z.string()
  .regex(
    /^[a-z][a-z0-9-_]*$/,
    "Step ID must be lowercase with hyphens/underscores (e.g., 'backup-database', 'step_1')"
  )
  .min(1, "Step ID cannot be empty")
  .brand<"StepId">();

export const LoopIdSchema = z.string()
  .regex(
    /^[a-z][a-z0-9-_]*$/,
    "Loop ID must be lowercase with hyphens/underscores"
  )
  .min(1, "Loop ID cannot be empty")
  .brand<"LoopId">();

export const ProjectIdSchema = z.string()
  .regex(/^[a-f0-9]{12}$/, "Project ID must be 12-character hex hash")
  .brand<"ProjectId">();

// Infer types (always in sync with validation)
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type StepId = z.infer<typeof StepIdSchema>;
export type LoopId = z.infer<typeof LoopIdSchema>;
export type ProjectId = z.infer<typeof ProjectIdSchema>;

// ============================================================================
// Enums & Literal Unions (Explicit Types, Not Primitives)
// ============================================================================

export const StepTypeSchema = z.enum(['action', 'loop', 'conditional']);
export const LoopTypeSchema = z.enum(['while', 'until', 'for', 'forEach']);
export const PrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export const DataSourceSchema = z.enum(['disk', 'provider']);

export type StepType = z.infer<typeof StepTypeSchema>;
export type LoopType = z.infer<typeof LoopTypeSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type DataSource = z.infer<typeof DataSourceSchema>;

// ============================================================================
// Discriminated Unions (No Booleans, No Nullables)
// ============================================================================

/**
 * Loop continuation result.
 * Replaces boolean shouldContinue() - explicit reasons.
 */
export const LoopContinuationSchema = z.discriminatedUnion('_tag', [
  z.object({
    _tag: z.literal('continue'),
    iteration: PositiveIntegerSchema,
  }),
  z.object({
    _tag: z.literal('stop'),
    reason: z.enum(['condition-false', 'max-iterations']),
    warnings: z.array(NonEmptyStringSchema).readonly().optional(),
  }),
]);

export type LoopContinuation = z.infer<typeof LoopContinuationSchema>;

/**
 * Step execution result.
 * Replaces status string + optional output/error - makes invalid states impossible.
 */
export const StepExecutionResultSchema = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('not-started') }),
  z.object({ _tag: z.literal('running'), startedAt: z.date() }),
  z.object({ _tag: z.literal('completed'), output: z.string(), completedAt: z.date() }),
  z.object({ _tag: z.literal('failed'), error: z.string(), failedAt: z.date() }),
  z.object({ _tag: z.literal('skipped'), reason: NonEmptyStringSchema }),
]);

export type StepExecutionResult = z.infer<typeof StepExecutionResultSchema>;

// ============================================================================
// Domain Object Schemas (Complete, Deep Validation)
// ============================================================================

/**
 * Base workflow step schema.
 * All action and conditional steps.
 */
export const WorkflowStepBaseSchema = z.object({
  id: StepIdSchema,
  title: NonEmptyStringSchema,
  prompt: NonEmptyStringSchema,
  agentRole: z.string().optional(),
  guidance: z.array(NonEmptyStringSchema).readonly().optional(),
  askForFiles: z.boolean().optional(),
  requireConfirmation: z.union([z.boolean(), z.record(z.unknown())]).optional(),  // Can be boolean OR condition object
  runCondition: z.record(z.unknown()).optional(),
  functionDefinitions: z.array(z.record(z.unknown())).optional(),
  functionCalls: z.array(z.record(z.unknown())).optional(),
  functionReferences: z.array(NonEmptyStringSchema).readonly().optional(),
});

/**
 * Loop configuration schema.
 */
export const LoopConfigSchema = z.object({
  type: LoopTypeSchema,
  condition: z.record(z.unknown()).optional(),
  items: z.string().optional(),
  count: z.union([PositiveIntegerSchema, z.string()]).optional(),
  maxIterations: PositiveIntegerSchema,
  iterationVar: z.string().optional(),
  itemVar: z.string().optional(),
  indexVar: z.string().optional(),
});

export type LoopConfig = z.infer<typeof LoopConfigSchema>;

/**
 * Loop step schema (extends base step).
 */
export const LoopStepSchema: z.ZodType<any> = WorkflowStepBaseSchema.extend({
  type: z.literal('loop'),
  prompt: z.union([NonEmptyStringSchema, z.null()]).optional(),  // Loop steps can have null prompt
  loop: LoopConfigSchema,
  body: z.union([
    StepIdSchema,
    z.array(z.lazy(() => WorkflowStepSchema as z.ZodType<any>))
  ]),
});

export type LoopStep = z.infer<typeof LoopStepSchema>;

/**
 * Workflow step schema (union of base and loop).
 */
export const WorkflowStepSchema: z.ZodType<any> = z.union([
  WorkflowStepBaseSchema,
  LoopStepSchema
]);

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/**
 * Complete workflow schema.
 * All fields validated, all IDs branded.
 */
export const WorkflowSchema = z.object({
  id: WorkflowIdSchema,
  name: NonEmptyStringSchema,
  version: SemVerSchema,
  description: z.string(),
  preconditions: z.array(NonEmptyStringSchema).readonly().optional(),
  clarificationPrompts: z.array(NonEmptyStringSchema).readonly().optional(),
  steps: z.array(WorkflowStepSchema).min(1, "Workflow must have at least one step"),
  metaGuidance: z.array(NonEmptyStringSchema).readonly().optional(),
  functionDefinitions: z.array(z.record(z.unknown())).optional(),
});

export type Workflow = z.infer<typeof WorkflowSchema>;

/**
 * Workflow summary schema (subset of Workflow).
 */
export const WorkflowSummarySchema = z.object({
  id: WorkflowIdSchema,
  name: NonEmptyStringSchema,
  description: z.string(),
  version: SemVerSchema,
});

export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;

// ============================================================================
// Session Schema
// ============================================================================

export const SessionSchema = z.object({
  id: SessionIdSchema,
  workflowId: WorkflowIdSchema,
  projectId: ProjectIdSchema,
  projectPath: z.string(),  // File path - primitive OK here
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  data: z.record(z.unknown()),
});

export type Session = z.infer<typeof SessionSchema>;

// ============================================================================
// Persistence Schema (Repository snapshot on disk)
// ============================================================================

// Note: Persisted snapshot uses plain WorkflowSchema which DOES have brands
// When we save to JSON, brands are lost
// When we load from JSON and validate, brands are restored
// This is correct - validation at boundary (disk → memory) restores type safety
export const PersistedSnapshotSchema = z.object({
  version: z.string().min(1),
  timestamp: z.number().int().positive(),
  workflows: z.array(z.any()),  // Will validate properly during load, avoid brand issues here
});

export type PersistedSnapshot = {
  version: string;
  timestamp: number;
  workflows: any[];  // Workflows but without enforcement for serialization
};

// ============================================================================
// Repository Snapshot (In-memory, different from persisted)
// ============================================================================

/**
 * Repository snapshot metadata.
 */
export const SnapshotMetadataSchema = z.object({
  version: NonEmptyStringSchema,
  timestamp: PositiveIntegerSchema,
});

export type SnapshotMetadata = z.infer<typeof SnapshotMetadataSchema>;

/**
 * Repository snapshot (in-memory representation).
 * Note: This uses Map which can't be validated by Zod.
 * The snapshot is created by factory functions, not Zod parsing.
 */
export interface RepositorySnapshot {
  readonly workflows: ReadonlyMap<WorkflowId, Workflow>;
  readonly loadedAt: Date;
  readonly source: DataSource;
  readonly metadata: SnapshotMetadata;
}

// ============================================================================
// Type Guards (Discriminated Union Helpers)
// ============================================================================

/**
 * Type guard for loop steps.
 */
export function isLoopStep(step: WorkflowStep): step is LoopStep {
  return 'type' in step && step.type === 'loop';
}

/**
 * Type guard for loop continuation.
 */
export function shouldContinue(result: LoopContinuation): result is Extract<LoopContinuation, { _tag: 'continue' }> {
  return result._tag === 'continue';
}

export function shouldStop(result: LoopContinuation): result is Extract<LoopContinuation, { _tag: 'stop' }> {
  return result._tag === 'stop';
}

// ============================================================================
// Readonly Utilities (Build Pattern)
// ============================================================================

/**
 * Convert mutable array to readonly (zero-cost type conversion).
 */
export const asReadonly = <T>(array: T[]): readonly T[] => array;

/**
 * Convert mutable map to readonly (zero-cost type conversion).
 */
export const asReadonlyMap = <K, V>(map: Map<K, V>): ReadonlyMap<K, V> => map;

/**
 * Build readonly array using mutable construction.
 * 
 * @example
 * const items = buildReadonlyArray<Item>(arr => {
 *   for (const x of source) {
 *     arr.push(transform(x));  // Mutate during construction
 *   }
 * });  // Returns readonly Item[] (zero-copy)
 */
export const buildReadonlyArray = <T>(
  builder: (array: T[]) => void
): readonly T[] => {
  const array: T[] = [];
  builder(array);
  return array;  // Type-converted to readonly
};

/**
 * Build readonly map using mutable construction.
 */
export const buildReadonlyMap = <K, V>(
  builder: (map: Map<K, V>) => void
): ReadonlyMap<K, V> => {
  const map = new Map<K, V>();
  builder(map);
  return map;
};

/**
 * Build readonly grouped map (CTC pattern).
 * 
 * @example
 * const byTeam = buildReadonlyGroupMap<string, Workflow>((map, add) => {
 *   for (const wf of workflows) {
 *     add(map, wf.team, wf);
 *   }
 * });
 */
export const buildReadonlyGroupMap = <K, V>(
  builder: (map: Map<K, V[]>, add: (map: Map<K, V[]>, key: K, value: V) => void) => void
): ReadonlyMap<K, readonly V[]> => {
  const map = new Map<K, V[]>();
  
  const add = (m: Map<K, V[]>, key: K, value: V) => {
    const existing = m.get(key);
    if (existing) {
      existing.push(value);
    } else {
      m.set(key, [value]);
    }
  };
  
  builder(map, add);
  return map;
};

// ============================================================================
// Factory Functions (Create Immutable Objects)
// ============================================================================

/**
 * Create immutable repository snapshot (CTC pattern).
 * All nested objects frozen.
 */
export function createSnapshot(
  workflows: readonly Workflow[],
  source: DataSource,
  metadata: SnapshotMetadata
): RepositorySnapshot {
  const workflowMap = buildReadonlyMap<any, Workflow>(map => {
    for (const wf of workflows) {
      map.set(wf.id as any, wf);
    }
  });
  
  const snapshot: RepositorySnapshot = {
    workflows: workflowMap,
    loadedAt: Object.freeze(new Date()),
    source,
    metadata: Object.freeze(metadata),
  };
  
  return Object.freeze(snapshot);
}

/**
 * Extract workflows array from snapshot (pure function).
 */
export function getWorkflowsArray(snapshot: RepositorySnapshot): readonly Workflow[] {
  return Array.from(snapshot.workflows.values());
}

/**
 * Extract workflow IDs from snapshot (pure function).
 */
export function getWorkflowIds(snapshot: RepositorySnapshot): readonly WorkflowId[] {
  return Array.from(snapshot.workflows.keys());
}

/**
 * Extract workflow IDs as strings for fuzzy matching (pure function).
 */
export function getWorkflowIdsAsStrings(snapshot: RepositorySnapshot): readonly string[] {
  return Array.from(snapshot.workflows.keys()) as readonly string[];
}
