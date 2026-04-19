# Design Candidates: POST /api/v2/sessions/:sessionId/steer

> Raw investigative material for main agent synthesis. Not a final decision.

---

## Problem Understanding

### Core Tensions

**T1: Closure-scoped state vs. HTTP endpoint accessibility.**
`pendingSteerParts` (the fixed form of `pendingSteerText`) lives inside the `runWorkflow()` closure
in `src/daemon/workflow-runner.ts`. The HTTP handler lives in `mountConsoleRoutes()` in
`src/v2/usecases/console-routes.ts`. These modules have no shared reference. The naive fix
(module-level `Map`) violates the per-instance isolation invariant that motivated moving `sseClients`
into the `mountConsoleRoutes()` closure: module-level state is shared across test instances and
hypothetical daemon restarts, causing cross-session contamination. Solution: explicit DI.

**T2: Silent discard on `pendingSteerText` overwrite.**
The R1 finding from `design-review-findings-mid-session-signaling.md`: `onAdvance()` currently does
`pendingSteerText = stepText` (assignment). A coordinator steer written between step advances would be
silently overwritten when `onAdvance()` fires. Fix: rename to `pendingSteerParts: string[]` and use
`push()`. The turn_end subscriber joins all parts and clears. Order: step text first (workflow advance
is primary), coordinator text appended. This is a blocking prerequisite for the endpoint.

**T3: Daemon-only semantics vs. shared `mountConsoleRoutes` function.**
The steer endpoint is only meaningful for daemon-managed sessions. The standalone console must NOT
expose it. If the endpoint is always registered (even in standalone mode), it returns 404 for every
call -- silently wrong. Better: the endpoint is structurally absent when no steer registry is injected.

**T4: Registry lifecycle -- registration timing gap.**
The registry key is the WorkRail `sess_xxx` ID, decoded from the continueToken after
`executeStartWorkflow()` returns. For sessions using `_preAllocatedStartResponse` (dispatch path),
the session ID is already decoded before `runWorkflow()` is called. For sessions that call
`executeStartWorkflow()` internally, there is a brief window (< 1 turn) where the session exists but
is not yet in the registry. v1 acceptable (documented); coordinator should retry once on 404.

### Likely Seam

The real seam is the `turn_end` subscriber in `runWorkflow()` at lines ~2523-2531. This is both where
the fix lands (drain `pendingSteerParts`) AND where steer delivery happens. The HTTP endpoint is
purely the write path into the array; the delivery mechanism (`agent.steer()`) is unchanged.

### What Makes This Hard

1. The registry must be constructed by the daemon layer and passed to BOTH the HTTP server and the
   workflow runner. These are currently linked only through `runWorkflow()` being called from
   `console-routes.ts` or `TriggerRouter`. Threading a new dependency through both callers requires
   identifying all call sites (`daemon-console.ts`, `console-routes.ts` direct dispatch).

2. JavaScript single-threadedness means there is NO race condition between the HTTP write path and the
   turn_end read path -- Node.js event loop serializes them. This is the key insight junior devs miss;
   they add unnecessary locking.

3. The `pendingSteerParts` array-based fix changes the join semantics: multiple concurrent steers from
   the coordinator (if the coordinator calls the endpoint twice before the next turn_end) both land.
   This is correct behavior but must be explicit in the code.

---

## Philosophy Constraints

Sources: `/Users/etienneb/CLAUDE.md`, `docs/discovery/design-review-findings-mid-session-signaling.md`,
existing `console-routes.ts` route patterns.

- **DI for boundaries**: The registry must be injected, not imported as a module singleton.
  Existing pattern: `triggerRouter?: TriggerRouter` in `mountConsoleRoutes()`.
- **Errors as data**: The lookup result should be a typed value (`'ok' | 'not_found'`), not a boolean
  or thrown exception. HTTP handler maps to 200/404.
- **Explicit domain types over primitives**: A named `SteerRegistry` type is preferred over a raw
  `Map<string, (text: string) => void>` even if functionally identical.
- **Make illegal states unrepresentable**: Standalone console should structurally not have a steer
  registry, making it impossible to accidentally steer non-daemon sessions.
- **YAGNI**: No auth token in v1 (documented per O3 finding). No `waitForCoordinator` blocking gate.
  No crash recovery for in-flight steers.
- **Validate at boundaries**: Endpoint validates `{ text: string }` body before calling invoke.

**Conflicts:** None found. All three candidates can be made to honor these principles.

---

## Impact Surface

Files that must remain consistent if the boundary changes:

- `src/daemon/workflow-runner.ts` -- rename `pendingSteerText` \u2192 `pendingSteerParts`, add registry
  registration/deregistration, add optional `steerRegistry` param
- `src/v2/usecases/console-routes.ts` -- add `steerRegistry` optional param, add POST endpoint
- `src/trigger/daemon-console.ts` -- create registry, pass to both `mountConsoleRoutes()` and the
  workflow runner (via TriggerRouter or direct call)
