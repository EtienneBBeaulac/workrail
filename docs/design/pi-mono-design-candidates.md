# pi-mono Integration: Design Candidates for WorkRail Auto Daemon

**Prepared for main-agent review -- 2026-04-14**
**Status:** Raw investigative material. Main agent owns final decision.

---

## Problem Understanding

### Core tensions
1. **Structural termination vs semantic completion** -- pi-mono's Agent terminates when no tool calls remain and no steer/followUp messages are queued. WorkRail session completion is semantic (isComplete flag from continue_workflow). The daemon must bridge these without adding extra LLM turns.
2. **Per-run isolation vs per-session efficiency** -- creating a fresh Agent per workflow run guarantees no cross-run state contamination; reusing an Agent across runs (like mom) is more efficient but requires careful reset() calls.
3. **Throw-on-failure (pi-mono) vs Result<T,E> (WorkRail)** -- AgentTool.execute() is expected to throw; WorkRail engine handlers return Result. The boundary is the tool execute() wrapper.
4. **Enforcement inside the loop vs at the boundary** -- WorkRail's HMAC token protocol is enforced by the engine handler, not the daemon. Daemon must call handlers in order and not bypass the token protocol.

### Likely seam
New file: `src/daemon/workflow-runner.ts`. Wraps pi-mono Agent, exposes `runWorkflow(sessionId, continueToken)`. Engine handlers injected as dependencies. KeyedAsyncQueue in daemon orchestrator (outside the runner) serializes concurrent calls per sessionId.

### What makes this hard
- steer() is called from inside tool execute() (inside the agent loop). The KeyedAsyncQueue serializing concurrent sessions must be OUTSIDE the agent, not inside it. A junior developer would put the queue inside the agent and create a deadlock.
- steer() vs followUp() distinction: steer() fires after each tool batch (inner loop); followUp() fires only when the agent would stop (outer loop). Using followUp() for step injection adds an unnecessary extra LLM turn per step.
- Token persistence BEFORE the engine call (not after) is required for crash safety.

---

## Philosophy Constraints

From `CLAUDE.md` (always-loaded system rules):
- **Immutability by default** -- per-run state must be a fresh object per run, not mutated across runs
- **Errors are data** -- engine handlers return Result<T,E>; the throw/Result boundary at execute() must be explicit
- **Make illegal states unrepresentable** -- isComplete=true + pendingSteeringMessages.length > 0 is an illegal state; type system should prevent it
- **Determinism over cleverness** -- same inputs, same outputs; no hidden shared state across sessions
- **YAGNI with discipline** -- no compaction, no retry at MVP; clear seams for later addition

**Philosophy conflict:** pi-mono's AgentTool.execute() uses throw-on-failure; WorkRail prefers Result<T,E>. Resolution: wrap engine handler Result errors as thrown Error objects inside execute() -- this respects both conventions at their respective boundaries.

---

## Impact Surface

Files that must stay consistent if the daemon is added:
- `src/v2/usecases/continue-workflow.ts` -- should accept optional AbortSignal for daemon cancellation (new parameter, backward-compatible)
- `src/mcp/handlers/` -- MCP handlers must remain unchanged; daemon adds a new entry point
- `src/v2/infra/local/session-lock/index.ts` -- **prerequisite fix**: PID + workerId required before daemon can safely coexist with MCP server (see backlog "Fix LocalSessionLockV2 with workerId")
- `src/daemon/` -- new module, no existing code affected

---

## Candidates

### Candidate A: Per-run Agent with steer() injection (Recommended)

**Summary:** Create a fresh `Agent` instance per workflow run. Inject WorkRail step instructions via `agent.steer()` after each `continue_workflow` advance. Terminate by not queueing more steer messages when `isComplete`.

**Tensions resolved:**
- Structural-vs-semantic: steer queue empties naturally when workflow complete -- no extra LLM turn
- Per-run isolation: fresh Agent per run = no cross-run state contamination

**Tension accepted:**
- Slightly higher construction overhead per run (~1ms, negligible for human-paced sessions)

**Boundary:** `src/daemon/workflow-runner.ts` -- one new file, ~150 LOC

**Why this boundary is best-fit:** No tighter boundary handles concurrent sessions. No broader boundary is needed at MVP. The boundary is the exact unit of work.

**Failure mode:** steer() called after isComplete due to race in tool execute(). Prevention: `runState.isComplete` boolean flag checked before steer().

**Repo-pattern relationship:** Adapts mom's `createRunner()` pattern (mutable per-run state in closure, subscribe once). Departs on lifecycle: fresh Agent per run vs mom's reuse across messages. The departure is justified because WorkRail sessions have strict isolation requirements chat bots don't.

**Gains:** Maximum isolation, simplest state reasoning, crash-safe by construction, honors all philosophy principles

**Losses:** Agent construction overhead per run (~1ms)

**Scope judgment:** Best-fit. Not too narrow (handles concurrent sessions). Not too broad (no speculative abstractions).

**Philosophy fit:** Honors Immutability, Determinism, YAGNI, Compose-small-pure-functions. One conflict (throw/Result) explicitly managed.

---

### Candidate B: Per-session Agent with reset() (Challenger)

**Summary:** Create one `Agent` per long-running daemon session. Call `agent.reset()` between workflow runs. Reuse the Agent instance across triggers for the same session.

**Tensions resolved:**
- Construction efficiency: Agent + tools built once per session

**Tension accepted:**
- Per-run isolation requires explicit reset() -- any forgotten state causes cross-run contamination

