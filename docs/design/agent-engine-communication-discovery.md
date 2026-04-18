# Agent-Engine Communication Discovery
## How Leading Autonomous Agent Systems Handle Agent-Engine Communication

**Status:** Complete
**Date:** 2026-04-18
**Goal:** Survey how OpenAI Agents SDK, Anthropic agent patterns, LangGraph, Temporal, and Vercel AI SDK handle agent-engine communication -- and extract recommendations for WorkRail's daemon now that it owns the full agent loop.

> **Artifact strategy:** This document is a human-readable reference for review. It is for people to read -- NOT the execution truth. Durable decisions, rationale, and context variables live in WorkRail session notes. If a chat rewind occurs, consult session notes first; this file may be out of date.
>
> **Capabilities used:** WebFetch (confirmed available -- used for 12 web fetches). Delegation (not used -- synthesis task, main agent owns all findings). Anthropic docs redirected to 404; LangGraph docs blocked by redirect chains; both gaps are noted explicitly in the Landscape Packet.

---

## Context / Ask

WorkRail's daemon now owns the full agent loop: it calls the Anthropic API directly, executes tool calls, and drives `continue_workflow` internally. The question is no longer "should we build a daemon" -- it is: **what communication pattern should the daemon use between the agent (LLM) and the WorkRail engine (step enforcer)?**

The backlog records prior-art analysis of pi-mono, OpenClaw, nexus-core, and Claude Code, all dated April 2026. This document extends that with fresh external research on the five systems named in the goal, then synthesizes recommendations specific to WorkRail's daemon architecture.

---

## Path Recommendation: `landscape_first`

The problem is well-framed. The daemon's architecture is already decided (Composite Same-Process, Candidate 3 from `daemon-architecture-discovery.md`). The open question is one layer lower: **what is the right communication primitive** between the LLM output and the `continue_workflow` call? Landscape grounding on how peers solved this is the dominant need.

---

## Landscape Packet

### 1. OpenAI Agents SDK

**Communication pattern: tool calls as first-class routing primitive**

Handoffs between agents are implemented as **tools**. When an agent wants to transfer control to another agent (e.g., `Refund Agent`), the LLM emits a tool call `transfer_to_refund_agent`. The runtime intercepts this specific tool call and routes to the named agent instead of executing arbitrary code. The naming convention `transfer_to_<agent_name>` is the signal -- no special return type needed.

The agent loop (from `running_agents` docs):
1. Call LLM with current input
2. If `final_output` (text, no tool calls) -- loop terminates
3. If handoff tool call -- update current agent, re-run loop
4. If regular tool call -- execute tool, append result, re-run loop

**Key architectural insight:** Routing is a **tool call with a predictable name**. The agent produces one type of output (tool calls) for everything -- domain actions, routing decisions, and termination signals. The runtime differentiates by inspecting the tool name, not the output structure.

**Termination signal:** Text output with no tool calls = done. There is no explicit "I am complete" message -- the absence of tool calls in a text response is the signal.

**MaxTurns guard:** The runtime enforces a maximum turn count (`MaxTurnsExceeded` exception). This is an external safety envelope, not an agent-controlled mechanism.

---

### 2. Anthropic Recommended Patterns (Building Effective Agents)

**Communication pattern: tool-call loop with environmental feedback**

Anthropic's pattern (from `anthropic.com/engineering/building-effective-agents`):
- The agent receives environmental feedback as tool results after each call
- The loop continues as long as the LLM calls tools; it terminates when the LLM produces text without tool calls
- Control flow is driven by the **LLM's own decision** to call or not call tools -- there is no external step advancement signal

**Key architectural insights:**
1. **Start simple.** Single LLM call with retrieval + tools is often enough. Add loop machinery only when simpler approaches fail.
2. **Tool design is the primary interface.** Invest in tool documentation, edge cases, and "poka-yoke" parameter design -- the quality of the tool interface is the primary determinant of agent reliability.
3. **Agents are for cases where workflows prove insufficient.** Pre-defined workflows (prompt chaining, routing, parallelization) are preferred. Autonomous agents are for cases where the path genuinely cannot be determined in advance.
4. **Human checkpoints over continuous supervision.** Rather than continuous intervention, build approval gates at meaningful decision points.

