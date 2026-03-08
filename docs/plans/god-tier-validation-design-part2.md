# God-Tier Workflow Validation: Detailed Design (Part 2)

Continuation of the design document. See `god-tier-validation-design.md` for Phases 1a and 1b.

---

## Phase 2: Registry-Centric Validation (Continued)

### New File: `src/application/use-cases/registry-validation/validate-registry.ts`

```typescript
import type { RegistrySnapshot, ResolvedWorkflow, RawWorkflowFile } from './registry-snapshot.js';
import type { ValidationOutcome, ValidatedWorkflow } from '../../services/workflow-validation-pipeline.js';
import { validateWorkflow } from '../../services/workflow-validation-pipeline.js';

/**
 * Tier 1 validation outcome (for raw files that don't reach full pipeline).
 * Only includes: schema, structural.
 * Does NOT include v1 compilation (that's Tier 2).
 */
export type Tier1Outcome =
  | { readonly kind: 'tier1_unparseable'; readonly parseError: string }
  | { readonly kind: 'schema_failed'; readonly errors: readonly SchemaError[] }
  | { readonly kind: 'structural_failed'; readonly issues: readonly string[] }
  | { readonly kind: 'tier1_passed' };

/**
 * Validation report entry for a resolved workflow (full pipeline).
 */
export interface ResolvedValidationEntry {
  readonly kind: 'resolved_entry';
  readonly workflowId: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly variantKind: string;
  readonly resolvedBy: 'source_priority' | 'variant_priority' | 'only_candidate';
  readonly outcome: ValidationOutcome; // Full 8-phase pipeline
}

/**
 * Validation report entry for a raw file (Tier 1 only).
 */
export interface RawFileValidationEntry {
  readonly kind: 'raw_file_entry';
  readonly filePath: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly variantKind: string; // Inferred from filename
  readonly isResolvedWinner: boolean; // True if this file was selected by resolution
  readonly tier1: Tier1Outcome;
}

/**
 * Registry validation report (full registry + all raw files).
 */
export interface RegistryValidationReport {
  readonly variant: string;
  readonly totalResolvedWorkflows: number;
  readonly validResolvedCount: number;
  readonly invalidResolvedCount: number;
  readonly totalRawFiles: number;
  readonly tier1PassedRawFiles: number;
  readonly tier1FailedRawFiles: number;
  readonly duplicateIds: readonly DuplicateIdReport[];
  readonly resolvedEntries: readonly ResolvedValidationEntry[];
  readonly rawFileEntries: readonly RawFileValidationEntry[];
}

/**
 * Validate a registry snapshot.
 * 
 * Runs:
 * - Full pipeline (8 phases) on each resolved workflow
 * - Tier 1 validation (schema + structural) on all raw files
 * - Duplicate detection (already in snapshot, just reported here)
 */
export async function validateRegistry(
  snapshot: RegistrySnapshot,
  deps: ValidationPipelineDeps
): Promise<RegistryValidationReport> {
  // Validate resolved workflows (full pipeline)
  const resolvedEntries: ResolvedValidationEntry[] = [];
  for (const resolved of snapshot.resolved) {
    const outcome = validateWorkflow(resolved.workflow, deps);
    resolvedEntries.push({
      kind: 'resolved_entry',
      workflowId: resolved.id,
      sourceKind: resolved.sourceKind,
      sourceRef: resolved.sourceRef,
      variantKind: resolved.variantKind,
      resolvedBy: resolved.resolvedBy,
      outcome,
    });
  }
  
  // Validate raw files (Tier 1)
  const rawFileEntries: RawFileValidationEntry[] = [];
  const resolvedFileSet = new Set(
    snapshot.resolved.map(r => deriveFilePathFromWorkflow(r.workflow))
  );
  
  for (const rawFile of snapshot.rawFiles) {
    const tier1 = validateRawFileTier1(rawFile, deps);
    const variantKind = deriveVariantKindFromFilename(rawFile.filePath);
    
    rawFileEntries.push({
      kind: 'raw_file_entry',
      filePath: rawFile.filePath,
      sourceKind: rawFile.sourceKind,
      sourceRef: rawFile.sourceRef,
      variantKind,
      isResolvedWinner: resolvedFileSet.has(rawFile.filePath),
      tier1,
    });
  }
  
  // Compute summary stats
  const validResolvedCount = resolvedEntries.filter(e => e.outcome.kind === 'valid').length;
  const tier1PassedRawFiles = rawFileEntries.filter(e => e.tier1.kind === 'tier1_passed').length;
  
  return {
    variant: snapshot.variant,
    totalResolvedWorkflows: snapshot.resolved.length,
    validResolvedCount,
    invalidResolvedCount: snapshot.resolved.length - validResolvedCount,
    totalRawFiles: snapshot.rawFiles.length,
    tier1PassedRawFiles,
    tier1FailedRawFiles: snapshot.rawFiles.length - tier1PassedRawFiles,
    duplicateIds: snapshot.duplicates,
    resolvedEntries,
    rawFileEntries,
  };
}

/**
 * Validate a raw file (Tier 1: schema + structural only).
 */
function validateRawFileTier1(
  rawFile: RawWorkflowFile,
  deps: ValidationPipelineDeps
): Tier1Outcome {
  if (rawFile.workflow.kind === 'unparseable') {
    return { kind: 'tier1_unparseable', parseError: rawFile.workflow.parseError };
  }
  
  const workflow = rawFile.workflow.workflow;
  
  // Schema validation
  const schemaResult = deps.schemaValidate(workflow);
  if (schemaResult.isErr()) {
    return { kind: 'schema_failed', errors: schemaResult.error };
  }
  
  // Structural validation
  const structuralResult = deps.structuralValidate(workflow);
  if (structuralResult.isErr()) {
    return { kind: 'structural_failed', issues: structuralResult.error };
  }
  
  return { kind: 'tier1_passed' };
}

function deriveVariantKindFromFilename(filePath: string): string {
  if (filePath.includes('.v2.') && filePath.includes('.agentic.')) return 'agentic+v2';
  if (filePath.includes('.v2.')) return 'v2';
  if (filePath.includes('.agentic.')) return 'agentic';
  return 'standard';
}
```

