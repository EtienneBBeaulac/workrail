# Implementation Plan: Fix spawn_agent delivery_failed result handling

**Branch:** `fix/spawn-agent-result-handling`
**Status:** Ready for implementation.

---

## Problem Statement

`makeSpawnAgentTool` in `src/daemon/workflow-runner.ts` maps the `delivery_failed` result variant to `outcome: 'success'` when constructing the structured result returned to the parent LLM. This is wrong: a parent LLM that receives `outcome: 'success'` will proceed as if the child session completed normally, even though an unexpected/impossible state was reached.

The bug is in the `else` branch of the result-mapping block (lines 1572-1579). The branch is architecturally unreachable -- `runWorkflow()` never produces `delivery_failed` (only `TriggerRouter` does, post-HTTP-callback). But the `else` fallthrough silently maps it to success rather than surfacing it as an error.

---

## Acceptance Criteria

1. `delivery_failed` does NOT map to `outcome: 'success'` in `makeSpawnAgentTool`.
2. A `ChildWorkflowRunResult` type alias is exported from `workflow-runner.ts` representing the 3 variants `runWorkflow()` actually returns: `WorkflowRunSuccess | WorkflowRunError | WorkflowRunTimeout`.
3. The result-mapping block uses explicit if-else branches over `ChildWorkflowRunResult` variants only, with `assertNever` in the else position.
4. The WHY comment on the result-mapping block accurately describes the architectural invariant (runWorkflow() never returns delivery_failed; only TriggerRouter does).
5. The existing `delivery_failed not expected here` comments in `console-routes.ts` and `trigger-router.ts` are updated to explain why they use soft handling (unlike spawn_agent, they have no user-visible consequence).
6. New test file `tests/unit/workflow-runner-spawn-agent.test.ts` exists and covers:
   - success -> `{ outcome: 'success', notes: <lastStepNotes> }`
   - error -> `{ outcome: 'error', notes: <message> }`
   - timeout -> `{ outcome: 'timeout', notes: <message> }`
   - depth limit exceeded -> `{ outcome: 'error', childSessionId: null }`
   - startResult failure -> `{ outcome: 'error', childSessionId: null }`
7. All existing tests pass.

---

## Non-Goals

- Do NOT change `TriggerRouter`'s delivery logic.
- Do NOT remove `delivery_failed` from `WorkflowRunResult` globally.
- Do NOT change `runWorkflow()`'s declared return type (Candidate 3 -- out of scope for this fix).
- Do NOT add retry logic for HTTP callback delivery.
- Do NOT modify the tool's description string (it already lists `'success'|'error'|'timeout'` correctly).

---

## Philosophy-Driven Constraints

- **Make illegal states unrepresentable:** `delivery_failed` must be excluded from the type at the spawn_agent call site. Use `ChildWorkflowRunResult` alias for this.
- **Exhaustiveness everywhere:** Use `assertNever(childResult)` in the else branch, not an implicit fallthrough.
- **Errors are data:** Impossible/unexpected states must surface as errors, not be silently mapped to success.
- **Document "why", not "what":** WHY comments must explain the architectural invariant, not just the mechanics.
- **Type safety as the first line of defense:** Compile-time exhaustiveness over the 3 real variants is the primary guard.

---

## Invariants

1. `runWorkflow()` never returns `delivery_failed` -- only `TriggerRouter` does, post-HTTP-callback.
2. Child sessions spawned by `spawn_agent` bypass `TriggerRouter` and have no `callbackUrl`.
3. The parent LLM must never receive `outcome: 'success'` for an impossible or unexpected state.
4. `ChildWorkflowRunResult` must be a strict subset of `WorkflowRunResult` (no new result types).

---

## Selected Approach

**Candidate 2: ChildWorkflowRunResult alias + cast + assertNever**

1. Export `type ChildWorkflowRunResult = WorkflowRunSuccess | WorkflowRunError | WorkflowRunTimeout` from `workflow-runner.ts`, placed near `WorkflowRunResult`. Include a WHY comment documenting the architectural invariant.
2. In `makeSpawnAgentTool.execute()`, cast `childResult` to `ChildWorkflowRunResult` immediately after the `runWorkflowFn(...)` call. Include a WHY comment on the cast.
3. Replace the implicit `else` fallthrough with `assertNever(childResult)`.
4. Import `assertNever` from `'../runtime/assert-never.js'` in `workflow-runner.ts`.
5. Update comments at the `delivery_failed not expected here` branches in `console-routes.ts` and `trigger-router.ts`.

**Runner-up:** Candidate 1 (minimal patch -- change `outcome: 'success'` to `'error'`). Loses because the type lie persists and the else fallthrough has no compile-time guard.

