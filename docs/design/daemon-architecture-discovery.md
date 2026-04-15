# WorkRail Daemon Architecture: First-Principles Discovery

> Design discovery for the WorkRail autonomous execution daemon architecture.
> Generated: 2026-04-14.
>
> **Artifact strategy:** This document is a human-readable reference. Execution truth
> is recorded in WorkRail session notes and context variables -- not in this file.
> Session notes are always authoritative.

---

## Landscape Packet

### Current-state summary

WorkRail today is exclusively reactive: it waits for an external agent (Claude Code, Cursor,
etc.) to call its MCP tools over a transport (stdio or HTTP). The process entry point is
`src/mcp-server.ts`, which starts either `startStdioServer` or `startHttpServer` based on
`WORKRAIL_TRANSPORT`.

**What already exists for autonomous execution:**

| Component | File | Status |
|-----------|------|--------|
| In-process engine library | `src/engine/engine-factory.ts` | Built -- wraps handlers directly |
| Engine interface | `src/engine/types.ts` | Built -- `WorkRailEngine` with bot-as-orchestrator doc comment |
| Core handler: start | `src/mcp/handlers/v2-execution/start.ts` | Built -- `executeStartWorkflow` |
| Core handler: continue | `src/mcp/handlers/v2-execution/continue-advance.ts` | Built -- `handleAdvanceIntent` |
| Core handler: checkpoint | `src/mcp/handlers/v2-checkpoint.ts` | Built |
| Durable session store | `src/v2/infra/local/` | Built -- append-only event log |
| HMAC token protocol | `src/v2/durable-core/tokens/` | Built -- cryptographic enforcement |
| DAG visualization | `console/` | Built -- passive (read-only) |
| SSE infrastructure | existing HTTP server | Built -- `/api/v2/workspace/events` |
| Trigger system | -- | **Missing** |
| Agent loop (LLM caller) | -- | **Missing** |
| Tool executor (Bash/Read/Write) | -- | **Missing for daemon** |
| Cross-repo routing | -- | **Missing** |
| Evidence collection hooks | -- | **Missing** |
| REST control plane | -- | **Missing** |
| Console live view | -- | **Missing** |

### Existing approaches and precedents

**pi-mono (35k stars, MIT, @mariozechner/pi-ai):**
- `agentLoop(prompts, context, config, signal?)` -- clean loop over unified LLM API
- `BeforeToolCallResult` / `AfterToolCallResult` -- hooks for observation and gating
- `ToolExecutionMode` -- sequential vs parallel tool execution
- `mom` package -- Slack bot as simplest daemon reference: "message received -> run agent -> respond"
- `coding-agent` package -- `SessionManager`, `AgentSession`, skill loading from directory

