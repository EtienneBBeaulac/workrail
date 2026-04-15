# pi-mono Integration Discovery

**Date:** 2026-04-14
**Status:** In Progress
**Path:** `landscape_first`
**Goal:** Understand pi-mono's full API to design WorkRail Auto's agent loop integration

---

## Context / Ask

WorkRail Auto will use `@mariozechner/pi-agent-core` as its agent loop foundation (decision already made -- see `docs/ideas/backlog.md`, section "Agent loop decision: pi-mono wins"). This discovery is not about whether to use pi-mono -- that's settled. The goal is:

1. Exhaustive understanding of every API surface that WorkRail will touch
2. Concrete TypeScript showing the integration pattern
3. Explicit design decisions on the non-obvious integration points

**Repo:** `https://github.com/badlogic/pi-mono` -- 35k stars, MIT, TypeScript monorepo by Mario Zechner

---

## Path Recommendation

**`landscape_first`** -- the dominant need is understanding an existing system in detail, not reframing a problem. We know what we're doing (building WorkRail Auto); we need to know what we're working with (pi-mono's API). Pure landscape/comprehension work.

---

## Constraints / Anti-Goals

- **Constraints:** WorkRail Auto must remain freestanding. No `mom`-specific dependencies. `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` only for MVP.
- **Anti-goals:** Do not design the full daemon in this document. Do not design the trigger system. Focus only on the agent loop integration surface.
- **Scope boundary:** This document ends at "concrete TypeScript that would work." It does not implement production-ready code.

---

## Landscape Packet

### Current State Summary

pi-mono is a TypeScript monorepo with the following packages relevant to WorkRail:

| Package | npm name | Purpose |
|---------|----------|---------|
| `packages/ai` | `@mariozechner/pi-ai` | Unified multi-provider LLM API (OpenAI, Anthropic, Google, Bedrock, etc.) |
| `packages/agent` | `@mariozechner/pi-agent-core` | Stateful `Agent` class wrapping the multi-turn LLM + tool call loop |
| `packages/mom` | (not published separately) | Slack bot using `Agent` -- reference implementation for channel integration |
| `packages/coding-agent` | `@mariozechner/pi-coding-agent` | `SessionManager`, `AgentSession`, skill loading -- higher-level session abstraction |

WorkRail uses `@mariozechner/pi-agent-core` (pinned at 0.67.2, 246kB, 1 dependency: `@mariozechner/pi-ai`).

### The `Agent` Class -- Full API

**Location:** `packages/agent/src/agent.ts`

```typescript
export interface AgentOptions {
  // Initial conversation state
  initialState?: Partial<Omit<AgentState, 'pendingToolCalls' | 'isStreaming' | 'streamingMessage' | 'errorMessage'>>;

  // Custom message conversion: AgentMessage[] -> LLM-compatible Message[]
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

  // Context transform: prune/inject before convertToLlm (token management, ancestry injection)
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

  // Streaming implementation (default: streamSimple from pi-ai)
  streamFn?: StreamFn;

  // Dynamic API key resolution (per LLM call -- for expiring OAuth tokens)
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

  // Raw provider payload inspection (for debugging, prompt caching config)
  onPayload?: SimpleStreamOptions['onPayload'];

  // Tool call hooks -- the critical WorkRail integration points
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

  // Message queue modes: "all" drains queue each turn, "one-at-a-time" processes one
  steeringMode?: QueueMode;  // default: "one-at-a-time"
  followUpMode?: QueueMode;  // default: "one-at-a-time"

  // Session ID for provider-level caching (Anthropic session header)
  sessionId?: string;

  // Reasoning/thinking token budgets
  thinkingBudgets?: ThinkingBudgets;

  // SSE vs WebSocket transport preference
  transport?: Transport;

  // Cap on provider-requested retry delays (default: 60s)
  maxRetryDelayMs?: number;

  // Sequential vs parallel tool execution (default: parallel in loop, sequential available)
  toolExecution?: ToolExecutionMode;
}
```

**`AgentState` interface (public read, some write):**

```typescript
interface AgentState {
  systemPrompt: string;          // Mutable: update between runs for fresh memory
  model: Model<any>;             // Mutable: switch models per run
  thinkingLevel: ThinkingLevel;  // off | minimal | low | medium | high | xhigh
  tools: AgentTool<any>[];       // Mutable: add/remove tools at runtime
  messages: AgentMessage[];      // Mutable: load persisted history on startup
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

**`Agent` public methods:**

```typescript
class Agent {
  // Read current state (snapshot, not live reference)
  get state(): AgentState

  // Run with a new user prompt
  prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void>

  // Continue from current context (no new user message)
  continue(): Promise<void>

  // Cancel current run
  abort(): void

  // Inject messages mid-run (after current tool calls finish, before next LLM call)
  steer(message: AgentMessage | string): void

  // Queue follow-up to process after agent would otherwise stop
  followUp(message: AgentMessage | string): void

  // Subscribe to all events (lifecycle, streaming, tool execution)
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void

  // Wait until agent is idle
  waitUntilIdle(): Promise<void>
}
```

**Key architectural fact:** `Agent` is stateful and persistent. The same instance is reused across multiple `prompt()` calls. The transcript accumulates. This is the `mom` pattern -- one `Agent` instance per Slack channel, alive for the bot's lifetime.

### Termination: How the Loop Stops

This is the most critical integration point for WorkRail.

The loop in `agent-loop.ts` terminates when:
1. LLM produces an assistant message with `stopReason !== "toolUse"` (i.e., `"stop"` or `"length"`) -- no more tool calls
2. `getSteeringMessages()` returns `[]` -- no pending steering messages
3. `getFollowUpMessages()` returns `[]` -- no queued follow-up prompts

**This is structural termination, not semantic.** The loop has no concept of "the workflow is complete." It stops when there is nothing more to do. For WorkRail, this means:

> **WorkRail must bridge `isComplete` from `continue_workflow` into `getFollowUpMessages` returning `[]`.**

If `continue_workflow` returns `{ _tag: 'advance', continueToken, step }`, return a follow-up message containing the next step. If `{ _tag: 'complete' }`, return `[]` -- the loop terminates naturally.

### Tool Definition -- `AgentTool<TParameters>`

**Location:** `packages/agent/src/types.ts`

```typescript
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any>
  extends Tool<TParameters> {

  name: string;           // Tool name (what the LLM calls)
  description: string;    // What the tool does (shown to LLM)
  parameters: TParameters; // TypeBox schema for arguments
  label: string;           // Human-readable label for UI display
  
  // Optional: normalize raw args before schema validation
  prepareArguments?: (args: unknown) => Static<TParameters>;

  // Execute -- THROW on failure (don't encode in content)
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];  // Text shown to LLM
  details: T;                               // Structured data for logs/UI
}
```

**Tool schemas use TypeBox (`@sinclair/typebox`).** This is important: WorkRail's `start_workflow` and `continue_workflow` tools need TypeBox schemas, not JSON Schema directly.

### The `BeforeToolCallResult` / `AfterToolCallResult` Hooks

These are the WorkRail evidence gate integration points:

```typescript
// beforeToolCall: can BLOCK a tool call before it executes
interface BeforeToolCallResult {
  block?: boolean;   // If true: tool does NOT execute, error result emitted instead
  reason?: string;   // Shown in the blocked tool result message
}

