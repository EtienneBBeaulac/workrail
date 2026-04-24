# Design Candidates: runWorkflow() Functional Core / Imperative Shell Refactor

## Problem Understanding

### Tensions
1. **Mutable shared state vs. functional core:** `SessionState` must be mutable (callbacks mutate it via `onAdvance`, `onComplete`, `onTokenUpdate`), but the functional core principle says immutability by default. Resolution: make the mutation explicit via a named `SessionState` interface -- better than hidden closure state, even if not purely immutable.
2. **Closure capture semantics vs. object reference:** The current code has `workrailSessionId` as a `let` that closures capture by reference. If `SessionState.workrailSessionId` is assigned a new string, all closures that hold a reference to `state` (the object) will see the updated value -- same semantics as the current `let` capture.
3. **AbortRegistry TDZ risk:** The abort registry is registered with `() => { agent.abort(); }` BEFORE `const agent` is declared. Early-exit paths between registration and `const agent = new AgentLoop` must delete the registry. `finalizeSession` is called AFTER the agent loop exits, so this constraint does not change with the refactor.
4. **Pre-existing stuck sidecar bug:** The `stuck` path (line 4232-4251) does NOT delete the sidecar. Invariants doc section 2.2 requires deletion. `finalizeSession` fixes this correctly.

### Likely seam
The seam is inside `runWorkflow()` -- the function already has logical phases (model selection, session start, worktree, agent loop, result classification, cleanup). The extractions formalize these phases.

### What makes it hard
- 13 `let` declarations that closures capture by reference -- must all be present in `SessionState`
- The `agent` const is referenced in closures before it is declared (TDZ); early-exit paths must clean up registries explicitly
- `finalizeSession` must handle worktree-success case (do NOT delete sidecar) vs. all others (DO delete)
- Adding stuck sidecar deletion is a behavioral change -- must verify tests cover it

## Philosophy Constraints
- **Exhaustiveness everywhere:** `tagToStatsOutcome` MUST use `assertNever` (import already exists at line 49)
- **Functional core / imperative shell:** pure functions have no I/O, no side effects
- **Validate at boundaries, trust inside:** `buildAgentClient` validates model format before any I/O
- **YAGNI with discipline:** no speculative abstractions -- extract what the spec asks for, nothing more
- **Dependency injection:** `_statsDir`, `_sessionsDir` injectable for tests

## Impact Surface
- `runWorkflow()` callers: `trigger-listener.ts`, `makeSpawnAgentTool` -- unchanged signature (new params are optional)
- `tests/unit/workflow-runner-outcome-invariants.test.ts` -- needs update to exercise `_statsDir` injection
- All other `workflow-runner-*.test.ts` -- must continue passing unchanged
- `docs/reference/worktrain-daemon-invariants.md` -- no changes needed (refactor follows the spec)

## Candidates

### Candidate A: Minimal mechanical extraction in same file (RECOMMENDED)

**Summary:** Extract exactly the 6 pieces specified as module-level functions in `workflow-runner.ts`. Update `runWorkflow()` to use them. No new files.

**Tensions resolved:** Makes pure logic testable without touching I/O. All 4 cleanup sites consolidated in `finalizeSession`. Fixes stuck sidecar bug.
**Tensions accepted:** `SessionState` still lives in the same large file.
**Boundary:** Module level -- everything in `workflow-runner.ts`, reorganized.
**Failure mode:** Missing one of the 13 `let` variables in `SessionState`.
**Repo pattern relationship:** Follows -- same as `buildSessionRecap`, `buildSystemPrompt`, `evaluateRecovery` extractions.
**Gains:** Minimal diff, surgical, easy to review. All acceptance criteria met.
**Losses:** Nothing.
**Scope:** Best-fit.
**Philosophy:** Honors functional core/imperative shell, exhaustiveness, explicit mutable state.

### Candidate B: Extract pure functions to separate files

**Summary:** Move `buildAgentClient`, `evaluateStuckSignals`, `tagToStatsOutcome` to `daemon-agent-client.ts`, `daemon-stuck-detection.ts`, etc.

**Tensions resolved:** Stronger module isolation.
**Tensions accepted:** More files, more imports, higher cognitive overhead.
**Failure mode:** Circular imports or over-engineering.
**Repo pattern:** Departs -- existing extractions all live in same file. Task spec doesn't mention new files.
**Scope:** Too broad.

### Candidate C: Class-based SessionState with typed mutation methods

**Summary:** `SessionState` as a TypeScript class with `advance()`, `complete()`, `updateToken()` setter methods.

**Failure mode:** Contradicts spec's explicit `interface SessionState` + factory shape.
**Scope:** Too broad (spec violation).

## Comparison and Recommendation

**Recommendation: Candidate A.**

The task spec is explicit about extraction targets and their signatures. Candidate A implements exactly what was specified using existing file-level patterns. All acceptance criteria met without scope creep.

## Self-Critique

**Strongest counter-argument:** Separate files would make `evaluateStuckSignals` testable without importing the full 4362-line module. Counter: existing test files use `vi.mock` at module level and import specific exports -- this pattern scales.

**Pivot conditions:** If the module becomes noticeably harder to navigate after the extraction (>4500 lines), a follow-up PR could split it. But that's not this task's scope.

**Invalidating assumption:** TypeScript TDZ with abortRegistry + `agent`. Mitigation: call `finalizeSession` only after the finally block.

## Open Questions for Main Agent

None -- spec is fully explicit. Implement Candidate A.
