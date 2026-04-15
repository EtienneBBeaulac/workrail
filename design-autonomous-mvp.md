# WorkRail Autonomous MVP -- Design Document

## Final Summary (TL;DR)

**Selected path:** full_spectrum (landscape + problem reframe)
**Chosen direction:** Candidate 1 -- Minimal Loop on Engine API
**Why it won:** `src/engine/engine-factory.ts` already exists and implements the exact seam needed. The daemon is 145 lines calling `createWorkRailEngine()` + a loop. The engine's own docstring describes this as the 'bot-as-orchestrator' use case.
**Runner-up:** Candidate 2 (callbacks) -- structurally identical after the StepOutput fix; only cosmetic naming difference.
**Confidence:** High.
**One residual risk:** LLM notes quality on `pending.prompt` without IDE tool access. Only empirical evidence resolves this. Mitigation: author `workflows/wr.autonomous-demo.json` with reasoning-only steps.

**Key files to read:**
- `src/engine/engine-factory.ts` -- the seam the daemon uses
- `src/engine/types.ts` -- the WorkRailEngine API
- `design-autonomous-mvp.md` -- this document (full design)
- `design-candidates-autonomous-mvp.md` -- candidates with full specs
- `design-review-findings-autonomous-mvp.md` -- RED/ORANGE/YELLOW findings

**Next actions (in order):**
1. Create GitHub issue: 'feat(engine): autonomous workflow daemon -- runWorkflow() entry point'
2. Author `workflows/wr.autonomous-demo.json` (3-4 reasoning-only steps)
3. Implement `src/daemon/` (145 lines, 4 files per the design)
4. Write vitest test with FakeLlmDriver (scripted notes, no API key)
5. Run the daemon against `wr.autonomous-demo.json` with a real API key -- evaluate notes quality

---

## Artifact Strategy

This document is a **human-readable artifact** -- it exists for readability and review. It is NOT the execution truth for this workflow. The durable execution truth lives in WorkRail's notes and context variables, which survive chat rewinds. If this file and the workflow notes ever conflict, the notes win.

- Read this document to understand the design rationale, file structure, and interfaces.
- Do NOT read this document to determine the workflow's current execution state.

Capabilities confirmed during this session:
- **Delegation (subagent):** Available via `mcp__nested-subagent__Task`
- **Web browsing:** Available via `WebFetch` (probed successfully against example.com)

Neither was needed for this design task -- the codebase and GitHub API provided all necessary source material. Both capabilities are noted for future steps if parallel cognitive perspectives are needed.

---

## Context / Ask

WorkRail today is a workflow execution engine exposed via MCP. A human agent (Claude Code, Claude desktop, etc.) drives it step by step: the LLM calls `start_workflow`, reads the step prompt, does the work, then calls `continue_workflow`. The engine is durable and event-sourced, but the driving intelligence is always a human-in-the-loop IDE session.

The ask: design the smallest thing that proves WorkRail can run workflows autonomously. A daemon receives a trigger `{ workflowId, goal, context }`, calls the Anthropic API directly, drives the existing session engine step by step, and reports completion -- no IDE, no human, no Claude Code harness.

## Path Recommendation

**full_spectrum** -- the dominant risk is both (a) not understanding the existing engine surface deeply enough to identify the seam, and (b) proposing the wrong concept if we skip landscape grounding. A narrow `design_first` path would miss implementation constraints; a narrow `landscape_first` path would miss the reframing needed to go from MCP-driven to daemon-driven.

Rationale over the other two:
- `landscape_first` alone: we know the landscape (WorkRail v2 engine, pi-mono agentLoop) -- additional landscape survey would not answer the real question of "what is the minimal seam?"
- `design_first` alone: the existing engine has very specific token and lock semantics that constrain the design. We need the landscape grounded first, then reframed.

## Constraints / Anti-goals

**Constraints:**
- Must reuse `executeStartWorkflow` and `handleAdvanceIntent` (or their underlying `loadAndPinWorkflow` / `advanceAndRecord` core) unmodified
- Must not require a running MCP server -- daemon talks to Anthropic SDK directly
- TypeScript, ES modules, `neverthrow` Result types throughout
- Single entry point: one function `runWorkflow(trigger)` that is awaitable
- Must work with WorkRail's existing durable event log and token system

**Anti-goals:**
- NOT a replacement for the MCP server -- both coexist
- NOT a general-purpose agent framework -- WorkRail's step structure is the scaffold
- NOT streaming UX -- MVP produces a completion report, no live event UI
- NOT multi-workflow concurrency -- single workflow run, sequential steps
- NOT a new storage layer -- reuse `LocalSessionEventLogStoreV2`, `LocalPinnedWorkflowStoreV2`, etc.

## Landscape Packet

### WorkRail v2 Engine Surface

Reading `src/mcp/handlers/v2-execution/start.ts` and `continue-advance.ts`:

The engine exposes two composable operations:

**1. `loadAndPinWorkflow` + `buildInitialEvents` + `mintStartTokens`**
Together these implement `start_workflow`. They:
- Load and validate the workflow definition
- Hash and pin it to `LocalPinnedWorkflowStoreV2` (content-addressed)
- Append session-created / run-started / node-created events to the event log
- Render the first step's prompt via `renderPendingPrompt`
- Return a `continueToken` + first step content

**2. `handleAdvanceIntent`**
Implements `continue_workflow` with `intent: "advance"`. It:
- Decodes the `continueToken` to recover `(sessionId, runId, nodeId, attemptId, workflowHashRef)`
- Acquires a session lock
- Calls `advanceAndRecord` which runs the engine state machine one step
- Appends an `advance_recorded` event
- Renders the next step's prompt (or `isComplete: true`)
- Returns a new `continueToken` for the next step

