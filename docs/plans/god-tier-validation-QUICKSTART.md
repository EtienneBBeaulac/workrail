# God-Tier Workflow Validation: Quick Start Guide

**For the implementer**: This is your entry point. Read this first.

---

## TL;DR - What to Do Right Now

1. **Read the mission** (5 minutes)
   - Open `god-tier-validation-implementation-plan.md`
   - Read lines 3-52 (Mission + Formal Invariants)
   - Understand: you're building a validator that proves workflows are correct before runtime

2. **Scan the navigation** (2 minutes)
   - Open `god-tier-validation-INDEX.md`
   - Skim the document structure
   - Note where things are located

3. **Execute Stage 1a** (2-4 hours via WorkRail subagent)
   - Open `god-tier-validation-PROMPTS.md`
   - Copy the "Stage 1a: Pipeline Skeleton" prompt
   - Invoke the WorkRail subagent with that prompt
   - Wait for completion, verify, merge

4. **Repeat for Stages 1b-6** (20-30 hours total)
   - One stage at a time
   - Merge after each stage
   - Follow the prompts exactly

---

## Document Map

You have **7 documents** in this directory:

| Document | Purpose | When to Read |
|----------|---------|--------------|
| **QUICKSTART.md** (this file) | Entry point, TL;DR | **Read first** |
| **INSTRUCTIONS.md** | Detailed implementation guide, tips | Read before Stage 1a |
| **PROMPTS.md** | Copy-paste ready prompts for WorkRail subagent | Use during implementation |
| **INDEX.md** | Navigation guide, cross-references | Reference as needed |
| **implementation-plan.md** | Master plan (1800 lines) | Read mission + invariants, reference during implementation |
| **design.md** | TypeScript signatures for Phases 1a, 1b, partial 2 | Reference while implementing Phases 1-2 |
| **design-part2.md** | TypeScript signatures for Phases 2-6 | Reference while implementing Phases 2-6 |

**Reading order:**
1. QUICKSTART.md (this file) - 5 minutes
2. INSTRUCTIONS.md - 15 minutes
3. implementation-plan.md (mission + invariants only) - 10 minutes
4. PROMPTS.md - ongoing reference during implementation

**Total reading time before starting**: ~30 minutes

---

## The Mission (Copy from Plan)

Make workflow validation the authoritative, runtime-equivalent gate for all workflows.