**OpenClaw (357k stars, MIT, TypeScript):**
- `AcpSessionStore` -- in-memory session management (WorkRail's disk-persisted store is superior)
- `SpawnAcpParams` -- minimal interface for spawning autonomous task sessions
- Task flow chaining -- `createTaskFlowForTask` / `linkTaskToFlowById`
- Policy system -- `isAcpEnabledByPolicy(cfg)` for daemon feature flags

**Claude Code (leaked source):**
- `sessionRunner.ts` -- programmatic session initiation (analogous to what daemon needs)
- `PreToolUse` / `PostToolUse` hooks -- evidence collection integration points
- Compaction hooks -- `executePreCompactHooks` for injecting WorkRail notes into session memory

### Hard constraints from the world

1. **DI container singleton:** `engineActive` guard -- one engine per process. Must evolve for concurrency.
2. **Anthropic API key required:** Daemon makes direct LLM API calls, not routed through Claude Code.
3. **Filesystem layout:** `WorkRailEngine.startWorkflow()` uses `process.cwd()` as workspace path. Daemon must pass explicit paths per session.
4. **Token protocol immutability:** HMAC tokens are cryptographically bound -- they cannot be reconstructed or forged. The daemon must store and manage tokens durably between agent loop iterations.
5. **Workflow backward compatibility:** Every existing workflow must run in autonomous mode unchanged. The daemon cannot require new workflow fields.

### Notable contradictions

1. **"MCP server and daemon can run simultaneously in the same process" (backlog) vs. `engineActive` guard (code):** The current singleton guard explicitly prevents this. The backlog's claim is aspirational; the code enforces single-engine. Resolution needed before multi-mode operation.
2. **"WorkRail calls MCP tools internally" (backlog) vs. engine-factory.ts pattern (code):** The backlog says the daemon calls `start_workflow` and `continue_workflow` MCP tools internally. The engine-factory shows it calls the underlying handlers directly -- no MCP tool layer. These are two descriptions of the same intent but at different abstraction levels. The handlers-directly path is more efficient and already built.
3. **Cross-repo isolation vs. single DI container:** If multiple sessions run concurrently and each session's tool calls are routed to different repos, the DI container's session store must remain repo-agnostic. Currently it is (the store uses session IDs, not workspace paths). But if the daemon injects workspace-specific tool executors per session, those executors must not bleed between sessions sharing the same engine instance.

### Evidence gaps

1. **pi-mono is not yet integrated** -- the agent loop layer is the biggest missing piece. pi-mono's `agentLoop` is the cleanest reference but is an external dependency. Whether WorkRail should use pi-mono or build its own agent loop is an open question.
2. **`engineActive` guard resolution path not designed** -- the exact mechanism for sharing one engine between MCP server and daemon is not specified.
3. **Evidence collection hook architecture** -- how `BeforeToolCall` hooks wire into the continue-token gate is not designed. The backlog mentions it but there is no code.
4. **Cloud session store** -- `LocalDataDirV2` is the only `DataDir` implementation. A cloud-backed store (S3, Postgres) would be needed for true cloud deployment. This is a port swap (DI-injectable) but the port contract for remote stores has not been designed.

### Precedent count: 3 (pi-mono, OpenClaw, Claude Code)
### Contradiction count: 3
### Evidence gap count: 4

---

## Problem Frame Packet

### Primary users / stakeholders

| User | Job to be done | Pain today |
|------|---------------|------------|
| **Individual developer (e.g., Zillow Mercury Mobile)** | Run autonomous MR review overnight without sitting at keyboard | Has to have Claude Code open and manually initiate each review |
| **Team lead** | Get consistent, enforced process on every MR without training reviewers | Reviews are ad-hoc; agents drift and skip steps |
| **Platform/infra engineer** | Deploy WorkRail as a service on cloud infrastructure | WorkRail is a local tool that exits when the terminal closes |
| **Workflow author** | Write a workflow once, have it run identically in both manual and autonomous mode | Today: manual mode only; would need to rewrite for autonomous mode if it existed separately |
| **WorkRail itself (self-improvement)** | Run `workflow-for-workflows` to author new workflows autonomously | Cannot initiate its own workflows; must be driven by a human |

### Core tension

**The daemon is not just a new entry point -- it is a different trust model.**

When a human drives Claude Code, the human is the ultimate arbiter of what the agent does. They can interrupt, redirect, or reject. When the daemon drives itself, the cryptographic enforcement of the token protocol and the immutable session log become the primary trust mechanism. The architecture must make the enforcement stronger, not weaker, when humans are not in the loop.

This creates a design tension:
- **Speed and simplicity** favor Option A (direct engine, tight coupling, fast)
- **Auditability and control** favor the REST control plane (humans can inspect, pause, override)
- **Portability and distribution** favor Option B (MCP client, process boundary, deployable separately)

The 12-month answer must satisfy all three. That is why Option D (composite) is necessary.

### Jobs and success criteria

**For the daemon to be considered successful at 12 months:**

1. `workrail daemon start` runs without Claude Code, without an IDE, without a human at the keyboard
2. A GitLab MR webhook triggers `mr-review-workflow`, runs to completion, posts findings as a comment -- zero human interaction
3. Every step of the autonomous session is visible in the console live view (audit trail, not just completion status)
4. If the daemon crashes mid-session, `workrail daemon resume <sessionId>` continues from the last checkpoint
5. Cross-repo: a workflow that reads from `android` and `ios` repos runs correctly on a developer's machine with both repos cloned
6. A workflow author cannot tell whether their workflow ran in manual mode (Claude Code) or autonomous mode (daemon) from the workflow definition alone

### Assumptions being treated as facts (framing risks)

1. **"The daemon should share the same process as the MCP server"** -- This is convenient but not obviously correct. A separate daemon process avoids the `engineActive` singleton problem entirely. The backlog says same-process; this should be a deliberate decision, not an assumption.

2. **"pi-mono is the right agent loop library"** -- pi-mono has 35k stars and clean TypeScript abstractions. But WorkRail's licensing, bundle size, and maintenance burden preferences are not stated. The daemon might be better served by a minimal direct Anthropic SDK integration than by adopting a 35k-star monorepo as a dependency.

3. **"Cross-repo execution is a 12-month must-have"** -- The backlog says "post-MVP, must-have before WorkRail can be called a general-purpose platform." This is a judgment call about timeline, not a technical constraint. A daemon that only handles single-repo workflows is still enormously useful.

4. **"The REST control plane is the right interface for console live view"** -- The console already has SSE infrastructure. The question is whether live session events from the daemon flow through the same SSE pipe or through a separate polling endpoint. This is a UI/API design question, not an architecture question.

### Tensions and HMW questions

**Tension 1: Single-process convenience vs. multi-session concurrency**
The `engineActive` guard exists because the DI container is a global singleton. A single-process model is simpler to deploy but requires the guard to evolve. A multi-process model eliminates the guard problem but adds IPC complexity.

HMW: How might we allow the MCP server and daemon to share one engine instance while ensuring concurrent sessions do not interfere?

**Tension 2: Freestanding vs. best-in-class agent loop**
WorkRail's value proposition is enforcement + durability + observability. The agent loop (LLM calling + tool execution) is commodity infrastructure. Using pi-mono's `agentLoop` gets a battle-tested implementation immediately but adds a dependency. Building in-house takes time but stays lean.

HMW: How might we get the benefits of a clean agent loop abstraction without coupling WorkRail to a specific third-party library?

**Tension 3: Autonomous trust vs. human control**
The more autonomous the daemon, the more important the console control plane becomes. But building the console live view adds scope. Deferring the live view means operators are blind to autonomous sessions.

HMW: How might we deliver meaningful human oversight of autonomous sessions with the minimum new console scope in the MVP?

### Framing risk count: 4
### Tension count: 3 (mapped to 3 HMW questions)
### Success criteria count: 6

---

## Candidate Generation Expectations

This is a `landscape_first` path. Candidate directions must:

1. **Be grounded in the actual landscape** -- not free invention. Each candidate must map
   to a specific precedent, constraint, or code pattern identified in the landscape packet.
   Candidates invented from scratch without landscape grounding will be rejected in synthesis.

2. **Cover the process-boundary dimension explicitly** -- the synthesis step identified
   the single-process vs. separate-process choice as the real open question. Every candidate
   must take a stance on this dimension.

3. **Not cluster around only the recommended option** -- even though Option D (composite)
   is the early favorite, the candidate set must include at least one candidate that
   challenges the composite direction (pure Option A with no REST layer, or pure Option B
   with a clean process boundary). The challenge must be genuinely argued, not strawmanned.

4. **Address the `engineActive` constraint explicitly** -- any candidate that places the
   daemon in the same process as the MCP server must state how it resolves the singleton
   guard. Any candidate that uses separate processes must state how session state is shared.

5. **Four candidates target:** A (pure direct engine, same process), B (MCP client,
   separate process), D-same (composite, same process), D-separate (composite, separate
   process). These four are the natural spread and map directly to the landscape.

---

## Candidate Directions

### Candidate 1: Minimal Sequential Daemon (simplest possible)

**One-sentence summary:** A new `src/daemon/entry.ts` calls `createWorkRailEngine()`, runs one
session at a time via a trigger listener, drives the agent loop with a direct Anthropic SDK
call per step, and exits after each session completes.

**Concrete shape:**
- `src/daemon/entry.ts` -- `workrailDaemon(config: DaemonConfig): Promise<void>`
- `src/daemon/trigger/gitlab-webhook.ts` -- HTTP listener, parses MR events, returns
  `{ workflowId: string; goal: string; context: Record<string, string> }`
- `src/daemon/agent-loop/step-runner.ts` -- takes `PendingStep`, calls Anthropic SDK
  `messages.create()` with the step prompt, collects tool calls, executes them via a
  `ToolExecutor`, returns `{ notesMarkdown: string; context: Record<string, unknown> }`
- `src/daemon/tool-executor/local.ts` -- implements `Bash`, `Read`, `Write` as child
  process calls; returns `ToolCallResult[]`
- Session queue: `DaemonSessionQueue` -- a simple async FIFO queue; only one session runs
  at a time; `engineActive` guard is never violated because queue ensures mutual exclusion

**Process boundary:** Same process as MCP server. The `engineActive` guard is satisfied by
the queue (only one engine in use at a time). No relaxation of the guard needed.

**Tensions resolved:** Simplicity; single-process deployment; zero workflow changes.
**Tensions accepted:** No concurrent sessions; no live view; no REST control plane.
**Failure mode:** Session throughput bottleneck -- if sessions are slow (30-60 min each),
the queue grows unbounded and new trigger events are delayed.
**Relation to existing patterns:** Directly adapts `engine-factory.ts`. The engine library
was built for this exact use case.
**Gain:** Ships fast, proves the agent loop concept, zero architectural risk.
**Give up:** No concurrency, no live view, no human override mid-session.
**Impact surface:** Only `src/daemon/` -- no changes to MCP server, engine, or console.
**Scope judgment:** Best-fit for MVP. Too narrow for 12-month platform vision.
**Philosophy:** Honors YAGNI, DI (engine injected), errors-as-data. Conflicts with nothing.

---

### Candidate 2: Pure MCP Client Daemon (clean process boundary)

**One-sentence summary:** A separate `workrail-daemon` process connects to the WorkRail
MCP server over HTTP and calls `start_workflow` / `continue_workflow` as a regular MCP
client, with no direct engine access.

**Concrete shape:**
- `packages/daemon/` -- separate package in the monorepo (or separate repo)
- `src/mcp/client.ts` -- a minimal MCP client over HTTP: `call(toolName, input)` returns
  the tool response. Wraps `fetch` with JSON-RPC envelope.
- `packages/daemon/src/trigger/` -- same trigger listener as Candidate 1
- `packages/daemon/src/agent-loop/step-runner.ts` -- same structure as Candidate 1, but
  calls `mcpClient.call('continue_workflow', { continueToken, output })` instead of the
  engine directly
- `packages/daemon/src/tool-executor/local.ts` -- same as Candidate 1
- Deployment: `docker-compose.yml` with two services: `workrail-mcp` and `workrail-daemon`

**Process boundary:** Separate process. The `engineActive` guard problem disappears --
the daemon never touches the DI container.

**Tensions resolved:** Clean process boundary; independent scaling; crash isolation;
no `engineActive` concern; deployable anywhere as separate container.
**Tensions accepted:** JSON-RPC round-trip on every `continue_workflow` call (adds ~5-10ms
per step, negligible for long-running steps); requires MCP server to be running first;
two-process deployment for local dev.
**Failure mode:** MCP server is a single point of failure for both human (Claude Code)
and autonomous (daemon) sessions. If the MCP server crashes, both stop.
**Relation to existing patterns:** Departs from `engine-factory.ts` -- does not use it.
Follows the MCP protocol contract instead.
**Gain:** Maximum decoupling; daemon code has no import from WorkRail's internal handlers;
daemon can be written in any language.
**Give up:** Two-process deployment friction for individuals; the HTTP transport adds latency
overhead on the hot path.
**Impact surface:** Requires MCP server to expose all necessary tools over HTTP (already
does for `http` transport mode).
**Scope judgment:** Best-fit for 18-24 month distributed cloud. Too broad for 12-month MVP.
**Philosophy:** Honors DI (full process boundary is the ultimate DI). Mild conflict with
YAGNI (the process boundary adds complexity not yet justified by scale requirements).

---

### Candidate 3: Composite Same-Process (recommended)

**One-sentence summary:** A `src/daemon/` module calls `createWorkRailEngine()` directly,
the `engineActive` guard is relaxed to allow the MCP server and daemon to share one engine
instance, concurrent sessions are managed by a `DaemonSessionManager` that runs each
session in its own async chain, and a thin REST/SSE control plane exposes session status
for the console.

**Concrete shape:**
- `src/engine/engine-factory.ts` -- relax `engineActive` guard: instead of a boolean,
  use a `EngineRefCount: number`. When `> 0`, the container is active. `createWorkRailEngine`
  now requires an explicit `EngineHandle` release pattern. OR: expose a single shared
  engine instance for the process that both MCP server and daemon use.
- `src/daemon/session-manager.ts` -- `DaemonSessionManager`: tracks active sessions by
  `sessionId -> { continueToken, status: 'running' | 'paused' | 'complete' | 'failed' }`.
  Each session runs as an independent `Promise` chain. No concurrency between steps of
  the same session (HMAC token protocol enforces this); concurrency across sessions is
  safe because the session store is append-only and session-scoped.
- `src/daemon/agent-loop/step-runner.ts` -- same as Candidate 1 but concurrent-safe
  (no shared mutable state between sessions).
- `src/daemon/trigger/` -- webhook + cron + CLI trigger listeners.
- `src/daemon/tool-executor/local.ts` -- `Bash`, `Read`, `Write` plus `BashInRepo`,
  `ReadRepo` for cross-repo routing.
- REST control plane additions to existing HTTP server:
  - `GET /api/v2/sessions/:id/daemon-status` -- `{ status, currentStepTitle, startedAt }`
  - `POST /api/v2/sessions/:id/pause` -- sets `status: 'paused'`, daemon loop waits
  - `POST /api/v2/sessions/:id/resume` -- unpauses
  - `DELETE /api/v2/sessions/:id` -- cancels active session (aborts current LLM call)

**Process boundary:** Same process. MCP server and daemon share one DI container and one
engine instance.

**Tensions resolved:** Single deployment artifact; zero workflow changes; concurrent sessions
(multiple sessions run simultaneously); human oversight (live view via REST/SSE); correct
enforcement (HMAC tokens apply to daemon sessions identically to manual sessions).
**Tensions accepted:** The `engineActive` guard must be relaxed (requires code change and
verification that concurrent handler calls are safe). The shared DI context means a
container bug affects both MCP server and daemon.
**Failure mode:** If concurrent `executeStartWorkflow` / `executeContinueWorkflow` calls
over the same DI context have a race condition (e.g., in the keyring load path or snapshot
store), concurrent sessions could corrupt each other. Must be verified.
**Relation to existing patterns:** Directly adapts `engine-factory.ts`. The `V2Dependencies`
struct is already designed to be built once and shared across calls -- no session-specific
state in `V2Dependencies`.
**Gain:** Single process, single deployment, concurrent sessions, live view, human control.
**Give up:** The `engineActive` guard relaxation needs careful design; shared process means
shared failure domain.
**Impact surface:** `engine-factory.ts` guard change; new `src/daemon/` module; minor
additions to existing HTTP server routes.
**Scope judgment:** Best-fit for 12-month vision. The composite is not broader than needed;
each component solves a concrete known requirement.
**Philosophy:** Honors DI (engine injected, agent loop port injected), errors-as-data,
immutability (session store is append-only, no mutation under concurrency). The guard
relaxation honors "make illegal states unrepresentable" -- a ref count is more precise
than a boolean. Conflicts with nothing.

---

### Candidate 4: Composite Separate-Process (cloud-native path)

**One-sentence summary:** The daemon runs as a separate process that uses `createWorkRailEngine()`
with a shared `dataDir` (pointing to the same `~/.workrail/v2` directory), enabling
independent process lifecycle while sharing durable session state through the filesystem.

**Concrete shape:**
- `packages/daemon/` -- separate entry point, runs `workrail-daemon` as its own process
- Uses `createWorkRailEngine({ dataDir: sharedDataDir })` -- the daemon gets its own DI
  container instance (no `engineActive` guard conflict) but reads/writes the same session
  store on disk
- The `engineActive` guard is NOT relaxed -- each process has exactly one engine, the guard
  works correctly
- Session store file locking: the append-only event log already uses file-level locking
  (`withHealthySessionLock`). Two processes writing to the same session store is safe IF
  they coordinate via the lock protocol.
- REST control plane: the daemon process exposes its own HTTP port (e.g., 3101) for
  status/pause/resume. The console proxies to this port.
- `src/daemon/agent-loop/`, `src/daemon/trigger/` -- same as Candidate 3

**Process boundary:** Separate process. Shared durable state via filesystem. The MCP
server and daemon are independent processes that both use the same `~/.workrail/v2`
directory as their shared state store.

**Tensions resolved:** `engineActive` guard is never an issue; independent crash recovery
(daemon crash does not affect MCP server); cloud-native (processes map to containers);
concurrent sessions (each daemon process handles multiple sessions via its own session
manager).
**Tensions accepted:** Two-process deployment for local dev; the shared filesystem is a
coordination mechanism that only works on a single machine (not distributed cloud without
a shared volume); REST control plane for the daemon is a new HTTP server, not reusing the
existing one.
**Failure mode:** Two processes writing to the same session store via file locks could
produce lock contention under high load. The lock protocol (`withHealthySessionLock`) is
designed for this, but it has not been tested with two concurrent processes.
**Relation to existing patterns:** Adapts `engine-factory.ts` (uses the library correctly,
one engine per process). Departs from the single-process assumption in `mcp-server.ts`.
**Gain:** Clean process boundary, no guard relaxation, independent scaling, natural
path to cloud (replace filesystem with remote store, same code).
**Give up:** Two-process deployment; filesystem-based coordination limits to single-machine;
more complex local dev setup.
**Impact surface:** New `packages/daemon/` package; new HTTP server in daemon process;
console proxy to daemon port.
**Scope judgment:** Best-fit for 18-month cloud target. Slightly too broad for 12-month
local-first focus.
**Philosophy:** Perfectly honors all principles -- one engine per process, `engineActive`
guard is correct, no guard relaxation needed. The cleanest architectural expression of
"dependency injection for boundaries." Conflicts with YAGNI slightly (the process
separation adds complexity before it is strictly needed).

---

## Challenge Notes

### C3 safety question: resolved

The critical concern for Candidate 3 was whether concurrent calls to
`executeStartWorkflow` / `executeContinueWorkflow` over the same `V2Dependencies` struct
are safe. Analysis of `engine-factory.ts` and the handler code resolves this:

- `V2Dependencies` is a stateless struct: no fields are mutated per-call. All mutable
  state lives in the session store (append-only event log with per-session file locks).
- `withHealthySessionLock(sessionId, ...)` serializes writes per session. Different
  sessions have different IDs -- their locks do not compete.
- The dedup key system (`advance_recorded:sessionId:nodeId:attemptId`) prevents
  double-advances even if two calls race on the same session.
- The keyring is loaded once during `createWorkRailEngine()` and its value is read-only
  after that. Concurrent token signing uses the same keyring but with per-call random
  entropy -- safe.

**Conclusion:** Concurrent sessions are safe today. The `engineActive` guard is not
protecting against a concurrent-call race condition -- it is protecting against two
separate `createWorkRailEngine()` calls creating two independent DI container instances
(which would have separate keystores, separate session stores, etc.). The solution for
Candidate 3 is to expose one shared engine instance for the process, not to relax
the guard to allow two instances.

### Strongest counter-argument against C3

The REST control plane is scope that is not required for correctness. A sequential daemon
(Candidate 1) with a FIFO session queue ships faster and proves the core unknowns:
(a) does the agent loop correctly drive a workflow step?
(b) does the trigger system work?
(c) does the daemon produce the right `notesMarkdown` output for `continueWorkflow`?

If the primary uncertainty is the agent loop (not the deployment architecture), C1 is
the better MVP choice. The REST control plane can follow in the next release.

### What would tip the decision to Candidate 1

If the 3-month target is "prove autonomous execution works" (not "ship the 12-month
platform"), Candidate 1 is correct. Sequential sessions with a queue are acceptable for
the MR review use case -- MRs are submitted hours apart, not milliseconds apart. A queue
delay of one session is unnoticeable.

### What would tip the decision to Candidate 4

If cloud deployment is committed (not tentative) within 12 months -- meaning there is
a production system that needs the daemon on a server, not just a local machine -- then
Candidate 4's separate process model is justified. The two-process local dev friction
is a real cost but acceptable for a deployed service.

---

## Resolution Notes

### Recommendation: Candidate 3 (Composite Same-Process)

**Rationale:**
1. The safety concern is resolved -- `V2Dependencies` is already concurrent-safe.
2. Single deployment artifact is a hard requirement for the developer experience goal
   (`workrail start` brings up everything).
3. The `engineActive` guard change is simpler than it appeared: the solution is to expose
   a single shared engine instance, not to allow two separate instances.
4. The REST control plane reuses existing HTTP server infrastructure -- it is not new
   architectural surface.
5. The 12-month success criteria require concurrent sessions (multiple MR reviews
   simultaneously) and human oversight (live view). Only C3 satisfies both within a
   single process.

**Pivot conditions:**
- If cloud deployment is committed within 12 months: migrate from C3 to C4 by extracting
  the daemon into a separate process. The code in `src/daemon/` is identical -- only the
  process entry point changes. The upgrade is a one-time extraction, not a rewrite.
- If the 3-month goal is "prove the agent loop": start with C1, expand to C3 after
  proof. The FIFO queue in C1 is a subset of C3's session manager.

**Implementation order for C3:**
1. Agent loop (`src/daemon/agent-loop/`) with direct Anthropic SDK -- the riskiest unknown
2. Single trigger (GitLab MR webhook) -- second most uncertain
3. Tool executor (Bash, Read, Write) -- mechanical, low risk
4. Shared engine instance (relax `engineActive` guard design) -- well-understood after
   the safety analysis
5. REST control plane additions -- incremental to existing HTTP server
6. Console live view integration -- last, depends on REST control plane

---

## Context / Ask

The specific question: what architectural form should the WorkRail autonomous execution
engine take for the 12-month vision?

**Three candidate architectures proposed:**
- **A) Direct engine caller** -- daemon imports and calls `executeStartWorkflow` /
  `executeContinueWorkflow` handler functions directly (tight, fast, internal)
- **B) MCP client** -- daemon connects to WorkRail's MCP server over the wire as a
  client (clean, decoupled, deployable anywhere)
