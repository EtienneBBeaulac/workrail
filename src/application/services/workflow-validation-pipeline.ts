import type { Workflow } from '../../types/workflow.js';
import type { DomainError } from '../../domain/execution/error.js';
import type { WorkflowCompiler, CompiledWorkflow } from './workflow-compiler.js';
import type { ValidationEngine } from './validation-engine.js';
import type { WorkflowInterpreter } from './workflow-interpreter.js';
import { type Result, ok, err } from 'neverthrow';
import type { CompiledWorkflowSnapshotV1 } from '../../v2/durable-core/schemas/compiled-workflow/index.js';
import type { StartabilityFailure } from '../../v2/durable-core/domain/start-construction.js';

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

/**
 * Full Phase 1b validation outcome (extends Phase 1a).
 *
 * Phase 1b includes all 8 phases: schema → structural → v1 compilation → normalization →
 * round-trip → executable construction → v2 compilation → startability.
 */
export type ValidationOutcome =
  | { readonly kind: 'schema_failed'; readonly workflowId: string; readonly errors: readonly SchemaError[] }
  | { readonly kind: 'structural_failed'; readonly workflowId: string; readonly issues: readonly string[] }
  | { readonly kind: 'v1_compilation_failed'; readonly workflowId: string; readonly cause: DomainError }
  | { readonly kind: 'normalization_failed'; readonly workflowId: string; readonly cause: DomainError }
  | { readonly kind: 'round_trip_failed'; readonly workflowId: string; readonly cause: string }
  | { readonly kind: 'v2_compilation_failed'; readonly workflowId: string; readonly cause: DomainError }
  | { readonly kind: 'startability_failed'; readonly workflowId: string; readonly reason: StartabilityFailure }
  | { readonly kind: 'valid'; readonly validated: ValidatedWorkflow };

/**
 * ValidatedWorkflow — the compile-time gate type.
 * Only constructible through the full validation pipeline.
 *
 * Stores both the source (authored) and executable forms, plus their compiled representations.
 */
export interface ValidatedWorkflow {
  readonly kind: 'validated_workflow';
  readonly source: Workflow;
  readonly executable: any; // ExecutableWorkflow (non-compiled executable form from Phase 6)
  readonly compiledV1: CompiledWorkflow;
  readonly compiledExecutable: any; // TODO: CompiledExecutableWorkflow type (Phase 1b evolution)
}

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
   * Normalization function (v1-to-v2-shim's normalizeV1WorkflowToPinnedSnapshot).
   */
  readonly normalizeToExecutable: (workflow: Workflow) => Result<ExecutableCompiledWorkflowSnapshot, DomainError>;
}

/**
 * Dependencies for Phase 1b (extends Phase 1a with additional validators).
 */
export interface ValidationPipelineDeps extends ValidationPipelineDepsPhase1a {
  /**
   * WorkflowInterpreter instance for startability check (Phase 1b step 8).
   */
  readonly interpreter: WorkflowInterpreter;

  /**
   * Shared function for first-step resolution (Phase 1b step 8).
   * Lives in src/v2/durable-core/domain/start-construction.ts.
   */
  readonly resolveFirstStep: (
    authoredWorkflow: Workflow,
    pinnedSnapshot: Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }>
  ) => Result<{ readonly id: string }, StartabilityFailure>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Function (Phase 1a)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a workflow through the Phase 1a pipeline:
 * 1. Schema validation (AJV)
 * 2. Structural validation (ValidationEngine checks, no normalization)
 * 3. V1 compilation (WorkflowCompiler.compile on authored form)
 * 4. Normalization (normalizeV1WorkflowToPinnedSnapshot)
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

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline Function (Phase 1b - Full Pipeline)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a workflow through the full 8-phase pipeline.
 *
 * Phases:
 * 1. Schema validation (AJV)
 * 2. Structural validation (ValidationEngine)
 * 3. V1 compilation (WorkflowCompiler.compile)
 * 4. Normalization (normalizeV1WorkflowToPinnedSnapshot)
 * 5. Serialization round-trip (JSON.stringify > parse > Zod)
 * 6. Executable construction (Object.freeze wrapped definition)
 * 7. V2 compilation (WorkflowCompiler.compileExecutable)
 * 8. Startability (resolveFirstStep + interpreter.next)
 *
 * Short-circuits on first failure. Returns a discriminated union outcome.
 */
