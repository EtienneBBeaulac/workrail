# God-Tier Workflow Validation: Implementation Guide

This directory contains the complete specification for implementing god-tier workflow validation in WorkRail.

## Document Index

### 0. **Quick Start Guide** (`god-tier-validation-QUICKSTART.md`)

**START HERE.** Entry point for implementers.

Contains:
- TL;DR what to do right now
- Document map (which doc to read when)
- Mission summary + formal invariants
- Success checklist
- Next action

**Length**: ~200 lines
**Read time**: 5 minutes
**Status**: Complete

---

### 1. **Implementation Instructions** (`god-tier-validation-INSTRUCTIONS.md`)

**Implementation guide for using the WorkRail subagent.**

Contains:
- Overview of what you're building
- Document reading guide (which sections to read)
- How to use the WorkRail subagent
- Phase-by-phase instructions with subagent prompts
- Tips for working with the subagent
- Expected timeline (22-35 hours)
- Success criteria
- Troubleshooting guide

**Length**: ~600 lines
**Read time**: 15 minutes
**Status**: Complete

---

### 2. **Ready-to-Use Prompts** (`god-tier-validation-PROMPTS.md`)

**Copy-paste ready prompts for the WorkRail subagent.**

Contains:
- One complete prompt per stage (1a, 1b, 2, 3, 4, 5)
- Each prompt includes: context, deliverables, acceptance criteria, sample code
- Quick reference table for stage order
- Tips for breaking down large tasks

**Length**: ~800 lines
**Use**: Copy prompts during implementation
**Status**: Complete

---

### 3. **Implementation Plan** (`god-tier-validation-implementation-plan.md`)

**The master plan.** Read this first.

Contains:
- Mission statement + 4 formal invariants
- Success metrics (measurable outcomes)
- 3-tier validation model (File → Registry → Execution)
- 17 identified gaps in current validation
- 6 implementation phases with dependencies
- Required follow-ups (known incompleteness)
- Definition of done
- Migration/rollout strategy

**Length**: ~1800 lines
**Status**: Complete

---

### 4. **Detailed Design Part 1** (`god-tier-validation-design.md`)

**Concrete TypeScript signatures for Phases 1a, 1b, and partial Phase 2.**

Contains:
- Phase 1a: Pipeline skeleton (schema + structural + v1 + normalize)
  - `ValidationOutcomePhase1a` discriminated union
  - `validateWorkflowPhase1a()` function signature
  - Changes to `ValidationEngine` (extract normalization)
  - CLI rewiring (`validate-workflow-file.ts`, `validate-workflow-json.ts`)

- Phase 1b: Full pipeline (+ round-trip + v2 compilation + startability)
  - `ValidationOutcome` full discriminated union (8 variants)
  - `ValidatedWorkflow` type (the compile-time gate)
  - `StartabilityFailure` discriminated union
  - `validateWorkflow()` full 8-phase function
  - `resolveFirstStep()` shared function (new file: `start-construction.ts`)
  - Changes to `start.ts` (refactor to use shared `resolveFirstStep`)

- Phase 2: Registry snapshot types
  - `RegistrySnapshot` interface
  - `RawWorkflowFile`, `WorkflowCandidate`, `ResolvedWorkflow`
  - `buildRegistrySnapshot()` function
  - Shared resolution functions (`resolveWorkflowCandidates`, `findWorkflowJsonFiles`)

**Length**: ~600 lines
**Status**: Complete through Phase 1b + partial Phase 2

---

### 5. **Detailed Design Part 2** (`god-tier-validation-design-part2.md`)

**Continuation: Phases 2-6.**

Contains:
- Phase 2: Registry validation (continued)
  - `validateRegistry()` function
  - `Tier1Outcome` union (for raw files)
  - `ResolvedValidationEntry` and `RawFileValidationEntry`
  - `RegistryValidationReport` interface
  - Changes to `EnhancedMultiSourceWorkflowStorage` (extract shared logic)

- Phase 3: CI script replacement
  - `scripts/validate-workflows-registry.ts` (full implementation)
  - Variant iteration logic
  - Report formatting
  - Failure exit codes

- Phase 4: Eliminate silent hiding
  - Changes to `prompt-renderer.ts` (fail on missing step)
  - Delete `renderPendingPromptOrDefault`
  - Changes to `start.ts` and `replay.ts` (handle `Result` explicitly)
  - Changes to `SchemaValidatingWorkflowStorage` (add error collector)

