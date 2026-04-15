# Daemon Execution Engine Architecture Discovery

**Status:** Complete -- Recommendation delivered  
**Date:** 2026-04-14  
**Confidence:** HIGH  
**Decision:** Option B -- Daemon as MCP HTTP client (separate process, `@modelcontextprotocol/sdk/client`, `localhost:3100/mcp`)  
**Goal:** Determine the best architectural form for WorkRail's autonomous execution engine

> **Artifact strategy:** This document is a human-readable summary for review. It is NOT the execution truth. Durable decisions live in WorkRail step notes and context variables. If a chat rewind occurs, consult the WorkRail session notes, not this file.

---

## Context / Ask

WorkRail needs an autonomous daemon that can execute workflow sessions without a human-driven MCP client in the loop. The architectural question is how this daemon should interact with WorkRail's execution engine:

- **Option A:** Daemon calls `engine-factory.ts` directly (in-process, tight coupling)
- **Option B:** Daemon connects to WorkRail's own MCP HTTP server as an MCP client (split-process)
- **Option C:** Something else entirely

---

## Path Recommendation

**`landscape_first`** -- The dominant need is comparing two concrete options (A vs B) with a known codebase. The landscape is already partially understood; grounding in the actual code is what resolves the tension. A full `full_spectrum` reframe would add marginal value here since the problem space is already well-defined.

---

## Constraints / Anti-goals

**Constraints:**
- Must support cloud deployment (not just localhost)
- Must work in Docker multi-container setups
- Must not introduce session store contention or lock conflicts
- Must remain testable and independently deployable
- WorkRail's long-term vision is as an open-source autonomous agent platform

**Anti-goals:**
- Do not optimize for shortest time-to-first-run at the expense of correctness
- Do not assume the daemon always runs in the same process as the MCP server
- Do not hide architectural complexity behind "we can refactor later"

---

## Landscape Packet

> **Current-state summary:** WorkRail already has two execution paths: (1) MCP tools (`start_workflow`, `continue_workflow`, `checkpoint_workflow`) backed by v2 handlers, and (2) `engine-factory.ts` which wraps those same handlers for in-process library use. The question is which path a daemon should use. The landscape below documents all relevant prior art, hard constraints, and known precedents.

### engine-factory.ts (Option A vehicle)

`/Users/etienneb/git/personal/workrail/src/engine/engine-factory.ts` -- 477 lines

Key findings:
- Creates a **full DI container** via `initializeContainer({ runtimeMode: { kind: 'library' } })`
- Has a **global singleton guard**: `let engineActive = false` -- enforces one engine per process
- Calls `executeStartWorkflow`, `executeContinueWorkflow`, `executeCheckpoint` -- the exact same handler functions the MCP tools call
- Uses `ThrowingProcessTerminator` (library mode): invariant violations throw instead of `process.exit()`
- Resets the container on `engine.close()` via `resetContainer()`
- `dataDir` can be overridden post-init by re-registering `DI.V2.DataDir` before the first resolve