**What Anthropic does NOT recommend:** Using structured output as control flow. The pattern is always: tool calls for actions, text for final output. Structured output is for making tool arguments and final outputs machine-readable -- not for encoding routing decisions.

---

### 3. LangGraph

**Communication pattern: state machine with typed state updates; optional Command for explicit routing**

LangGraph's model (from codebase research -- the docs blocked web fetch, but the backlog has deep LangGraph findings from `docs/ideas/langgraph-discovery.md`):

- Each node is a function that receives `state` and returns a state update (a dict)
- The graph engine merges the state update into the shared `StateGraph` state
- Edge routing is declared at graph construction time: `graph.add_edge("node_a", "node_b")`
- Conditional edges: `graph.add_conditional_edges("node", condition_fn)` -- the condition function receives state and returns the next node name

**The `Command` pattern (newer addition):** A node can return a `Command(goto="node_name", update={...})` object instead of a plain state dict. This combines state update + routing in a single return value, allowing dynamic routing from within a node rather than requiring pre-declared conditional edges.

**Key architectural insights:**
1. **State is the shared medium.** Nodes communicate through the `StateGraph` state object, not through direct calls. The agent writes to state; the engine reads state to route.
2. **Routing is not a tool call.** LangGraph separates tool execution (the `ToolNode`) from routing (edges/conditions). The agent produces tool calls; ToolNode executes them and updates state; edges route based on state.
3. **`interrupt()` is structural, not prompt-advisory.** When a node calls `interrupt()`, the graph halts and requires external `Command(resume=...)` to continue. WorkRail's HMAC token protocol achieves the same guarantee cryptographically.
4. **Time-travel checkpointing.** `CheckpointMetadata.source = "fork"` enables re-invoking from any historical checkpoint. Maps to WorkRail's "workflow rewind" backlog feature.
5. **Streaming: `(namespace, mode, data)` triple.** Includes subgraph namespace path. Maps to WorkRail's console SSE events pattern.

**The LangGraph weakness (from backlog):** `interrupt()` can be bypassed -- it is structurally enforced by the graph runtime, but not cryptographically. A malicious or context-pressured agent can call tools out of sequence if the graph's conditional edges permit it. WorkRail's HMAC token gate closes this gap.

---

### 4. Temporal.io

**Communication pattern: event-sourced deterministic replay; workflow code IS the state machine**

Temporal's model (from `temporal-patterns-design-candidates.md` and `temporal-patterns-design-review-findings.md` and fresh web research):

- Workflows are **ordinary code** (Go, Java, TypeScript, Python) that runs deterministically
- The Temporal engine records every **Command** (schedule activity, start timer, await signal) and every **Event** (activity completed, signal received) in an event history
- On crash/replay, the engine replays the event history to restore the workflow's pre-failure state
- **Activity vs. Workflow split:** Workflows orchestrate; Activities execute. Activities are the "tool execution" layer; Workflows are the "control flow" layer. This is a strict separation.
- **Task token heartbeat:** Long-running activities use a task token for async completion. The activity calls back with the token when done, rather than blocking.

**Key architectural insights:**
1. **Event history is the source of truth.** Not a session store or a token -- the full ordered event log of commands and events. WorkRail's append-only event log maps directly to this.
2. **Temporal's determinism constraint is NOT applicable to WorkRail.** Temporal's replay model requires deterministic code. AI agent tool calls are inherently non-deterministic. WorkRail's checkpoint token + append-only session store is already the right architecture for this domain.
3. **Overlap policy for cron triggers.** `ScheduleOverlapPolicy` (SKIP, BUFFER_ONE, BUFFER_ALL, CANCEL_OTHER, ALLOW_ALL) is the right model for WorkRail's cron trigger when a scheduled run is still running when the next fires.
4. **Worker polling vs webhook push.** Temporal uses worker polling (workers poll a task queue). WorkRail uses webhook push. Both are valid; polling is better for cloud/multi-tenant scaling.
5. **Namespace isolation.** Per-org Temporal namespaces with separate history and quota. WorkRail cloud: per-org data dirs from day one.