**Pivot condition:** If `runWorkflow()` gains a `callbackUrl` parameter and starts producing `delivery_failed` directly, switch to Candidate 3 (narrow `runWorkflow()`'s return type).

---

## Vertical Slices

### Slice 1: ChildWorkflowRunResult type + assertNever fix in workflow-runner.ts

**File:** `src/daemon/workflow-runner.ts`
**Changes:**
- Add `export type ChildWorkflowRunResult = WorkflowRunSuccess | WorkflowRunError | WorkflowRunTimeout` near `WorkflowRunResult` (line ~341), with WHY comment.
- Add `import { assertNever } from '../runtime/assert-never.js'` to the imports.
- In `makeSpawnAgentTool.execute()`, after the `runWorkflowFn(...)` call, add the cast: `const childResult = (await runWorkflowFn(...)) as ChildWorkflowRunResult`.
- Replace the implicit `else` branch body with `assertNever(childResult)`.
- Update the comment on the result-mapping block (lines 1546-1551) to accurately state the invariant.
- Replace the explicit variable declaration `let resultObj: { ... }` with `let resultObj: { childSessionId: string | null; outcome: 'success' | 'error' | 'timeout'; notes: string }` (unchanged -- it already correctly excludes delivery_failed from the outcome type).

**Done when:** TypeScript compiles without errors; `delivery_failed` branch is gone from the result-mapping block.

### Slice 2: Comment updates in console-routes.ts and trigger-router.ts

**Files:** `src/v2/usecases/console-routes.ts`, `src/trigger/trigger-router.ts`
**Changes (comment-only):**
- `console-routes.ts` line 638-641: add note explaining soft handling is intentional (log-only path, no user-visible outcome, unlike spawn_agent).
- `trigger-router.ts` line 679-681: same.

**Done when:** Both files updated with explanatory comments.

### Slice 3: New test file for makeSpawnAgentTool result mapping

**File:** `tests/unit/workflow-runner-spawn-agent.test.ts` (new)
**Coverage:**
- `success` result -> `{ outcome: 'success', notes: lastStepNotes }`
- `error` result -> `{ outcome: 'error', notes: message }`
- `timeout` result -> `{ outcome: 'timeout', notes: message }`
- Depth limit exceeded (before runWorkflow call) -> `{ outcome: 'error', childSessionId: null }`
- `executeStartWorkflow` failure (startResult.isErr()) -> `{ outcome: 'error', childSessionId: null }`

**Done when:** Tests pass; no existing tests are broken.

---

## Test Design

**Framework:** Existing test suite (vitest, based on `workflow-runner-*.test.ts` patterns).
**Pattern:** One describe block for `makeSpawnAgentTool`, one `it` per behavior.
**Stubs:** Inject a `runWorkflowFn` stub that returns the desired variant. Inject a minimal `ctx` with the required ports. No real LLM calls.

**Key test cases:**
```typescript
describe('makeSpawnAgentTool result mapping', () => {
  it('maps success to outcome: success with lastStepNotes', ...)
  it('maps error to outcome: error with message', ...)
  it('maps timeout to outcome: timeout with message', ...)
  it('returns error when depth limit exceeded', ...)
  it('returns error when executeStartWorkflow fails', ...)
})
```

Note: The `assertNever` branch for `delivery_failed` is not testable without casting in the test (since `ChildWorkflowRunResult` excludes it). The compile-time guard is the primary verification for that branch.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cast becomes stale (runWorkflow gains delivery_failed) | Low | Medium | WHY comment makes assumption visible; assertNever throws loudly |
| New WorkflowRunResult variant breaks assertNever | Low | Low | Compile error surfaces immediately |
| Test scaffolding for makeSpawnAgentTool is complex | Low | Low | Other workflow-runner tests show the pattern; reuse it |

---

## PR Packaging Strategy

**Single PR** on branch `fix/spawn-agent-result-handling`.

Contents:
- `src/daemon/workflow-runner.ts` -- type alias + import + cast + assertNever + updated comment
- `src/v2/usecases/console-routes.ts` -- comment update only
- `src/trigger/trigger-router.ts` -- comment update only
- `tests/unit/workflow-runner-spawn-agent.test.ts` -- new test file
- `docs/design/spawn-agent-failure-modes.md` -- discovery doc
- `docs/design/spawn-agent-failure-modes-design-review.md` -- design review doc
- `docs/design/spawn-agent-result-handling-implementation-plan.md` -- this file

---

## Philosophy Alignment Per Slice

### Slice 1 (ChildWorkflowRunResult + assertNever)
- Make illegal states unrepresentable -> **satisfied**: delivery_failed excluded from type at call site
- Exhaustiveness everywhere -> **satisfied**: assertNever guards all future variants
- Errors are data -> **satisfied**: impossible state throws, not silently succeeds
- Type safety as first line of defense -> **satisfied**: compile-time exhaustiveness over 3 real variants
- Document "why" not "what" -> **satisfied**: WHY comments on alias and cast
- YAGNI with discipline -> **tension**: one additional type alias; acceptable (documents existing invariant, not speculative)

### Slice 2 (Comment updates)
- Document "why" not "what" -> **satisfied**: explains intentional inconsistency between callsites

### Slice 3 (Tests)
- Prefer fakes over mocks -> **satisfied**: stub runWorkflowFn function, not mock framework
- Determinism over cleverness -> **satisfied**: each test exercises one result variant deterministically

---

## Plan Confidence: High

- `unresolvedUnknownCount`: 0
- `planConfidenceBand`: High
- `estimatedPRCount`: 1
- `followUpTickets`: Candidate 3 (narrow runWorkflow return type) if runWorkflow ever gains callbackUrl support -- not filed yet, documented as pivot condition.