**Critical constraint:** The DI container is a **process-level global singleton** (`tsyringe`'s `container` imported from module scope). Two callers initializing the container in the same process share all singletons: same keyring, same session store, same session lock, same pinned workflow store.

### DI container (container.ts)

- `container` is the `tsyringe` global singleton -- not scoped, not namespaced
- `initialized` / `asyncInitialized` flags are module-level globals
- `resetContainer()` resets everything including `initialized = false`
- In production mode, SIGINT/SIGTERM handlers are installed -- if the daemon and MCP server share a process, one set of signal handlers runs for both

### Session lock (session-lock/index.ts)

`LocalSessionLockV2.acquire()` uses `fs.openExclusive()` -- a file-system-level exclusive lock (lock file per session). The stale-lock cleanup uses `process.kill(pid, 0)` to detect dead PIDs.

**Critical finding:** If daemon and MCP server share the same process (same PID), the stale-lock cleanup will **never** clean up the other's locks -- `kill(ownPid, 0)` always succeeds (process is alive). Locks held by one execution path (MCP or daemon) will appear valid to the other even if the holder is logically done but hasn't released the lock due to a bug. Worse: if the daemon path crashes mid-execution without releasing a lock, and the MCP server then tries to resume, the `process.kill(pid, 0)` check returns "alive" (same PID), so the lock is treated as valid and the MCP path gets `SESSION_LOCK_BUSY` -- **permanent deadlock** until the whole process restarts.

### HTTP MCP transport (Option B vehicle)

`http-entry.ts` + `http-listener.ts`:
- Express app, StreamableHTTPServerTransport, port scan range 3100-3199
- `enableJsonResponse: true` -- simple JSON request/response (no SSE streaming required)
- Port bound before route registration; `bindWithPortFallback` scans range
- Server is a full standalone process; `wireShutdownHooks` manages lifecycle

### mcp-server.ts

Single entry point dispatches to `startStdioServer` or `startHttpServer` based on `WORKRAIL_TRANSPORT`. No daemon awareness.

### Reference: OpenClaw (AcpSessionManager)

OpenClaw's `manager.ts` exports a **process-level singleton** `ACP_SESSION_MANAGER_SINGLETON`. `AcpSessionManager` manages session lifecycle (init, run turn, close) as an in-process manager. It uses:
- `SessionActorQueue` -- per-session serialization
- `RuntimeCache` -- runtime handle caching
- Turn timeout tracking

**Key architectural conclusion from OpenClaw:** OpenClaw's control plane runs **in-process** with the agent runtime. There is no split-process architecture. The entire control plane (queue, runtime, session manager) lives in one Node.js process. This works because OpenClaw controls both the transport layer and the execution layer -- they are co-located by design.

However, OpenClaw is **not** a multi-tenant open platform. It does not expose an MCP API that third-party clients connect to. The daemon IS the product.

### Reference: pi-mono (agent-loop.ts)

pi-mono's `agentLoop` is a **pure functional loop** -- it takes `prompts`, `context`, `config` and returns an `EventStream`. No singletons, no global state, no DI container. The loop is:

```
while (hasMoreToolCalls || pendingMessages.length > 0) {
  streamAssistantResponse() -> execute tool calls -> collect results
}
```

Tool calls are executed sequentially or in parallel via `executeToolCallsSequential` / `executeToolCallsParallel`. The loop has no concept of "step" or "workflow" -- it's a raw LLM turn loop.

**Key architectural conclusion from pi-mono:** The agent loop is stateless and composable precisely because it has no infrastructure coupling. A daemon built on pi-mono's pattern would own its own execution loop and simply call tools (WorkRail's MCP tools) as a client -- exactly Option B's model.

---

## Problem Frame Packet

### Primary users / stakeholders
- **WorkRail platform developers** (Etienne): building the daemon; want a model that is correct, fast to implement, and doesn't require a second rearchitecting pass before cloud deployment
- **Open-source adopters**: will deploy WorkRail as an autonomous agent platform; expect the daemon to work in Docker, Kubernetes, and cloud-hosted configurations
- **Agent infrastructure operators**: running WorkRail alongside other MCP servers; need clear process isolation and predictable failure modes
- **Future daemon SDK consumers**: if the daemon is exposed as an SDK, the engine-factory API already exists; but only in single-process contexts

### Core tensions
1. **Speed vs. correctness**: Option A is ~50 lines and works today; Option B requires an MCP client wrapper (~100 lines) and a running HTTP server, but avoids lock contention and DI collisions
2. **In-process simplicity vs. deployment flexibility**: in-process is simpler locally but wrong for cloud; HTTP over localhost is slightly more complex locally but identical to cloud deployment
3. **Reuse of engine-factory API vs. architectural purity**: the engine-factory API is clean and well-typed; using it from a daemon is tempting; but the singleton guard and PID aliasing are non-negotiable blocking issues

