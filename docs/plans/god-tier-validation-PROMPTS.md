# God-Tier Validation: Ready-to-Use WorkRail Subagent Prompts

This file contains copy-paste ready prompts for each implementation stage. Use these with the WorkRail subagent.

---

## How to Use These Prompts

1. Copy the entire prompt for a stage
2. Invoke the WorkRail subagent:
   ```
   Use the task tool with subagent_type: "workrail-executor"
   ```
3. Paste the prompt in the `prompt` parameter
4. Wait for completion
5. Verify the deliverables
6. Proceed to next stage

---

## Stage 1a: Pipeline Skeleton

```
Implement Phase 1a of god-tier workflow validation: Pipeline Skeleton.

CONTEXT:
- Read docs/plans/god-tier-validation-implementation-plan.md (Phase 1 section, lines 309-400)
- Read docs/plans/god-tier-validation-design.md (Phase 1a design, lines 1-200)
- Read docs/plans/god-tier-validation-INSTRUCTIONS.md (Stage 1a section)
- This is checkpoint #1: consolidation only, no new validation logic

DELIVERABLES:
1. New file: src/application/services/workflow-validation-pipeline.ts
   - Copy ValidationOutcomePhase1a type from design doc (lines 25-33)
   - Copy ValidationPipelineDepsPhase1a interface (lines 50-72)
   - Implement validateWorkflowPhase1a() function (lines 82-115)
   - The function runs 4 phases: schema → structural → v1 compilation → normalization
   - Short-circuits on first failure
   - Returns discriminated union outcome

2. Edit: src/application/services/validation-engine.ts
   - Find validateWorkflow() method (around line 674)
   - Extract the compileV1WorkflowToPinnedSnapshot call (currently at lines 763+)
   - Add new method: validateWorkflowStructureOnly(workflow: Workflow): Result<Workflow, string[]>
   - Keep all existing structural checks (they're correct, just remove normalization)

3. Edit: src/application/validation.ts
   - Add validateWorkflowSchema() function that wraps existing AJV validator
   - Returns Result<Workflow, SchemaError[]>
   - See design doc lines 130-150 for exact signature

4. Edit: src/application/use-cases/validate-workflow-file.ts
   - Rewire to call validateWorkflowPhase1a() instead of existing validator
   - Build ValidationPipelineDepsPhase1a from DI container
   - Map ValidationOutcomePhase1a to existing ValidationResult type
   - For now, all pipeline failures map to single 'pipeline_invalid' message
   - See design doc lines 152-180 for pattern

5. Edit: src/application/use-cases/validate-workflow-json.ts
   - Same rewiring as validate-workflow-file.ts

ACCEPTANCE CRITERIA:
- npm test passes (all existing validation tests work through new pipeline)
- CLI command `workrail validate <file>` uses the new pipeline
- MCP tool `validate_workflow_json` uses the new pipeline
- No behavior change: same workflows pass/fail as before (consolidation, not new logic)

IMPLEMENTATION NOTES:
- Use neverthrow Result types throughout (ok(), err(), andThen())
- Follow discriminated union pattern (all types have 'kind' field)
- All dependencies injected through ValidationPipelineDepsPhase1a
- Copy exact type signatures from design doc - do not modify them

When complete:
1. Run npm test to verify all tests pass
2. Create git commit with message:
   "Phase 1a: Consolidate validation into pipeline skeleton
   
   - Created workflow-validation-pipeline.ts with 4-phase pipeline
   - Extracted normalization from ValidationEngine
   - Rewired CLI and MCP validators to use pipeline
   - All existing tests pass (consolidation, no new logic)"
```

---

## Stage 1b: Full Pipeline

