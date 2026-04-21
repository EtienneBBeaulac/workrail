> Note: worktrain trigger poll was removed in PR #755.

# Implementation Plan: Bypass Dispatch Dedup for Pre-Allocated Sessions

**Date:** 2026-04-19
**Branch:** fix/dispatch-dedup-prealloc-bypass
**Scope:** src/trigger/trigger-router.ts only (src/mcp/ excluded)

---

## 1. Problem Statement

`TriggerRouter.dispatch()` has a 30-second deduplication guard that compares incoming
`goal::workspacePath` against `_recentAdaptiveDispatches`. When `dispatchAdaptivePipeline()`
runs, it writes this key. Milliseconds later, `spawnSession()` calls `dispatch()` with the same
goal and workspace (plus `_preAllocatedStartResponse`). The dedup guard fires, `queue.enqueue()`
is never called, and the session that was already written to the store by `executeStartWorkflow()`
zombies permanently.

---

## 2. Acceptance Criteria

1. `dispatch()` called with `_preAllocatedStartResponse` set bypasses the dedup check and calls
   `runWorkflowFn` exactly once.
2. `dispatch()` called WITHOUT `_preAllocatedStartResponse` still deduplicates correctly within 30s.
3. `npm run build` exits clean (no TypeScript errors).
4. `npx vitest run tests/unit/trigger-router.test.ts` -- all tests pass including two new tests.
5. `npx vitest run` -- no regressions in any other test file.
6. PR merged to main via `gh pr merge <N> --squash`.
7. Daemon rebuilt and reinstalled (`npm run build && node dist/cli-worktrain.js daemon --install`).
8. `node dist/cli-worktrain.js trigger poll self-improvement` starts a session and `session_started`
   appears in the event log within 30s.

---

## 3. Non-Goals

- Do NOT touch `src/mcp/` (any file).
- Do NOT implement Option B (remove dedup from dispatch() entirely).
- Do NOT implement Option C (separate dedup maps).
- Do NOT touch `route()` or `dispatchAdaptivePipeline()`.
- Do NOT change the dedup TTL or map key format.

---

## 4. Philosophy-Driven Constraints

- Guard comment must explain WHY, not what (CLAUDE.md: 'Document why, not what').
- No code duplication: both the pre-alloc path and the normal path reach the same single
  `queue.enqueue()` call (CLAUDE.md: 'Compose with small, pure functions').
- Guard uses `!== undefined` not a falsy check (CLAUDE.md: 'Type safety as the first line of defense').

---

## 5. Invariants

1. When `_preAllocatedStartResponse !== undefined`, `queue.enqueue()` MUST be called.
2. When `_preAllocatedStartResponse === undefined`, the existing dedup check runs unchanged.
3. `_recentAdaptiveDispatches` is not updated for pre-alloc dispatch calls (the entry from
   `dispatchAdaptivePipeline()` remains and is the correct TTL anchor for top-level dedup).
4. The `assertNever` exhaustiveness guard in the enqueue callback remains intact.

---

## 6. Selected Approach + Rationale

**Approach:** Wrap the dedup block in `dispatch()` with:
```typescript
if (workflowTrigger._preAllocatedStartResponse === undefined) {
  // ... existing dedup block ...
}
```
Both the pre-alloc path and the normal (post-dedup) path fall through to the same single
`void this.queue.enqueue(...)` call.

**Rationale:** Minimal blast radius. Single guard. No code duplication. Directly models the
documented invariant in `WorkflowTrigger._preAllocatedStartResponse` JSDoc.

**Runner-up:** Early-return guard before the dedup block (Candidate A from design review).
Lost because it risks duplicating the enqueue callback body. Structurally equivalent otherwise.

---

## 7. Vertical Slices

### Slice 1: Implementation fix in trigger-router.ts

**Scope:** `src/trigger/trigger-router.ts`, `dispatch()` method only (lines 847-933).

**Change:**
1. Add a guard comment before the dedup block explaining the pre-alloc invariant.
2. Wrap the scoped dedup block `{...}` in `if (workflowTrigger._preAllocatedStartResponse === undefined)`.
3. Add an optional `console.log` in the pre-alloc path for daemon observability.
4. The existing `void this.queue.enqueue(...)` call remains after the if-block.

**Acceptance criterion:** TypeScript compiles clean. The guard is visible and commented correctly.

---

### Slice 2: Unit tests in trigger-router.test.ts