- **C) Self-referential workflow** -- WorkRail becomes fully self-referential; workflows
  spawn other workflows autonomously using existing subagent delegation
- **D) Something else**

**The 12-month vision (from backlog.md):**
- WorkRail is a freestanding autonomous agent platform
- WorkRail drives itself -- the daemon calls WorkRail's own MCP tools internally
- Cross-repo execution: sessions can span multiple repos
- The autonomous engine must work without Claude Code, without any IDE
- Every workflow written for Claude Code works in autonomous mode with zero changes

---

## Path Recommendation: `landscape_first`

The code already contains a concrete answer. `engine-factory.ts` and `engine/types.ts`
reveal that an in-process library API already exists and was explicitly designed with
autonomous execution in mind ("Future direction: bot-as-orchestrator"). The dominant need
is reading that design and reasoning from it -- not open-ended reframing.

---

## Constraints / Anti-goals

**Hard constraints (from backlog.md and codebase):**
- Single process: DI container is a global singleton -- one `WorkRailEngine` instance per
  process at a time (enforced by `engineActive` guard)
- No duplicate session logic -- the existing session engine is the canonical implementation
- Zero workflow changes -- existing workflows must run in autonomous mode unchanged
- Freestanding -- no Claude Code, no IDE dependency
- `npx -y @exaudeus/workrail` must still work for all non-daemon users

