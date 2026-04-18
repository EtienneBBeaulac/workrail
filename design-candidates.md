# Design Candidates: assertNever exhaustiveness guard for TriggerRouter

**Date:** 2026-04-18
**Status:** Ready for main-agent review

---

## Problem Understanding

### Core Tensions
1. **Runtime correctness vs compile-time safety**: Both `route()` and `dispatch()` have open `else` branches that assume `result._tag === 'error'`. They work today because `WorkflowRunResult` has exactly 4 variants and the first 3 are handled explicitly. Adding a 5th variant would silently route through the error-handling log path with no compiler warning.
2. **Soft handling rationale vs exhaustiveness**: The existing `dispatch()` code has a comment explaining WHY `delivery_failed` uses soft handling (log-only, no assertNever). The fix must not conflate this deliberate decision with the unguarded `else` for the `error` variant.
3. **DRY vs stability**: `workflow-source.ts` has a local `assertNever` that duplicates the canonical one. Consolidating it is trivial but is a separate concern.

### Likely Seam
The seam is exactly where identified: the final `else` branches in `route()` (line 604) and `dispatch()` (line 675) of `src/trigger/trigger-router.ts`. These are not symptoms of a deeper design flaw -- they are simply unguarded fallthrough branches that need an explicit tag check and an assertNever guard.

### What Makes This Hard
Almost nothing. The only non-obvious point: you cannot add `assertNever(result)` inside the existing `else` directly -- TypeScript would see `result: WorkflowRunError` (the one unhandled variant), not `never`. You must add `else if (result._tag === 'error') { ... }` first so TypeScript can narrow `result` to `never` in the subsequent `else { assertNever(result); }`.

---

## Philosophy Constraints

From `CLAUDE.md`:
- **Exhaustiveness everywhere** -- use discriminated unions so handling is complete and refactor-safe
- **Type safety as the first line of defense** -- prefer compile-time guarantees over runtime checks
- **Make illegal states unrepresentable** -- model domain states so invalid combinations cannot be constructed
- **YAGNI with discipline** -- avoid speculative abstractions; don't restructure working code without a concrete reason
- **Document why, not what** -- comments explain intent and invariants

**Conflicts:** None. All principles align toward Candidate 1.

---

## Impact Surface

- `src/trigger/trigger-router.ts`: 2 locations changed (route() + dispatch())
- `src/types/workflow-source.ts`: local assertNever removed, import added (bonus consolidation)
- No callers change -- these are internal logging branches with no return value
- `src/runtime/assert-never.ts`: read-only (adding a consumer, no changes)
- `tests/unit/trigger-router.test.ts`: existing tests verify the router behavior; no new tests needed for assertNever (unreachable at runtime)

---

## Candidates

### Candidate 1: Minimal fix -- else if + assertNever (recommended)

**Summary:** Add `else if (result._tag === 'error') { ... }` guard before the existing else body, then add `else { assertNever(result); }` after. Add the import at the top of the file.

**Tensions resolved:** Closes exhaustiveness gap with compile-time protection. Preserves all existing structure and comments.

**Tensions accepted:** If/else chains are slightly less idiomatic for discriminated unions than switch statements, but acceptable given existing code style.

**Boundary solved at:** Exact symptom location -- the open else branches. This IS the right seam; no deeper architectural change is needed.

**Failure mode:** If `WorkflowRunError._tag` is renamed from `'error'`, the `else if (result._tag === 'error')` will fail to compile -- which is correct behavior.

**Repo-pattern relationship:** Adapts the `workflow-runner.ts` assertNever pattern from switch/default to if/else form.

**Gains:** Compile-time exhaustiveness, minimal diff, zero behavior change.

**Losses:** None.

**Scope judgment:** Best-fit.

**Philosophy fit:** Honors exhaustiveness, type safety, YAGNI. No conflicts.

---

### Candidate 2: Refactor to switch statements + assertNever default

**Summary:** Convert both if/else chains to `switch (result._tag)` with explicit cases and `default: assertNever(result)`, matching the pattern in `workflow-runner.ts` lines 1571-1600.

**Tensions resolved:** Same exhaustiveness gap. More literal match to the workflow-runner.ts pattern.

**Tensions accepted:** More invasive change -- restructures 20+ lines of working code per location. Inline WHY comments for `delivery_failed` need careful migration into case blocks.

**Failure mode:** Risk of introducing a logic error or losing a comment during restructuring.

**Repo-pattern relationship:** Matches `workflow-runner.ts` switch pattern literally.

**Gains:** Possibly more idiomatic discriminated union matching.

**Losses:** Larger diff, higher risk surface, no additional compile-time benefit over Candidate 1.

**Scope judgment:** Too broad -- no concrete evidence that switch is required here.

**Philosophy fit:** Conflicts with YAGNI (restructuring working code without concrete benefit).

---

## Comparison and Recommendation

**Recommendation: Candidate 1.**

Both candidates achieve identical compile-time exhaustiveness. Candidate 1 does so with minimal diff surface and no restructuring of working code. CLAUDE.md's YAGNI principle directly supports not refactoring the if/else chains into switches when the only goal is adding an exhaustiveness guard.

---

## Self-Critique

**Strongest counter-argument:** If/else chains are less conventional for exhaustive discriminated-union matching than switch statements. Resolved with a comment following the workflow-runner.ts style.

**Pivot condition:** Switch refactor would be justified if a team standard explicitly required switch for discriminated unions. No such requirement exists.

**Invalidating assumption:** If TypeScript's narrowing failed to reduce `result` to `never` after explicit handling of all 4 variants -- not a real risk.

---

## Open Questions for the Main Agent

1. Should `console-routes.ts` (line 646) also be fixed? Task description only mentions trigger-router.ts. Decision: leave out of scope.
2. For `workflow-source.ts` consolidation: the local assertNever has a more specific error message (`Unexpected source kind`) vs the shared one (`Unexpected value`). Decision: shared message is sufficient; the source kind appears in JSON.stringify output anyway.
