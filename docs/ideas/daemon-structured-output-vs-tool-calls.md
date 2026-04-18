# Daemon: Structured Output vs Tool Calls for Workflow-Control Communication

**Status:** Discovery in progress (2026-04-18)
**Author:** Discovery workflow
**Scope:** WorkRail autonomous daemon (`src/daemon/`) only. Does not affect the MCP server or human-driven Claude Code sessions.

---

## What this doc is for

This document is a **human-readable artifact** for reviewing the structured output vs tool call tradeoff in the WorkRail daemon. It is NOT execution truth -- execution truth lives in WorkRail session notes and context variables.

---

## Context / Ask

The WorkRail daemon (`workflow-runner.ts`) drives autonomous workflow sessions via an `AgentLoop` that uses the Anthropic Messages API. The agent currently communicates with the workflow engine entirely through tool calls:

- `continue_workflow` -- advance/rehydrate the workflow engine (in-process via `executeContinueWorkflow`)
- `Bash`, `Read`, `Write` -- interact with the filesystem/shell
- `report_issue` -- observability signal to the daemon

The `continue_workflow` pattern was inherited from the MCP protocol, where tool calls are the only communication mechanism. But the daemon **owns the agent loop directly** and is not constrained by MCP. It could use `response_format: { type: 'json_schema', json_schema: {...} }` to force structured JSON output instead of tool calls for workflow-control operations.

**The question:** Should `continue_workflow` (and possibly `report_issue`) be replaced with structured output, keeping only the world-interaction tools (Bash, Read, Write) as actual tool calls?

---

## Path Recommendation

`landscape_first` -- both options are named, the codebase is readable, the dominant need is side-by-side comparison.

---

## Constraints / Anti-Goals

**Constraints:**
- Must not break the MCP server tool-call path (MCP clients still call `continue_workflow` as a tool)
- Bedrock compatibility required (default daemon client is `AnthropicBedrock`)
- No new Anthropic API features that aren't available on Bedrock

**Anti-goals:**
- Don't redesign MCP server schema
- Don't change how human-driven Claude Code sessions work
- Don't require unavailable API features

---

## Landscape Packet

### API Capability Survey (verified 2026-04-18)

**Anthropic SDK version installed:** `@anthropic-ai/sdk` (GA), `@anthropic-ai/bedrock-sdk` 0.28.1

**GA messages API (`client.messages.create`):**
- `output_config.format` (type `JSONOutputFormat` with `type: 'json_schema'`) is in the GA `MessageCreateParamsNonStreaming` type (line 1059 of messages.d.ts)
- `tools` and `output_config.format` are **separate fields** on the same params object -- there is NO documented incompatibility in the TypeScript types
- The beta `structured-outputs-2025-12-15` header is only required for the older `beta.messages` API; the GA API uses `output_config` directly
- Bedrock SDK (`@anthropic-ai/bedrock-sdk`) imports `Resources` from `@anthropic-ai/sdk/resources/index` -- it inherits the same `output_config` type

**Key discovery: tools + output_config CAN coexist in the GA API**
The `MessageCreateParamsNonStreaming` type has both `tools?: Array<ToolUnion>` and `output_config?: OutputConfig` as independent optional fields. Earlier assumption that "you can't mix response_format with tool calls" applies only to the older beta API (which has a different incompatibility model). The GA API was designed to support both simultaneously.

This eliminates the main technical blocker for the hybrid approach.

### Token Overhead Analysis

| Approach | Schema overhead per request | Notes |
|----------|--------------------------|-------|
| Current (5 tools) | ~853 tokens | All 5 schemas injected on every `messages.create()` call |
| Hybrid (3 world tools + SO schema) | ~628 tokens | Bash + Read + Write tools + output_config schema |
| Enriched tool schema (Option D) | ~853 tokens | Same as current, adds fields to existing schema |
| Pure structured output | ~358 tokens | output_config schema only, no tools |

The savings from the hybrid approach (~225 tokens/request) are modest. At 50 turns/session, that's ~11,000 tokens saved -- meaningful but not decisive.

### Tool Call Pattern Analysis

From reading `workflow-runner.ts` and `agent-loop.ts`, the actual session pattern is:

```
Turn 1: Bash (read files) → Bash (more investigation) → continue_workflow(advance)
Turn 2: Bash (edit code) → Bash (run tests) → continue_workflow(advance)
...
Turn N: continue_workflow(advance) → done
```

