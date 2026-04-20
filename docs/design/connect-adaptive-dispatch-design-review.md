# Design Review: Connect adaptive dispatch in polling-scheduler.ts

**Design under review:** `connect-adaptive-dispatch-candidates.md`, Candidate A (with hybrid revision)

---

## Tradeoff Review

| Tradeoff | Status |
|----------|--------|
| Production activation deferred | Acceptable -- documented, warned, follow-up task |
| Duck-type guard instead of static narrowing | Acceptable -- required for test mock compatibility |
| Signature change removes 2 required params | Safe -- no tests call `dispatchAdaptivePipeline` directly |
| Async fire-and-forget via void IIFE | Acceptable -- consistent with `dispatch()` pattern |

All tradeoffs were verified against acceptance criteria and invariants. None violates the task's stated requirements.

---

## Failure Mode Review

| Failure Mode | Mitigation | Risk Level |
|-------------|-----------|-----------|
| `coordinatorDeps` absent -- silent fallback | `console.warn` log | Low (documented deferral) |
| `runAdaptivePipeline` throws | Try-catch in IIFE + scheduler-level catch | Low |
| Type guard false for real TriggerRouter | Cannot happen -- method on prototype | N/A |
| Interface drift (new required deps method) | TypeScript compile-time catch | Low |
| Concurrent poll cycles | Skip-cycle guard already prevents | N/A |

No unmitigated failure modes identified.

---

## Runner-Up / Simpler Alternative Review

**Simpler variant considered**: Keep `dispatchAdaptivePipeline` signature with `coordinatorDeps` and `modeExecutors` as optional method params (not stored on constructor). Scheduler calls with `(goal, workspace, undefined, undefined, context)`.

**Why rejected as-is**: 5-param call site with two explicit `undefined` arguments at the scheduler call site is noisy and implies the caller is responsible for deps it cannot provide.

**Hybrid adopted**: Keep optional method params (for flexibility) AND store them as constructor fields (for default injection). The scheduler calls with `(goal, workspace, context)` -- 3 params, no explicit `undefined`. Production can inject deps at construction; tests can pass them per-call if needed. This is strictly more flexible than the original Candidate A.

---

## Philosophy Alignment

- **DI for boundaries**: Satisfied. Deps injected at construction, scheduler passes nothing.
- **Immutability by default**: Satisfied. New fields are `private readonly`.
- **YAGNI with discipline**: Satisfied. No production deps wiring in this PR.
- **Type safety first**: Minor tension with duck-type guard. Acceptable -- required for test mock compatibility.
- **Make illegal states unrepresentable**: Minor tension -- `coordinatorDeps` and `modeExecutors` are independent optionals. Acceptable -- consistent with existing router pattern.

---

## Findings

### Yellow: Deferred production activation

**Severity**: Yellow (informational, not a blocker)

`coordinatorDeps` and `modeExecutors` will be `undefined` in production until a follow-up PR wires them into the `TriggerRouter` constructor. The `console.warn` log makes this visible. This is intentional per the pitch's "connect" framing, but should be tracked as a follow-up task.

**No revision required.** The warning log is sufficient mitigation.

### Yellow: Method signature flexibility

**Severity**: Yellow (quality, not a correctness issue)

The hybrid approach (optional params + stored fields) adds slight complexity to `dispatchAdaptivePipeline` internals (must merge caller-provided and stored fields). The precedence rule (caller-provided params override stored fields when both are present) should be documented in the method's JSDoc to prevent future confusion.

**Revision required**: Add JSDoc note to `dispatchAdaptivePipeline` clarifying that caller-provided `coordinatorDeps`/`modeExecutors` override the stored fields.

---

## Recommended Revisions

1. **Adopt hybrid approach**: `dispatchAdaptivePipeline` accepts optional `coordinatorDeps?` and `modeExecutors?` params (caller override) with fallback to `this._coordinatorDeps` and `this._modeExecutors` (stored fields). Three-param call site from scheduler: `(goal, workspace, context)`.

2. **Add JSDoc clarification**: Document the precedence rule (caller params override stored fields) in `dispatchAdaptivePipeline`'s JSDoc.

3. **Warning log text**: The fallback warning should include: triggerId, reason ("coordinatorDeps not injected -- falling back to dispatch()"), and suggest where to inject.

---

## Residual Concerns

- **Production wiring gap**: The adaptive coordinator will not activate in production until `AdaptiveCoordinatorDeps` is implemented and injected. This is tracked as a follow-up task by the task description. No action required in this PR.

- **Test coverage gap**: No test verifies that `dispatchAdaptivePipeline` is called instead of `dispatch()` for queue-poll sessions when deps are present. This would require adding `dispatchAdaptivePipeline` to the mock router in `polling-scheduler.test.ts`. Out of scope for this PR per the "small targeted change" instruction, but recommended as a follow-up.
