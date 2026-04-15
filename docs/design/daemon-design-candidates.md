# WorkRail Daemon Architecture: Design Candidates

> Raw investigative material for main-agent synthesis. Not a final decision.
> Generated: 2026-04-14.

---

## Problem Understanding

### Core tensions

1. **Single-process simplicity vs. concurrent-session correctness.**
   The `engineActive` guard exists because the DI container is a global singleton.
   Sequential sessions (one at a time) are safe but not scalable. Concurrent sessions
   require either exposing a single shared engine instance (same process) or using
   separate processes (isolated engines). These have different deployment implications.

2. **Direct handler calls vs. MCP tool protocol portability.**
   `engine-factory.ts` calls `executeStartWorkflow` / `executeContinueWorkflow` directly,
   bypassing JSON-RPC. This is faster and already built, but it couples the daemon to
   the internal handler API. Changes to handler signatures require daemon changes.
   The MCP protocol layer is what makes callers swappable.

3. **Freestanding vs. dependency-rich agent loop.**
   `npx -y @exaudeus/workrail` portability is a core feature. Adding pi-mono as a
   dependency doubles the surface area. But building a custom agent loop from scratch
   converges on the same patterns.

4. **Self-enforced trust model.**
   In autonomous mode, the daemon is both driver and enforced entity. The HMAC token
   protocol prevents token forgery, but the daemon can choose not to call `continueWorkflow`
   at all. Enforcement integrity relies on the daemon being well-behaved.

### Likely seam

The seam between the engine and the agent loop is clean and already designed:
- Engine produces: `{ pending: { prompt: string, stepId, title } }`
- Agent loop consumes: the prompt, calls LLM, executes tool calls, returns
  `{ notesMarkdown: string, context: Record<string, unknown> }`
- Engine accepts: `continueWorkflow(stateToken, ackToken, output, context)`

The daemon's job is to close this loop. The seam is at `pending.prompt` going in and
`{ notesMarkdown, context }` coming out.

### What makes this hard (junior developer blind spots)

1. **Token durability across the agent loop.** The `continueToken` must survive process
   crashes between LLM calls. If the process crashes after the LLM responds but before
   `continueWorkflow` is called, the step is re-attempted on next start. The dedup key
   system (`advance_recorded:sessionId:nodeId:attemptId`) handles this correctly, but
   the daemon must persist the token durably.

2. **Tool call routing within the agent loop.** LLM responses contain tool calls that
   must be executed and results returned to the LLM BEFORE the LLM produces the final
   `notesMarkdown` output to feed to `continueWorkflow`. This is the `agentLoop` pattern
   from pi-mono -- it is a multi-turn LLM loop, not a single call.

3. **Session lifecycle vs. agent context lifecycle.** A WorkRail session is durable (event
   log, tokens, steps). An LLM context window is ephemeral (messages, tool results). The
   daemon must coordinate these two lifecycles: the WorkRail session survives context
   compaction; the LLM context window does not.

---

## Philosophy Constraints

From CLAUDE.md (system instructions), confirmed by code patterns:

- **Errors are data (neverthrow ResultAsync):** All handler code uses `RA` (ResultAsync)
  chains. Daemon code MUST follow the same pattern. No try/catch in the agent loop.
- **Branded types:** Daemon config must use branded types for credentials
  (`AnthropicApiKey`, `GitLabToken`, etc.), not primitive strings.
- **DI for boundaries:** The agent loop (LLM caller) MUST be injected as an
  `AgentLoopPort`, not hardcoded to Anthropic SDK. This makes the LLM provider swappable.
- **Exhaustive discriminated unions:** `DaemonConfig` process-boundary choice should be
  a discriminated union, not a boolean flag.
- **YAGNI with discipline:** The REST control plane is not speculative -- it is required
  for human oversight in the changed trust model. The `engineActive` guard change is not
  speculative -- it is required for concurrent sessions.

**Philosophy conflicts: none.** The codebase exactly embodies the CLAUDE.md principles.
No conflict between stated philosophy and repo patterns.

---

## Impact Surface

### What must stay consistent if the daemon is added

