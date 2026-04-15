# pi-mono Discovery: WorkRail Auto Integration Guide

**Discovery date:** 2026-04-14
**Repo:** `https://github.com/badlogic/pi-mono` -- 35k stars, MIT, TypeScript monorepo by Mario Zechner
**Relevant package:** `@mariozechner/pi-agent-core` (pinned 0.67.2, 246kB, 1 dependency, published on npm)

## Artifact Strategy

This document is a **human-readable reference** for the WorkRail Auto daemon implementation team. It is NOT the execution truth for the discovery workflow -- that lives in WorkRail session notes and context variables. If there is any conflict between this doc and the session notes, the session notes win.

**What this doc is for:** Concrete API reference, TypeScript snippets, and design decisions that a developer writing `src/daemon/` would need to look up.

**What this doc is NOT for:** Workflow state tracking, continue tokens, or session metadata.

## Context / Ask

WorkRail Auto needs an agent loop to drive autonomous daemon sessions. The decision (recorded in `docs/ideas/backlog.md`) is to use `@mariozechner/pi-agent-core` as the loop foundation. This document is an exhaustive extraction of everything WorkRail Auto needs from pi-mono -- not just the agent loop but the full ecosystem.

## Path Recommendation

**`full_spectrum`** -- The ask has two distinct components: (1) landscape grounding (reading actual pi-mono source to understand APIs, error handling, types) and (2) synthesis/framing (producing concrete TypeScript snippets that show WorkRail Auto using these APIs). Both are needed. `landscape_first` alone would miss the critical synthesis step; `design_first` would be premature since the APIs aren't understood yet.

## Constraints / Anti-goals

- **Anti-goal:** Do not import OpenClaw's runner wrapper or any OpenClaw internals. Use pi-mono directly.
- **Anti-goal:** Do not add context window management (compaction) at MVP -- that is handled upstream.
- **Anti-goal:** Do not re-implement the session store or workflow engine -- WorkRail's existing engine is used via direct function calls.
- **Constraint:** The daemon must produce identical WorkRail session semantics to the MCP server mode. Same handlers, same tokens, same enforcement.
- **Constraint:** Each concurrent autonomous session needs its own `Agent` instance -- no shared state across sessions.

---

## Problem Frame Packet

**Primary users / stakeholders:**
1. WorkRail daemon implementer (writes `src/daemon/`) -- needs concrete API reference and correct wiring patterns
2. WorkRail workflow authors -- their workflows must run unchanged in daemon mode
3. WorkRail users / operators -- need reliable autonomous execution with observable state and recoverable crashes

**Jobs / outcomes:**
- Daemon must drive WorkRail sessions autonomously without a human in the loop
- Every WorkRail enforcement guarantee (step ordering, HMAC tokens, continue token gating) must be preserved in daemon mode
- Sessions must be recoverable after crashes (token persistence, `waitForIdle()` before next step)
- Concurrent sessions must not interfere with each other (one Agent per session, KeyedAsyncQueue)

**Pains / tensions:**
1. **Termination ambiguity**: the loop terminates structurally (no tool calls + no follow-ups), not semantically. The daemon must bridge `isComplete` from `continue_workflow` into a structural stop signal.
2. **Step injection timing**: steer() fires after each tool batch (inside loop), followUp() fires only when loop would stop (outside loop). Wrong choice adds an unnecessary LLM turn per step.
3. **Concurrent session safety**: multiple workflows running simultaneously need isolated Agent instances. pi-mono's Agent is not safe to share across concurrent runs.
4. **Crash recovery**: if the daemon crashes mid-step, the continue token must be persisted before calling the engine so the session can be resumed.
5. **AbortSignal threading**: cancellation from the REST control plane must reach in-flight tool executions and the LLM stream.

**Constraints that matter in lived use:**
- WorkRail sessions are short (10-40 steps) -- no context window management needed at MVP
- Workflows call `continue_workflow` many times per run -- token persistence matters
- The daemon runs in the same process as the MCP server -- Agent instances must not share state

**Success criteria:**
1. An existing `mr-review-workflow` runs autonomously in daemon mode with identical enforcement behavior to MCP mode
2. A daemon session crash mid-step can be resumed from the last persisted continue token
3. Two concurrent daemon sessions advance independently without interfering
4. `agent.abort()` from the REST control plane cancels in-flight tool calls within 100ms

**Assumptions to watch:**
- Assumption: `steer()` messages are consumed one-at-a-time when `steeringMode: "one-at-a-time"` (default). This means one WorkRail step per steer() call. Verify: yes, `PendingMessageQueue.drain()` returns `[first]` in `"one-at-a-time"` mode.
- Assumption: WorkRail engine handlers are safe to call from inside a tool `execute()` function (inside the agent loop). This is correct since the engine is called directly (no re-entrant loop).