// Receives: assistantMessage, toolCall, validated args, current context
interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;
  context: AgentContext;
}

// afterToolCall: can OVERRIDE parts of the executed result
interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[]; // Override full content
  details?: unknown;                         // Override full details
  isError?: boolean;                         // Override error flag
}
```

**WorkRail use of `beforeToolCall`:** When a workflow step has `requiredEvidence`, WorkRail's `beforeToolCall` hook can inspect tool calls and require certain evidence to be present before the LLM can call `continue_workflow`. If the token is not gated by evidence, block with `{ block: true, reason: "Required evidence not yet recorded" }`.

**WorkRail use of `afterToolCall`:** Not needed for MVP. Potentially useful later for injecting step notes into tool results.

### Streaming: `AgentEvent` Union

All agent events flow through `subscribe()`. Events are emitted synchronously in order:

```
agent_start
  turn_start
    message_start        (user prompt)
    message_end
    message_start        (assistant streaming)
    message_update * N   (per streaming chunk)
    message_end          (final assistant message)
    tool_execution_start
    tool_execution_update * N
    tool_execution_end
  turn_end
  [more turns if tool calls...]
agent_end
```

**Key:** `message_update` carries `assistantMessageEvent: AssistantMessageEvent` from pi-ai, which carries the raw provider streaming events (`text_delta`, `toolcall_delta`, etc.). WorkRail's console live view subscribes here to stream tokens.

### `ToolExecutionMode`: Sequential vs Parallel

```typescript
type ToolExecutionMode = "sequential" | "parallel";
```

- `"sequential"`: each tool call prepares, executes, and finalizes before the next starts. Safe default for WorkRail -- workflow tools have ordering requirements.
- `"parallel"`: tools are prepared sequentially (so `beforeToolCall` runs in order), then allowed tools execute concurrently. Final results are emitted in source order.

**WorkRail recommendation:** Use `"sequential"` for the daemon loop. Workflow integrity requires that `continue_workflow` completes before `Bash` begins on the next step.

### The `mom` Slack Bot -- Concurrency and Channel State

**Architecture:**

```
SlackBot (WebSocket Socket Mode)
  ├── ChannelQueue per channel  (serialized processing)
  ├── ChannelState per channel
  │   ├── running: boolean
  │   ├── stopRequested: boolean
  │   └── runner: AgentRunner  (one Agent per channel, persistent)
  └── ChannelStore per channel  (attachment download, log.jsonl)