**Anti-goals:**
- Do not duplicate the session store, token protocol, or step sequencer
- Do not require a running MCP server as a prerequisite for autonomous execution
- Do not introduce MCP transport overhead on the hot path (token round-trips, JSON-RPC
  serialization) when the daemon and engine are co-located
- Do not build something that only works on local -- cloud deployment is a 12-month goal

---

## What the Code Actually Reveals

### engine-factory.ts is already the daemon API

`createWorkRailEngine()` returns a `WorkRailEngine` that wraps `executeStartWorkflow` and
`executeContinueWorkflow` directly -- the same handlers the MCP server calls. The factory:

- Initializes the DI container in `library` mode (no signal handlers, no HTTP server,
  no MCP transport)
- Builds the full `V2Dependencies` object (gate, sessionStore, snapshotStore, keyring,
  tokenCodecPorts, etc.)
- Exposes `startWorkflow`, `continueWorkflow`, `checkpointWorkflow`, `listWorkflows`

The doc comment says explicitly:
> "Future direction: bot-as-orchestrator -- the caller reads `agentRole` + `prompt` from
> each step, constructs its own system prompts enriched with domain context, manages the
> agent lifecycle independently, and feeds output back."

**This is Option A (Direct engine caller) -- already partially built.**

### The MCP server is a thin wrapper over the same handlers