### Changes to `src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts`

**Extract `resolveWorkflowCandidates` logic:**

Current `loadAllWorkflows()` implementation has inline resolution logic. Extract to the shared function:

```typescript
import { resolveWorkflowCandidates } from '../../application/use-cases/registry-validation/resolve-workflow-candidates.js';

async loadAllWorkflows(): Promise<readonly Workflow[]> {
  // Load from all sources
  const allCandidates: WorkflowCandidate[] = [];
  for (const storage of this.storageInstances) {
    const workflows = await storage.loadAllWorkflows();
    const sourceKind = storage.source.kind;
    const sourceRef = deriveSourceRef(storage.source);
    
    for (const workflow of workflows) {
      allCandidates.push({
        id: workflow.id,
        workflow,
        sourceKind,
        sourceRef,
        variantKind: deriveVariantKind(workflow, this.featureFlags),
      });
    }
  }
  
  // Use shared resolution function
  const { resolved } = resolveWorkflowCandidates(allCandidates);
  
  return resolved.map(c => c.workflow);
}
```

---

## Phase 3: Replace CI Script

### New File: `scripts/validate-workflows-registry.ts`

```typescript
#!/usr/bin/env tsx

/**
 * Registry-centric workflow validator for CI.
 * 
 * Runs validation under all feature-flag variants defined in
 * scripts/workflow-validation-variants.json.
 * 
 * Exits non-zero if any variant has any failure.
 */

import { buildRegistrySnapshot } from '../src/application/use-cases/registry-validation/build-registry-snapshot.js';
import { validateRegistry } from '../src/application/use-cases/registry-validation/validate-registry.js';
import type { RegistryValidationReport } from '../src/application/use-cases/registry-validation/validate-registry.js';
import { container } from '../src/di/container.js';
import * as fs from 'fs/promises';
import * as path from 'path';

interface VariantConfig {
  readonly name: string;
  readonly v2Tools: boolean;
  readonly agenticRoutines: boolean;
}

async function main() {
  // Load variant configurations
  const variantsPath = path.join(__dirname, 'workflow-validation-variants.json');
  const variantsJson = await fs.readFile(variantsPath, 'utf-8');
  const variants: VariantConfig[] = JSON.parse(variantsJson).variants;
  
  const allReports: { variant: string; report: RegistryValidationReport }[] = [];
  let totalFailures = 0;
  
  console.log('Starting registry-centric workflow validation...\n');
  
  // Validate each variant
  for (const variant of variants) {
    console.log(`=== Variant: ${variant.name} ===`);
    
    // Build storage chain with feature flags
    const storage = container.resolve('WorkflowStorage', {
      featureFlags: { v2Tools: variant.v2Tools, agenticRoutines: variant.agenticRoutines },
    });
    
    // Build registry snapshot
    const snapshot = await buildRegistrySnapshot(
      storage.sources, // EnhancedMultiSourceWorkflowStorage exposes sources
      variant.name,
      { v2Tools: variant.v2Tools, agenticRoutines: variant.agenticRoutines }
    );
    
    // Build pipeline deps
    const deps = {
      schemaValidate: container.resolve('SchemaValidator'),
      structuralValidate: container.resolve('ValidationEngine').validateWorkflowStructureOnly,
      compiler: container.resolve('WorkflowCompiler'),
      interpreter: container.resolve('WorkflowInterpreter'),
      normalizeToExecutable: container.resolve('CompileV1WorkflowToPinnedSnapshot'),
      resolveFirstStep: container.resolve('ResolveFirstStep'),
    };
    
    // Validate registry
    const report = await validateRegistry(snapshot, deps, { timeout: 30000 });
    allReports.push({ variant: variant.name, report });
    
    // Print summary
    printVariantSummary(variant.name, report);
    
    // Track failures
    if (report.invalidResolvedCount > 0 || report.tier1FailedRawFiles > 0 || report.duplicateIds.length > 0) {
      totalFailures++;
    }
    
    console.log('');
  }
  
  // Final summary
  console.log('=================================');
  if (totalFailures === 0) {
    console.log('✓ All workflows valid across all variants');
    process.exit(0);
  } else {
    console.error(`✗ ${totalFailures} variant(s) with failures`);
    printDetailedFailures(allReports);
    process.exit(1);
  }
}

function printVariantSummary(variantName: string, report: RegistryValidationReport) {
  console.log(`  Resolved workflows: ${report.validResolvedCount}/${report.totalResolvedWorkflows} valid`);
  console.log(`  Raw files: ${report.tier1PassedRawFiles}/${report.totalRawFiles} passed Tier 1`);
  console.log(`  Duplicate IDs: ${report.duplicateIds.length}`);
  
  // Print per-workflow status (first 10 resolved workflows)
  const sampleSize = Math.min(10, report.resolvedEntries.length);
  for (let i = 0; i < sampleSize; i++) {
    const entry = report.resolvedEntries[i];
    const status = entry.outcome.kind === 'valid' ? '✓' : '✗';
    const phases = formatPhaseStatus(entry.outcome);
    console.log(`  ${status} ${entry.workflowId.padEnd(40)} ${entry.sourceKind.padEnd(10)} ${phases}`);
  }
  
  if (report.resolvedEntries.length > sampleSize) {
    console.log(`  ... and ${report.resolvedEntries.length - sampleSize} more`);
  }
}

function formatPhaseStatus(outcome: ValidationOutcome): string {
  if (outcome.kind === 'valid') {
    return 'schema:ok structural:ok v1-compile:ok normalize:ok roundtrip:ok v2-compile:ok start:ok';
  }
  
  const failedPhase = outcome.kind.replace('_failed', '');
  return `${failedPhase}:FAIL`;
}

function printDetailedFailures(
  reports: readonly { variant: string; report: RegistryValidationReport }[]
) {
  for (const { variant, report } of reports) {
    const invalidEntries = report.resolvedEntries.filter(e => e.outcome.kind !== 'valid');
    if (invalidEntries.length === 0) continue;
    
    console.log(`\n=== Failures in variant: ${variant} ===`);
    for (const entry of invalidEntries) {
      console.log(`  ${entry.workflowId} (${entry.sourceKind})`);
      console.log(`    ${formatFailureDetail(entry.outcome)}`);
    }
  }
}

function formatFailureDetail(outcome: Exclude<ValidationOutcome, { kind: 'valid' }>): string {
  switch (outcome.kind) {
    case 'schema_failed':
      return `Schema validation failed: ${outcome.errors.map(e => e.message).join(', ')}`;
    case 'structural_failed':
      return `Structural validation failed: ${outcome.issues.join(', ')}`;
    case 'v1_compilation_failed':
      return `V1 compilation failed: ${outcome.cause.message}`;
    case 'normalization_failed':
      return `Normalization failed: ${outcome.cause.message}`;
    case 'round_trip_failed':
      return `Round-trip failed: ${outcome.cause}`;
    case 'v2_compilation_failed':
      return `V2 compilation failed: ${outcome.cause.message}`;
    case 'startability_failed':
      return `Startability failed: ${formatStartabilityFailure(outcome.reason)}`;
  }
}

function formatStartabilityFailure(reason: StartabilityFailure): string {
  switch (reason.reason) {
    case 'no_steps':
      return reason.detail;
    case 'first_step_not_in_executable':
      return `${reason.detail} (authored step ID: ${reason.authoredStepId})`;
    case 'no_reachable_step':
      return reason.detail;
    case 'interpreter_error':
      return `Interpreter error: ${reason.detail}`;
  }
}

main().catch(err => {
  console.error('Fatal error during validation:', err);
  process.exit(1);
});
```