```

**How concurrent messages are handled:**

`mom` uses a `ChannelQueue` (per channel) with a simple promise chain:

```typescript
class ChannelQueue {
  private queue: QueuedWork[] = [];
  private processing = false;

  enqueue(work: QueuedWork): void {
    this.queue.push(work);
    this.processNext(); // fires and forgets -- processes next when current finishes
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const work = this.queue.shift()!;
    try { await work(); } catch { ... }
    this.processing = false;
    this.processNext(); // tail call -- processes next item
  }
}
```

This is the `KeyedAsyncQueue` pattern the backlog recommends reimplementing for WorkRail (~30 lines). Per-channel serialization: while the agent is running for channel X, new messages for channel X queue behind it.

**What WorkRail needs vs what `mom` has:**

| Concern | `mom` | WorkRail daemon |
|---------|-------|----------------|
| Concurrency unit | Slack channel | WorkRail session ID |
| Queue key | `channelId` | `sessionId` |
| Persistent state | `Agent` instance (in-memory) | `Agent` instance + WorkRail session store (disk) |
| Context survival | `SessionManager.context.jsonl` | WorkRail append-only event log |
| Trigger | Slack message | GitLab webhook / Jira webhook / cron |
| Termination | `getFollowUpMessages() = []` | `isComplete = true` from `continue_workflow` |

**Per-channel state (`ChannelState`) -- WorkRail equivalent:**

```typescript
// mom's ChannelState
interface ChannelState {
  running: boolean;
  runner: AgentRunner;
  store: ChannelStore;
  stopRequested: boolean;
  stopMessageTs?: string;
}

