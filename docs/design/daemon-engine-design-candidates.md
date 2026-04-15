# Daemon Execution Engine -- Design Candidates

**Status:** Raw investigative material -- for main agent review  
**Date:** 2026-04-14  
**Context:** Architecture decision for WorkRail's autonomous execution daemon

---

## Problem Understanding

### Core tensions

1. **Build speed vs. structural correctness**: `engine-factory.ts` is 477 lines and already wraps the exact same v2 handlers the MCP tools call. Using it from a daemon looks like a 50-line win. But it has two hard correctness bugs when used alongside a running MCP server.

2. **Colocation vs. isolation**: The DI container is a module-level tsyringe global singleton. Its design invariant is one container per process. Forcing two concurrent execution paths through it violates the invariant by design, not by accident.

3. **API surface stability vs. speed of access**: Option A gives the daemon access to internal handler functions (`executeStartWorkflow`, `executeContinueWorkflow`) -- no versioning, no contract boundary. Option B uses the MCP HTTP API -- versioned, stable, Zod-validated.

4. **Testing simplicity vs. deployment correctness**: Option A requires no running HTTP server in tests. Option B does (or a mock MCP server). This is a real cost, not a theoretical one.

### Likely seam

**OS process boundary.** WorkRail already has two modes: library (same process, no signals) and server (own process, HTTP transport). The daemon belongs in a third role: a separate process that is a consumer of the server's MCP HTTP API. The seam is the `/mcp` endpoint.

### What makes this hard / what a junior developer would miss

- `engineActive = false` in `engine-factory.ts` is a hard block, not advisory
- `process.kill(pid, 0)` in `LocalSessionLockV2` cannot distinguish two call paths that share a PID -- it will treat a daemon-held lock as valid even after the daemon crashes, because the process (MCP server) is still alive
- The DI global singleton means both paths share keyring material -- a compromise or divergence in one affects the other
- `ThrowingProcessTerminator` in library mode throws instead of calling `process.exit()` -- fine for embedding, but if the daemon has an invariant violation in this mode, the event loop continues in a possibly corrupt state

---

## Philosophy Constraints

From `/Users/etienneb/CLAUDE.md` and codebase patterns:

**Principles under most pressure:**
- **Make illegal states unrepresentable**: Option A makes a lock-held-by-same-process state possible and undetectable. Option B makes it structurally impossible.
- **Dependency injection for boundaries**: Option A collapses the boundary between daemon and server infrastructure. Option B preserves it -- the MCP API is the injected boundary.

**Principles that both options satisfy:**
- **Errors are data** (`neverthrow` / `ResultAsync`): Both options can surface typed errors.
- **YAGNI with discipline**: Neither option over-engineers.

**No stated-vs-practiced conflicts** observed in the codebase.

---

## Impact Surface

If Option B is chosen:
- `http-entry.ts` / `http-listener.ts`: no changes needed -- HTTP server is already multi-client
- `StreamableHTTPServerTransport` with `sessionIdGenerator: crypto.randomUUID`: already handles concurrent MCP clients
- Daemon uses `@modelcontextprotocol/sdk/client` (already a dependency for the SDK)
- `continueToken` / `checkpointToken` are the only state the daemon carries between steps

If Option A were chosen (rejected):
- `engineActive` guard would need to be bypassed or disabled -- violates explicit design intent
- `LocalSessionLockV2.acquire()` would give false "lock is valid" results for daemon-held locks after daemon crashes
- Both paths would share the same `DI.V2.Keyring` instance -- any key rotation in one path invalidates tokens in the other

---

## Candidates

### Candidate 1: Daemon as MCP HTTP client (RECOMMENDED)

**Summary:** Separate OS process. Uses `@modelcontextprotocol/sdk/client` pointed at `localhost:3100/mcp`. Drives sessions via `start_workflow` / `continue_workflow` HTTP calls. No shared in-process state with the MCP server.

**Tensions resolved:**
- Colocation vs. isolation: resolved -- different PIDs, separate DI containers
- API stability: resolved -- MCP HTTP contract is versioned and Zod-validated
- Cloud/Docker portability: resolved -- HTTP over localhost = HTTP over private network

**Tension accepted:** Testing requires a running HTTP server or mock MCP server.

**Boundary solved at:** OS process boundary via HTTP. This is the boundary WorkRail already establishes for its MCP transport.