- Phase 5: Regression tests
  - Test file structure (`validate-workflow-registry.test.ts`)
  - Sample test cases (tests 1, 2, 15, 16, 17b, 19, 19b)
  - Fake builders

- Phase 6: Lifecycle harness
  - `lifecycle-harness.ts` (fixture executor)
  - `WorkflowFixture` interface (inline workflow + step fixtures)
  - `LifecycleTestResult` discriminated union
  - `executeWorkflowLifecycle()` function
  - Sample fixture (`test-session-persistence.fixture.ts`)

**Length**: ~800 lines
**Status**: Complete

---

## Quick Navigation

### By Phase

| Phase | Plan Section | Design Doc | Key Deliverables |
|-------|--------------|-----------|------------------|
| 1a | Lines 309-400 | Part 1, lines 1-200 | Pipeline skeleton: `validateWorkflowPhase1a()`, CLI rewiring |
| 1b | Lines 309-400 | Part 1, lines 200-600 | Full pipeline: `validateWorkflow()`, `resolveFirstStep()`, startability |
| 2 | Lines 402-500 | Part 1 (partial) + Part 2, lines 1-300 | Registry snapshot, `validateRegistry()`, duplicate detection |
| 3 | Lines 502-600 | Part 2, lines 300-450 | CI script: `validate-workflows-registry.ts` |
| 4 | Lines 602-700 | Part 2, lines 450-600 | Silent hiding fixes: prompt renderer, error collector |
| 5 | Lines 702-800 | Part 2, lines 600-700 | Regression tests: 39 test cases |
| 6 | Lines 802-900 | Part 2, lines 700-800 | Lifecycle harness + fixtures |

### By File (New Files Created)

| File Path | Phase | Purpose |
|-----------|-------|---------|
| `src/application/services/workflow-validation-pipeline.ts` | 1a, 1b | Core validation pipeline (8 phases) |
| `src/v2/durable-core/domain/start-construction.ts` | 1b | Shared `resolveFirstStep()` function |
| `src/application/use-cases/registry-validation/registry-snapshot.ts` | 2 | Registry snapshot types |
| `src/application/use-cases/registry-validation/build-registry-snapshot.ts` | 2 | Snapshot builder |
| `src/application/use-cases/registry-validation/resolve-workflow-candidates.ts` | 2 | Shared cross-source resolution |
| `src/application/use-cases/registry-validation/find-workflow-json-files.ts` | 2 | Shared file discovery |
| `src/application/use-cases/registry-validation/validate-registry.ts` | 2 | Registry validator |
| `scripts/validate-workflows-registry.ts` | 3 | CI validation script |
| `tests/unit/validate-workflow-registry.test.ts` | 5 | Regression test suite |
| `tests/lifecycle/lifecycle-harness.ts` | 6 | Lifecycle execution harness |
| `tests/lifecycle/fixtures/*.fixture.ts` | 6 | Per-workflow fixtures |

### By File (Edited Files)

| File Path | Phases | Changes |
|-----------|--------|---------|
| `src/application/services/validation-engine.ts` | 1a | Extract normalization call |
| `src/application/validation.ts` | 1a | Add `validateWorkflowSchema()` wrapper |
| `src/application/use-cases/validate-workflow-file.ts` | 1a | Rewire to pipeline |
| `src/application/use-cases/validate-workflow-json.ts` | 1a | Rewire to pipeline |
| `src/mcp/handlers/v2-execution/start.ts` | 1b, 4 | Use `resolveFirstStep()`, handle prompt errors |
| `src/infrastructure/storage/enhanced-multi-source-workflow-storage.ts` | 2 | Extract `resolveWorkflowCandidates` |
| `src/infrastructure/storage/file-workflow-storage.ts` | 2 | Extract `findWorkflowJsonFiles` |
| `package.json` | 3 | Update `validate:workflows` script |
| `src/v2/durable-core/domain/prompt-renderer.ts` | 4 | Fail on missing step |
| `src/mcp/handlers/v2-execution-helpers.ts` | 4 | Delete `renderPendingPromptOrDefault` |
| `src/mcp/handlers/v2-execution/replay.ts` | 4 | Handle prompt errors |
| `src/infrastructure/storage/schema-validating-workflow-storage.ts` | 4 | Add error collector |

---

## Implementation Order

**Critical: follow the checkpoint strategy** (Plan lines 1742-1807):