- `src/console/standalone-console.ts` -- no change needed (passes `undefined` for new param)

Contracts that must remain consistent:
- `runWorkflow()` public signature -- any change must be additive (optional param, default undefined)
- `mountConsoleRoutes()` public signature -- same constraint
- `pendingSteerText` variable name change: search for any existing references (none found outside
  `workflow-runner.ts` itself)

---

## Candidates

### Candidate 1: Minimal -- raw Map parameter added to existing signatures

**Summary:** Add `steerRegistry?: Map<string, (text: string) => void>` as an optional trailing param
to both `mountConsoleRoutes()` and `runWorkflow()`. Fix `pendingSteerParts` inline. Endpoint guarded by
`!steerRegistry \u2192 503`.

**Tensions resolved:**
- T1 (closure vs. HTTP): plain `Map` is passed explicitly.
- T2 (silent discard): `pendingSteerParts.push()` fix.
- T3 (daemon-only): absent Map \u2192 503.

**Tensions accepted:**
- Lifecycle of registration is caller-managed; caller must remember to deregister in a finally block
  (not enforced by the type).
- `boolean` return from `Map.has()` coerces to HTTP 200/404 implicitly.

**Boundary:** `runWorkflow()` and `mountConsoleRoutes()` signatures. Additive, backward-compatible.

**Why this boundary:** These are the exact two call sites that need the registry; adding it here adds
no abstraction layer above what's needed.

**Failure mode:** Caller forgets to delete from Map after `runWorkflow()` completes \u2192 stale entry
remains. HTTP endpoint calls the stale callback, which calls `pendingSteerParts.push()` on a
completed session's closed-over array (harmless but semantically wrong). Mitigation: put the delete
inside `runWorkflow()`'s finally block (not caller-managed). Risk: low.

**Repo pattern:** Follows `triggerRouter?: TriggerRouter` exactly -- highest pattern consistency.

**Gains:** Minimal new code (\u223c15 lines net new). No new files. No new abstractions.

**Losses:** Raw `Map` type is not self-documenting. The `(text: string) => void` callback signature
has no name. Mild 'explicit domain types' philosophy violation.

**Impact surface:** Three files (workflow-runner.ts, console-routes.ts, daemon-console.ts). No new
files.

**Scope:** Best-fit. Exactly what's needed, nothing more.

**Philosophy:** Honors DI-for-boundaries, YAGNI. Mild conflict with 'prefer explicit domain types'.

---

### Candidate 2: Encapsulated -- SteerRegistry class in src/daemon/steer-registry.ts

**Summary:** Create a named `SteerRegistry` class with `register(sessionId, cb): () => void` (returns
disposer), `invoke(sessionId, text): 'ok' | 'not_found'`, and private `_sessions: Map`. Pass instances
to `mountConsoleRoutes()` and `runWorkflow()`.

**Tensions resolved:**
- T1: explicit DI, same as C1.
- T2: `pendingSteerParts.push()` fix.
- T3: absent registry \u2192 503.
- Lifecycle: `register()` returns a disposer function. `runWorkflow()` stores it and calls it in
  finally. Impossible to forget -- the disposer IS the deregistration.

**Tensions accepted:**
- New file (~50 lines). Marginal over C1.

**Boundary:** New file `src/daemon/steer-registry.ts`. Both callers import from there. The named class
is the domain object; the Map is an implementation detail hidden behind the API.

**Why this boundary:** Encapsulates the invariant that 'a session is registered when running and
deregistered when done'. The disposer pattern makes this lifecycle explicit at the type level.

**Failure mode:** Same as C1 in theory, but structurally prevented: `register()` returns the disposer,
so the only way to use `SteerRegistry` correctly is to store and call the disposer. Forgetting to call
it requires actively ignoring the return value (which TypeScript can warn about with `@typescript-eslint/no-unused-vars`).

**Repo pattern:** Consistent with `ToolCallTimingRingBuffer` (small class for narrow concern). Slight
departure from 'just add a param' pattern, but consistent with broader codebase style of named
infrastructure types.

**Gains:** Self-documenting API. `'ok' | 'not_found'` maps directly to HTTP 200/404 with no coercion.
Disposer pattern prevents stale registration. Testable in isolation.

**Losses:** New file. ~35 more lines than C1.

**Impact surface:** Four files (workflow-runner.ts, console-routes.ts, daemon-console.ts, new
steer-registry.ts).

**Scope:** Best-fit. Marginal scope increase over C1 justified by lifecycle safety.

**Philosophy:** Fully honors 'prefer explicit domain types', DI-for-boundaries, 'errors as data'.
No conflicts.

---

### Candidate 3: Ambient injection via V2ToolContext

**Summary:** Add `steerRegistry?: SteerRegistry` as an optional field to `V2Dependencies` (or
`V2ToolContext` directly in `src/mcp/types.ts`). `runWorkflow()` reads it from context; `mountConsoleRoutes()`
already receives `v2ToolContext`. No new params on either function.

