# Daemon Loop Comparison: pi-mono vs OpenClaw

> **Artifact purpose:** This document is a human-readable reference. It summarizes findings and decisions for reviewers. It is NOT execution truth -- the workflow notes and context variables in WorkRail are the authoritative record. If this file and the workflow notes conflict, trust the notes.

## Context / Ask

WorkRail needs an autonomous daemon -- a separate process that connects to WorkRail's MCP HTTP server as a client and drives `start_workflow` / `continue_workflow` calls with tool execution in between, looping until `isComplete: true`. The question is which project provides the better loop foundation.

**Path Recommendation:** `landscape_first` -- the dominant need is comparing two concrete options, not reframing the problem space.

---

## Constraints / Anti-goals

- **Must not adopt OpenClaw as a dependency.** It is a multi-hundred-file product codebase, not a library.
- **Must not require pi-mono's full platform stack.** Only the agent loop package is relevant.
- **No streaming required initially.** The daemon is headless; streaming output is not essential for the MVP.
- **Loop must be async, abort-capable, and independently runnable per workflow.** Multiple daemons may run concurrently.
- **Tool execution must support MCP client calls** (start_workflow, continue_workflow, Bash, Read, Write) not just in-process tools.

---

## Landscape Packet

### pi-mono Agent Loop

**Package:** `@mariozechner/pi-agent-core` (packages/agent/src/)

**Key files read:**
- `agent-loop.ts` -- 350 lines, the loop kernel
- `types.ts` -- 400 lines, all interfaces
- `agent.ts` -- 500 lines, stateful wrapper

**Loop structure:**

```
agentLoop(prompts, context, config, signal?) -> EventStream<AgentEvent, AgentMessage[]>
  runAgentLoop()
    runLoop():
      while (true):                               // outer: follow-up messages
        while (hasMoreToolCalls || pending):      // inner: tool calls + steering
          streamAssistantResponse()               // LLM call with streaming
          if stopReason == error/aborted: return
          toolCalls = message.content.filter(toolCall)
          if toolCalls: executeToolCalls()        // sequential or parallel
          check steeringMessages
        check followUpMessages
      agent_end
```

The loop is purely functional at the kernel level -- `runLoop` takes all dependencies as parameters, holds no global state. The `Agent` class wraps it with a mutable state store (`_state`), subscriber fanout, steering/follow-up queues, and lifecycle management.

**Tool registration:** Tools are `AgentTool<TParameters>` objects with a TypeBox schema, a `label`, and an `execute(id, args, signal, onUpdate)` method. They live in `AgentContext.tools[]` and are matched by name at call time. Schema validation happens via `validateToolArguments` before the hook chain.

**Error handling:**
- LLM errors: encoded as `AssistantMessage` with `stopReason: "error"` and `errorMessage`. Loop exits cleanly -- emits `turn_end` + `agent_end`, no exception thrown.
- Abort: `stopReason: "aborted"`, same path.
- Tool not found: immediate error tool result, loop continues.
- Tool throws: caught, wrapped as error tool result, loop continues.
- `convertToLlm` / `transformContext` must never throw (documented contract).
- `handleRunFailure` in `Agent` catches any uncaught loop exception and synthesizes a failure `agent_end` event.

**Cancellation:** First-class `AbortSignal` threaded through every async boundary: `streamAssistantResponse`, `executeToolCalls`, `executePreparedToolCall`, `beforeToolCall`, `afterToolCall`, `transformContext`. `Agent.abort()` calls `abortController.abort()`. The loop observes the signal at the LLM streaming layer; tool implementations receive it and may honor it.

**Concurrency:** `Agent` is single-active-run -- `prompt()` throws if `activeRun` exists. Multiple independent `Agent` instances can run in parallel (no shared state). `executeToolCallsParallel` fans out tool executions within a single turn.

**Streaming:** `EventStream<AgentEvent>` emits fine-grained events (`message_start`, `message_update`, `tool_execution_start`, etc.). The consumer can ignore all of them for headless use -- just `await agent.prompt()` and check `agent.state.messages` at the end.

**mom/agent.ts usage pattern:** The Slack bot creates one `Agent` per channel, calls `session.prompt(userMessage)`, and subscribes to events to relay progress to Slack. This is almost exactly what the WorkRail daemon needs, with Slack replaced by nothing (headless).