1. **Stage 1a** (Phase 1a): Pipeline skeleton
   - Merge #1: consolidate existing validation
   - No new validation logic, just unification
   - Gate: all existing tests pass through new pipeline

2. **Stage 1b** (Phase 1b): Full pipeline
   - Merge #2: add round-trip, v2 compilation, startability
   - `resolveFirstStep()` extraction + `start.ts` refactor
   - Gate: all bundled workflows pass full 8-phase pipeline

3. **Stage 2** (Phases 2-3): Registry validation + CI
   - Merge #3: registry snapshot, duplicate detection, CI script
   - Shared function extractions (behavior-preserving refactors)
   - Gate: all bundled workflows valid under all feature-flag variants

4. **Stage 3** (Phase 4): Tighten runtime
   - Merge #4: prompt rendering fixes, error collector
   - `renderPendingPromptOrDefault` deletion
   - Gate: no silent hiding in logs

5. **Stage 4** (Phase 5): Regression tests
   - Merge #5: 39 regression tests
   - Gate: all tests green

6. **Stage 5** (Phase 6 MVP): Lifecycle seeding
   - Merge #6: harness + 3 workflow fixtures
   - Gate: 3 bundled workflows drive to completion

7. **Stage 6** (Phase 6 waves): Lifecycle expansion
   - Incremental: add fixtures for remaining bundled workflows
   - Goal: 100% coverage (Success Metrics table, Plan line 100)

8. **Stage 7** (Required Follow-Ups): Architectural completion
   - `ValidatedWorkflow` runtime type gate
   - Phase 4 Option A (remove runtime filtering)
   - Prompt rendering in validation pipeline

---

## Key Design Decisions (Cross-Referenced)

1. **Discriminated unions everywhere** (Philosophy constraint: exhaustiveness)
   - `ValidationOutcome` (8 variants)
   - `StartabilityFailure` (4 variants)
   - `Tier1Outcome` (4 variants)
   - `LifecycleTestResult` (4 variants)
   - `RawWorkflowFileContent` (2 variants)

2. **Shared pure functions** (Plan lines 54-68: Single Source of Resolution Truth)
   - `resolveFirstStep()` — runtime + validation
   - `resolveWorkflowCandidates()` — runtime storage + snapshot builder
   - `findWorkflowJsonFiles()` — FileWorkflowStorage + raw scanner

3. **Two-tier validation** (Plan lines 110-152: Validation Tiers)
   - Tier 1 (schema + structural) for ALL raw files
   - Tier 2 (full 8-phase pipeline) for resolved workflows
   - Tier 3 (lifecycle execution) for bundled workflows only

4. **Phase 4 Option B as temporary containment** (Plan line 1672)
   - Runtime keeps filtering (graceful degradation)
   - But adds structured error reporting (no silent hiding)
   - Option A (remove filtering) is Required Follow-Up

5. **`ValidatedWorkflow` deferred as runtime type gate** (Plan lines 642-646)
   - Type exists, pipeline produces it
   - But runtime doesn't require it (performance concern)
   - Deferred to Required Follow-Ups

---

## File Size Summary

- **Implementation Plan**: 1800 lines (human-readable strategy + phases)
- **Design Part 1**: 600 lines (TypeScript signatures for Phases 1a, 1b, partial 2)
- **Design Part 2**: 800 lines (TypeScript signatures for Phases 2-6)
- **Total specification**: ~3200 lines

---

## Next Steps

1. **Read the Implementation Plan first** to understand the mission, invariants, and strategy.
2. **Read Design Part 1** to see the exact types and functions for Phases 1a and 1b.
3. **Read Design Part 2** to see Phases 2-6.
4. **Start implementation at Stage 1a** (Phase 1a: pipeline skeleton).
5. **Follow the checkpoint strategy** — merge after each stage, don't skip ahead.

---

## Questions / Clarifications

If anything is unclear, cross-reference:
- **"Why this design?"** → Implementation Plan, Philosophy Alignment section (lines 264-280)
- **"What's the test coverage?"** → Implementation Plan, Success Metrics table (lines 95-106)
- **"What order do I implement?"** → Implementation Plan, Migration/Rollout Strategy (lines 1738-1820)
- **"What are the acceptance criteria?"** → Each Phase has an "Acceptance Criteria" section in the Plan

---

**Document Status**: All 3 documents complete as of 2026-03-08.
**Ready for implementation**: Yes