The engine state machine lives in `src/v2/durable-core/`. It is purely functional: given a snapshot + events, it returns the next state. All I/O is behind ports (`SessionEventLogStorePortV2`, `SnapshotStorePortV2`, etc.) registered in `src/di/container.ts`.

**Key seam:** The daemon only needs to call `executeStartWorkflow` once, then call `executeContinueWorkflow` (the handler that routes to `handleAdvanceIntent`) in a loop until `isComplete: true`. The MCP handler formatting layer is noise -- the daemon can bypass it and work with the raw `z.infer<typeof V2StartWorkflowOutputSchema>` / `V2ContinueWorkflowOutputSchema` directly.

### pi-mono agentLoop Pattern

Reading `packages/agent/src/agent-loop.ts`:

The `runLoop` function is the core pattern:
1. Build an `AgentContext` with `{ systemPrompt, messages, tools }`
2. Call `streamAssistantResponse` -- converts `AgentMessage[]` to LLM `Message[]`, calls provider
3. If the response has `toolCalls`, execute them and push results back to context
4. Repeat until no tool calls remain
5. Check for follow-up / steering messages, loop outer

Key insight for WorkRail: the "tool" is `continue_workflow`. Each step, the LLM sees the step prompt and calls `continue_workflow` exactly once (with notes + optional context). The "tool result" is the next step prompt. The loop terminates when `isComplete: true`.

This maps cleanly:
- `systemPrompt` = WorkRail daemon identity + instructions
- User message per turn = the rendered step prompt from WorkRail
- The LLM's response = the notes/output it produces
- "Tool call" = calling `continue_workflow` internally (not via MCP -- directly via engine function)
- Tool result = next step rendered prompt

### CRITICAL FINDING: engine-factory.ts Already Exists

`src/engine/engine-factory.ts` already implements the exact seam described in Direction A. It:
- Calls `initializeContainer({ runtimeMode: { kind: 'library' } })` (no signal handlers, no HTTP)
- Assembles `V2Dependencies` by resolving all DI tokens
- Initializes the keyring (handles `loadOrCreate()`)
- Loads the token alias index
- Returns a `WorkRailEngine` with `startWorkflow` and `continueWorkflow` methods
- Has a `close()` method that resets the container

`src/engine/types.ts` defines `WorkRailEngine`, `StepResponse`, `PendingStep`, `EngineResult`, `EngineError`, `StateToken`, `AckToken`, `CheckpointToken`.

The `WorkRailEngine.continueWorkflow` signature: `(stateToken, ackToken, output?, context?)` -- where `ackToken` present means advance, `null` means rehydrate. `pending.prompt` is the step's rendered text. `isComplete` signals termination.

**This completely revises the daemon design.** The daemon loop becomes:

```
createWorkRailEngine() -> engine.startWorkflow() -> loop: LLM(step.prompt) -> engine.continueWorkflow(stateToken, ackToken, { notesMarkdown }) until isComplete
```

Total new code drops from ~240 lines to ~150 lines (no tool-context-factory, no token codec assembly).

### OpenClaw task-executor Pattern

`src/tasks/task-executor.ts` shows a task-queue model: `createQueuedTaskRun` -> `createRunningTaskRun` -> terminal. It uses flows and delivery-status tracking. The session store pattern (in-memory, keyed by sessionId, with idle TTL reaping) is relevant for how to manage daemon-side state.

Key takeaway: OpenClaw treats task lifecycle as an explicit state machine with queued -> running -> terminal. WorkRail's daemon should do the same: not a fire-and-forget coroutine but a named lifecycle with observable status.

## Problem Frame Packet

### Users / Stakeholders

- **Primary:** WorkRail developer/maintainer (Etienne) -- wants to prove the autonomous thesis and open a path to the next major feature area
- **Secondary:** Future open-source contributors -- need a clean, minimal entry point to build on (webhooks, job queues, scheduled runners)
- **Tertiary:** Teams running WorkRail workflows that want to automate repetitive multi-step tasks without a developer in the loop

### Jobs / Outcomes

The job is not "run an LLM." The job is: **execute a structured plan (workflow) to completion, durably, without a human watching.** The outcome is: a completed session in WorkRail's event log, with full notes at each step, replayable, auditable.

### Pains / Tensions

1. **Tension: minimal vs. general.** The daemon should be the smallest thing that proves the thesis. But it will immediately attract scope creep: retry logic, streaming, progress webhooks, multi-workflow concurrency. The design must name what is out of scope or it will bloat before it ships.

2. **Tension: engine-factory reuse vs. wrapper overhead.** `createWorkRailEngine` already exists but uses a backward-compatibility API (`StateToken`/`AckToken` double-token pattern on the caller side). The daemon can use it directly -- which is correct -- but should not be confused by the two-token appearance; internally both map to `continueToken`.

3. **Tension: step prompt richness vs. LLM capability.** WorkRail's `pending.prompt` is designed to be read by a human-IDE agent with codebase context. For autonomous execution, the LLM must act on the prompt alone, without IDE tools (no `Read`, `Edit`, `Bash`). Steps that require actual file I/O or code execution will block. The daemon MVP must either: (a) skip tool use entirely (notes-only workflows), or (b) include a tool-use layer. The MVP should be (a).

4. **Pain: blocked steps.** `StepResponse` has `kind: 'blocked'` with blockers like `USER_ONLY_DEPENDENCY`. The daemon must handle this gracefully -- report it as a typed outcome, not crash.

### Constraints That Matter in Lived Use

