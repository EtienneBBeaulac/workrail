# Agent Loop Architecture Alternatives: Discovery

**Status:** Complete
**Date:** 2026-04-18
**Goal:** What architectural alternatives to tool calls exist for the WorkRail daemon agent loop? We own the full agent loop and are not constrained by MCP protocol -- what patterns from research/production autonomous agent systems could be superior?

> **Artifact strategy:** Human-readable reference. Execution truth lives in WorkRail session notes and context variables. This file is for readability only.

---

## Context / Ask

WorkRail owns its full agent loop (`src/daemon/agent-loop.ts` + `workflow-runner.ts`). The current loop uses Anthropic's tool_use protocol: LLM outputs a `tool_use` block, daemon executes the tool, returns a `tool_result` block, loop continues. This is the standard MCP-compatible pattern.

The question is whether this is the *best* pattern given that WorkRail is not constrained by MCP protocol when running in daemon mode. We own the full loop. What patterns from research and production agent systems could be superior, and how would each integrate with WorkRail's workflow engine (step progression, assessment gates, continueTokens)?

---

## Path Recommendation: `landscape_first`

The dominant need is landscape grounding -- understanding what patterns exist and how each maps to WorkRail's specific constraints (HMAC token protocol, step sequencer, `isComplete` signal). The code is already understood; the research patterns are what need enumeration and ranking. `full_spectrum` reframe would add marginal value -- the problem is concrete enough.

---

## Constraints / Anti-goals

**Hard constraints:**
- HMAC token protocol is immutable -- `continueToken` must be round-tripped exactly
- `isComplete: true` is the termination signal from `continue_workflow` -- any alternative must bridge this
- Existing workflows must run unchanged -- any alternative must accept current workflow step format
- `steer()` fires after each tool batch and is the injection point for next-step prompts -- any alternative must preserve or replace this
- Sequential tool execution (workflow tools have ordering requirements -- `continue_workflow` must complete before `Bash` starts next step)
- No streaming currently (Anthropic `MessageCreateParamsNonStreaming`) -- streaming is an option but adds latency complexity

**Anti-goals:**
- Do not require changes to workflow format or step definitions
- Do not add a second LLM call per step (cost/latency)
- Do not break the HMAC enforcement guarantee
- Do not make tool error recovery worse -- current loop returns `isError: true` tool_result so LLM can recover

---

## Landscape Packet

### Current architecture: tool_use round-trip

```
1. LLM call with tools registered (continue_workflow, Bash, Read, Write, ...)
2. LLM response: stop_reason="tool_use", content=[tool_use block(s)]
3. Daemon executes tools sequentially (agent-loop.ts:_executeTools)
4. Daemon appends tool_result blocks as user message
5. Emit turn_end event; workflow-runner.ts subscriber calls steer() with next step
6. Next LLM call includes full conversation history + new steer message
7. Repeat until stop_reason="end_turn" + empty steer queue
```

**Known friction points:**
- Every step requires at minimum 2 LLM calls: one to decide to call `continue_workflow`, one to receive the next step and proceed
- Full conversation history grows every turn -- long sessions inflate input token count
- Tool schema registration happens at startup; tools are generic `AgentTool` objects with JSON Schema
- The LLM must "decide" to call `continue_workflow` -- it could theoretically forget or deviate

### What the backlog says about this question

**"Scripts over agent" principle (backlog.md, Apr 15, 2026):**
> "The agent is expensive, inconsistent, and slow. Scripts are free, deterministic, and instant. Any operation the daemon can perform with a shell script, git command, or API call should be done that way -- not delegated to the LLM."

This is the most explicit statement in the codebase about the underlying tension. The current tool_use model gives the LLM agency over *when* to call `continue_workflow`. The principle says: that decision should be deterministic (the daemon drives step transitions), not probabilistic (the LLM decides).

**Knowledge graph (backlog.md, Apr 15, 2026):**
> "every session starts with a full repo sweep... a persistent, derived knowledge graph that agents build incrementally and query instead of sweeping"

This directly addresses the memory-augmented pattern -- context compression between sessions, not per-turn.

**Workflow complexity routing (backlog.md, Apr 15, 2026):**
> "Phase 0 (classify): delegate to a cheap subagent... Main agent reviews and accepts/overrides"