**Why this boundary is the best fit:** The `engineActive` guard, the DI global singleton, and the PID-based lock check are all designed around the process boundary as the fundamental isolation unit. Respecting this boundary means working with the codebase's invariants, not against them.

**Failure mode:** MCP session token propagation -- `StreamableHTTPServerTransport` requires `Mcp-Session-Id` headers after session establishment. The MCP SDK client handles this automatically; using raw `fetch` would require manual header management. Mitigation: use the SDK client.

**Repo-pattern relationship:** Follows `http-entry.ts` (HTTP transport already established). Adapts pi-mono's `agentLoop` (stateless loop calling external tools). No departure from existing patterns.

**Gains:**
- Zero session lock contention
- Zero DI collision
- Cloud/Docker portable without code changes
- Independently testable with mock server
- Daemon crash only affects its own sessions (no shared state to corrupt)

**Gives up:**
- Direct function call latency (~1-5ms per step vs. microseconds)
- Requires MCP HTTP server to be running at startup

**Scope judgment:** Best-fit. Directly addresses the problem without over-engineering.

**Philosophy fit:**
- Honors: make-illegal-states-unrepresentable, DI-for-boundaries, validate-at-boundaries, errors-are-data
- Conflicts: none

---

### Candidate 2: engine-factory via child_process.fork + IPC

**Summary:** Daemon forks a child process that exclusively runs `createWorkRailEngine()`. Parent sends JSON-serialized `{ kind: 'start' | 'continue' | 'checkpoint', ... }` messages over `process.send()` IPC. Child responds with serialized `EngineResult`. Different PIDs -- lock check works.

**Tensions resolved:**
- Colocation vs. isolation: resolved (different PIDs via fork)
- Test ergonomics: resolved (no HTTP server needed)

**Tension accepted:**
- API surface stability: weak -- IPC message format is ad-hoc, not versioned
- New keyring divergence risk: if two processes load the same keyring file independently and either rotates keys, token signatures from the other process become invalid
- Cloud/Docker: forks don't cross container boundaries; must be replaced with a network transport for cloud

**Boundary solved at:** OS process boundary via `child_process.fork()` IPC.

**Why this boundary is NOT the best fit:** It introduces a novel IPC protocol not present in the codebase and creates a keyring divergence risk that does not exist in Option B. The fork model works locally but fails in Docker multi-container or any distributed deployment.

**Failure mode (critical):** Keyring divergence. Two processes loading the same `~/.workrail/keyring.json` get the same initial HMAC keys. But if either process rotates keys (key expiry, re-keying), the other process's in-memory keyring diverges. Tokens signed by process A may fail validation in process B. This is a non-obvious correctness risk with no mitigation short of external coordination.

**Repo-pattern relationship:** Departs from existing patterns. No `child_process.fork()` or IPC in the codebase.

**Gains:**
- PID isolation (lock check works)
- No HTTP server dependency
- Reuses typed `WorkRailEngine` API

**Gives up:**
- Introduces ad-hoc IPC protocol
- Keyring divergence risk
- No cloud portability
- More maintenance burden than Option B

**Scope judgment:** Too broad. Solves the PID problem but introduces a new correctness risk. More complex than Option B without the deployment benefits.

**Philosophy fit:**
- Honors: make-illegal-states-unrepresentable (PIDs now different), errors-are-data
- Conflicts: YAGNI (novel IPC layer), validate-at-boundaries (IPC serialization is unvalidated), architectural-fixes-over-patches (this is a patch, not a fix)

---

### Candidate 3: Hybrid -- MCP HTTP in production, engine-factory in test/local

**Summary:** At startup, the daemon checks: if `WORKRAIL_TRANSPORT=http` and `localhost:{port}/mcp` is reachable, use Candidate 1 (MCP HTTP client). Otherwise, use `createWorkRailEngine()` directly (Candidate A). Internal `DaemonTransport` union type: `{ kind: 'mcp_http'; client: McpClient } | { kind: 'direct'; engine: WorkRailEngine }`.

**Tensions resolved:**
- Test ergonomics: resolved (direct path needs no HTTP server)
- Build speed: partially resolved (reuse engine-factory for local scenarios)

**Tension accepted:** Two code paths must be maintained. Any new engine feature must be reflected in both, or the direct path diverges from the MCP path over time.