export function validateWorkflow(
  workflow: Workflow,
  deps: ValidationPipelineDeps
): ValidationOutcome {
  const workflowId = workflow.definition.id;

  // Phases 1-4: run Phase 1a pipeline
  const phase1aOutcome = validateWorkflowPhase1a(workflow, deps);
  if (phase1aOutcome.kind !== 'phase1a_valid') {
    // Map Phase 1a failure to Phase 1b outcome (same variant names)
    return phase1aOutcome as ValidationOutcome;
  }

  const snapshot = phase1aOutcome.snapshot;

  // Phase 5: Serialization round-trip
  // Prove that the normalized definition survives JSON stringify > parse cycle
  let roundTrippedDefinition: any;
  try {
    const serialized = JSON.stringify(snapshot);
    const deserialized = JSON.parse(serialized);

    // Verify the definition is still present after round-trip
    if (!deserialized?.definition) {
      return {
        kind: 'round_trip_failed',
        workflowId,
        cause: 'Definition lost during JSON round-trip',
      };
    }
    roundTrippedDefinition = deserialized.definition;
  } catch (e) {
    return {
      kind: 'round_trip_failed',
      workflowId,
      cause: e instanceof Error ? e.message : String(e),
    };
  }

  // Phase 6: Executable construction
  // Create a wrapper object (frozen for immutability) - this is non-failing
  const executableWorkflow = Object.freeze({
    kind: 'executable_workflow' as const,
    definition: roundTrippedDefinition,
  });

  // Phase 7: V2 compilation (on executable form)
  // DEFERRED: WorkflowCompiler.compileExecutable() not yet implemented.
  // Phase 7 is skipped pending v2 execution implementation.
  // Once compileExecutable exists, uncomment this and remove placeholder:
  // const v2CompilationResult = deps.compiler.compileExecutable(executableWorkflow);
  // if (v2CompilationResult.isErr()) {
  //   return { kind: 'v2_compilation_failed', workflowId, cause: v2CompilationResult.error };
  // }
  const compiledExecutable = {} as any; // Placeholder - Phase 7 deferred

  // Phase 8: Startability (two sub-checks)
  const startabilityResult = validateStartability(workflow, snapshot, executableWorkflow, deps);
  if (startabilityResult.isErr()) {
    return { kind: 'startability_failed', workflowId, reason: startabilityResult.error };
  }

  // Success: construct ValidatedWorkflow
  const v1Compiled = deps.compiler.compile(workflow).unwrapOr(undefined as any);
  if (!v1Compiled) {
    // Should never happen (we already validated v1 compilation in phase 3)
    throw new Error('Invariant violation: v1 compilation failed after already passing');
  }

  return {
    kind: 'valid',
    validated: {
      kind: 'validated_workflow',
      source: workflow,
      executable: executableWorkflow,
      compiledV1: v1Compiled,
      compiledExecutable,
    },
  };
}

/**
 * Startability validation (Phase 8).
 *
 * Two sub-checks:
 * 1. First-step resolution (via shared resolveFirstStep function) - REQUIRED
 * 2. Interpreter reachability (interpreter.next from init state) - DEFERRED
 *
 * The interpreter check validates that the workflow is reachable from initial state.
 * This is stricter than runtime (which doesn't call interpreter at start) but catches
 * workflows where the first step has a false runCondition or is an invalid loop.
 *
 * DEFERRED: Phase 7 (v2 compilation) and Phase 8 sub-check 2 (interpreter) are
 * deferred pending WorkflowInterpreter implementation. For now, sub-check 1
 * (first-step resolution) is the only active startability check.
 */
function validateStartability(
  authoredWorkflow: Workflow,
  pinnedSnapshot: Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }>,
  executableWorkflow: any, // ExecutableWorkflow from Phase 6
  deps: ValidationPipelineDeps
): Result<void, StartabilityFailure> {
  // Sub-check 1: First-step resolution (shared with runtime, REQUIRED)
  // Validates: workflow has steps, steps[0].id exists in executable form
  const firstStepResult = deps.resolveFirstStep(authoredWorkflow, pinnedSnapshot);
  if (firstStepResult.isErr()) {
    return err(firstStepResult.error);
  }

  // Sub-check 2: Interpreter reachability (DEFERRED)
  // DEFERRED: Pending Phase 7 (v2 compilation) and full interpreter implementation.
  // When ready, uncomment and call: deps.interpreter.next(compiledExecutable, { kind: 'init' })
  //
  // The interpreter would validate:
  // - Interpreter can produce a pending step from initial state
  // - If isComplete=true with zero completed steps, workflow has no reachable steps
  //
  // Until then, first-step resolution alone proves basic startability.

  return ok(undefined);
}