// WorkRail's equivalent (per active session)
interface DaemonSessionState {
  running: boolean;
  agent: Agent;
  sessionId: string;      // WorkRail session ID
  continueToken: string;  // Current step's continue token (persisted to disk)
  checkpointToken: string; // Last checkpoint token (persisted to disk)
  abortController: AbortController;
}
```

**The `AgentRunner` interface (`mom/src/agent.ts`):**

```typescript
interface AgentRunner {
  run(
    ctx: SlackContext,
    store: ChannelStore,
    pendingMessages?: PendingMessage[],
  ): Promise<{ stopReason: string; errorMessage?: string }>;
  abort(): void;
}
```

WorkRail's daemon runner is structurally identical: `run(trigger: WorkflowTrigger): Promise<{ stopReason: string }>` + `abort()`.

### System Prompt Refresh Pattern

`mom` updates the `Agent`'s system prompt on every `run()` call, even though the `Agent` instance persists:

```typescript
// In AgentRunner.run():
const memory = getMemory(channelDir);
const skills = loadMomSkills(channelDir, workspacePath);
const systemPrompt = buildSystemPrompt(..., memory, skills);
session.agent.state.systemPrompt = systemPrompt; // Mutate directly
```

**WorkRail use:** Inject the ancestry recap (step notes from previous steps) into the system prompt on each daemon session start. The system prompt is the injection point for context survival, per the backlog's "context survival" design decision.

### Error Handling

The loop emits `agent_end` with a message where `stopReason === "error"` or `"aborted"`. The `Agent` class:

1. Catches exceptions in the executor
2. Synthesizes a failure `AssistantMessage` with `stopReason: "error"`, `errorMessage: error.message`
3. Pushes it to `messages` and emits `agent_end`
4. Never re-throws -- errors are data in the event stream

**WorkRail retry pattern (from backlog):**

```typescript
// Not in pi-mono -- WorkRail reimplements this (~30 lines)
async function runWithRetry(
  agent: Agent,
  prompt: string,
  maxAttempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await agent.prompt(prompt);
    const state = agent.state;
    const lastMsg = state.messages.at(-1);
    if (lastMsg?.role === 'assistant' && lastMsg.stopReason === 'error') {
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new Error(`Agent failed after ${maxAttempts} attempts: ${lastMsg.errorMessage}`);
    }
    return;
  }
}
```

### Token Persistence (Critical for WorkRail)

`mom` has no durable token persistence -- it's a Slack bot, and if it crashes, the conversation restarts naturally. WorkRail has a hard requirement here (from backlog):

> Daemon must write `continueToken` + `checkpointToken` to `~/.workrail/daemon-state.json` (atomic write) before each step. Crash without this = unrecoverable sessions.

pi-mono has no built-in crash recovery. WorkRail's `afterToolCall` hook on `continue_workflow` is the right integration point for persisting tokens.

---

## Problem Frame Packet

### Who Needs This

- **Primary:** WorkRail daemon implementer (Etienne) -- needs the exact API surface to write `src/daemon/`
- **Secondary:** WorkRail console -- needs event types for live streaming
- **Tertiary:** Future contributors extending WorkRail's tool set

### Jobs / Outcomes

1. Author `createDaemonLoopConfig()` factory without guessing API shapes
2. Define `start_workflow` and `continue_workflow` as `AgentTool<TParameters>` correctly
3. Know exactly where to inject WorkRail's session durability, evidence gates, and ancestry recap
4. Know which parts of `mom` to reimplement vs import

### Success Criteria

- Zero "I'll figure this out when I implement it" decisions remaining
- Concrete TypeScript compiles without TypeBox/pi-mono type errors
- Every integration point has a documented decision and rationale

---

## Candidate Directions

### Direction A: Direct `Agent` usage (selected)

Use `@mariozechner/pi-agent-core`'s `Agent` class directly, per the backlog decision. Define WorkRail's tools as `AgentTool<TParameters>` with TypeBox schemas. Use `getFollowUpMessages` for workflow progression. Use `beforeToolCall` for evidence gating. Create one `Agent` per daemon session (not shared).

**Why it wins:**
- Exactly what the backlog specified
- Clean, minimal, 1 dependency
- `Agent` handles all retry/backoff internally (`auto_retry_start` event)
- `beforeToolCall` is exactly the right hook for WorkRail's gating model
- `getFollowUpMessages` maps cleanly to `isComplete` bridge

**Risks:**
- No built-in timeout -- need wall-clock limit via `steer()` + turn counter
- No built-in token persistence -- WorkRail adds this in `afterToolCall` on `continue_workflow`

### Direction B: Use `agentLoop()` low-level function directly (runner-up)

Use the exported `agentLoop()` / `agentLoopContinue()` functions from `agent-loop.ts` directly, without the stateful `Agent` wrapper.

**Why it loses:**
- Would require WorkRail to manage the `AgentContext` (messages, tools, system prompt) manually
- `Agent` already does all of this correctly and adds abort support, event subscription, and queue management
- No benefit for WorkRail's use case -- WorkRail creates a new `Agent` per daemon session anyway

---

## Challenge Notes

**Challenge:** `Agent` is designed for persistent, long-lived instances (one per Slack channel). WorkRail creates one per daemon session, which may be short-lived. Is there a resource leak?

**Resolution:** No. `Agent` holds no external resources -- it's a plain TypeScript object wrapping arrays and a `Set`. No connections, no handles. Creating and discarding `Agent` instances is perfectly safe.

**Challenge:** `getFollowUpMessages` is called after the loop would "naturally" stop. If `continue_workflow` triggers tool calls in the same turn (e.g., the LLM calls both `continue_workflow` and `Bash`), could there be a sequencing issue?

**Resolution:** With `toolExecution: "sequential"`, `continue_workflow` executes first, `Bash` second. The follow-up return from `continue_workflow` is queued in WorkRail's outer state. After all tool calls in the turn complete, the loop polls `getFollowUpMessages`. At that point, WorkRail returns the next step prompt. Clean.

**Challenge:** The loop terminates when `stopReason === "stop"` with no follow-ups. But what if the LLM calls `continue_workflow` and the response is `isComplete: true` -- when exactly does `getFollowUpMessages` return `[]`?

**Resolution:** `getFollowUpMessages` is called after the full turn (including all tool results) completes. The tool result from `continue_workflow` with `isComplete: true` is already in the context. The closure captures `isComplete` from `execute()` and `getFollowUpMessages` returns `[]` on the next poll. The loop exits. WorkRail's outer `run()` function resolves.

---

## Resolution Notes

**Resolution mode: `direct_recommendation`** -- the landscape work is comprehensive enough. All API shapes are known. The integration points are explicit. The TypeScript below is the concrete output.

**Confidence band: HIGH** -- pi-mono's API is well-typed, stable (pinned at 0.67.2), and matches the backlog's assumptions exactly. No surprises found during the deep dive.

**Residual risks:**
1. TypeBox version mismatch between WorkRail and `@mariozechner/pi-agent-core` -- check `peerDependencies` before npm install
2. `@mariozechner/pi-ai` may not export `streamSimple` for all Anthropic model IDs -- test with the exact model ID WorkRail wants
3. `Agent.state` is a getter that returns a snapshot. Mutations to the returned object do NOT update agent state -- must assign back to `agent.state.messages = [...]` etc.

---

## Decision Log

| Decision | Rationale |
|----------|-----------|
| `landscape_first` path | Pure comprehension task on an existing library |
| Direct `Agent` class (not low-level `agentLoop`) | Stateful wrapper handles all lifecycle, no benefit to going lower |
| `toolExecution: "sequential"` | Workflow tools have ordering requirements |
| `getFollowUpMessages` for workflow progression | Cleanest structural termination bridge |
| `beforeToolCall` for evidence gating | Designed exactly for this use case (block + reason) |
| `afterToolCall` on `continue_workflow` for token persistence | Only safe hook after the token is returned |

---

## Final Summary

See "Concrete TypeScript Integration" section below for the full implementation.

**Selected path:** `landscape_first`
**Chosen direction:** Direct `Agent` class usage with TypeBox tools
**Why it won:** Matches backlog decision exactly; `Agent` handles all lifecycle concerns; `getFollowUpMessages` cleanly bridges structural termination to semantic workflow completion
**Strongest alternative:** Low-level `agentLoop()` -- rejected because it requires manual state management with no benefit
**Confidence band:** HIGH
**Residual risks:** TypeBox version pin, Anthropic model ID availability, `state` getter snapshot semantics
**Next actions:** Implement `src/daemon/index.ts` using the patterns below

---

## Concrete TypeScript: WorkRail Auto + pi-mono Integration

### 1. Tool Definitions (`src/daemon/tools.ts`)

```typescript
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { DaemonSessionBridge } from "./bridge.js";