**Boundary solved at:** Startup-time capability detection. Adapts the `resolveTransportMode()` pattern from `mcp-server.ts`.

**Why this boundary is not the best fit:** The `direct` path still has the `engineActive` singleton constraint and the PID aliasing risk if an MCP server is accidentally co-located. The runtime check protecting against this is advisory (a thrown Error), not structural (a type system constraint).

**Failure mode:** If `WORKRAIL_DAEMON_TRANSPORT=direct` is set in a production environment where an MCP server is also running, the PID aliasing bug returns silently. There is no compile-time protection.

**Repo-pattern relationship:** Adapts `resolveTransportMode()` from `mcp-server.ts`. Reasonable adaptation.

**Gains:**
- Test ergonomics (no HTTP server needed in direct mode)
- Migration path for library embedding use cases

**Gives up:**
- Two-path maintenance burden
- Direct path safety is advisory, not structural
- Adds conditional logic to every daemon session operation

**Scope judgment:** Slightly too broad for the production case. Best-fit only if test ergonomics is a primary blocking concern.

**Philosophy fit:**
- Honors: YAGNI (reuses existing API), errors-are-data
- Conflicts: make-illegal-states-unrepresentable (direct path allows aliasing), architectural-fixes-over-patches (hybrid is a patch)

---

## Comparison and Recommendation

| Criterion | C1 (MCP HTTP) | C2 (fork+IPC) | C3 (hybrid) |\n|-----------|-------------|-------------|------------|\n| Lock contention | Resolved structurally | Resolved via fork | Resolved in prod path |\n| DI isolation | Resolved | Resolved | Resolved in prod path |\n| Keyring safety | N/A (server owns it) | New risk | N/A in MCP path |\n| Cloud/Docker | Excellent | Poor (no cross-container fork) | Good only in MCP path |\n| API stability | Strong (MCP contract) | Weak (ad-hoc IPC) | Mixed |\n| Test ergonomics | Needs mock server | No server needed | No server needed (direct) |\n| Maintenance burden | Low (single path) | High (IPC layer) | Medium (two paths) |\n| Repo pattern fit | Excellent | Poor | Acceptable |\n| Philosophy alignment | Strong | Weak | Mixed |\n\n**Recommendation: Candidate 1 (MCP HTTP client)**

All five decision criteria are satisfied structurally, not by advisory guards or operational conventions. Cloud portability is zero-cost. The implementation is the shortest path to correctness (~100 lines for the daemon's MCP client wrapper + agent loop), not the shortest path to a running prototype.

---

## Self-Critique

**Strongest counter-argument against C1:**
The MCP HTTP server must be running before the daemon operates. In a single-binary deployment, this requires orchestrating two processes. In practice: use a process supervisor (PM2, systemd, Docker Compose `depends_on`), or have the daemon implement a startup retry loop. This is operational boilerplate, not a correctness problem.

**What narrower option might still work:**
Candidate 3 (hybrid) satisfies all criteria in its MCP path. It loses because the two-path maintenance burden and the advisory-only guard on the direct path make it structurally weaker than C1 with no material benefit that C1 cannot achieve with a test-only mock server.

**What broader option might be justified:**
A full job queue (Redis/BullMQ backing the daemon) for multi-tenant SaaS scale. Evidence required: concurrent sessions, multiple daemon instances, distributed scheduling. Not in scope.

**Assumption that would invalidate this design:**
The daemon must operate in an air-gapped/offline environment with no localhost HTTP available. In that case, Candidate 2 (fork+IPC) is the right shape -- but requires resolving the keyring divergence risk first (e.g., move token signing to a shared file-based signing service, or use the same process for both keyring and daemon).

---

## Open Questions for the Main Agent

1. Is the MCP HTTP startup dependency acceptable, or is there a single-binary deployment requirement that makes Option B impractical?
2. Should the daemon use a test-mode mock MCP server (simulated in-memory) or a real HTTP server in unit tests?
3. Should the `DaemonTransport` abstraction from Candidate 3 be built as a future extension point even if only the MCP path is implemented initially?
4. Is the 1-5ms HTTP overhead per step a real concern for the planned step intervals (seconds to minutes), or is it safe to ignore?
5. What is the expected concurrency model for the daemon -- one session at a time, or multiple concurrent sessions driving different workflows?