Key observations:
1. **`continue_workflow` always appears at the END of a turn.** The LLM never interleaves `continue_workflow` with Bash calls. This is enforced by workflow design -- the step work comes before advancing.
2. **Multiple tool calls per turn are common.** The LLM calls Bash 3-5 times before `continue_workflow`.
3. **Tool call ordering is significant.** `continue_workflow` must be last in a turn.
4. The `steer()` mechanism injects the next step AFTER `continue_workflow` fires, which then causes a new LLM turn.

This pattern means: on the turn where `continue_workflow` fires, it is always the LAST tool call. There is no structural reason it needs to be a tool call (the daemon could inspect the response, see end_turn, and interpret the text as structured output). But the current mechanism is clean -- tool call = explicit signal, result = next step.

### Precedents in the Codebase

- The "scripts over agent" principle (backlog.md) applies: deterministic operations should be scripts, not LLM decisions. Structured output is more scripty -- it removes the LLM's ability to "call wrong tools" and forces it to produce what the daemon expects.
- The blocked response complexity (retry tokens, validation issues) is currently text-in-tool_result. With structured output, `next_action: "blocked"` with a structured `blockers` array would be cleaner.
- Bedrock SDK 0.28.1 is current (released 2026-04-08) and inherits GA API types including `output_config`.

### Evidence Gaps

1. **Runtime behavior of tools + output_config combo on Bedrock:** TypeScript types allow it; runtime behavior is unverified. Could use WebFetch to check Bedrock docs or test with a real call.
2. **Whether output_config.format constrains tool call behavior:** The docs say structured outputs "guarantee" the format -- but what happens on the turn where the LLM also calls tools? Does it produce tool_use blocks OR a json_schema text block? This is the key behavior question.
3. **Token counting accuracy:** ~4 chars/token is a rough estimate. Actual overhead depends on the specific tokenizer.

### Contradictions Found

1. **Earlier claim (pre-reading) vs. actual SDK:** I initially assumed "response_format + tools = incompatible." The GA SDK shows `output_config` and `tools` are separate fields. This assumption was wrong and needs correction.
2. **The "blocked" path complexity:** The current `continue_workflow` tool returns complex text (retry tokens, validation issues, assessment followups) in the tool_result text. This is exactly the kind of structured data that JSON schema would handle better -- a contradiction with the tool-call-is-simpler narrative.

---

## Problem Frame Packet

### Primary Users / Stakeholders

- **Daemon operator (Etienne):** Runs autonomous workflows. Cares about session reliability, debuggability, token cost, and whether the LLM reliably submits well-structured notes and artifacts on each step.
- **Workflow authors:** Define workflow steps. Benefit if the agent submits structured artifacts (commit type, PR title, files changed) without requiring notes-parsing heuristics.
- **MCP clients (Claude Code, other MCP integrations):** Unaffected -- the MCP tool-call path is unchanged. This decision is daemon-internal only.
- **WorkRail engine (`executeContinueWorkflow`):** Receives advance calls. Currently gets `notesMarkdown` as a string; would benefit from typed `artifacts` and `context_updates` as first-class fields.

### Core Tension

**Tool calls give the LLM agency; structured output constrains it.**

With tool calls, the LLM decides WHEN to call `continue_workflow` and WHAT to include. It can call it early, late, skip it, or call it multiple times. The daemon has to trust the LLM to follow the protocol.

With structured output, the LLM MUST emit the schema on end_turn. The daemon reads it deterministically. The LLM cannot deviate from the schema.

But: tool calls are the natural idiom for "LLM doing work then reporting completion." Structured output is the natural idiom for "LLM producing a typed result." The question is which idiom fits the daemon's use case better.

**The sub-tension:** The `blocked` response path needs structured data (retry tokens, blockers, validation issues) to flow back to the LLM cleanly. Currently this is text-in-tool_result that the agent has to parse. Structured output (or an enriched tool schema) solves this directly.

### Jobs / Outcomes

1. **Reliable step completion signaling:** Daemon needs to know when the LLM has finished step work. Currently: LLM calls `continue_workflow`. With SO: LLM emits end_turn with json output.
2. **Structured artifact submission:** Workflow steps can require typed handoff artifacts (commit type, PR title). Currently parsed from notesMarkdown text -- fragile. With SO or enriched schema: first-class typed fields.
3. **Debuggability:** When a session goes wrong, can you tell why? Tool calls leave a clear log (`tool_called` events). Structured output on end_turn is also inspectable. Both are fine.
4. **Blocked response handling:** LLM needs to understand what to fix when `continue_workflow` returns blocked. Currently: complex text in tool_result. Better: structured blockers array.