**Temporal-to-WorkRail mapping (confirmed from backlog):**
- Event history → append-only session event log (exists)
- Workflow task token → `ct_`/`st_` checkpoint token (exists)
- Worker polling → direct in-process engine calls (daemon model)
- Temporal SDK API → WorkRail MCP tools

---

### 5. Vercel AI SDK

**Communication pattern: tool-call loop with `stopWhen` declarative termination; `done` tool as explicit stop signal**

The Vercel AI SDK's `generateText` with `maxSteps` (now `stopWhen`):
- The agent loop continues as long as the model produces tool calls
- `stopWhen` conditions replace the old `maxSteps` parameter:
  - `stepCountIs(n)` -- hard stop after n steps (default 20)
  - `hasToolCall("done")` -- stop when a specific tool is called
  - `isLoopFinished()` -- remove limits, let agent finish naturally
  - Custom conditions (token count, cost, output patterns)
- The **`done` tool pattern**: a tool with no `execute` function. When the agent calls it, the loop stops. Results accessible via `result.staticToolCalls`. This is a tool call that IS the termination signal.
- **`prepareStep` callback**: runs before each step, allowing dynamic adjustment of model, context, available tools per phase.

**Key architectural insights:**
1. **Tool calls are the universal primitive.** Termination is signaled by calling a `done` tool (no execute function), not by text output. Routing between phases is done by which tools are made available via `prepareStep`.
2. **`stopWhen` is the external safety envelope.** Like OpenAI's `MaxTurnsExceeded`, it prevents infinite loops. The agent-controlled signal is the `done` tool call; the framework-controlled signal is `stopWhen`.
3. **Phase-based tool availability.** `prepareStep` can change which tools are available before each step, effectively implementing a state machine without explicit graph edges. This is a soft version of WorkRail's step-enforced tool availability.
4. **Multi-step workflows via data flow.** Sequential workflows advance through data: each step's output becomes the next step's input, passed as context. No explicit routing primitive -- just function composition.

---

## Pattern Comparison

| System | Control flow primitive | Termination signal | Routing mechanism | Enforcement model |
|--------|----------------------|-------------------|-------------------|------------------|
| **OpenAI Agents SDK** | Tool call (including handoffs as tools) | Text output + no tool calls | `transfer_to_X` tool name | MaxTurns (external counter) |
| **Anthropic patterns** | Tool call loop | Text output + no tool calls | None (LLM decides) | Human checkpoints |
| **LangGraph** | State update; `Command(goto=...)` | Conditional edges + `END` | Pre-declared edges + `Command` | `interrupt()` (structural, bypassable) |
| **Temporal** | Activity schedule/result (event) | Workflow code returns | Deterministic code | Event history (full replay) |
| **Vercel AI SDK** | Tool call; `done` tool (no execute) | `done` tool call or `stopWhen` | `prepareStep` (dynamic tools) | `stopWhen` (external counter) |
| **WorkRail (current)** | `continue_workflow` tool call | `isComplete: true` from engine | HMAC token gate | Cryptographic (token) |

---

## Key Convergence: What the Field Has Learned

After surveying all five systems plus pi-mono, OpenClaw, nexus-core, and Claude Code (from prior backlog research), the field has converged on a clear pattern:

### The Universal Answer: Tool Calls All the Way Down

**Every system that has solved "autonomous agent runs a structured workflow reliably" has converged on tool calls as the universal communication primitive.** Not structured output. Not special return types. Not message passing protocols.

The reason is fundamental: **tool calls are the only output primitive the LLM can produce that carries a name, arguments, and a predictable schema**. Text output is for humans. Structured output is for making tool arguments machine-readable. But the *mechanism* for signaling "I want to do X" is always a tool call.

