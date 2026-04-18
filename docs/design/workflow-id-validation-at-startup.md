# Design: Workflow ID Validation at Daemon Startup

**Status:** Decision made -- implement Candidate A  
**Date:** 2026-04-16  
**Context:** Backlog item "Workflow ID validation at startup" (Tier 1, groomed Apr 18)

---

## Problem Understanding

### The Bug

A user writes `workflowId: coding-task-workflow-agentic.lean.v2` (filename without extension) instead of `coding-task-workflow-agentic` (the actual workflow ID). The daemon starts fine, accepts webhooks, but every dispatch silently fails with `workflow_not_found`. The error only surfaces in logs, not at startup. The operator has no way to know their trigger is broken until they watch logs during an actual webhook event.

### Core Tensions

1. **Testability vs. production simplicity** -- `ctx.workflowService.getWorkflowById` is available in production but tests use `FAKE_CTX = {} as V2ToolContext` where `workflowService` is `undefined`. Requires an injectable function approach, not direct ctx access.
2. **Warn+skip consistency vs. fail-fast** -- `loadTriggerConfig` already chose warn+skip for invalid triggers. A hard-fail here would create two conflicting behaviors in the same startup path.
3. **Where to wire the lookup** -- `StartTriggerListenerOptions` injectable (matches existing `runWorkflowFn` pattern) vs. direct `ctx` access.

### Likely Seam

`startTriggerListener` in `src/trigger/trigger-listener.ts`, after `buildTriggerIndex()` returns ok (~line 235), before `new TriggerRouter(...)`. This is the correct seam -- triggers are loaded and indexed, but no webhooks can arrive yet.

### What Makes This Hard

- `FAKE_CTX = {} as V2ToolContext` in tests -- direct `ctx.workflowService` use breaks existing test infrastructure without any compile-time warning.
- Need to decide what happens when `getWorkflowByIdFn` is not provided (backward compat: skip validation entirely).
- Workflows are static YAML files -- if not found at startup, they will never be found at dispatch time either. No "not found now, maybe later" case exists.

---

## Philosophy Constraints

**Sources:**
- `/Users/etienneb/CLAUDE.md`: "Dependency injection for boundaries -- inject external effects (I/O, clocks, randomness) to keep core logic testable"
- `/Users/etienneb/CLAUDE.md`: "Validate at boundaries, trust inside -- do input validation at system edges"
- Repo pattern: `runWorkflowFn?: RunWorkflowFn` in `StartTriggerListenerOptions` -- exact injectable pattern to follow
- Repo pattern: `loadTriggerConfig` warn+skip -- policy to remain consistent with

**No conflicts.** All sources agree on: DI injectable for testability, warn+skip policy, validate at the startup boundary.

---

## Impact Surface