`start.ts` and `continue-advance.ts` show that the MCP server handlers are also thin
wrappers over `executeStartWorkflow` / `executeContinueWorkflow`. The MCP server adds:
- JSON-RPC serialization/deserialization
- MCP transport (stdio or HTTP)
- `workspaceResolver` and `directoryListing` ports (MCP-specific workspace resolution)
- `sessionSummaryProvider` (for the `resume_session` tool)

None of these are needed by an autonomous daemon. The daemon knows exactly which workflow
to run and where the workspace is -- it does not need workspace discovery.

### What's missing from engine-factory.ts for the daemon

The existing `WorkRailEngine` was scoped as "transport replacement" -- it drives the step
loop the same way an MCP agent would. What's needed for true autonomous execution:

1. **Agent loop** -- something to read `pending.prompt`, send it to the LLM (direct
   Anthropic API call), get back a `continueWorkflow` call with notes + context
2. **Tool execution** -- `Bash`, `Read`, `Write`, and domain tools (`BashInRepo`, etc.)
3. **Trigger system** -- webhooks, cron, CLI, REST to initiate a workflow session
4. **Cross-repo routing** -- workspace manifest resolution, repo provisioning
5. **Evidence collection** -- `BeforeToolCall` / `AfterToolCall` hooks to observe agent
   tool use and gate continue tokens on required evidence