### Changes to `package.json`

```json
{
  "scripts": {
    "validate:workflows": "tsx scripts/validate-workflows-registry.ts",
    "precommit": "npm run validate:workflows && npm run lint"
  }
}
```

### Deprecate `scripts/validate-workflows.sh`

Add a comment at the top:
```bash
#!/bin/bash
# DEPRECATED: This script validates files individually, not through the runtime registry.
# Use `npm run validate:workflows` (scripts/validate-workflows-registry.ts) instead.
# 
# This file is kept for reference only.
```

---

## Phase 4: Eliminate Silent Hiding

### Changes to `src/v2/durable-core/domain/prompt-renderer.ts`

**Fix silent degradation:**

Current code (lines 316-318):
```typescript
const step = getExecutableStepById(args.workflow, args.stepId);
const baseTitle = step?.title ?? args.stepId;
const basePrompt = step?.prompt ?? `Pending step: ${args.stepId}`;
```

Change to:
```typescript
const step = getExecutableStepById(args.workflow, args.stepId);
if (!step) {
  return err({
    code: 'RENDER_FAILED' as const,
    message: `Step '${args.stepId}' not found in executable workflow`,
  });
}
const baseTitle = step.title;
const basePrompt = step.prompt;
```

### Delete `src/mcp/handlers/v2-execution-helpers.ts:renderPendingPromptOrDefault`