**Reframes / HMW questions:**
1. **HMW**: How might WorkRail use pi-mono's Agent class without coupling the daemon to a long-lived agent state? Answer: `agent.reset()` between workflow runs, or create a fresh Agent per run.
2. **Reframe**: Instead of thinking "the agent calls WorkRail," think "the agent IS driven by WorkRail -- WorkRail injects step instructions as steer() messages and the agent executes them."

**Framing risks:**
1. Over-engineering the termination bridge -- the simplest approach (don't steer() when complete) may be all that's needed
2. Assuming compaction is needed at MVP -- WorkRail sessions are short; context window overflow is unlikely before step 40
3. Conflating AgentSession (heavy coding-agent wrapper) with Agent (what WorkRail needs) -- never import AgentSession for daemon use

## Landscape Packet

### 1. `packages/ai` -- Unified LLM API

**File:** `packages/ai/src/types.ts`

The core types that matter for WorkRail Auto:

```typescript
// Provider registration key -- "anthropic-messages" is what WorkRail uses
type KnownApi = "openai-completions" | "anthropic-messages" | "google-generative-ai" | /* ... */;

// Unified model descriptor
interface Model<TApi extends Api> {
  id: string;            // e.g., "claude-sonnet-4-5"
  name: string;
  api: TApi;             // "anthropic-messages"
  provider: Provider;    // "anthropic"
  baseUrl: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; };
}

// The message union -- UserMessage | AssistantMessage | ToolResultMessage
// StopReason is critical for error detection:
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// Tools are defined with TypeBox schemas
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}

// Context passed to each LLM call
interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

**File:** `packages/ai/src/stream.ts`

The actual call surface WorkRail uses:

```typescript
// streamSimple is the primary call -- handles reasoning levels, caching, transport
function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions  // includes reasoning, signal, apiKey, sessionId, etc.
): AssistantMessageEventStream;

// completeSimple is the awaited version -- returns the final AssistantMessage
async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions
): Promise<AssistantMessage>;
```

**File:** `packages/ai/src/api-registry.ts`

Provider registration -- WorkRail does NOT need this directly. pi-ai auto-imports built-in providers via `stream.ts` importing `./providers/register-builtins.js`. Calling `import "@mariozechner/pi-ai"` is sufficient. Custom provider registration would use:

```typescript
function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
  provider: ApiProvider<TApi, TOptions>,
  sourceId?: string
): void;
```

WorkRail Auto needs to call `getModel("anthropic", "claude-sonnet-4-5")` from `@mariozechner/pi-ai` -- the registry is handled internally.

**`AssistantMessageEventStream`** (from `utils/event-stream.ts`):

```typescript
class EventStream<T, R> implements AsyncIterable<T> {
  push(event: T): void;
  end(result?: R): void;
  result(): Promise<R>;   // <-- await this to get the final AssistantMessage
  [Symbol.asyncIterator](): AsyncIterator<T>;
}
```

The stream terminates with either `{ type: "done", message }` or `{ type: "error", error }`.

---

### 2. `packages/agent` -- The Agent Class

**File:** `packages/agent/src/types.ts`

**`AgentTool<TParameters>`** -- the tool registration type:

```typescript
interface AgentTool<TParameters extends TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;           // shown to user in UI
  prepareArguments?: (args: unknown) => Static<TParameters>;  // optional arg shim
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>
  ) => Promise<AgentToolResult<TDetails>>;
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];  // returned to the LLM
  details: T;                               // for logs/UI only
}
```

**`BeforeToolCallResult` / `AfterToolCallResult`** -- the hooks WorkRail needs for evidence gating:

```typescript
// Return { block: true } to prevent tool execution -- loop emits error tool result instead
interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

// Return to override parts of the executed tool result
interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
}
```

**`AgentEvent`** -- the full lifecycle event union:

```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

**`ToolExecutionMode`**:

```typescript
type ToolExecutionMode = "sequential" | "parallel";
// sequential: each tool call runs to completion before next starts
// parallel: all tool calls execute concurrently, results emitted in source order
```

**File:** `packages/agent/src/agent.ts`

**`AgentOptions`** -- full configuration surface:

```typescript
interface AgentOptions {
  initialState?: Partial<AgentState>;      // systemPrompt, model, tools, messages
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  onPayload?: SimpleStreamOptions["onPayload"];
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
  steeringMode?: "all" | "one-at-a-time";    // how steering messages are drained
  followUpMode?: "all" | "one-at-a-time";    // how follow-up messages are drained
  sessionId?: string;                         // forwarded to providers for cache-aware backends
  thinkingBudgets?: ThinkingBudgets;
  transport?: Transport;
  maxRetryDelayMs?: number;
  toolExecution?: ToolExecutionMode;
}
```

**`Agent` public API** (the methods WorkRail Auto calls):