```
Implement Phase 1b of god-tier workflow validation: Full Pipeline.

CONTEXT:
- Phase 1a MUST be complete and merged before starting this
- Read docs/plans/god-tier-validation-implementation-plan.md (Phase 1 section)
- Read docs/plans/god-tier-validation-design.md (Phase 1b design, lines 200-600)
- Read docs/plans/god-tier-validation-INSTRUCTIONS.md (Stage 1b section)
- This adds 4 new validation phases: round-trip, executable construction, v2 compilation, startability

DELIVERABLES:
1. Edit: src/application/services/workflow-validation-pipeline.ts
   - Replace ValidationOutcomePhase1a with full ValidationOutcome type (8 variants, see design lines 205-215)
   - Add ValidatedWorkflow interface (lines 220-228)
   - Add StartabilityFailure discriminated union (lines 235-240)
   - Extend ValidationPipelineDepsPhase1a to ValidationPipelineDeps (add interpreter, resolveFirstStep)
   - Implement validateWorkflow() function - full 8-phase pipeline (lines 245-320)
   - Implement validateStartability() helper function (lines 330-380)
   - validateStartability has two sub-checks:
     a) First-step resolution (via shared resolveFirstStep)
     b) Interpreter reachability (interpreter.next from init state)

2. New file: src/v2/durable-core/domain/start-construction.ts
   - Implement resolveFirstStep() function (design lines 395-430)
   - This function is SHARED by both runtime and validation
   - Takes authoredWorkflow + executableWorkflow
   - Returns Result<{ id: string }, StartabilityFailure>
   - Validates: (1) workflow has at least one step, (2) steps[0].id exists in executable form
   - This prevents the runtime bug where steps[0] from authored form doesn't exist in executable

3. Edit: src/mcp/handlers/v2-execution/start.ts
   - Import resolveFirstStep from start-construction.ts
   - Find the first-step resolution logic (currently around lines 62-70)
   - Add cheap pre-check before normalization: if (workflow.definition.steps.length === 0) return error
   - AFTER pinning succeeds, call resolveFirstStep(workflow, pinnedWorkflow)
   - Handle error: if (firstStepResult.isErr()) return neErrorAsync({ kind: 'startability_failed', reason: firstStepResult.error })
   - Update StartWorkflowError type to include new error kind
   - See design lines 470-520 for exact code

4. Edit: src/application/use-cases/validate-workflow-file.ts
   - Change to call validateWorkflow() instead of validateWorkflowPhase1a()
   - Map full ValidationOutcome (8 variants) to ValidationResult

5. Edit: src/application/use-cases/validate-workflow-json.ts
   - Same update as validate-workflow-file.ts

ACCEPTANCE CRITERIA:
- npm test passes
- All bundled workflows pass the full 8-phase pipeline
- start.ts uses shared resolveFirstStep() function (runtime shares validation code)
- Validation pipeline calls the same resolveFirstStep() function
- Test case: workflow with steps[0].id not in executable form → startability_failed
- Test case: workflow with all steps having runCondition: false → startability_failed (no_reachable_step reason)
- ValidatedWorkflow type is only produced on full pipeline success

IMPLEMENTATION NOTES:
- The round-trip phase does: JSON.stringify(snapshot) → JSON.parse() → Zod re-parse
- This proves the serialized bytes runtime would store are valid
- validateStartability() is a private helper in workflow-validation-pipeline.ts
- Follow exact type signatures from design doc

CRITICAL: resolveFirstStep() must be extracted into start-construction.ts as a SHARED function. Both runtime (start.ts) and validation (pipeline) call the SAME function. This is the "Single Source of Resolution Truth" principle.

When complete:
1. Run npm test
2. Verify start.ts calls resolveFirstStep() after pinning
3. Verify validation pipeline also calls resolveFirstStep()
4. Create git commit:
   "Phase 1b: Complete 8-phase validation pipeline
   
   - Added round-trip, v2 compilation, startability phases
   - Extracted resolveFirstStep() as shared function
   - Refactored start.ts to use resolveFirstStep()
   - ValidatedWorkflow type now produced on full success
   - All bundled workflows pass full pipeline"
```

---

## Stage 2: Registry Validation + CI Script (Phases 2-3)