---

## Candidate Analysis

### Option A: Direct Engine Caller (the `engine-factory.ts` pattern)

**Architecture:**
```
src/daemon/
├── trigger/          -- GitLab webhook, cron, CLI, REST
├── agent-loop/       -- LLM call layer (pi-mono agentLoop or direct Anthropic SDK)
├── tool-executor/    -- Bash, Read, Write + scoped cross-repo tools
└── entry.ts          -- daemon process entry point
```

The daemon imports `createWorkRailEngine()`, calls `engine.startWorkflow()`, reads
`response.pending.prompt`, sends it to the LLM API, gets tool calls + notes back, calls
`engine.continueWorkflow()` with the notes. Repeat until `isComplete`.

**Cross-repo execution:** The daemon controls the tool executor -- `BashInRepo(repo,
command)` routes to a provisioned workspace. The engine sees opaque context variables;
the daemon translates them to routed tool calls.

**Cloud vs local:** The engine uses `LocalDataDirV2` by default. For cloud, swap the
`dataDir` config or inject a remote-backed `SessionEventLogAppendStorePort`. The engine
is fully DI-injectable -- no filesystem assumptions in the session logic itself.

**WorkRail drives itself:** The daemon calls `engine.startWorkflow()` and
`engine.continueWorkflow()` -- the same tokens, the same session store, the same
enforcement. The daemon IS the agent; the engine enforces the workflow on the daemon.

**Developer experience (autonomous MR review):** One process, one command, zero
configuration beyond Claude API key + GitLab token. No MCP server running, no Claude Code
open. The daemon receives the GitLab webhook, starts the `mr-review-workflow`, runs the
agent loop, posts results.

**Risks:**
- The `engineActive` singleton guard means one active engine per process. Multi-session
  concurrency requires the guard to evolve (or run sessions sequentially, which is fine
  for v1).
- The daemon and MCP server share the same DI container -- running both simultaneously
  in the same process requires care. The factory already notes "MCP server and daemon can
  run simultaneously in the same process" but the singleton guard currently blocks this.
  Solution: the guard needs relaxing for multi-session daemon mode (tracked separately).

---

### Option B: MCP Client (daemon connects to the MCP server over the wire)

**Architecture:**
```
Process 1: WorkRail MCP Server (existing)
Process 2: Daemon --> HTTP/stdio --> MCP Server
```

The daemon connects to the running MCP server and calls `start_workflow`,
`continue_workflow` as a client.

**Cross-repo execution:** Same as A -- the daemon controls the tool executor.

**Cloud vs local:** Clean process boundary -- deploy daemon and MCP server as separate
containers. The MCP server is the stateful component; the daemon is stateless between
sessions.

**WorkRail drives itself:** Yes -- the daemon calls the same MCP tools that Claude Code
calls. The token protocol and enforcement are identical.

**Developer experience:** Worse for MVP. Requires:
1. A running MCP server (separate process)
2. A stable HTTP address or process handle for the daemon to connect to
3. Authentication between daemon and MCP server
4. Dealing with JSON-RPC over HTTP round-trip latency on every `continue_workflow` call

For a developer who just wants autonomous MR review: "install WorkRail, start two
processes, configure them to talk to each other" -- this is friction that Option A
eliminates entirely.