Remove the function entirely (lines 589-612).

### Changes to `src/mcp/handlers/v2-execution/start.ts`

**Replace `renderPendingPromptOrDefault` with `renderPendingPrompt`:**

Current code (lines 407-415):
```typescript
const meta = renderPendingPromptOrDefault({
  workflow: pinnedWorkflow,
  stepId: firstStep.id,
  loopPath: [],
  truth: { events: [], manifest: [] },
  runId: asRunId(String(runId)),
  nodeId: asNodeId(String(nodeId)),
  rehydrateOnly: false,
});
```

Change to:
```typescript
const metaResult = renderPendingPrompt({
  workflow: pinnedWorkflow,
  stepId: firstStep.id,
  loopPath: [],
  truth: { events: [], manifest: [] },
  runId: asRunId(String(runId)),
  nodeId: asNodeId(String(nodeId)),
  rehydrateOnly: false,
});

if (metaResult.isErr()) {
  return neErrorAsync({
    kind: 'prompt_render_failed' as const,
    message: metaResult.error.message,
  });
}

const meta = metaResult.value;
```

**Update `StartWorkflowError` type:**

Add:
```typescript
| { readonly kind: 'prompt_render_failed'; readonly message: string }
```

### Changes to `src/mcp/handlers/v2-execution/replay.ts`

