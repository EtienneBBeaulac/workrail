# Daemon Conversation Logging: Design Candidates

## Problem Understanding

### Core tensions

1. **AgentLoop decoupling vs. LLM turn visibility**: AgentLoop is intentionally decoupled from all observability infrastructure (no DaemonEventEmitter import). To emit LLM turn events FROM inside `_runLoop()`, we need to bridge this gap without coupling AgentLoop to daemon-specific types. Options: inject callbacks, use the existing AgentEvent subscriber system, or violate the boundary. The subscriber system fires at `turn_end` (after tool results), which is not the right boundary for `llm_turn_started` / `llm_turn_completed`. Callbacks are the right choice.

2. **Single-source vs. dual-source tool events**: Today each tool factory (`makeBashTool`, `makeReadTool`, etc.) emits `tool_called` directly. Adding `tool_call_started/completed/failed` in `_executeTools()` creates a single centralized emission point. The existing `tool_called` events remain for backward compatibility; new event kinds are additive.

3. **Input token estimation**: True token counts require a tokenizer (tiktoken or the API's usage field). The API returns `response.usage.input_tokens` and `response.usage.output_tokens` in the response. For `llm_turn_started`, emit message count as proxy. For `llm_turn_completed`, emit actual token counts from the API response.

4. **`worktrain logs --follow` streaming**: Node.js file watching is noisy; polling every 500ms is reliable and simple for MVP.

### What makes this hard

Nothing is architecturally hard. The tricky parts are:
- Getting tool event timing exactly right (started before execute, completed/failed after)
- For `worktrain logs --follow`: handling the case where the log file doesn't exist yet
- TypeScript type checking: callback signatures must be precise for ts-strict

### Likely seam

The real seam for tool events is `_executeTools()` in `agent-loop.ts` - it's the single place all tools execute. The real seam for LLM turn events is the `client.messages.create()` call in `_runLoop()`. Both are in `agent-loop.ts`.

## Philosophy Constraints

From `CLAUDE.md` (system-wide):
- **DI for boundaries**: inject external effects (observability) to keep core logic testable
- **YAGNI with discipline**: no speculative fields beyond what's in the spec
- **Exhaustiveness everywhere**: new event kinds extend the `DaemonEvent` discriminated union
- **Fire-and-forget invariant**: `emit()` is void, errors swallowed - observability never affects correctness
- **Prefer fakes over mocks**: FakeAnthropicClient pattern in agent-loop tests

No philosophy conflicts found between stated principles and existing repo patterns.

## Impact Surface

- `runWorkflow()` in `workflow-runner.ts`: constructs AgentLoop, must pass new callbacks
- `AgentLoopOptions` interface: extended with optional callbacks (non-breaking)
- `DaemonEvent` union: extended with new members (exhaustiveness tests must update)
- `tests/unit/daemon-events.test.ts`: the exhaustiveness test at line 169 must list new event kinds
- `tests/unit/agent-loop.test.ts`: needs tests for callback invocation timing
- No public API changes - all daemon-internal

## Candidates

### Candidate A: AgentLoopOptions callbacks (recommended)

**Summary**: Add 5 optional callback properties to `AgentLoopOptions` in `agent-loop.ts`. Call them synchronously in `_runLoop()` and `_executeTools()`. Wire in `workflow-runner.ts` to call `emitter?.emit()`.

**New properties on AgentLoopOptions**:
```typescript
onLlmTurnStarted?: (info: { messageCount: number }) => void
onLlmTurnCompleted?: (info: {
  stopReason: string;
  outputTokens: number;
  inputTokens: number;
  toolNamesRequested: string[];
}) => void
onToolCallStarted?: (info: { toolName: string; argsSummary: string }) => void
onToolCallCompleted?: (info: { toolName: string; durationMs: number; resultSummary: string }) => void
onToolCallFailed?: (info: { toolName: string; durationMs: number; errorMessage: string }) => void
```

**Tensions resolved**: AgentLoop stays decoupled from DaemonEventEmitter. Single source of truth for tool event timing.

**Boundary**: AgentLoop / workflow-runner.ts interface. Correct seam - AgentLoop is a reusable primitive; workflow-runner.ts is the daemon-specific orchestrator.

**Failure mode**: If a callback throws, it propagates into the agent loop. Mitigated by: callbacks call `emitter?.emit()` which is fire-and-forget and never throws.

**Follows existing pattern**: `DaemonRegistry` uses the same inject-as-optional pattern. `toolExecution: 'sequential'` is already a strategy parameter on `AgentLoopOptions`.

**Gains**: Central timing; no changes to individual tool factories; clean separation; new tools get events automatically.
**Gives up**: `AgentLoopOptions` interface is slightly heavier (5 optional callbacks). Callbacks are less discoverable than per-tool pattern.

**Scope**: best-fit.

**Philosophy**: honors DI-for-boundaries, YAGNI, exhaustiveness. No conflicts.

---

### Candidate B: Extend per-tool factory pattern (adapt existing)

**Summary**: Keep the existing per-tool `emitter?.emit({ kind: 'tool_called' })` approach. Add `tool_call_started` emit before `tool.execute()` and `tool_call_completed`/`tool_call_failed` after, inside each of the 5 tool factory closures. Add LLM turn callbacks to `AgentLoopOptions` only for the LLM-specific events.

**Tensions resolved**: Minimizes changes to AgentLoop (only 2 callbacks instead of 5). Follows the exact existing pattern.

**Boundary**: Each tool factory is the emission point.

**Failure mode**: 5 tool factories x 3 events each = 15 new emit calls. Duplication risk. New tools added later won't automatically get events.

**Follows existing pattern**: Pure adaptation of the existing `tool_called` pattern.

**Gains**: No callbacks for tool events in AgentLoopOptions; no risk of propagated errors.
**Gives up**: DRY principle - timing logic duplicated 5x. Maintenance trap.

**Scope**: best-fit for existing tools, but creates technical debt.

**Philosophy**: conflicts with "compose with small, pure functions" (duplication). Honors DI-for-boundaries.

## Comparison and Recommendation

**Recommendation: Candidate A**

Candidate A wins on every meaningful dimension:
- **Best-fit boundary**: `_executeTools()` is the single canonical execution point for all tools.
- **Most manageable failure mode**: callbacks call `emitter?.emit()` which can never throw.
- **Best philosophy fit**: "Compose with small, pure functions" and "DI for boundaries" both point to A.
- **Easiest to evolve**: Adding a 6th tool gets events automatically.
- **Consistent with repo patterns**: Same pattern as `DaemonRegistry` injection.

## Self-Critique

**Strongest argument against**: Candidate A adds 5 callback properties to `AgentLoopOptions`. If `AgentLoop` is used in tests without an emitter, the interface is heavier. Counter: all 5 are optional (`?`), zero cost when absent.

**Narrower option that was considered**: Only add LLM turn callbacks (skip `tool_call_started/completed/failed`). Doesn't satisfy the spec.

**Broader option**: Put the emitter directly in `AgentLoopOptions`. Would require `AgentLoop` to import `DaemonEventEmitter`, coupling the modules. Unjustified.

**Invalidating assumption**: None. `_executeTools()` is the only tool execution path in `AgentLoop`.

## Open Questions for Implementation

1. The existing `tool_called` events in per-tool factories (`makeBashTool`, `makeReadTool`, `makeWriteTool`, `makeContinueWorkflowTool`) - keep them as-is for backward compat, or remove them now that `tool_call_started` supersedes them? Decision: keep for backward compat since consumers may depend on them.

2. For the `worktrain logs --follow` command, should it print historical lines first then follow? Yes - show existing entries then poll for new ones.

3. Should `worktrain logs --session <id>` filter by exact sessionId match? Yes.