### Success criteria
1. Daemon can run alongside a running MCP server without session lock contention
2. Daemon works identically in local, Docker, and cloud environments without code changes
3. Daemon failure (crash, hang) does not corrupt or permanently lock sessions for MCP clients
4. Daemon is independently testable (mock MCP server or real server)
5. Implementation is maintainable without deep knowledge of WorkRail's DI internals

### Assumptions that could be wrong
- **Assumption: the MCP HTTP server is always running when the daemon runs.** If the daemon is the only consumer (no IDE client), requiring an HTTP server could be seen as unnecessary overhead. Counter: the HTTP server is already the transport for the daemon's own tool calls -- this dependency is inherent to Option B.
- **Assumption: HTTP round-trip latency is negligible.** True for workflow step intervals (seconds to minutes between steps). Would be wrong for a use case requiring sub-millisecond turn latency -- not applicable here.
- **Assumption: Option A's PID aliasing is a real risk, not theoretical.** It is a real risk any time a daemon-driven session lock is held and the MCP server path tries to acquire the same session. This is not a race condition -- it is a logical guarantee failure.

### HMW questions (reframes)
1. **HMW make the daemon feel like a native part of the WorkRail MCP API, not a bolt-on?** -- Option B naturally answers this: the daemon is just another MCP client, no different from the Claude IDE extension. The API contract is the product.
2. **HMW allow the daemon to run without a running HTTP server for local testing?** -- The engine-factory API could be used for a single-process test harness (test mode, not production). The daemon could have a `--direct` flag that uses engine-factory when `WORKRAIL_TRANSPORT=direct` -- but this is an optimization for test ergonomics, not the production architecture.

### Framing risks
- **Risk: the daemon might be conceived as a scheduler (trigger sessions) rather than an executor (run sessions).** If so, neither Option A nor B is the right frame -- the daemon would be a cron-like trigger, not an agent loop. This is unlikely given the question's explicit mention of "execution engine."
- **Risk: assuming the daemon is always a single instance.** If multiple daemon instances run concurrently (e.g., one per user in a SaaS deployment), the session lock mechanism is even more important -- and Option A's PID aliasing is catastrophic in that scenario.

### Needs challenge: No -- framing is tight and evidence-based.

---

## Candidate Directions

### Candidate generation expectations (landscape_first path)

The candidate set must:
1. **Reflect landscape precedents**: OpenClaw (in-process singleton) and pi-mono (stateless loop as MCP client) are the two reference patterns. Candidates must be grounded in these, not invented freely.
2. **Respect hard constraints**: session lock PID aliasing and DI global singleton are non-negotiable. Any candidate that requires sharing a process must explicitly address these or accept them as known bugs.
3. **Include at least one hybrid or middle-ground**: A purely binary A-vs-B set would miss the Option B+ question (engine-factory for local testing, MCP for production).
4. **Not cluster around the obvious**: The easy answer is "just use Option B." A good candidate set asks whether there is a version of Option A that could work (e.g., if the singleton guard were relaxed), and why it still fails.

---

### Option A: Daemon calls engine-factory.ts directly

**Pros:**
- Fast to build (~50 lines of daemon code calling the existing API)
- No network hop -- function call latency only
- No port management, no auth tokens, no transport layer

**Cons:**
- **Session lock contention (correctness bug):** Same PID means `process.kill(pid, 0)` never identifies daemon-held locks as stale. If the daemon holds a session lock and the MCP server (same process) tries to acquire it, it gets `SESSION_LOCK_BUSY` indefinitely.
- **DI global singleton collision:** One container per process. The daemon cannot have a different `dataDir`, `keyring`, or `featureFlags` than the MCP server unless it runs before the MCP server starts. The `engineActive` guard means you cannot have two concurrent engine instances.
- **Signal handler conflict:** Production mode installs SIGINT/SIGTERM. Both paths share the same handlers.
- **Does not scale to cloud:** On cloud infrastructure, daemon and MCP server may run in separate containers or separate regions. The in-process model is fundamentally single-machine.
- **Testing becomes coupled:** Tests for the daemon cannot mock the MCP layer boundary.