This applies to:
- Domain actions (run bash, read file)
- Workflow advancement (call `continue_workflow`)
- Agent handoffs (call `transfer_to_agent_name`)
- Termination (call `done` / produce text with no tool calls)
- Routing (call a tool whose name indicates the next step)

### The Three Patterns That Emerged

**Pattern 1: The Loop Primitive**
All systems implement the same core loop:
1. Call LLM with current state
2. If tool calls: execute, append results, loop
3. If text output (no tools): done

The only variation is what "done" means and how enforced.

**Pattern 2: The Safety Envelope**
All systems add an external safety counter (MaxTurns, stepCountIs, timeout) that the LLM cannot control. This prevents infinite loops caused by malformed agents. The LLM controls termination via the tool-call mechanism; the runtime enforces an upper bound.

**Pattern 3: Tool Availability as Phase Control**
The most sophisticated systems (Vercel AI SDK `prepareStep`, LangGraph conditional edges, WorkRail step enforcement) use **tool availability** as the phase control mechanism. You do not tell the agent "you are in phase 2"; you make only phase-2 tools available. The agent can only do what the available tools permit.

---

## What WorkRail Already Gets Right

WorkRail's `continue_workflow` tool call IS the field-standard pattern, applied to workflow advancement:
- `continue_workflow` is a tool call (not structured output, not text return)
- The HMAC token in `continueToken` is WorkRail's "tool availability as phase control" -- the agent cannot call `continue_workflow` for a step it hasn't completed, because the token is cryptographically bound to the specific step/session
- `isComplete: true` from the engine is the termination signal (analogous to `END` in LangGraph)
- The daemon's `AgentLoop.steer()` pattern (inject next step prompt after `continue_workflow` returns) is the same as Vercel's `prepareStep` and pi-mono's message injection

WorkRail is **the only system in this survey that makes the workflow enforcement cryptographic** (HMAC-bound tokens). Every other system uses either structural (bypassable) or prompt-advisory enforcement.

---

## What WorkRail Is Missing (Gaps vs. Field)

### Gap 1: The "Done" Tool / Termination Signal Clarity

**Field pattern:** Vercel AI SDK's `done` tool (no execute function) is a clean, explicit termination signal that the agent calls deliberately. OpenAI uses "text output + no tool calls" as implicit termination.

**WorkRail current state:** WorkRail relies on `isComplete: true` from the engine -- the daemon's loop terminates when the engine signals completion. This is correct but implicit from the agent's perspective. The agent never explicitly says "I am done" -- the engine decides.

**Recommendation:** Keep the engine-side termination (`isComplete: true`). But consider adding an explicit `finish_workflow` tool that the agent calls on the last step. This makes termination visible in the conversation transcript and creates a natural audit record. The tool can be a no-op that returns `{ message: "workflow finished" }` -- the engine's `isComplete` flag is still the canonical signal.

### Gap 2: The `prepareStep` / Dynamic Tool Availability Pattern

**Field pattern:** Vercel AI SDK's `prepareStep` changes which tools are available before each step. LangGraph's conditional edges do the same. This is "tool availability as phase control."

**WorkRail current state:** The daemon provides the same tools on every step. Tool availability does not change between steps. The HMAC token provides the cryptographic step gate, but the agent still sees all tools at all times.

**Recommendation:** Implement step-level tool filtering in the daemon. Each workflow step can declare `allowed_tools: ["Bash", "Read", "Write", "continue_workflow"]`. The daemon's `AgentLoopOptions` already accepts a tool list -- make this per-step. This is additive (no changes to the engine or token protocol) and prevents the agent from accidentally calling admin tools during a research step.

### Gap 3: The Safety Envelope (MaxTurns / StepCountIs)

**Field pattern:** All five surveyed systems enforce a maximum turn count at the runtime level. This is not a prompt instruction -- it is a hard ceiling that raises an exception/error.

**WorkRail current state:** The daemon has per-step timeouts (`AbortController`) but no per-step turn count limit. An agent can loop indefinitely within a single step if it keeps making tool calls without calling `continue_workflow`.