- **One engine per process.** `engine-factory.ts` enforces a singleton guard. The daemon cannot create two engines; it must call `close()` before reinitializing.
- **ANTHROPIC_API_KEY must be in environment or passed explicitly.** The Anthropic SDK fails immediately without it -- not a graceful error.
- **`pending.prompt` is the complete rendered step text.** No additional context injection needed from the daemon side for notes-only workflows.
- **Notes are required.** `continueWorkflow` with an empty or missing `notesMarkdown` will produce a blocker (`MISSING_REQUIRED_NOTES`). The LLM must always produce substantive notes.

### Success Criteria

1. `runWorkflow({ workflowId: 'wr.discovery', goal: '...', anthropicApiKey: '...' })` completes without throwing, returns `{ kind: 'completed', stepCount: N, sessionId: '...' }`
2. The WorkRail dashboard shows a full session with notes at every step
3. No new files or directories required outside `src/daemon/`
4. No modifications to `src/engine/`, `src/mcp/`, or `src/v2/`
5. A test workflow with notes-only steps (no tool use) runs autonomously end-to-end

### Assumptions (not yet facts)

- `pending.prompt` is sufficient for the LLM to produce useful notes without codebase tool access (ASSUMPTION -- needs a proof run)
- The Anthropic SDK's `messages.create` with a single user message is enough (no multi-turn history needed per step -- each step is self-contained)
- WorkRail's `autonomy: 'full_auto_never_stop'` preference does not change step rendering (check: does the prompt change based on autonomy setting?)

### Reframes / HMW Questions

**Reframe 1: The workflow IS the system prompt.** Each step's `prompt` field is already the instruction. The LLM doesn't need elaborate system prompt engineering -- WorkRail already encodes what to do. The daemon's job is translation, not orchestration.

**Reframe 2: The daemon is a proof of concept for WorkRail-as-agent-OS.** If a workflow can run with just `pending.prompt -> LLM -> notes`, then any structured plan encoded in WorkRail becomes executable autonomously. The daemon is not a product feature -- it is a thesis proof.

**HMW 1:** How might we make the daemon handle tool-using steps (Read, Edit, Bash) without importing the full Claude Code harness? (Answer: inject a minimal tool executor as a parameter -- out of scope for MVP.)

**HMW 2:** How might we make blocked steps (USER_ONLY_DEPENDENCY) recoverable in a daemon context? (Answer: surface them as a typed `CompletionReport` variant -- the caller decides what to do.)

### Framing Risks (what could still be wrong)

1. **Risk:** `pending.prompt` may reference prior context, session history, or workspace anchors that the LLM cannot act on without tool access. If so, the MVP proof only works for a subset of workflows.
2. **Risk:** The daemon's single-message-per-step pattern may produce worse notes than a multi-turn conversation. If step prompts are long and complex, the LLM may truncate or miss requirements.
3. **Risk:** The `engine-factory.ts` singleton guard (`engineActive`) may block concurrent test execution. The daemon needs to handle the `precondition_failed: An engine is already active` error case.

### The Real Problem (revised)

WorkRail's engine is already autonomous-ready: `engine-factory.ts` implements the in-process library seam. The only thing missing is a caller that holds Anthropic API credentials and runs the loop. The daemon is that caller -- 150 lines of new code on top of an existing foundation.

### Reframe (revised)

Don't build a "new agent runtime." Don't even build `buildV2ToolContext`. Build a **WorkRail session driver** that calls `createWorkRailEngine()`, loops `continueWorkflow()` with Anthropic-generated notes, and stops on `isComplete`. The Anthropic SDK is the transport. The workflow definition is the plan. WorkRail is the runtime.

## Candidate Generation Expectations

**Path:** full_spectrum -- candidates must reflect BOTH landscape truth (existing engine-factory.ts seam, WorkRailEngine API) AND problem frame truth (thesis proof, notes-only MVP, no tool execution).

**Bias to avoid:** Candidates should NOT drift into "build a new agent framework" territory. The landscape clearly shows the engine seam exists. Candidates that ignore `createWorkRailEngine()` and propose raw DI assembly or new storage layers are anti-patterns.

**Required candidate spread:**
1. One direction that is the most literal reuse of the existing engine seam (minimal wrapper)
2. One direction that adds one meaningful extra layer (e.g., tool execution stub, or workflow-aware system prompt engineering)
3. One direction that reframes the problem -- e.g., the daemon is not a standalone binary but an embedded SDK function that callers inject into their own agent loops

**What a good candidate must include:**
- Explicit file structure (which files are new, which are reused)
- The core loop in pseudocode (start -> LLM -> advance -> repeat)
- How blocked steps are handled
- What `pending.prompt` provides and what the daemon adds

## Candidate Directions

### Candidate 1: Minimal Loop on Engine API (Recommended)

**Summary:** A single `runWorkflow(trigger, llmDriver)` function in `src/daemon/run-workflow.ts` that calls `createWorkRailEngine()` and drives the loop. No new infrastructure; no modifications to existing code.

**Shape:**
```
src/daemon/
  types.ts         -- WorkflowTrigger (readonly), CompletionReport (discriminated union), LlmDriver (interface)
  llm-driver.ts    -- createAnthropicDriver(apiKey, model): LlmDriver  [~40 lines]
  run-workflow.ts  -- runWorkflow(trigger, llmDriver?): Promise<CompletionReport>  [~80 lines]
  index.ts         -- re-exports  [5 lines]
```

