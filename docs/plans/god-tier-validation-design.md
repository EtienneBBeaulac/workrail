# God-Tier Workflow Validation: Detailed Design

This document specifies the exact types, functions, interfaces, and file structure for implementing the god-tier validation plan. Each phase has concrete TypeScript signatures and implementation notes.

---

## Phase 1a: Pipeline Skeleton

### Goal

Consolidate existing validation (schema + structural + v1 compilation + normalization) into a single typed pipeline function. No new validation logic — just unification.

### New File: `src/application/services/workflow-validation-pipeline.ts`

```typescript
import type { Workflow } from '../../types/workflow.js';
import type { DomainError } from '../../domain/execution/error.js';
import type { WorkflowCompiler, CompiledWorkflow } from './workflow-compiler.js';
import type { ValidationEngine } from './validation-engine.js';
import { type Result, ok, err } from 'neverthrow';

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
 * The ExecutableCompiledWorkflowSnapshot type from v2-to-v1-shim.
 * Contains the normalized executable workflow definition.
 */
export type ExecutableCompiledWorkflowSnapshot = {
  readonly definition: ExecutableWorkflowDefinition;
  readonly compiledMetadata: unknown; // Additional metadata from compilation
};

// Import from existing files:
import type { ExecutableWorkflowDefinition } from '../../v2/durable-core/schemas/compiled-workflow/index.js';

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
  const workflowId = workflow.id;
  
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
```

### Changes to `src/application/services/validation-engine.ts`

**Extract normalization from `validateWorkflow()`:**

Current code (lines 763+):
```typescript
if (issues.length === 0) {
  const executableValidation = compileV1WorkflowToPinnedSnapshot(workflow);
  if (executableValidation.isErr()) {
    issues.push(executableValidation.error.message);
    // ...
  }
}
```

Change to:
```typescript
// Normalization is now handled by the pipeline, not the validation engine.
// This method only performs structural checks.
```

**New method for Phase 1a deps:**

```typescript
/**
 * Validate workflow structure (no normalization).
 * Returns Result<Workflow, string[]> for pipeline integration.
 */
validateWorkflowStructureOnly(workflow: Workflow): Result<Workflow, string[]> {
  const result = this.validateWorkflow(workflow);
  if (result.valid) {
    return ok(workflow);
  }
  return err(result.issues);
}
```

### Changes to `src/application/validation.ts`

**Wrap AJV validator for pipeline:**

```typescript
import type { SchemaError } from './services/workflow-validation-pipeline.js';

/**
 * Validate workflow against JSON schema (for pipeline integration).
 */
export function validateWorkflowSchema(workflow: Workflow): Result<Workflow, readonly SchemaError[]> {
  const result = validateWorkflow(workflow); // existing AJV validator
  if (result.valid) {
    return ok(workflow);
  }
  // Map AJV errors to SchemaError[]
  const errors: SchemaError[] = result.errors?.map(e => ({
    instancePath: e.instancePath ?? '',
    message: e.message,
    keyword: e.keyword,
    params: e.params,
  })) ?? [];
  return err(errors);
}
```

### Changes to `src/application/use-cases/validate-workflow-file.ts`

**Rewire to use the pipeline:**

```typescript
import { validateWorkflowPhase1a, type ValidationOutcomePhase1a } from '../services/workflow-validation-pipeline.js';

export function createValidateWorkflowFileUseCase(/* DI deps */) {
  return async (filePath: string): Promise<ValidationResult> => {
    // Load workflow from file
    const workflow = await loadWorkflowFromFile(filePath);
    
    // Build pipeline deps
    const deps = {
      schemaValidate: validateWorkflowSchema,
      structuralValidate: (wf) => validationEngine.validateWorkflowStructureOnly(wf),
      compiler: workflowCompiler,
      normalizeToExecutable: compileV1WorkflowToPinnedSnapshot,
    };
    
    // Run pipeline
    const outcome = validateWorkflowPhase1a(workflow, deps);
    
    // Map outcome to existing ValidationResult format
    return mapOutcomeToValidationResult(outcome);
  };
}

function mapOutcomeToValidationResult(outcome: ValidationOutcomePhase1a): ValidationResult {
  if (outcome.kind === 'phase1a_valid') {
    return { valid: true, issues: [], suggestions: [], warnings: [] };
  }
  
  // For now, all failures map to a single 'pipeline_invalid' result
  const message = outcomeToErrorMessage(outcome);
  return { valid: false, issues: [message], suggestions: [], warnings: [] };
}

function outcomeToErrorMessage(outcome: Exclude<ValidationOutcomePhase1a, { kind: 'phase1a_valid' }>): string {
  switch (outcome.kind) {
    case 'schema_failed':
      return `Schema validation failed: ${outcome.errors.map(e => e.message).join(', ')}`;
    case 'structural_failed':
      return `Structural validation failed: ${outcome.issues.join(', ')}`;
    case 'v1_compilation_failed':
      return `V1 compilation failed: ${outcome.cause.message}`;
    case 'normalization_failed':
      return `Normalization failed: ${outcome.cause.message}`;
  }
}
```

