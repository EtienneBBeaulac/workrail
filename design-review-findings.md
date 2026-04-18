# Design Review Findings: Regression Test for delivery_failed Bug (PR #580)

**Date:** 2026-04-18
**Status:** Review complete

---

## Tradeoff Review

- `as any` cast to bypass ChildWorkflowRunResult type: acceptable. Confined to test only. Substring match `.toThrow('Unexpected value')` tolerates minor message changes. assertNever is called synchronously in the else branch.
- Relies on beforeEach mockExecuteStartWorkflow setup: acceptable. Vitest guarantees beforeEach runs before each test. Isolation confirmed by 5 existing passing tests.

---

## Failure Mode Review

- Test not reaching assertNever: disproved by existing timeout/error tests with identical setup.
- assertNever message format change: handled by substring match.
- Branch conflict on merge: user instructions cover this; main has no conflicting changes to the test file.

---

## Runner-Up / Simpler Alternative Review

No runner-up exists. The provided test is the simplest valid approach. makeRunWorkflowStub cannot be used because delivery_failed is not assignable to ChildWorkflowRunResult.

---

## Philosophy Alignment

- exhaustiveness everywhere: satisfied (assertNever guard verified)
- prefer fakes over mocks: satisfied (inline async stub)
- document why not what: satisfied (test description names the regression explicitly)
- type safety: acceptable tension (as-any required to test impossible state)
- make illegal states unrepresentable: satisfied (ChildWorkflowRunResult excludes delivery_failed)

---

## Findings

None. No red, orange, or yellow findings.

---

## Recommended Revisions

None. Proceed with the provided test snippet verbatim.

---

## Residual Concerns

None.
