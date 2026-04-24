# Design Review Findings: runWorkflow() Functional Core / Imperative Shell Refactor

## Tradeoff Review

| Tradeoff | Acceptable? | Condition |
|---|---|---|
| SessionState in same large file | Yes | File stays under ~4500 lines |
| Stuck sidecar deletion is a behavioral fix | Yes | No test asserts sidecar persistence on stuck |
| workrailSessionId async population via object mutation | Yes | JS object mutation visible through all references |
| evaluateStuckSignals interface clean separation | Yes | Subscriber handles all signal kinds |

## Failure Mode Review

| Failure Mode | Risk | Mitigation |
|---|---|---|
| Missing let variable in SessionState | Low | TypeScript compiler catches at build time |
| TDZ with abortRegistry + agent | Low | finalizeSession called only after finally block |
| evaluateStuckSignals subscriber missing a signal kind | Medium | Use discriminated union + switch/exhaustive handling in subscriber |
| finalizeSession missing stuck sidecar deletion | Low | Explicit addition + test via injected _sessionsDir |

**Highest risk:** evaluateStuckSignals subscriber missing a signal kind (silent degradation).

## Runner-Up / Simpler Alternative Review

- Runner-up (separate files): No elements worth borrowing
- Simpler alternative (skip SessionState + evaluateStuckSignals): Fails acceptance criteria 4+5
- Candidate A is already the simplest design that satisfies all acceptance criteria

## Philosophy Alignment

**Satisfied:** Exhaustiveness (assertNever), functional core, dependency injection, validate at boundaries, make illegal states unrepresentable.

**Acceptable tensions:**
- SessionState is mutable (callback pattern inherently requires it; now explicit via named interface)
- buildAgentClient throws (outer runWorkflow catches, converts to errors-as-data Result)

## Findings

**ORANGE: evaluateStuckSignals subscriber exhaustiveness**
The subscriber in the turn_end handler calls `evaluateStuckSignals()` and acts on the result. If the subscriber uses an if-else chain rather than a switch on the signal's discriminant, TypeScript won't enforce that all signal kinds are handled. A missing case silently degrades stuck detection.

Recommended revision: In the turn_end subscriber, use a clearly structured handler that explicitly checks each `StuckSignal.kind` -- either via switch statement or clearly separated if-blocks that document each case. Add comments linking each block to the corresponding signal kind.

**YELLOW: SessionState completeness**
All 13 `let` declarations must be present in `SessionState`. Missing one creates a divergent state bug.

Recommended revision: Remove each `let` declaration one by one (in code, not just add to interface), so the TypeScript compiler flags any missed references.

**YELLOW: stuck sidecar deletion is new behavior**
The pre-existing stuck path does NOT delete the sidecar. The `finalizeSession` refactor adds this. While the invariants doc requires it, the behavior change could surprise anyone who relied on the pre-existing (incorrect) behavior.

Recommended revision: Add a comment in `finalizeSession` noting this fixes a pre-existing bug and reference the invariants doc section 2.2.

## Recommended Revisions

1. Use a structured signal handler in the turn_end subscriber (switch or explicit if-blocks per kind)
2. Remove `let` declarations one-by-one to catch compiler errors
3. Add a comment in `finalizeSession` noting the stuck sidecar fix

## Residual Concerns

None blocking. All concerns are addressed by the recommended revisions above.