**Tensions resolved:**
- T1: V2ToolContext flows everywhere, no new wiring needed.

**Tensions accepted:**
- T3: V2ToolContext is shared between daemon AND MCP server sessions. Adding a daemon-specific field
  pollutes the shared context. MCP sessions would have `steerRegistry: undefined`, but the type allows
  it to be set -- no structural prevention.
- Architecture pollution: `src/mcp/types.ts` is a high-traffic type with many consumers. Adding a
  daemon-only field there couples the MCP abstraction to the daemon's runtime state.

**Boundary:** `src/mcp/types.ts` V2Dependencies interface. High-traffic, many consumers.

**Why this boundary is wrong:** V2ToolContext is the MCP/engine shared context. Daemon-specific state
(like which sessions have live agent loops) should not bleed into the MCP layer. If MCP sessions ever
become steer-able, C3 would be correct then; today it's premature.

**Failure mode:** Misconfigured test or future consumer accidentally sets `steerRegistry` on an MCP
session, making it steer-able from the HTTP endpoint. Not structurally prevented -- only prevented by
convention.

**Repo pattern:** Consistent with how `v2ToolContext` is used everywhere, but departs from the 'inject
specific dependencies for specific concerns' principle.

**Gains:** Zero new params to thread; registry flows naturally wherever V2ToolContext goes.

**Losses:** Architectural pollution. Structurally harder to reason about which sessions are
steer-able. High-traffic type change.

**Impact surface:** `src/mcp/types.ts` + all consumers that need to be checked for exhaustive handling.

**Scope:** Too broad. The registry is a daemon-only concern.

**Philosophy:** Conflicts with 'make illegal states unrepresentable'. Partially honors DI.

---

## Comparison and Recommendation

### Matrix

| Factor | C1 (raw Map) | C2 (SteerRegistry) | C3 (V2ToolContext) |
|---|---|---|---|
| Resolves T1 | Yes | Yes | Yes |
| Resolves T2 | Yes | Yes | Yes |
| Resolves T3 structurally | Partially | Yes | No |
| Lifecycle safety | Caller convention | Enforced by disposer | Caller convention |
| Philosophy fit | Good | Excellent | Poor (T3) |
| Repo pattern | Exact match | Adapted match | Wrong boundary |
| New files | 0 | 1 | 0 |
| Impact surface | 3 files | 4 files | High (types.ts) |

### Recommendation: Candidate 2 (SteerRegistry class)

**Rationale:** The disposer pattern from `register()` structurally prevents the only meaningful
failure mode (stale registration). The `'ok' | 'not_found'` return type eliminates implicit coercion
at the HTTP layer. The new file adds \u223c50 lines but pays for itself in self-documentation and
testability. C1 and C2 are functionally identical; C2 wins on type safety and lifecycle enforcement.

### Self-Critique

**Strongest argument against C2:** C1 with a type alias `type SteerRegistry = Map<string, (text: string) => void>` and a disposer convention in `runWorkflow()`'s finally block is functionally
identical to C2. The new file in C2 is purely for encapsulation. If the codebase convention is 'small
files for small concerns', C2 is right. If the convention is 'minimize files', C1 wins. The codebase
has `ToolCallTimingRingBuffer` as a precedent for small dedicated infrastructure files -- C2 follows
this pattern.

**Narrower option that could work:** C1. Loses only the explicit lifecycle type; gains nothing beyond
fewer files. C1 is acceptable if YAGNI pressure is high.

**Broader option that might be justified:** C3 if MCP sessions become steer-able in v2. Not justified
today. Evidence required: MCP server calling `runWorkflow()`-style loop.

**Pivot condition:** If a new engineer misuses C2 by holding the registry object and calling
`invoke()` directly (bypassing the disposer), C2's safety guarantee fails. Risk: low (internal API).

---

## Open Questions for Main Agent

1. Does `daemon-console.ts` own registry construction, or should it be constructed in `trigger-router.ts`
   and passed down? `TriggerRouter.dispatch()` calls `runWorkflow()` -- it would need the registry.
   `daemon-console.ts` constructs the `TriggerRouter`. The cleanest path: construct registry in
   `daemon-console.ts`, pass to `TriggerRouter` constructor and to `mountConsoleRoutes()`.

2. Should the endpoint return `{ success: true }` (no data) on 200, or echo back something useful
   (e.g., `{ queued: true, sessionId }`)?

3. Should coordinator steers be appended before or after the step text in `pendingSteerParts`?
   Current proposal: step text first (via `onAdvance()` which fires first), coordinator appended.
   The agent sees the step instructions before the coordinator enrichment.

4. Is there an existing test for `runWorkflow()` that needs to be updated when `pendingSteerText`
   is renamed? (Check `src/daemon/workflow-runner.test.ts` or similar.)