- `engine-factory.ts`: the `engineActive` guard and `createWorkRailEngine()` API. The
  daemon must not require breaking changes to this API.
- `src/mcp-server.ts`: the MCP server entry point must be unchanged. Existing Claude
  Code / Cursor users must see no difference.
- The session store append-only invariant: daemon sessions write to the same store as
  MCP sessions. The lock protocol must hold under concurrent access.
- The token protocol: daemon-initiated sessions produce HMAC tokens identical to
  MCP-initiated sessions. The console must not distinguish them.
- Existing workflows: zero changes required. The daemon reads `pending.prompt` from the
  workflow step; the workflow does not know who is driving.

### Nearby callers and consumers

- Console (`console/`) -- reads session history from the same store. If daemon sessions
  are added, they appear in the session list immediately (no console changes needed for
  basic visibility; REST control plane needed for live view).
- `src/engine/index.ts` -- the library export surface. If `createWorkRailEngine()` is
  changed, consumers of the engine library must be updated.
- `src/di/container.ts` -- the DI container. Any change to the `engineActive` guard
  touches the container's initialization path.

---

## Candidates

### Candidate 1: Minimal Sequential Daemon

**Summary:** `src/daemon/entry.ts` calls `createWorkRailEngine()`, runs one session at a
time via FIFO queue, drives the agent loop with direct Anthropic SDK calls, exits after
each session.

**Tensions resolved:** Simplicity; single-process; `engineActive` guard avoided via queue.
**Tensions accepted:** No concurrent sessions; no live view; no human override.
**Boundary:** `src/daemon/` only. No changes to engine, MCP server, or console.
**Why this boundary:** The minimum viable boundary that proves autonomous execution works.
**Failure mode:** Session throughput bottleneck. If sessions are 30-60 min each, the
queue grows unbounded. Acceptable for MVP; unacceptable for production.
**Repo pattern:** Directly follows `engine-factory.ts`. The engine was built for this.
**Gain:** Ships fast, proves the agent loop concept, zero architectural risk.
**Give up:** No concurrency, no live view, no human override.
**Scope:** Too narrow for 12-month platform. Best-fit for 3-month proof-of-concept.
**Philosophy:** Perfect fit. YAGNI applied correctly for a proof-of-concept target.

---

### Candidate 2: Pure MCP Client Daemon

**Summary:** A separate `workrail-daemon` process connects to the running WorkRail MCP
server over HTTP, calls `start_workflow` / `continue_workflow` via JSON-RPC, with no
direct engine access.

**Concrete shape:**
- `packages/daemon/src/mcp-client.ts` -- `call(toolName, input)` over HTTP JSON-RPC
- `packages/daemon/src/trigger/` -- trigger listeners
- `packages/daemon/src/agent-loop/` -- same structure as C1 but calls MCP client
- Deployment: two Docker services (MCP server + daemon)

**Tensions resolved:** Clean process boundary; no `engineActive` concern; maximally
decoupled; crash isolation; deployable anywhere.
**Tensions accepted:** JSON-RPC overhead per step; two-process local dev; MCP server is
single point of failure for both human and autonomous sessions.
**Boundary:** Separate package/process. MCP HTTP transport is the interface.
**Why this boundary:** The MCP protocol is the stable public interface. Calling it from
the daemon ensures the daemon is never coupled to handler internals.
**Failure mode:** MCP server crash stops both Claude Code users and autonomous sessions.
**Repo pattern:** Departs from `engine-factory.ts`. Treats the MCP server as a black box.
**Gain:** Maximum decoupling; daemon can be any language; natural cloud model.
**Give up:** Two-process deployment; HTTP overhead; MCP server as prerequisite.
**Scope:** Best-fit for 18-24 month distributed cloud. Too broad for MVP.
**Philosophy:** Honors DI at the process level (ultimate boundary). Mild YAGNI conflict.

---

### Candidate 3: Composite Same-Process (recommended)

**Summary:** `src/daemon/` calls the engine via a shared instance (not two separate
`createWorkRailEngine()` calls), with concurrent sessions managed by `DaemonSessionManager`,
and a thin REST/SSE control plane added to the existing HTTP server.