**Scope:** `tests/unit/trigger-router.test.ts`, new describe block or additions to existing
'TriggerRouter.route and dispatch deduplication' describe block.

**Two new tests:**

**Test 1: dispatch() with _preAllocatedStartResponse bypasses dedup and calls runWorkflowFn**
- Call `dispatchAdaptivePipeline(goal, workspace)` to prime the dedup map.
- Then call `dispatch({ workflowId, goal, workspacePath: workspace, context: {}, _preAllocatedStartResponse: <fake> })`.
- Flush the async queue.
- Assert `calls.toHaveLength(1)` -- runWorkflowFn was called exactly once.

**Test 2: dispatch() WITHOUT _preAllocatedStartResponse still deduplicates within 30s**
- This test already exists at line 1604. Verify it still passes after the change.
- No new test needed for this case; the existing test is the regression guard.

**Acceptance criterion:** Both tests pass (`vitest run tests/unit/trigger-router.test.ts`).

---

### Slice 3: Build, test, PR, CI, merge

**Steps:**
1. `npm run build` -- clean
2. `npx vitest run tests/unit/trigger-router.test.ts` -- all pass
3. `npx vitest run` -- no regressions
4. Create branch `fix/dispatch-dedup-prealloc-bypass`
5. Commit: `fix(trigger): bypass dispatch dedup for pre-allocated sessions to prevent zombie sessions`
6. Push + open PR
7. Wait for CI
8. Merge: `gh pr merge <N> --squash`

---

### Slice 4: Daemon reinstall and smoke test

**Steps:**
1. `npm run build && node dist/cli-worktrain.js daemon --install`
2. `node dist/cli-worktrain.js trigger poll self-improvement`
3. Watch for `session_started` in event log for at least 30s
4. Confirm session is not zombie (status completes or progresses past `run_started`)

---

## 8. Test Design

### New Test 1: Bypass case (primary regression test for this fix)

```typescript
it('dispatch(): bypasses dedup and calls runWorkflowFn when _preAllocatedStartResponse is set', async () => {
  vi.useFakeTimers();
  const { fn, calls } = makeFakeRunWorkflow();
  const trigger = makeTrigger();
  const router = new TriggerRouter(
    makeIndex(trigger), FAKE_CTX, FAKE_API_KEY, fn,
    undefined, undefined, undefined, undefined, undefined,
    FAKE_DEPS, executors,
  );

  const goal = trigger.goal;
  const workspace = trigger.workspacePath;

  // Prime the dedup map via dispatchAdaptivePipeline
  await router.dispatchAdaptivePipeline(goal, workspace);

  // Now dispatch with _preAllocatedStartResponse set -- must bypass dedup
  router.dispatch({
    workflowId: trigger.workflowId,
    goal,
    workspacePath: workspace,
    context: {},
    _preAllocatedStartResponse: {} as any, // non-undefined value triggers bypass
  });

  // Flush
  await new Promise((r) => setImmediate(r));

  // runWorkflowFn must have been called exactly once
  expect(calls).toHaveLength(1);
  vi.useRealTimers();
});
```

### Existing Test (regression guard): dispatch() dedup still works without _preAllocatedStartResponse

The test at line 1604-1644 of trigger-router.test.ts covers this. It will serve as the
regression guard after the change.

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Guard removed in future refactor | Low | High | Unit test catches it in CI |
| Comment becomes stale | Low | Medium | Comment explains invariant, not mechanics -- less likely to stale |
| _preAllocatedStartResponse type changes | Very low | Low | TypeScript would catch it at compile time |

---

## 10. PR Packaging Strategy

Single PR. One commit. No breaking changes.

Branch: `fix/dispatch-dedup-prealloc-bypass`
Commit: `fix(trigger): bypass dispatch dedup for pre-allocated sessions to prevent zombie sessions`

---

## 11. Philosophy Alignment

| Principle | Status | Why |
|---|---|---|
| Architectural fixes over patches | Satisfied | Guard models the root invariant, not a special-case |
| Make illegal states unrepresentable | Satisfied | `_preAllocatedStartResponse !== undefined` is compile-time discriminator |
| YAGNI with discipline | Satisfied | Minimal change, no speculative abstractions |
| Document why, not what | Satisfied | Guard comment explains invariant |
| Type safety as first line of defense | Satisfied | `!== undefined` check, typed optional field |
| Immutability by default | Tension (pre-existing) | Shared mutable map; not introduced by this fix |