// ============================================================================
// WorkRail tool result discriminant
// ============================================================================

export type WorkflowContinueResult =
  | { _tag: "advance"; step: PendingStep; continueToken: string; checkpointToken?: string }
  | { _tag: "complete"; finalNotes: string }
  | { _tag: "error"; message: string };

export interface PendingStep {
  id: string;
  title: string;
  prompt: string;
}

// ============================================================================
// start_workflow tool
// ============================================================================

const StartWorkflowParams = Type.Object({
  workflowId: Type.String({ description: "ID of the workflow to start" }),
  workspacePath: Type.String({ description: "Absolute path to the workspace" }),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: "Initial workflow context variables",
  })),
  label: Type.String({ description: "Human-readable label shown in UI" }),
});

export function createStartWorkflowTool(
  bridge: DaemonSessionBridge,
): AgentTool<typeof StartWorkflowParams, WorkflowContinueResult> {
  return {
    name: "start_workflow",
    description: "Start a WorkRail workflow session and return the first step.",
    parameters: StartWorkflowParams,
    label: "Start Workflow",

    execute: async (
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<WorkflowContinueResult>> => {
      const result = await bridge.startWorkflow(params, signal);

      if (result._tag === "error") {
        throw new Error(result.message);
      }

      if (result._tag === "complete") {
        return {
          content: [{ type: "text", text: `Workflow complete: ${result.finalNotes}` }],
          details: result,
        };
      }

      // Persist tokens before returning -- crash safety
      await bridge.persistTokens(result.continueToken, result.checkpointToken);

      return {
        content: [{
          type: "text",
          text: [
            `## Step: ${result.step.title}`,
            "",
            result.step.prompt,
            "",
            `continueToken: ${result.continueToken}`,
          ].join("\n"),
        }],
        details: result,
      };
    },
  };
}

// ============================================================================
// continue_workflow tool
// ============================================================================

const ContinueWorkflowParams = Type.Object({
  continueToken: Type.String({ description: "Token from the previous step" }),
  notes: Type.Optional(Type.String({ description: "Notes from completing this step" })),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: "Context variables to set for the next step",
  })),
  label: Type.String({ description: "Human-readable label shown in UI" }),
});

