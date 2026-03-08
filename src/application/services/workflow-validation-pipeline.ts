import type { Workflow } from '../../types/workflow.js';
import type { DomainError } from '../../domain/execution/error.js';
import type { WorkflowCompiler, CompiledWorkflow } from './workflow-compiler.js';
import type { ValidationEngine } from './validation-engine.js';
import { type Result, ok, err } from 'neverthrow';
import type { CompiledWorkflowSnapshotV1 } from '../../v2/durable-core/schemas/compiled-workflow/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Outcome Types (Discriminated Union)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AJV schema error shape (from validation.ts).
 */
export interface SchemaError {
  readonly instancePath: string;
  readonly message?: string;
  readonly keyword?: string;
  readonly params?: unknown;
}

/**
 * The ExecutableCompiledWorkflowSnapshot type representing a normalized executable workflow.
 * This is the v1_pinned variant from the compiled snapshot schema.
 */
export type ExecutableCompiledWorkflowSnapshot = Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }>;

/**
 * Validation outcome for Phase 1a pipeline.
 *
 * Phase 1a includes: schema, structural, v1 compilation, normalization.
 * Does NOT include: round-trip, v2 compilation, startability (those are Phase 1b).
 */
export type ValidationOutcomePhase1a =
  | { readonly kind: 'schema_failed'; readonly workflowId: string; readonly errors: readonly SchemaError[] }
  | { readonly kind: 'structural_failed'; readonly workflowId: string; readonly issues: readonly string[] }
  | { readonly kind: 'v1_compilation_failed'; readonly workflowId: string; readonly cause: DomainError }
  | { readonly kind: 'normalization_failed'; readonly workflowId: string; readonly cause: DomainError }
  | { readonly kind: 'phase1a_valid'; readonly workflowId: string; readonly snapshot: ExecutableCompiledWorkflowSnapshot };

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies (Injected)
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationPipelineDepsPhase1a {
  /**
   * Schema validator (AJV-based, from validation.ts).
   * Returns Ok(workflow) if schema-valid, Err(errors) otherwise.
   */
  readonly schemaValidate: (workflow: Workflow) => Result<Workflow, readonly SchemaError[]>;

  /**
   * Structural validator (ValidationEngine, minus the normalization call).
   * Returns Ok(workflow) if structural checks pass, Err(issues) otherwise.
   */
  readonly structuralValidate: (workflow: Workflow) => Result<Workflow, readonly string[]>;

  /**
   * V1 compiler (compiles authored Workflow to CompiledWorkflow).
   */
  readonly compiler: WorkflowCompiler;

  /**
   * Normalization function (v1-to-v2-shim's compileV1WorkflowToPinnedSnapshot).
   */
  readonly normalizeToExecutable: (workflow: Workflow) => Result<ExecutableCompiledWorkflowSnapshot, DomainError>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Function (Phase 1a)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a workflow through the Phase 1a pipeline:
 * 1. Schema validation (AJV)
 * 2. Structural validation (ValidationEngine checks, no normalization)
 * 3. V1 compilation (WorkflowCompiler.compile on authored form)
 * 4. Normalization (compileV1WorkflowToPinnedSnapshot)
 *
 * Short-circuits on first failure. Returns a discriminated union outcome.
 */
export function validateWorkflowPhase1a(
  workflow: Workflow,
  deps: ValidationPipelineDepsPhase1a
): ValidationOutcomePhase1a {
  const workflowId = workflow.definition.id;

  // Phase 1: Schema validation
  const schemaResult = deps.schemaValidate(workflow);
  if (schemaResult.isErr()) {
    return { kind: 'schema_failed', workflowId, errors: schemaResult.error };
  }

  // Phase 2: Structural validation
  const structuralResult = deps.structuralValidate(workflow);
  if (structuralResult.isErr()) {
    return { kind: 'structural_failed', workflowId, issues: structuralResult.error };
  }

  // Phase 3: V1 compilation (on authored Workflow)
  const v1CompilationResult = deps.compiler.compile(workflow);
  if (v1CompilationResult.isErr()) {
    return { kind: 'v1_compilation_failed', workflowId, cause: v1CompilationResult.error };
  }

  // Phase 4: Normalization to executable form
  const normalizationResult = deps.normalizeToExecutable(workflow);
  if (normalizationResult.isErr()) {
    return { kind: 'normalization_failed', workflowId, cause: normalizationResult.error };
  }

  return { kind: 'phase1a_valid', workflowId, snapshot: normalizationResult.value };
}
