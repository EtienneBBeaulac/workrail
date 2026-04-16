# Design Candidates: WorkRail Auto Task Input MVP

**Date:** 2026-04-14
**Status:** Ready for main-agent review

---

## Problem Understanding

### Core Tensions

1. **TriggerRouter cohesion vs dispatch seam**: `TriggerRouter` was designed to route webhook events only. Adding `dispatch()` and `getTriggers()` extends its responsibility. But it already owns all needed dependencies (`index`, `runWorkflowFn`, `ctx`, `apiKey`). Any alternative boundary would duplicate those injections.

2. **console-routes read-only invariant vs mutating dispatch endpoint**: `console-routes.ts` has a comment stating "All routes are GET-only (invariant: Console is read-only)". The task explicitly requires `POST /api/v2/auto/dispatch`. Resolution: update the comment; add `express.json()` only for that path; keep GET routes unchanged.

3. **WorkflowTrigger interface scope**: The task requires `buildSystemPrompt()` and model setup in `workflow-runner.ts` to read `trigger.referenceUrls` and `trigger.agentConfig`. `WorkflowTrigger` is the type passed to `runWorkflow()`. Extending it with optional fields is additive; the alternative (passing `TriggerDefinition` separately) would couple the daemon to the trigger system types.

4. **TriggerRouter lifecycle vs console route availability**: `TriggerRouter` is only instantiated when `WORKRAIL_TRIGGERS_ENABLED=true`. `mountConsoleRoutes` must handle `undefined` router gracefully (503 from dispatch, empty list from GET /api/v2/triggers).

### What Makes This Hard

1. **YAML parser extension for nested blocks**: `agentConfig` and `onComplete` are sub-objects in the narrow YAML parser. Each requires a new block parser similar to the existing `contextMapping` special-case.

2. **`goalTemplate` interpolation fallback**: `{{$.dot.path}}` tokens must extract values from the webhook payload. If ANY token is missing, the entire template must fall back to the static `goal`. Partial interpolation produces broken goal strings.

3. **TriggerRouter exposure in server.ts**: `startTriggerListener()` currently returns a `TriggerListenerHandle` but does not expose the router. The router must be accessible to thread to `mountConsoleRoutes()`.

4. **`ContextMappingEntry.required` already exists**: Do NOT add it again -- already defined in `types.ts` at line 41.

### Likely Seam

The natural seam for the HTTP dispatch entry point is `TriggerRouter`, which already owns the full dispatch dependency set. The `console-routes.ts` file is the right location for mounting the new endpoints (follows the established pattern for optional features).

---

## Philosophy Constraints

From `/Users/etienneb/CLAUDE.md` (primary) and codebase patterns:

- **Immutability by default**: All new `TriggerDefinition` fields must be `readonly`.
- **Make illegal states unrepresentable**: `onComplete.runOn` must be `'success' | 'failure' | 'always'` literal union.
- **Errors are data**: Dispatch endpoint returns `{ error: string }` JSON, never throws.
- **Validate at boundaries, trust inside**: YAML parsing is the boundary for all new fields. Runtime dispatch trusts a valid `WorkflowTrigger`.
- **YAGNI with discipline**: Don't implement `onComplete.runOn !== 'success'` -- emit warning only. Don't build full JSONPath -- only `{{$.dot.path}}` templates.
- **Document "why", not "what"**: Comments explain intent of the warning for unimplemented `onComplete.runOn` values.

**Conflict:** `console-routes.ts` comment says read-only invariant. Task requires POST. Resolution: update the comment.

---

## Impact Surface

- `TriggerListenerHandle` interface (exposed publicly) -- adding `router` field is additive
- `mountConsoleRoutes` function signature -- adding optional `triggerRouter?` follows existing optional-param pattern
- `WorkflowTrigger` interface -- adding optional fields is non-breaking for all existing callers
- `buildSystemPrompt()` signature -- no change needed; reads from `trigger` which is already a parameter
- All existing trigger-store and trigger-router tests must pass unchanged
- TypeScript must compile clean: all new types must be consistent

---

## Candidates

### Candidate 1: Minimal additive -- extend TriggerRouter, pass as optional param

**Summary:** Add `dispatch()` and `getTriggers()` methods to `TriggerRouter`. Expose the router in `TriggerListenerHandle`. Pass it as an optional 7th parameter to `mountConsoleRoutes()`.

**Tensions resolved:**
- No dependency duplication: reuses existing injections in TriggerRouter
- console-routes: single POST route added with comment update, no structural change
- WorkflowTrigger: extends with optional `referenceUrls?` and `agentConfig?` fields

