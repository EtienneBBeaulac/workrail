# Design Review Findings: POST /api/v2/sessions/:sessionId/steer

> Concise, actionable findings from the tradeoff review, failure mode analysis,
> runner-up comparison, and philosophy alignment check.

---

## Tradeoff Review

| Tradeoff | Acceptable? | Condition for unacceptability |
|---|---|---|
| No auth on endpoint | Yes | Multi-tenant or remote daemon deployment (not today) |
| Registration gap window (~50ms) | Yes | Coordinator steers immediately on session creation, before first tool call |
| No crash recovery for in-flight steers | Yes | Real-time human approval with no retry mechanism (not a v1 use case) |
| `pendingSteerParts` is mutable array | Yes | Mutation is bounded to two explicit write paths, one read path |
| `SteerRegistry` as type alias, not class | Yes | Only if richer lifecycle API is needed (it isn't for 3 operations) |

---

## Failure Mode Review

| Failure Mode | Risk | Design Handling |
|---|---|---|
| Coordinator calls before session registered | LOW | 404 returned; gap is ~50ms not 1 LLM turn |
| Coordinator calls after session completes | NONE | 404 returned (registry cleared in finally block) |
| Stale registration leaking closure reference | NONE | Structurally prevented: disposer lambda in finally block |
| Concurrent push + drain (JS single-threaded) | NONE | Event loop serializes; no interleaving possible |
| Unbounded `pendingSteerParts` array | VERY LOW | Bounded by network pressure; no cap needed in v1 |
| Invalid body (missing/non-string `text`) | NONE | 400 returned after boundary validation |

---

## Runner-Up / Simpler Alternative Review

**From C2 (SteerRegistry class):** Borrow the disposer pattern -- `register()` returns the deregistration lambda. Even with the hybrid (type alias, no class), the disposer pattern is implemented as a closure in `runWorkflow()`'s finally block. The value is in the pattern, not the wrapper.

**Simpler variant (inline Map, no type alias):** Works, but the parameter type `Map<string, (text: string) => void>` in function signatures has no name. A type alias `SteerRegistry` costs zero lines and buys readability at all call sites.

**Hybrid (selected):** Named type alias `SteerRegistry` in `workflow-runner.ts` + no new file. Satisfies 'explicit domain types' at low cost. Disposer lambda in finally block satisfies lifecycle safety. Three trivial operations (set, delete, call) don't warrant a class.

---

## Philosophy Alignment

**Strongly satisfied:**
- DI for boundaries (registry injected as parameter)
- Errors as data (HTTP returns typed shape; no exceptions)
- Validate at boundaries (400/503/404 before hitting registry)
- YAGNI (no auth, no waitForCoordinator, no crash recovery -- all documented)

**Acceptable tension:**
- 'Prefer explicit domain types' -- type alias satisfies naming without full class
- 'Make illegal states unrepresentable' -- structurally possible to pass registry to standalone console, but mitigated by explicit `undefined` + comment
- 'Immutability by default' -- mutable array bounded behind two explicit write paths

**No conflicts.**

---

## Findings

### GREEN (no blocking issues)

The selected design (hybrid: type alias + parameter injection) satisfies all acceptance criteria, resolves all identified tensions, and has no unaddressed failure modes.

### ORANGE (significant -- address before or during implementation)

**O1: TriggerRouter constructor must receive `steerRegistry`.**
`TriggerRouter.dispatch()` calls `this.runWorkflowFn(workflowTrigger, this.ctx, this.apiKey, undefined, this.emitter)`. The steer registry must be passed here too, or daemon-triggered sessions cannot be steered. Solution: add `private readonly steerRegistry?: SteerRegistry` to TriggerRouter constructor; pass as 6th arg to `runWorkflowFn()` calls. Update `RunWorkflowFn` type to include optional `steerRegistry` param.

**O2: `runWorkflow()` registration window must be explicit in code comments.**
The registration gap (~50ms after `executeStartWorkflow()` returns) should be documented with a comment in `runWorkflow()` near the `steerRegistry?.set()` call, explaining that coordinators calling the endpoint immediately after session creation should retry once on 404.

### YELLOW (low risk -- watch during implementation)

**Y1: `pendingSteerParts` clearing semantics.**
The drain in turn_end should assign `pendingSteerParts = []` (reassign) rather than `pendingSteerParts.length = 0` (mutate-in-place). Either works (JS is single-threaded), but reassignment is more obviously immutable at the read site. Note: the steer callback closes over `pendingSteerParts` by reference to the variable, so if we reassign the variable, the closure's reference becomes stale. Solution: use `pendingSteerParts.length = 0` (truncate in-place) OR close over a container object. Prefer: `pendingSteerParts.splice(0)` (splice to empty, returns removed elements). Alternatively, declare with `const pendingSteerParts: string[] = []` and use `splice(0)` to drain.

**Y2: Ordering of parts in the joined steer message.**
Step text (from `onAdvance()`) should appear first, coordinator text second. This is the natural order since `onAdvance()` fires first (inside `makeContinueWorkflowTool`), then the steer callback fires from the HTTP handler (which arrives as a later event loop callback). Verify this ordering is preserved after the `pendingSteerText` rename.

---

## Recommended Revisions

1. **Implement hybrid approach:** Named type alias `export type SteerRegistry = Map<string, (text: string) => void>` in `workflow-runner.ts`. No new file. Import alias in `console-routes.ts` and `daemon-console.ts`.

2. **Extend `RunWorkflowFn` type** in `trigger-router.ts` to include optional `steerRegistry?: SteerRegistry` as 6th param. Update both `route()` and `dispatch()` call sites. Add `steerRegistry` to `TriggerRouter` constructor.

3. **Fix `pendingSteerText` -> `pendingSteerParts`** (R1 from prior review). Use `const pendingSteerParts: string[] = []`. Drain with `pendingSteerParts.splice(0)` in turn_end subscriber (splices all items out, returns them for joining).

4. **Registration gap comment**: in `runWorkflow()` near `steerRegistry?.set(workrailSessionId, ...)`, add a comment: "Registration gap: the HTTP endpoint returns 404 for ~50ms between session creation and this call. Coordinators should retry once on 404 during session start-up."

5. **Endpoint response shape**: return `{ success: true }` on 200 (no data needed; steer is fire-and-forget from coordinator's perspective).

---

## Residual Concerns

1. **MCP-mode injection remains deferred.** The steer endpoint is daemon-only. If MCP sessions ever become steer-able, the registry abstraction extends cleanly -- just wire the MCP session's AgentLoop to its own steer callback. Document this explicitly with a TODO comment in the endpoint.

2. **`report_issue` coexistence (Y3 from prior review).** The `signal_coordinator` tool (if added later) and `report_issue` partially overlap. This endpoint does not resolve that overlap. Track separately.

3. **The steer text is unstructured.** The coordinator pushes arbitrary `text: string`. There is no schema for what the text should contain. For v1 this is fine (coordinator constructs the text); for v2, a structured `{ role, content, signal_id }` shape would enable better audit tracing.