### Changes to `src/application/use-cases/validate-workflow-json.ts`

Similar rewiring as `validate-workflow-file.ts` (parse JSON, call pipeline, map result).

---

## Phase 1b: Full Pipeline

### Goal

Add the missing validation phases to complete the 8-phase pipeline: round-trip, executable construction, v2 compilation, startability.

### Extend `src/application/services/workflow-validation-pipeline.ts`

**Add Phase 1b outcome variants:**

```typescript
import type { ExecutableWorkflow } from '../../v2/durable-core/executable-workflow.js';
import type { CompiledExecutableWorkflow } from './workflow-compiler.js';
import type { WorkflowInterpreter } from './workflow-interpreter.js';

/**
 * Full Phase 1b validation outcome.
 * Extends Phase 1a with: round-trip, v2 compilation, startability.
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
 * Startability failure reasons (discriminated union).
 */
export type StartabilityFailure =
  | { readonly reason: 'no_steps'; readonly detail: 'Workflow has no steps in authored form' }
  | { readonly reason: 'first_step_not_in_executable'; readonly authoredStepId: string; readonly detail: string }
  | { readonly reason: 'no_reachable_step'; readonly detail: 'Interpreter returned isComplete=true with zero completed steps' }
  | { readonly reason: 'interpreter_error'; readonly detail: string };

/**
 * ValidatedWorkflow — the compile-time gate type.
 * Only constructible through the full validation pipeline.
 */
export interface ValidatedWorkflow {
  readonly kind: 'validated_workflow';
  readonly source: Workflow;
  readonly executable: ExecutableWorkflow;
  readonly compiledV1: CompiledWorkflow;
  readonly compiledExecutable: CompiledExecutableWorkflow;
}

/**
 * Dependencies for Phase 1b (extends Phase 1a).
 */
export interface ValidationPipelineDeps extends ValidationPipelineDepsPhase1a {
  /**
   * WorkflowInterpreter instance for startability check.
   */
  readonly interpreter: WorkflowInterpreter;
  
  /**
   * Shared function for first-step resolution.
   * Lives in src/v2/durable-core/domain/start-construction.ts.
   */
  readonly resolveFirstStep: (
    authoredWorkflow: Workflow,
    executableWorkflow: ExecutableWorkflow
  ) => Result<{ readonly id: string }, StartabilityFailure>;
}
```

**Full pipeline function:**