### Success Criteria

1. The LLM reliably submits step notes and advances the workflow -- no more, no less.
2. Artifact fields (commit type, PR title, files changed) are accessible as typed data in `lastStepNotes` without text parsing.
3. Blocked response path is clearer -- the LLM knows exactly what to fix and where to find the retry token.
4. No Bedrock API regression.
5. Implementation complexity is proportional to the benefit.

### Assumptions (that could be wrong)

1. **"tools + output_config coexist at runtime"** -- verified in SDK types, unverified at Bedrock runtime. If AWS Bedrock doesn't support `output_config.format`, hybrid and pure-SO options are blocked on Bedrock.
2. **"the LLM always calls continue_workflow last"** -- this is behavioral, not enforced. A hallucinating LLM could call Bash after continue_workflow. The steer() mechanism handles this, but it's an assumption that the protocol holds.
3. **"structured output improves reliability"** -- it guarantees schema shape, not semantic correctness. The LLM could still submit empty notes, wrong artifacts, or meaningless step_notes. The gain is format enforcement, not content enforcement.

### Reframes / HMW Questions

1. **HMW:** "How might we make the artifact submission path typed without changing the turn structure at all?" Answer: Option D -- enrich `ContinueWorkflowParams` with an `artifacts` array. Zero API change, same tool call pattern.

2. **HMW:** "How might we separate 'workflow-control' from 'world-interaction' in a way that makes the distinction architecturally clean?" Answer: This is the real insight in the structured output proposal. Bash/Read/Write are I/O. `continue_workflow` is a protocol signal. Mixing them in the same tool list conflates two different communication channels.

3. **Reframe:** The question is NOT "tool calls vs structured output" -- it's "should the workflow-advance signal be a tool call or a protocol signal?" Tool calls are the right mechanism for I/O with side effects. Workflow advance is not I/O -- it's a turn-ending protocol handshake. The framing conflates mechanism with purpose.

### Framing Risks

1. **Over-engineering risk:** The "structured output is cleaner" argument is aesthetically appealing. But the actual pain is "artifacts are hard to extract from notesMarkdown text." Option D fixes that pain with one schema field addition. If that's the only real pain, the bigger architectural change isn't justified.
2. **Runtime compatibility risk:** If Bedrock doesn't support `output_config.format` (unverified), the hybrid/pure-SO options are blocked on the default daemon client. The fix would require switching to direct Anthropic API (no Bedrock) or waiting for AWS to support it.
3. **LLM behavior risk:** Structured output guarantees schema shape but not quality. An LLM that writes bad notes as text will write bad notes as json. The reliability improvement is narrower than it sounds.

---

## Candidate Directions

### Option A: Status Quo (do nothing)

**Summary:** Keep the current tool-call pattern exactly as-is. Accept that artifact extraction requires notesMarkdown parsing and blocked responses are text.

**Tensions resolved:** None. Baseline for comparison.
**Tensions accepted:** Fragile artifact extraction, messy blocked response text.
**Boundary:** No change.
**Failure mode:** Delivery layer (`delivery-action.ts`) continues to parse `lastStepNotes` as text -- brittle to note format changes.
**Repo pattern:** Follows existing pattern exactly.
**Gain:** Zero change cost, zero risk.
**Give up:** Typed artifact delivery, cleaner blocked response handling.
**Impact surface:** None.
**Scope:** Best-fit as baseline only, not as a real candidate for improvement.
**Philosophy:** Honors YAGNI. Conflicts with "make illegal states unrepresentable" (notesMarkdown parsing is a stringly-typed boundary).

---

### Option D: Enriched Tool Schema (recommended -- simplest sufficient change)

**Summary:** Add `artifacts?: Array<{kind: 'git_commit'|'pr'|'test_run'|'file_set', [key: string]: unknown}>` and `blockerResolution?: {retryToken: string, issuesResolved: string[]}` to `ContinueWorkflowParams`. Remove the blocked response text encoding from tool_result; return a structured `BlockedResponse` type instead.

**Concrete shape:**
```typescript
// ContinueWorkflowParams additions:
artifacts?: ReadonlyArray<{
  kind: 'git_commit' | 'pull_request' | 'test_run' | 'file_set';
  [key: string]: unknown;
}>;
// BlockedResponse tool_result (replace current text encoding):
// { kind: 'blocked', blockers: [{message, suggestedFix?}], retryToken: string, validation?: {issues: string[], suggestions: string[]} }
// Returned as JSON in the tool_result content block
```
The LLM calls `continue_workflow({continueToken, notesMarkdown, artifacts: [{kind: 'git_commit', type: 'feat', subject: '...'}]})`. The daemon reads `params.artifacts` directly. No notesMarkdown parsing for delivery.