```
Implement Phases 2-3 of god-tier workflow validation: Registry Validation + CI Script.

CONTEXT:
- Phases 1a and 1b MUST be complete and merged
- Read docs/plans/god-tier-validation-implementation-plan.md (lines 402-600)
- Read docs/plans/god-tier-validation-design.md (lines 400-600)
- Read docs/plans/god-tier-validation-design-part2.md (lines 1-450)
- Read docs/plans/god-tier-validation-INSTRUCTIONS.md (Stage 2 section)
- CRITICAL PRINCIPLE: validation must use the SAME resolution code as runtime (extract shared functions, don't rewrite)

DELIVERABLES:

NEW FILES (Registry Validation):

1. src/application/use-cases/registry-validation/registry-snapshot.ts
   - Copy ALL types from design doc (design.md lines 400-500):
     - RawWorkflowFile, RawWorkflowFileContent (discriminated union)
     - WorkflowCandidate, ResolvedWorkflow
     - DuplicateIdReport
     - RegistrySnapshot
   - These are pure data types, no logic

2. src/application/use-cases/registry-validation/resolve-workflow-candidates.ts
   - Implement resolveWorkflowCandidates() function
   - This is EXTRACTED logic from EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()
   - DO NOT rewrite - copy the existing resolution logic
   - Pure function: takes candidates[], returns { resolved, duplicates }
   - Source priority order: bundled > plugin > user > custom > git > remote > project
   - See design-part2.md lines 100-150

3. src/application/use-cases/registry-validation/find-workflow-json-files.ts
   - Implement findWorkflowJsonFiles() function
   - This is EXTRACTED logic from FileWorkflowStorage.findJsonFiles()
   - DO NOT rewrite - copy the existing scan logic
   - Pure function: takes WorkflowSource, returns file paths
   - Recursive scan, skip examples/ directory

4. src/application/use-cases/registry-validation/build-registry-snapshot.ts
   - Implement buildRegistrySnapshot() function (design-part2.md lines 50-100)
   - Uses shared functions (findWorkflowJsonFiles, resolveWorkflowCandidates)
   - Scans raw files, builds candidates, resolves across sources
   - Returns RegistrySnapshot with: rawFiles, candidates, resolved, duplicates

5. src/application/use-cases/registry-validation/validate-registry.ts
   - Copy types from design-part2.md lines 1-50:
     - Tier1Outcome (4 variants: unparseable, schema_failed, structural_failed, tier1_passed)
     - ResolvedValidationEntry, RawFileValidationEntry
     - RegistryValidationReport
   - Implement validateRegistry() function (lines 150-250)
   - Runs full 8-phase pipeline on each resolved workflow
   - Runs Tier 1 (schema + structural only) on all raw files
   - Returns comprehensive report

EDIT FILES (Storage Refactoring):

6. src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts
   - Find loadAllWorkflows() method
   - REFACTOR to use shared resolveWorkflowCandidates() function
   - Import from registry-validation/resolve-workflow-candidates.ts
   - This is a BEHAVIOR-PRESERVING refactor (same results, just calls shared function)
   - Do NOT change the method signature or return type

7. src/infrastructure/storage/file-workflow-storage.ts
   - Find findJsonFiles() method
   - REFACTOR to use shared findWorkflowJsonFiles() function
   - Import from registry-validation/find-workflow-json-files.ts
   - This is a BEHAVIOR-PRESERVING refactor

NEW FILE (CI Script):

8. scripts/validate-workflows-registry.ts
   - Copy full implementation from design-part2.md lines 300-450
   - This is an executable TypeScript script (#!/usr/bin/env tsx at top)
   - Loads variant configs from scripts/workflow-validation-variants.json
   - For each variant:
     a) Set feature flags
     b) Build storage chain with those flags
     c) Build registry snapshot
     d) Validate registry
     e) Report results
   - Print detailed output (per-workflow phase status)
   - Exit non-zero if any failures

EDIT FILES (Package + Deprecation):

9. package.json
   - Change "validate:workflows" script from "./scripts/validate-workflows.sh" to "tsx scripts/validate-workflows-registry.ts"
   - Update "precommit" script if needed

10. scripts/validate-workflows.sh (deprecate, don't delete)
    - Add comment at top: "# DEPRECATED: Use npm run validate:workflows instead"
    - Keep file for reference only

ACCEPTANCE CRITERIA:
- npm run validate:workflows uses new TypeScript script (not bash)
- Reports all failures across all 4 feature-flag variants (default, agentic, v2, agentic+v2)
- Duplicate workflow IDs across sources are detected and reported
- All raw files (.json files on disk) get Tier 1 validation
- All resolved workflows (what runtime would use) get full 8-phase validation
- Exits non-zero if any failures exist
- Recursive scanning: catches workflows in subdirectories like workflows/routines/
- Runtime tests still pass (storage refactors are behavior-preserving)

CRITICAL NOTES:
1. The shared functions (resolveWorkflowCandidates, findWorkflowJsonFiles) MUST be extracted from existing runtime code, not rewritten from scratch
2. The storage refactors MUST preserve existing behavior - same inputs produce same outputs
3. The registry validator builds the snapshot using the SAME functions runtime uses

When complete:
1. Run npm test (storage refactors must not break runtime tests)
2. Run npm run validate:workflows (should use new script and report on all variants)
3. Create git commit:
   "Phase 2-3: Registry validation + CI script replacement
   
   - Created registry snapshot builder using shared resolution functions
   - Extracted resolveWorkflowCandidates from EnhancedMultiSourceWorkflowStorage
   - Extracted findWorkflowJsonFiles from FileWorkflowStorage
   - Implemented validateRegistry() with Tier 1 + full pipeline
   - Replaced bash CI script with TypeScript registry validator
   - Validates under all 4 feature-flag variants
   - Detects and reports duplicate workflow IDs"
```