This is the plan-then-execute pattern: a cheap classifier generates the execution plan, the main agent executes it. Already identified as a direction.

### Production/research patterns surveyed

Six patterns from research and production autonomous agent systems:

1. **ReAct (Reason + Act)** -- Yao et al. 2022; used in LangChain ReActAgent, AutoGPT. LLM generates reasoning trace + action in one structured response. No separate "decide what tool to call" and "execute tool" round-trip.

2. **Plan-then-execute** -- OpenAI function calling + planner mode; Devin's task planning layer; EM-LLM planning paper. Agent produces full execution plan (ordered list of actions + expected outcomes), daemon executes the whole plan, returns batch results.

3. **Verifier pattern** -- Constitutional AI (Anthropic); self-critique loops in GPT-4 Turbo; Reflexion (Shinn et al. 2023). Separate LLM calls for "what to do" (planner) vs "did it work" (verifier). Main loop never gets stuck in error recovery.

4. **Direct structured output / typed schemas** -- OpenAI structured_outputs (2024); Instructor library; Pydantic AI. Instead of `tool_use` protocol with JSON Schema, LLM outputs a strongly-typed response object that the daemon parses directly. No tool definition registration at startup.

5. **Agentic streaming** -- Anthropic streaming API; streaming tool use (Claude claude-sonnet-4-5 supports streaming with tool calls); OpenAI streaming function calls. Daemon parses response in real-time and executes actions as they appear in the stream.

6. **Memory-augmented loop** -- MemGPT (Packer et al. 2023); Zep memory layer; WorkRail knowledge graph backlog. Agent reads from and writes to structured knowledge store between turns instead of carrying everything in context.

---

## Pattern Analysis

### Pattern 1: ReAct (Reason + Act)

**How it works in research:**
LLM outputs structured `Thought: ... Action: ... Observation: ...` traces. Reasoning and action are interleaved in one response. The model commits to an action before seeing the result, reasons about the result, then commits to the next action.

**How it would work in WorkRail:**

Replace the current `tool_use` output format with a structured JSON response:
```json
{
  "thought": "The step asks me to read agent-loop.ts and summarize the architecture...",
  "action": "read_file",
  "action_input": { "path": "src/daemon/agent-loop.ts" },
  "is_step_complete": false,
  "notes_so_far": "..."
}
```

Daemon parses this, executes the action, injects the result back, and continues.

**What replaces `continue_workflow`:**
`is_step_complete: true` in the structured output triggers the daemon to call `engine.continueWorkflow()` directly -- not via a tool call. The LLM does not need to know about `continueToken`. The daemon owns token management entirely.

**Fit with WorkRail:**
- HMAC tokens: the LLM never sees them -- daemon manages them. Full enforcement preserved.
- `isComplete`: daemon reads `is_step_complete` flag; calls `engine.continueWorkflow()` when true.
- `steer()` replacement: daemon injects next step via `agent.steer()` as before, but the step prompt format changes to match the ReAct output schema.
- Step injection: the workflow step prompt becomes the "context" frame for the structured output.

**Gains:**
- No tool registration overhead -- tools are hard-coded to the structured output schema
- Reasoning is explicit and auditable -- the `thought` field is in the session log
- One LLM call can combine reasoning + action decision + progress tracking

**Losses / risks:**
- Structured output mode requires Anthropic's `tool_choice: { type: "any" }` or a single tool with the full schema -- less flexible than multi-tool setup
- Error recovery is harder: if `is_step_complete` is true but the work is wrong, the daemon has already advanced. Current tool_use model lets the LLM self-correct via additional tool calls before deciding to advance.
- Not all Anthropic models support JSON mode reliably for complex schemas; tool_use is more reliable for structured output

**Verdict: MEDIUM fit.** Best applied as a hybrid: keep `continue_workflow` as a tool but make the step prompt explicitly ask the LLM to reason before acting. The pure ReAct replacement (no tools) would hurt error recovery.

---

### Pattern 2: Plan-then-Execute

**How it works in research:**
A planner LLM call produces a complete execution plan (ordered list of actions). A separate executor runs each action in the plan sequentially or in parallel. Results are batched and returned to the planner for verification or re-planning.