```typescript
/**
 * Validate a workflow through the full 8-phase pipeline.
 * 
 * Phases:
 * 1. Schema validation (AJV)
 * 2. Structural validation (ValidationEngine)
 * 3. V1 compilation (WorkflowCompiler.compile)
 * 4. Normalization (compileV1WorkflowToPinnedSnapshot)
 * 5. Serialization round-trip (JSON.stringify > parse > Zod)
 * 6. Executable construction (createExecutableWorkflow)
 * 7. V2 compilation (WorkflowCompiler.compileExecutable)
 * 8. Startability (resolveFirstStep + interpreter.next)
 */
export function validateWorkflow(
  workflow: Workflow,
  deps: ValidationPipelineDeps
): ValidationOutcome {
  const workflowId = workflow.id;
  
  // Phases 1-4: run Phase 1a pipeline
  const phase1aOutcome = validateWorkflowPhase1a(workflow, deps);
  if (phase1aOutcome.kind !== 'phase1a_valid') {
    // Map Phase 1a failure to Phase 1b outcome (same variant names)
    return phase1aOutcome as ValidationOutcome;
  }
  
  const snapshot = phase1aOutcome.snapshot;
  
  // Phase 5: Serialization round-trip
  let roundTrippedDefinition: ExecutableWorkflowDefinition;
  try {
    const serialized = JSON.stringify(snapshot);
    const deserialized = JSON.parse(serialized);
    
    // Re-parse through Zod schema
    const parseResult = ExecutableWorkflowDefinitionSchema.safeParse(deserialized.definition);
    if (!parseResult.success) {
      return {
        kind: 'round_trip_failed',
        workflowId,
        cause: `Zod re-parse failed after round-trip: ${parseResult.error.message}`,
      };
    }
    roundTrippedDefinition = parseResult.data;
  } catch (e) {
    return {
      kind: 'round_trip_failed',
      workflowId,
      cause: e instanceof Error ? e.message : String(e),
    };
  }
  
  // Phase 6: Executable construction (non-failing, just type wrapper)
  const executableWorkflow = createExecutableWorkflow(roundTrippedDefinition);
  
  // Phase 7: V2 compilation (on executable form)
  const v2CompilationResult = deps.compiler.compileExecutable(executableWorkflow);
  if (v2CompilationResult.isErr()) {
    return { kind: 'v2_compilation_failed', workflowId, cause: v2CompilationResult.error };
  }
  
  const compiledExecutable = v2CompilationResult.value;
  
  // Phase 8: Startability
  const startabilityResult = validateStartability(
    workflow,
    executableWorkflow,
    compiledExecutable,
    deps
  );
  if (startabilityResult.isErr()) {
    return { kind: 'startability_failed', workflowId, reason: startabilityResult.error };
  }
  
  // Success: construct ValidatedWorkflow
  const v1Compiled = deps.compiler.compile(workflow).unwrapOrElse(() => {
    // Should never happen (we already validated v1 compilation in phase 3)
    throw new Error('Invariant violation: v1 compilation failed after already passing');
  });
  
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
 * 1. First-step resolution (via shared resolveFirstStep function)
 * 2. Interpreter reachability (interpreter.next from init state)
 */
function validateStartability(
  authoredWorkflow: Workflow,
  executableWorkflow: ExecutableWorkflow,
  compiledExecutable: CompiledExecutableWorkflow,
  deps: ValidationPipelineDeps
): Result<void, StartabilityFailure> {
  // Sub-check 1: First-step resolution (shared with runtime)
  const firstStepResult = deps.resolveFirstStep(authoredWorkflow, executableWorkflow);
  if (firstStepResult.isErr()) {
    return err(firstStepResult.error);
  }
  
  // Sub-check 2: Interpreter reachability
  const initialState = { kind: 'init' as const };
  const nextResult = deps.interpreter.next(compiledExecutable, initialState);
  
  if (nextResult.isErr()) {
    return err({
      reason: 'interpreter_error',
      detail: nextResult.error.message,
    });
  }
  
  const { next, isComplete } = nextResult.value;
  
  // If the interpreter returned isComplete=true with no next step and zero completed work,
  // the workflow has no reachable steps.
  if (isComplete && !next && nextResult.value.state.kind === 'running' && nextResult.value.state.completed.length === 0) {
    return err({
      reason: 'no_reachable_step',
      detail: 'Interpreter returned isComplete=true with zero completed steps from initial state',
    });
  }
  
  return ok(undefined);
}
```

### New File: `src/v2/durable-core/domain/start-construction.ts`

```typescript
import type { Workflow } from '../../../types/workflow.js';
import type { ExecutableWorkflow } from '../executable-workflow.js';
import { type Result, ok, err } from 'neverthrow';
import type { StartabilityFailure } from '../../../application/services/workflow-validation-pipeline.js';

/**
 * Resolve the first step from an authored workflow.
 * 
 * Validates:
 * - Workflow has at least one step
 * - steps[0].id exists in the executable workflow
 * 
 * This function is shared by:
 * - Runtime (start.ts)
 * - Validation pipeline (Phase 1b step 8)
 * 
 * Ensures runtime and validation use identical first-step resolution logic.
 */
export function resolveFirstStep(
  authoredWorkflow: Workflow,
  executableWorkflow: ExecutableWorkflow
): Result<{ readonly id: string }, StartabilityFailure> {
  // Check: workflow has at least one step in authored form
  const firstStep = authoredWorkflow.definition.steps[0];
  if (!firstStep) {
    return err({
      reason: 'no_steps',
      detail: 'Workflow has no steps in authored form',
    });
  }
  
  const firstStepId = firstStep.id;
  
  // Check: first step ID exists in executable form
  const executableStep = executableWorkflow.definition.steps.find(s => s.id === firstStepId);
  if (!executableStep) {
    return err({
      reason: 'first_step_not_in_executable',
      authoredStepId: firstStepId,
      detail: `Step '${firstStepId}' from authored workflow steps[0] not found in executable workflow`,
    });
  }
  
  return ok({ id: firstStepId });
}
```