---

### OpenClaw pi-embedded-runner

**Key files read:**
- `src/agents/acp-spawn.ts` -- spawn orchestration (~150 lines read)
- `src/acp/control-plane/session-actor-queue.ts` -- per-session serialization queue
- `src/agents/pi-embedded-runner/run.ts` -- outer retry/failover loop (~250 lines read)
- `src/auto-reply/reply/agent-runner.ts` -- reply runner (~200 lines read)
- `src/tasks/task-executor.ts` -- task lifecycle management

**Loop structure:** OpenClaw uses pi-mono's `Agent` class internally (`@mariozechner/pi-agent-core`). The pi-embedded-runner is a thick wrapper that adds:
- Multi-provider auth rotation and failover
- Preemptive compaction (context window management)
- Session write locks (preventing concurrent writes to the same session file)
- Global and per-session command lanes (`KeyedAsyncQueue`)
- Task lifecycle tracking (queued -> running -> terminal)
- Replay state and transcript repair
- Extensive plugin/hook system

The actual agent loop is **pi-mono's loop** under the hood. OpenClaw does not implement a different loop algorithm -- it wraps pi-mono's `Agent` and `AgentSession` with enterprise concerns.

**Session serialization:** `SessionActorQueue` (wrapping `KeyedAsyncQueue`) serializes all operations per `actorKey` (session ID). This prevents races between concurrent messages to the same session. It is a clean, small utility (30 lines).

**Error handling:** Adds retry with exponential backoff, auth profile rotation on 401/429, provider failover, context overflow compaction triggers, idle timeout retries. Far more sophisticated than pi-mono's base handling.

**Concurrency:** Multiple sessions run concurrently via distinct `actorKey` lanes. The `enqueueSession` + `enqueueGlobal` two-level queue prevents both per-session races and global resource exhaustion.

**Coupling:** `src/agents/pi-embedded-runner/run.ts` alone imports from 80+ internal modules. It is architecturally inseparable from the OpenClaw product. Extracting even the retry loop would require porting dozens of internal abstractions.

---

## Problem Frame Packet

**What WorkRail's daemon actually needs:**

1. Accept a `goal` string, call `start_workflow(workflowId, workspacePath, goal)`.
2. Receive a step with `continueToken`.
3. Execute whatever tools the step requires (Bash, Read, Write, MCP calls).
4. Call `continue_workflow(continueToken, notes)`.
5. Repeat until `isComplete: true`.
6. Abort cleanly on signal.
7. Run multiple workflows concurrently (one `Agent` per workflow run).

**What this is NOT:**
- Not a multi-user system requiring auth rotation.
- Not requiring context window compaction (WorkRail sessions are short).
- Not requiring provider failover.
- Not requiring session persistence across restarts (WorkRail has its own checkpoint system).

---

## Candidate Generation Expectations

> **For the injected candidate-generation pass:** This is a `landscape_first` path. Candidates must be grounded in the concrete evidence read from source -- not free invention. Each candidate must address how `isComplete` propagates, how cancellation works, and whether the dependency is viable. The candidate set must span the dependency spectrum (external dep / vendor / inline) and must not cluster around superficially similar variations of the same approach.

## Candidate Directions

### A. Use pi-mono's Agent class directly

Adopt `@mariozechner/pi-agent-core` (the loop package, not all of pi-mono). Each workflow daemon instance is one `Agent`. Tools are registered as `AgentTool` objects wrapping MCP client calls (start_workflow, continue_workflow, Bash, Read, Write). The loop drives tool calls naturally. Completion is detected via an `agent_end` event or by checking the last message's `stopReason`.

**Implementation sketch:**
```typescript
const agent = new Agent({
  initialState: { systemPrompt, model, tools: workrailTools },
  getApiKey: () => apiKey,
});
agent.subscribe((event) => {
  if (event.type === "agent_end") logCompletion(event.messages);
});
await agent.prompt(goalMessage);
```

The WorkRail MCP tools (`start_workflow`, `continue_workflow`) are defined as `AgentTool` objects. The LLM receives step instructions and naturally calls tools to execute them. The `isComplete` check lives inside a `continue_workflow` tool that signals completion to the loop (e.g., by setting a sentinel in the tool result, or via the `afterToolCall` hook).