**How it would work in WorkRail:**

At step start, before executing any actions, the daemon makes a "planning" LLM call:
```json
{
  "plan": [
    { "step": 1, "action": "read_file", "path": "src/daemon/agent-loop.ts", "expected_outcome": "understand loop structure" },
    { "step": 2, "action": "read_file", "path": "src/daemon/workflow-runner.ts", "expected_outcome": "understand steer() usage" },
    { "step": 3, "action": "complete_step", "notes": "..." }
  ]
}
```

Daemon executes the plan, batches results, calls a second LLM for synthesis + notes generation.

**What replaces `continue_workflow`:**
The plan's final action is `complete_step` with `notes`. Daemon calls `engine.continueWorkflow()` when the executor reaches the final plan item.

**Fit with WorkRail:**
- Aligns perfectly with "scripts over agent" -- the planning phase is the only LLM call; execution is mechanical
- Works with WorkRail's step model: each workflow step gets one plan-execute cycle
- `isComplete`: the plan's final `complete_step` action signals step completion
- HMAC tokens: daemon manages, LLM never sees them

**Gains:**
- Fewer total LLM calls for predictable steps (one planning call + one synthesis call vs. N tool_use round-trips)
- Execution is deterministic once the plan exists -- auditable, testable
- Plans are human-readable artifacts -- can be reviewed before execution (human-in-the-loop hooks)
- Aligns with the Phase 0 classification pattern already in the backlog