### Changes to `src/mcp/handlers/v2-execution/start.ts`

**Refactor to use shared `resolveFirstStep`:**

Current code (lines 62-70):
```typescript
.andThen((workflow): RA<{ workflow: ...; firstStep: { readonly id: string } }, StartWorkflowError> => {
  if (!workflow) {
    return neErrorAsync({ kind: 'workflow_not_found' as const, workflowId: asWorkflowId(workflowId) });
  }
  const firstStep = workflow.definition.steps[0];
  if (!firstStep) {
    return neErrorAsync({ kind: 'workflow_has_no_steps' as const, workflowId: asWorkflowId(workflowId) });
  }
  return okAsync({ workflow, firstStep });
})
```

Change to:
```typescript
.andThen((workflow): RA<{ workflow: ...; firstStep: { readonly id: string } }, StartWorkflowError> => {
  if (!workflow) {
    return neErrorAsync({ kind: 'workflow_not_found' as const, workflowId: asWorkflowId(workflowId) });
  }
  
  // Cheap pre-check: workflow has steps (avoids expensive pinning for zero-step workflows)
  if (workflow.definition.steps.length === 0) {
    return neErrorAsync({ kind: 'workflow_has_no_steps' as const, workflowId: asWorkflowId(workflowId) });
  }
  
  return okAsync({ workflow });
})
```

Later, **after pinning** (new location for cross-form check):

```typescript
.andThen(({ workflow, workflowHash, pinnedWorkflow }) => {
  // Resolve first step using shared function (validates cross-form consistency)
  const firstStepResult = resolveFirstStep(workflow, pinnedWorkflow);
  if (firstStepResult.isErr()) {
    return neErrorAsync({
      kind: 'startability_failed' as const,
      reason: firstStepResult.error,
    });
  }
  
  return okAsync({ workflow, workflowHash, pinnedWorkflow, firstStep: firstStepResult.value });
})
```

**Update `StartWorkflowError` type:**

Add new error kind:
```typescript
type StartWorkflowError =
  | { readonly kind: 'workflow_not_found'; readonly workflowId: WorkflowId }
  | { readonly kind: 'workflow_has_no_steps'; readonly workflowId: WorkflowId }
  | { readonly kind: 'startability_failed'; readonly reason: StartabilityFailure }
  | // ... existing error kinds
```

---

## Phase 2: Registry-Centric Validation

### Goal

Build a registry snapshot (using shared resolution functions), detect duplicates, and run the Phase 1b pipeline on each resolved workflow.

### New File: `src/application/use-cases/registry-validation/registry-snapshot.ts`

```typescript
import type { Workflow } from '../../../types/workflow.js';
import type { WorkflowSource } from '../../../types/storage.js';

/**
 * Raw workflow file discovered by the scanner (before variant resolution).
 */
export interface RawWorkflowFile {
  readonly filePath: string;
  readonly sourceKind: string; // 'bundled', 'user', 'plugin', etc.
  readonly sourceRef: string; // directory path, repo URL, etc.
  readonly workflow: RawWorkflowFileContent;
}

/**
 * Raw file content (discriminated union: parsed or unparseable).
 */
export type RawWorkflowFileContent =
  | { readonly kind: 'parsed'; readonly workflow: Workflow }
  | { readonly kind: 'unparseable'; readonly parseError: string };

/**
 * Workflow candidate (after file discovery, before variant resolution).
 */
export interface WorkflowCandidate {
  readonly id: string;
  readonly workflow: Workflow;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly variantKind: 'standard' | 'agentic' | 'v2' | 'agentic+v2';
}

/**
 * Resolved workflow (after deduplication and variant selection).
 */
export interface ResolvedWorkflow {
  readonly id: string;
  readonly workflow: Workflow;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly variantKind: 'standard' | 'agentic' | 'v2' | 'agentic+v2';
  readonly resolvedBy: 'source_priority' | 'variant_priority' | 'only_candidate';
}

/**
 * Duplicate ID report (multiple candidates with the same ID).
 */
export interface DuplicateIdReport {
  readonly workflowId: string;
  readonly candidates: readonly {
    readonly sourceKind: string;
    readonly sourceRef: string;
    readonly variantKind: string;
  }[];
  readonly resolved: {
    readonly sourceKind: string;
    readonly sourceRef: string;
    readonly variantKind: string;
  };
}

/**
 * Registry snapshot — the frozen state of workflow discovery and resolution.
 * Built by calling shared pure functions (resolveWorkflowCandidates, findWorkflowJsonFiles).
 * Passed as input to the registry validator.
 */
export interface RegistrySnapshot {
  readonly variant: string; // e.g. 'default', 'v2-tools-enabled'
  readonly rawFiles: readonly RawWorkflowFile[];
  readonly candidates: readonly WorkflowCandidate[];
  readonly resolved: readonly ResolvedWorkflow[];
  readonly duplicates: readonly DuplicateIdReport[];
}
```