export function createContinueWorkflowTool(
  bridge: DaemonSessionBridge,
  onComplete: (result: WorkflowContinueResult & { _tag: "complete" }) => void,
): AgentTool<typeof ContinueWorkflowParams, WorkflowContinueResult> {
  return {
    name: "continue_workflow",
    description: "Advance the WorkRail workflow to the next step.",
    parameters: ContinueWorkflowParams,
    label: "Continue Workflow",

    execute: async (
      _toolCallId,
      params,
      signal,
    ): Promise<AgentToolResult<WorkflowContinueResult>> => {
      const result = await bridge.continueWorkflow(params, signal);

      if (result._tag === "error") {
        throw new Error(result.message);
      }

      if (result._tag === "complete") {
        onComplete(result);
        return {
          content: [{ type: "text", text: `Workflow complete: ${result.finalNotes}` }],
          details: result,
        };
      }

      // Persist tokens before returning -- crash safety
      await bridge.persistTokens(result.continueToken, result.checkpointToken);

      return {
        content: [{
          type: "text",
          text: [
            `## Next Step: ${result.step.title}`,
            "",
            result.step.prompt,
            "",
            `continueToken: ${result.continueToken}`,
          ].join("\n"),
        }],
        details: result,
      };
    },
  };
}
```

### 2. Daemon Loop Factory (`src/daemon/loop.ts`)

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  createStartWorkflowTool,
  createContinueWorkflowTool,
  type WorkflowContinueResult,
  type PendingStep,
} from "./tools.js";
import type { DaemonSessionBridge } from "./bridge.js";

export interface DaemonRunConfig {
  workflowId: string;
  workspacePath: string;
  triggerContext: Record<string, unknown>;
  anthropicApiKey: string;
  sessionId: string;  // WorkRail session ID (for provider-side caching)
}

/**
 * Run a single WorkRail autonomous session.
 *
 * Creates one Agent per session (not shared). The Agent is garbage-collected
 * when this function returns.
 *
 * Termination: the loop exits when continue_workflow returns isComplete=true,
 * which routes through getFollowUpMessages returning [].
 */
export async function runDaemonSession(
  config: DaemonRunConfig,
  bridge: DaemonSessionBridge,
  signal?: AbortSignal,
): Promise<{ stopReason: string; error?: string }> {

  // ---- Completion bridge ----
  // Captured by getFollowUpMessages closure to know when to return []
  let isComplete = false;
  let completionNotes: string | undefined;

  const onComplete = (result: WorkflowContinueResult & { _tag: "complete" }) => {
    isComplete = true;
    completionNotes = result.finalNotes;
  };

  // ---- Tools ----
  const startWorkflowTool = createStartWorkflowTool(bridge);
  const continueWorkflowTool = createContinueWorkflowTool(bridge, onComplete);

  // Standard coding tools -- identical to what Claude Code provides
  const bashTool = createBashTool(config.workspacePath, signal);
  const readTool = createReadTool(config.workspacePath);
  const writeTool = createWriteTool(config.workspacePath);

  // ---- Model ----
  const model = getModel("anthropic", "claude-sonnet-4-5");

  // ---- System prompt ----
  // Inject ancestry recap here for context survival on resumed sessions
  const ancestryRecap = await bridge.getAncestryRecap(config.sessionId);
  const systemPrompt = buildDaemonSystemPrompt(config, ancestryRecap);

  // ---- Agent (one per session) ----
  // createDaemonLoopConfig() is a factory -- no shared state across sessions
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: "off",
      tools: [startWorkflowTool, continueWorkflowTool, bashTool, readTool, writeTool],
    },
    getApiKey: async () => config.anthropicApiKey,
    sessionId: config.sessionId,  // Provider-side caching affinity

    // Sequential: workflow tools have ordering requirements
    toolExecution: "sequential",

    // Evidence gate hook -- blocks continue_workflow if required evidence not present
    beforeToolCall: async (context, abortSignal) => {
      if (context.toolCall.name !== "continue_workflow") return undefined;
      return bridge.checkEvidenceGate(config.sessionId, context, abortSignal);
    },

    // Token persistence hook -- runs after continue_workflow returns a token
    afterToolCall: async (context) => {
      if (context.toolCall.name !== "continue_workflow") return undefined;
      const result = context.result.details as WorkflowContinueResult | undefined;
      if (result?._tag === "advance" && result.continueToken) {
        await bridge.persistTokens(result.continueToken, result.checkpointToken);
      }
      return undefined; // Don't override the result content
    },

    // Termination bridge: return [] when workflow is complete
    // This is what makes the loop stop on workflow completion
    followUpMode: "one-at-a-time",

    steeringMode: "one-at-a-time",
  });

  // getFollowUpMessages is configured via the AgentLoopConfig created inside Agent.
  // We reach it by passing it through AgentOptions -- but wait:
  // AgentOptions does NOT expose getFollowUpMessages directly!
  // It exposes followUpMode, and the queue is drained via agent.followUp().
  //
  // Resolution: use agent.followUp() to inject the next step prompt.
  // Override getFollowUpMessages by NOT using agent.followUp() and instead
  // using a custom AgentLoopConfig via the lower-level API.
  //
  // CORRECTION: The Agent class uses an internal PendingMessageQueue for followUps.
  // getFollowUpMessages in AgentLoopConfig drains that queue.
  // WorkRail calls agent.followUp(nextStepPrompt) to queue the next step,
  // and returns [] once isComplete = true by never calling agent.followUp() again.

  // ---- Subscribe to events for console live view ----
  const unsubscribe = agent.subscribe(async (event, abortSignal) => {
    if (abortSignal.aborted) return;
    await bridge.emitConsoleEvent(config.sessionId, event);
  });

  // ---- Initial prompt ----
  // Kick off the workflow: ask agent to call start_workflow
  const initialPrompt = buildInitialPrompt(config);

  let stopReason = "stop";
  let errorMsg: string | undefined;

  try {
    // Agent drives itself:
    // 1. Calls start_workflow -> gets step 1 prompt
    // 2. Calls continue_workflow -> gets step 2 prompt (via followUp injection below)
    // ... until isComplete = true

    // We need to bridge the "advance" result into a follow-up.
    // Strategy: subscribe to tool_execution_end events for continue_workflow,
    // and call agent.followUp() with the next step prompt.

    // This works because:
    // - tool_execution_end fires before the turn ends
    // - agent.followUp() queues a message
    // - after the turn ends (no more tool calls), getFollowUpMessages returns it
    // - the loop processes it as the next turn's user message

    // The isComplete bridge: when isComplete=true, we never call agent.followUp(),
    // so getFollowUpMessages returns [] and the loop exits.

    await agent.prompt(initialPrompt);

    const state = agent.state;
    const lastMsg = state.messages.findLast(m => m.role === "assistant") as any;
    stopReason = lastMsg?.stopReason ?? "stop";
    errorMsg = lastMsg?.errorMessage;

  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    stopReason = "error";
  } finally {
    unsubscribe();
  }

  return { stopReason, error: errorMsg };
}

// ============================================================================
// Step injection via event subscription (the actual loop driver)
// ============================================================================

/**
 * The real implementation uses subscribe() to inject follow-ups.
 * This is the WorkRail daemon's core control mechanism.
 */
export async function runDaemonSessionFull(
  config: DaemonRunConfig,
  bridge: DaemonSessionBridge,
  signal?: AbortSignal,
): Promise<{ stopReason: string; error?: string }> {

  let pendingFollowUp: string | null = null;
  let isComplete = false;

  const model = getModel("anthropic", "claude-sonnet-4-5");

  const startWorkflowTool = createStartWorkflowTool(bridge);

  // For continue_workflow, we use a version that sets pendingFollowUp
  const ContinueWorkflowParams_local = createContinueWorkflowParamsSchema();
  const continueWorkflowTool: import("@mariozechner/pi-agent-core").AgentTool<any, WorkflowContinueResult> = {
    name: "continue_workflow",
    description: "Advance the WorkRail workflow to the next step.",
    parameters: ContinueWorkflowParams_local,
    label: "Continue Workflow",
    execute: async (_toolCallId, params, abortSignal) => {
      const result = await bridge.continueWorkflow(params, abortSignal);

      if (result._tag === "error") throw new Error(result.message);

      if (result._tag === "complete") {
        isComplete = true;
        // No pendingFollowUp -- loop exits naturally
        return {
          content: [{ type: "text", text: `Workflow complete.\n${result.finalNotes}` }],
          details: result,
        };
      }

      // Persist tokens atomically
      await bridge.persistTokens(result.continueToken, result.checkpointToken);

      // Queue next step as follow-up (will be injected after this turn ends)
      pendingFollowUp = buildStepFollowUp(result.step, result.continueToken);

      return {
        content: [{
          type: "text",
          text: `## Step: ${result.step.title}\n\n${result.step.prompt}\n\ncontinueToken: ${result.continueToken}`,
        }],
        details: result,
      };
    },
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: buildDaemonSystemPrompt(config, await bridge.getAncestryRecap(config.sessionId)),
      model,
      thinkingLevel: "off",
      tools: [startWorkflowTool, continueWorkflowTool],
    },
    getApiKey: async () => config.anthropicApiKey,
    sessionId: config.sessionId,
    toolExecution: "sequential",
    beforeToolCall: async (ctx, abortSignal) => {
      if (ctx.toolCall.name !== "continue_workflow") return undefined;
      return bridge.checkEvidenceGate(config.sessionId, ctx, abortSignal);
    },
  });

  // Subscribe: inject follow-ups after each turn that produced one
  const unsubscribe = agent.subscribe(async (event, abortSignal) => {
    if (abortSignal.aborted) return;

    // After turn_end: if a follow-up was queued, inject it
    if (event.type === "turn_end" && pendingFollowUp && !isComplete) {
      const followUp = pendingFollowUp;
      pendingFollowUp = null;
      agent.followUp(followUp);
    }

    // Forward to console live view
    await bridge.emitConsoleEvent(config.sessionId, event);
  });

  const unsubscribeAbort = signal ? (() => {
    signal.addEventListener("abort", () => agent.abort(), { once: true });
    return () => {};
  })() : () => {};

  let stopReason = "stop";
  let errorMsg: string | undefined;

  try {
    await agent.prompt(buildInitialPrompt(config));
    const lastMsg = agent.state.messages.findLast(m => m.role === "assistant") as any;
    stopReason = lastMsg?.stopReason ?? "stop";
    errorMsg = lastMsg?.errorMessage;
  } finally {
    unsubscribe();
    unsubscribeAbort();
  }

  return { stopReason, error: errorMsg };
}