```typescript
class Agent {
  // Start a new turn
  async prompt(message: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void>;

  // Continue from current transcript (last message must be user or toolResult)
  async continue(): Promise<void>;

  // Subscribe to lifecycle events -- returns unsubscribe fn
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void;

  // Inject mid-turn steering messages
  steer(message: AgentMessage): void;

  // Inject follow-up messages (run after agent would otherwise stop)
  followUp(message: AgentMessage): void;

  // Current state (systemPrompt, model, tools, messages, isStreaming, etc.)
  get state(): AgentState;

  // Abort current run
  abort(): void;

  // Wait for current run + all listeners to settle
  waitForIdle(): Promise<void>;

  // Reset transcript and queues
  reset(): void;
}
```

**Termination semantics (critical for WorkRail):**

The loop terminates when:
1. The assistant response has `stopReason === "stop"` (no tool calls), AND
2. `getSteeringMessages()` returns `[]`, AND
3. `getFollowUpMessages()` returns `[]`

For WorkRail Auto, the termination bridge is: return `[]` from `getFollowUpMessages` when `continue_workflow` returns `{ _tag: 'complete' }`. Return a follow-up user message when the workflow wants the agent to advance to the next step.

**File:** `packages/agent/src/agent-loop.ts`

The lower-level loop functions (`agentLoop`, `agentLoopContinue`) are also exported but `Agent` wraps them. WorkRail should use `Agent` directly, not `agentLoop`/`agentLoopContinue`.

**Error handling in the loop:**

```typescript
// When LLM returns error:
// -- stopReason === "error", errorMessage set on AssistantMessage
// -- Agent emits { type: "agent_end", messages } with the error message included
// -- agent.state.errorMessage is set

// When a tool throws:
// -- createErrorToolResult() wraps the error as a text content block
// -- isError: true on the ToolResultMessage -- loop continues, LLM sees the error

// When beforeToolCall blocks:
// -- ImmediateToolCallOutcome with isError: true, reason from BeforeToolCallResult.reason
// -- Loop continues normally (tool "ran" but returned an error result)

// When context limit is hit:
// -- stopReason === "length" on AssistantMessage
// -- Handled upstream (by caller) -- loop terminates normally with that stop reason
```

---

### 3. `packages/mom` -- Slack Bot Reference Architecture

**What mom demonstrates for WorkRail Auto:**

`mom` is the reference for "daemon receives trigger → runs agent → responds to channel." The pattern maps directly to WorkRail Auto's notification layer.

**Per-channel state isolation** (`main.ts`):

```typescript
interface ChannelState {
  running: boolean;           // prevents concurrent runs per channel
  runner: AgentRunner;        // persistent -- one Agent per channel
  store: ChannelStore;        // per-channel state/log
  stopRequested: boolean;     // abort flag
}

const channelStates = new Map<string, ChannelState>();
```

WorkRail Auto equivalent: `Map<sessionId, DaemonSessionState>` where each session has its own `Agent` instance.

**Serial queue per channel** (`slack.ts` -- `ChannelQueue`):

```typescript
class ChannelQueue {
  private queue: QueuedWork[] = [];
  private processing = false;

  enqueue(work: QueuedWork): void { /* serializes async work */ }
}
```

This is the "KeyedAsyncQueue" pattern from the backlog -- prevents concurrent modification of the same session. WorkRail's version (~30 lines) serializes `continue_workflow` calls against the same session ID.

**Per-run queue for Slack updates** (`agent.ts`):

```typescript
// Inside runner.run():
let queueChain = Promise.resolve();
const queue = {
  enqueue(fn: () => Promise<void>): void {
    queueChain = queueChain.then(() => fn().catch(handleError));
  }
};

// Subscribe once, use per-run queue in closure:
session.subscribe(async (event) => {
  if (event.type === "tool_execution_start") {
    queue.enqueue(() => ctx.respond(`_→ ${label}_`));
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    queue.enqueue(() => ctx.respond(text));
  }
});
```

WorkRail Auto's equivalent: replace `ctx.respond()` with writing to the console live-view websocket or posting to Slack/webhook.

**Session persistence** (`agent.ts` -- `SessionManager.open(contextFile, channelDir)`):

Mom uses `@mariozechner/pi-coding-agent`'s `SessionManager` which appends to `context.jsonl`. WorkRail Auto does NOT need this -- WorkRail's own session store is the ground truth. Messages are kept in the `Agent.state.messages` array for the duration of a workflow run; the WorkRail session store has the authoritative step notes and continue tokens.

**Runner abort** (`agent.ts`):

```typescript
abort(): void {
  session.abort();  // calls Agent.abort() under the hood
}
```

WorkRail Auto maps this to: `AbortController` per session, triggered by REST control plane or wall-clock timeout.

**`ChannelStore`** (`store.ts`):

Append-only JSONL log of messages per channel. WorkRail Auto does NOT need this -- the WorkRail session store already serves this role.

---

### 4. Tool Registration Pattern

From `packages/mom/src/tools/bash.ts`:

```typescript
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const bashSchema = Type.Object({
  label: Type.String({ description: "Brief description" }),
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number()),
});

export function createBashTool(): AgentTool<typeof bashSchema> {
  return {
    name: "bash",
    label: "bash",
    description: "Execute a bash command...",
    parameters: bashSchema,
    execute: async (toolCallId, { command, timeout }, signal) => {
      // ... execute ...
      return {
        content: [{ type: "text", text: outputText }],
        details: { /* structured details for UI */ }
      };
    }
  };
}
```