---

## Stage 3: Eliminate Silent Hiding (Phase 4)

```
Implement Phase 4 of god-tier workflow validation: Eliminate Silent Hiding.

CONTEXT:
- Phases 1-3 MUST be complete and merged
- Read docs/plans/god-tier-validation-implementation-plan.md (lines 602-700)
- Read docs/plans/god-tier-validation-design-part2.md (lines 450-600)
- Read docs/plans/god-tier-validation-INSTRUCTIONS.md (Stage 3 section)
- Goal: no silent degradation - errors must be loud, structured, and visible

DELIVERABLES:

1. Edit: src/v2/durable-core/domain/prompt-renderer.ts
   - Find renderPendingPrompt() function
   - Locate the line: const step = getExecutableStepById(args.workflow, args.stepId);
   - Current code likely has: const baseTitle = step?.title ?? args.stepId;
   - Change to fail-fast pattern:
     ```
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
   - No fallback - hard failure if step doesn't exist

2. Delete: src/mcp/handlers/v2-execution-helpers.ts - renderPendingPromptOrDefault function
   - Find renderPendingPromptOrDefault (likely around lines 589-612)
   - DELETE the entire function
   - This function was masking errors by providing fallback values

3. Edit: src/mcp/handlers/v2-execution/start.ts
   - Find the renderPendingPromptOrDefault() call (around line 407)
   - Replace with renderPendingPrompt() and explicit error handling:
     ```
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
   - Add 'prompt_render_failed' to StartWorkflowError type union

4. Edit: src/mcp/handlers/v2-execution/replay.ts
   - Find renderPendingPromptOrDefault() calls
   - Apply same change as start.ts (replace with error-handling pattern)

5. Edit: src/infrastructure/storage/schema-validating-workflow-storage.ts
   - Add ValidationErrorCollector interface at top of file:
     ```
     export interface ValidationErrorCollector {
       report(workflowId: string, sourceKind: string, error: string): void;
     }
     
     export class ConsoleValidationErrorCollector implements ValidationErrorCollector {
       report(workflowId: string, sourceKind: string, error: string): void {
         console.error(`[ValidationError] Workflow '${workflowId}' from ${sourceKind}: ${error}`);
       }
     }
     ```
   - Update constructor to inject ValidationErrorCollector (default to ConsoleValidationErrorCollector)
   - In loadAllWorkflows(): before filtering invalid workflows, call this.errorCollector.report()
   - In getWorkflowById(): before returning null for invalid workflow, call this.errorCollector.report()
   - In listWorkflowSummaries(): change to call this.loadAllWorkflows() and derive summaries from validated list
     (this fixes Gap 9 - listWorkflowSummaries was bypassing validation)

ACCEPTANCE CRITERIA:
- npm test passes
- renderPendingPrompt with missing step ID returns error (not fallback)
- renderPendingPromptOrDefault no longer exists (grep confirms)
- start.ts and replay.ts handle prompt rendering errors explicitly
- Invalid workflows are logged with structured messages to console.error
- listWorkflowSummaries() never includes schema-invalid workflows
- No silent hiding anywhere in the validation or storage layers

IMPLEMENTATION NOTES:
- Use neverthrow error handling throughout (no exceptions)
- Error collector logs to console.error (can be replaced with structured logging later)
- Follow existing error-handling patterns in the handlers (they use Result.andThen chains)

When complete:
1. Run npm test
2. Grep for "renderPendingPromptOrDefault" - should find nothing
3. Create a test workflow with invalid step reference, verify error is logged to console
4. Create git commit:
   "Phase 4: Eliminate silent hiding
   
   - Prompt renderer now fails hard on missing step ID
   - Deleted renderPendingPromptOrDefault (silent degradation wrapper)
   - start.ts and replay.ts handle prompt errors explicitly
   - Added ValidationErrorCollector to SchemaValidatingWorkflowStorage
   - Invalid workflows logged with structured error messages
   - listWorkflowSummaries fixed to exclude invalid workflows"
```

