# Design Review Findings: WorkRail Daemon Agent Loop

> Concise, actionable findings for the main workflow. Not a final decision document.

---

## Tradeoff Review

### T1: Closure flag for `isComplete` -- runtime-correct, not compile-time typed

- Holds under all realistic conditions. The closure is scoped per `Agent` instance. No sharing risk if `createDaemonConfig()` factory is used.
- Breaks if: `isComplete` protocol evolves to richer variants (`isBlocked`, `isPaused`). Mitigation: hybrid `WorkflowContinueResult` discriminant at tool boundary handles this without touching pi-mono.

### T2: External npm dependency pinned to exact version

- `@mariozechner/pi-agent-core@0.67.2` is confirmed published, MIT, 246 kB, 1 dep. Exact pin provides immutable tarball.
- Breaks if: npm registry outage blocks CI, or security vulnerability requires emergency upgrade. Standard operational risk for any npm dep.

### T3: LLM cost per step accepted

- Unavoidable given WorkRail's natural-language step instructions. 5-10 LLM calls per typical workflow. Acceptable at MVP scale.
- Breaks if: daemon must handle thousands of concurrent runs at sub-second latency. Not a current requirement.

---

## Failure Mode Review

| Failure Mode | Design Coverage | Gap |
|---|---|---|
| npm breaking change | Exact version pin | Add `npm audit` to CI |
| Closure shared across runs | Factory function pattern | Document requirement; add factory |
| Stuck loop (LLM loops without calling continue_workflow) | Not covered by current design | **Required mitigation: wall-clock timeout + max-turn counter** |
| continue_workflow returns isComplete mid-turn | Handled correctly -- loop exits after current turn | None |

---

## Runner-Up / Simpler Alternative Review

**Runner-up (C2: vendor loop):** The only element worth borrowing is the typed `WorkflowContinueResult` discriminant. This is adoptable in C1 as a domain type at the tool boundary -- zero vendor code needed.

**Simpler alternative (50-line while loop, no LLM):** Does not satisfy acceptance criteria. WorkRail step prompts require LLM interpretation.

**Hybrid recommended:** C1's npm dep + C2's typed result discriminant at the `continue_workflow.execute()` boundary.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Dependency injection for boundaries | Satisfied -- `AgentLoopConfig` is fully injected |
| Immutability by default | Satisfied -- context snapshots, accessor-gated state |
| Errors are data | Satisfied -- pi-mono encodes all errors as message fields |
| Exhaustiveness everywhere | Satisfied (with hybrid discriminant) |
| Make illegal states unrepresentable | Satisfied -- one Agent per run, single-active-run guard |
| YAGNI | Minor tension -- discriminant adds 10 lines. Justified by real domain states. |
| Functional/declarative | Minor tension -- mutable closure flag. Bounded and acceptable. |

---

## Findings

### RED -- None

### ORANGE: Stuck-loop timeout not in design

**Severity:** Orange (pre-production required, not blocking for design selection)

The daemon has no mechanism to abort an infinite tool-call loop. A misbehaving LLM can call Bash repeatedly for hours, consuming LLM credits without making workflow progress.

**Required mitigation (must implement before production deployment):**
1. `agent.abort()` after wall-clock timeout (configurable, e.g., 10 minutes per workflow run)
2. Max-turn counter in `getSteeringMessages` -- after N turns without `continue_workflow` being called, inject a steering message: 'You have been running for N turns. Please call continue_workflow now to advance the workflow.'

### YELLOW: `createDaemonConfig()` factory not formalized

**Severity:** Yellow (design gap, easy fix)

The design relies on each `Agent` instance having its own `AgentLoopConfig` closure. Without a factory function enforcing this, a developer could accidentally share the config object between runs, causing `isComplete` cross-contamination.

**Recommended fix:** Define `createDaemonLoopConfig(workrailClient: WorkRailMCPClient): AgentLoopConfig` as the only public API for creating a daemon config. The factory creates the closure-private `isComplete` flag and all WorkRail tool wrappers.

### YELLOW: `WorkflowContinueResult` discriminant not yet in design spec

**Severity:** Yellow (enhancement, not a flaw)

The current design uses a bare closure boolean for `isComplete`. The hybrid extension (typed `WorkflowContinueResult = { _tag: 'advance' } | { _tag: 'complete' } | { _tag: 'error' }`) should be added to the spec to satisfy WorkRail's exhaustiveness-everywhere principle.

---

## Recommended Revisions

1. **Add wall-clock timeout + max-turn counter to the design spec.** This is a pre-production requirement, not optional.
2. **Formalize `createDaemonLoopConfig()` factory.** Single entry point for daemon config creation.
3. **Add `WorkflowContinueResult` typed discriminant** to the `continue_workflow` tool's internal implementation spec.
4. **Pin `@mariozechner/pi-agent-core` to exact version** in `package.json` (no `^` prefix).

---

## Residual Concerns

1. **Protocol evolution:** If `continue_workflow` returns richer completion states in the future, the closure boolean needs upgrading to a typed union. Low urgency, but the discriminant hybrid makes this upgrade path clear.

2. **Checkpoint / pause-resume in the daemon:** Not yet addressed. If the daemon needs to honor WorkRail's `checkpointToken`, the `continue_workflow` tool needs a `{ _tag: 'checkpoint'; resumeToken: string }` variant in the `WorkflowContinueResult` discriminant. This is a future capability, not an MVP requirement.