**WorkRail Auto's tool registration** would look like:

```typescript
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// WorkRail MCP tools
const startWorkflowSchema = Type.Object({
  workflowId: Type.String(),
  workspacePath: Type.String(),
  goal: Type.String(),
});

export const startWorkflowTool: AgentTool<typeof startWorkflowSchema> = {
  name: "start_workflow",
  label: "start_workflow",
  description: "Start a WorkRail workflow session",
  parameters: startWorkflowSchema,
  execute: async (_id, params, _signal) => {
    const result = await executeStartWorkflow(params);  // direct engine call
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    };
  },
};

const continueWorkflowSchema = Type.Object({
  continueToken: Type.String(),
  intent: Type.Optional(Type.Union([Type.Literal("advance"), Type.Literal("rehydrate")])),
  output: Type.Optional(Type.Object({
    notesMarkdown: Type.String(),
  })),
});

export const continueWorkflowTool: AgentTool<typeof continueWorkflowSchema> = {
  name: "continue_workflow",
  label: "continue_workflow",
  description: "Advance or rehydrate a WorkRail workflow step",
  parameters: continueWorkflowSchema,
  execute: async (_id, params, _signal) => {
    const result = await executeContinueWorkflow(params);  // direct engine call
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: result,
    };
  },
};
```

The key insight: `execute` wraps the existing WorkRail engine handlers (`executeStartWorkflow`, `executeContinueWorkflow`) -- no new session logic, same enforcement.

---

### 5. Error Handling and Recovery

**LLM error** (`stopReason === "error"`):

```typescript
// In agent-loop.ts runLoop():
if (message.stopReason === "error" || message.stopReason === "aborted") {
  await emit({ type: "turn_end", message, toolResults: [] });
  await emit({ type: "agent_end", messages: newMessages });
  return;  // loop exits immediately
}
```

WorkRail Auto handles this in the `agent_end` subscriber:
```typescript
agent.subscribe(async (event) => {
  if (event.type === "agent_end") {
    const lastMsg = event.messages.at(-1);
    if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
      // Write error to WorkRail session store, persist continueToken for retry
      await persistDaemonState({ continueToken, error: (lastMsg as AssistantMessage).errorMessage });
    }
  }
});
```

**Tool throws** (`execute` throws):

```typescript
// In agent-loop.ts executePreparedToolCall():
try {
  const result = await prepared.tool.execute(/* ... */);
  return { result, isError: false };
} catch (error) {
  return {
    result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
    isError: true,
  };
}
```

Tool errors are converted to error tool results and sent back to the LLM. The loop continues -- the LLM decides what to do with the error. This is the correct behavior for WorkRail: if `continue_workflow` throws (malformed token, session not found), the LLM sees the error text and can report back.

**`beforeToolCall` blocks**:

```typescript
if (config.beforeToolCall) {
  const beforeResult = await config.beforeToolCall({ assistantMessage, toolCall, args, context }, signal);
  if (beforeResult?.block) {
    return {
      kind: "immediate",
      result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
      isError: true,
    };
  }
}
```

WorkRail Auto uses this for evidence gating: when `requiredEvidence` is declared, `beforeToolCall` can block `continue_workflow` with "Missing required evidence: X" until the agent provides it via `record_evidence`.

**Context limit** (`stopReason === "length"`):

The loop terminates normally. WorkRail Auto detects this in the `agent_end` handler and persists the `checkpointToken` so the session can be resumed from the last WorkRail step. No special handling needed in the loop itself.

**Abort** (`agent.abort()`):

`AbortController.abort()` propagates through `signal` to every `execute()` call and the LLM stream. The loop terminates with `stopReason === "aborted"`. WorkRail Auto triggers abort from: REST control plane (`POST /api/v2/sessions/:id/cancel`), wall-clock timeout, SIGTERM.

---

## Candidate Generation Expectations