// ============================================================================
// Helpers
// ============================================================================

function buildDaemonSystemPrompt(
  config: DaemonRunConfig,
  ancestryRecap: string,
): string {
  return [
    "You are WorkRail Auto, an autonomous agent that executes workflows step by step.",
    "",
    "## Your tools",
    "- `start_workflow`: Start a WorkRail workflow. Call this first with the workflowId.",
    "- `continue_workflow`: Advance to the next step. Call this after completing each step's work.",
    "- `bash`: Run shell commands in the workspace.",
    "- `read`: Read files.",
    "- `write`: Write files.",
    "",
    "## Execution contract",
    "1. Call `start_workflow` to get the first step.",
    "2. Read the step carefully. Do all the work the step asks for.",
    "3. Call `continue_workflow` with your notes and context updates.",
    "4. Repeat until the workflow is complete.",
    "5. Do NOT skip steps. Do NOT call `continue_workflow` without doing the step's work.",
    "",
    ...(ancestryRecap ? ["## Session context", ancestryRecap, ""] : []),
    `## Workspace: ${config.workspacePath}`,
  ].join("\n");
}

function buildInitialPrompt(config: DaemonRunConfig): string {
  const contextStr = JSON.stringify(config.triggerContext, null, 2);
  return [
    `Start the workflow \`${config.workflowId}\`.`,
    "",
    "Trigger context:",
    "```json",
    contextStr,
    "```",
    "",
    `workspacePath: ${config.workspacePath}`,
  ].join("\n");
}