**Concrete shape:**
- `src/engine/engine-factory.ts` change: instead of a boolean `engineActive` guard, expose
  a `getSharedEngine(config): WorkRailEngine` that creates the engine once and returns the
  same instance to all callers (MCP server entry + daemon entry). The guard becomes:
  "container initialized: yes/no" rather than "engine in use: yes/no."
- `src/daemon/session-manager.ts` -- `DaemonSessionManager`: `Map<SessionId, DaemonSession>`,
  each session running as an independent `Promise` chain with its own `continueToken`.
  `DaemonSession = { continueToken: string; status: 'running' | 'paused' | 'complete' | 'failed'; abortController: AbortController }`
- `src/daemon/agent-loop/step-runner.ts` -- `runStep(pending: PendingStep, toolExecutor, llmPort): Promise<StepOutput>`.
  Multi-turn loop: call LLM -> execute tool calls -> return to LLM -> repeat until
  LLM produces `continueWorkflow` output. `StepOutput = { notesMarkdown: string; context: Record<string, unknown> }`
- `src/daemon/trigger/gitlab-webhook.ts` -- HTTP listener, parses MR opened events.
- `src/daemon/tool-executor/local.ts` -- `Bash(cmd: string): RA<string, ToolError>`,
  `Read(path: string): RA<string, ToolError>`, `Write(path, content): RA<void, ToolError>`.
  Also `BashInRepo(repo: string, cmd: string)` for cross-repo routing.
- REST additions to existing HTTP server:
  - `GET /api/v2/sessions/:id/daemon-status` -- `{ status, currentStepTitle, startedAt }`
  - `POST /api/v2/sessions/:id/pause`
  - `POST /api/v2/sessions/:id/resume`
  - `DELETE /api/v2/sessions/:id` (cancel + abort LLM call)

