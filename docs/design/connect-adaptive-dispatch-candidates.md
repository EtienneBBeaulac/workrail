# Design Candidates: Connect adaptive dispatch in polling-scheduler.ts

**Task:** Connect `TriggerRouter.dispatchAdaptivePipeline()` in `doPollGitHubQueue()` so queue poll sessions route through the adaptive coordinator instead of generic `dispatch()`.

**Scope:** `src/trigger/polling-scheduler.ts` and `src/trigger/trigger-router.ts` only.

---

## Problem Understanding

### Tensions

1. **Fire-and-forget vs. async coordination**: `dispatch()` is synchronous and returns a `string` immediately. `dispatchAdaptivePipeline()` is `async` and returns `Promise<PipelineOutcome>`. The scheduler calls both as void fire-and-forget. The tension is that the pipeline outcome is never surfaced to the scheduler -- errors are only logged, never propagated.

2. **Deps ownership vs. scheduler simplicity**: `dispatchAdaptivePipeline()` currently requires `AdaptiveCoordinatorDeps` and `ModeExecutors` from the caller. The scheduler has neither. Either the router must own these deps (stored via DI), or the scheduler must carry them (wrong boundary), or the method builds them internally (violates DI principle).

3. **Type safety vs. runtime flexibility**: The task requests a duck-type guard (`'dispatchAdaptivePipeline' in this.router`) rather than relying on TypeScript's static type. This is unusual for a strongly-typed codebase but necessary for test fakes that may not implement the method.

4. **Production readiness vs. YAGNI**: Wiring `AdaptiveCoordinatorDeps` in production requires `spawnSession`, `awaitSessions`, `getAgentResult`, etc. -- HTTP-based, port-dependent. Providing that wiring now is out of scope for a "connect" task.

### Likely seam

`doPollGitHubQueue()` in `polling-scheduler.ts`, line 494: `this.router.dispatch(workflowTrigger)`. This is the correct seam -- it's where the dispatch decision is made, and where `context.taskCandidate` is available.

### What makes this hard

- `dispatchAdaptivePipeline` was added incomplete by design (JSDoc: "intentionally unconnected until that branch is rebased onto main"). It's a placeholder with a signature that requires caller-supplied deps that the scheduler cannot provide.
- Production `AdaptiveCoordinatorDeps` wiring does not yet exist on `TriggerRouter`.
- A naive swap crashes at runtime (deps are `undefined`, `runAdaptivePipeline` calls `deps.now()` immediately).

---

## Philosophy Constraints

From CLAUDE.md and repo patterns:

- **DI for boundaries**: inject external effects (I/O, clocks) -- do not construct them inside logic modules
- **YAGNI with discipline**: avoid speculative abstractions; the task is to "connect" not to "fully implement"
- **Immutability by default**: all TriggerRouter fields are `private readonly`
- **Type safety first**: prefer compile-time guarantees -- but the type guard is an accepted runtime concession for mock compatibility

### Conflicts

- Stated philosophy ("type safety first") vs. requested duck-type guard. The runtime guard exists because test fakes may not implement `dispatchAdaptivePipeline`. This is an intentional concession to test flexibility, not a philosophical violation.

---

## Impact Surface

- `TriggerRouter` constructor signature (minor -- optional params only, no breaking change)
- All existing `TriggerRouter` tests -- must continue to pass without supplying new optional params
- `PollingScheduler` -- minimal change at the dispatch call site
- All existing `PollingScheduler` tests -- must continue to pass; the type guard means mock routers without `dispatchAdaptivePipeline` silently fall back to `dispatch()`
- Production bootstrap (e.g. `src/trigger/trigger-listener.ts`) -- NOT changed in this PR (wiring `coordinatorDeps` is a follow-up task)

---

## Candidates

### Candidate A: Store optional coordinator deps on TriggerRouter (DI pattern)

**Summary**: Add optional `coordinatorDeps?: AdaptiveCoordinatorDeps` and `modeExecutors?: ModeExecutors` constructor params to `TriggerRouter`. Simplify `dispatchAdaptivePipeline` to use stored fields (not caller-provided params). In `doPollGitHubQueue`, type-guard check and call `void this.router.dispatchAdaptivePipeline(goal, workspace, context)`; fall back to `dispatch()` when the method is absent or deps are missing.

**Tensions resolved**: DI boundary (router owns deps). Fire-and-forget preserved. Type guard enables test fallback.

**Tensions accepted**: Production adaptive dispatch deferred (always falls back to `dispatch()` until deps are wired). Adds optional params to TriggerRouter constructor.

**Boundary**: `TriggerRouter` -- correct. It already owns `execFn`, `emitter`, `notificationService`, `steerRegistry` via the same pattern.

**Why this boundary**: The scheduler's job is to poll and dispatch. It should not know what `AdaptiveCoordinatorDeps` is. The router is the infrastructure boundary.

**Failure mode**: If `coordinatorDeps` is never injected in production, adaptive dispatch silently falls back to `dispatch()`. Mitigated by a `console.warn` log.

**Repo pattern**: Follows the existing TriggerRouter optional DI pattern exactly. No new patterns invented.

**Gains**: Clean separation; minimal change; all existing tests pass unchanged.

**Gives up**: Production adaptive dispatch doesn't work until a follow-up PR wires `coordinatorDeps`.

