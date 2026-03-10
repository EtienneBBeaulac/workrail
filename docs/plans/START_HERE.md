# God-Tier Workflow Validation: Implementation Start

## For the Implementer (Human or AI Agent)

You're implementing a **validation system that proves workflows are correct before runtime**.

---

## What to Read

1. **Mission & Invariants** (10 minutes)
   - File: `docs/plans/god-tier-validation-implementation-plan.md`
   - Read: Lines 3-88 (Mission, Formal Invariants, Single Source of Truth, Success Metrics)
   - This defines what "correct" means and the contract you're enforcing

2. **Full Implementation Plan** (reference as needed)
   - File: `docs/plans/god-tier-validation-implementation-plan.md`
   - Sections: Validation Tiers, all 6 Phase sections, Cross-Cutting Concerns, Migration Strategy
   - This is the master plan — explains why every decision was made

3. **TypeScript Signatures** (reference during implementation)
   - File: `docs/plans/god-tier-validation-design.md` (Phases 1a, 1b)
   - File: `docs/plans/god-tier-validation-design-part2.md` (Phases 2-6)
   - These have exact type signatures and function bodies — copy them directly

4. **Navigation** (when you need to find something)
   - File: `docs/plans/god-tier-validation-INDEX.md`
   - Quick lookup tables by phase, by file, by deliverable

---

## Implementation Strategy

**6 phases, executed sequentially**. Each phase is a separate merge.

| Phase | Goal | Scope | Estimated Time |
|-------|------|-------|---------------|
| 1a | Consolidate existing validation into one pipeline | 1 new file, 3 edits | 2-4 hours |
| 1b | Add missing validation phases (round-trip, startability) | 1 new file, 2 edits | 3-5 hours |
| 2-3 | Registry-centric validation + CI script | 5 new files, 2 edits, 1 script | 4-6 hours |
| 4 | Eliminate silent hiding | 0 new files, 5 edits | 2-3 hours |
| 5 | 39 regression tests | 1 new file + fakes | 2-3 hours |
| 6 | Lifecycle execution harness | 3+ new files | 3-4 hours |

**Total**: 22-35 hours across 6 phases

---

## The Work

Each phase has:
- **Acceptance criteria** (in the plan, under each phase section)
- **Concrete TypeScript** (in the design docs)
- **Test requirements** (in Phase 5)

**Key principle**: Validation and runtime must use **the same code paths** (shared functions). Extract, don't rewrite.

**Core deliverables**:
- 8-phase validation pipeline (`validateWorkflow()` function)
- Registry-centric validator (validates what runtime resolves)
- Shared functions: `resolveFirstStep()`, `resolveWorkflowCandidates()`, `findWorkflowJsonFiles()`
- CI script that validates under all feature-flag variants
- 39 regression tests
- Lifecycle execution harness

---

## Success Criteria

When complete:
- ✅ Zero runtime workflow-definition errors for bundled workflows
- ✅ 100% of bundled workflows pass full 8-phase pipeline
- ✅ 100% of bundled workflows have lifecycle tests
- ✅ All failures reported in one CI run (exhaustive)
- ✅ No silent hiding (errors are loud and structured)

---

## Current Branch

You are on: `feature/etienneb/god-tier-validation-impl-phase1a`

This branch has all planning docs and is ready for Phase 1a implementation.

---

## Next Action

**Start with Phase 1a**.

Read the plan (mission + Phase 1 section), read the design (Phase 1a types), then implement.

All the details you need are in the docs.