**Core loop:**
```typescript
const engineResult = await createWorkRailEngine({ dataDir: trigger.dataDir });
if (!engineResult.ok) return { kind: 'failed', reason: engineResult.error.message };
const engine = engineResult.value;
try {
  const startResult = await engine.startWorkflow(trigger.workflowId, trigger.goal);
  if (!startResult.ok) return { kind: 'failed', reason: startResult.error.message };
  let current = startResult.value;
  let stepCount = 0;
  while (!current.isComplete) {
    if (stepCount >= (trigger.maxSteps ?? 50)) return { kind: 'max_steps_reached', stepCount };
    if (current.kind === 'blocked') return { kind: 'blocked', blockers: current.blockers, stepCount };
    const notes = await llmDriver.callStep(systemPrompt(trigger.goal), current.pending!.prompt);
    const cont = await engine.continueWorkflow(current.stateToken, current.ackToken, { notesMarkdown: notes });
    if (!cont.ok) return { kind: 'failed', reason: cont.error.message, stepCount };
    current = cont.value;
    stepCount++;
  }
  return { kind: 'completed', stepCount };
} finally {
  await engine.close();
}
```

**CompletionReport type:**
```typescript
export type CompletionReport =
  | { readonly kind: 'completed';          readonly stepCount: number }
  | { readonly kind: 'failed';             readonly reason: string;   readonly stepCount?: number }
  | { readonly kind: 'blocked';            readonly blockers: readonly Blocker[]; readonly stepCount: number }
  | { readonly kind: 'max_steps_reached';  readonly stepCount: number };
```

**LlmDriver interface:**
```typescript
export interface LlmDriver {
  callStep(systemPrompt: string, stepPrompt: string): Promise<string>;
}
```

**Tensions resolved:** errors-as-data (EngineResult mapped to CompletionReport), exhaustiveness (all StepResponse variants handled), LlmDriver injected (testable), resource cleanup (try/finally).