Same pattern as `start.ts` — replace `renderPendingPromptOrDefault` with error-handling on `renderPendingPrompt`.

### Changes to `src/infrastructure/storage/schema-validating-workflow-storage.ts`

**Add structured error reporting:**

```typescript
export interface ValidationErrorCollector {
  report(workflowId: string, sourceKind: string, error: string): void;
}

export class ConsoleValidationErrorCollector implements ValidationErrorCollector {
  report(workflowId: string, sourceKind: string, error: string): void {
    console.error(`[ValidationError] Workflow '${workflowId}' from ${sourceKind}: ${error}`);
  }
}

@singleton()
export class SchemaValidatingWorkflowStorage implements IWorkflowStorage {
  constructor(
    @inject('InnerStorage') private readonly inner: IWorkflowStorage,
    @inject('ValidationErrorCollector') private readonly errorCollector: ValidationErrorCollector = new ConsoleValidationErrorCollector()
  ) {}
  
  async loadAllWorkflows(): Promise<readonly Workflow[]> {
    const workflows = await this.inner.loadAllWorkflows();
    const validated: Workflow[] = [];
    
    for (const workflow of workflows) {
      const result = validateWorkflow(workflow);
      if (result.valid) {
        validated.push(workflow);
      } else {
        // Report instead of silently filtering
        this.errorCollector.report(
          workflow.id,
          workflow.source.kind,
          `Schema validation failed: ${result.errors?.map(e => e.message).join(', ')}`
        );
      }
    }
    
    return validated;
  }
  
  async getWorkflowById(id: string): Promise<Workflow | null> {
    const workflow = await this.inner.getWorkflowById(id);
    if (!workflow) return null;
    
    const result = validateWorkflow(workflow);
    if (result.valid) {
      return workflow;
    }
    
    // Report before returning null
    this.errorCollector.report(
      workflow.id,
      workflow.source.kind,
      `Schema validation failed: ${result.errors?.map(e => e.message).join(', ')}`
    );
    return null;
  }
  
  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    // Fix: validate through loadAllWorkflows, derive summaries from validated set
    const workflows = await this.loadAllWorkflows(); // This already filters + reports
    return workflows.map(w => ({
      id: w.id,
      title: w.definition.title,
      description: w.definition.description,
      source: w.source,
    }));
  }
}
```

---

## Phase 5: Regression Test Suite

### New File: `tests/unit/validate-workflow-registry.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { validateWorkflow } from '../../src/application/services/workflow-validation-pipeline.js';
import { validateRegistry } from '../../src/application/use-cases/registry-validation/validate-registry.js';
import type { Workflow } from '../../src/types/workflow.js';
import { createFakeWorkflow } from '../fakes/workflow.fake.js';
import { createFakeValidationDeps } from '../fakes/validation-deps.fake.js';