### New File: `src/application/use-cases/registry-validation/build-registry-snapshot.ts`

```typescript
import type { RegistrySnapshot, RawWorkflowFile, WorkflowCandidate, ResolvedWorkflow, DuplicateIdReport } from './registry-snapshot.js';
import type { IWorkflowStorage, WorkflowSource } from '../../../types/storage.js';
import { resolveWorkflowCandidates } from './resolve-workflow-candidates.js';
import { findWorkflowJsonFiles } from './find-workflow-json-files.js';

/**
 * Build a registry snapshot from a multi-source storage chain.
 * 
 * Uses shared pure functions:
 * - findWorkflowJsonFiles() (from FileWorkflowStorage)
 * - resolveWorkflowCandidates() (from EnhancedMultiSourceWorkflowStorage)
 */
export async function buildRegistrySnapshot(
  storageChain: readonly IWorkflowStorage[],
  variantName: string,
  featureFlags: { v2Tools: boolean; agenticRoutines: boolean }
): Promise<RegistrySnapshot> {
  // Step 1: Scan raw files from all sources
  const rawFiles: RawWorkflowFile[] = [];
  for (const storage of storageChain) {
    const sourceKind = storage.source.kind;
    const sourceRef = deriveSourceRef(storage.source);
    
    // Call shared findWorkflowJsonFiles function
    const files = await findWorkflowJsonFiles(storage.source);
    
    for (const file of files) {
      rawFiles.push({
        filePath: file.path,
        sourceKind,
        sourceRef,
        workflow: await parseWorkflowFile(file.path),
      });
    }
  }
  
  // Step 2: Build candidates (per source, with variant selection)
  const candidates: WorkflowCandidate[] = [];
  for (const storage of storageChain) {
    const workflows = await storage.loadAllWorkflows();
    const sourceKind = storage.source.kind;
    const sourceRef = deriveSourceRef(storage.source);
    
    for (const workflow of workflows) {
      candidates.push({
        id: workflow.id,
        workflow,
        sourceKind,
        sourceRef,
        variantKind: deriveVariantKind(workflow, featureFlags),
      });
    }
  }
  
  // Step 3: Resolve across sources using shared resolveWorkflowCandidates function
  const resolvedResult = resolveWorkflowCandidates(candidates);
  
  const resolved: ResolvedWorkflow[] = resolvedResult.resolved.map(c => ({
    ...c,
    resolvedBy: deriveResolvedBy(c, candidates),
  }));
  
  const duplicates: DuplicateIdReport[] = resolvedResult.duplicates.map(d => ({
    workflowId: d.id,
    candidates: d.candidates.map(c => ({
      sourceKind: c.sourceKind,
      sourceRef: c.sourceRef,
      variantKind: c.variantKind,
    })),
    resolved: {
      sourceKind: d.resolved.sourceKind,
      sourceRef: d.resolved.sourceRef,
      variantKind: d.resolved.variantKind,
    },
  }));
  
  return { variant: variantName, rawFiles, candidates, resolved, duplicates };
}

// Helper: derive resolvedBy heuristic (approximation)
function deriveResolvedBy(
  resolved: WorkflowCandidate,
  allCandidates: readonly WorkflowCandidate[]
): 'source_priority' | 'variant_priority' | 'only_candidate' {
  const sameIdCandidates = allCandidates.filter(c => c.id === resolved.id);
  
  if (sameIdCandidates.length === 1) {
    return 'only_candidate';
  }
  
  const sameSourceCandidates = sameIdCandidates.filter(c => c.sourceKind === resolved.sourceKind);
  if (sameSourceCandidates.length > 1) {
    return 'variant_priority'; // Multiple candidates in same source → variant resolution
  }
  
  return 'source_priority'; // Multiple candidates across sources → source priority resolution
}

function deriveSourceRef(source: WorkflowSource): string {
  switch (source.kind) {
    case 'bundled': return '(bundled)';
    case 'user': return source.directoryPath;
    case 'project': return source.directoryPath;
    case 'custom': return source.directoryPath;
    case 'git': return `${source.repositoryUrl}#${source.branch}`;
    case 'remote': return source.registryUrl;
    case 'plugin': return `${source.pluginName}@${source.pluginVersion}`;
  }
}