**Tensions accepted:** notes-only (no tool execution in LlmDriver.callStep); single-message-per-step (no conversation accumulation -- WorkRail's ancestry recap compensates).

**Boundary:** `src/daemon/` -- caller of `src/engine/`, zero modifications to engine/mcp/v2.

**Failure mode to watch:** `engine.close()` called even when Anthropic API call throws. The `try/finally` pattern handles this, but if `createWorkRailEngine()` fails, `close()` must NOT be called (the engine was never created). The code above guards this correctly by returning early on `!engineResult.ok`.

**Relation to repo patterns:** Follows `engine-factory.ts` exactly -- same `EngineResult` pattern, same `try/close()` discipline. Adapts the `EngineResult` -> `CompletionReport` mapping from `mapStartError`/`mapContinueError` already in `engine-factory.ts`.

**Gain:** 125 lines total, fully testable, no new dependencies beyond `@anthropic-ai/sdk` (already a peer dep candidate).
**Give up:** No tool execution, no streaming, no retry logic -- all explicitly deferred.

**Impact surface:** None beyond `src/daemon/`. No callers of existing engine API change.

**Scope judgment:** Best-fit. Concrete evidence: `engine-factory.ts` already exists. The daemon is literally just a loop around `WorkRailEngine`.

**Philosophy honored:** errors-as-data, exhaustiveness, immutability, DI for boundaries, YAGNI.
**Philosophy conflicts:** None.

---

### Candidate 2: Callback-Based Embedded SDK Function

**Summary:** Instead of a standalone `runWorkflow()` that hardcodes the LLM call, expose a `driveWorkflow(trigger, callbacks)` function where the caller provides `onStep(prompt) -> notes` -- making WorkRail's autonomous runtime an embeddable SDK primitive, not a CLI.

**Shape:**
```
src/daemon/
  types.ts           -- WorkflowTrigger, CompletionReport, WorkflowCallbacks (interface)
  drive-workflow.ts  -- driveWorkflow(trigger, callbacks): Promise<CompletionReport>  [~70 lines]
  index.ts           -- re-exports (no LLM driver -- caller provides their own)
```

**WorkflowCallbacks interface:**
```typescript
export interface WorkflowCallbacks {
  /** Called for each step. Return notes to advance. */
  onStep(stepId: string, prompt: string, stepCount: number): Promise<string>;
  /** Optional: called when a step is blocked. Return true to continue (skip), false to abort. */
  onBlocked?(blockers: readonly Blocker[], stepCount: number): Promise<boolean>;
}
```

**Core difference from Candidate 1:** The LLM driver is not built into the daemon. The caller provides the step executor. This makes `driveWorkflow` a generic workflow automation primitive -- callers can plug in Anthropic, OpenAI, a local model, a human, or a test harness.

**Tensions resolved:** Same as Candidate 1 for errors/exhaustiveness/cleanup. Additionally resolves the tool-use tension: `onStep` can call any tools the caller has available (Read, Edit, Bash) -- the daemon doesn't constrain it.

**Tensions accepted:** More complex public API (caller must implement `onStep`). Harder to use as a CLI binary (requires a callback, not just env vars).

**Failure mode to watch:** If `onStep` throws, the `try/finally` block must still call `engine.close()`. The implementation must wrap `callbacks.onStep` in a try/catch that returns a `CompletionReport.failed` without re-throwing.

**Relation to repo patterns:** Departs slightly from `engine-factory.ts` -- that file is a factory, not a driver. Adapts the callback injection pattern seen in `agentLoop`'s `emit` parameter (pi-mono).

**Gain:** No Anthropic dependency in the daemon library. `driveWorkflow` is truly generic -- any step executor. Future-proof for Phase 2 tool use without changing the API.
**Give up:** More complex to use from a CLI. Callers must implement `onStep` rather than just passing an API key. The Anthropic convenience wrapper must be a separate package or example file.

**Impact surface:** Same as Candidate 1 -- zero modifications to engine/mcp/v2.

**Scope judgment:** Slightly too broad for MVP. The callback API is a better eventual shape but adds API surface. For a thesis proof, Candidate 1 is simpler and the callback API can be added in Phase 2 (Candidate 1 already injects `LlmDriver`, which is effectively the same seam with a different name).

**Philosophy honored:** DI for boundaries (no hardcoded LLM), YAGNI (no Anthropic dep in library), errors-as-data.
**Philosophy conflicts:** Adds speculative abstraction (`onBlocked` callback) that the MVP doesn't need.

---

### Candidate 3: MCP Subprocess Driver

**Summary:** Run the existing MCP server as a child process (stdio transport) and drive it via the MCP client SDK, exactly as Claude Code does -- the daemon is a hardcoded MCP client with no engine code changes.

**Shape:**
```
src/daemon/
  types.ts              -- WorkflowTrigger, CompletionReport
  mcp-client-driver.ts  -- startMcpServer(), callTool('start_workflow'), callTool('continue_workflow')
  run-workflow.ts       -- loop using MCP client calls
  index.ts              -- re-exports
```

**Core loop:**
```typescript
const server = await spawnMcpServer();  // child_process.spawn('node', ['dist/mcp/server.js'])
const client = new McpClient({ transport: new StdioClientTransport(server) });
const start = await client.callTool('start_workflow', { workflowId, goal, workspacePath });
// ... parse continueToken from response, loop callTool('continue_workflow', ...)
```

**Tensions resolved:** Zero engine code changes. Full MCP protocol compliance. The daemon is literally a MCP client, identical to how Claude Code uses WorkRail.

**Tensions accepted:** Subprocess management complexity (process lifecycle, stdout/stderr buffering, EPIPE). MCP JSON-RPC overhead on every step. The daemon depends on the MCP server binary being built and reachable. Server startup latency on every `runWorkflow()` call.

**Failure mode to watch:** AGENTS.md explicitly notes 'The MCP SDK does not handle stdout EPIPE errors -- a broken pipe kills the server process.' Using stdio transport for the daemon creates the same EPIPE risk. HTTP transport would require the server to already be running (external dependency).

**Relation to repo patterns:** Departs from the engine-factory pattern entirely. Is a valid architecture but contradicts the landscape finding: `createWorkRailEngine()` already exists precisely to avoid MCP transport overhead.

**Gain:** Zero engine modifications. Reuses full MCP protocol surface including tool schema validation, error formatting, etc.
**Give up:** Subprocess complexity, EPIPE risk, startup latency, MCP JSON parsing overhead. The daemon is not a library -- it's a process launcher.

**Impact surface:** Requires the built MCP server binary to exist at a known path. Adds a runtime dependency on the build output.

**Scope judgment:** Too broad for MVP. Concrete evidence: `engine-factory.ts` exists specifically to avoid this pattern. The AGENTS.md documents the EPIPE risk explicitly.

**Philosophy honored:** Architectural clarity (clean client/server separation).
**Philosophy conflicts:** YAGNI (subprocess management when a direct function call exists). Determinism (process lifecycle adds non-determinism).

## Resolution Notes

**Design is complete. Recommendation: Candidate 1 (Minimal Loop on Engine API) with required fixes applied.**

### Revised design after full review cycle

**Revised line count: ~145 lines** across 4 files (types.ts ~40, llm-driver.ts ~45, run-workflow.ts ~55, index.ts ~5).

**Key revisions from the review cycle:**
1. `LlmDriver.callStep` returns `StepOutput { notesMarkdown, context?, artifacts? }` (not `string`) -- preserves Phase 2 context/artifacts path
2. `driver.callStep()` wrapped in try/catch -- converts Anthropic SDK throws to `CompletionReport.failed` (required: 'errors are data')
3. `anthropicApiKey` boundary validation before engine creation
4. `wr.autonomous-demo.json` is a prerequisite (reasoning-only workflow needed for thesis proof)

### Final `runWorkflow` shape

```typescript
// src/daemon/types.ts
export interface WorkflowTrigger {
  readonly workflowId: string;
  readonly goal: string;
  readonly workspacePath?: string;
  readonly dataDir?: string;
  readonly anthropicApiKey?: string;  // required if no llmDriver provided
  readonly model?: string;            // default: latest claude-sonnet
  readonly maxSteps?: number;         // default: 50
}

export interface StepOutput {
  readonly notesMarkdown: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly unknown[];
}

export interface LlmDriver {
  callStep(systemPrompt: string, stepPrompt: string): Promise<StepOutput>;
}

export type CompletionReport =
  | { readonly kind: 'completed';         readonly stepCount: number }
  | { readonly kind: 'failed';            readonly reason: string;  readonly stepCount?: number }
  | { readonly kind: 'blocked';           readonly blockers: readonly { readonly code: string; readonly message: string }[]; readonly stepCount: number }
  | { readonly kind: 'max_steps_reached'; readonly stepCount: number };
```

```typescript
// src/daemon/run-workflow.ts (final shape)
export async function runWorkflow(
  trigger: WorkflowTrigger,
  llmDriver?: LlmDriver,
): Promise<CompletionReport> {
  // Validate at boundary
  if (!llmDriver && !trigger.anthropicApiKey) {
    return { kind: 'failed', reason: 'anthropicApiKey is required when no llmDriver is provided' };
  }
  const driver = llmDriver ?? createAnthropicDriver(trigger.anthropicApiKey!, trigger.model);

  const engineResult = await createWorkRailEngine({ dataDir: trigger.dataDir });
  if (!engineResult.ok) return { kind: 'failed', reason: engineResult.error.message };

  const engine = engineResult.value;
  try {
    const startResult = await engine.startWorkflow(trigger.workflowId, trigger.goal);
    if (!startResult.ok) return { kind: 'failed', reason: startResult.error.message, stepCount: 0 };

    let current = startResult.value;
    let stepCount = 0;
    const sysPrompt = `You are an autonomous WorkRail workflow executor. Goal: ${trigger.goal}\n\nRead each step's instructions. Perform the requested analysis or reasoning. Write detailed, specific notes -- the durable log depends on them.`;

    while (!current.isComplete) {
      if (stepCount >= (trigger.maxSteps ?? 50)) return { kind: 'max_steps_reached', stepCount };
      if (current.kind === 'blocked') return { kind: 'blocked', blockers: current.blockers, stepCount };
      if (!current.pending || !current.ackToken) {
        return { kind: 'failed', reason: 'Engine returned no pending step or ackToken', stepCount };
      }

      // Wrap callStep -- Anthropic SDK throws on network/auth errors
      let stepOutput: StepOutput;
      try {
        stepOutput = await driver.callStep(sysPrompt, current.pending.prompt);
      } catch (err) {
        return { kind: 'failed', reason: err instanceof Error ? err.message : String(err), stepCount };
      }

      const cont = await engine.continueWorkflow(
        current.stateToken,
        current.ackToken,
        {
          notesMarkdown: stepOutput.notesMarkdown,
          ...(stepOutput.artifacts?.length ? { artifacts: [...stepOutput.artifacts] } : {}),
        },
        stepOutput.context,
      );
      if (!cont.ok) return { kind: 'failed', reason: cont.error.message, stepCount };
      current = cont.value;
      stepCount++;
    }

    return { kind: 'completed', stepCount };
  } finally {
    await engine.close();
  }
}
```

### Build vs. reuse summary

| Piece | Source | Notes |
|-------|--------|-------|
| `createWorkRailEngine()` | REUSE | `src/engine/engine-factory.ts` -- the exact seam, already exists |
| `WorkRailEngine` loop API | REUSE | `src/engine/types.ts` |
| `src/daemon/types.ts` | BUILD NEW | ~40 lines -- WorkflowTrigger, StepOutput, LlmDriver, CompletionReport |
| `src/daemon/llm-driver.ts` | BUILD NEW | ~45 lines -- createAnthropicDriver factory |
| `src/daemon/run-workflow.ts` | BUILD NEW | ~55 lines -- the core loop |
| `src/daemon/index.ts` | BUILD NEW | ~5 lines -- re-exports |
| `workflows/wr.autonomous-demo.json` | BUILD NEW | prerequisite reasoning-only workflow |
| pi-mono agentLoop | INSPIRATION ONLY | loop structure derived from it; not imported |
| OpenClaw session store | INSPIRATION ONLY | lifecycle state pattern noted; not imported |

**Total new code: ~145 lines.** The daemon is a thin caller of an engine that was already designed for this use case.

### Why NOT to import pi-mono

WorkRail's step structure is the scaffold. The LLM's job is not 'decide what tools to call' but 'execute this step's instructions and produce notes.' pi-mono's EventStream, AgentContext, and provider registry are all unnecessary when the workflow definition is already the plan.

### Why NOT to import OpenClaw

OpenClaw's task executor manages distributed task delivery across multiple runtimes. WorkRail's event log already provides durable state. The daemon runs a single workflow per invocation.

### Confidence and residual risks

**Confidence: high.** Design is grounded in existing `engine-factory.ts` and `WorkRailEngine` API -- a seam the engine's own docstring describes as the 'bot-as-orchestrator' use case.

**Residual risk (1): prototype-learning uncertainty.** Notes quality on `pending.prompt` without IDE tool access is unknown until a real daemon run. Only empirical evidence resolves this.

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Use `createWorkRailEngine()` not raw DI | engine-factory.ts already implements the seam; don't reinvent |
| Bypass MCP transport | Avoids subprocess overhead and EPIPE risk (AGENTS.md explicit warning) |
| Do not import pi-mono | WorkRail step structure supersedes general tool-call loop; ancestry recap provides cross-step context |
| Do not import OpenClaw | Single-workflow daemon; WorkRail event log provides durability |
| `LlmDriver` interface injected | 'DI for boundaries' philosophy; enables unit testing without real API key |
| `StepOutput` return type (not `string`) | Preserves Phase 2 context/artifacts path at 4-line cost; avoids future API break |
| try/catch around `driver.callStep()` | 'Errors are data' -- Anthropic SDK throws must be caught and mapped to `CompletionReport.failed` |
| `CompletionReport` discriminated union (4 variants) | 'Exhaustiveness everywhere' -- all outcomes typed |
| `wr.autonomous-demo.json` as prerequisite | Existing bundled workflows assume IDE tool access; daemon MVP needs reasoning-only workflow |
| Candidate 1 over Candidate 2 | Same seam after StepOutput adoption; Candidate 1 ships Anthropic adapter as default (usable out of box) |
| Candidate 3 eliminated | EPIPE risk, subprocess overhead, contradicts engine-factory.ts existence |

---

## [SUPERSEDED] Initial Design Sketch

> The following section was the initial design produced before discovering `engine-factory.ts`. It is kept for historical context. The Resolution Notes and Decision Log above reflect the final, corrected design.

## Final Design: Minimal Daemon Runtime

### File Structure

```
src/daemon/
  index.ts                  -- public API: export { runWorkflow }
  run-workflow.ts           -- core loop: start -> advance -> complete
  tool-context-factory.ts   -- builds V2ToolContext from DI container
  llm-driver.ts             -- Anthropic SDK calls: stepToMessage, parseOutput
  types.ts                  -- WorkflowTrigger, CompletionReport, StepOutput
