# Design Candidates: spawn_agent Task Implementation

> Full investigative material is in `design-candidates-spawn-agent.md`, `design-spawn-agent.md`,
> and `design-review-findings-spawn-agent.md`. This file summarizes for the current coding task.

---

## Problem Understanding

### Core Tensions

**T1: Blocking vs. semaphore deadlock**
`TriggerRouter.dispatch()` is fire-and-forget (non-blocking by design) and uses a global `Semaphore`.
A parent holding a slot cannot wait for a child to acquire another slot -- deadlock.
Correct path: call `runWorkflow()` directly, bypassing the semaphore entirely.

**T2: Typed schema extension vs. internalContext injection**
Adding `parentSessionId` to `session_created.data` is the typed, durable, query-friendly path.
Injecting via `internalContext` (context_set event) is the proven fast path.
Both are needed: `internalContext` for the `executeStartWorkflow()` call, AND schema extension for future DAG queries.

**T3: Deterministic childSessionId vs. code simplicity**
Pre-creating the child session (Candidate 2) gives a deterministic `childSessionId` before the run starts.
Direct `runWorkflow()` (Candidate 1) is simpler but cannot return `childSessionId` if the run crashes before the AgentLoop starts.

**T4: Depth propagation safety**
Using `context.spawnDepth` (generic map) is fragile -- any code that overwrites context silently breaks depth enforcement.
Using `WorkflowTrigger.spawnDepth` (typed `readonly` field) is compiler-enforced and cannot be accidentally lost.

### Likely Seam
`workflow-runner.ts` -- new `makeSpawnAgentTool()` factory alongside existing tool factories.
`events.ts` -- one-line additive schema extension for `session_created.data`.
`start.ts` -- thread `parentSessionId` through `buildInitialEvents()`.

### What Makes It Hard
- The `runWorkflow()` call inside `execute()` requires capturing `ctx`, `apiKey`, `daemonRegistry?`, `emitter?` in the factory closure.
- `executeStartWorkflow()` returns `RA<StartWorkflowResult, StartWorkflowError>` -- must be unwrapped asynchronously.
- `_preAllocatedStartResponse` expects `startResult.value.response` (not the full `StartWorkflowResult`).
- Junior developer would call `dispatch()` instead of `runWorkflow()` and create a deadlock.
- `session_created.data` currently hardcodes `data: {}` in `buildInitialEvents()` -- must thread `parentSessionId` into that call.

---

## Philosophy Constraints

From `CLAUDE.md` and repo patterns:

- **Errors as data**: Return `{ outcome: 'error', notes: msg }` JSON, not thrown exceptions, for child failures.
- **Exhaustiveness**: Handle all 4 `WorkflowRunResult` variants without `as unknown` casts.
- **Immutability**: New `WorkflowTrigger` fields are `readonly`.
- **DI for boundaries**: `runWorkflowFn`, `ctx`, `apiKey`, `emitter` all injected at construction time.
- **YAGNI**: Phase 1 only. No `spawn_session + await_sessions`, no bare-prompt mode, no width guardrails.
- **Make illegal states unrepresentable**: `childSessionId` always present (pre-create guarantees it).

No philosophy conflicts between stated rules and repo patterns.

---

## Impact Surface

| File | Change | Risk |
|---|---|---|
| `src/daemon/workflow-runner.ts` | Add `parentSessionId?`, `spawnDepth?` to `WorkflowTrigger`; add `makeSpawnAgentTool()`; inject in `runWorkflow()`; update `BASE_SYSTEM_PROMPT`; update `_preAllocatedStartResponse` JSDoc | Low -- additive |
| `src/v2/durable-core/schemas/session/events.ts` | Extend `session_created.data` with `parentSessionId?: z.string().optional()` | Low -- `z.object({})` uses strip mode |
| `src/mcp/handlers/v2-execution/start.ts` | Thread `parentSessionId` from `internalContext` into `session_created` event via `buildInitialEvents()` | Low -- internal API |
| `src/trigger/trigger-router.ts` | No change -- new `WorkflowTrigger` fields are optional | None |
| `src/v2/usecases/console-routes.ts` | No change -- new `WorkflowTrigger` fields are optional | None |

---

## Candidates

### Candidate 1: Direct runWorkflow() call

**Summary**: `makeSpawnAgentTool()` calls `runWorkflow()` directly. No pre-creation. Session ID extracted from result after run.

**Tensions resolved**: YAGNI (fewest lines), blocking (natural await).
**Tensions accepted**: Crash-before-start has no observable `childSessionId`. `childSessionId` is absent on failure.

**Boundary**: `WorkflowTrigger` + direct `runWorkflow()` call.
**Why this boundary**: `WorkflowTrigger` is the natural seam -- carries all session config. No new types.

**Failure mode**: `runWorkflow()` crashes before AgentLoop starts -- `childSessionId` is null, parent gets `{ outcome: 'error', childSessionId: null }`.