function deriveVariantKind(
  workflow: Workflow,
  flags: { v2Tools: boolean; agenticRoutines: boolean }
): 'standard' | 'agentic' | 'v2' | 'agentic+v2' {
  const isV2 = workflow.id.includes('.v2.') && flags.v2Tools;
  const isAgentic = workflow.id.includes('.agentic.') && flags.agenticRoutines;
  
  if (isV2 && isAgentic) return 'agentic+v2';
  if (isV2) return 'v2';
  if (isAgentic) return 'agentic';
  return 'standard';
}
```

### New File: `src/application/use-cases/registry-validation/resolve-workflow-candidates.ts`

```typescript
/**
 * Shared pure function for cross-source workflow resolution.
 * 
 * Extracted from EnhancedMultiSourceWorkflowStorage.loadAllWorkflows().
 * Used by:
 * - Runtime (EnhancedMultiSourceWorkflowStorage)
 * - Registry snapshot builder (Phase 2)
 */
export function resolveWorkflowCandidates(
  candidates: readonly WorkflowCandidate[]
): {
  readonly resolved: readonly WorkflowCandidate[];
  readonly duplicates: readonly { readonly id: string; readonly candidates: readonly WorkflowCandidate[]; readonly resolved: WorkflowCandidate };
} {
  // Group by ID
  const candidatesByI = new Map<string, WorkflowCandidate[]>();
  for (const candidate of candidates) {
    const existing = candidatesByI.get(candidate.id) ?? [];
    existing.push(candidate);
    candidatesByI.set(candidate.id, existing);
  }
  
  const resolved: WorkflowCandidate[] = [];
  const duplicates: { id: string; candidates: WorkflowCandidate[]; resolved: WorkflowCandidate }[] = [];
  
  for (const [id, idCandidates] of candidatesByI) {
    if (idCandidates.length === 1) {
      resolved.push(idCandidates[0]);
      continue;
    }
    
    // Duplicate detected: apply source priority
    const sourcePriority = ['bundled', 'plugin', 'user', 'custom', 'git', 'remote', 'project'];
    const sorted = [...idCandidates].sort((a, b) => {
      const aIdx = sourcePriority.indexOf(a.sourceKind);
      const bIdx = sourcePriority.indexOf(b.sourceKind);
      return aIdx - bIdx;
    });
    
    const winner = sorted[0];
    resolved.push(winner);
    duplicates.push({ id, candidates: idCandidates, resolved: winner });
  }
  
  return { resolved, duplicates };
}
```

### New File: `src/application/use-cases/registry-validation/find-workflow-json-files.ts`

```typescript
/**
 * Shared pure function for recursive workflow JSON file discovery.
 * 
 * Extracted from FileWorkflowStorage.findJsonFiles().
 * Used by:
 * - Runtime (FileWorkflowStorage)
 * - Raw file scanner (Phase 2)
 */
export async function findWorkflowJsonFiles(source: WorkflowSource): Promise<readonly { path: string }[]> {
  // Implementation: recursive fs.readdir, filter *.json, skip examples/
  // This is the exact logic from FileWorkflowStorage.findJsonFiles() extracted
  // ...
}
```

---

This is getting long. Should I continue with Phase 2's validation report types and the rest of the phases, or would you like me to split this into multiple design docs (one per phase)?