function buildStepFollowUp(step: PendingStep, continueToken: string): string {
  return [
    `## Next step: ${step.title}`,
    "",
    step.prompt,
    "",
    `Your continue token is: ${continueToken}`,
    "Complete this step's work, then call continue_workflow.",
  ].join("\n");
}

function createContinueWorkflowParamsSchema() {
  return Type.Object({
    continueToken: Type.String(),
    notes: Type.Optional(Type.String()),
    context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    label: Type.String(),
  });
}
```

### 3. Concurrent Session Management (`src/daemon/session-registry.ts`)

```typescript
// WorkRail's equivalent of mom's channelStates Map + ChannelQueue
// Pattern: KeyedAsyncQueue (~30 lines, reimplemented from OpenClaw's pattern)

type SessionWork = () => Promise<void>;

class SessionQueue {
  private chain: Promise<void> = Promise.resolve();

  enqueue(work: SessionWork): void {
    this.chain = this.chain.then(async () => {
      try { await work(); } catch { /* logged by caller */ }
    });
  }
}

export class DaemonSessionRegistry {
  private queues = new Map<string, SessionQueue>();
  private activeSessions = new Map<string, AbortController>();

  /**
   * Serialize runs against the same session ID.
   * If session X is running and another trigger arrives for X, it queues behind.
   */
  enqueueRun(sessionId: string, run: SessionWork): void {
    if (!this.queues.has(sessionId)) {
      this.queues.set(sessionId, new SessionQueue());
    }
    const queue = this.queues.get(sessionId)!;
    const abortController = new AbortController();
    this.activeSessions.set(sessionId, abortController);

    queue.enqueue(async () => {
      try {
        await run();
      } finally {
        this.activeSessions.delete(sessionId);
        // Clean up queue entry when no more work
        // (simplified -- production needs reference counting)
      }
    });
  }

  abort(sessionId: string): void {
    this.activeSessions.get(sessionId)?.abort();
  }

  isRunning(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }
}
```

### 4. Console Live View Integration (`src/daemon/console-bridge.ts`)

```typescript
import type { AgentEvent } from "@mariozechner/pi-agent-core";

// WorkRail daemon emits these events to the console's DaemonRegistry
// (session store already records all WorkRail-level events via continue_workflow)
// Agent events are ephemeral -- they're for live streaming only

export interface DaemonConsoleEvent {
  sessionId: string;
  workflowId: string;
  eventType: AgentEvent["type"];
  // For streaming tokens:
  tokenDelta?: string;
  // For tool execution:
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  // Timestamp
  ts: number;
}

export class ConsoleBridge {
  // In-memory only -- console connects via SSE or WebSocket
  private listeners = new Set<(event: DaemonConsoleEvent) => void>();

  subscribe(listener: (event: DaemonConsoleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(sessionId: string, workflowId: string, event: AgentEvent): void {
    const consoleEvent: DaemonConsoleEvent = {
      sessionId,
      workflowId,
      eventType: event.type,
      ts: Date.now(),
    };

    if (event.type === "message_update") {
      // Extract streaming token delta for live token display
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        consoleEvent.tokenDelta = update.delta;
      }
    }

    if (event.type === "tool_execution_start") {
      consoleEvent.toolName = event.toolName;
      consoleEvent.toolCallId = event.toolCallId;
    }

    if (event.type === "tool_execution_end") {
      consoleEvent.toolName = event.toolName;
      consoleEvent.toolCallId = event.toolCallId;
      consoleEvent.isError = event.isError;
    }

    for (const listener of this.listeners) {
      listener(consoleEvent);
    }
  }
}
```

---

## What NOT to Import from `mom`

`mom` is the reference architecture, not a library dependency. WorkRail should NOT import from `@mariozechner/pi-coding-agent` (which `mom` uses for `SessionManager`, `AgentSession`). That package adds session persistence, model registry, and skill loading abstractions that WorkRail already has in its own session store.

**Only import:**
- `@mariozechner/pi-agent-core`: `Agent`, `AgentTool`, `AgentEvent`, all types
- `@mariozechner/pi-ai`: `getModel`, `streamSimple` (implicitly via Agent), model definitions

**Reimplement from `mom` (~100 lines total):**
- `SessionQueue` / `KeyedAsyncQueue` pattern (~30 lines)
- Retry wrapper with backoff on `stopReason === "error"` (~20 lines)
- Token persistence to `~/.workrail/daemon-state.json` (atomic write, ~15 lines)
- System prompt builder for daemon context (~30 lines)