**Formal Invariants** (the contract you're enforcing):

1. **Any workflow-definition error encountered at runtime is a validator bug.**  
   If a workflow passes validation and then fails during execution due to a workflow-definition issue, the validator is broken.

2. **Runtime must never discover an error kind the validation pipeline cannot represent.**  
   Every possible workflow-definition error must have a variant in the `ValidationOutcome` union.

3. **`start_workflow(workflowId)` must validate the same resolved source and variant that CI validated.**  
   Validation and runtime must use the same resolution code paths.

4. **No consumer may answer "is this workflow valid?" without calling the unified pipeline.**  
   One pipeline, many consumers. No reimplementation.

**Success metric**: Zero runtime workflow-definition errors for bundled workflows.

---

## The Strategy (Checkpoint-Driven)

You'll implement this in **6 stages** (7 if you include follow-ups):

### Stage 1a: Pipeline Skeleton (Merge #1)
- **What**: Consolidate existing validation into one function
- **Why**: Unify scattered validation call sites
- **Scope**: 1 new file, 3 edits
- **Time**: 2-4 hours

### Stage 1b: Full Pipeline (Merge #2)
- **What**: Add 4 missing phases (round-trip, v2 compilation, startability)
- **Why**: Catch errors the current validator misses
- **Scope**: 1 new file, 2 edits
- **Time**: 3-5 hours

### Stage 2: Registry Validation + CI (Merge #3)
- **What**: Validate the registry (not individual files), replace CI script
- **Why**: Match runtime's multi-source, variant-aware resolution
- **Scope**: 5 new files, 2 edits, 1 script, 1 package.json change
- **Time**: 4-6 hours

### Stage 3: Eliminate Silent Hiding (Merge #4)
- **What**: Make errors loud, delete silent degradation wrappers
- **Why**: No hiding — all failures must be visible
- **Scope**: 0 new files, 5 edits
- **Time**: 2-3 hours

### Stage 4: Regression Tests (Merge #5)
- **What**: 39 tests that prove all gaps are closed
- **Why**: Lock down correctness, prevent regressions
- **Scope**: 1 new file + fakes
- **Time**: 2-3 hours

### Stage 5: Lifecycle Harness MVP (Merge #6)
- **What**: 3 workflows executed start-to-completion under fixtures
- **Why**: Prove workflows actually run without errors
- **Scope**: 7 new files (harness + 3 fixtures + 3 tests)
- **Time**: 3-4 hours

### Stage 6: Lifecycle Expansion (Incremental merges)
- **What**: Fixtures for all remaining bundled workflows
- **Why**: Achieve 100% coverage
- **Scope**: N files (depends on workflow count)
- **Time**: 6-10 hours

**Total: 22-35 hours**

---

## How to Execute (Step-by-Step)

### Step 1: Prepare Your Environment

```bash
# Ensure you're on main and up-to-date
git checkout main
git pull origin main

# Verify tests pass before starting
npm test

# Verify current validation works
npm run validate:workflows
```

### Step 2: Invoke WorkRail Subagent for Stage 1a

Open your AI coding assistant and say:

> "I need to implement Stage 1a of god-tier workflow validation. Use the WorkRail subagent (task tool with subagent_type: 'workrail-executor').
>
> The prompt is in `docs/plans/god-tier-validation-PROMPTS.md` under "Stage 1a: Pipeline Skeleton". Copy that entire prompt and use it to invoke the subagent."

The AI will invoke the WorkRail subagent, which will:
- Read the plan and design docs
- Create the pipeline file
- Edit the 3 existing files
- Run tests
- Create a git commit

### Step 3: Verify Stage 1a

After the subagent completes:

```bash
# Run tests
npm test

# Verify the pipeline file exists
ls -lh src/application/services/workflow-validation-pipeline.ts

# Check the commit
git log -1 --stat

# Verify CLI uses new pipeline
npm run validate -- workflows/test-session-persistence.json
```

If everything looks good, merge:

```bash
git push origin HEAD
# Create PR, get review, merge
```

### Step 4: Repeat for Stages 1b-6

For each subsequent stage:
1. Ensure previous stage is merged
2. Open `god-tier-validation-PROMPTS.md`
3. Copy the prompt for the next stage
4. Invoke WorkRail subagent with that prompt
5. Verify deliverables
6. Merge

---

## Key Principles (Keep These in Mind)

### 1. Same Code Path

Validation and runtime must use **the same functions**:
- ✅ `resolveFirstStep()` — shared (Stage 1b)
- ✅ `resolveWorkflowCandidates()` — shared (Stage 2)
- ✅ `findWorkflowJsonFiles()` — shared (Stage 2)
- ✅ `compileExecutable()` — already shared (used by both)
- ✅ `interpreter.next()` — already shared (used by both)

If validation reimplements any of these, it will drift from runtime. **Extract, don't rewrite.**

### 2. Discriminated Unions Everywhere

Every outcome type is a discriminated union with a `kind` field:
- `ValidationOutcome` (8 variants)
- `StartabilityFailure` (4 variants)
- `Tier1Outcome` (4 variants)
- `LifecycleTestResult` (4 variants)

This enables exhaustive switching and type-safe error handling.

### 3. Fail Fast, Fail Loud

No silent degradation:
- ❌ Before: `step?.title ?? stepId` (fallback)
- ✅ After: `if (!step) return err(...)` (fail fast)

No silent filtering without reporting:
- ❌ Before: Filter invalid workflows, return valid ones (silent)
- ✅ After: Filter, but call `errorCollector.report()` first (loud)

### 4. One Pipeline, Many Consumers

```
         ┌──> CLI validate
         │
Pipeline ┼──> MCP validate_workflow_json
         │
         ┼──> Registry validator (CI)
         │
         └──> Runtime assertions (future)
```

All consumers call the same `validateWorkflow()` function. No reimplementation.

---

## Common Pitfalls

### Pitfall 1: Skipping Stages

**Don't do this.** Each stage is a separate merge with standalone value. If you skip ahead:
- You can't verify intermediate deliverables
- If something breaks, you won't know which stage caused it
- You miss the safety checkpoints

### Pitfall 2: Rewriting Instead of Extracting

When Stage 2 says "extract `resolveWorkflowCandidates` from `EnhancedMultiSourceWorkflowStorage`":
- ❌ Don't rewrite the resolution logic from scratch
- ✅ Copy the exact logic from `loadAllWorkflows()` into the new function
- ✅ Then have `loadAllWorkflows()` call the extracted function

This ensures runtime and validation use **the same code**.

### Pitfall 3: Implementing Without Reading the Design Docs

The prompts reference specific line numbers in the design docs. If you just give the prompt to the subagent without ensuring it reads those lines:
- It might guess the types instead of copying them
- It might implement logic differently than specified
- You'll get subtle bugs

**Solution**: The prompts include "Read docs/..." instructions. Trust that the subagent will follow them.

### Pitfall 4: Not Verifying Each Stage

After each stage completes:
- ✅ Run tests
- ✅ Check the key deliverable exists
- ✅ Verify the git commit message is accurate
- ✅ Manually test the changed behavior

If you skip verification and proceed to the next stage, you might build on a broken foundation.

---

## What Success Looks Like

After Stage 6 (before follow-ups):

### Terminal Output

```bash
$ npm run validate:workflows

Starting registry-centric workflow validation...

=== Variant: default ===
  Resolved workflows: 15/15 valid
  Raw files: 18/18 passed Tier 1
  Duplicate IDs: 0
  ✓ test-session-persistence          bundled     schema:ok structural:ok v1-compile:ok normalize:ok roundtrip:ok v2-compile:ok start:ok
  ✓ workflow-diagnose-environment     bundled     schema:ok structural:ok v1-compile:ok normalize:ok roundtrip:ok v2-compile:ok start:ok
  ... and 13 more

=== Variant: v2-tools-enabled ===
  Resolved workflows: 15/15 valid
  Raw files: 18/18 passed Tier 1
  Duplicate IDs: 0
  ✓ coding-task-workflow-agentic.v2   bundled     schema:ok structural:ok v1-compile:ok normalize:ok roundtrip:ok v2-compile:ok start:ok
  ... and 14 more

=== Variant: agentic-routines-enabled ===
  Resolved workflows: 15/15 valid
  Raw files: 18/18 passed Tier 1
  Duplicate IDs: 0
  ... 

=== Variant: both-enabled ===
  Resolved workflows: 15/15 valid
  Raw files: 18/18 passed Tier 1
  Duplicate IDs: 0
  ...

=================================
✓ All workflows valid across all variants
```

### Test Output

```bash
$ npm test

 ✓ tests/unit/validate-workflow-registry.test.ts (39 tests) 2.3s
 ✓ tests/lifecycle/test-session-persistence.test.ts (1 test) 0.8s
 ✓ tests/lifecycle/workflow-diagnose-environment.test.ts (1 test) 0.7s
 ✓ tests/lifecycle/test-artifact-loop-control.test.ts (1 test) 1.2s
 ... all other tests ...

Test Files  XX passed (XX)
     Tests  XXX passed (XXX)
  Start at  HH:MM:SS
  Duration  XXs
```

### Git History

```bash
$ git log --oneline -7

abc1234 Phase 6 MVP: Lifecycle harness + 3 workflow fixtures
def5678 Phase 5: 39 regression tests for validation gaps
ghi9012 Phase 4: Eliminate silent hiding
jkl3456 Phase 2-3: Registry validation + CI script replacement
mno7890 Phase 1b: Complete 8-phase validation pipeline
pqr1234 Phase 1a: Consolidate validation into pipeline skeleton
stu5678 (previous work)
```

---

## How to Get Help

### If the WorkRail subagent doesn't understand a prompt:

1. Check that all referenced documents exist
2. Provide specific line numbers from the design docs
3. Break the stage into smaller sub-tasks
4. Ask the subagent to read the relevant files first

### If tests fail after a stage:

1. Read the test output carefully
2. Check which test failed
3. Look up that test number in the implementation plan (it maps to a specific gap)
4. Ask the subagent to fix the specific test

### If you're unsure about a design decision:

1. Search the implementation plan for the relevant section
2. Check if it's addressed in the Philosophy Alignment section
3. Check if it's in Cross-Cutting Concerns
4. If still unclear, refer to the formal invariants (lines 14-52 in the plan)

---

## Checklist (Before You Start)

- [ ] I've read this QUICKSTART guide
- [ ] I've skimmed INSTRUCTIONS.md
- [ ] I've read the Mission and Formal Invariants in implementation-plan.md
- [ ] I have access to the WorkRail subagent
- [ ] I'm on the main branch with all tests passing
- [ ] I understand the checkpoint strategy (one stage at a time, merge before proceeding)

If all boxes are checked, **you're ready to start Stage 1a**.

---

## Next Action

Open `god-tier-validation-PROMPTS.md`, copy the Stage 1a prompt, and invoke the WorkRail subagent.

Good luck! The design is complete and ready to execute.
