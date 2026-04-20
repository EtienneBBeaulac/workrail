# Implementation Plan: Connect adaptive dispatch in polling-scheduler.ts

## Problem Statement

`TriggerRouter.dispatchAdaptivePipeline()` was added in PR #639 but left unconnected. `polling-scheduler.ts` still calls `router.dispatch()` for all sessions including `github_queue_poll` ones. The queue poll sessions run as generic workflow sessions instead of being routed through the adaptive coordinator. This PR creates the wiring connection.

---

## Acceptance Criteria

1. In `doPollGitHubQueue()`, when a task candidate is dispatched, `router.dispatchAdaptivePipeline()` is called (via type guard) instead of `router.dispatch()` -- when `dispatchAdaptivePipeline` exists on the router.

2. When `dispatchAdaptivePipeline` is absent on the router (test mocks), `dispatch()` is called as fallback -- no crash, no error.

3. When `dispatchAdaptivePipeline` exists but `coordinatorDeps` is not injected, a `console.warn` is emitted and the method falls back gracefully (returns a dry_run outcome or delegates to dispatch-equivalent behavior). The polling loop continues normally.

4. `TriggerRouter` accepts optional `coordinatorDeps?: AdaptiveCoordinatorDeps` and `modeExecutors?: ModeExecutors` constructor params. When provided, `dispatchAdaptivePipeline` uses them as defaults.

5. `dispatchAdaptivePipeline` signature is simplified: takes `(goal, workspace, context?, coordinatorDeps?, modeExecutors?)` -- last two are caller overrides (take precedence over stored fields). Returns `Promise<PipelineOutcome>`.

6. `npm run build` produces no TypeScript errors.

7. `npx vitest run` -- all 353 test files pass, no regressions.

---

## Non-Goals