**Pros:**
- Clean, minimal dependency (one package, ~1000 lines total).
- AbortSignal, streaming events, error recovery all built in.
- Parallel tool execution available when needed.
- Steering and follow-up queues available for future interactive use.
- Well-tested (pi-mono uses it in production for the Slack bot).

**Cons:**
- No built-in retry on LLM errors (must add via `afterToolCall` or wrapper).
- No context window management (not needed initially).
- Must write `AgentTool` wrappers for each MCP call.

### B. Use OpenClaw's pi-embedded-runner

Extract the retry/failover outer loop from `run.ts` plus `SessionActorQueue`.

**Verdict:** Not viable without porting 80+ internal modules. The code is architecturally coupled to OpenClaw's product stack. Even the `SessionActorQueue` utility is fine but trivially reimplementable (30 lines).

### C. Write a custom loop from scratch

A simple `while (!isComplete)` loop calling MCP endpoints and tools directly without pi-mono.

**Verdict:** Would reinvent AbortSignal threading, streaming, error recovery, and the event/subscriber model. pi-mono does all of this well. No reason to start from scratch.

---

## Challenge Notes

- **pi-mono package availability:** `@mariozechner/pi-agent-core` must be importable. If it is not published to npm, WorkRail would need to either vendor it or add a git dependency. This needs verification.
- **Completion detection:** The WorkRail daemon needs to know when `continue_workflow` returns `isComplete: true`. This is a WorkRail-specific concern. The cleanest approach is a wrapper tool that reads the MCP response and, when `isComplete`, throws a controlled sentinel that causes the agent to stop (via `stopReason: "stop"`), or sets a flag that `getFollowUpMessages` returns empty.
- **LLM choice for the daemon:** The daemon needs an LLM to interpret step instructions and decide which tools to call. This is an architectural question separate from the loop choice.

---

## Resolution Notes

**Recommendation: Use pi-mono's Agent class (Candidate A).**

Evidence:
1. OpenClaw itself uses pi-mono's `Agent` internally. This confirms pi-mono's loop is production-grade.
2. The pi-mono loop is ~1000 lines, clean, fully typed, and has zero product-specific coupling.
3. All five comparison dimensions favor pi-mono for WorkRail's use case: stateless kernel, first-class AbortSignal, sequential or parallel tool execution, clean error encoding, independent instances.
4. OpenClaw adds value over pi-mono only for concerns WorkRail does not have: auth rotation, provider failover, context compaction, session persistence. For the daemon MVP, those are non-requirements.
5. The mom/agent.ts pattern (one `Agent` per channel, subscribe once, call `prompt()` per message) maps directly to WorkRail's daemon (one `Agent` per workflow run).

**What to take from pi-mono:**
- `Agent` class and `AgentLoopConfig` -- the stateful wrapper.
- `AgentTool<TParameters>` interface -- for defining MCP tools.
- `AgentEvent` union -- for observability hooks.
- `beforeToolCall` / `afterToolCall` hooks -- for completion detection and logging.