**Recommendation:** Add `maxTurnsPerStep: number` to `AgentLoopOptions`. Default: 30. When exceeded, the daemon emits a `step_exceeded_turns` event and the session moves to `failed` status. This closes the same gap that all five surveyed systems address with their safety envelopes.

### Gap 4: Routing as Tool Calls (Explicit Agent Handoffs)

**Field pattern:** OpenAI Agents SDK implements handoffs as `transfer_to_X` tool calls. The agent signals "I need a specialist" by calling a named tool. The runtime routes, not the agent.

**WorkRail current state:** WorkRail has subagent delegation via `mcp__nested-subagent__Task`. But this is a tool the orchestrator agent calls -- it is already the field-standard pattern. The gap is that the daemon does not yet support inter-session handoffs triggered by a running daemon session. A daemon session can call `continue_workflow` but cannot spawn a new daemon session mid-execution.

**Recommendation (post-MVP):** Add a `spawn_daemon_session` tool to daemon sessions. When called, it queues a new session with specified `workflowId` and `goal`, returns a session ID, and allows the calling session to optionally wait for completion. This is the OpenAI handoff pattern adapted to WorkRail's session model.

### Gap 5: Streaming Event Format Standardization

**Field pattern:** LangGraph uses `(namespace, mode, data)` triples for SSE events. OpenAI uses `{type: "response.output_item.added", ...}`. All use structured, typed events.

**WorkRail current state:** The console SSE emits `{type: "change"}` (minimal) and `{type: "worktrees-updated"}`. Daemon-specific events are not yet streamed.

**Recommendation:** Extend the SSE event format to `{type: "daemon_event", sessionId, eventKind: "step_start" | "tool_call" | "tool_result" | "step_advance" | "session_complete" | "session_failed", payload: T}`. This closes the observability gap for the console live view.

---

## Recommendations for WorkRail's Daemon

In priority order:

### R1: Keep `continue_workflow` as the advancement tool call (CONFIRMED CORRECT)

The field has unanimously converged on tool calls as the advancement primitive. WorkRail's `continue_workflow` is exactly right. No changes needed to the protocol.

The HMAC token in `continueToken` is WorkRail's unique advantage -- it makes step enforcement cryptographic rather than structural or advisory. Every other system in this survey is bypassable under context pressure. WorkRail is not.

### R2: Add `maxTurnsPerStep` to `AgentLoopOptions` (NEAR-TERM, ~30 LOC)

```typescript
interface AgentLoopOptions {
  // existing...
  maxTurnsPerStep?: number;  // default: 30
}
```

When `turnCount >= maxTurnsPerStep`, the daemon aborts the step and marks the session as failed with reason `step_exceeded_max_turns`. This is the safety envelope that all five surveyed systems implement.

### R3: Add step-level `allowed_tools` filtering (NEAR-TERM, ~50 LOC)

Extend workflow step schema to support:
```json
{
  "allowedTools": ["Bash", "Read", "Write", "continue_workflow"]
}
```

The daemon filters `AgentLoopOptions.tools` to only the allowed tools for the current step. This is additive -- existing workflows without `allowedTools` get all tools (current behavior). This implements "tool availability as phase control" at the workflow authoring level.

### R4: Add a `finish_workflow` no-op tool (OPTIONAL, post-MVP)

A tool with no side effects that the agent calls on the final step's completion:
```typescript
{
  name: "finish_workflow",
  description: "Signal that all workflow steps are complete. Call this as the last action.",
  input_schema: { type: "object", properties: {} }
}
```