**Repo-pattern relationship**: Follows factory pattern. No adaptation of `_preAllocatedStartResponse`.

**Gain**: ~10 fewer lines, maximum simplicity.
**Give up**: No deterministic `childSessionId` on startup failures. Less crash observability.

**Scope**: Best-fit.
**Philosophy fit**: Honors YAGNI strongest. Slight tension with 'make illegal states unrepresentable' (`childSessionId` can be null).

---

### Candidate 2: Pre-create session with _preAllocatedStartResponse (RECOMMENDED)

**Summary**: `execute()` calls `executeStartWorkflow()` with `parentSessionId` in `internalContext`, decodes `childSessionId` from the returned `continueToken`, then calls `runWorkflow()` with `_preAllocatedStartResponse`.

**Tensions resolved**: Deterministic `childSessionId`, crash-before-start observability, `childSessionId` seeds Phase 2, 'make illegal states unrepresentable'.
**Tensions accepted**: One extra async call (~10-50ms).

**Boundary**: `WorkflowTrigger._preAllocatedStartResponse` + `internalContext` injection.
**Why this boundary**: Direct adaptation of the proven `_preAllocatedStartResponse` pattern from `console-routes.ts`. Session store sees the child immediately -- correct observable behavior.

**Failure mode**: `executeStartWorkflow()` succeeds, `runWorkflow()` fails before AgentLoop -- zombie session in store. Accepted for Phase 1.

**Repo-pattern relationship**: Adapts proven `_preAllocatedStartResponse` pattern.

**Gain**: `childSessionId` always known before child runs. Deterministic. Child observable from moment of `execute()`.
**Give up**: One extra async call. Slightly more setup code.

**Scope**: Best-fit.
**Philosophy fit**: Honors determinism over cleverness, make illegal states unrepresentable, DI. No conflicts.

---

### Candidate 3: Read depth from session store at execute() time

**Summary**: Instead of passing `currentDepth` as a constructor parameter, read `spawnDepth` from parent session store inside `execute()`.

**Tensions resolved**: Accurate depth for checkpoint-resumed sessions (theoretical edge case).
**Tensions accepted**: Async I/O in `execute()`, more error paths, session store dependency.

**Boundary**: Session store read inside `execute()`.
**Why this boundary is NOT best-fit**: Expensive, speculative. Checkpoint-resumed daemon sessions restart AgentLoop from scratch -- constructor parameter is always correctly set.

**Failure mode**: Store read fails -- fail-safe blocks spawn, adds error path complexity.

**Repo-pattern relationship**: Departs from constructor-injection pattern.

**Gain**: Accurate depth for resumed sessions. **Give up**: YAGNI violation, async I/O, extra error paths.

**Scope**: Too broad. **Philosophy fit**: Conflicts with YAGNI.

---

## Comparison and Recommendation

### Comparison Matrix

| Tension | C1 | C2 | C3 |
|---|---|---|---|
| Blocking fidelity | Strong | Strong | Strong |
| Deterministic childSessionId | Weak | Strong | Weak |
| Semaphore bypass | Strong | Strong | Strong |
| YAGNI | Strong | Moderate | Weak |
| Crash observability | Weak | Strong | Weak |
| Depth accuracy | Adequate | Adequate | Strong (speculative) |
| Repo pattern | Follows | Adapts proven | Departs |
| Philosophy | Full | Full | Partial |

### Recommendation: Candidate 2

C2 is best-fit. The `_preAllocatedStartResponse` pattern is proven and stable (`console-routes.ts`).
The marginal complexity (one extra async call) is small relative to the gain: `childSessionId` is always
known, crash-before-start is observable, Phase 2 is seeded. C3 is rejected on YAGNI grounds.

---

## Self-Critique

**Strongest counter-argument**: C2 adds a zombie session failure mode that C1 doesn't have. If `executeStartWorkflow()` succeeds but `runWorkflow()` fails immediately, a session exists in the store with no corresponding run. C1 avoids this -- no session is created until the run actually starts.

**C1 as narrower option**: Still satisfies acceptance criteria. Loses crash observability and deterministic `childSessionId`. Would win if we prioritized simplicity over observability.

**C3 as broader option**: Justified only if checkpoint-resumed spawned sessions become a real production use case. No evidence for Phase 1.

**Assumption that would invalidate C2**: If `_preAllocatedStartResponse` is removed in a future refactor. Mitigation: update its JSDoc (Orange finding O2) to list `spawn_agent` as a legitimate caller.

---

## Open Questions for the Main Agent

1. **maxSubagentDepth source**: Design doc says read from `WorkflowTrigger.agentConfig` (default 3). Should this also check global workspace config? Decision: use `trigger.agentConfig?.maxSubagentDepth ?? 3` for Phase 1. Document in tool description.

2. **`session_created.data` strictness**: Confirmed `z.object({})` uses strip mode. Extension is safe. Unverified by migration run -- low risk.

3. **Zombie session cleanup**: Deferred to Phase 2. Document as known edge case in tool description.