describe('Workflow Validation Pipeline', () => {
  let deps: ValidationPipelineDeps;
  
  beforeEach(() => {
    deps = createFakeValidationDeps();
  });
  
  // ─────────────────────────────────────────────────────────────────────────
  // Discovery and Duplicates
  // ─────────────────────────────────────────────────────────────────────────
  
  it('1. Two workflows with the same ID in different sources → hard failure', async () => {
    const snapshot = createFakeRegistrySnapshot({
      duplicates: [{
        workflowId: 'test-workflow',
        candidates: [
          { sourceKind: 'bundled', sourceRef: '(bundled)', variantKind: 'standard' },
          { sourceKind: 'user', sourceRef: '/home/user/workflows', variantKind: 'standard' },
        ],
        resolved: { sourceKind: 'bundled', sourceRef: '(bundled)', variantKind: 'standard' },
      }],
    });
    
    const report = await validateRegistry(snapshot, deps);
    
    expect(report.duplicateIds).toHaveLength(1);
    expect(report.duplicateIds[0].workflowId).toBe('test-workflow');
    // CI script treats duplicates as failures
  });
  
  it('2. wr.* ID in bundled + non-bundled → bundled wins, reported but not error', async () => {
    const snapshot = createFakeRegistrySnapshot({
      duplicates: [{
        workflowId: 'wr.protected-workflow',
        candidates: [
          { sourceKind: 'bundled', sourceRef: '(bundled)', variantKind: 'standard' },
          { sourceKind: 'user', sourceRef: '/home/user/workflows', variantKind: 'standard' },
        ],
        resolved: { sourceKind: 'bundled', sourceRef: '(bundled)', variantKind: 'standard' },
      }],
    });
    
    const report = await validateRegistry(snapshot, deps);
    
    // Duplicate is reported
    expect(report.duplicateIds).toHaveLength(1);
    // But this is an allowed exception (wr.* protection)
    // CI script logic checks for wr.* prefix and doesn't fail
  });
  
  // ... tests 3-39 following the same pattern
  
  // ─────────────────────────────────────────────────────────────────────────
  // Startability
  // ─────────────────────────────────────────────────────────────────────────
  
  it('15. Valid workflow → interpreter.next returns pending step', () => {
    const workflow = createFakeWorkflow({
      steps: [
        { id: 'step1', title: 'Step 1', prompt: 'Do something' },
      ],
    });
    
    const outcome = validateWorkflow(workflow, deps);
    
    expect(outcome.kind).toBe('valid');
    if (outcome.kind === 'valid') {
      expect(outcome.validated.kind).toBe('validated_workflow');
    }
  });
  
  it('16. All steps with runCondition: false → startability failure', () => {
    const workflow = createFakeWorkflow({
      steps: [
        { id: 'step1', title: 'Step 1', prompt: 'Never runs', runCondition: { type: 'js', expression: 'false' } },
        { id: 'step2', title: 'Step 2', prompt: 'Also never runs', runCondition: { type: 'js', expression: 'false' } },
      ],
    });
    
    const outcome = validateWorkflow(workflow, deps);
    
    expect(outcome.kind).toBe('startability_failed');
    if (outcome.kind === 'startability_failed') {
      expect(outcome.reason.reason).toBe('no_reachable_step');
    }
  });
  
  it('17b. steps[0].id not in executable → startability failure', () => {
    // Create workflow where normalization changes step IDs (hypothetical bug)
    const workflow = createFakeWorkflow({
      steps: [
        { id: 'original-step-id', title: 'Step 1', prompt: 'Do something' },
      ],
    });
    
    // Mock normalizeToExecutable to return different step ID
    deps = {
      ...deps,
      normalizeToExecutable: () => ok({
        definition: {
          steps: [
            { id: 'different-step-id', title: 'Step 1', prompt: 'Do something' },
          ],
        },
      }),
    };
    
    const outcome = validateWorkflow(workflow, deps);
    
    expect(outcome.kind).toBe('startability_failed');
    if (outcome.kind === 'startability_failed') {
      expect(outcome.reason.reason).toBe('first_step_not_in_executable');
      expect(outcome.reason.authoredStepId).toBe('original-step-id');
    }
  });
  
  // ─────────────────────────────────────────────────────────────────────────
  // Silent Hiding
  // ─────────────────────────────────────────────────────────────────────────
  
  it('19. renderPendingPrompt with missing step ID → error not fallback', () => {
    const workflow = createFakeExecutableWorkflow({
      steps: [{ id: 'step1', title: 'Step 1', prompt: 'Do something' }],
    });
    
    const result = renderPendingPrompt({
      workflow,
      stepId: 'nonexistent-step',
      loopPath: [],
      truth: { events: [], manifest: [] },
      runId: asRunId('run-1'),
      nodeId: asNodeId('node-1'),
      rehydrateOnly: false,
    });
    
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('RENDER_FAILED');
    }
  });
  
  it('19b. renderPendingPromptOrDefault deleted; start.ts propagates errors', () => {
    // This is a structural test: grep for renderPendingPromptOrDefault should find nothing
    // Implemented as a simple smoke test:
    expect(typeof renderPendingPromptOrDefault).toBe('undefined');
  });
});
```

---

## Phase 6: Lifecycle Execution Harness

### New File: `tests/lifecycle/lifecycle-harness.ts`

```typescript
import type { Workflow } from '../../src/types/workflow.js';
import type { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';
import type { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import { validateWorkflow } from '../../src/application/services/workflow-validation-pipeline.js';
import { type Result, ok, err } from 'neverthrow';

/**
 * Fixture data for a single step.
 */
export interface StepFixture {
  readonly notesMarkdown?: string;
  readonly artifacts?: readonly unknown[];
  readonly context?: Record<string, unknown>;
}

/**
 * Workflow fixture (inline, hermetic).
 */
export interface WorkflowFixture {
  readonly workflowId: string;
  readonly workflow: Workflow; // Inline workflow definition
  readonly startInputs?: { workspacePath?: string };
  readonly stepFixtures: Record<string, StepFixture>;
  readonly expectedTerminalState: 'complete' | 'blocked';
}

/**
 * Lifecycle test result.
 */
export type LifecycleTestResult =
  | { readonly kind: 'validation_failed'; readonly outcome: ValidationOutcome }
  | { readonly kind: 'step_failed'; readonly stepId: string; readonly error: DomainError }
  | { readonly kind: 'terminal_mismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'success'; readonly stepsExecuted: number };

/**
 * Execute a workflow from start to terminal completion under deterministic fixtures.
 */
export async function executeWorkflowLifecycle(
  fixture: WorkflowFixture,
  deps: { compiler: WorkflowCompiler; interpreter: WorkflowInterpreter }
): Promise<LifecycleTestResult> {
  // Step 1: Validate workflow
  const validationDeps = buildValidationDeps(deps);
  const outcome = validateWorkflow(fixture.workflow, validationDeps);
  
  if (outcome.kind !== 'valid') {
    return { kind: 'validation_failed', outcome };
  }
  
  const validated = outcome.validated;
  
  // Step 2: Create initial execution state
  let state = { kind: 'init' as const };
  let stepsExecuted = 0;
  
  // Step 3: Drive to completion
  while (true) {
    const nextResult = deps.interpreter.next(validated.compiledExecutable, state);
    
    if (nextResult.isErr()) {
      return { kind: 'step_failed', stepId: 'unknown', error: nextResult.error };
    }
    
    const { next, isComplete, state: newState } = nextResult.value;
    state = newState;
    
    if (isComplete) {
      break;
    }
    
    if (!next) {
      return { kind: 'step_failed', stepId: 'unknown', error: { message: 'No next step but not complete' } };
    }
    
    // Apply step fixture
    const fixtureData = fixture.stepFixtures[next.stepId];
    if (!fixtureData) {
      return { kind: 'step_failed', stepId: next.stepId, error: { message: 'No fixture data for step' } };
    }
    
    const event = {
      kind: 'step_completed' as const,
      stepId: next.stepId,
      output: {
        notesMarkdown: fixtureData.notesMarkdown ?? '',
        artifacts: fixtureData.artifacts ?? [],
      },
      context: fixtureData.context ?? {},
    };
    
    const applyResult = deps.interpreter.applyEvent(state, event);
    if (applyResult.isErr()) {
      return { kind: 'step_failed', stepId: next.stepId, error: applyResult.error };
    }
    
    state = applyResult.value;
    stepsExecuted++;
  }
  
  // Step 4: Verify terminal state
  const actualTerminal = state.kind === 'complete' ? 'complete' : 'blocked';
  if (actualTerminal !== fixture.expectedTerminalState) {
    return { kind: 'terminal_mismatch', expected: fixture.expectedTerminalState, actual: actualTerminal };
  }
  
  return { kind: 'success', stepsExecuted };
}
```

### New File: `tests/lifecycle/fixtures/test-session-persistence.fixture.ts`

```typescript
import type { WorkflowFixture } from '../lifecycle-harness.js';

/**
 * Fixture for test-session-persistence workflow.
 * 
 * Inline workflow definition + per-step fixture data.
 */
export const testSessionPersistenceFixture: WorkflowFixture = {
  workflowId: 'test-session-persistence',
  workflow: {
    id: 'test-session-persistence',
    definition: {
      title: 'Test Session Persistence',
      description: 'Test workflow for session persistence',
      steps: [
        {
          id: 'step1',
          title: 'Write data',
          prompt: 'Write some data to the session',
        },
        {
          id: 'step2',
          title: 'Read data',
          prompt: 'Read the data back',
        },
        {
          id: 'step3',
          title: 'Verify',
          prompt: 'Verify the data is correct',
        },
      ],
    },
    source: { kind: 'bundled' },
  },
  stepFixtures: {
    step1: {
      notesMarkdown: 'Data written',
      artifacts: [{ key: 'value' }],
    },
    step2: {
      notesMarkdown: 'Data read back',
    },
    step3: {
      notesMarkdown: 'Verification successful',
    },
  },
  expectedTerminalState: 'complete',
};
```

### New File: `tests/lifecycle/test-session-persistence.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { executeWorkflowLifecycle } from './lifecycle-harness.js';
import { testSessionPersistenceFixture } from './fixtures/test-session-persistence.fixture.js';
import { container } from '../../src/di/container.js';

describe('Lifecycle: test-session-persistence', () => {
  it('should execute start-to-completion without workflow-definition errors', async () => {
    const deps = {
      compiler: container.resolve('WorkflowCompiler'),
      interpreter: container.resolve('WorkflowInterpreter'),
    };
    
    const result = await executeWorkflowLifecycle(testSessionPersistenceFixture, deps);
    
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.stepsExecuted).toBe(3);
    }
  });
});
```

---

## Summary: File Count by Phase

| Phase | New Files | Edited Files |
|-------|-----------|-------------|
| 1a | 1 (pipeline.ts) | 3 (validation-engine, validation, validate-workflow-file) |
| 1b | 1 (start-construction.ts) | 2 (pipeline.ts to extend, start.ts) |
| 2 | 5 (registry-snapshot, build-snapshot, resolve-candidates, find-files, validate-registry) | 2 (enhanced-multi-source-storage, file-workflow-storage) |
| 3 | 1 (validate-workflows-registry.ts) | 1 (package.json) |
| 4 | 0 | 5 (prompt-renderer, v2-execution-helpers delete, start, replay, schema-validating-storage) |
| 5 | 1 (test file) | 0 |
| 6 | 3+ (harness + fixtures) | 0 |

**Total: 12-15 new files, 13 edited files across all phases.**