The blocked response text is replaced with JSON in the tool_result content, using the existing text content block but with `JSON.stringify(blockedResponse)` -- the LLM already parses JSON from tool results.

**Tensions resolved:**
- Typed artifact submission: solved (typed `artifacts` field)
- Blocked response clarity: partially solved (structured JSON in tool_result, but still in a text block)
**Tensions accepted:**
- The tool_result structured response is still a text block -- the JSON is implicit, not schema-enforced
- `artifacts.kind` enum is a new contract that workflow authors must honor

**Boundary:** `makeContinueWorkflowTool` in `workflow-runner.ts`. The `ContinueWorkflowParams` schema is the input boundary; the blocked response format is the output boundary.
**Why this boundary:** The tool execute() function is the one place where both the input (params) and output (tool_result content) live. No changes to `agent-loop.ts` or `AgentClientInterface`.

**Failure mode:** The LLM may not pass `artifacts` if the system prompt doesn't explicitly instruct it to. The schema makes it optional (backward compatible). The delivery layer must handle missing artifacts gracefully.

**Repo pattern:** Follows existing pattern (tool call, schema, execute()). Adapts the blocked response from text to JSON in the same text content block.

**Gain:** Typed artifact delivery without any new API dependencies or Bedrock risk. Solves the most concrete day-to-day pain.
**Give up:** Still a tool call (no schema enforcement at the LLM boundary); still text-wrapped JSON for blocked responses.

**Impact surface:**
- `workflow-runner.ts`: `makeContinueWorkflowTool` schema + execute()
- `src/trigger/delivery-action.ts`: reads `params.artifacts` instead of parsing `lastStepNotes`
- System prompt: add artifacts instruction
- Zero changes to `agent-loop.ts`, MCP server, or Bedrock client

**Scope:** Best-fit. Minimal change to the real seam, solves the stated pains.
**Philosophy:** Honors "explicit domain types over primitives" (typed artifacts vs string parsing), "YAGNI" (no new dependencies), "validate at boundaries" (typed input schema). Minor conflict with "make illegal states unrepresentable" -- artifacts.kind is closed but the rest of the object is open (`[key: string]: unknown`).

---

### Option C: Two-Phase Hybrid (tools for I/O, structured output for end-of-step)

**Summary:** Keep Bash/Read/Write as tool calls. Remove `continue_workflow` from the tool list entirely. On every `end_turn` response (when the LLM stops calling tools), the daemon reads a structured JSON object from the final text block using `output_config.format: { type: 'json_schema', schema: StepCompletionSchema }`. The daemon calls `executeContinueWorkflow` directly based on that JSON.

**Concrete shape:**
```typescript
// output_config schema injected into messages.create():
const StepCompletionSchema = {
  type: 'object',
  properties: {
    step_notes: { type: 'string' },
    next_action: { type: 'string', enum: ['advance', 'rehydrate', 'done'] },
    artifacts: { type: 'array', items: { type: 'object' } },
    context_updates: { type: 'object' },
    issues: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string', enum: ['tool_failure', 'blocked', 'unexpected_behavior', 'needs_human', 'self_correction'] },
      severity: { type: 'string', enum: ['info', 'warn', 'error', 'fatal'] },
      summary: { type: 'string' }
    }}}
  },
  required: ['step_notes', 'next_action']
};
// messages.create() call adds: output_config: { format: { type: 'json_schema', schema: StepCompletionSchema } }
```

The daemon's `agent-loop.ts` needs a new code path: when `stop_reason === 'end_turn'`, parse the text content block as JSON (the structured output). The `workflow-runner.ts` `_runLoop` handles this in its `agent_end` subscriber.

The steer() mechanism must be restructured: instead of steers happening inside the current prompt() call, the daemon calls `agent.prompt()` again with the next step after parsing the end_turn JSON.