**Tensions accepted:** Mild TriggerRouter cohesion violation (adds HTTP dispatch semantics to a webhook router).

**Boundary solved at:** `TriggerRouter` -- already owns `index`, `runWorkflowFn`, `ctx`, `apiKey`. Any other boundary duplicates these.

**Why that boundary is the best fit:** `dispatch()` is semantically "route a dispatch request to runWorkflowFn" -- the same thing the class does for webhook events, just with a different input source. The conceptual center of the class doesn't change.

**Failure mode:** If the trigger listener never starts, the optional router is `undefined`, and the dispatch endpoint returns 503. Must be handled explicitly in console-routes.

**Repo-pattern relationship:** Follows the established `mountConsoleRoutes` optional-param pattern (`workflowService?`, `timingRingBuffer?`, etc.).

**Gains:** Minimal blast radius. No new files in `src/trigger/`. Single new dependency edge (console-routes -> TriggerRouter type). All existing tests pass unchanged.

**Losses:** TriggerRouter.dispatch() is technically a second responsibility for the class.

**Impact surface:** server.ts startup sequence needs to store the router from the listener result.

**Scope judgment:** Best-fit. Evidence: `mountConsoleRoutes` already has 4 optional parameters using this exact pattern.

**Philosophy fit:** Honors YAGNI (no new classes), immutability, errors-as-data. Mild conflict with single-responsibility.

---

### Candidate 2: Extract AutoDispatcher -- dedicated class for HTTP-originated dispatch

**Summary:** Create `src/trigger/auto-dispatcher.ts` with an `AutoDispatcher` class that wraps `runWorkflowFn`, `ctx`, `apiKey`, and the trigger index, with `dispatch()` and `listTriggers()` methods. Pass this to `mountConsoleRoutes` instead of `TriggerRouter`.

**Tensions resolved:**
- TriggerRouter cohesion: stays webhook-only, clean SRP

**Tensions accepted:**
- Dependency duplication: `AutoDispatcher` and `TriggerRouter` both need the same 4 injected dependencies
- Index ownership: two holders of the same `Map<string, TriggerDefinition>`

**Boundary solved at:** New `AutoDispatcher` class.

**Failure mode:** Index synchronization -- if triggers reload in the future, both objects must be updated.

**Repo-pattern relationship:** Departs from existing pattern. No existing analogue.

**Gains:** Clean single-responsibility for TriggerRouter.

**Losses:** More files, more injection, future index sync surface.

**Scope judgment:** Too broad for the current task. Creates infrastructure for a minor SRP concern.

**Philosophy fit:** Honors SRP. Conflicts with YAGNI.

---

## Comparison and Recommendation

| Tension | Candidate 1 | Candidate 2 |
|---|---|---|
| TriggerRouter cohesion | Mild violation (2 methods) | Clean |
| Dependency duplication | None | High (4 deps twice) |
| Index sync future risk | N/A (one owner) | Real footgun |
| Blast radius | Minimal | Larger |
| Repo pattern fit | Follows | Departs |

**Recommendation: Candidate 1.**

The TriggerRouter cohesion concern is the weakest objection in context. `dispatch()` reuses the same injected dependencies as `route()`. Adding it doesn't change the class's conceptual center. Candidate 2 solves a purity concern by creating a duplication problem that is strictly worse.

---

## Self-Critique

**Strongest counter-argument:** None compelling. The dependency duplication in Candidate 2 is a concrete cost; the SRP benefit is marginal at this scale.

**Narrower option that lost:** Not exposing the router at all; standalone `dispatchWorkflow()` function. Too narrow -- skips goalTemplate/referenceUrls/agentConfig enrichment and can't serve GET /api/v2/triggers.

**Broader option:** Full `AutoService` class (like `ConsoleService`) with test file. Only justified if 5+ methods planned. Not justified by current task.

**Pivot condition:** If dynamic trigger reload (hot-reload of triggers.yml) is implemented with multiple consumers -- revisit Candidate 2 at that point.

---

## Open Questions for the Main Agent

1. Should `WorkflowTrigger` carry `referenceUrls` and `agentConfig` (keeping daemon decoupled from trigger types)? **Working assumption: yes -- extend WorkflowTrigger with optional fields.**

2. Should the dispatch endpoint work when triggers are disabled (call `runWorkflow` directly with no enrichment), or require triggers to be enabled? **Working assumption: works independently, no enrichment when router is absent.**

3. Should `mountConsoleRoutes` accept `triggerRouter?: TriggerRouter` or a narrower structural interface? **Working assumption: use TriggerRouter type directly -- one call site doesn't justify a structural interface.**
