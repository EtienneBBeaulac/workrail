# Implementation Plan: Regression Test for delivery_failed->success Bug (PR #580)

**Date:** 2026-04-18

---

## 1. Problem Statement

`makeSpawnAgentTool()` in `src/daemon/workflow-runner.ts` had an else branch that silently mapped `delivery_failed` to `outcome: 'success'`, corrupting the parent LLM's context. The fix (already on branch `fix/spawn-agent-result-handling`) replaces that branch with `assertNever(childResult)`. This plan adds one regression test to verify the assertNever guard fires when `delivery_failed` is injected.

---

## 2. Acceptance Criteria

- One new test case in `tests/unit/workflow-runner-spawn-agent.test.ts` inside `describe('makeSpawnAgentTool() result mapping')`
- Test description: `throws via assertNever when runWorkflow returns delivery_failed -- regression: old code silently mapped this to success`
- `tool.execute('call-1', FAKE_PARAMS)` rejects with error matching `'Unexpected value'`
- `npx vitest run tests/unit/workflow-runner-spawn-agent.test.ts` passes (all 6 tests, was 5)
- Commit pushed to `fix/spawn-agent-result-handling`
- PR #580 merged via `gh pr merge 580 --squash`

---

## 3. Non-Goals

- No production code changes
- No new imports (all needed types/functions are already imported)
- No new test helpers
- No changes to other test files

---

## 4. Philosophy-Driven Constraints

- Inline async stub (prefer fakes over mocks): `const stub = async () => deliveryFailedResult as any`
- `eslint-disable-next-line @typescript-eslint/no-explicit-any` before the as-any cast
- Test description names the regression explicitly (document why not what)

---

## 5. Invariants

- `assertNever` in `src/runtime/assert-never.ts` throws `new Error('Unexpected value: ' + JSON.stringify(x))`
- `delivery_failed` is excluded from `ChildWorkflowRunResult` -- the cast is required to simulate it
- `beforeEach` sets up `mockExecuteStartWorkflow` to return a successful fake start result for all tests
- `continueToken: undefined` in fake start result causes makeSpawnAgentTool to skip parseContinueToken but still call runWorkflowFn

---

## 6. Selected Approach

Append the provided test verbatim to the `describe('makeSpawnAgentTool() result mapping')` block, just before the closing `});`.

Runner-up: none (makeRunWorkflowStub cannot be used -- delivery_failed excluded from ChildWorkflowRunResult type).

---

## 7. Vertical Slices

### Slice 1: Add regression test

- File: `tests/unit/workflow-runner-spawn-agent.test.ts` on branch `fix/spawn-agent-result-handling`
- Action: Append test case before closing `});` of the describe block
- AC: vitest passes with 6 tests (was 5)

### Slice 2: Push and merge

- Push to `fix/spawn-agent-result-handling`
- Run `gh pr merge 580 --squash`
- AC: PR #580 shows as merged

---

## 8. Test Design

One new `it()` case:
- Constructs `deliveryFailedResult` with `_tag: 'delivery_failed'`
- Creates inline stub: `const stub = async () => deliveryFailedResult as any`
- Calls `makeSpawnAgentTool('sess-1', FAKE_CTX, FAKE_API_KEY, 'parent-session-id', 0, 3, stub, FAKE_SCHEMAS)`
- Asserts: `await expect(tool.execute('call-1', FAKE_PARAMS)).rejects.toThrow('Unexpected value')`

---

## 9. Risk Register

- Branch conflict on merge: unlikely (main has no changes to test file); user instructions cover rebase if needed

---

## 10. PR Packaging Strategy

SinglePR: PR #580 already exists. Add test, push, squash merge.

---

## 11. Philosophy Alignment

- exhaustiveness everywhere -> satisfied (assertNever guard verified by test)
- prefer fakes over mocks -> satisfied (inline async stub)
- document why not what -> satisfied (test description names regression)
- type safety -> acceptable tension (as-any required to test impossible state)
- make illegal states unrepresentable -> satisfied (ChildWorkflowRunResult excludes delivery_failed)

---

## Metadata

- `implementationPlan`: Add one regression test to existing test file, push, squash merge PR #580
- `slices`: [add-test, push-and-merge]
- `testDesign`: one new it() case using inline stub with as-any cast
- `estimatedPRCount`: 1
- `followUpTickets`: none
- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