**When Option B makes sense:** When the daemon is deployed on separate infrastructure
from the MCP server (e.g., a cloud worker that connects to a central WorkRail instance).
This is a valid 18-24 month architecture but is premature for the 12-month horizon where
the primary deployment is local or simple cloud.

**Verdict: Option B is architecturally correct for distributed cloud but adds friction
that does not pay off in the 12-month horizon.**

---

### Option C: Self-Referential Workflow

**Architecture:** A "daemon workflow" running inside WorkRail that uses the existing
`mcp__nested-subagent__Task` delegation to spawn subagent sessions for each autonomous
task.

**Cross-repo execution:** The coordinator workflow passes workspace paths via context
variables. Subagent workflows receive them as input. This is already how the existing
subagent protocol works.

**Cloud vs local:** The coordinator session runs wherever WorkRail runs. Subagents run
in the same process.

**WorkRail drives itself:** Yes -- workflows spawn workflows. The `wr.discovery` workflow
(this session) is already an example of this pattern in manual mode.

**Developer experience:** Interesting but not right for this use case:
1. The coordinator workflow itself needs an agent driving it (a human or... another
   daemon). This is turtles all the way down.
2. Triggers (GitLab webhooks, cron) do not map cleanly to workflow steps. A workflow is
   a thing you start with a goal; a trigger system is a thing that decides when to start.
3. The `mcp__nested-subagent__Task` delegation is a subagent protocol, not a task
   dispatch queue. It does not handle webhook payloads, credential management, or
   concurrent session scheduling.

**What Option C is actually good for:** Autonomous orchestration within a single session
(coordinator delegates subtasks to parallel subagent sessions). This is already working
and is the right pattern for within-session parallelism. It is NOT the right pattern for
the entry-point / trigger layer.

**Verdict: Option C is the right answer for intra-session parallelism but is the wrong
answer for the daemon entry point.**

---

### Option D: Composite -- Direct Engine + Thin HTTP API

The 12-month architecture that actually satisfies all constraints is a composite:

```
WorkRail Process
├── Core Engine (shared DI singletons)
│   ├── Session store, snapshot store, keyring
│   ├── Token protocol
│   └── Workflow registry
│
├── MCP Server (existing -- Claude Code integration, no changes)
│   └── stdio or HTTP transport
│
├── Daemon Entry (new -- src/daemon/)
│   ├── Trigger listener (webhooks, cron, CLI)
│   ├── Agent loop (pi-mono agentLoop / direct Anthropic SDK)
│   ├── Tool executor (Bash, Read, Write, BashInRepo, ReadRepo)
│   └── Calls createWorkRailEngine() -- same handlers as MCP server
│
└── REST Control Plane (new -- for console live view + external control)
    ├── GET /api/v2/sessions/:id/status  (live polling by console)
    ├── POST /api/v2/sessions/:id/pause  (human pause mid-session)
    ├── POST /api/v2/sessions/:id/resume (human resume)
    └── SSE /api/v2/workspace/events     (already exists -- extend for daemon events)
```

The daemon calls the engine directly (Option A pattern) for the core loop. The REST
control plane exposes session state for the console and for external control (option B's
"decoupled" benefit without the process boundary overhead on the hot path).

This is already the direction the backlog describes:
> "The single-process model: The daemon entry point is a new src/daemon/ module that
> imports and calls the same handlers as the MCP server -- executeStartWorkflow,
> executeContinueWorkflow -- directly, without HTTP overhead."

---

## Resolution: Option D (Composite) is the Answer

**The 12-month architecture is not A, B, or C in isolation. It is:**
- **Option A** for the core execution loop (direct engine calls, no transport overhead)
- **Option C** for intra-session orchestration (workflows spawn subagent workflows)
- **A thin REST/SSE control plane** for human visibility and external control
  (the "Option B benefit" without requiring a separate MCP server process)

**Why this beats pure Option B for 12 months:**
- No inter-process transport on the hot path (the majority of daemon interactions)
- Single deployment artifact -- `workrail daemon` starts everything
- The REST control plane satisfies "deployable anywhere" without requiring a second MCP
  server process

**Why this beats pure Option A:**
- The REST control plane enables the console live view (currently missing)
- External systems (CI pipelines, Slack bots, other services) can interact with running
  sessions without embedding the WorkRail engine
- Future option: split daemon and MCP server to separate processes when scale demands it,
  by pointing the daemon at the REST API instead of the direct engine -- zero workflow
  changes required

**The key architectural invariant:** The daemon never bypasses WorkRail's session engine.
It calls `engine.startWorkflow()` and `engine.continueWorkflow()` -- the exact same
code path as Claude Code's MCP calls. The enforcement guarantee is cryptographically
identical.

---

## Decision Log (Updated After Challenge)

| Decision | Rationale |
|----------|-----------|
| Direct engine (Option A) for core loop | Engine factory already exists, no transport overhead, same handlers as MCP server. `V2Dependencies` is stateless -- concurrent calls verified safe. |
| Not pure Option B (MCP client) | Process boundary adds friction for MVP (two processes, HTTP overhead per step). No payoff until distributed cloud deployment. Departs from `engine-factory.ts` pattern. |
| Not pure Option C (self-referential) | Trigger/dispatch layer does not map to workflow steps. Something still has to drive the coordinator. Right pattern for intra-session parallelism, wrong for entry point. |
| Not pure Option A (sequential, no live view) | Satisfies 3-month proof-of-concept but not 12-month platform. No concurrent sessions, no human override. |
| Composite same-process (C3) selected | Only candidate that satisfies all 12-month criteria: single deployment + concurrent sessions + live view + human override + correct enforcement. |
| REST control plane via existing Express server | `http-entry.ts` uses Express -- adding REST routes is `listener.app.get(...)`. Not a new server, not new architectural surface. |
| `engineActive` guard: shared instance, not relaxed | The guard prevents two `initializeContainer()` calls (which would reset DI registrations). Fix: a process-level `initializeWorkRailProcess()` called once; both MCP server and daemon use the resulting engine instance. The guard's purpose (prevent two containers) is preserved; its implementation is changed. |
| Challenge found 3 real risks, none blocking | (1) Hanging agent loops need `AbortController` timeouts -- design requirement, not blocker. (2) Process-level init function is a real non-trivial change -- design constraint, recorded. (3) Cross-repo not needed for MR review MVP -- scope decision, not blocker. |