**Tensions resolved:** Single deployment; concurrent sessions; live view; human override;
`engineActive` solved by shared instance (not relaxed); correct enforcement (HMAC identical
for daemon and manual sessions).
**Tensions accepted:** Shared process means shared failure domain (daemon crash affects MCP
server -- use process supervisor to restart).
**Boundary:** Same process; new `src/daemon/` module; minor HTTP server additions.
**Why this boundary:** The 12-month success criteria require concurrent sessions AND live
view AND single deployment. This is the only candidate that satisfies all three.
**Failure mode:** If the daemon's agent loop has a bug that crashes the process, the MCP
server also goes down. Mitigation: crash isolation within the daemon (try/catch at the
session manager boundary, not inside handlers) and a process supervisor.
**Repo pattern:** Directly adapts `engine-factory.ts`. Requires one targeted change to the
engine factory (shared instance pattern). All other code follows existing patterns.
**Gain:** Single process, concurrent sessions, live view, human control, upgrade path to C4.
**Give up:** Shared failure domain (vs. C4's isolated processes).
**Scope:** Best-fit for 12-month vision.
**Philosophy:** Honors DI (engine injected, `AgentLoopPort` injected), errors-as-data
(ResultAsync throughout), immutability (session store append-only), exhaustiveness
(`DaemonSession.status` is a discriminated union). No conflicts.

---

### Candidate 4: Composite Separate-Process

**Summary:** The daemon runs as a separate process with its own `createWorkRailEngine()`
instance, sharing durable session state with the MCP server through a shared `dataDir`.

**Concrete shape:**
- `packages/daemon/src/entry.ts` -- new process, calls `createWorkRailEngine({ dataDir: sharedPath })`
- Same `DaemonSessionManager`, `step-runner`, `trigger/`, `tool-executor/` as C3
- Separate HTTP port (default: 3101) for daemon control plane
- `withHealthySessionLock` file locking ensures safe cross-process session store writes
- Console proxies to both port 3100 (MCP server) and port 3101 (daemon) for live view

**Tensions resolved:** No `engineActive` guard change needed (each process has one engine);
crash isolation (daemon crash does not affect MCP server); natural cloud upgrade path.
**Tensions accepted:** Two-process deployment for local dev; filesystem coordination limits
to single machine without shared volume; separate HTTP port for daemon control.
**Boundary:** Separate process with shared filesystem state.
**Why this boundary:** Cleanest architectural expression. No guard changes. Natural path
to cloud (swap `LocalDataDirV2` for a remote-backed store port).
**Failure mode:** Lock contention on shared session store under high concurrent load.
`withHealthySessionLock` handles this, but cross-process file locking has not been tested
with two WorkRail processes.
**Repo pattern:** Adapts `engine-factory.ts` correctly (one engine per process). Departs
from single-process assumption in `mcp-server.ts`.
**Gain:** Clean process boundary; no guard change; independent scaling; cloud-natural.
**Give up:** Two-process local dev; lock contention risk; more complex setup.
**Scope:** Best-fit for 18-month cloud target. Slightly broad for 12-month local-first.
**Philosophy:** Architecturally the purest expression of all principles. One engine per
process, no guard relaxation, cleanest DI. No conflicts.

---

## Comparison and Recommendation

| | C1 | C2 | C3 | C4 |
|---|---|---|---|---|
| Single deployment | Yes | No | Yes | No |
| Concurrent sessions | No | Yes | Yes | Yes |
| Human override (live view) | No | Partial | Yes | Yes |
| engineActive change | None | None | Shared instance | None |
| Cloud upgrade path | Hard | Native | Port swap | Natural |
| Repo pattern fit | Perfect | Departs | Perfect + extend | Perfect + extend |
| Philosophy fit | Perfect | Good | Perfect | Best |
| Ship complexity | Low | High | Medium | High |

**Recommendation: Candidate 3.**

The 12-month success criteria require concurrent sessions AND live view AND single
deployment. Only C3 satisfies all three. The safety concern (concurrent handler calls)
is resolved by code analysis -- `V2Dependencies` is stateless and the session store
serializes per-session writes. The `engineActive` guard change (boolean -> shared
instance) is a targeted, well-understood change.

---

## Self-Critique

### Strongest counter-argument

C1 (sequential) ships faster and proves the actual unknowns: does the agent loop work?
Does the trigger system work? Does the daemon produce correct `notesMarkdown`? The REST
control plane is a developer experience feature, not a correctness feature. If the
primary goal is "demonstrate autonomous execution," C1 is the better choice. C3 adds
scope before the core concept is proven.

### Narrower option that could work

C1 with a note: "expand to C3 in the next iteration." C1 is a strict subset of C3 --
the FIFO queue is a degenerate case of C3's `DaemonSessionManager` (concurrency = 1).
Starting with C1 and expanding to C3 is a valid staged approach.

### Broader option and what would justify it

C4 (separate process) is justified if cloud deployment becomes a committed 12-month
goal. The migration from C3 to C4 is: extract `src/daemon/` into `packages/daemon/`,
add a separate process entry point, verify cross-process lock safety. The daemon code
itself does not change -- only the process boundary changes.

### Assumption that would invalidate this recommendation

If `withHealthySessionLock` does NOT safely handle concurrent callers within the same
process (i.e., if the lock is not reentrant-safe for async calls), then concurrent
sessions in C3 would corrupt the session store. This is unlikely (the lock is designed
for concurrent writes) but must be verified before shipping C3 with concurrency enabled.

---

## Open Questions for the Main Agent

1. Should the first daemon version use C1 (sequential, ship fast) or C3 (concurrent,
   full scope) as the initial implementation target?

2. The `AgentLoopPort` interface -- should it abstract the full LLM conversation turn
   (multi-turn tool call loop) or just the single LLM API call? A full-turn abstraction
   is cleaner but harder to design. A single-call abstraction leaks the tool call loop
   into the daemon.

3. Is pi-mono's `agentLoop` the right reference for the agent loop implementation, or
   should WorkRail build a minimal implementation against the Anthropic SDK directly?

4. Cross-repo execution: is it a 12-month must-have or a post-12-month feature? If it
   is a must-have, `BashInRepo` / `ReadRepo` must be designed now. If it is post-12-month,
   the tool executor can be simpler (single-workspace Bash/Read/Write).

5. The `engineActive` guard change: should it be a shared singleton instance pattern, or
   a ref-counted guard, or something else? The choice affects how tests isolate engine
   instances.