**Boundary:** Same as Candidate A, plus `DaemonSessionPool` managing a pool of reusable Agents

**Why this boundary is too broad:** DaemonSessionPool is an unneeded abstraction when sessions are short-lived (10-40 steps, ~5 minutes). Speculative optimization.

**Failure mode:** reset() misuse -- Agent has multiple state fields; missing one in reset() causes subtle cross-run bugs. Harder to test exhaustively.

**Repo-pattern relationship:** Directly follows mom's createRunner() pattern without departure.

**Gains:** Lower construction overhead. Closest to pi-mono reference architecture.

**Losses:** Per-run isolation guarantee. More complex state management. reset() correctness must be audited.

**Scope judgment:** Slightly too broad for MVP. Pool management unneeded.

**Philosophy fit:** Conflicts Immutability (mutable Agent across runs), Conflicts Determinism (reset() correctness is required invariant). Honors YAGNI (no extra construction).

**Verdict:** Not recommended for MVP. Construction savings are negligible; isolation risk is real.

---

### Candidate C: Flat async loop without Agent class (Disqualified)

**Summary:** Implement daemon as a plain while loop calling `completeSimple()` directly, with manual tool dispatch. No Agent class used.

**Tensions resolved:** None of the structural-vs-semantic tension (loop IS semantic). Maximum control.

**Tension created:** Loses all pi-mono hooks -- beforeToolCall (evidence gating), afterToolCall (tool observation), subscribe (console live view), abort (REST cancellation). Must re-implement everything from scratch.

**Boundary:** Same new `src/daemon/` module but ~500 LOC vs ~150 LOC.

**Why this boundary is wrong:** AgentTool dispatch, parallel tool execution, AbortSignal threading are all already handled correctly by pi-mono. Re-implementing them introduces new bugs.

**Failure mode:** Parallel tool call races. pi-mono already handles sequential/parallel dispatch correctly.

**Repo-pattern relationship:** Departs from all pi-mono patterns. Goes back to raw API calls.

**Gains:** Maximum control. No abstraction surface to misunderstand.

**Losses:** beforeToolCall (evidence gating), afterToolCall (tool observation), subscribe (console live view), agent.abort() (REST cancellation) -- ALL features WorkRail Auto needs.

**Scope judgment:** Wrong level. Using raw API when the abstraction exists for a reason.

**Philosophy fit:** Conflicts YAGNI (re-implements pi-mono), Conflicts Architectural-fixes-over-patches.

**Verdict:** DISQUALIFIED. Loses all features WorkRail needs.

---

## Comparison and Recommendation

| Criterion | Candidate A | Candidate B | Candidate C |
|---|---|---|---|
| Enforcement preserved | YES | YES | YES |
| Crash-recoverable | YES | YES | YES |
| Concurrent-safe | YES | PARTIAL | YES |
| Hooks available | YES | YES | NO |
| Per-run isolation | YES | PARTIAL | YES |
| Construction cost | ~1ms/run | ~0ms/run | ~0ms/run |
| State management complexity | Low | Medium | Low |
| Philosophy alignment | Strong | Weak | Weak |
| Scope judgment | Best-fit | Too broad | Wrong level |

**Recommendation: Candidate A**

The per-run Agent with steer() injection is the best-fit solution. It resolves all 4 core tensions, meets all 3 decision criteria, honors the dev's stated philosophy, adapts the best reference pattern with a justified departure, and has the most manageable failure mode. The ~1ms construction overhead is negligible for human-paced workflow sessions (steps run seconds to minutes apart, not milliseconds).

---

## Self-Critique

**Strongest argument against Candidate A:** If WorkRail Auto runs hundreds of concurrent sessions at sub-second step cadence, per-run Agent construction becomes meaningful. Counter: WorkRail sessions are human-paced; even at 100 concurrent sessions, construction is not a bottleneck. The bottleneck is LLM latency (~500ms-2s per turn), not Agent construction (~1ms).

**Narrower option that still works:** Per-run Agent with NO hooks (no beforeToolCall, no afterToolCall, no subscribe). This loses evidence gating and console live view -- exactly the features that differentiate WorkRail Auto. Does not win.

**Broader option that might be justified:** AgentSession wrapper from coding-agent (compaction, retry, extensions). Evidence required: observed context overflow in test runs. Not needed at MVP (sessions are 10-40 steps, well within 200k token context window).

**Assumption that would invalidate this design:** WorkRail engine handlers are NOT safe to call from inside a tool execute() function (re-entrant loop issue). Currently safe for direct function calls. Invalidated only if the engine gains async background work that re-uses the same session state during a tool call.

**Pivot conditions:**
- If per-run construction shows >10ms overhead in profiling: move to Candidate B with explicit reset() contract
- If context window overflow observed in test runs: add compaction wrapper
- If re-entrant engine call issues found: switch to HTTP client mode (Option B from daemon architecture decision)

---

## Open Questions for Main Agent

1. Should the continue_workflow tool execute() function catch all engine errors and throw, or pass Result errors as error tool results? (Current proposal: throw -- pi-mono catches and converts to error tool result automatically.)
2. Is the `steeringMode: "one-at-a-time"` default correct? Confirm: one WorkRail step per steer() call, not batched.
3. Should `agent.abort()` be wired to a per-session AbortController managed by the daemon orchestrator, or to a global shutdown signal? (Proposed: per-session AbortController for cancel; SIGTERM maps to all controllers.)
4. The session lock workerId fix is listed as a prerequisite. Is it actually blocking, or can the daemon use a separate DI container that gets its own session lock instance?