**Tensions resolved:**
- Typed artifact submission: solved at the API level (schema-enforced)
- Blocked response clarity: daemon sends the next step text as a new user message, not as a tool_result -- the LLM sees the blocked feedback as a first-class message
- Schema enforcement: the LLM CANNOT produce end_turn without a valid JSON object
**Tensions accepted:**
- Bedrock runtime uncertainty: `output_config.format + tools` coexist in GA TypeScript types but unverified on Bedrock at runtime
- Steer() restructuring: the current steer/turn_end/inject-next-step flow must change -- after end_turn, the daemon calls agent.prompt() for the next step, not agent.steer()
- Multi-step per prompt() call changes: currently one prompt() call runs an entire session. With this change, each step becomes its own prompt() call (or a new messages.create() call).

**Boundary:** `agent-loop.ts` + `workflow-runner.ts`. The `AgentClientInterface.messages.create()` params gain `output_config`. The loop's `end_turn` handling gains JSON parsing.

**Failure mode:**
1. Bedrock doesn't support `output_config.format` at runtime -- session fails silently or with a cryptic API error
2. The LLM produces a malformed JSON object (schema enforcement reduces but doesn't eliminate this)
3. The steer() restructuring introduces a regression in the step-injection flow

**Repo pattern:** Departs from existing pattern. Requires changes to both `agent-loop.ts` (new end_turn handling) and `workflow-runner.ts` (new step-injection flow). The `AgentClientInterface` duck-type must be extended.

**Gain:** Schema-enforced step completion. Clean architectural separation between "world interaction" (tool calls) and "protocol communication" (structured output). Eliminates the tool_result complexity for blocked responses.
**Give up:** Implementation complexity, Bedrock risk, steer() refactor, non-trivial testing effort.

**Impact surface:**
- `agent-loop.ts`: new end_turn JSON parsing path, `AgentClientInterface` extended
- `workflow-runner.ts`: step-injection restructuring, `AgentLoopOptions.tools` changes
- `AgentClientInterface`: new `output_config` parameter
- All tests that exercise the agent loop
- Bedrock runtime compatibility (unverified)

**Scope:** Too broad for the stated pains. The implementation complexity exceeds the benefit if Option D solves the artifact/blocked-response problem.
**Philosophy:** Strongly honors "make illegal states unrepresentable" (schema enforcement), "validate at boundaries" (LLM output boundary). Conflicts with "YAGNI" -- architectural change for a benefit that D also provides incrementally. Conflicts with "architectural fixes over patches" only if D is a patch; D is arguably an architectural fix (typed domain types).

---

### Option B: Pure Structured Output (no tool calls except Bash/Read/Write)

**Summary:** Same as Option C but removes `report_issue` from the tool list too, folding it into the `issues` array in the structured output schema. The daemon listens only for `end_turn` with the StepCompletionSchema JSON -- no `continue_workflow` tool call at all.

**Distinctions from Option C:** This option commits fully to structured output as the ONLY workflow-control channel. `report_issue` becomes a field in the StepCompletionSchema, not a tool call. The LLM has fewer tools (Bash, Read, Write only) -- simpler tool schema.

**Additional gain over C:** ~225 tokens/request saved (no continue_workflow or report_issue schemas). Tool list is 3 items (Bash, Read, Write) -- cleaner, fewer hallucination targets.
**Additional risk over C:** Same Bedrock risk. Larger departure from existing pattern. `report_issue` timing changes -- currently the LLM can call it mid-step; with pure SO, issues are batch-submitted at end_turn.

**Scope:** Too broad. Same fundamental Bedrock risk as C with additional issue-timing behavioral change.
**Philosophy:** Most aligned with "make illegal states unrepresentable." Highest conflict with "YAGNI."

---

## Challenge Notes

### Candidate Generation Expectations (landscape_first path)

The candidate set must:
1. **Reflect verified landscape constraints** -- specifically that `output_config.format + tools` CAN coexist in the GA API (verified from SDK types). Options must not assume incompatibility.
2. **Cover the full spectrum from minimal to architectural** -- from schema enrichment only (Option D) to full structured output (Option B) to hybrid (Option C). No candidate should be omitted because it seems "too simple" or "too complex."
3. **Treat Bedrock runtime uncertainty as a first-class dimension** -- each option must state its Bedrock risk explicitly. Options that require unverified Bedrock behavior must be flagged as "conditional on prototype validation."
4. **Address the two concrete pains** -- typed artifact submission AND blocked response clarity. An option that solves neither is not a candidate.
5. **Not drift into free invention** -- options must be grounded in what the codebase actually supports. No speculative dependencies.

---

## Resolution Notes

*(To be populated)*

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-18 | Landscape-first path chosen | Both options are named; dominant need is comparison, not reframing |

---

## Final Summary

*(To be populated)*