- **`src/trigger/trigger-listener.ts`** -- primary change. New validation loop and new `StartTriggerListenerOptions` field.
- **`tests/unit/trigger-router.test.ts`** -- add new test cases. Existing tests unaffected (they don't provide `getWorkflowByIdFn`, so validation is skipped -- same behavior as today).
- **`src/trigger/trigger-router.ts`** -- no change. Router already handles `workflow_not_found` at dispatch; this is an earlier defense layer.
- **`src/trigger/trigger-store.ts`** -- no change. YAML parsing is separate from workflow ID resolution.
- **`src/trigger/types.ts`** -- no change. `TriggerDefinition` shape unchanged.

---

## Candidates

### Candidate A -- Injectable function on StartTriggerListenerOptions (RECOMMENDED)

**Summary:** Add `getWorkflowByIdFn?: (id: string) => Promise<boolean>` to `StartTriggerListenerOptions`. Production path defaults to `(id) => ctx.workflowService.getWorkflowById(id).then(w => w !== null)`. When not provided, validation is skipped (backward compat for existing tests).

**Tensions resolved:** Testability (tests inject stub), warn+skip consistency, DI principle.  
**Tensions accepted:** Slight verbosity (new option field). Validation silently skipped if fn not provided (intentional).

**Boundary:** `startTriggerListener`, after `buildTriggerIndex()` returns ok.  
**Why this boundary:** Single assembly point before the router accepts any traffic. Earlier (store layer) would require making `loadTriggerConfig` async. Later (dispatch time) is too late -- that's the bug we're fixing.

**Failure mode:** Existing tests that don't inject `getWorkflowByIdFn` silently skip validation. This is intentional backward compat, not a latent bug -- they still test all other startup behavior.

**Repo pattern:** Exact match to `runWorkflowFn?: RunWorkflowFn` in the same `StartTriggerListenerOptions` interface.

**Gains:** Full testability, no changes to existing tests, clean DI seam, consistent with all philosophy principles.  
**Losses:** Caller must inject the fn to get validation. If someone creates a new caller of `startTriggerListener` without providing it, they get no validation. (Low risk: only one production caller.)

**Scope judgment:** Best-fit. Changes only `trigger-listener.ts` and adds tests. No interface changes to store or router.

**Philosophy fit:** Honors "Dependency injection for boundaries", "Validate at boundaries, trust inside". No conflicts.

---

### Candidate B -- Use ctx.workflowService directly with null guard

**Summary:** Call `ctx.workflowService?.getWorkflowById(id)` directly in the validation loop, skipping the whole loop if `ctx.workflowService` is undefined.

**Tensions resolved:** Production simplicity (no new option field).  
**Tensions accepted:** Testability gap -- the warn+skip behavior can't be tested without constructing a real `workflowService` in `ctx`.

**Failure mode:** New validation behavior is untestable with the existing `FAKE_CTX` test infrastructure.

**Repo pattern:** Departs from `runWorkflowFn` injectable pattern. Conflicts with DI principle.

**Scope judgment:** Best-fit for production behavior, too narrow for test coverage.

**Philosophy fit:** Conflicts with "Dependency injection for boundaries".

---

### Candidate C -- Validate inside loadTriggerConfig (store layer)

**Summary:** Add `workflowResolver?: (id: string) => Promise<boolean>` to `loadTriggerConfig`, filtering unknown workflowId triggers at parse time.

**Tensions resolved:** Centralizes all trigger validation.  
**Tensions accepted:** `trigger-store.ts` is a pure synchronous YAML parser; making it async for the resolver breaks its pure/impure boundary and all existing sync call sites.

**Failure mode:** Breaks `loadTriggerConfig`'s synchronous interface contract. All existing callers would need updating.

**Repo pattern:** Departs from the pure-sync design of `trigger-store.ts`.

**Scope judgment:** Too broad -- adds async I/O to a pure parsing module with no justification beyond this feature.

**Philosophy fit:** Conflicts with "Compose with small, pure functions".

---

## Comparison and Recommendation

| Tension | A (Injectable) | B (ctx direct) | C (store layer) |
|---------|---------------|----------------|-----------------|
| Testability | Wins | Loses | N/A |
| Warn+skip consistency | Wins | Wins | Breaks pure boundary |
| DI principle | Honors | Conflicts | Conflicts |
| Repo pattern fit | Exact match | Departs | Departs |
| Reversibility | Easy | Easy | Hard |

**Recommendation: Candidate A.** It resolves all tensions, is a direct repo-pattern match, requires minimal code change, and leaves all existing tests unchanged.

---

## Self-Critique

**Strongest counter-argument:** "Why add a new option when `ctx.workflowService` is already there? That's extra API surface for a one-time startup check." -- Response: `FAKE_CTX = {} as V2ToolContext` (line 33, `trigger-router.test.ts`) means `ctx.workflowService` is `undefined` at test runtime. Without the injectable, the new validation behavior is untestable. Fixing a silent-failure bug without being able to test it is unacceptable.

**Narrower option that lost:** Candidate B (ctx direct with null guard). Loses because new behavior is untestable.

**Broader option that would need evidence:** Candidate C (store layer) would be justified if multiple callers of `loadTriggerConfig` needed workflow ID validation -- but there is only one production caller. The scope increase is not warranted.

**Invalidating assumption:** If `FAKE_CTX` were replaced by a real mock with a `workflowService`, Candidate B would be equally valid. But that's a larger test infrastructure change that's out of scope.

---

## Open Questions for the Main Agent

None. All design decisions are resolved. Implementation is straightforward:
1. Add `getWorkflowByIdFn?: (id: string) => Promise<boolean>` to `StartTriggerListenerOptions`
2. After `buildTriggerIndex()` returns ok, if `getWorkflowByIdFn` is provided, iterate `triggerIndex`, call fn for each `workflowId`, warn and delete unknowns
3. Production default (when fn not provided): use `ctx.workflowService.getWorkflowById(id).then(w => w !== null)`
4. Add test cases for: warn+skip on unknown workflowId, valid workflowId passes through, fn not provided skips validation
