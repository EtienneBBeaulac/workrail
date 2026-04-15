# Design Candidates: WorkRail Daemon Agent Loop

> Raw investigative material for main-agent review. Not a final decision.

## Problem Understanding

### Core tensions

1. **Loop generality vs. termination specificity.** pi-mono's loop terminates structurally (no tool calls + no follow-up messages). WorkRail's `isComplete` is a semantic condition returned from `continue_workflow`. Something must bridge these without coupling the loop to WorkRail semantics.

2. **External dependency vs. operational risk.** Using `@mariozechner/pi-agent-core` as an npm dep is the cleanest path but creates fragility: if the upstream OSS project breaks or the package is unpublished, WorkRail's daemon breaks. Vendoring eliminates that risk at maintenance cost.

3. **Agent-as-loop-driver vs. direct-MCP-caller.** The daemon could run an LLM that interprets step prompts and calls tools autonomously, or be a deterministic loop that calls MCP tools without an LLM. Approach (a) is flexible but adds LLM cost per step. Approach (b) is cheaper but cannot execute natural-language step instructions.

4. **Type safety of `isComplete` propagation.** WorkRail's philosophy demands typed domain values. The `isComplete: boolean` from `continue_workflow` must propagate to loop termination in a type-safe way without leaking into pi-mono's generic layer.

### Likely seam

The `AgentTool.execute()` method for the `continue_workflow` tool, plus the `getFollowUpMessages` callback in `AgentLoopConfig`. This is where `isComplete` enters the system and where the loop's continuation decision is made.

### What makes this hard

pi-mono's loop has no built-in concept of 'external termination condition.' The `afterToolCall` hook can override tool results but cannot directly stop the loop. The `getFollowUpMessages` callback is the only hook that controls the outer-loop continuation condition. Correctly wiring `isComplete` through this callback is the non-obvious insight.

---

## Philosophy Constraints

From `CLAUDE.md` and codebase patterns in `src/engine/types.ts`, `src/errors/app-error.ts`:

- **Errors are data** -- tool failures must surface as `isError: true` in `ToolResultMessage`, not thrown exceptions. pi-mono already does this.
- **Make illegal states unrepresentable** -- `isComplete=true` with pending follow-up messages would be an illegal state.
- **Immutability by default** -- Agent state should be owned by the `Agent` instance, not shared globals.
- **Exhaustiveness everywhere** -- the `NextIntent` and `DaemonToolResult` types must use discriminated unions with exhaustive switch.
- **Dependency injection for boundaries** -- the `getFollowUpMessages` closure is the correct injection point.

**Philosophy conflict to watch:** The closure flag (C1) is runtime-correct but not compile-time-typed. The vendored discriminated union (C2) is more philosophy-aligned. If type safety is non-negotiable for the daemon, C2 wins on this dimension.

---

## Impact Surface

- **Daemon process only.** No changes to WorkRail's MCP server, engine, or existing workflows.
- **MCP tool definitions** (`start_workflow`, `continue_workflow`) must be defined as `AgentTool` objects -- new code, no modifications to existing files.
- **Concurrency model:** Multiple `Agent` instances (one per workflow run) with no shared state between them.

---

## Candidates

### Candidate 1: pi-mono as external npm dep, closure flag for `isComplete`

**Summary:** Install `@mariozechner/pi-agent-core` from npm. Wrap each MCP call as an `AgentTool`. The `continue_workflow` tool's `execute()` sets a `let isComplete = false` flag in a closure. `getFollowUpMessages` returns `[]` when the flag is true, causing the outer loop to exit.

**Tensions resolved:**
- Loop generality vs. termination specificity: resolved via closure flag
- Philosophy fit for dependency injection: `AgentLoopConfig` is injected with the closure

**Tensions accepted:**
- External dependency risk: package availability unverified
- Type safety: closure flag is `let boolean` -- correct at runtime but not a typed discriminant

**Boundary solved at:** `AgentTool.execute()` for `continue_workflow` + `getFollowUpMessages` callback

**Failure mode:** npm package unavailable. Mitigation: fallback to C2.

