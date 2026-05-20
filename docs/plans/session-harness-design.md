# Daemon Session Harness Design

**Status:** Discovery in progress (2026-05-20)

## Context / Ask

**Stated goal (original):** Design a deterministic (no AI) harness layer between the agent loop and the WorkRail engine that owns session lifecycle intelligence -- pre-turn state injection, tool interception and error enrichment, failure pattern escalation, session suspension/resumption, and daemon-side synthetic tool calls.

**Goal classification:** `solution_statement` -- already names a specific architecture.

**Path recommendation:** `design_first` -- the stated solution names a layer but there are open questions about where the right boundaries are and whether prevention or recovery should be the primary mechanism.

**Rigor mode:** `THOROUGH` -- core infrastructure that everything else depends on; wrong abstraction boundary is worse than no harness.

**Solution ambitiousness:** `ideal_solution` -- MVP must be architecturally coherent with the full vision; cannot make assumptions that foreclose future capabilities.

**Problem domain:** `software`

## Problem Frame Packet

**Reframed problem:** The daemon has no mechanism to observe what a session is doing, intervene when it goes wrong, or recover gracefully -- so sessions that encounter errors spiral into stuck states or terminate unexpectedly with no recovery path, making autonomous overnight operation unreliable.

**Desired outcome:** Sessions that currently end stuck recover and complete. Operator escalation is a clean handled path, not a crash. The harness is invisible on the happy path and omnipresent on failure paths.

**Anti-goals:**
- No AI in the harness -- all logic must be deterministic scripts
- Do not make the happy path slower
- Do not couple harness logic to specific workflow definitions
- Do not replace the engine's contract enforcement -- the harness enriches, it doesn't bypass

**Primary uncertainty:** Whether the right intervention point is at the message layer (before the LLM sees bad information), the tool layer (after the tool call returns a bad result), or both -- and whether prevention (augmenting prompts before failures) or recovery (handling failures after they happen) should be the primary mechanism.

**Known approaches:**
- Middleware wrapping the agent loop
- Callback hooks at tool call boundaries
- Message preprocessing pipeline before each LLM turn
- Post-tool-call result enrichment

## Constraints / Anti-goals

- All harness logic is deterministic TypeScript -- no LLM calls, no AI reasoning
- Zero latency added on the happy path
- New behaviors require one rule, not modifications to the agent loop or engine
- Full observability: harness interventions appear in the session event log
- Session suspension must preserve full state for clean resumption

## Landscape Packet

*(to be populated)*

## Problem Frame Packet (detailed)

*(to be populated)*

## Candidate Directions

*(to be populated)*

## Challenge Notes

*(to be populated)*

## Resolution Notes

*(to be populated)*

## Decision Log

*(to be populated)*

## Decision Log

**2026-05-20: Selected SessionCortex with tiered recovery ladder**

*Why it won:* Only candidate to satisfy all 6 criteria including the quality-aspirational (open/closed) and vision-aligned (session segmentation compatible). Structural challenge eliminated C2 (two-chain approach) for hot-path mutation, dual extension points, no durable in-flight state. Fresh-context executor independently scored C3 6/6. The key insight: existing turn_end event already carries toolResults -- no new agent loop hook needed. The cortex log is the minimum persistence layer for criterion 4 (suspension/resumption after restart).

*Why runner-up (C1, prevention-only) is the foundation, not an alternative:* C1's pure-function rule shape `(CortexState, TurnEvent) => Intervention | null` is the correct internal rule interface within the cortex. C1 as a standalone fails criteria 4 and 5; as the first tier inside the cortex it is the right implementation starting point.

*How it compares to idealEndState:* Reaches 5/6 aspects. The one gap: same-turn tool result rewriting (intercepting error messages before the LLM receives them) is excluded. Recovery guidance arrives in the NEXT turn's steer message. This is the accepted tradeoff: the interceptor's costs (hot path mutation, no durable state, dual coordination problem) exceed the benefit of one-turn-faster feedback.

## Final Summary

**Recommendation:** SessionCortex with tiered recovery ladder
**Confidence:** High
**Selection tier:** strong_recommendation

### What to build

A `SessionCortex` class that:
1. Subscribes to `turn_end` events (which already carry all toolResults)
2. Maintains per-step failure counts in an append-only typed event log (crash-safe)
3. Drives a typed escalation state machine per step: `NoFailures → HintInjected → ScaffoldInjected → StepRewound → OperatorEscalated`
4. On failure count 1: inject a targeted hint via `agent.steer()` before the next LLM turn
5. On failure count 2: inject a scaffolded example (exact artifact format, copy-pasteable)
6. On failure count 3: attempt step rewind (rehydrate to pre-failure state)
7. On failure count 4: suspend to operator escalation (never terminate abnormally)

Individual recovery behaviors are pure functions: `(CortexState, TurnEvent) => Intervention | null`. The cortex is the stateful coordinator (imperative shell); rules are stateless (functional core).

### Required prerequisite before implementation

**Specify the cortex event log format** with typed variants:
```typescript
type CortexEvent =
  | { kind: 'step_failure_observed'; stepId: string; failureCount: number; errorSummary: string; ts: number }
  | { kind: 'hint_injected'; stepId: string; ts: number }
  | { kind: 'scaffold_injected'; stepId: string; ts: number }
  | { kind: 'step_rewound'; stepId: string; ts: number }
  | { kind: 'operator_escalated'; stepId: string; ts: number };
```

Startup recovery reads the log, replays events to reconstruct escalation ladder position, and the cortex resumes correctly after daemon restart.

### Implementation phases (incremental, each ships value)

- **Phase 1:** Cortex subscribes to turn_end. Per-step failure counting. Hint injection on failure count 1 (fixes the wr.loop_control bug immediately). Event log written.
- **Phase 2:** Scaffold injection (copy-pasteable artifact format examples derived from the step's outputContract). Covers the blocked_attempt_limit_exceeded confusion.
- **Phase 3:** Step rewind (rehydrate to pre-failure state via the engine's rehydrate path).
- **Phase 4:** Operator escalation (clean session suspension with context, not crash). Replaces `stuck` as the terminal path.

### Residual risks

1. **[ORANGE] Cortex event log format must be designed before implementation** -- typed CortexEvent union required for crash recovery to work correctly
2. **[YELLOW] Intervention threshold should be 1** -- fire on first failure, not third
3. **[YELLOW] Escalation is a typed state machine** -- not free-form log entries; illegal sequences must be unrepresentable
4. **[INFO] Same-turn tool result rewriting excluded** -- accepted tradeoff; revisit only if agent reliability deteriorates
5. **[INFO] Context degradation (C5 checkpointing) is orthogonal** -- separate backlog item, architecturally compatible with this design