```

No new test infrastructure needed beyond the existing vitest suite. The daemon functions are pure async functions -- testable by injecting fake ports.

### Key Interfaces

```typescript
// types.ts

export interface WorkflowTrigger {
  readonly workflowId: string;
  readonly goal: string;
  readonly context?: Record<string, unknown>;
  readonly workspacePath?: string;
  readonly anthropicApiKey: string;
  readonly model?: string;           // default: claude-sonnet-4-5
  readonly maxSteps?: number;        // safety cap, default: 50
}

export type StepOutput = {
  readonly notesMarkdown: string;
  readonly contextVariables?: Record<string, unknown>;
};

export type CompletionReport =
  | { readonly kind: 'completed'; readonly stepCount: number; readonly sessionId: string }
  | { readonly kind: 'failed';    readonly reason: string;    readonly sessionId?: string }
  | { readonly kind: 'max_steps_reached'; readonly stepCount: number };
```

### tool-context-factory.ts

The V2ToolContext is currently assembled inline inside the MCP request handler (`src/mcp/server.ts` or similar). We extract a factory:

```typescript
// tool-context-factory.ts
import { container } from '../di/container.js';
import { DI } from '../di/tokens.js';
import type { V2ToolContext } from '../mcp/types.js';

export function buildV2ToolContext(workspacePath?: string): V2ToolContext {
  return {
    v2: {
      gate:                 container.resolve(DI.V2.ExecutionGate),
      sessionStore:         container.resolve(DI.V2.SessionStore),
      snapshotStore:        container.resolve(DI.V2.SnapshotStore),
      pinnedStore:          container.resolve(DI.V2.PinnedWorkflowStore),
      crypto:               container.resolve(DI.V2.Sha256),
      tokenCodecPorts:      buildTokenCodecPorts(container),
      idFactory:            container.resolve(DI.V2.IdFactory),
      validationPipelineDeps: buildValidationPipelineDeps(container),
      tokenAliasStore:      container.resolve(DI.V2.TokenAliasStore),
      entropy:              container.resolve(DI.V2.RandomEntropy),
      rememberedRootsStore: container.resolve(DI.V2.RememberedRootsStore),
      managedSourceStore:   container.resolve(DI.V2.ManagedSourceStore),
      resolvedRootUris:     workspacePath ? [pathToFileURL(workspacePath).href] : [],
    },
    workflowService:    container.resolve(DI.Services.Workflow),
    featureFlags:       container.resolve(DI.Infra.FeatureFlags),
  };
}
```

This is the only "new" infrastructure piece. Everything else is resolved from the existing DI container.

### llm-driver.ts

```typescript
// llm-driver.ts
import Anthropic from '@anthropic-ai/sdk';

