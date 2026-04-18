# Discovery: Daemon Stuck Detection and Visibility

## Context / Ask

Identify what a "stuck" daemon agent looks like in the logs and define the definitive signals for detecting it. This is the prerequisite for implementing visibility improvements (stuck detection events, improved `worktrain logs`, session health summary, console live panel indicator, and richer WORKTRAIN_STUCK markers).

## Path Recommendation

**landscape_first** -- the codebase and event log are fully readable; no architectural reframing needed. The signals are observable facts, not design decisions.

**Rationale:** The ask is empirical: what does stuck look like? The event log for 2026-04-18 has real `issue_reported` events showing actual stuck patterns. The code is fully readable. Discovery + landscaping is sufficient; no candidate comparison needed.

## Constraints / Anti-goals

- Anti-goal: Do not redesign the session event store or merge daemon events into it (separate backlog item #4315).
- Anti-goal: Do not build a watchdog daemon or restart mechanism (out of scope for this phase).
- Constraint: All new events must follow the discriminated union pattern in `daemon-events.ts`.
- Constraint: Stuck detection runs in the `turn_end` subscriber in `runWorkflow()`, not as a new thread.

## Landscape Packet

### Source files reviewed

- `src/daemon/workflow-runner.ts` -- agent loop, timeout logic, turn counter, `report_issue` tool
- `src/daemon/daemon-events.ts` -- all current event kinds (15 events in the union)
- `src/daemon/agent-loop.ts` -- turn_end subscriber, steer, _runLoop
- `~/.workrail/events/daemon/2026-04-18.jsonl` -- 2000+ events from real sessions today
- `docs/ideas/backlog.md` -- relevant sections at lines 3912-3972, 4315-4380

### Current event kinds in DaemonEvent union

1. `daemon_started` -- daemon boot
2. `trigger_fired` -- incoming webhook
3. `session_queued` -- queue entry
4. `session_started` -- agent loop about to begin
5. `tool_called` (coarse stream) -- from inside each tool's execute()
6. `tool_error` -- isError=true tool result in turn_end subscriber
7. `step_advanced` -- onAdvance() fired (continue_workflow succeeded)
8. `session_completed` -- outcome: success|error|timeout
9. `delivery_attempted` -- HTTP callback POST
10. `issue_reported` -- agent called report_issue; has severity + issueKind
11. `llm_turn_started` -- before client.messages.create()
12. `llm_turn_completed` -- after API response; has stopReason, inputTokens, outputTokens, toolNamesRequested
13. `tool_call_started` -- fine-grained; has argsSummary (200 chars JSON)
14. `tool_call_completed` -- fine-grained; has durationMs, resultSummary
15. `tool_call_failed` -- fine-grained; has durationMs, errorMessage

**Missing:** No `agent_stuck` event kind currently exists.

### Real stuck patterns in 2026-04-18.jsonl (session ea2de6e5)

Session `ea2de6e5` (workrailSessionId: `sess_5hb25pdpq2jqhciznto7vmgaue`) shows a clear real-world stuck pattern:

1. Agent tried to submit `wr.assessment` artifacts 6+ times via `continue_workflow`
2. Each attempt was blocked (the daemon's `continue_workflow` tool lacks an `artifacts` field)
3. Agent escalated: `issue_reported` severity=warn (line 1779) → severity=error (line 1795) → severity=fatal (line 1825) → severity=fatal again (line 1915)
4. The session ended with `session_completed outcome=timeout detail=max_turns` -- it hit the turn limit still stuck

This is the canonical "blocked_at_assessment_gate" stuck pattern. The agent knows it's stuck and signals it clearly via `report_issue`, but there's no `agent_stuck` event the console or coordinator can watch for.

### Stuck signal taxonomy (from code analysis + log evidence)

**Signal 1: Repeated tool call (same tool + same args)**
- In `tool_call_started` events, `argsSummary` is JSON params truncated to 200 chars.
- If the last 3 `tool_call_started` events for the session have identical `toolName` AND `argsSummary`, the agent is looping.
- Observable from the event log by comparing consecutive `tool_call_started.argsSummary` values.
- Detection point: `turn_end` subscriber in `runWorkflow()`.

**Signal 2: issue_reported with severity=fatal**
- Agent self-diagnoses as stuck and explicitly calls `report_issue` with `severity='fatal'`.
- Confirmed by real log: 2x fatal reports in session ea2de6e5 before max_turns.
- This is the most reliable signal because the agent knows its state.
- Detection point: already emitted as `issue_reported` event; just needs to be surfaced.

**Signal 3: No step advances after N LLM turns**
- `step_advanced` events increment `stepAdvanceCount` (tracked in `onAdvance()` closure).
- `llm_turn_completed` events tracked by `turnCount` variable.
- If `turnCount >= maxTurns * 0.8` AND `stepAdvanceCount == 0`, the session will timeout without completing a single step.
- Detection point: `turn_end` subscriber (already has access to `turnCount` and can track `stepAdvanceCount`).

**Signal 4: Tool call failure rate > 50% over last 5 turns**
- `tool_call_failed` events tracked by the `turn_end` subscriber.
- If >50% of tool calls in the last 5 turns failed, something systematic is broken.
- Less reliable than signals 1-3 because short bursts of failure are normal (grep exit 1, missing files).
- Detection point: `turn_end` subscriber with a rolling 5-turn failure rate tracker.

**Signal 5: Wall-clock approaching maxSessionMinutes with < 2 advances**
- `timeoutReason !== null` is set when wall-clock timeout fires, but that's too late -- the abort already happened.
- Better: check `(Date.now() - sessionStartMs) > sessionTimeoutMs * 0.8` AND `stepAdvanceCount < 2`.
- Detection point: `turn_end` subscriber.

**Signal 6: Blocked attempt chain (assessment gates)**
- When `continue_workflow` returns `kind: 'blocked'`, the tool returns feedback to the LLM.
- PR #554 capped `blocked_attempt` chains at 3. Beyond that it's a fatal block.
- The `issue_reported` events are the reliable proxy for this pattern.

### turn_end subscriber and tracking variables (workflow-runner.ts)

The `turn_end` subscriber (lines 1725-1755) currently:
- Emits `tool_error` events for `isError=true` tool results
- Increments `turnCount`
- Checks `maxTurns` limit and calls `agent.abort()` if hit
- Calls `agent.steer()` with pending step text

State variables accessible in the subscriber via closures:
- `turnCount` -- LLM turn count (already tracked)
- `isComplete` -- workflow complete flag
- `pendingSteerText` -- next step text (null until continue_workflow advances)
- `stepAdvanceCount` -- NOT currently tracked (needs to be added)
- `sessionStartMs` -- NOT currently tracked (needs to be added)
- The event history for "last N tool_call_started" -- NOT currently tracked (needs a ring buffer)

### WORKTRAIN_STUCK current fields (workflow-runner.ts line 1837-1843)

```json
{
  "reason": "session_error",
  "error": "<first 500 chars of error message>",
  "workflowId": "<id>",
  "sessionId": "<process-local UUID>"
}
```

Missing (per implementation spec): `turnCount`, `stepAdvanceCount`, `lastToolCalled`, `issueSummaries`.

### Backlog references

- Line 3923: "Session liveness detection. If a session has been in_progress for more than N minutes with no advance_recorded events, the daemon watchdog should log a warning and optionally abort the session."
- Line 4229: "report_issue tool -- WORKTRAIN_STUCK marker in WorkflowRunResult"
- Line 4315-4332: "Agent actions as first-class events" -- worktrain_stuck as a session event kind
- Line 3972: "WORKTRAIN_STUCK routing and coordinator self-healing patterns all depend on logs being structured and complete"

## Problem Frame Packet

**The stuck agent is currently invisible.** An agent can loop for 50 turns hitting assessment gates, call `report_issue` 4 times at increasing severity, and the only external signal is that `session_completed outcome=timeout` eventually fires. There is no `agent_stuck` event. The `worktrain logs` output doesn't distinguish fatal issues from warnings. The console live panel shows no stuck indicator. The WORKTRAIN_STUCK marker has no context about turns used or issues reported.

**Root cause:** stuck detection was deferred to "after the fact" (WORKTRAIN_STUCK in final notes), but the signals exist in real-time (turn_end subscriber has turnCount, tool results, and the onAdvance closure tracks advances).

## Candidate Directions

### Direction A: Minimal -- just emit agent_stuck events (no UI changes)
Add `AgentStuckEvent` to daemon-events.ts, emit in turn_end subscriber on 3 signals. Low effort, observable via raw JSONL.

### Direction B: Full -- 5 improvements as specified
Add stuck events + improve worktrain logs + add `worktrain status` + console panel + richer WORKTRAIN_STUCK. Full visibility stack.

**Recommendation: Direction B.** The 5 improvements are cohesive and each addresses a different visibility gap. The stuck event alone (Direction A) isn't actionable if nothing surfaces it to humans.

## Resolution Notes

All 5 implementation items are well-scoped. The key implementation details:

1. **Stuck detection (workflow-runner.ts):** Add `stepAdvanceCount` and `sessionStartMs` variables alongside `turnCount`. Add a `lastNToolCalls` ring buffer (last 3 `tool_call_started` events). In `turn_end`, check the 3 signals and emit `agent_stuck`.

2. **worktrain logs formatting (cli-worktrain.ts):** `formatDaemonEventLine()` exists and can be extended with new cases. Currently minimal (no step_advanced or llm_turn_completed formatting found -- needs verification).

3. **worktrain status command (cli-worktrain.ts):** New subcommand. Reads the daemon JSONL for a sessionId, aggregates counts, prints health summary. Pure reads, no daemon state required.

4. **Console liveActivity (console-service.ts):** `readLiveActivity()` already reads `tool_called` events. Add `agent_stuck` to the filter.

5. **WORKTRAIN_STUCK enrichment (workflow-runner.ts):** The stuckMarker JSON at line 1837 needs 4 new fields. The data is all available in closures at that point.

## Decision Log

- Chose `landscape_first` path: the signals are observable facts from code + logs, not design decisions.
- Session ea2de6e5 from 2026-04-18.jsonl confirmed that `issue_reported` severity escalation is the primary real-world stuck signal.
- Ring buffer approach (last 3 `tool_call_started`) preferred over full history scan for repeated-tool detection.
- `stepAdvanceCount` must be tracked separately from `turnCount` (both exist in the subscriber but only `turnCount` is currently maintained).

## Final Summary

A stuck daemon agent currently looks like: many `llm_turn_completed` events with `toolNamesRequested` containing only failed tools, escalating `issue_reported` severity levels (warn → error → fatal), zero `step_advanced` events, and finally `session_completed outcome=timeout detail=max_turns`. The session `ea2de6e5` in today's log is the canonical example: 6 blocked `continue_workflow` attempts, 4 escalating `issue_reported` calls, terminated by max_turns.

The 5 definitive stuck signals are: (1) same tool+args called 3+ times, (2) issue_reported severity=fatal, (3) 0 step advances after 80%+ of turns used, (4) tool failure rate >50% over last 5 turns, (5) wall-clock at 80%+ with <2 advances. These are all detectable in the `turn_end` subscriber using existing state variables plus 2 new counters and a 3-element ring buffer.