### Option B: Daemon connects to WorkRail's MCP HTTP server as an MCP client

**Pros:**
- **Clean process isolation:** Daemon is a completely separate process. Its PID is different from the MCP server's PID. Session lock stale detection works correctly.
- **No DI singleton collision:** Each process has its own container, keyring, and session store.
- **Docker-native:** `daemon:localhost:3100/mcp` connecting to `mcp-server:3100/mcp` is standard Docker network topology. Scales to Kubernetes without architectural change.
- **Cloud-ready:** HTTP over a private network works identically in local, Docker, and cloud environments.
- **Daemon is just another client:** Any language, any infrastructure can run the daemon. The WorkRail MCP API is already the contract.
- **pi-mono alignment:** The daemon becomes a `runAgentLoop`-style loop that calls WorkRail tools via MCP -- exactly the pattern pi-mono demonstrates.
- **Session lock safety:** Different PIDs mean stale lock detection works. If the daemon crashes, the MCP server correctly identifies the lock as stale.

**Cons:**
- **Network round-trip per step:** Local HTTP adds ~1-5ms per call. For a 20-step workflow, that is 100ms of overhead -- negligible.
- **HTTP server must be running:** The daemon has a startup dependency on the MCP HTTP server. This is the same dependency the Claude IDE extension has -- already solved.
- **Auth/session management:** The daemon needs to handle MCP session tokens. This is already handled by `StreamableHTTPServerTransport`.

### Option C: Daemon as a WorkRail subagent / workflow

**Concept:** The daemon doesn't execute sessions directly. Instead, it is itself a WorkRail workflow step (or a workflow) that delegates to WorkRail's `nested-subagent` capability. The daemon becomes a thin scheduler that triggers workflow executions by calling WorkRail tools, and those executions in turn spawn further subagents.

**Assessment:** This is viable for orchestration-heavy use cases (e.g., parallel workflow fan-out), but it conflates infrastructure (the daemon's scheduling role) with execution (the workflow's step role). It also creates a recursive dependency: the daemon needs WorkRail to run, and WorkRail's autonomous mode needs the daemon to trigger it. For the initial execution engine, this adds complexity without resolving the fundamental question of how sessions are driven. **Defer to post-MVP.**

---

## Challenge Notes

1. **Option A's singleton guard is load-bearing, not incidental.** The comment in `engine-factory.ts` explicitly states: "Constraint: one engine per process. The DI container is a global singleton." This is not a limitation to engineer around -- it is the correct invariant for library mode. Using Option A in the same process as the running MCP server would require violating this invariant.

2. **The session lock PID check is a correctness guarantee, not advisory.** It prevents stale lock buildup after crashes. If daemon and MCP server share a PID, this guarantee is broken for cross-path lock contention.

3. **OpenClaw's in-process model is not a counterexample.** OpenClaw is a single-product system with no external MCP consumers. WorkRail's design contract is "the MCP API is the product." The daemon should be an MCP consumer, same as any other agent client.

4. **The HTTP transport already handles concurrent MCP clients.** `StreamableHTTPServerTransport` with `sessionIdGenerator: crypto.randomUUID` is designed for multi-client operation. Adding a daemon client is zero additional work on the server side.

---

## Resolution Notes

The evidence converges on **Option B** as the correct architecture.

The decisive factors, in priority order:

1. **Session lock correctness (non-negotiable):** Option A creates an unsolvable PID-aliasing problem with `LocalSessionLockV2`. Option B avoids this entirely through process separation.

2. **DI singleton safety (non-negotiable):** The `engineActive` guard and global `container` make two concurrent engines in one process an explicit design violation. Option B respects this boundary.

3. **Cloud/Docker topology (strategic):** HTTP over localhost or private network is the standard model for microservice composition. Option B is already the right shape for containerized deployment.