export interface LlmDriver {
  callStep(systemPrompt: string, stepPrompt: string): Promise<StepOutput>;
}

export function createAnthropicDriver(apiKey: string, model: string): LlmDriver {
  const client = new Anthropic({ apiKey });

  return {
    async callStep(systemPrompt, stepPrompt) {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: stepPrompt }],
      });

      // Parse notesMarkdown from response text
      // The system prompt instructs the LLM to produce:
      //   NOTES: <markdown>
      //   CONTEXT: <json object, optional>
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      return parseStepOutput(text);
    },
  };
}
```

### run-workflow.ts -- Core Loop (pseudocode)

```typescript
// run-workflow.ts
export async function runWorkflow(trigger: WorkflowTrigger): Promise<CompletionReport> {
  // 1. Boot the DI container (idempotent, safe to call multiple times)
  await initializeContainer({ runtimeMode: { kind: 'library' } });

  const ctx = buildV2ToolContext(trigger.workspacePath);
  const llm = createAnthropicDriver(trigger.anthropicApiKey, trigger.model ?? DEFAULT_MODEL);

  // 2. Start the workflow -- get first step
  const startResult = await executeStartWorkflow(
    { workflowId: trigger.workflowId, goal: trigger.goal, workspacePath: trigger.workspacePath },
    ctx
  ).match(
    ok => ok,
    err => { throw new DaemonError(err); }
  );

  const systemPrompt = buildSystemPrompt(trigger.goal);
  let continueToken = startResult.response.continueToken;
  let stepPrompt = renderContentEnvelopeAsText(startResult.contentEnvelope);
  let stepCount = 0;
  const sessionId = /* extract from token or first event */ '...';

  // 3. Drive the loop
  while (true) {
    if (stepCount >= (trigger.maxSteps ?? MAX_STEPS)) {
      return { kind: 'max_steps_reached', stepCount };
    }

    // 4. Call the LLM with this step's prompt
    const output = await llm.callStep(systemPrompt, stepPrompt);
    stepCount++;

    // 5. Advance WorkRail engine with the LLM's output
    const continueResult = await executeContinueWorkflow(
      {
        continueToken,
        intent: 'advance',
        output: { notesMarkdown: output.notesMarkdown },
        context: output.contextVariables,
        workspacePath: trigger.workspacePath,
        goal: trigger.goal,
      },
      ctx
    ).match(
      ok => ok,
      err => { throw new DaemonError(err); }
    );

    // 6. Check for completion
    if (continueResult.isComplete) {
      return { kind: 'completed', stepCount, sessionId };
    }

    // 7. Feed the next step prompt back into the loop
    continueToken = continueResult.continueToken;
    stepPrompt = renderContinueResponseAsText(continueResult);
  }
}
```

The key insight: `executeContinueWorkflow` is the existing `handleAdvanceIntent` wrapped in a thin adapter. It already returns `isComplete`, the next step's rendered prompt, and a new `continueToken`. The daemon just loops on those three values.

### System Prompt Design

```
You are an autonomous WorkRail workflow executor. You are driving a workflow step by step.

