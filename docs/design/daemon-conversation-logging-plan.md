# Implementation Plan: Daemon Conversation Logging

## Problem Statement

The WorkRail daemon runs workflows autonomously but provides minimal visibility into what the agent is actually doing. Today you can see `session_started`, `tool_called`, and `session_completed` in the JSONL event log - but you cannot see what the LLM decided, which tools it requested, how long each tool took, or whether a tool succeeded. Adding `llm_turn_started`, `llm_turn_completed`, `tool_call_started`, `tool_call_completed`, and `tool_call_failed` events - plus a `worktrain logs` CLI command - turns the event file into a real-time audit trail of agent behavior.

## Acceptance Criteria

1. After an LLM API call in `_runLoop()`, `llm_turn_started` is written before the call and `llm_turn_completed` after the response.
2. For every tool execution via `_executeTools()`, `tool_call_started` is written before `tool.execute()`, and either `tool_call_completed` or `tool_call_failed` is written after.
3. `tool_call_started` args are truncated to max 200 chars. `tool_call_completed` result summary truncated to max 200 chars.
4. All new events appear in the same daily JSONL file as existing events.
5. `worktrain logs` reads today's log file and prints each event formatted for humans.
6. `worktrain logs --follow` polls the file every 500ms and prints new events as they arrive.
7. `worktrain logs --session <id>` filters events to those with matching `sessionId`.
8. `worktrain logs --follow` handles midnight file rotation (switches to new date file).
9. If the log file doesn't exist, `worktrain logs` prints a helpful message; `--follow` waits for the file.
10. TypeScript compiles without errors. Existing tests pass.

## Non-Goals

- NOT putting events in the v2 session event store
- NOT adding a Console Timeline tab
- NOT deprecating `tool_called` events (backward compat)
- NOT implementing accurate pre-call token counting (message count proxy is sufficient)
- NOT searching across multiple day files for `--session` filter

## Philosophy-Driven Constraints

- **Fire-and-forget invariant**: All callbacks in AgentLoop are wrapped in try/catch that swallow errors.
- **DI for boundaries**: AgentLoop receives callbacks, not DaemonEventEmitter itself.
- **Make illegal states unrepresentable**: New event kinds added to `DaemonEvent` discriminated union.
- **YAGNI**: Only the specified event kinds and fields.

## Invariants

1. `tool_call_started` is always followed by either `tool_call_completed` or `tool_call_failed`.
2. `llm_turn_started` may have no matching `llm_turn_completed` on API error - this is intentional signal.
3. Callbacks in AgentLoop never propagate exceptions to the caller.
4. `DaemonEvent` union remains exhaustive.

## Selected Approach

AgentLoopOptions callbacks: 5 optional callback properties on `AgentLoopOptions` called in `_runLoop()` and `_executeTools()`. workflow-runner.ts wires them to `emitter?.emit()`.

## Vertical Slices

### Slice 1: New event types in daemon-events.ts
- Add interfaces: `LlmTurnStartedEvent`, `LlmTurnCompletedEvent`, `ToolCallStartedEvent`, `ToolCallCompletedEvent`, `ToolCallFailedEvent`
- Extend `DaemonEvent` union with all 5

### Slice 2: AgentLoopOptions callbacks + emission in agent-loop.ts
- Add 5 optional callbacks to `AgentLoopOptions`
- Call with try/catch in `_runLoop()` before/after `client.messages.create()`
- Call with try/catch in `_executeTools()` before/after `tool.execute()`
- Add `Date.now()` timing for tool calls

### Slice 3: Wire callbacks in workflow-runner.ts
- In `runWorkflow()`, pass `AgentLoop` constructor the 5 callbacks
- Each callback calls `emitter?.emit()` with the appropriate new event kind

### Slice 4: `worktrain logs` CLI command
- Add `program.command('logs')` with `--follow` and `--session <id>` options
- Read daily JSONL, format each line, handle ENOENT
- Polling loop with midnight rotation

### Slice 5: Tests
- `daemon-events.test.ts`: Add 5 new event kinds to exhaustiveness test
- `agent-loop.test.ts`: Add tests for callback timing, completion, failure, and try/catch guards

## Test Design

- onToolCallStarted fires before tool execute (verified via call order recording)
- onToolCallCompleted fires after successful execute (verified with durationMs > 0)
- onToolCallFailed fires when tool throws (loop continues normally)
- onLlmTurnStarted fires with correct messageCount before API call
- onLlmTurnCompleted fires with actual token counts from API response
- Callbacks that throw do not crash the loop

## Risk Register

| Risk | Mitigation |
|---|---|
| Callback throws crash the session | try/catch on all 5 callback invocations |
| --follow misses events at midnight | Date-check on each poll iteration |

## PR Strategy

Single PR: `feat/daemon-conversation-logging`

## Philosophy Alignment

- DI for boundaries: Satisfied (callbacks, not DaemonEventEmitter in AgentLoop)
- Make illegal states unrepresentable: Satisfied (discriminated union)
- Errors are data: Satisfied (tool throws -> tool_call_failed, not propagated)
- Fire-and-forget: Satisfied (try/catch guards)
- YAGNI: Satisfied
- Exhaustiveness: Satisfied (union extended + test updated)