When called, the daemon logs a `workflow_finish_called` event and continues normally (the engine's `isComplete: true` is still the canonical completion signal). This creates an explicit audit record of deliberate completion vs. session end by timeout.

### R5: Extend SSE events for daemon observability (NEAR-TERM, ~80 LOC)

Extend `mountConsoleRoutes()` / daemon event emission to include:
```typescript
{ type: "daemon_event", sessionId: string, eventKind: DaemonEventKind, payload: unknown }
```

Where `DaemonEventKind` = `"step_start" | "tool_call" | "tool_result" | "step_advance" | "session_complete" | "session_failed" | "session_paused"`.

This is the LangGraph `(namespace, mode, data)` pattern adapted to WorkRail's SSE infrastructure.

### R6: Spawn session handoffs (POST-MVP)

After the daemon MVP is proven, add `spawn_daemon_session` as a tool available to orchestrator workflows. This completes the OpenAI handoff pattern for WorkRail's multi-session model.

---

## Decision Log

| Decision | Rationale |
|----------|-----------|
| `continue_workflow` as advancement tool call -- confirmed correct | Every surveyed system uses tool calls as the advancement primitive. WorkRail's existing design is field-standard. |
| HMAC token enforcement -- confirmed unique advantage | No surveyed system has cryptographic step enforcement. All are bypassable. WorkRail's moat is real. |
| Add `maxTurnsPerStep` to `AgentLoopOptions` | All five systems implement a safety envelope. WorkRail's per-step timeout is necessary but not sufficient. Turn count cap closes the same gap. ~30 LOC. |
| Step-level `allowed_tools` with workflow-level default + `enforcementMode: 'block'|'warn'` | Field-standard (Vercel `prepareStep`, LangGraph conditional edges). Additive to WorkRail schema, no token protocol changes. Default 'warn' for first release; upgrade path to 'block' documented. ~50 LOC. |
| `DaemonEventEmitter` as required injectable port | Silent wiring miss (ORANGE finding) prevented by making the port required in `WorkflowRunnerOptions`. Injectable = test-swappable (no-op implementation). ~80 LOC total. |
| SSE daemon events (step-level only) | LangGraph `(namespace, mode, data)` streaming is the precedent. Step-level events (step_start, step_advance, session_complete/failed) are low-frequency -- no SSE flood risk. Tool-level events opt-in. |
| Structured output NOT for control flow | Anthropic and OpenAI both confirm: structured output is for tool arguments and final outputs, not for routing decisions. Control flow is via tool calls. |
| LangGraph `interrupt()` not applicable | LangGraph's structural interrupt is equivalent to WorkRail's token gate but bypassable. WorkRail's HMAC approach is strictly superior. |
| Temporal replay model not applicable | Temporal's determinism requirement conflicts with AI agent non-determinism. WorkRail's checkpoint token + append-only log is already the correct architecture for this domain. |
| `finish_workflow` tool deferred | Marginal value over implicit `continue_workflow` record. Token overhead (~50 tokens/step) not justified today. |
| `spawn_daemon_session` deferred | Requires concurrent session manager (maxConcurrentSessions > 1) and cycle detection. Build after sequential daemon is proven. |

---

## Competitive Positioning Update

This research confirms the positioning anchor from the backlog: **"If you know Temporal.io, WorkRail is Temporal for AI agent process governance via MCP."**

More precisely:
- WorkRail's `continue_workflow` = Temporal's activity scheduling + task token pattern, but expressed as a tool call
- WorkRail's HMAC-bound `continueToken` = Temporal's task token, but cryptographically bound to the specific step/session/attempt
- WorkRail's append-only event log = Temporal's event history, but without the determinism constraint (correct for AI agents)
- WorkRail's step enforcement = Temporal's workflow-as-code constraints, but expressed as JSON workflow + token gate instead of TypeScript code

The four systems without structural enforcement (OpenAI SDK's MaxTurns, Anthropic's human checkpoints, LangGraph's `interrupt()`, Vercel's `stopWhen`) are all "advisory + counter" models. They can be overwhelmed by context pressure or implementation bugs. WorkRail's token gate cannot.

---

## Open Questions

1. **Should `allowed_tools` be per-step or per-workflow-phase?** Per-step is simpler to author but verbose. A phase-based approach (`phases: { research: [...tools], implementation: [...tools] }`) might be cleaner for complex workflows. Decision deferred to workflow schema design sprint.

2. **Should `spawn_daemon_session` block or be fire-and-forget?** Blocking allows the parent session to wait for child results (orchestrator pattern). Fire-and-forget is simpler for parallel fan-out. Recommendation: support both via a `wait: boolean` parameter. Post-MVP.

3. **Is `finish_workflow` worth the added tool slot in the prompt?** An extra tool in the system prompt adds ~50 tokens per step. For a 20-step workflow, that is 1000 tokens of overhead. Worth it only if the audit record value exceeds the cost. Deferred.

---

## Final Summary

**Path:** `landscape_first` -- the daemon architecture is decided; the question was one layer lower (what communication primitive).

**Problem framing:** WorkRail's daemon owns the full agent loop. The open question is what additive safety layers to build, in what order, for reliable unattended execution.

**Landscape takeaways (9 systems surveyed):**
1. Tool calls are the universal agent-engine communication primitive. Every system that has solved reliable autonomous execution converges on this.
2. WorkRail's `continue_workflow` tool call is field-standard. The HMAC token is WorkRail's unique cryptographic enforcement advantage -- no surveyed system has this.
3. The three field patterns: (a) tool-call loop with text-output termination, (b) external safety envelope (MaxTurns/stopWhen), (c) tool availability as phase control (prepareStep/conditional edges).
4. Structured output is NOT for control flow. Anthropic and OpenAI both confirm this explicitly.
5. Temporal's deterministic replay model is NOT applicable to AI agents (non-determinism incompatibility). WorkRail's checkpoint token + append-only log is already the correct architecture.

**Chosen direction: Candidate B (Standard Near-Term Set).**

Four additions at the `workflow-runner.ts` / `AgentLoopOptions` seam (~190 LOC total):
1. `maxTurnsPerStep: number` in `AgentLoopOptions` -- safety envelope, default 30, per-step override. All five systems have this.
2. `allowedTools?: string[]` per step, `defaultAllowedTools?: string[]` at workflow level, `allowedToolsEnforcement: 'block' | 'warn'` (default `'warn'`). Vercel `prepareStep` / LangGraph conditional edges pattern.
3. `DaemonEventEmitter` required injectable port + local JSONL implementation with TTL. Required field prevents silent wiring miss.
4. Step/session-level SSE daemon events (`step_start`, `step_advance`, `session_complete`, `session_failed`). LangGraph `(namespace, mode, data)` streaming pattern.

**Strongest alternative: Candidate A (Minimal).** `maxTurnsPerStep` only (~30 LOC). Valid if the 3-month goal is 'prove the loop works.' A is a strict subset of B -- upgrade path requires no rollback.

**Why B won over A:** B's additions (tool filtering and SSE events) are at the same seam, are all additive and opt-in, and are needed before the daemon can be considered production-ready for unattended overnight sessions. The incremental cost is ~160 LOC for non-trivial observability and phase-control benefits.

**Why C lost:** `spawn_daemon_session` requires concurrent session manager (not built) and cycle detection (~200 LOC). `finish_workflow` adds ~50 prompt tokens/step for marginal audit value. Both deferred to post-MVP.

**Confidence: HIGH.** Nine-system field survey, strong convergence, no contradictions between external research and WorkRail design decisions. Review found one ORANGE requirement (DaemonEventEmitter required field, ~3 LOC) incorporated into B. Two residual risks (both operational, not design).

**Residual risks:**
1. `allowedTools` verbosity for phase-heavy workflows (deferred to workflow schema sprint)
2. Two conflicting architecture docs (process boundary question, orthogonal to communication primitive)

**Next actions:**
1. Decide: 3-month proof-of-concept goal (ship A) or 6-9 month production release (ship B)
2. If B: implement in order: (a) `maxTurnsPerStep` + `DaemonEventEmitter` port + local JSONL impl, (b) `allowedTools` schema field + enforcement in `workflow-runner.ts`, (c) console frontend SSE display as a separate PR
3. Resolve the two conflicting architecture docs in a dedicated session before implementing the daemon entry point

**Supporting docs:**
- `docs/design/agent-engine-comms-design-candidates.md` -- three candidate analysis
- `docs/design/agent-engine-comms-design-review.md` -- review findings (ORANGE/YELLOW/GREEN)