- Do NOT implement `AdaptiveCoordinatorDeps` production wiring inside `TriggerRouter` (that's a follow-up PR).
- Do NOT wire `coordinatorDeps` in `trigger-listener.ts` or any bootstrap file.
- Do NOT modify any `src/mcp/` files.
- Do NOT change `AdaptiveCoordinatorDeps` or `ModeExecutors` interface definitions.
- Do NOT add new tests for the adaptive dispatch path (test mock router doesn't implement `dispatchAdaptivePipeline`; the fallback path is the tested path).
- Do NOT change `PollingScheduler` constructor signature.

---

## Philosophy-Driven Constraints

- **DI for boundaries**: `coordinatorDeps` stored on `TriggerRouter`, not constructed inside it.
- **Immutability by default**: New fields are `private readonly`.
- **YAGNI**: Only the wiring is added; no production deps implementation.
- **Errors as data**: Absent deps produce a logged warning and graceful fallback, never a thrown error.
- **Determinism**: Fallback behavior (when deps absent) is always the same -- log warn + skip adaptive dispatch.

---

## Invariants

1. At-least-once delivery ordering is preserved: adaptive dispatch fires BEFORE `appendQueuePollLog` records the event (same ordering as the `dispatch()` call it replaces).

2. Fire-and-forget semantics preserved: `doPollGitHubQueue` does not await the adaptive dispatch outcome.

3. Fallback to `dispatch()` when `dispatchAdaptivePipeline` is absent on the router (type guard false).

4. `dispatchAdaptivePipeline` never throws: any internal errors are caught and logged; the method returns `PipelineOutcome { kind: 'escalated' }` on unexpected errors.

5. Existing `TriggerRouter` tests pass without modification -- new constructor params are optional.

---

## Selected Approach

**Hybrid approach (Candidate A refined):**

### In `trigger-router.ts`

1. Add to constructor parameters (after `steerRegistry?`):
   - `coordinatorDeps?: AdaptiveCoordinatorDeps`
   - `modeExecutors?: ModeExecutors`

2. Store as `private readonly _coordinatorDeps?: AdaptiveCoordinatorDeps` and `private readonly _modeExecutors?: ModeExecutors`.

3. Change `dispatchAdaptivePipeline` signature from:
   ```typescript
   async dispatchAdaptivePipeline(
     goal: string,
     workspace: string,
     coordinatorDeps: AdaptiveCoordinatorDeps,
     modeExecutors: ModeExecutors,
     context?: Readonly<Record<string, unknown>>,
   )
   ```
   to:
   ```typescript
   async dispatchAdaptivePipeline(
     goal: string,
     workspace: string,
     context?: Readonly<Record<string, unknown>>,
     coordinatorDeps?: AdaptiveCoordinatorDeps,
     modeExecutors?: ModeExecutors,
   )
   ```
   Effective deps = caller-provided (override) OR stored fields (default).

4. Inside `dispatchAdaptivePipeline`, if no effective deps are available:
   - Log `console.warn('[TriggerRouter] dispatchAdaptivePipeline called but coordinatorDeps not injected -- adaptive dispatch disabled. Inject coordinatorDeps in TriggerRouter constructor to activate.')`
   - Return `{ kind: 'escalated', escalationReason: { phase: 'dispatch', reason: 'coordinatorDeps not injected' } }` as PipelineOutcome.

5. Update JSDoc to document:
   - The `@see feat/github-queue-poll` comment (already there -- keep it)
   - The caller-override vs. stored-field precedence rule
   - That absent deps produce a warn + escalated outcome (not a throw)

### In `polling-scheduler.ts`

1. In `doPollGitHubQueue`, replace line:
   ```typescript
   this.router.dispatch(workflowTrigger);
   ```
   with:
   ```typescript
   if ('dispatchAdaptivePipeline' in this.router && typeof (this.router as { dispatchAdaptivePipeline?: unknown }).dispatchAdaptivePipeline === 'function') {
     void (this.router as { dispatchAdaptivePipeline: (goal: string, workspace: string, context?: Readonly<Record<string, unknown>>) => Promise<unknown> }).dispatchAdaptivePipeline(
       workflowTrigger.goal,
       workflowTrigger.workspacePath,
       workflowTrigger.context,
     );
   } else {
     this.router.dispatch(workflowTrigger);
   }
   ```
   Note: The type cast is necessary because `TriggerRouter` is imported as a type (not class) in `polling-scheduler.ts`. The duck-type check is the runtime safety mechanism.

2. Add a log line after the adaptive dispatch call:
   ```typescript
   console.log(`[QueuePoll] dispatched via adaptivePipeline: goal="${workflowTrigger.goal.slice(0, 80)}"`);
   ```

---

## Runner-Up

**Candidate B** (PollingScheduler carries coordinator deps) -- rejected because it places infrastructure-level deps at the wrong boundary. PollingScheduler should only know about the router interface.

---

## Vertical Slices

### Slice 1: Modify `trigger-router.ts`
- Add optional constructor params `coordinatorDeps?` and `modeExecutors?`
- Store as `private readonly` fields
- Simplify `dispatchAdaptivePipeline` signature (context before deps)
- Add absent-deps fallback with `console.warn` and `escalated` return
- Update JSDoc

**Done when**: `npm run build` succeeds; `dispatchAdaptivePipeline` method compiles with new signature.

### Slice 2: Modify `polling-scheduler.ts`
- Replace `this.router.dispatch(workflowTrigger)` with type-guard + adaptive dispatch call + fallback
- Add log line for adaptive dispatch path

**Done when**: `npm run build` succeeds; existing `polling-scheduler.test.ts` tests pass (mock router only has `dispatch`, type guard falls back -- no regressions).

---

## Test Design

**No new test files.** The task says "small targeted change" and the adaptive path requires `coordinatorDeps` injection which the existing test infrastructure doesn't support. Existing tests verify:
- The fallback path: mock router only has `dispatch()`, type guard is `false`, `dispatch()` is called (existing tests already verify this behavior -- they just don't explicitly test the type guard).

**Manual verification**: After implementation, verify that `npm run build` and `npx vitest run` both pass cleanly.

**Follow-up test** (not in this PR): Add `dispatchAdaptivePipeline` to the mock router in `polling-scheduler.test.ts` and assert it's called for queue-poll sessions.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Type cast for duck-type check causes TS error | Low | Build failure | Use `as { dispatchAdaptivePipeline?: unknown }` minimal cast; verify in Slice 2 |
| `dispatchAdaptivePipeline` return type mismatch after signature change | Low | Build failure | Verify `ReturnType<typeof runAdaptivePipeline>` still matches `Promise<PipelineOutcome>` |
| Missing `(this.router as TriggerRouter).dispatchAdaptivePipeline` direct call | None | N/A | The import in `polling-scheduler.ts` is `import type { TriggerRouter }` -- the type guard is the correct approach |
| Existing trigger-router.test.ts fails after constructor change | Low | Test failure | New params are optional -- all existing test construction sites pass `undefined` implicitly |

---

## PR Packaging Strategy

**Single PR**: `fix/connect-adaptive-dispatch`

Commit: `fix(trigger): connect queue poll dispatch to adaptive coordinator`

All changes in one commit: `trigger-router.ts` + `polling-scheduler.ts` + design docs.

---

## Philosophy Alignment

| Principle | Status | Reason |
|-----------|--------|--------|
| DI for boundaries | Satisfied | `coordinatorDeps` injected at construction, not built internally |
| Immutability by default | Satisfied | New fields are `private readonly` |
| YAGNI with discipline | Satisfied | No production deps wiring; only the call path is connected |
| Errors as data | Satisfied | Absent deps return `escalated` PipelineOutcome, never throw |
| Type safety first | Minor tension | Duck-type guard is runtime check; acceptable for mock compatibility |
| Make illegal states unrepresentable | Minor tension | `coordinatorDeps` and `modeExecutors` are independent optionals; acceptable per existing router pattern |

---

## Estimation

- **`unresolvedUnknownCount`**: 0
- **`planConfidenceBand`**: High
- **`estimatedPRCount`**: 1
- **`followUpTickets`**:
  1. Wire `AdaptiveCoordinatorDeps` into `TriggerRouter` constructor in `trigger-listener.ts` bootstrap
  2. Add test for `dispatchAdaptivePipeline` call path in `polling-scheduler.test.ts`