**Losses / risks:**
- Planning quality degrades for complex, exploratory steps where the right actions depend on what earlier actions reveal (you can't plan "read file X" if you don't yet know X's path)
- Two-call overhead per step even for simple steps (planning + synthesis)
- Plan-then-execute assumes the plan is complete -- if the plan misses an action, the step fails silently

**Verdict: HIGH fit for structured, predictable steps (Phase 5 fast path, auto-commit steps). LOW fit for exploratory steps (context gathering, investigation). Best as an opt-in step type: `stepType: "planned"` in workflow definition.**

---

### Pattern 3: Verifier Pattern

**How it works in research:**
Separate LLM calls for "planner" (what to do next) and "verifier" (did the last thing work). The planner never sees error recovery -- that's the verifier's job. The planner stays focused on progress; the verifier handles quality gates.

**How it would work in WorkRail:**

After each tool batch (currently the `turn_end` event), a second LLM call evaluates the tool results:
```json
{
  "assessment": "pass|retry|escalate",
  "reasoning": "...",
  "retry_instruction": "Run npm test again -- the first run failed due to a flaky test"
}
```

If `assessment: "retry"`, the verifier's `retry_instruction` is injected via `steer()`. If `assessment: "escalate"`, the step is marked as `needs_human_review`.

**What replaces `continue_workflow`:**
Nothing -- `continue_workflow` is still called by the planner. The verifier adds a post-action quality gate.

**Fit with WorkRail:**
- This is a natural complement to the current tool_use model, not a replacement
- The `turn_end` event is the natural integration point for the verifier call
- WorkRail's assessment gates (in some workflow step types) already model this conceptually
- HMAC tokens: unchanged -- verifier never calls `continue_workflow`

**Gains:**
- Main agent stays focused on progress, not error recovery
- Verifier can use a cheaper model (claude-haiku for assessment, claude-sonnet for planning)
- Retry logic is explicit and auditable
- Escalation path for genuinely stuck agents

**Losses / risks:**
- Adds one LLM call per tool batch -- significant cost for tool-heavy steps
- Verifier and planner can disagree on "done" -- needs a tie-breaking rule
- Verifier model needs access to tool results and step context -- adds context management complexity

**Verdict: HIGH fit as an optional enhancement, not a core architecture change. Best implemented as an `onTurnEnd` hook in AgentLoop with a configurable verifier function. Step definition can opt in: `verifier: { model: "haiku", threshold: "high" }`.**

---

### Pattern 4: Direct Structured Output (typed schemas)

**How it works in research:**
Instead of registering tools with JSON Schema and receiving `tool_use` blocks, the LLM is constrained to output a single structured object that the daemon parses. Used in OpenAI structured_outputs, Instructor library, Pydantic AI.

**How it would work in WorkRail:**

Define a `StepOutput` type that the LLM must produce:
```typescript
interface StepOutput {
  notesMarkdown: string;   // required -- step completion notes
  contextUpdates: Record<string, unknown>; // optional context variable updates
  isComplete: boolean;     // true = advance to next step
  toolCalls: Array<{       // zero or more tool calls to execute
    tool: 'Bash' | 'Read' | 'Write';
    params: Record<string, unknown>;
  }>;
}
```

The LLM outputs one `StepOutput` per turn. Daemon executes the `toolCalls`, feeds results back, and loops.

**What replaces `continue_workflow`:**
`isComplete: true` in the `StepOutput` -- daemon calls `engine.continueWorkflow()` with `notesMarkdown`. The LLM never needs to know about the token protocol.

**Fit with WorkRail:**
- **Best alignment with WorkRail's "scripts over agent" principle**: LLM produces the intent, daemon executes it
- HMAC tokens: completely hidden from the LLM -- daemon owns all token management
- `steer()` replacement: daemon still uses `steer()` to inject next step prompt, but the expected output shape is the `StepOutput` schema
- Existing workflows: step prompts become the instruction set for generating a `StepOutput`

**Gains:**
- LLM never sees `continueToken` -- zero token leakage risk, zero token hallucination risk
- Typed output validation at parse time (Zod/TypeBox) -- malformed output is detected before execution
- Tool calls are explicit in the output schema -- no "unknown tool name" hallucination
- `isComplete` is a first-class field -- daemon progression is controlled by the daemon, not by whether the LLM chose to call a specific tool
- Step notes are always present (required field) -- eliminates the "LLM forgot to include notes" failure mode

**Losses / risks:**
- Requires Anthropic's `tool_choice` with a single tool (the `StepOutput` schema as a tool) -- changes the API call shape
- Parallel tool execution not representable -- `toolCalls` is sequential by definition in this schema
- Error messages from failed tool calls must be injected back as part of the structured output loop -- slightly different message format than current `tool_result` blocks
- The LLM must output a complete `StepOutput` including `notesMarkdown` before tool results are known -- this may degrade note quality for exploratory steps

**Verdict: VERY HIGH fit -- this is the most architecturally coherent alternative. It is the pattern that best expresses WorkRail's "daemon owns step progression" principle. Implementation path: add a `StepOutputMode` option to `AgentLoopOptions`; when set, use a single tool schema for `StepOutput` instead of the multi-tool registry.**

---

### Pattern 5: Agentic Streaming

**How it works in research:**
LLM streams its response, daemon parses it in real-time and executes actions as they appear. Used in Claude claude-sonnet-4-5 with streaming tool use, OpenAI streaming function calls.

**How it would work in WorkRail:**

Switch `client.messages.create` to streaming (`client.messages.stream`). As the stream arrives:
- Text blocks are buffered for logging
- Tool use blocks trigger immediate tool execution when the input JSON is complete
- Results are injected into the stream continuation

**What replaces `continue_workflow`:**
Nothing changes -- `continue_workflow` is still a tool. The change is execution timing: tools fire as soon as they're parsed from the stream rather than waiting for the full response.

**Fit with WorkRail:**
- Sequential tool execution constraint is preserved -- stream still processes tools in declaration order
- `steer()` integration is unchanged
- HMAC tokens: unchanged

**Gains:**
- Lower latency for tool-heavy steps: `Bash` command starts while LLM is still generating the rest of its response
- For long-running bash commands, the LLM output is fully streamed while the command runs
- Feels more responsive in console live view

**Losses / risks:**
- Streaming API adds significant complexity to `_runLoop` -- need to handle partial tool_use blocks, streaming errors, and reconnection
- The `onLlmTurnStarted/onLlmTurnCompleted` callbacks need to span the full stream duration -- different token accounting
- `AbortController` behavior changes: aborting mid-stream requires drain-then-abort semantics
- Latency gains are marginal for short steps (< 500ms tool execution) -- the LLM generation time dominates

**Verdict: LOW fit for now. The latency gains are real but small for WorkRail's use case (workflow steps that run bash commands taking 5-60 seconds). The complexity cost is high. Best deferred until streaming becomes necessary for a specific use case (e.g., live console output display during long-running bash).**

---

### Pattern 6: Memory-Augmented Loop

**How it works in research:**
MemGPT, Zep, and similar systems maintain a structured knowledge store that the agent reads from and writes to between turns. Instead of re-reading files at the start of every session, the agent queries the knowledge store for relevant context.

**How it would work in WorkRail:**

WorkRail's backlog already designs this: the knowledge graph backed by tree-sitter + DuckDB. The agent loop integration point:

1. At session start, instead of injecting full CLAUDE.md (32 KB cap), inject a targeted context bundle from the knowledge graph
2. Between steps, the daemon updates the knowledge graph with what the agent learned (files read, symbols traced, invariants found)
3. At next session start, context gathering is "query graph for relevant subgraph" not "sweep 200 files"

**What replaces `continue_workflow`:**
Nothing -- this is not a replacement for the step progression mechanism. It replaces the context *content* injected into the agent, not the control flow.

**Fit with WorkRail:**
- The backlog already identifies this as HIGH importance (Apr 15, 2026)
- The knowledge graph is a new WorkRail source -- `graphSource` alongside `bundledSource`, `userSource`, `managedSource`
- `query_knowledge_graph` and `update_knowledge_graph` tools in the daemon tool registry
- The daemon updates the graph post-session (scripts over agent principle: graph update is deterministic, no LLM needed)

**Gains:**
- Context gathering drops from "sweep 200 files" to "query graph for 5-10 relevant files"
- Session startup time drops significantly for repeat tasks on familiar codebases
- Cross-session knowledge accumulates -- each session makes the next one faster
- Reduces input token count per session

**Losses / risks:**
- Requires the knowledge graph to be built and maintained -- significant new infrastructure
- Graph staleness: source files change, graph may be stale. Provenance tracking mitigates but doesn't eliminate
- First session on a new codebase still requires a full sweep to seed the graph

**Verdict: HIGH strategic importance, LOW urgency for near-term. This is the right long-term direction for reducing per-session cost. The implementation is a new WorkRail infrastructure layer, not a change to the agent loop itself. Defer until daemon is proven with current architecture.**

---

## Candidate Directions (Ranked)

### Rank 1: Direct Structured Output (Pattern 4)

**Why it wins:**
- Best expresses the "daemon owns step progression" architectural principle
- Eliminates `continueToken` visibility and hallucination risk entirely
- `notesMarkdown` becomes a required field -- eliminates "LLM forgot notes" failures
- `isComplete` is first-class -- daemon progression is deterministic, not tool-call-dependent
- Requires minimal change to `AgentLoop` -- add `StepOutputMode` option with single-schema tool
- All existing workflows work unchanged -- step prompts become `StepOutput` instructions

**Implementation path:**
1. Add `StepOutputSchema` TypeBox type: `{ notesMarkdown: string, isComplete: boolean, toolCalls: Array<...>, contextUpdates: Record<...> }`
2. Add `outputMode: 'tool_use' | 'structured_output'` to `AgentLoopOptions`
3. In `structured_output` mode: register a single tool `__step_output__` with `StepOutputSchema` as input_schema; add `tool_choice: { type: "tool", name: "__step_output__" }` to API params
4. In `_executeTools`: when `__step_output__` is called, extract `toolCalls` from the structured output and execute them; when `isComplete: true`, set the `isComplete` flag in `workflow-runner.ts`
5. `workflow-runner.ts` reads `isComplete` from the structured output instead of from `continue_workflow`'s response

**Replaces `continue_workflow` calls with:** Structured output field. The LLM never calls `continue_workflow` directly.

**What `continue_workflow` becomes in this model:** A daemon-side function call -- `engine.continueWorkflow()` is called by the daemon when it reads `isComplete: true` from the structured output. Not a tool the LLM invokes.

---

### Rank 2: Verifier Pattern (Pattern 3)

**Why it's second:**
- Does not replace the current architecture -- enhances it
- Low-risk addition: `onTurnEnd` hook in `AgentLoop` already supported via `subscribe()`
- Cheap model (Haiku) for verification keeps cost overhead low
- Solves real problem: LLM error recovery loops that go in circles
- Opt-in per step type -- existing workflows unaffected until they opt in

**Implementation path:**
1. Add `VerifierConfig` to `AgentLoopOptions`: `{ model: string; systemPrompt: string; threshold: 'low' | 'medium' | 'high' }`
2. In `turn_end` subscriber in `workflow-runner.ts`, after tool results are collected, call verifier LLM with tool results + step context
3. Verifier returns `{ assessment: 'pass' | 'retry' | 'escalate', retryInstruction?: string }`
4. `retry`: call `agent.steer()` with `retryInstruction` (overrides normal next-step steer)
5. `escalate`: set a `needsHumanReview` flag; daemon pauses session and emits REST event for console

**Replaces `continue_workflow` calls with:** Nothing -- `continue_workflow` is still called by the LLM. Verifier adds a post-execution quality gate.

---

### Rank 3: Plan-then-Execute (Pattern 2)

**Why it's third:**
- High fit for structured, predictable steps; poor fit for exploratory steps
- Best as an opt-in step type (`stepType: "planned"`) not a universal replacement
- Phase 5 fast-path in lean.v2 workflows is the ideal target
- Aligns with the Phase 0 classification backlog item

**Implementation path:**
1. Add `stepType: "planned"` to workflow step schema
2. In `workflow-runner.ts`: when step type is `planned`, make a planning LLM call first with a `PlanSchema` output
3. Daemon executes the plan mechanically (scripts, not agent)
4. Second LLM call synthesizes results + generates notes
5. Daemon calls `engine.continueWorkflow()` with synthesized notes

**Replaces `continue_workflow` calls with:** Daemon orchestration -- the LLM never calls `continue_workflow` in planned steps.

---

### Rank 4: ReAct (Pattern 1)

**Why it's fourth:**
- Useful as a prompt engineering technique within the current architecture (explicitly ask for reasoning before action)
- Not worth a full architecture change -- the gains are prompt-level, not infrastructure-level
- Error recovery concern (premature `is_step_complete`) is a real risk

**Implementation path:** No code change needed. Add ReAct-style reasoning instruction to step prompts in `buildSystemPrompt()`. The `## Execution contract` section already encourages "read the step carefully" -- add "reason about your approach before executing."

---

### Rank 5: Memory-Augmented Loop (Pattern 6)

**Why it's fifth:**
- Highest strategic importance for the long-term platform
- Lowest urgency -- requires the knowledge graph infrastructure first
- Not a change to the agent loop itself; a change to the context content

**Implementation path:** See knowledge graph backlog section. Requires tree-sitter + DuckDB implementation, `query_knowledge_graph` tool, session-end graph update hook.

---

### Rank 6: Agentic Streaming (Pattern 5)

**Why it's last:**
- Highest complexity, lowest marginal gain for WorkRail's use case
- Deferred until a specific use case (live console output) justifies the complexity

---

## Resolution Notes

### The architectural insight across all patterns

Every high-ranked pattern converges on the same principle: **the LLM should express intent, the daemon should drive control flow.**

In the current architecture, the LLM drives control flow by deciding to call `continue_workflow`. This is the weakest point:
- The LLM can forget to include notes
- The LLM can misformat the `continueToken`
- The LLM can call `continue_workflow` before completing the work
- The LLM can enter an error recovery loop that never advances

The Structured Output pattern (Rank 1) fully inverts this: the LLM outputs `{ isComplete: true, notesMarkdown: "...", toolCalls: [...] }` and the daemon decides whether and when to call `engine.continueWorkflow()`. This is architecturally cleaner and more robust.

### What this means for the WorkRail "daemon owns everything" principle

The `continue_workflow` tool is currently a bridge between the LLM world (tool calls) and the WorkRail world (HMAC tokens, step sequencer). The Structured Output pattern removes the LLM from that bridge. The daemon becomes the sole owner of step transitions. The LLM becomes a pure cognition engine: given a context, produce a structured output. The daemon handles all state machine transitions.

This is the right long-term direction. The `continue_workflow` tool is a historical artifact of the MCP model where Claude Code drives WorkRail externally. In daemon mode, that indirection is unnecessary.

### Compatibility with current workflows

All Rank 1-3 patterns are backward-compatible with current workflows:
- Structured Output: step prompts become instructions for producing `StepOutput`; no workflow format change needed
- Verifier: opt-in per step; existing steps unaffected
- Plan-then-Execute: opt-in per step type; existing steps unaffected

---

## Decision Log

### Initial pattern survey rankings (landscape pass)

| Decision | Rationale |
|----------|-----------|
| Rank 1: Structured Output | Best expression of "daemon owns step progression"; eliminates token leakage and hallucination risk; required `notesMarkdown` field solves persistent notes failure mode |
| Rank 2: Verifier | Non-breaking enhancement; solves real error recovery problem; opt-in; cheap with Haiku model |
| Rank 3: Plan-then-Execute | High fit for structured steps; aligns with Phase 0 classification backlog; opt-in via step type |
| Rank 4: ReAct | Prompt engineering, not architecture change; no code needed |
| Rank 5: Memory-Augmented | Highest long-term strategic importance; lowest near-term urgency; separate infrastructure layer |
| Rank 6: Streaming | Highest complexity, lowest marginal gain; deferred |
| Against: pure tool_use replacement | Current tool_use model works; the risk is the LLM controlling step transitions, not the mechanism itself |

### Candidate generation + design review (candidate pass)

Four concrete candidates were generated and reviewed (see `agent-loop-alternatives-candidates.md` and `agent-loop-alternatives-review.md`):

| Decision | Rationale |
|----------|-----------|
| **Selected: C3 (complete_step tool)** | Minimum-scope change satisfying all 5 decision criteria; iterative exploration preserved; continueToken hidden; notes required at type level; MCP mode unchanged; reversible. |
| C1 (Required-Notes Wrapper) as Phase 1 | Ships in 30 minutes as immediate safety net; compatible with C3; not competing. |
| C2 (StepOutput Mode) as runner-up | Lost because declaring all tool calls upfront breaks iterative exploration for investigative steps. Right long-term direction if Anthropic's forced-tool mode supports iterative invocation. |
| C4 (Scripted Steps) as follow-on | Right for auto-commit/auto-test steps; build when that feature ships. |
| C3 revised: minLength 50 (not 10) | ORANGE finding from design review: minLength 10 catches empty strings but not placeholder notes. |
| C3 revised: explicit continue_workflow exclusion | ORANGE finding: silent failure if both tools registered; explicit exclusion + test required. |

---

## Final Summary

**The core question is: who should own step transitions -- the LLM or the daemon?**

The current tool_use model answers "LLM" (by calling `continue_workflow`). Every high-value alternative answers "daemon" (by reading a structured output field or executing a plan).

### Recommended build order

**Phase 1 (this week, ~30 min):**
- Add `minLength: 50` check to `continue_workflow` notes param in `_executeTools()` -- ships as immediate safety net

**Phase 2 (next sprint, ~1 day):**
- Implement `complete_step` tool for daemon mode: schema `{ notesMarkdown (required, minLength:50), contextUpdates }`
- Update `workflow-runner.ts` turn_end subscriber to detect `complete_step` and call `engine.continueWorkflow()` directly
- Update `buildSystemPrompt()` to describe `complete_step` in daemon mode
- Explicit `continue_workflow` exclusion in daemon mode tool registry
- Unit test: daemon mode tool list includes `complete_step`, excludes `continue_workflow`
- WHY comments throughout explaining the token-hiding and notes-enforcement rationale

**Phase 3 (after Phase 2 is proven):**
- Verifier hook at `turn_end` (Rank 2) -- opt-in per step; cheap Haiku model; solves premature-complete failure mode

**Phase 4 (longer-term):**
- `stepType: "scripted"` for Phase 5 fast path / auto-commit steps (Rank 3, C4)
- Knowledge graph infrastructure (Rank 5) -- separate infrastructure layer

**Confidence: HIGH.** All findings are grounded in:
- Direct code reading (`agent-loop.ts`, `workflow-runner.ts`)
- Direct backlog reading ("scripts over agent" principle, knowledge graph section, complexity routing section)
- Prior daemon architecture discovery (`daemon-architecture-discovery.md`)
- Pattern literature (ReAct, MemGPT, Reflexion, structured_outputs)
