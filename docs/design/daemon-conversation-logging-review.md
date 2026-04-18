# Daemon Conversation Logging: Design Review Findings

## Tradeoff Review

| Tradeoff | Assessment | Conditions for failure |
|---|---|---|
| AgentLoopOptions gains 5 optional callbacks | Acceptable - all optional, zero cost when absent | Would matter if AgentLoop were a versioned public library |
| Dual `tool_called` + `tool_call_started` events in log | Minor duplication, harmless - different fields, different consumers | If a consumer enforced "one event per tool execution" |
| `llm_turn_started` uses message count (proxy) | Spec-compliant - user explicitly said "estimate from message count" | If accurate pre-call token counts were needed for routing |
| `--follow` polls at 500ms interval | Acceptable for human-readable monitoring | If sub-100ms stream was required |

## Failure Mode Review

| Failure mode | Status | Mitigation |
|---|---|---|
| Callback throws, propagates into agent loop | **UNMITIGATED - REQUIRES FIX** | Add try/catch around all 5 callback invocations in agent-loop.ts |
| `tool_call_started` without matching `tool_call_completed` | Handled - catch block emits `tool_call_failed` | No action needed |
| `llm_turn_started` without matching `llm_turn_completed` (API error) | Acceptable - unmatched started = API error signal | No action needed |
| `--follow` misses events at midnight file rotation | **REQUIRES FIX** | Check `new Date()` on each poll; switch to new file when date changes |
| Log file doesn't exist (daemon not started) | Handled - ENOENT returns graceful message | No action needed |

## Runner-Up / Simpler Alternative Review

- **Runner-up (Candidate B, per-tool factories)**: No elements worth borrowing. Centralizing in `_executeTools()` is strictly better.
- **Simpler alternative (no AgentLoop changes + `turn_end` subscriber for LLM events)**: Fails spec - `turn_end` fires after tool results, not after API response. Not a valid simplification.
- **Hybrid (callbacks for LLM, per-factory for tools)**: Two patterns for the same concern. Worse than either pure approach.

## Philosophy Alignment

**Satisfied**: DI for boundaries, immutability, make illegal states unrepresentable, errors as data, determinism, YAGNI, validate at boundaries.

**Under tension (acceptable)**:
- Type safety: `argsSummary` is deliberately a truncated string - this is spec-required (max 200 chars) and appropriate for JSONL serialization.
- Exhaustiveness: DaemonEvent union grows by 5; no switch consumers exist so this is theoretical only.

## Findings

### Red (blocking)
None.

### Orange (should fix before implementation)
1. **Missing try/catch around callbacks in agent-loop.ts**: A buggy callback passed to `AgentLoop` would propagate a throw into the agent loop and crash the session. This violates the fire-and-forget invariant that all observability in the daemon upholds. Fix: wrap each of the 5 callback invocations with `try { callback(info); } catch { /* swallow */ }`.

### Yellow (fix during implementation)
2. **Midnight file rotation in `--follow`**: The polling loop should check `new Date().toISOString().slice(0, 10)` on each iteration and switch to the new file when the date changes. 3-line fix in the polling loop.

## Recommended Revisions

1. Add try/catch guards around all callback invocations in `_runLoop()` and `_executeTools()` in `agent-loop.ts`.
2. Add date-aware file switching in the `--follow` polling loop in `cli-worktrain.ts`.

## Residual Concerns

- The `tool_called` + `tool_call_started` dual events: a future cleanup task could deprecate `tool_called` once all consumers migrate to `tool_call_started`. Not in scope for this PR.
- The `worktrain logs` command reads from the daily JSONL file directly. If sessions span multiple days, `--session <id>` would only find events in the current day's file. A future improvement could search across all files. Not in scope.
