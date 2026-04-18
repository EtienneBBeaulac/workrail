# Design Candidates: Regression Test for delivery_failed->success Bug (PR #580)

**Date:** 2026-04-18
**Status:** Ready for main-agent review

---

## Problem Understanding

**Tensions:**
- `delivery_failed` is part of `WorkflowRunResult` for TriggerRouter compatibility but is architecturally unreachable from `runWorkflow()` directly. Testing the assertNever guard requires bypassing the type system via `as any` cast - intentional and documented.
- Testing an "impossible" runtime state means deliberately constructing a value the type system forbids. The `as any` cast is the correct signal.

**Likely seam:** The end of the `describe('makeSpawnAgentTool() result mapping')` block in `tests/unit/workflow-runner-spawn-agent.test.ts`, before the closing `});`.

**What makes it hard:** Nothing technically hard. Key insight: `delivery_failed` cannot be passed to `makeRunWorkflowStub` (typed to `ChildWorkflowRunResult`) - must use inline stub with `as any`.

---

## Philosophy Constraints

- `exhaustiveness everywhere` - assertNever is the correct compile-time guard
- `prefer fakes over mocks` - inline async stub, not vi.fn() mock
- `document why not what` - test description explains the regression intent
- `type safety as first line of defense` - the `as any` cast is explicitly bypassing type safety to test the runtime guard (justified)

No philosophy conflicts between CLAUDE.md and repo patterns.

---

## Impact Surface

- Test file only: `tests/unit/workflow-runner-spawn-agent.test.ts`
- No production code changes
- No new imports required (all helpers and types already imported)
- No nearby consumers affected

---

## Candidates

### Candidate 1: Append provided test verbatim (recommended)

**Summary:** Add the user-provided test case inside the existing describe block, just before the closing `});`.

**Tensions resolved:** Correctly tests the assertNever guard using `as any` to simulate the impossible delivery_failed state.

**Tensions accepted:** Deliberately bypasses ChildWorkflowRunResult type safety (the `as any` is intentional and documented with eslint-disable comment).

**Boundary:** Test file only. No production changes.

**Why this boundary is best-fit:** The regression is in result mapping logic inside makeSpawnAgentTool. The test exercises exactly that path.

**Failure mode:** If makeSpawnAgentTool returns before calling runWorkflowFn when continueToken is undefined. Disproved by existing error/timeout tests with same setup.

**Repo-pattern relationship:** Follows exactly - inline stub pattern, eslint-disable comment before as-any, beforeEach provides mockExecuteStartWorkflow.

**Gains:** Documents the regression; verifies assertNever fires; prevents future regressions.

**Losses:** None.

**Scope judgment:** Best-fit.

**Philosophy fit:** Honors exhaustiveness everywhere, prefer fakes over mocks, document why not what.

### Candidate 2: Use makeRunWorkflowStub helper

**Summary:** Use `makeRunWorkflowStub(deliveryFailedResult)` like the other tests.

**Why this fails:** `makeRunWorkflowStub` has return type `ChildWorkflowRunResult` which excludes `delivery_failed`. TypeScript compile error. Not a real candidate.

---

## Comparison and Recommendation

All candidates converge on Candidate 1. There is no architectural choice to make - the provided snippet is the only valid approach.

**Recommendation:** Append the provided test verbatim. Switch to branch `fix/spawn-agent-result-handling`, edit the test file, run vitest, push, merge.

---

## Self-Critique

**Strongest counter-argument:** None meaningful.

**Pivot condition:** None identified.

**Assumption that would invalidate design:** makeSpawnAgentTool returns early before runWorkflowFn when continueToken is undefined. Disproved by existing passing tests with identical setup.

---

## Open Questions for the Main Agent

None. Proceed directly to implementation.