**What to skip from pi-mono:**
- `AgentSession` (coding agent wrapper with skills, extensions, session files) -- not needed.
- `SessionManager`, `ModelRegistry`, `ResourceLoader` -- all pi-coding-agent concerns.
- Streaming event forwarding (optional, headless daemon doesn't need it).

**What to take from OpenClaw:**
- `SessionActorQueue` pattern (30 lines) -- trivially reimplementable in WorkRail as a `KeyedAsyncQueue` to serialize concurrent runs against the same session ID. Worth the idea, not the import.
- Retry wrapper pattern -- `run.ts` shows how to wrap `agent.prompt()` with retry-on-error. Can be adapted without the OpenClaw-specific auth rotation logic.

**What to skip from OpenClaw:**
- Everything in `pi-embedded-runner/` except the structural insight.
- All 80+ product-internal imports.
- `acp-spawn.ts` -- not relevant to the daemon loop.

---

## Decision Log

| Decision | Rationale |
|---|---|
| `landscape_first` path | Both options are concrete -- no need for full problem reframing |
| pi-mono Agent over OpenClaw pi-embedded-runner | OpenClaw wraps pi-mono; extracting the extra value is not viable |
| Candidate A (npm dep) over Candidate B (vendor) | `@mariozechner/pi-agent-core@0.67.2` confirmed published on npm (verified: `npm view` returned package details, published 4 hours ago, 213 versions, MIT). No need to vendor. |
| Candidate A over Candidate C | pi-mono already solves AbortSignal, streaming, error recovery |
| Skip AgentSession / pi-coding-agent | WorkRail has its own session system; the coding agent layer adds friction |
| Runner-up: Candidate B (vendor) | Pivot trigger: if npm package becomes unavailable or breaking API change occurs. Not a speculative risk -- 213 versions in active development, pin exact version. |
| Accepted tradeoff: closure flag vs. typed DaemonToolResult | C1 uses a mutable closure flag for `isComplete` propagation. This is runtime-correct but not compile-time-typed. Acceptable for MVP; can be upgraded to typed discriminant if philosophy review requires it. |

---

## Final Summary

### Recommendation: pi-mono `Agent` as the daemon loop foundation

**Confidence: high.** Source files read from primary sources, npm availability confirmed, adversarial challenge passed with 0 RED findings.

**Core implementation shape:**

1. **Dependency:** `@mariozechner/pi-agent-core` at exact version pin (`0.67.2` as of 2026-04-14). No `^` prefix.
2. **One `Agent` per workflow run.** Each run creates a fresh `Agent` instance. No shared state between concurrent runs.
3. **MCP tools as `AgentTool` objects:** `start_workflow`, `continue_workflow`, `Bash`, `Read`, `Write`. Each implements `AgentTool<TSchema>` with a TypeBox schema and `execute()`.
4. **Termination via `getFollowUpMessages` closure:** The `continue_workflow` tool's `execute()` sets `isComplete = true` on a per-run context object when the MCP response indicates completion. `getFollowUpMessages` returns `[]` when `isComplete`, causing the outer loop to exit naturally.
5. **Typed internal result:** `continue_workflow.execute()` uses a `WorkflowContinueResult = { _tag: 'advance'; ... } | { _tag: 'complete'; ... } | { _tag: 'error'; ... }` discriminated union internally before setting the closure flag.
6. **Factory function:** `createDaemonLoopConfig(client: WorkRailMCPClient): AgentLoopConfig` is the only entry point. Enforces per-run closure isolation.
7. **Stuck-loop safeguard (required before production):** `agent.abort()` after wall-clock timeout (e.g., 10 minutes) + max-turn counter via `getSteeringMessages` that injects a nudge message after N turns without `continue_workflow` being called.

**What to take from pi-mono:**
- `Agent` class and `AgentLoopConfig` -- the stateful wrapper
- `AgentTool<TParameters>` interface -- for defining MCP tools
- `AgentEvent` union -- for observability hooks
- `beforeToolCall` / `afterToolCall` hooks -- for logging and blocking

**What to skip from pi-mono:**
- `AgentSession`, `SessionManager`, `ResourceLoader` -- pi-coding-agent layer, not needed
- Streaming event forwarding -- headless daemon does not need it at MVP

**What to take from OpenClaw:**
- `KeyedAsyncQueue` pattern (30 lines, reimplement) -- for serializing concurrent runs against the same session ID
- Retry wrapper pattern -- simple `agent.prompt()` wrapper with backoff on `stopReason === 'error'`

**What to skip from OpenClaw:**
- Everything in `pi-embedded-runner/` (80+ internal imports, architecturally inseparable from OpenClaw product)
- `acp-spawn.ts`, `task-executor.ts` -- product-specific orchestration

### Strongest alternative: Vendor pi-mono loop (Candidate 2)

Pivot to C2 if: npm package becomes unavailable, or if WorkRail's philosophy review requires compile-time exhaustiveness at the loop-termination level rather than just at the tool-boundary level.

### Residual risks (2)

1. **Active upstream development:** 213 versions published, 0.67.2 released 4 hours ago. API stability at exact pin is guaranteed, but requires manual upgrade process. Low operational risk.
2. **Protocol evolution:** If `continue_workflow` response gains richer completion state variants, the `WorkflowContinueResult` discriminant needs extension. The typed discriminant hybrid makes this upgrade straightforward.