Goal: {goal}

For each step, you will receive the step's instructions. Carry them out completely.
Then write your output in exactly this format:

NOTES:
<your notes in markdown -- what you did, what you found, key decisions>

CONTEXT:
<optional JSON object with any context variables the step requires>

Be thorough in your notes. The workflow's durable log depends on them.
Do not add commentary outside the NOTES/CONTEXT blocks.
```

### What We Build vs What We Reuse

| Piece | Source | Notes |
|-------|--------|-------|
| `executeStartWorkflow` | Reuse unchanged | `src/mcp/handlers/v2-execution/start.ts` |
| `handleAdvanceIntent` | Reuse unchanged | `src/mcp/handlers/v2-execution/continue-advance.ts` |
| `initializeContainer` | Reuse unchanged | `src/di/container.ts` |
| All v2 ports/stores | Reuse unchanged | `src/v2/infra/local/` |
| `renderPendingPrompt` | Reuse unchanged | `src/v2/durable-core/domain/prompt-renderer.ts` |
| `buildV2ToolContext` | **Build new** | ~50 lines, assembles DI tokens into V2ToolContext |
| `runWorkflow` loop | **Build new** | ~100 lines, the daemon's core |
| `createAnthropicDriver` | **Build new** | ~60 lines, thin Anthropic SDK wrapper |
| `parseStepOutput` | **Build new** | ~30 lines, parses NOTES/CONTEXT from LLM text |
| pi-mono `agentLoop` | Inspiration only -- NOT imported | The loop structure is derived from it, but the WorkRail engine replaces the tool-call layer entirely |
| OpenClaw session store | Inspiration only -- NOT imported | The lifecycle state machine pattern is noted; WorkRail's existing event log handles durability |

**Total new code: ~240 lines.** The daemon is a thin caller of the existing engine.

### Why NOT to import pi-mono

pi-mono's `agentLoop` is designed for general tool-calling agents: it manages an open-ended conversation where the LLM decides which tools to call and in which order. WorkRail's workflow already encodes the step order. The LLM's job in the daemon is not "decide what to do" but "execute this step's instructions and produce notes." This is a strictly simpler, more constrained problem. Importing pi-mono would add complexity (provider registration, AgentContext, EventStream) without benefit.

### Why NOT to import OpenClaw

OpenClaw's task executor manages queued/running/terminal state for distributed task delivery across multiple runtimes (acp, subagent). WorkRail's event log already provides durable state. The daemon runs a single workflow per invocation. OpenClaw's patterns are instructive but the machinery would be over-engineering.

## Challenge Notes

1. **V2ToolContext assembly**: The exact set of fields in `V2ToolContext` needs to be verified against `src/mcp/types.ts` and the actual MCP request handler. The factory above is a sketch based on what `executeStartWorkflow` destructures from `ctx.v2`. This is the highest-risk piece.

2. **Token codec ports**: `buildTokenCodecPorts` requires the keyring (HMAC key material). This is initialized lazily on first call. The factory must ensure `initializeContainer` has completed before resolving these tokens.

3. **Step prompt rendering for daemon**: `executeStartWorkflow` returns a `contentEnvelope` in addition to the response. The daemon needs `renderContentEnvelopeAsText` -- a function that collapses the envelope into a single string for the LLM. This is straightforward but needs to be written.

4. **`executeContinueWorkflow` wrapper**: The daemon calls `handleAdvanceIntent` directly, bypassing the token decoding layer in the MCP handler. We need to verify whether token decoding (alias store lookup, HMAC verify) is handled inside `handleAdvanceIntent` or in a wrapper above it. If above, the daemon must include that decode step.

5. **Max steps safety cap**: The daemon must enforce a hard limit to prevent infinite loops on cyclic or misbehaving workflows.

## Resolution Notes

The design above resolves the key tension between "minimal" and "path to platform":
- Minimal: ~240 lines of new code, zero new infrastructure, full reuse of the durable engine
- Platform path: once `runWorkflow` exists, it becomes the foundation for a job queue, a REST trigger endpoint, a webhook handler, and a scheduled runner -- all without changing the engine

The daemon proves the thesis: WorkRail can run workflows autonomously. The workflow definition IS the agent plan. The LLM IS the executor. WorkRail IS the runtime.

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Bypass MCP transport | Avoids subprocess overhead; daemon is a library caller, not a client |
| Reuse existing DI container | Zero new storage; daemon boots the same container as the MCP server |
| Do not import pi-mono | WorkRail's step structure supersedes the general tool-call loop |
| Do not import OpenClaw | Single-workflow daemon is simpler than OpenClaw's task queue |
| `initializeContainer({ runtimeMode: 'library' })` | Disables signal handlers and `process.exit` -- safe for library use |
| NOTES/CONTEXT text protocol | Simplest possible parsing; avoids JSON schema enforcement at the LLM boundary |

## Final Summary

The MVP is five files, ~240 lines of new code. The core is `runWorkflow` -- a loop that calls `executeStartWorkflow` once, then calls `handleAdvanceIntent` in a tight loop, feeding each step's rendered prompt to the Anthropic API and each LLM response back to the engine as notes. The existing durable event log provides full observability and replay capability. The daemon does not need pi-mono, OpenClaw, or any new infrastructure -- it is a thin driver of an engine that was already autonomous-ready.