**Repo-pattern relationship:** Follows WorkRail's dependency injection convention.

**Gains:** Minimal code (~100 lines of tool wrappers). All loop machinery included and battle-tested.

**Losses:** External dep risk. No compile-time guarantee that `isComplete` is handled exhaustively.

**Scope judgment:** best-fit.

**Philosophy fit:** Honors dependency injection, immutability, errors as data. Minor conflict with exhaustiveness.

---

### Candidate 2: Vendor pi-mono loop (~1000 lines), typed `DaemonToolResult` discriminant

**Summary:** Copy `agent-loop.ts`, `types.ts`, and a stripped `Agent` class into `src/daemon/agent-loop/`. Replace the generic `AgentToolResult<T>` with `DaemonToolResult = { _tag: 'success'; content: ... } | { _tag: 'error'; message: string } | { _tag: 'workflow_complete' }`. The loop exits when `execute()` returns `{ _tag: 'workflow_complete' }`.

**Tensions resolved:**
- External dependency risk: eliminated
- Type safety of `isComplete`: resolved with typed discriminated union, compiler-enforced

**Tensions accepted:**
- Maintenance burden: WorkRail owns ~1000 lines of loop code

**Boundary solved at:** `src/daemon/agent-loop/loop.ts` + `src/daemon/types.ts`

**Failure mode:** Vendor drift -- upstream pi-mono fixes are not automatically applied.

**Repo-pattern relationship:** Adapts WorkRail's `_tag` discriminant convention (matches `AppError` in `src/errors/app-error.ts`).

**Gains:** Zero external dep risk. Compile-time exhaustiveness.

**Losses:** ~1000 lines of vendored code.

**Scope judgment:** best-fit, slight lean toward too-broad if npm is available.

**Philosophy fit:** Honors make-illegal-states-unrepresentable, exhaustiveness, type safety. Minor conflict with YAGNI.

---

### Candidate 3: Deterministic (LLM-free) daemon loop

**Summary:** A plain `while (!isComplete)` async loop that calls `start_workflow`, parses the step's `prompt` deterministically, executes the matching tool, then calls `continue_workflow`. No LLM involved.

**Tensions resolved:**
- External dependency risk: none
- LLM cost: eliminated

**Tensions accepted:**
- Cannot execute steps requiring natural-language reasoning

**Failure mode:** Cannot execute the majority of WorkRail steps, which contain natural-language instructions.

**Scope judgment:** too narrow.

**Philosophy fit:** Honors determinism. Conflicts with WorkRail's LLM-driven execution model.

---

## Comparison and Recommendation

| Dimension | C1 (npm dep) | C2 (vendor) | C3 (no LLM) |
|---|---|---|---|
| Loop termination | Closure flag (runtime) | Typed discriminant (compile-time) | Direct boolean |
| Dep risk | Accepts | Eliminates | Eliminates |
| Maintenance | Minimal | ~1000 lines owned | ~50 lines owned |
| Philosophy fit | Good | Excellent | Partial |
| Execution scope | Full (LLM-driven) | Full (LLM-driven) | Too narrow |

**Recommendation: C1, pivot to C2 if npm unavailable.**

---

## Self-Critique

**Strongest argument against C1:** The upstream dependency is on a personal OSS project that could be abandoned.

**Strongest argument against C2:** 1000 lines of vendored code. Upstream fixes are not automatically applied.

**Pivot conditions:**
- C1 -> C2: npm package confirmed unavailable, OR compile-time `isComplete` typing is required
- C3 viable only if: WorkRail step prompts are always machine-structured (product direction change)

---

## Open Questions for the Main Agent

1. Is `@mariozechner/pi-agent-core` published on npm? (Check: `npm view @mariozechner/pi-agent-core`)
2. Does WorkRail's philosophy review require compile-time-typed `isComplete` propagation, or is the runtime closure flag acceptable?
3. Should the daemon handle `checkpointToken` (pause/resume)? If so, the `continue_workflow` tool needs a `checkpoint` variant in the `DaemonToolResult` discriminant.
