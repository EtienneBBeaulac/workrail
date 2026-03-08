# God-Tier Workflow Validation: Implementation Instructions

This document provides step-by-step instructions for implementing the god-tier workflow validation system. It's designed to be followed by another developer (or an AI agent) who will execute the work.

---

## Prerequisites

Before starting, ensure you have:
1. Read access to the WorkRail codebase
2. The WorkRail subagent available (for executing multi-step implementation tasks)
3. Familiarity with TypeScript, neverthrow Result types, and discriminated unions

---

## Overview: What You're Building

You're implementing a **validation system that proves workflows are correct before runtime**. The current validator checks files individually; the new system validates the full registry (multi-source, variant-aware) exactly as runtime would resolve it.

**Key principle**: Validation and runtime must use **the same code paths**. If they diverge, the validator becomes a false assurance layer.

**Success metric**: Zero runtime workflow-definition errors for bundled workflows (Invariant 1 in the plan).

---

## Document Guide

### Must-Read Documents (in order)

1. **`god-tier-validation-implementation-plan.md`** (~1800 lines)
   - Read sections: Mission, Formal Invariants, Success Metrics, Validation Tiers, Philosophy Alignment, all 6 Phase sections
   - This is the **master plan** — it explains the "why" behind every design decision
   - Key sections to internalize:
     - Lines 14-52: Formal Invariants (the contract you're enforcing)
     - Lines 54-68: Single Source of Resolution Truth (shared functions principle)
     - Lines 70-88: Authoritative Validation Entrypoint (one pipeline, many consumers)
     - Lines 264-280: Philosophy Alignment Constraints (the type-system requirements)

2. **`god-tier-validation-INDEX.md`** (navigation guide)
   - Use this to quickly find things in the other docs
   - Refer to the "Quick Navigation" tables when you need to look up a specific phase or file

3. **`god-tier-validation-design.md`** (Phases 1a, 1b, partial 2)
   - **Implementation reference** — concrete TypeScript signatures
   - You'll copy-paste types from here into your code

4. **`god-tier-validation-design-part2.md`** (Phases 2-6)
   - **Implementation reference** — more TypeScript signatures
   - Sample test cases, CI script structure, lifecycle harness

---

## Implementation Strategy: Use the WorkRail Subagent

**Do NOT implement this manually.** The scope is too large (12-15 new files, 13 edited files). Instead, use the WorkRail subagent to execute each phase as a standalone task.

### How to Use the WorkRail Subagent

The WorkRail subagent is a specialized AI agent that can:
- Read the plan documents
- Inspect existing code
- Create new files with proper TypeScript types
- Edit existing files following the design
- Run tests to verify correctness
- Create git commits

**Invoke it with the `task` tool:**

```typescript
task({
  subagent_type: "workrail-executor",
  description: "Implement Phase 1a: Pipeline Skeleton",
  prompt: `Implement Phase 1a of the god-tier validation plan.
  
Context:
- Read docs/plans/god-tier-validation-implementation-plan.md (Phase 1a section)
- Read docs/plans/god-tier-validation-design.md (Phase 1a types and functions)
- Read docs/plans/god-tier-validation-INDEX.md (for navigation)

Task:
1. Create src/application/services/workflow-validation-pipeline.ts with the Phase 1a types and validateWorkflowPhase1a() function
2. Edit src/application/services/validation-engine.ts to extract normalization
3. Edit src/application/validation.ts to add validateWorkflowSchema() wrapper
4. Edit src/application/use-cases/validate-workflow-file.ts to use the pipeline
5. Edit src/application/use-cases/validate-workflow-json.ts to use the pipeline

Acceptance criteria:
- All existing validation tests pass
- validateWorkflowPhase1a() returns a discriminated union (ValidationOutcomePhase1a)
- CLI validate command uses the new pipeline
- No new validation logic — just consolidation of existing checks

Reference the design doc for exact type signatures. Follow the TypeScript exactly as specified.`
})
```

---

## Phase-by-Phase Instructions

### Stage 1a: Pipeline Skeleton (Phase 1a)

**Goal**: Consolidate existing validation into one pipeline function. No new logic.

**Prompt for WorkRail Subagent:**

```
Implement Phase 1a of god-tier workflow validation: Pipeline Skeleton.

CONTEXT:
- Read docs/plans/god-tier-validation-implementation-plan.md lines 309-400 (Phase 1 section)
- Read docs/plans/god-tier-validation-design.md lines 1-200 (Phase 1a design)
- This is checkpoint #1 — consolidation only, no new validation logic

DELIVERABLES:
1. New file: src/application/services/workflow-validation-pipeline.ts
   - Copy ValidationOutcomePhase1a type from design doc
   - Copy ValidationPipelineDepsPhase1a interface
   - Implement validateWorkflowPhase1a() function (4 phases: schema, structural, v1 compilation, normalization)

2. Edit: src/application/services/validation-engine.ts
   - Extract the compileV1WorkflowToPinnedSnapshot call from validateWorkflow() (currently at lines 763+)
   - Add validateWorkflowStructureOnly() method that returns Result<Workflow, string[]>
   - Keep all existing structural checks (duplicate step IDs, loop validation, etc.)

3. Edit: src/application/validation.ts
   - Add validateWorkflowSchema() function that wraps the existing AJV validator
   - Return Result<Workflow, SchemaError[]>

4. Edit: src/application/use-cases/validate-workflow-file.ts
   - Rewire to call validateWorkflowPhase1a()
   - Map ValidationOutcomePhase1a to the existing ValidationResult type
   - For now, all failures map to a single 'pipeline_invalid' message

5. Edit: src/application/use-cases/validate-workflow-json.ts
   - Same rewiring as validate-workflow-file.ts

ACCEPTANCE CRITERIA:
- npm test passes (all existing validation tests work with new pipeline)
- CLI: workrail validate <file> uses the new pipeline
- MCP: validate_workflow_json uses the new pipeline
- No behavior change — same workflows pass/fail as before

STYLE:
- Use neverthrow Result types (ok, err)
- Follow discriminated union pattern (kind field)
- All deps injected, no ad-hoc construction
- Copy exact types from design doc

When complete, run tests and create a git commit:
"Phase 1a: Consolidate validation into pipeline skeleton

- Created workflow-validation-pipeline.ts with 4-phase pipeline
- Extracted normalization from ValidationEngine
- Rewired CLI and MCP validators to use pipeline
- All existing tests pass (consolidation, no new logic)"
```

**Human verification after agent completes:**
1. Run `npm test` — all tests should pass
2. Run `npm run validate:workflows` — should use old bash script (unchanged in this phase)
3. Check that `validateWorkflowPhase1a()` exists and has the 4 outcome variants

---

### Stage 1b: Full Pipeline (Phase 1b)

**Goal**: Add the missing 4 phases (round-trip, v2 compilation, startability). Extract `resolveFirstStep()` as shared function.

**Prompt for WorkRail Subagent:**

```
Implement Phase 1b of god-tier workflow validation: Full Pipeline.

CONTEXT:
- Phase 1a must be complete and merged
- Read docs/plans/god-tier-validation-implementation-plan.md Phase 1 section
- Read docs/plans/god-tier-validation-design.md lines 200-600 (Phase 1b design)
- This adds 4 new phases to the pipeline: round-trip, executable construction, v2 compilation, startability

DELIVERABLES:
1. Edit: src/application/services/workflow-validation-pipeline.ts
   - Extend ValidationOutcome type (add 4 new variants: round_trip_failed, v2_compilation_failed, startability_failed, valid)
   - Add ValidatedWorkflow interface (the compile-time gate type)
   - Add StartabilityFailure discriminated union (4 variants)
   - Add ValidationPipelineDeps interface (extends Phase 1a deps with interpreter, resolveFirstStep)
   - Implement validateWorkflow() function (full 8-phase pipeline)
   - Implement validateStartability() helper (two sub-checks: first-step resolution + interpreter reachability)

2. New file: src/v2/durable-core/domain/start-construction.ts
   - Implement resolveFirstStep() function (shared by runtime and validation)
   - Takes authoredWorkflow + executableWorkflow
   - Returns Result<{ id: string }, StartabilityFailure>
   - Checks: (1) workflow has steps, (2) steps[0].id exists in executable form
   - Copy exact function signature from design doc lines 300-350

3. Edit: src/mcp/handlers/v2-execution/start.ts
   - Import resolveFirstStep from start-construction.ts
   - Refactor lines 62-70 to add cheap pre-check (workflow has steps)
   - Move cross-form check to AFTER pinning (new location)
   - Call resolveFirstStep(workflow, pinnedWorkflow) after pinning succeeds
   - Update StartWorkflowError type to include { kind: 'startability_failed', reason: StartabilityFailure }
   - Handle resolveFirstStep error by returning startability_failed

4. Edit: src/application/use-cases/validate-workflow-file.ts
   - Update to call validateWorkflow() (not validateWorkflowPhase1a)
   - Map full ValidationOutcome to ValidationResult

5. Edit: src/application/use-cases/validate-workflow-json.ts
   - Same update as validate-workflow-file.ts

ACCEPTANCE CRITERIA:
- npm test passes
- All bundled workflows pass the full 8-phase pipeline
- start.ts uses shared resolveFirstStep() function
- Validation pipeline calls the same resolveFirstStep() function
- Test: workflow with steps[0].id not in executable form → startability_failed
- Test: workflow with all steps having runCondition: false → startability_failed (no_reachable_step)

STYLE:
- Use neverthrow Result.andThen for pipeline chaining
- Follow exact type signatures from design doc
- validateStartability() is a private helper in workflow-validation-pipeline.ts

When complete, run tests and create git commit:
"Phase 1b: Complete 8-phase validation pipeline

- Added round-trip, v2 compilation, startability phases
- Extracted resolveFirstStep() as shared function
- Refactored start.ts to use resolveFirstStep()
- ValidatedWorkflow type now produced on full success
- All bundled workflows pass full pipeline"
```

**Human verification:**
1. Run `npm test`
2. Check that `resolveFirstStep()` exists in `start-construction.ts`
3. Verify `start.ts` calls `resolveFirstStep()` after pinning
4. Check that validation pipeline also calls `resolveFirstStep()`

---

### Stage 2: Registry Validation (Phases 2-3)

**Goal**: Build registry snapshot using shared functions. Detect duplicates. Replace CI script.

**Prompt for WorkRail Subagent:**

```
Implement Phases 2-3 of god-tier workflow validation: Registry Validation + CI Script.

CONTEXT:
- Phases 1a and 1b must be complete
- Read docs/plans/god-tier-validation-implementation-plan.md lines 402-600 (Phases 2-3)
- Read docs/plans/god-tier-validation-design.md lines 400-600 + god-tier-validation-design-part2.md lines 1-450
- Key principle: validation must use the SAME resolution code as runtime (shared functions)

DELIVERABLES:
1. New file: src/application/use-cases/registry-validation/registry-snapshot.ts
   - Copy all types from design doc: RawWorkflowFile, WorkflowCandidate, ResolvedWorkflow, DuplicateIdReport, RegistrySnapshot
   - RawWorkflowFileContent is a discriminated union (parsed | unparseable)

2. New file: src/application/use-cases/registry-validation/resolve-workflow-candidates.ts
   - Implement resolveWorkflowCandidates() function
   - This is the EXTRACTED logic from EnhancedMultiSourceWorkflowStorage.loadAllWorkflows()
   - Pure function: takes candidates[], returns { resolved, duplicates }
   - Source priority: bundled > plugin > user > custom > git > remote > project

3. New file: src/application/use-cases/registry-validation/find-workflow-json-files.ts
   - Implement findWorkflowJsonFiles() function
   - This is the EXTRACTED logic from FileWorkflowStorage.findJsonFiles()
   - Pure function: takes WorkflowSource, returns file paths
   - Recursive scan, skip examples/

4. New file: src/application/use-cases/registry-validation/build-registry-snapshot.ts
   - Implement buildRegistrySnapshot() function
   - Uses shared functions (findWorkflowJsonFiles, resolveWorkflowCandidates)
   - Returns RegistrySnapshot (rawFiles, candidates, resolved, duplicates)

5. New file: src/application/use-cases/registry-validation/validate-registry.ts
   - Implement Tier1Outcome type (unparseable, schema_failed, structural_failed, tier1_passed)
   - Implement ResolvedValidationEntry and RawFileValidationEntry types
   - Implement RegistryValidationReport type
   - Implement validateRegistry() function
   - Runs full pipeline on resolved workflows, Tier 1 on all raw files

6. Edit: src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts
   - Refactor loadAllWorkflows() to use shared resolveWorkflowCandidates()
   - Import from resolve-workflow-candidates.ts
   - Behavior-preserving refactor (same results, just calls shared function)

7. Edit: src/infrastructure/storage/file-workflow-storage.ts
   - Refactor findJsonFiles() to use shared findWorkflowJsonFiles()
   - Import from find-workflow-json-files.ts
   - Behavior-preserving refactor

8. New file: scripts/validate-workflows-registry.ts
   - Copy full implementation from design-part2.md lines 300-450
   - Loads variants from scripts/workflow-validation-variants.json
   - For each variant: build snapshot, validate registry, report results
   - Exit non-zero if any failures
   - Print detailed output (per-workflow phase status)

9. Edit: package.json
   - Change "validate:workflows" script to: "tsx scripts/validate-workflows-registry.ts"
   - Update "precommit" to use new validator

10. Deprecate: scripts/validate-workflows.sh
    - Add DEPRECATED comment at top
    - Keep file for reference

ACCEPTANCE CRITERIA:
- npm run validate:workflows runs new registry-centric validator
- Reports all failures across all 4 feature-flag variants
- Duplicate IDs across sources are reported
- All raw files get Tier 1 validation
- All resolved workflows get full 8-phase validation
- Exits non-zero on any failure
- Recursive: catches workflows in subdirectories
- Runtime tests still pass (refactored storage uses shared functions, same behavior)

CRITICAL: The shared functions (resolveWorkflowCandidates, findWorkflowJsonFiles) must be EXTRACTED from existing code, not rewritten. Copy the logic exactly, then have both runtime and validator call the extracted version.

When complete, run tests and validation, create git commit:
"Phase 2-3: Registry validation + CI script replacement

- Created registry snapshot builder using shared resolution functions
- Extracted resolveWorkflowCandidates from EnhancedMultiSourceWorkflowStorage
- Extracted findWorkflowJsonFiles from FileWorkflowStorage
- Implemented validateRegistry() with Tier 1 + full pipeline
- Replaced bash CI script with TypeScript registry validator
- Validates under all 4 feature-flag variants
- Detects and reports duplicate workflow IDs"
```

**Human verification:**
1. Run `npm run validate:workflows` — should use new TypeScript script
2. Check output includes all 4 variants
3. Verify runtime tests pass (storage refactors are behavior-preserving)
4. Check that duplicate IDs are reported if you create a test duplicate

---

### Stage 3: Tighten Runtime (Phase 4)

**Goal**: Remove silent hiding. Make prompt rendering fail-fast. Add error collector.

**Prompt for WorkRail Subagent:**

```
Implement Phase 4 of god-tier workflow validation: Eliminate Silent Hiding.

CONTEXT:
- Phases 1-3 must be complete
- Read docs/plans/god-tier-validation-implementation-plan.md lines 602-700 (Phase 4)
- Read docs/plans/god-tier-validation-design-part2.md lines 450-600
- Goal: no silent degradation — errors must be loud and structured

DELIVERABLES:
1. Edit: src/v2/durable-core/domain/prompt-renderer.ts
   - Find renderPendingPrompt() function (likely around line 316)
   - Current code: const step = getExecutableStepById(...); const baseTitle = step?.title ?? stepId;
   - Change to: if (!step) return err({ code: 'RENDER_FAILED', message: '...' });
   - No fallback — fail hard if step not found

2. Delete: renderPendingPromptOrDefault() from src/mcp/handlers/v2-execution-helpers.ts
   - Find the function (lines 589-612)
   - Delete it entirely

3. Edit: src/mcp/handlers/v2-execution/start.ts
   - Find renderPendingPromptOrDefault() call (line 407)
   - Replace with renderPendingPrompt()
   - Handle the Result: if (metaResult.isErr()) return neErrorAsync({ kind: 'prompt_render_failed', ... })
   - Add 'prompt_render_failed' to StartWorkflowError type

4. Edit: src/mcp/handlers/v2-execution/replay.ts
   - Same change as start.ts (replace renderPendingPromptOrDefault with error handling)

5. Edit: src/infrastructure/storage/schema-validating-workflow-storage.ts
   - Add ValidationErrorCollector interface (see design doc)
   - Add ConsoleValidationErrorCollector implementation
   - Inject collector in constructor
   - In loadAllWorkflows(): call collector.report() before filtering invalid workflows
   - In getWorkflowById(): call collector.report() before returning null
   - In listWorkflowSummaries(): change to derive from loadAllWorkflows() (already filtered)

ACCEPTANCE CRITERIA:
- npm test passes
- renderPendingPrompt with missing step ID returns error (not fallback)
- renderPendingPromptOrDefault no longer exists
- start.ts and replay.ts handle prompt rendering errors explicitly
- Invalid workflows are logged with structured error messages (console.error)
- listWorkflowSummaries() never includes invalid workflows

STYLE:
- Use neverthrow error handling (no exceptions)
- Error collector uses console.error (can be replaced with structured logging later)
- Follow existing error-handling patterns in handlers

When complete, run tests and create git commit:
"Phase 4: Eliminate silent hiding

- Prompt renderer now fails hard on missing step ID
- Deleted renderPendingPromptOrDefault (silent degradation wrapper)
- start.ts and replay.ts handle prompt errors explicitly
- Added ValidationErrorCollector to SchemaValidatingWorkflowStorage
- Invalid workflows logged with structured error messages
- listWorkflowSummaries fixed to exclude invalid workflows"
```

**Human verification:**
1. Run `npm test`
2. Check that `renderPendingPromptOrDefault` doesn't exist (grep for it)
3. Create a test workflow with invalid step reference, verify error is logged
4. Check that `start.ts` has explicit error handling for prompt rendering

---

### Stage 4: Regression Tests (Phase 5)

**Goal**: Lock down all gaps with 39 regression tests.

**Prompt for WorkRail Subagent:**

```
Implement Phase 5 of god-tier workflow validation: Regression Test Suite.

CONTEXT:
- Phases 1-4 must be complete
- Read docs/plans/god-tier-validation-implementation-plan.md lines 702-800 (Phase 5)
- Read docs/plans/god-tier-validation-design-part2.md lines 600-700
- Create 39 tests that prove every identified gap is closed

DELIVERABLES:
1. New file: tests/unit/validate-workflow-registry.test.ts
   - Use vitest (describe, it, expect)
   - Create fakes for deps (don't use real filesystem)
   - Implement all 39 test cases from the plan (lines 702-760 in implementation plan)
   - Tests organized by category: Discovery, Variant Resolution, Normalization, Round-Trip, Compilation, Startability, Silent Hiding, Exhaustive Reporting, Pipeline Consolidation

2. Create test fakes:
   - tests/fakes/workflow.fake.ts (if doesn't exist): createFakeWorkflow()
   - tests/fakes/validation-deps.fake.ts: createFakeValidationDeps()
   - tests/fakes/registry-snapshot.fake.ts: createFakeRegistrySnapshot()

SAMPLE TESTS (from design doc):
- Test 1: Two workflows same ID different sources → duplicate reported
- Test 2: wr.* in bundled + user → bundled wins, reported but not error
- Test 15: Valid workflow → interpreter.next returns pending step
- Test 16: All steps runCondition: false → startability_failed (no_reachable_step)
- Test 17b: steps[0].id not in executable → startability_failed (first_step_not_in_executable)
- Test 19: renderPendingPrompt missing step → error not fallback
- Test 19b: renderPendingPromptOrDefault deleted

ACCEPTANCE CRITERIA:
- All 39 tests pass
- Tests use fakes, not real filesystem
- Each test is named by the gap it closes
- Fast execution (< 5 seconds for full suite)
- Tests are hermetic (no external dependencies)

When complete, run tests and create git commit:
"Phase 5: 39 regression tests for validation gaps

- Created validate-workflow-registry.test.ts with full coverage
- Tests for: discovery, duplicates, variants, normalization, round-trip, compilation, startability, silent hiding
- All tests use fakes (hermetic, fast)
- Each test named by gap number from audit"
```

**Human verification:**
1. Run `npm test tests/unit/validate-workflow-registry.test.ts`
2. All 39 tests should pass
3. Check test execution time (should be < 5 seconds)

---

### Stage 5: Lifecycle Harness MVP (Phase 6)

**Goal**: Prove 3 bundled workflows can execute start-to-completion without workflow-definition errors.

**Prompt for WorkRail Subagent:**

```
Implement Phase 6 of god-tier workflow validation: Lifecycle Execution Harness (MVP).

CONTEXT:
- Phases 1-5 must be complete
- Read docs/plans/god-tier-validation-implementation-plan.md lines 802-900 (Phase 6)
- Read docs/plans/god-tier-validation-design-part2.md lines 700-800
- Start with 3 simple workflows, not a general framework (YAGNI)

DELIVERABLES:
1. New file: tests/lifecycle/lifecycle-harness.ts
   - Copy types from design doc: WorkflowFixture, StepFixture, LifecycleTestResult
   - Implement executeWorkflowLifecycle() function
   - Steps: validate → create initial state → loop (interpreter.next → apply fixture → applyEvent) → verify terminal

2. New file: tests/lifecycle/fixtures/test-session-persistence.fixture.ts
   - Inline workflow definition (copy from workflows/test-session-persistence.json if it exists)
   - Per-step fixture data (notesMarkdown, artifacts, context)
   - Expected terminal state: 'complete'

3. New file: tests/lifecycle/fixtures/workflow-diagnose-environment.fixture.ts
   - Same pattern as above

4. New file: tests/lifecycle/fixtures/test-artifact-loop-control.fixture.ts
   - Same pattern, but includes loop iteration fixtures

5. New file: tests/lifecycle/test-session-persistence.test.ts
   - Import harness and fixture
   - One test: executeWorkflowLifecycle → expect success

6. New file: tests/lifecycle/workflow-diagnose-environment.test.ts
   - Same pattern

7. New file: tests/lifecycle/test-artifact-loop-control.test.ts
   - Same pattern

ACCEPTANCE CRITERIA:
- All 3 lifecycle tests pass
- Each test drives workflow from start to isComplete: true
- No workflow-definition errors during execution
- Fixtures are inline (hermetic), not loaded from filesystem
- Tests use real WorkflowCompiler and WorkflowInterpreter (not fakes)

STYLE:
- Keep fixtures minimal — just enough to advance each step
- Use YAGNI — no abstractions until 3+ workflows need the same pattern
- Fixtures are TypeScript files (type-safe), not JSON

When complete, run tests and create git commit:
"Phase 6 MVP: Lifecycle harness + 3 workflow fixtures

- Created lifecycle execution harness
- Implemented fixtures for 3 bundled workflows
- All workflows execute start-to-completion without errors
- Fixtures are inline and hermetic"
```

**Human verification:**
1. Run `npm test tests/lifecycle/`
2. All 3 tests should pass
3. Check that fixtures are type-safe TypeScript (not JSON)

---

### Stage 6: Lifecycle Expansion (Waves)

**Goal**: Add fixtures for all remaining bundled workflows. Achieve 100% coverage.

**Prompt for WorkRail Subagent:**

```
Expand Phase 6 lifecycle coverage: add fixtures for all remaining bundled workflows.

CONTEXT:
- Phase 6 MVP must be complete (3 workflows have fixtures)
- Read docs/plans/god-tier-validation-implementation-plan.md success metrics (line 100: 100% bundled workflows)
- Goal: every workflow in workflows/ directory has a lifecycle test

STRATEGY:
Work in waves of 3-5 workflows at a time. For each wave:
1. List the next 3-5 workflows in workflows/ that don't have fixtures yet
2. For each workflow:
   - Create tests/lifecycle/fixtures/<workflow-id>.fixture.ts
   - Inline the workflow definition
   - Add minimal per-step fixtures (just enough to advance)
   - Create tests/lifecycle/<workflow-id>.test.ts
3. Run tests — if any workflow-definition errors appear, fix the workflow (not the harness)

DELIVERABLES (per wave):
- 3-5 new fixture files
- 3-5 new test files
- All tests pass
- Git commit per wave

Continue until all bundled workflows have fixtures.

ACCEPTANCE CRITERIA (final):
- 100% of bundled workflows have lifecycle tests
- All lifecycle tests pass
- Success metric achieved: "Bundled workflows with completion fixture tests: 100%"
```

**Human verification:**
1. Run `npm test tests/lifecycle/`
2. Check that every workflow in `workflows/` has a corresponding fixture
3. All tests pass

---

### Stage 7: Architectural Completion (Required Follow-Ups)

**Goal**: Deliver the 3 required follow-ups to achieve mission completion.

This stage is NOT part of the initial implementation. It's documented for future work after Stages 1-6 are complete and stabilized.

**Follow-Up 1: ValidatedWorkflow Runtime Type Gate**

```
Add ValidatedWorkflow as runtime type gate.

CONTEXT:
- See docs/plans/god-tier-validation-implementation-plan.md lines 1670, 642-646
- Currently ValidatedWorkflow exists but runtime doesn't require it
- Change start.ts and runtime handlers to accept ValidatedWorkflow instead of Workflow

DELIVERABLES:
- Refactor start.ts to run validation pipeline before loadAndPinWorkflow
- Change function signatures to require ValidatedWorkflow
- Update all call sites

CHALLENGE: Performance — this adds validation latency to start_workflow
SOLUTION: Consider caching validated workflows or async pre-validation
```

**Follow-Up 2: Phase 4 Option A (Remove Runtime Filtering)**

```
Remove silent filtering from SchemaValidatingWorkflowStorage.

CONTEXT:
- See docs/plans/god-tier-validation-implementation-plan.md line 1672
- Currently runtime filters invalid workflows silently (Option B)
- Change to fail loudly (Option A)

DELIVERABLES:
- Remove filtering logic from SchemaValidatingWorkflowStorage
- Make getWorkflowById() return error (not null) for invalid workflows
- Update all runtime consumers to handle validation errors gracefully
```

**Follow-Up 3: Prompt Rendering in Validation Pipeline**

```
Add renderPendingPrompt as startability sub-check.

CONTEXT:
- See docs/plans/god-tier-validation-implementation-plan.md line 1674
- Currently validation checks compilation + interpreter but not prompt rendering
- Add renderPendingPrompt() call to validateStartability()

DELIVERABLES:
- Extend validateStartability() to call renderPendingPrompt on first step
- Add 'prompt_render_failed' variant to StartabilityFailure
- Tests for prompt rendering failures
```

---

## Tips for Working with the WorkRail Subagent

### 1. **Break large phases into sub-tasks**

If the subagent struggles with a large phase, break it down:
- Phase 2 could be: (a) create snapshot types, (b) extract shared functions, (c) build validator
- Each sub-task gets its own prompt

### 2. **Reference the design docs explicitly**

Always include in your prompt:
```
Reference: docs/plans/god-tier-validation-design.md lines X-Y for exact type signatures.
Copy the types EXACTLY — do not modify them.
```

### 3. **Verify after each stage**

Don't proceed to the next stage until:
- Tests pass
- You've manually verified the key deliverables
- Git commit is created

### 4. **Use the checkpoint strategy**

Each stage is a separate merge. Don't skip ahead.

### 5. **If the subagent gets stuck**

Common issues and fixes:
- **"Can't find the file"**: Give it the full absolute path
- **"Type error"**: Point it to the design doc line number with the exact type
- **"Tests failing"**: Ask it to read the test output and fix the specific error
- **"Lost context"**: Re-provide the key design doc sections in a follow-up prompt

---

## Expected Timeline

Assuming the WorkRail subagent works efficiently:

| Stage | Estimated Time | Checkpoints |
|-------|---------------|-------------|
| 1a | 2-4 hours | Pipeline skeleton works, tests pass |
| 1b | 3-5 hours | Full pipeline, resolveFirstStep extracted, start.ts refactored |
| 2 | 4-6 hours | Registry snapshot, shared functions, validator, CI script |
| 3 | 2-3 hours | Prompt rendering fixes, error collector |
| 4 | 2-3 hours | 39 regression tests |
| 5 | 3-4 hours | 3 lifecycle fixtures |
| 6 | 6-10 hours | Remaining lifecycle fixtures (depends on workflow count) |

**Total: 22-35 hours** of subagent execution time, spread across 6-7 separate invocations (one per stage).

---

## Success Criteria (How You Know It's Done)

After all 6 stages:

1. ✅ `npm run validate:workflows` validates full registry under 4 variants
2. ✅ All bundled workflows pass full 8-phase pipeline
3. ✅ Duplicate IDs are detected and reported
4. ✅ All raw files get Tier 1 validation
5. ✅ 39 regression tests pass
6. ✅ 100% of bundled workflows have lifecycle tests
7. ✅ All lifecycle tests pass (workflows drive to completion)
8. ✅ No silent hiding (errors logged with structured messages)
9. ✅ Runtime uses shared functions (resolveFirstStep, resolveWorkflowCandidates, findWorkflowJsonFiles)
10. ✅ Success metric achieved: **Zero runtime workflow-definition errors for bundled workflows**

---

## Troubleshooting

### Problem: Tests fail after Phase 1a

**Solution**: The pipeline consolidation might have changed validation behavior slightly. Check:
- Did you extract normalization correctly from ValidationEngine?
- Is the pipeline calling all 4 phases in the right order?
- Are the error types mapping correctly to ValidationResult?

### Problem: Runtime tests fail after Phase 2

**Solution**: The storage refactors should be behavior-preserving. Check:
- Does resolveWorkflowCandidates() use the same source priority?
- Does findWorkflowJsonFiles() scan recursively the same way?
- Are the function signatures matching what the storage classes expect?

### Problem: Lifecycle tests fail in Phase 6

**Solution**: This likely means a workflow-definition error exists. Check:
- What's the error message from the lifecycle harness?
- Does the workflow pass the full 8-phase pipeline?
- Is the fixture data complete (all steps have fixtures)?

### Problem: WorkRail subagent says "I can't implement this"

**Solution**: The prompt might be too vague. Try:
- Breaking the task into smaller pieces
- Providing exact line numbers from the design docs
- Asking it to read specific files first before implementing

---

## Final Notes

This is a **large, multi-phase implementation** (12-15 new files, 13 edited files). The checkpoint strategy is critical — don't skip ahead.

**Use the WorkRail subagent for all implementation work.** It has access to:
- The full codebase
- The plan documents
- The design documents
- Test execution
- Git commit creation

Your role is to:
1. Provide clear prompts (use the templates above)
2. Verify each stage after completion
3. Merge each checkpoint before proceeding

Good luck! The design is complete — execution should be straightforward if you follow the stage-by-stage strategy.