---

## Stage 4: Regression Tests (Phase 5)

```
Implement Phase 5 of god-tier workflow validation: Regression Test Suite.

CONTEXT:
- Phases 1-4 MUST be complete and merged
- Read docs/plans/god-tier-validation-implementation-plan.md (lines 702-800)
- Read docs/plans/god-tier-validation-design-part2.md (lines 600-700)
- Read docs/plans/god-tier-validation-INSTRUCTIONS.md (Stage 4 section)
- Goal: 39 regression tests that prove every identified gap is closed

DELIVERABLES:

1. New file: tests/unit/validate-workflow-registry.test.ts
   - Use vitest framework (describe, it, expect, beforeEach)
   - Create test fakes (don't use real filesystem - tests must be hermetic)
   - Implement all 39 test cases from implementation-plan.md lines 702-760
   - Organize tests by category:
     - Discovery and Duplicates (tests 1-4)
     - Variant Resolution (tests 5-7)
     - Normalization (tests 8-10)
     - Serialization Round-Trip (test 11)
     - Executable Compilation (tests 12-14)
     - Startability (tests 15-17b)
     - Silent Hiding (tests 18-19b)
     - Exhaustive Reporting (tests 20-21)
     - Pipeline Consolidation (tests 22-23)

2. Create test helper files (if they don't exist):
   - tests/fakes/workflow.fake.ts
     - createFakeWorkflow() function for building test workflows
   - tests/fakes/validation-deps.fake.ts
     - createFakeValidationDeps() for building ValidationPipelineDeps
   - tests/fakes/registry-snapshot.fake.ts
     - createFakeRegistrySnapshot() for building RegistrySnapshot test data

SAMPLE TESTS (copy from design-part2.md lines 600-700):

Test 1: Duplicate detection
```typescript
it('1. Two workflows with same ID in different sources → hard failure', async () => {
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
});
```

Test 15: Startability success
```typescript
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
```

Test 16: Startability failure (no reachable steps)
```typescript
it('16. All steps with runCondition: false → startability failure', () => {
  const workflow = createFakeWorkflow({
    steps: [
      { id: 'step1', title: 'Step 1', prompt: 'Never runs', runCondition: { type: 'js', expression: 'false' } },
    ],
  });
  
  const outcome = validateWorkflow(workflow, deps);
  
  expect(outcome.kind).toBe('startability_failed');
  if (outcome.kind === 'startability_failed') {
    expect(outcome.reason.reason).toBe('no_reachable_step');
  }
});
```

Test 17b: First-step cross-form check
```typescript
it('17b. steps[0].id not in executable → startability failure', () => {
  const workflow = createFakeWorkflow({
    steps: [{ id: 'original-step-id', title: 'Step 1', prompt: 'Test' }],
  });
  
  // Mock normalizeToExecutable to return different step ID
  const depsWithMock = {
    ...deps,
    normalizeToExecutable: () => ok({
      definition: {
        steps: [{ id: 'different-step-id', title: 'Step 1', prompt: 'Test' }],
      },
    }),
  };
  
  const outcome = validateWorkflow(workflow, depsWithMock);
  
  expect(outcome.kind).toBe('startability_failed');
  if (outcome.kind === 'startability_failed') {
    expect(outcome.reason.reason).toBe('first_step_not_in_executable');
    expect(outcome.reason.authoredStepId).toBe('original-step-id');
  }
});
```

Test 19: Prompt renderer fail-fast
```typescript
it('19. renderPendingPrompt with missing step ID → error not fallback', () => {
  const workflow = createFakeExecutableWorkflow({
    steps: [{ id: 'step1', title: 'Step 1', prompt: 'Test' }],
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
```

ACCEPTANCE CRITERIA:
- All 39 tests pass
- Tests use fakes, not real filesystem (hermetic)
- Each test is named by the gap number it closes (e.g., "1. Two workflows...")
- Fast execution (< 5 seconds for full test suite)
- Tests cover all validation phases: schema, structural, v1 compilation, normalization, round-trip, v2 compilation, startability

IMPLEMENTATION NOTES:
- Use vitest's describe/it/expect API
- Create minimal fakes that return the specific data needed for each test
- Don't test implementation details - test observable outcomes (ValidationOutcome.kind)
- Follow the discriminated union pattern in assertions (check kind, then narrow type)

When complete:
1. Run npm test tests/unit/validate-workflow-registry.test.ts
2. Verify all 39 tests pass
3. Check execution time (should be fast)
4. Create git commit:
   "Phase 5: 39 regression tests for validation gaps
   
   - Created validate-workflow-registry.test.ts with full coverage
   - Tests for: discovery, duplicates, variants, normalization, round-trip, compilation, startability, silent hiding
   - All tests use fakes (hermetic, fast)
   - Each test named by gap number from original audit"
```

---

## Stage 5: Lifecycle Harness MVP (Phase 6)

```
Implement Phase 6 of god-tier workflow validation: Lifecycle Execution Harness (MVP).

CONTEXT:
- Phases 1-5 MUST be complete and merged
- Read docs/plans/god-tier-validation-implementation-plan.md (lines 802-900)
- Read docs/plans/god-tier-validation-design-part2.md (lines 700-800)
- Read docs/plans/god-tier-validation-INSTRUCTIONS.md (Stage 5 section)
- Goal: Prove 3 bundled workflows can execute start-to-completion without workflow-definition errors
- Use YAGNI principle: start with 3 hardcoded tests, not a general framework

DELIVERABLES:

1. New file: tests/lifecycle/lifecycle-harness.ts
   - Copy types from design-part2.md lines 700-730:
     - WorkflowFixture (inline workflow + step fixtures)
     - StepFixture (notesMarkdown, artifacts, context)
     - LifecycleTestResult (discriminated union: validation_failed, step_failed, terminal_mismatch, success)
   - Implement executeWorkflowLifecycle() function (lines 750-800)
   - Steps:
     1. Validate workflow through full pipeline (must pass)
     2. Create initial execution state ({ kind: 'init' })
     3. Loop: interpreter.next() → get next step → apply fixture data → interpreter.applyEvent() → repeat
     4. Drive to isComplete: true
     5. Verify terminal state matches expected
   - Return LifecycleTestResult

2. New file: tests/lifecycle/fixtures/test-session-persistence.fixture.ts
   - Export const testSessionPersistenceFixture: WorkflowFixture
   - Inline workflow definition (copy from workflows/test-session-persistence.json if it exists, or create minimal version)
   - Per-step fixture data (just enough to advance each step)
   - expectedTerminalState: 'complete'
   - See design-part2.md lines 805-830 for example

3. New file: tests/lifecycle/fixtures/workflow-diagnose-environment.fixture.ts
   - Same pattern as test-session-persistence
   - Different workflow (simpler if possible)

4. New file: tests/lifecycle/fixtures/test-artifact-loop-control.fixture.ts
   - Same pattern, but this workflow has a loop
   - Fixture includes loop iteration data

5. New file: tests/lifecycle/test-session-persistence.test.ts
   - Import executeWorkflowLifecycle and testSessionPersistenceFixture
   - One test: should execute start-to-completion without workflow-definition errors
   - Uses real WorkflowCompiler and WorkflowInterpreter (not fakes - we're testing the real thing)
   - Assert result.kind === 'success'

6. New file: tests/lifecycle/workflow-diagnose-environment.test.ts
   - Same pattern as above

7. New file: tests/lifecycle/test-artifact-loop-control.test.ts
   - Same pattern as above

ACCEPTANCE CRITERIA:
- All 3 lifecycle tests pass
- Each test drives workflow from start to isComplete: true
- No workflow-definition errors during execution
- Fixtures are inline TypeScript (not loaded from filesystem - hermetic)
- Tests use real compiler and interpreter (integration test level)
- Test execution is deterministic (same fixtures always produce same result)

IMPLEMENTATION NOTES:
- Keep fixtures minimal - just enough data to advance each step
- Don't build a framework yet - 3 hardcoded tests is fine (YAGNI)
- Fixtures are TypeScript files for type safety
- The harness validates the workflow first (proves it passes full pipeline before execution)
- Use the actual DI container to resolve WorkflowCompiler and WorkflowInterpreter

When complete:
1. Run npm test tests/lifecycle/
2. All 3 tests should pass
3. Verify fixtures are type-safe TypeScript (not JSON)
4. Create git commit:
   "Phase 6 MVP: Lifecycle harness + 3 workflow fixtures
   
   - Created lifecycle execution harness
   - Implemented fixtures for 3 bundled workflows
   - All workflows execute start-to-completion without errors
   - Fixtures are inline and hermetic (TypeScript, not JSON)"
```

---

## Quick Reference: Stage Order

1. **Stage 1a** → Consolidate validation (1 new file, 3 edits)
2. **Stage 1b** → Full pipeline + shared resolveFirstStep (1 new file, 2 edits)
3. **Stage 2** → Registry validation + CI script (5 new files, 2 edits, 1 new script, 1 edit package.json)
4. **Stage 3** → Eliminate silent hiding (0 new files, 5 edits)
5. **Stage 4** → 39 regression tests (1 new file + fakes)
6. **Stage 5** → Lifecycle harness MVP (7 new files: harness + 3 fixtures + 3 tests)

**Total implementation time**: 22-35 hours across 6 stages

---

## Important Reminders

- **Never skip stages** — each is a separate merge with standalone value
- **Always run tests** after completing a stage
- **Copy types exactly** from design docs — don't modify them
- **Use shared functions** — runtime and validation must use the same code
- **Keep commits small** — one commit per stage
- **Verify before proceeding** — human verification after each stage

---

Good luck! These prompts are ready to use with the WorkRail subagent.