**Scope judgment**: Best-fit. The task says "connect" -- this creates the wiring path without full production readiness.

**Philosophy fit**: Honors DI for boundaries, YAGNI, immutability. Minor concession: duck-type guard is necessary for mock compatibility.

---

### Candidate B: Add coordinator deps to PollingScheduler constructor

**Summary**: Leave `TriggerRouter.dispatchAdaptivePipeline` signature as-is. Add `coordinatorDeps?` and `modeExecutors?` to `PollingScheduler` constructor. Pass them through to `dispatchAdaptivePipeline` in `doPollGitHubQueue`.

**Tensions resolved**: No TriggerRouter API change.

**Tensions accepted**: `PollingScheduler` becomes responsible for coordinator wiring -- wrong boundary. Scheduler's constructor grows with unrelated concerns.

**Boundary**: `PollingScheduler` -- wrong. The scheduler manages polling intervals; it should not know about `AdaptiveCoordinatorDeps`.

**Failure mode**: Two-level optional param threading. If either is absent, must guard in two places (scheduler constructor + method call).

**Repo pattern**: Departs -- nothing in `PollingScheduler` currently takes coordinator-level dependencies.

**Scope judgment**: Too broad -- changes the wrong boundary.

**Philosophy conflict**: Violates DI for boundaries (wrong injection point) and YAGNI.

---

### Candidate C: Lazily construct AdaptiveCoordinatorDeps inside dispatchAdaptivePipeline

**Summary**: No constructor changes. `dispatchAdaptivePipeline` builds `AdaptiveCoordinatorDeps` lazily from `this.ctx`, dynamically imports mode executors (same as CLI pattern), and calls `runAdaptivePipeline` self-contained. In the scheduler, type-guard + call with just `(goal, workspace, context)`.

**Tensions resolved**: No constructor API change. Self-contained per call.

**Tensions accepted**: Requires full `AdaptiveCoordinatorDeps` implementation inside `trigger-router.ts` -- requires console port, HTTP client, `gh` CLI. Major scope increase. Violates DI principle (building deps inside module).

**Failure mode**: Incomplete impl crashes at `deps.now()` or later; requires entire `AdaptiveCoordinatorDeps` surface implemented.

**Scope judgment**: Too broad. This is a separate task ("implement coordinator deps for TriggerRouter").

**Philosophy conflict**: Violates DI for boundaries.

---

## Comparison and Recommendation

**Recommendation: Candidate A.**

All meaningful tensions favor Candidate A:

- **Right boundary**: TriggerRouter already uses the exact same DI pattern for `execFn`, `emitter`, `notificationService`, `steerRegistry`. Adding `coordinatorDeps` and `modeExecutors` extends an established pattern at the established boundary.
- **Most manageable failure mode**: The fallback to `dispatch()` with a warning log is explicit and visible. Candidate B has the same fallback complexity but at the wrong boundary. Candidate C crashes if not fully implemented.
- **Scope fit**: The task is explicitly a "connect" task. Candidate A makes the connection; production wiring is deferred to a follow-up (which is correct -- the pitch says "wire queue poller -> runAdaptivePipeline()" as a modification to `trigger-router.ts`, not as production bootstrap wiring).
- **Easiest to evolve**: When the production `AdaptiveCoordinatorDeps` is ready, it's injected once at the bootstrap level. No changes to scheduler or method internals required.

---

## Self-Critique

**Strongest counter-argument**: If `coordinatorDeps` is always `undefined` in production, this PR "connects" nothing in practice -- the fallback to `dispatch()` always fires. The connection exists in the code but not in behavior.

Response: This is the explicitly stated intent. The JSDoc says "intentionally unconnected until that branch is rebased onto main." The task is to create the call path; making it operational is a separate step.

**Narrower option considered**: Don't change `trigger-router.ts` at all -- add the type guard in `polling-scheduler.ts` and call the existing method with `undefined` for the `coordinatorDeps`/`modeExecutors` params. Problem: the existing method has those params as required (not optional). This requires making them optional in `trigger-router.ts` anyway, which is essentially the same as Candidate A without the constructor injection.

**Broader option that might be justified**: Candidate C, if the production deps implementation already existed elsewhere and just needed wiring. Evidence required: a `makeAdaptiveCoordinatorDeps(ctx, port)` factory function somewhere. None found.

**Assumption that could invalidate this design**: If `dispatchAdaptivePipeline` was intended to always receive fresh deps from the caller (not stored), and the production caller is NOT `PollingScheduler` but some higher-level bootstrap that wraps the router. In that case, the method signature should stay as-is and the scheduler should call a different wrapper. However, the task description explicitly says to call `router.dispatchAdaptivePipeline()` from the scheduler, which rules out this interpretation.

---

## Open Questions for Main Agent

1. Should the fallback log a `console.warn` (visible noise) or `console.log` (informational)? The pattern for "expected missing optional dep" in this codebase is `console.warn` (see TriggerRouter constructor for missing `maxConcurrentSessions`).

2. Should the async `dispatchAdaptivePipeline` fire-and-forget (same as `dispatch()`) or should errors be awaited and logged? The existing `dispatch()` pattern uses `void this.queue.enqueue(...)` for fire-and-forget with result logging inside the callback. The adaptive dispatch should do the same: `void (async () => { ... })()` with outcome logging inside.