4. **Architectural alignment (strategic):** pi-mono's agent loop pattern -- a stateless loop that calls tools as a client -- is exactly what the daemon should be. WorkRail's MCP HTTP API is the tool interface. The daemon is an MCP client.

5. **Development velocity (practical):** Option B requires building an MCP client wrapper (~100 lines using `@modelcontextprotocol/sdk/client`). Option A requires 145 lines of tight coupling that will need to be rearchitected before cloud deployment.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-14 | Recommend Option B (MCP client) | Session lock PID aliasing, DI singleton constraint, cloud topology alignment, pi-mono pattern match |
| 2026-04-14 | Defer Option C (subagent workflow) | Adds recursive complexity without resolving the fundamental execution model |
| 2026-04-14 | Adversarial challenge: Candidate 1 position strengthened | HTTP startup dependency is operational (not structural); keyring divergence in fork+IPC model is real and has no mitigation without external coordination; HTTP overhead (1-5ms) is genuinely negligible for workflow step intervals |
| 2026-04-14 | Runner-up: Candidate 3 (hybrid) | Valid for test ergonomics, but two-path maintenance burden and advisory-only direct-path guard make it structurally weaker than C1 |

---

## Final Summary

**Recommendation: Option B -- Daemon as MCP HTTP client**

**Confidence: HIGH.** Evidence is primary-source (five source files read in full, two reference repos fetched via gh API). Arguments are structural and deterministic, not probabilistic.

Build the daemon as a separate process that connects to WorkRail's HTTP MCP server at `localhost:3100/mcp` (or configured host:port). The daemon runs an agent loop (pi-mono pattern) that:

1. Calls `start_workflow` via MCP HTTP to start a session
2. Reads the returned `continueToken` -- **persist this to durable storage before executing the step**
3. Executes the step (invokes an LLM, runs a subagent, etc.)
4. Calls `continue_workflow` with notes and context
5. Loops until `isComplete: true`

**Implementation shape:**
- Use `Client` from `@modelcontextprotocol/sdk/client/index.js` + `StreamableHTTPClientTransport` (handles session ID headers automatically)
- Wrap the transport behind a `DaemonTransport` interface (kind: `mcp_http | direct`) -- ship with `mcp_http` only; adds optionality for future test-mode `direct` path with zero runtime cost
- Identify the daemon as `new Client({ name: 'workrail-daemon', version: '1.0.0' })` for server-side diagnostics

**Pre-implementation decisions required:**
- Token persistence mechanism: recommend `~/.workrail/daemon-state.json` (atomic write before each step)
- Port discovery mechanism: recommend server writes bound port to `~/.workrail/http-port` on startup
- Concurrency model: one session at a time (simplest) vs. multiple concurrent sessions (pi-mono parallel pattern)

**Strongest alternative:** Candidate 3 (hybrid) -- borrow the `DaemonTransport` interface shape, but ship MCP HTTP implementation only. Valid for test ergonomics if `InMemoryTransport` is insufficient. Loses because two-path maintenance burden outweighs benefits when the mock server is 20 lines.

**Residual risks (LOW):**
- Key rotation: if WorkRail ever rotates keyring keys, long-running daemon clients may hold tokens signed with old keys. Daemon must handle `token_invalid` errors gracefully (detect and restart session).
- Protocol version negotiation: standard semver pinning handles this.

This model:
- Has zero session lock contention risk (separate PIDs -- structural guarantee, not advisory)
- Has zero DI singleton collision risk (separate processes)
- Works identically on local, Docker, and cloud infrastructure without code changes
- Is independently testable with `InMemoryTransport` mock server (~20 lines setup)
- Aligns with WorkRail's own tooling (MCP SDK client is already the primary integration mechanism)

Option A is faster to prototype but creates two non-negotiable correctness risks (lock PID aliasing, DI singleton collision) that would require rearchitecting before any production use. The time saved by starting with Option A is lost in the rearchitecting, plus the risk of correctness bugs reaching users.