For `full_spectrum` + THOROUGH rigor, the candidate set must:
1. **Reflect landscape precedents**: all 3 candidates must be grounded in observed pi-mono patterns (mom's createRunner, AgentTool<TParameters>, steer() queue), not invented abstractions
2. **Cover the real option space**: the 3 candidates are not variants of the same idea -- they differ on the fundamental structural question (per-run vs per-session Agent instance, and how the termination bridge is wired)
3. **Include one challenge to the assumed design**: at least one candidate must question whether the steer() injection pattern is actually the right approach, or propose an alternative termination mechanism
4. **Meet all 3 decision criteria** (enforcement preserved, crash-recoverable, concurrent-safe) -- candidates that fail any criterion are disqualified, not just ranked lower

## Candidate Directions

### Candidate A (Recommended): Per-run Agent with steer() step injection

**Summary:** Create a fresh `Agent` instance per workflow run. Inject WorkRail step instructions via `agent.steer()` after each `continue_workflow` advance. Terminate by not queueing more steer messages when `isComplete`.

**Tensions resolved:** Structural-vs-semantic termination (steer queue drains naturally when empty = no extra LLM turn). Per-run isolation (fresh Agent = no cross-run state contamination).

**Tension accepted:** Slightly higher construction overhead per run (creating Agent + tools each time).

**Boundary:** `src/daemon/workflow-runner.ts` -- single new file. Engine handlers injected as deps. KeyedAsyncQueue in orchestrator.

**Failure mode to watch:** steer() called after `isComplete` due to race in tool execute() -- prevent with a flag that blocks steer() once complete.

**Follows/adapts:** Adapts mom's `createRunner()` pattern (mutable per-run state in closure, subscribe once). Departs on Agent lifecycle (mom reuses across messages; this creates fresh per run).

**Gain:** Maximum isolation, simplest reasoning about state, crash-safe by construction.

**Give up:** Agent/tool construction overhead per run (~1ms, negligible).

**Impact surface:** New `src/daemon/` module only. Existing MCP handlers untouched. Session lock needs workerId fix (prerequisite).

**Scope:** Best-fit. No narrower boundary handles concurrent sessions. No broader boundary is needed at MVP.

**Philosophy:** Honors Immutability (fresh state per run), Determinism (same inputs = same outputs), YAGNI (no compaction/retry at MVP). Conflicts: throws at tool execute() boundary vs Errors-are-data -- resolved by wrapping engine handler errors as thrown Error objects.

---

### Candidate B (Challenger): Per-session Agent with reset() between runs

**Summary:** Create one `Agent` per long-running daemon session (like mom), call `agent.reset()` between workflow runs to clear transcript. Reuse the Agent instance across multiple triggers for the same workflow.

**Tensions resolved:** Construction efficiency (Agent + tools built once per session).

**Tension accepted:** Per-run isolation requires explicit reset() -- any forgotten field in runState causes cross-run contamination. Harder to reason about.

**Boundary:** Same as Candidate A, but `DaemonSessionPool` manages a pool of reusable Agents keyed by session config hash.

**Failure mode to watch:** reset() clears messages but not beforeToolCall hooks -- if hooks hold closure over per-run state, they carry stale data to the next run.

**Follows/adapts:** Directly follows mom's `createRunner()` pattern (one Agent per channel, reuse across messages).

**Gain:** Lower construction overhead. Consistent with pi-mono's own reference architecture.

**Give up:** Per-run isolation guarantee. More complex state management. reset() misuse risk.

**Impact surface:** Same as Candidate A, but adds `DaemonSessionPool` abstraction.

**Scope:** Slightly too broad for MVP -- session pool management is unneeded when sessions are short-lived.

**Philosophy:** Conflicts with Immutability (mutable Agent across runs). Conflicts with Determinism (reset() must be correct or runs bleed). Honors YAGNI (no extra construction per run).

**Verdict:** Not recommended for MVP. The construction overhead saved is negligible; the isolation risk is real.

---

### Candidate C (Challenger): Flat async loop without Agent class

**Summary:** Implement daemon as a plain `while` loop calling `completeSimple()` directly, with manual tool dispatch and `continue_workflow` calls -- no `Agent` class used.

**Tensions resolved:** None of the structural-vs-semantic tension, because the loop IS semantic -- we control every iteration.

**Tension created:** Loses all pi-mono hooks (beforeToolCall, afterToolCall, subscribe, abort). Must re-implement tool execution, error handling, abort propagation, and observability from scratch.

**Boundary:** Same new `src/daemon/` module, but much larger implementation (~500 LOC vs ~150 LOC for Candidate A).

**Failure mode to watch:** Parallel tool call execution bugs. pi-mono already handles sequential/parallel tool dispatch correctly. Re-implementing it introduces new races.

**Follows/adapts:** Departs from all pi-mono patterns. Goes back to raw API calls.

**Gain:** Maximum control. No abstraction surface to misunderstand.

**Give up:** All the hooks WorkRail needs (beforeToolCall for evidence gating, afterToolCall for tool observation, subscribe for console live view, abort for REST control plane). Plus re-implementing what pi-mono already does correctly.

**Impact surface:** No existing MCP handlers affected. But WorkRail's evidence gate, console live view, and REST cancellation all need to be re-wired manually.

**Scope:** Too narrow -- scope judgment: solving the right problem with the wrong tool. The Agent class exists precisely to handle this loop correctly.

**Philosophy:** Honors Compose-small-pure-functions (each loop iteration is explicit). Conflicts with YAGNI (re-implements what pi-mono provides). Conflicts with Architectural-fixes-over-patches (bypasses the abstraction rather than using it correctly).

**Verdict:** Disqualified. Loses all hooks WorkRail needs. Not a viable MVP candidate.

---

### Direction 1 (Recommended): `createDaemonLoopConfig()` factory per session

One `Agent` instance per concurrent daemon session, created fresh for each workflow run. No shared state between sessions.

```typescript
// src/daemon/agent-factory.ts
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

export function createDaemonAgent(config: DaemonAgentConfig): Agent {
  const model = getModel("anthropic", config.modelId ?? "claude-sonnet-4-5");

  const agent = new Agent({
    initialState: {
      systemPrompt: buildWorkflowSystemPrompt(config),
      model,
      tools: [
        startWorkflowTool,
        continueWorkflowTool,
        createBashTool(),
        createReadTool(),
        createWriteTool(),
      ],
    },
    getApiKey: async () => config.anthropicApiKey,
    toolExecution: "sequential",  // workflow steps must be serial
    beforeToolCall: config.evidenceGate,
    afterToolCall: config.toolObserver,
    getSteeringMessages: async () => {
      // This is the step injection bridge:
      // Return the next WorkRail step as a user message after each tool batch.
      // steer() is used (not followUp()) so steps are injected mid-run, not only after completion.
      return config.pendingSteeringMessages.drain();
    },
    getFollowUpMessages: async () => {
      // Return [] when workflow is complete (no follow-up = agent stops).
      // Return a message only if there's a post-completion action needed (rare).
      return [];
    },
  });

  return agent;
}
```

### Direction 2: Typed discriminant for `continue_workflow` result (from backlog)

```typescript
type WorkflowContinueResult =
  | { _tag: 'advance'; step: PendingStep; continueToken: string }
  | { _tag: 'complete'; finalNotes: string }
  | { _tag: 'error'; message: string };
```

The daemon loop reads this discriminant and either:
- Calls `agent.followUp(buildStepMessage(result.step))` for `advance`
- Returns `[]` from `getFollowUpMessages` for `complete`
- Persists error and exits for `error`

---

## Concrete TypeScript: WorkRail Auto Using pi-mono APIs

### Full daemon run loop

```typescript
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

export async function runWorkflow(
  workflowId: string,
  goal: string,
  config: DaemonRunConfig,
): Promise<void> {
  const agent = createDaemonAgent({ ...config, workflowId, goal });

  // Subscribe for observability (console live view, logging)
  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    if (event.type === "tool_execution_start") {
      await config.progressEmitter.emit({ type: "tool_start", name: event.toolName });
    }
    if (event.type === "agent_end") {
      const lastMsg = event.messages.at(-1) as any;
      if (lastMsg?.stopReason === "error") {
        await config.daemonState.writeError(lastMsg.errorMessage);
      }
    }
  });

  try {
    // Persist state BEFORE each step -- crash recovery
    await config.daemonState.write({ continueToken: null, step: "starting" });

    // Start the workflow
    await agent.prompt(
      `Start workflow "${workflowId}" with goal: ${goal}\n\nUse start_workflow to begin.`,
    );

    await agent.waitForIdle();
  } finally {
    unsubscribe();
  }
}
```

### Tool for `continue_workflow` with termination bridge

```typescript
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// Per-run state -- NOT shared between sessions
interface DaemonRunState {
  pendingFollowUps: AgentMessage[];
  isComplete: boolean;
  continueToken: string | null;
}

export function createContinueWorkflowTool(
  state: DaemonRunState,
  daemonStateFile: DaemonStateFile,
): AgentTool<typeof continueWorkflowSchema> {
  return {
    name: "continue_workflow",
    label: "continue_workflow",
    description: "Advance to the next WorkRail workflow step",
    parameters: continueWorkflowSchema,
    execute: async (_id, params, _signal) => {
      // Persist token BEFORE calling engine -- crash safety
      await daemonStateFile.write({ continueToken: params.continueToken });

      const result = await executeContinueWorkflow(params) as WorkflowContinueResult;

      if (result._tag === "complete") {
        state.isComplete = true;
        // getFollowUpMessages will return [] -- agent terminates
      } else if (result._tag === "advance") {
        state.continueToken = result.continueToken;
        // Inject next step as follow-up -- agent continues
        state.pendingFollowUps.push({
          role: "user",
          content: [{ type: "text", text: formatStepInstructions(result.step) }],
          timestamp: Date.now(),
        });
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
```

### Evidence gate via `beforeToolCall`

```typescript
export function createEvidenceGate(
  evidenceStore: EvidenceStore,
): AgentOptions["beforeToolCall"] {
  return async (ctx, _signal) => {
    if (ctx.toolCall.name !== "continue_workflow") return undefined;

    const args = ctx.args as { intent?: string; continueToken?: string };
    if (args.intent === "rehydrate") return undefined;  // rehydrate never gated

    const requiredEvidence = evidenceStore.getRequired(ctx.context);
    const missingEvidence = requiredEvidence.filter((e) => !evidenceStore.has(e));

    if (missingEvidence.length > 0) {
      return {
        block: true,
        reason: `Cannot advance: missing required evidence: ${missingEvidence.join(", ")}. Use record_evidence tool first.`,
      };
    }

    return undefined;  // allow
  };
}
```

---

## Parallel Research Synthesis (COMPLETENESS + DEPTH)

### COMPLETENESS findings -- gaps to add

**Critical gap found:** `getModel()` from `@mariozechner/pi-ai` was not documented. This is how WorkRail constructs `Model<KnownApi>` instances:

```typescript
import { getModel } from "@mariozechner/pi-ai";
const model = getModel("anthropic", "claude-sonnet-4-5");
// Returns: Model<"anthropic-messages"> with full cost/context/maxTokens data
```

`@mariozechner/pi-ai` also exports:
- `isContextOverflow(message)` -- detects overflow errors for context management (not MVP but useful)
- `calculateCost(model, usage)` -- computes cost breakdown from usage
- `modelsAreEqual(a, b)` -- compares two model descriptors
- `supportsXhigh(model)` -- checks if a model supports xhigh thinking level
- `Type` from `@sinclair/typebox` -- re-exported for tool schema construction

**`packages/agent/src/proxy.ts`** -- `streamProxy()` for routing through a server. WorkRail Auto does NOT need this; it calls providers directly.

**Compaction utilities** in `packages/coding-agent/src/core/compaction/`: `shouldCompact()`, `estimateContextTokens()`, `compact()`. WorkRail does not need these at MVP -- the daemon runs short-lived workflow sessions, not long-running interactive sessions.

### DEPTH findings -- behavioral details

**1. Concurrent prompt() calls:** Throws `"Agent is already processing a prompt."` immediately. WorkRail's KeyedAsyncQueue must queue calls per session ID and call `agent.waitForIdle()` before issuing the next prompt.

**2. getFollowUpMessages timing (exact):** Called only in the outer loop, after the inner loop exits (no more tool calls AND no more steering messages). NOT called during active tool execution. This means: a follow-up cannot be delivered mid-turn.

**3. steer() vs followUp() -- IMPORTANT CORRECTION:**
- `steer()` messages are polled **after every tool execution turn** (inside the inner loop) -- they interrupt mid-run
- `followUp()` messages are polled **only when the agent would otherwise stop** (outer loop) -- they resume after completion
- **WorkRail should use `steer()` to inject the next step**, NOT `followUp()`. Using `followUp()` would mean the agent completes all tool calls, tries to stop, and only then sees the next step -- which requires an extra LLM turn. `steer()` injects the step after the current tool batch completes, before the agent can "stop" thinking.

**4. afterToolCall can flip isError false:** `afterResult.isError ?? isError` -- yes, afterToolCall can flip `isError: true` to `isError: false`. The flipped value propagates to the ToolResultMessage. WorkRail can use this to suppress evidence-gate error messages from polluting the LLM transcript.

**5. agent.continue() vs agent.prompt():** `prompt()` adds new messages to the transcript. `continue()` resumes from the existing transcript without adding. WorkRail calls `prompt()` for every new step. `continue()` is only for resume-from-interrupt scenarios where the last message in the transcript is already a user message (e.g., after a crash recovery that reloaded from disk).

**6. AbortSignal propagation:** The same `AbortController.signal` created in `runWithLifecycle()` is passed through the entire call chain to `tool.execute()`. When `agent.abort()` is called, it triggers `abortController.abort()` which cancels in-flight tool executions and the LLM stream simultaneously. WorkRail's engine handlers must accept and honor `signal` to support graceful cancellation.

## Decision Log

| Decision | Rationale |
|---|---|
| Use `Agent` class (not raw `agentLoop`) | `Agent` manages state, queuing, lifecycle events, abort. Raw loop is lower-level than needed. |
| `toolExecution: "sequential"` for WorkRail | Workflow steps must execute in order. Parallel tool execution would allow `continue_workflow` to race with `Bash`. |
| One `Agent` instance per daemon session, mutable runState per run | mom's createRunner() pattern exactly. subscribe() once at creation, reset runState at start of each runWorkflow() call. Balances isolation and construction efficiency. |
| `agent.steer()` for step injection (NOT `getFollowUpMessages`) | steer() fires after each tool batch (inner loop). followUp() fires only when agent would stop (outer loop). Wrong choice adds an extra LLM turn per step. |
| Do NOT use `SessionManager` from coding-agent | WorkRail's own session store is the ground truth. No need for `context.jsonl` sidecar. |
| Do NOT import mom tools | WorkRail Auto needs `start_workflow`/`continue_workflow` as primary tools, not bash/read/write as primaries. |
| abort() is best-effort for synchronous engine ops | Engine handlers use synchronous SQLite + HMAC. AbortSignal cannot interrupt synchronous code. Worst case: current synchronous op completes, then session stops. Session state is consistent. |
| KeyedAsyncQueue invariant: documentation-enforced at MVP | Tool execute() must not call daemon handlers that queue on same sessionId. Structural enforcement deferred to post-MVP (before external users). |
| `WorkflowRunState` type-safe discriminant: post-MVP | isComplete boolean flag at MVP; discriminated union (running, complete, error) before external users. |

---

## Final Recommendation

**Selected direction:** Candidate A hybrid -- Per-run Agent state, subscribe() once at daemon session creation, mutable runState reset per run, steer() for step injection.

**Confidence:** HIGH. Design grounded by: (1) exhaustive pi-mono source reading, (2) two parallel research executors, (3) adversarial challenger (0 blocking findings), (4) full tradeoff/failure mode/philosophy/runner-up review, (5) stable across review loop (directionRevised=false).

**Strongest alternative:** Candidate B (per-session Agent with reset()) -- prefer if per-run construction overhead exceeds 10ms in profiling (unlikely at MVP with 5 tools).

**Residual risks (2, both post-MVP):**
1. ORANGE: KeyedAsyncQueue re-entry constraint documentation-enforced only. Structural enforcement needed before external users.
2. ORANGE: isComplete boolean flag instead of type-safe WorkflowRunState discriminant. Discriminated union needed before external users.

**What this does NOT resolve:** Multi-tenancy (one Agent per user vs one per trigger type), context window management (not needed at MVP), retry logic on LLM errors (not needed at MVP). These are deliberate out-of-scope items with clear seams for post-MVP addition.

## Final Summary

**Discovery path:** full_spectrum. Problem: how to wire pi-mono's Agent class into WorkRail Auto's daemon so the enforcement contract is preserved. Landscape grounding: exhaustive pi-mono source reading + two parallel research executors. Problem framing: 4 core tensions identified, steer() vs followUp() correction as the critical insight.

**Selected direction:** Candidate A hybrid -- per-run Agent state with subscribe() once at daemon session creation, mutable runState reset per run, `agent.steer()` for step injection.

**Why it won:** Resolves all 4 core tensions. Meets all 3 acceptance criteria (enforcement preserved, crash-recoverable, concurrent-safe). Adapts mom's proven createRunner() pattern with a justified departure (fresh state per run). Honors the dev's stated philosophy (immutability, determinism, YAGNI). Adversarial challenge produced 0 blocking findings.

**Why the runner-up (Candidate B: per-session + reset()) lost:** Construction efficiency advantage (~1ms) is negligible at MVP tool count (5 tools). Isolation risk (reset() misuse) outweighs the savings.

**Confidence:** HIGH. Evidence quality: source code read, two parallel researchers, one adversarial challenger, full review loop.

**Residual risks (2, post-MVP):**
1. KeyedAsyncQueue re-entry constraint is documentation-enforced. Structural enforcement needed before external users.
2. isComplete boolean flag instead of type-safe WorkflowRunState discriminant. Discriminated union before external users.

**Next actions:**
1. Fix LocalSessionLockV2 with workerId (prerequisite for in-process daemon)
2. Create src/daemon/workflow-runner.ts (~150 LOC) implementing the hybrid pattern
3. Register start_workflow, continue_workflow, Bash, Read, Write as AgentTool<TParameters>
4. Wire continueToken persistence to daemon state file before each engine call
5. Add KeyedAsyncQueue (~30 LOC) in daemon orchestrator

**Where to find artifacts:**
- `docs/design/pi-mono-discovery.md` -- this file: full API reference, TypeScript snippets, decision log
- `docs/design/pi-mono-design-candidates.md` -- raw candidate analysis with comparison matrix
- `docs/design/pi-mono-design-review-findings.md` -- tradeoff/failure mode/philosophy review with RED/ORANGE/YELLOW findings

**What WorkRail Auto takes from pi-mono:**

1. **`Agent` class** (`@mariozechner/pi-agent-core`) -- multi-turn loop with tool execution, hooks, abort, subscribe
2. **`AgentTool<TParameters>`** with TypeBox schemas -- define `start_workflow`, `continue_workflow`, `Bash`, `Read`, `Write`
3. **`agent.steer()`** -- step injection: called from inside tool execute() after each continue_workflow advance
4. **`beforeToolCall` hook** -- evidence gate: block `continue_workflow` advance when required evidence is missing
5. **`afterToolCall` hook** -- tool observation: record what tools the agent called for audit trail
6. **`agent.abort()`** -- cancellation, best-effort for synchronous engine operations
7. **`agent.subscribe()`** -- observability: feed events to console live-view websocket
8. **`KeyedAsyncQueue` pattern** (~30 lines, re-implement, don't import) -- serialize concurrent runs against same session ID
9. **`getModel("anthropic", "claude-sonnet-4-5")`** from `@mariozechner/pi-ai` -- model descriptor

**What WorkRail Auto does NOT need from pi-mono:**

- `SessionManager` / `AgentSession` from coding-agent (WorkRail has its own session store)
- `ChannelStore` / `log.jsonl` (WorkRail session store is the log)
- `loadSkillsFromDir` / `formatSkillsForPrompt` (WorkRail uses its own skill system)
- Provider registration (built-ins auto-register on import)
- `agentLoop` / `agentLoopContinue` directly (use `Agent` class instead)
- mom's `SlackBot` (WorkRail notification layer is separate)