---

## Open Questions

1. **Session concurrency:** The `engineActive` guard allows one engine per process. The
   daemon needs to handle multiple concurrent sessions. Options: (a) session queue
   (process one at a time), (b) relax the guard to allow multiple concurrent
   `WorkRailEngine` instances with isolated DI containers, (c) per-session process
   workers. For v1, a simple session queue is sufficient.

2. **Cross-repo tool routing:** The `BashInRepo(repo, command)` pattern requires a
   workspace manifest resolver. Where does this live -- in the daemon's tool executor or
   in the engine itself? Recommendation: tool executor (the engine stays agnostic about
   filesystem layout; the daemon injects scoped tool implementations).

3. **Credential management:** Daemon needs Claude API key, GitLab/GitHub tokens, Jira
   tokens. Where are these stored? Options: environment variables (simplest), WorkRail
   keyring extension (same HMAC infrastructure), external secret manager. For v1,
   environment variables with a typed `DaemonConfig` struct.

4. **Evidence collection hook:** The `BeforeToolCall` / `AfterToolCall` hooks that gate
   continue tokens on observed evidence -- these need integration with the agent loop.
   The pi-mono `agentLoop` has `BeforeToolCallResult` and `AfterToolCallResult` -- these
   are the right integration points.

5. **Single-process constraint:** The backlog says "MCP server and daemon can run
   simultaneously in the same process" -- but the current `engineActive` guard prevents
   this (two engines cannot coexist). The guard exists because the DI container is a
   global singleton. Either: (a) the daemon shares the single engine instance with the
   MCP server, or (b) they use separate data directories (separate DI contexts). Option
   (a) is cleaner but requires the engine's `startWorkflow` / `continueWorkflow` to be
   thread-safe (they already are, since each call is a separate async chain over
   immutable session events). The guard should be relaxed to allow the MCP server and
   daemon to share one engine instance.

---

## Final Summary (Updated After Full Review Cycle)

The daemon should be **Candidate 3: Composite Same-Process with C1 safety defaults**.

**Architecture:**
```
WorkRail Process (single)
├── Core (shared)
│   ├── Session store, snapshot store, keyring (all DI singletons)
│   ├── HMAC token protocol
│   └── Workflow registry
│
├── MCP Server entry (existing, unchanged)
│   └── Claude Code / Cursor call start_workflow, continue_workflow externally
│
└── Daemon entry (new -- src/daemon/)
    ├── DaemonSessionManager(config: { maxConcurrentSessions: 1 })
    │   └── FIFO session queue for v1 (C1 safety, no engineActive guard change needed)
    ├── AgentLoopPort (injected -- Anthropic SDK or pi-mono behind a port)
    ├── ToolExecutorPort (injected -- Bash, Read, Write + optional repo routing)
    ├── TriggerListener (GitLab MR webhook for v1)
    └── REST additions to existing Express server
        ├── GET /api/v2/sessions/:id/daemon-status
        ├── POST /api/v2/sessions/:id/pause
        ├── POST /api/v2/sessions/:id/resume
        └── DELETE /api/v2/sessions/:id (cancel)
```

**V1 implementation order:**
1. Agent loop (`src/daemon/agent-loop/`) -- riskiest unknown; direct Anthropic SDK + AbortSignal
2. Single trigger (GitLab MR webhook) -- second most uncertain
3. Tool executor (Bash, Read, Write) -- mechanical
4. Design `SharedEngineContext` / `initializeWorkRailProcess()` -- design only in v1, enable in v1.5
5. REST control plane additions (4 routes on existing Express server)
6. Console live view integration

**v1.5 additions (after v1 is proven):**
- Enable `maxConcurrentSessions: N` (requires SharedEngineContext pattern)
- Cross-repo tool routing (BashInRepo, ReadRepo)
- Evidence collection hooks (BeforeToolCall / AfterToolCall)

**Confidence: high.** Grounded in code analysis (`V2Dependencies` concurrent-safe, Express server
extensible, `engine-factory.ts` already partially implements this pattern). No RED findings in
design review. Two ORANGE constraints (AbortSignal in step-runner, SharedEngineContext interface)
are implementation requirements, not blockers.

**Strongest alternative: Candidate 1 (Sequential Daemon)**
Valid if the 3-month goal is "prove autonomous execution works" rather than "ship the 12-month
platform." C1 is a strict subset of C3 -- expand to C3 after proof.

**Pivot condition:** If cloud deployment is committed in 12 months, extract daemon to separate
process (Candidate 4). The `src/daemon/` code is identical; only the process entry point changes.

**Residual risks:**
1. Agent loop multi-turn tool call coordination is the riskiest unknown -- has never been built
   in WorkRail. Study pi-mono's `agentLoop` before designing.
2. `mcp-server.ts` refactor scope for `initializeWorkRailProcess()` is uncertain -- needs a code
   spike first.
3. First real use case may be cross-repo (full-stack MR) -- if so, ToolExecutorPort repo parameter
   becomes a v1 requirement, not v2. Confirm MVP workflow target before finalizing tool executor design.
